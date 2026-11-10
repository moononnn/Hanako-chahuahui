import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";
import { threadToMessages } from "../lib/prompt.js";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
async function boot({ corruptQuota = false, unavailableService = false } = {}) {
  let partner, mediaCalls = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    partner = store.createLocalPartner({ name: "测试伙伴", description: "绿发绿眼的二次元少女" });
    store.saveKnowing(partner.id, { ...store.getKnowing(partner.id), personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } } });
    store.setPartnerSettings(partner.id, { phone: { holding: true, untilMs: Date.now() + 60 * 60_000 }, rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 }, voice: { enabled: false } });
    store.setGlobalSettings({ weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    if (corruptQuota) {
      fs.mkdirSync(path.join(ctx.dataDir, "v2"), { recursive: true });
      fs.writeFileSync(path.join(ctx.dataDir, "v2", "image-quota.json"), "{broken");
    }
    if (unavailableService) {
      const register = ctx.bus.handle;
      ctx.bus.handle = (name, ...rest) => { if (name === "chat-image-generate") throw new Error("service unavailable"); return register(name, ...rest); };
    }
    const original = ctx.bus.request;
    ctx.bus.request = async (method, payload, ...rest) => {
      if (method === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "task_photo" }] }; }
      return original(method, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "test_photo" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  return { ...app, partner, mediaCalls };
}
test("真apply设置API默认关闭，双层档位可保存重开，上传不会自动选参考照", async () => {
  const app = await boot(); const id = app.partner.id;
  let view = await app.request("GET", `/image/partner/${id}`);
  assert.equal(view.body.globalTier, "off"); assert.equal(view.body.tier, "off");
  assert.equal((await app.request("PUT", "/settings/global", { json: { imageTier: "normal" } })).status, 200);
  assert.equal((await app.request("PUT", `/settings/partner/${id}`, { json: { imageTier: "less" } })).status, 200);
  view = await app.request("GET", `/image/partner/${id}`);
  assert.equal(view.body.usage.globalLimit, 8); assert.equal(view.body.usage.partnerLimit, 1);
  const uploaded = await app.request("POST", `/image/reference/${id}`, { json: { image: { data: PNG.toString("base64") } } });
  assert.equal(uploaded.status, 200); assert.equal(uploaded.body.reference.currentId, null);
  const referenceId = uploaded.body.reference.history[0].id;
  assert.equal((await app.request("PUT", `/image/reference/${id}`, { json: { referenceId } })).status, 200);
  assert.equal((await app.request("GET", `/image/reference/${id}/${referenceId}`)).status, 200);
  assert.equal(createStore(app.dataDir).getPartnerSettings(id).imageTier, "less");
  assert.equal(app.mediaCalls.length, 0);
});
test("真apply聊天纯图请求只生成一次，附件真实落库并可读，后续上下文记得照片内容", async () => {
  const app = await boot(); const id = app.partner.id;
  await app.request("PUT", "/settings/global", { json: { imageTier: "less" } });
  await app.request("PUT", `/settings/partner/${id}`, { json: { imageTier: "less" } });
  app.models.answer(req => /【聊天照片】/.test(String(req.systemPrompt)), '[生图:{"prompt":"窗边的一杯咖啡，不出现人物","self":false}]');
  const started = await app.request("POST", "/turns", { json: { agentId: id, text: "让我看看你手边的咖啡", watching: true, clientMessageId: "photo_request_001" } });
  assert.equal(started.body.ok, true);
  const deadline = Date.now() + 8000;
  let message;
  while (Date.now() < deadline) {
    message = reopenThread(app.dataDir, id).find(row => row.role === "assistant" && row.attachment?.id);
    if (message) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(message, "最终图片应沿真实composeReply落库");
  assert.equal(app.mediaCalls.length, 1);
  const serviceCall = app.serviceCalls.find(row => row.type === "app:chahuahui/chat-image-generate");
  assert.ok(serviceCall, "异步生图必须通过独立App自服务作用域");
  const service = app.serviceHandlers.get("chat-image-generate");
  await assert.rejects(() => service(serviceCall.payload, { callerAppId: "other-app" }), /仅供本应用/);
  assert.equal((await service(serviceCall.payload, { callerAppId: "chahuahui" })).imageOutcome, "unknown");
  assert.equal(app.mediaCalls.length, 1, "重复调用旧工作号不再付费");
  assert.equal(message.text.includes("生图"), false);
  assert.equal((await app.request("GET", `/attachment/${id}/${message.attachment.id}`)).status, 200);
  const view = await app.request("GET", `/image/partner/${id}`);
  assert.equal(view.body.usage.partnerUsed, 1);
  assert.equal(view.body.usage.partnerPending, 0);
  assert.match(JSON.stringify(threadToMessages([message])), /咖啡/);
});
test("额度账本损坏或聊天服务未启动时明确报暂停，仍可管理参考照", async () => {
  for (const options of [{ corruptQuota: true }, { unavailableService: true }]) {
    const app = await boot(options); const id = app.partner.id;
    const view = await app.request("GET", `/image/partner/${id}`);
    assert.equal(view.status, 200); assert.ok(view.body.quotaError);
    assert.equal((await app.request("POST", `/image/reference/${id}`, { json: { image: { data: PNG.toString("base64") } } })).status, 200);
    assert.equal(app.mediaCalls.length, 0);
  }
});
test("彻底删除伙伴会清掉参考照，且在途生成不能把删除的候选写回来", async () => {
  const app = await boot(); const id = app.partner.id;
  const result = await app.request("POST", `/image/reference/${id}`, { json: { image: { data: PNG.toString("base64") } } });
  assert.equal(result.status, 200);
  const referenceDir = path.join(app.dataDir, "v2", "image-references", id);
  assert.ok(fs.existsSync(referenceDir));
  let finish;
  app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.request("POST", `/image/reference/${id}/generate`, { json: { confirm: true } });
  for (let i = 0; i < 40 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(finish);
  const purged = await app.request("POST", `/settings/partner/${id}/purge`, { json: {} });
  assert.equal(purged.status, 200); assert.equal(fs.existsSync(referenceDir), false);
  finish({ status: "completed" });
  assert.equal((await pending).body.ok, false);
  assert.equal(fs.existsSync(referenceDir), false);
});
