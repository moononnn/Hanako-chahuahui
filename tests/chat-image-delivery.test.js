import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createImageQuota } from "../lib/image-quota.js";
import { detectImageType } from "../lib/background.js";
const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const start = source.indexOf("  async function prepareChatImage(");
const code = source.slice(start, source.indexOf("\n  function removeAttachment", start));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
function setup(t, generate = async () => ({ bytes: PNG })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-photo-delivery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const global = { imageTier: "normal" }, partner = { imageTier: "less" };
  let reference = { id: "ref_one", path: "/app-data/one.png" };
  let calls = [], saved = [];
  const imageQuota = createImageQuota(dir, { getGlobal: () => global, getPartner: () => partner });
  const deps = { imageQuota, imageQuotaError: null, imageReferences: { current: () => reference, view: () => ({ currentId: reference?.id }) }, store: { getGlobalSettings: () => global, getPartnerSettings: () => partner }, ctx: {},
    generateChatImage: async (_ctx, options) => { calls.push(options); return generate(options); },
    normalizeImageModelPatch: () => ({}), detectImageType,
    saveAttachment: input => { saved.push(input); return { id: "img_result", data: PNG }; },
    recordAttachmentDescription() {}, diagnostics() {}, describeError: error => ({ message: error.message }),
  };
  const prepare = new Function(...Object.keys(deps), `return (${code.trim()});`)(...Object.values(deps));
  return { global, partner, imageQuota, calls, saved, prepare, changeReference(value) { reference = value; } };
}
test("聊天关闭、没有参考的自拍和旧稿都不发付费请求", async t => {
  const s = setup(t);
  s.global.imageTier = "off";
  assert.equal((await s.prepare("one", { prompt: "咖啡", self: false })).attachment, null);
  s.global.imageTier = "normal"; s.changeReference(null);
  assert.equal((await s.prepare("one", { prompt: "自拍", self: true })).attachment, null);
  assert.equal((await s.prepare("one", { prompt: "雨", self: false }, { stillCurrent: () => false })).stale, true);
  assert.equal(s.calls.length, 0);
});
test("成功的角色照片带正确参考并计次，附件不泄露图片字节", async t => {
  const s = setup(t);
  const out = await s.prepare("one", { prompt: "喝咖啡", self: true });
  assert.deepEqual(s.calls[0].referencePaths, ["/app-data/one.png"]);
  assert.equal(out.attachment.id, "img_result");
  assert.equal(Object.hasOwn(out.attachment, "data"), false);
  assert.equal(s.imageQuota.usage("one").partnerUsed, 1);
  assert.equal((await s.prepare("one", { prompt: "再拍", self: true })).attachment, null);
  assert.equal(s.calls.length, 1);
});
test("生成期间关闭、换照或新消息都不投递，但成功仍记次数", async t => {
  for (const change of [s => { s.global.imageTier = "off"; }, s => { s.partner.imageTier = "off"; }, s => s.changeReference({ id: "ref_other", path: "/app-data/two.png" }), s => { s.current = false; }]) {
    let done;
    const s = setup(t, () => new Promise(resolve => { done = resolve; })); s.current = true;
    const pending = s.prepare("one", { prompt: "自拍", self: true }, { stillCurrent: () => s.current });
    assert.equal(s.imageQuota.usage("one").partnerPending, 1);
    change(s); done({ bytes: PNG });
    assert.equal((await pending).stale, true);
    assert.equal(s.saved.length, 0);
    assert.equal(s.imageQuota.usage("one").partnerUsed, 1);
  }
});
test("明确失败释放次数，未知上游结果不自动重试也不释放", async t => {
  for (const outcome of ["failed", "unknown"]) {
    const s = setup(t, async () => { throw Object.assign(new Error("没出图"), outcome === "failed" ? { imageOutcome: "failed" } : {}); });
    const out = await s.prepare("one", { prompt: "咖啡", self: false });
    assert.match(out.fallback, /没发出来/);
    assert.equal(s.calls.length, 1);
    assert.equal(s.imageQuota.usage("one").partnerPending, outcome === "unknown" ? 1 : 0);
    assert.equal(s.saved.length, 0);
  }
});
test("额度预占或结算写入失败时暂停生图，不抛出整条聊天也不重复请求", async t => {
  const before = setup(t);
  before.imageQuota.reserve = () => { throw new Error("disk full"); };
  const blocked = await before.prepare("one", { prompt: "咖啡", self: false });
  assert.ok(blocked.fallback); assert.equal(before.calls.length, 0);
  const after = setup(t);
  after.imageQuota.settle = () => { throw new Error("disk full"); };
  const failed = await after.prepare("one", { prompt: "咖啡", self: false });
  assert.ok(failed.fallback); assert.equal(after.calls.length, 1);
  await after.prepare("one", { prompt: "再拍", self: false });
  assert.equal(after.calls.length, 1);
});
test("聊天接线把纯图作为正常回复保存，关闭也会剥离幻觉协议", () => {
  assert.match(source, /parseChatImage\(rawGeneratedText\)/);
  assert.match(source, /bubbles.length === 0 && !preparedImage.attachment/);
  assert.match(source, /attachment: preparedImage.attachment/);
  assert.match(source, /parseStickerMarker\(parseChatImage\(rawText\).text\)/);
});
