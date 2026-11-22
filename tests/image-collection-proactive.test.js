import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";

// 催一次主动巡檢这条路由是内测口子，正式包里会剥掉；那几则按形态 skip。
const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const TICK_OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡檢路由" };

const AGENT = "nova";
const HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const STICKER_PREFIX = "\u0001stk:";
const OLD = "[旧图:{\"id\":\"img_stick_1\",\"as\":\"sticker\"}]";

async function boot(t, { answer = OLD } = {}) {
  const mediaCalls = [], prompts = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({ rhythmProactiveEnabled: true, imageTier: "off", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) }, weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    store.setPartnerSettings(AGENT, { proactiveEnabled: true, tier: "often", imageTier: "off", model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: new Date().toISOString(), sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } }, voice: { enabled: false } });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } }, worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
    store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() - HOUR).toISOString(), lastSentAt: new Date(Date.now() - HOUR).toISOString(), interestLearning: { curiosity: { startedAt: new Date().toISOString(), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: new Date().toISOString(), seeds: [] }, newsBook: { lastFetchAt: new Date().toISOString(), lastDomainId: "", items: [], history: [] } });
    store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: new Date(Date.now() - 2 * HOUR).toISOString() });
    store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: new Date(Date.now() - 2 * HOUR + 1000).toISOString() });
    // 一张她明确收作表情的旧图：属主是这位伙伴。
    const dir = path.join(ctx.dataDir, "v2", "attachments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "img_stick_1.bin"), PNG);
    fs.writeFileSync(path.join(dir, "img_stick_1.json"), JSON.stringify({
      id: "img_stick_1", agentId: AGENT, name: "图片", mimeType: "image/png", size: PNG.length,
      at: new Date(Date.now() - 5 * HOUR).toISOString(), lastSeenAt: new Date(Date.now() - 5 * HOUR).toISOString(),
      title: "一只猫", description: "窗台上的猫",
      collection: { sticker: true, at: new Date(Date.now() - HOUR).toISOString(), sourceSaid: "这张给你做表情包" },
    }, null, 2));
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.answer(req => { prompts.push(req); return true; }, answer);
  return { ...app, mediaCalls, prompts };
}

async function waitFor(app, predicate, what = "消息") {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const hit = reopenThread(app.dataDir, AGENT).find(predicate);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待${what}超时`);
}

test("主动开口也能重发旧图：只进气泡，不挂附件，不生图", TICK_OPTIONS, async t => {
  const app = await boot(t);
  const random = Math.random;
  Math.random = () => 0.99; // 默认落在有聊天凭据的关系由头
  let result;
  try { result = await app.request("POST", "/proactive/tick", { json: {} }); }
  finally { Math.random = random; }
  assert.equal(result.status, 200);
  const message = await waitFor(app, (row) => row.proactive && row.bubbles?.length, "那条主动消息");
  assert.equal(message.imageReuse.attachmentId, "img_stick_1");
  assert.equal(message.imageReuse.as, "sticker");
  assert.equal(message.attachment, undefined, "当表情发不再挂一张附件");
  assert.ok(message.bubbles.some((piece) => String(piece).startsWith(STICKER_PREFIX)), "旧图要进气泡");
  assert.equal(app.mediaCalls.length, 0, "旧图不许触发生图");
  const prompt = app.prompts.find(req => String(req.systemPrompt).includes("【你手边的旧图】"))?.systemPrompt;
  assert.ok(prompt, "主动那轮也要看得见旧图候选");
  assert.match(prompt, /img_stick_1/);
});

test("旧图发不出去时，主动那条宁可不说，也不发空头图", TICK_OPTIONS, async t => {
  const app = await boot(t, { answer: '[旧图:{"id":"img_not_here","as":"sticker"}]' });
  const random = Math.random;
  Math.random = () => 0.99;
  let result;
  try { result = await app.request("POST", "/proactive/tick", { json: {} }); }
  finally { Math.random = random; }
  assert.equal(result.status, 200);
  await new Promise(resolve => setTimeout(resolve, 400));
  const rows = reopenThread(app.dataDir, AGENT).filter((row) => row.proactive);
  assert.equal(rows.length, 0, "发不出去的旧图不该变成一条空消息");
  assert.equal(app.mediaCalls.length, 0, "也不许补调生图");
});

test("主动那轮旧图与生图同轮：发旧图，不生图，也不丢整轮", TICK_OPTIONS, async t => {
  const app = await boot(t, { answer: `${OLD}[生图:{"prompt":"窗边一杯咖啡","self":false}]` });
  const random = Math.random;
  Math.random = () => 0.99;
  let result;
  try { result = await app.request("POST", "/proactive/tick", { json: {} }); }
  finally { Math.random = random; }
  assert.equal(result.status, 200);
  const message = await waitFor(app, (row) => row.proactive && row.bubbles?.length, "那条主动消息");
  assert.equal(message.imageReuse.attachmentId, "img_stick_1", "旧图照发");
  assert.equal(message.attachment, undefined, "旧图当表情发就不再挂附件");
  assert.ok(message.bubbles.some((piece) => String(piece).startsWith(STICKER_PREFIX)));
  assert.equal(message.proactiveExpression, undefined, "旧图不算新拍的照片");
  assert.equal(app.mediaCalls.length, 0, "有旧图就不生图");
});
