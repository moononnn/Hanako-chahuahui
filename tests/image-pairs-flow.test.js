import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";

const A = "img_pair_a", B = "img_pair_b", AGENT = "nova", HOUR = 3600000;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
// 两份合法PNG文件字节不同，第二份增加PNG解码器允许忽略的尾字节；不拿此用例冒充视觉识别。
const bytes = new Map([[A, png], [B, Buffer.concat([png, Buffer.from([0])])]]);
async function boot(t) {
  const tools = new Map(), prompts = [], media = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    ctx.tools.register = (tool) => tools.set(tool.name, tool);
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = (hour) => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({ rhythmProactiveEnabled: true, imageTier: "off", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) }, weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    store.setPartnerSettings(AGENT, { proactiveEnabled: true, tier: "often", imageTier: "off", model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: new Date().toISOString(), phone: { holding: true, untilMs: Date.now() + HOUR }, sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } }, rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 }, voice: { enabled: false } });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } }, worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
    store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() - HOUR).toISOString(), lastSentAt: new Date(Date.now() - HOUR).toISOString(), interestLearning: { curiosity: { startedAt: new Date().toISOString(), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: new Date().toISOString(), seeds: [] }, newsBook: { lastFetchAt: new Date().toISOString(), lastDomainId: "", items: [], history: [] } });
    const dir = path.join(ctx.dataDir, "v2", "attachments"); fs.mkdirSync(dir, { recursive: true });
    for (const [id, data] of bytes) {
      fs.writeFileSync(path.join(dir, `${id}.bin`), data);
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, agentId: AGENT, name: `${id}.png`, mimeType: "image/png", size: data.length, hash: createHash("sha256").update(data).digest("hex"), at: new Date(Date.now() - 2 * HOUR).toISOString(), lastSeenAt: new Date(Date.now() - 2 * HOUR).toISOString(), title: "测试图", description: "两幅同构图角色插画" }));
      store.appendMessage(AGENT, { id: `source_${id}`, role: "user", text: "[图片]", attachment: { id, name: `${id}.png`, mimeType: "image/png", size: data.length }, at: new Date(Date.now() - 2 * HOUR).toISOString() });
    }
    store.appendMessage(AGENT, { role: "assistant", text: "一起碰个杯。", at: new Date(Date.now() - 2 * HOUR + 1000).toISOString() });
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => { if (type === "media:generate-image") { media.push(payload); throw new Error("不应生图"); } return request(type, payload, ...rest); };
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.setCatalog([{ provider: "test-provider", model: "test-model", supportsImage: true }]);
  const tool = tools.get("chahuahui_image_pair"); assert.ok(tool, "正式apply确实注册工具");
  const call = async (args) => JSON.parse((await tool.execute(args)).content[0].text);
  assert.equal((await call({ action: "bind", agentId: AGENT, userImageId: A, partnerImageId: B, name: "碰杯暗号", meaning: "同构图的两个OC，互相接图碰杯，也可以故意逗对方。", confirm: true })).verified, true);
  function answer(id) {
    app.models.rules.length = 0;
    app.models.answer((req) => { if (!String(req.systemPrompt).includes("成对图片暗号")) return false; prompts.push(req); return true; }, `[旧图:{"id":"${id}","as":"sticker"}]`);
    app.models.answer(() => true, "嗯，我在。");
  }
  return { ...app, prompts, media, call, answer };
}
async function waitMessage(app, predicate) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const row = reopenThread(app.dataDir, AGENT).find(predicate);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待配对回复超时");
}

test("正式工具绑定后A接B、B接A，再次A仍能接B：复用原件且提示认清OC", async (t) => {
  const app = await boot(t);
  for (const [index, incoming, target] of [[0, A, B], [1, B, A], [2, A, B]]) {
    app.answer(target);
    const turn = await app.request("POST", "/turns", { json: { agentId: AGENT, text: "接这个", image: { data: bytes.get(incoming).toString("base64"), mimeType: "image/png" }, watching: true, clientMessageId: `pair_turn_${index}` } });
    assert.equal(turn.status, 200);
    const row = await waitMessage(app, (row) => row.role === "assistant" && row.repliedTo === turn.body.messageId && row.imageReuse);
    assert.equal(row.imageReuse.attachmentId, target);
    assert.ok(row.bubbles.includes(`\u0001stk:${target}`));
    const prompt = app.prompts.at(-1).systemPrompt;
    assert.match(prompt, /画中角色与原发送者是两回事/);
    assert.ok(prompt.includes(`"latestUserImageId":"${incoming}"`));
  }
  assert.equal(app.media.length, 0);
  const dir = path.join(app.dataDir, "v2", "attachments");
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".bin")).length, 2);
  for (const [id, data] of bytes) assert.deepEqual(fs.readFileSync(path.join(dir, `${id}.bin`)), data);
});

test("主动可用任一张邀接梗，仍走正常调度且不生图", async (t) => {
  for (const id of [A, B]) {
    const app = await boot(t); app.answer(id);
    const random = Math.random; Math.random = () => 0.99;
    try { assert.equal((await app.request("POST", "/proactive/tick", { json: {} })).status, 200); }
    finally { Math.random = random; }
    const row = await waitMessage(app, (row) => row.proactive && row.imageReuse);
    assert.equal(row.imageReuse.attachmentId, id);
    assert.ok(app.prompts.some((req) => req.systemPrompt.includes("主动聊天时也可以先发任一张")));
    assert.equal(app.media.length, 0);
  }
});

test("源历史清空不丢配对；原消息撤回会使配对立即失效", async (t) => {
  const app = await boot(t);
  const original = reopenThread(app.dataDir, AGENT).find((row) => row.attachment?.id === A);
  app.store.patchMessage(AGENT, original.id, { recalled: true });
  assert.equal((await app.call({ action: "read", agentId: AGENT })).pairs.length, 0);
  app.store.patchMessage(AGENT, original.id, { recalled: false });
  assert.equal((await app.call({ action: "read", agentId: AGENT })).pairs.length, 1);
  await app.request("POST", `/thread/${AGENT}/clear`, { json: {} });
  assert.equal((await app.call({ action: "read", agentId: AGENT })).pairs.length, 1);
});
