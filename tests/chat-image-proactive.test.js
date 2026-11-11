import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花，不出现人物","self":false}]';
const time = ms => new Date(Date.now() + ms).toISOString();
async function boot(t, { enabled = true, answer = PHOTO } = {}) {
  const mediaCalls = [], prompts = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({ rhythmProactiveEnabled: true, imageTier: enabled ? "less" : "off", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) }, weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    store.setPartnerSettings(AGENT, { proactiveEnabled: true, tier: "often", imageTier: enabled ? "normal" : "off", model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: time(0), sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } }, voice: { enabled: false } });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } }, worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, { nextDueAt: time(-HOUR), lastSentAt: time(-HOUR), interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: time(0), seeds: [] }, newsBook: { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] } });
    store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: time(-2 * HOUR) });
    store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  const tick = async () => {
    const random = Math.random;
    Math.random = () => 0.99; // 稳定落在有聊天凭据的关系由头，不去碰网络素材。
    try { return await app.request("POST", "/proactive/tick", { json: {} }); }
    finally { Math.random = random; }
  };
  return { ...app, mediaCalls, prompts, tick, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}
async function waitUntil(testFn) {
  for (let i = 0; i < 800; i++) { if (testFn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("等待测试工作启动超时");
}
test("真主动调度：纯图沿既有消息通路保存并通知，只生成一次，额度与普通聊天共用", OPTIONS, async t => {
  const app = await boot(t);
  const result = await app.tick();
  assert.equal(result.status, 200);
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(result.body));
  const [message] = app.photos(); assert.ok(message);
  assert.equal(message.text, "[图片]"); assert.equal(message.proactiveKind, "proactive");
  assert.equal(JSON.stringify(message).includes("[生图:"), false);
  assert.equal((await app.request("GET", `/attachment/${AGENT}/${message.attachment.id}`)).status, 200);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1); assert.equal(usage.globalUsed, 1); assert.equal(usage.partnerPending, 0);
  const prompt = app.prompts.find(req => req.systemPrompt.includes("【聊天照片】"))?.systemPrompt;
  assert.match(prompt, /【发图意愿：适中】/, "主动分享也按伙伴档位，不取全局少一些");
  assert.doesNotMatch(prompt, /【发图意愿：少一些】/);
  assert.ok(app.serviceCalls.some(row => row.type === "app:chahuahui/chat-image-generate"));
  assert.ok(app.emittedAppEvents.some(row => row.type === "partner-message-arrived" && row.payload.messageId === message.id));
});
test("主动与普通聊天确实共用伙伴上限，用完后硬输出标记也不再生成", OPTIONS, async t => {
  const app = await boot(t); await app.tick();
  await app.request("PUT", `/settings/partner/${AGENT}`, { json: { phone: { holding: true, untilMs: Date.now() + HOUR }, rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 } } });
  app.models.answer(() => true, PHOTO);
  for (let i = 0; i < 2; i++) {
    const before = reopenThread(app.dataDir, AGENT).filter(row => row.role === "assistant").length;
    await app.request("POST", "/turns", { json: { agentId: AGENT, text: "再看看你的咖啡", watching: true, clientMessageId: `shared_photo_${i}` } });
    await waitUntil(() => reopenThread(app.dataDir, AGENT).filter(row => row.role === "assistant").length > before);
  }
  assert.equal(app.mediaCalls.length, 2, "主动一张、普通一张，第三次不能再调用宿主");
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 2); assert.equal(usage.partnerPending, 0);
});
test("主动自拍只带当前选用的伙伴参考照，照片属性沿现有附件存储", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我在窗边拿着热咖啡","self":true}]' });
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  const referenceId = uploaded.body.reference.history[0].id;
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId } });
  await app.tick(); assert.equal(app.photos().length, 1);
  assert.equal(app.mediaCalls[0].input.imageIntent, "edit");
  assert.ok(app.mediaCalls[0].input.referenceImages[0].path.endsWith(`${referenceId}.png`));
  assert.match(app.mediaCalls[0].input.prompt, /同一角色.*画风/);
});
test("静默、坏协议与重复协议不触发主动生图", OPTIONS, async t => {
  for (const answer of [`[不回]${PHOTO}`, '[生图:{坏json}]', PHOTO + PHOTO]) {
    await t.test(answer.slice(0, 12), async t => {
      const app = await boot(t, { answer }); await app.tick();
      assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
    });
  }
});
test("开关关闭时不注入发图能力，模型硬输出照片协议也不能付费或发空头配文", OPTIONS, async t => {
  const app = await boot(t, { enabled: false, answer: `给你看看我刚冲的咖啡。${PHOTO}` });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  assert.ok(app.prompts.every(req => !req.systemPrompt.includes("【聊天照片】")));
});
test("未选外貌参考时，主动自拍不能生成陌生脸", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我靠着窗拿咖啡","self":true}]' });
  await app.tick(); assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
});
test("慢生图期间不落配文，成功时图文一起落库，不并发语音", OPTIONS, async t => {
  const app = await boot(t, { answer: `窗边这杯咖啡的拉花歪得像个小土豆，给你瞅瞅。${PHOTO}` });
  let finish;
  app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.tick(); await waitUntil(() => finish);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  finish({ status: "completed" }); await pending;
  const [message] = app.photos(); assert.ok(message); assert.match(message.text, /小土豆/); assert.equal(message.voice, undefined);
});
test("失败只结算这一次，不自动重试、不发送声称已出图的配文", OPTIONS, async t => {
  const app = await boot(t, { answer: `窗边这杯咖啡的拉花歪得像个小土豆，给你瞅瞅。${PHOTO}` });
  app.ctx.media.getTask = async () => ({ status: "failed", error: "测试失败" });
  await app.tick(); assert.equal(app.mediaCalls.length, 1); assert.equal(app.photos().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0); assert.equal(usage.partnerPending, 0);
});
test("自拍生成期间切换参考照，不把旧外貌照片发出去，成功仍计数", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我在窗边拿着热咖啡","self":true}]' });
  const upload = async () => (await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } })).body.reference.history[0].id;
  const one = await upload(), two = await upload();
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: one } });
  let finish; app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.tick(); await waitUntil(() => finish);
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: two } });
  finish({ status: "completed" }); await pending;
  assert.equal(app.photos().length, 0); assert.equal(app.mediaCalls.length, 1);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1); assert.equal(usage.partnerPending, 0);
});
test("等待期间新消息或关闭生图/主动开关，都不投递过期照片；已成功生成仍计数", OPTIONS, async t => {
  for (const change of ["message", "imageOff", "proactiveOff", "partnerOff"]) {
    await t.test(change, async t => {
      const app = await boot(t); let finish;
      app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
      const pending = app.tick(); await waitUntil(() => finish);
      if (change === "message") app.store.appendMessage(AGENT, { role: "user", text: "我又发了新话", at: time(0) });
      else if (change === "imageOff") await app.request("PUT", "/settings/global", { json: { imageTier: "off" } });
      else if (change === "proactiveOff") await app.request("PUT", "/settings/global", { json: { rhythmProactiveEnabled: false } });
      else await app.request("PUT", `/settings/partner/${AGENT}`, { json: { proactiveEnabled: false } });
      finish({ status: "completed" }); await pending;
      assert.equal(app.photos().length, 0); assert.equal(app.mediaCalls.length, 1);
      const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
      assert.equal(usage.partnerUsed, 1); assert.equal(usage.partnerPending, 0);
    });
  }
});
