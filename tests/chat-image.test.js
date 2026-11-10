import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseChatImage, normalizeImageTier, chatImagePrompt } from "../lib/chat-image.js";
import { createImageQuota } from "../lib/image-quota.js";
function setup(t, global = "more", partner = "less") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-image-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let date = new Date(2026, 10, 10, 23, 59);
  const settings = { imageTier: global };
  const partners = { one: { imageTier: partner }, two: { imageTier: partner } };
  const options = { getGlobal: () => settings, getPartner: id => partners[id], now: () => date };
  return { dir, settings, partners, options, quota: createImageQuota(dir, options), nextDay() { date = new Date(2026, 10, 11, 0, 1); } };
}
test("生图档位缺失、旧值、对象均关闭，不自动启用", () => {
  for (const value of [undefined, null, true, 1, "sometimes", {}, "OFF"]) assert.equal(normalizeImageTier(value), "off");
  assert.equal(normalizeImageTier("normal"), "normal");
  assert.equal(chatImagePrompt({ enabled: false }), "");
  assert.match(chatImagePrompt({ enabled: true }), /只能self=false/);
});
test("照片协议带括号与转义仍正确，正文不含内部JSON", () => {
  const request = { prompt: '窗外的雨[夜色]和一张写着"晴"的纸', self: false };
  const parsed = parseChatImage(`瞅一眼\n[生图:${JSON.stringify(request)}]`);
  assert.equal(parsed.text, "瞅一眼");
  assert.deepEqual(parsed.request, request);
});
test("坏协议、半截、未知字段及多次标记不触发生图", () => {
  for (const raw of ['[生图:{bad}]', '[生图:{"prompt":"猫"', '[生图:{"prompt":"猫","self":"false"}]', '[生图:{"prompt":"猫","self":false,"path":"x"}]']) {
    const parsed = parseChatImage(`正文\n${raw}`);
    assert.equal(parsed.request, null);
    assert.equal(parsed.text.includes("生图"), false);
  }
  const multiline = parseChatImage('正文\n[生图:{\n"prompt":"猫",\n"self":false}');
  assert.equal(multiline.text, "正文");
  assert.equal(multiline.request, null);
  const marker = '[生图:{"prompt":"猫","self":false}]';
  assert.equal(parseChatImage(marker + marker).request, null);
});
test("两层默认关闭不预占；全局关闭保留伙伴设置", t => {
  const { quota, settings, partners } = setup(t, "off");
  assert.equal(quota.reserve("one"), null);
  assert.equal(partners.one.imageTier, "less");
  settings.imageTier = "more";
  assert.ok(quota.reserve("one"));
  assert.equal(quota.reserve("one"), null);
});
test("跨伙伴共用总额度，预占在await前同步生效", t => {
  const { quota, partners } = setup(t, "less", "more");
  assert.ok(quota.reserve("one")); assert.ok(quota.reserve("one"));
  assert.ok(quota.reserve("two")); assert.ok(quota.reserve("two"));
  assert.equal(quota.reserve("one"), null);
  assert.equal(quota.usage("two").globalPending, 4);
  partners.two.imageTier = "off";
  assert.equal(quota.available("two"), false);
});
test("明确失败释放，成功和未知不能重试绕过限额，重启仍占位", t => {
  const { quota, dir, options } = setup(t);
  const first = quota.reserve("one"); quota.settle(first, "failed");
  const second = quota.reserve("one"); quota.settle(second, "unknown");
  assert.equal(quota.reserve("one"), null);
  assert.equal(createImageQuota(dir, options).available("one"), false);
  quota.settle(second, "success"); quota.settle(second, "failed");
  assert.equal(quota.usage("one").partnerUsed, 1);
});
test("未知结果次日恢复，跨日仍运行的生成占新日额度", t => {
  const s = setup(t);
  const first = s.quota.reserve("one"); s.quota.settle(first, "unknown");
  const running = s.quota.reserve("two");
  s.nextDay();
  assert.equal(s.quota.available("one"), true);
  assert.equal(s.quota.available("two"), false);
  s.quota.settle(running, "success");
  assert.equal(s.quota.usage("two").partnerUsed, 1);
});
test("坏次数账本停止而不重置额度", t => {
  const { quota, dir, options } = setup(t);
  quota.reserve("one");
  const file = path.join(dir, "v2", "image-quota.json");
  fs.writeFileSync(file, "{");
  assert.throws(() => createImageQuota(dir, options), /停止聊天生图/);
  assert.equal(fs.readFileSync(file, "utf8"), "{");
});
