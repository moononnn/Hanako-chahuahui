import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { bootChahuahui } from "./helpers/app-harness.js";

/**
 * 模型降级链（2026-11-02）。
 *
 * 实机反馈：给小花单独配的 gpt 额度用完，茶话会整轮直接判「模型这会儿用不了」，
 * 一句也不回——而全局明明还配着 ds。当时的实现只有「目录里找不到」会往下退，
 * 「找得到但调不动」不会。这组用例守的是新的规矩：第一档调不动就换下一档，
 * 链走完才算这一轮真的没模型可用。
 */

const AGENT = "nova";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 手写一份附件：走真磁盘，让 readAttachment / 识图都跑到真代码。 */
function seedImageAttachment(ctx, agentId) {
  const dir = path.join(ctx.dataDir, "v2", "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const id = "img_degrade1";
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, agentId, name: "截图.png", mimeType: "image/png", size: bytes.length,
    createdAt: new Date().toISOString(), nativeVision: true,
  }, null, 2));
  fs.writeFileSync(path.join(dir, `${id}.bin`), bytes);
  return id;
}

const seedReady = (store, extra = {}) => store.setPartnerSettings(AGENT, {
  phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
  rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
  voice: { enabled: false },
  ...extra,
});

const saidRows = (app) => app.store.getThread(AGENT).messages
  .filter((row) => row.role === "assistant" && row.text);

/** 等某一家被调第 n 次（同一个模型可能被调好几回）。 */
async function waitForNth(app, provider, n, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hits = app.models.calls.filter((call) => call.request?.provider === provider);
    if (hits.length >= n) return hits[n - 1];
    await sleep(10);
  }
  throw new Error(`等第 ${n} 次 ${provider} 调用超时`);
}

async function waitForSaid(app, count = 1, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = saidRows(app);
    if (rows.length >= count) return rows;
    await sleep(10);
  }
  throw new Error(`等回复超时（实际 ${saidRows(app).length} 条）`);
}

async function waitForNotice(app, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = app.store.getThread(AGENT).messages.find((item) => item?.notice?.code === "MODEL_UNAVAILABLE");
    if (row) return row;
    await sleep(10);
  }
  throw new Error("等不到「模型用不了」的告示");
}

test("伙伴那档额度用完：自动降到全局那一档接着说，不是整轮哑掉", async () => {
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store, { model: { provider: "openai-codex", model: "gpt-6.1-terra" } });
      store.setGlobalSettings({ model: { provider: "deepseek", model: "deepseek-flash" } });
    },
  });
  app.models.setCatalog([
    { provider: "openai-codex", model: "gpt-6.1-terra" },
    { provider: "deepseek", model: "deepseek-flash" },
  ]);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });

  const first = await app.models.waitForCallWhere((request) => request?.provider === "openai-codex");
  assert.equal(first.request.model, "gpt-6.1-terra", "先用她配给这位伙伴的那个");
  app.models.releaseError(first, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");

  const second = await app.models.waitForCallWhere((request) => request?.provider === "deepseek");
  assert.equal(second.request.model, "deepseek-flash", "第一档调不动就换全局配的那个");
  app.models.release(second, "在。刚才那口气没接上，现在换个嗓子跟你说。");

  const rows = await waitForSaid(app);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /现在换个嗓子/);
  assert.equal(rows[0].via, "stream:deepseek/deepseek-flash", "落库记的是真开口的那个模型");
  assert.equal(
    app.store.getThread(AGENT).messages.some((row) => row?.notice?.code === "MODEL_UNAVAILABLE"),
    false,
    "降下来了就不该再摆「模型用不了」的告示",
  );
});

test("链上两档都调不动：才算这一轮没模型可用，告示挂在她那条消息上", async () => {
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store, { model: { provider: "openai-codex", model: "gpt-6.1-terra" } });
      store.setGlobalSettings({ model: { provider: "deepseek", model: "deepseek-flash" } });
    },
  });
  app.models.setCatalog([
    { provider: "openai-codex", model: "gpt-6.1-terra" },
    { provider: "deepseek", model: "deepseek-flash" },
  ]);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });
  const first = await app.models.waitForCallWhere((request) => request?.provider === "openai-codex");
  app.models.releaseError(first, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");
  const second = await app.models.waitForCallWhere((request) => request?.provider === "deepseek");
  // 两档都是额度用完：这条不是抖，重试没用，两下就走完，告示也就马上挂上。
  app.models.releaseError(second, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");

  const row = await waitForNotice(app);
  assert.equal(row.notice.kind, "quota");
  assert.equal(saidRows(app).length, 0, "一句都没说出来时不能凭空多一条回复");
});

test("刚调不动过的模型短期内不再白撞：第二句直接从那档能用的开始", async () => {
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store, { model: { provider: "openai-codex", model: "gpt-6.1-terra" } });
      store.setGlobalSettings({ model: { provider: "deepseek", model: "deepseek-flash" } });
    },
  });
  app.models.setCatalog([
    { provider: "openai-codex", model: "gpt-6.1-terra" },
    { provider: "deepseek", model: "deepseek-flash" },
  ]);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });
  const first = await app.models.waitForCallWhere((request) => request?.provider === "openai-codex");
  app.models.releaseError(first, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");
  const second = await app.models.waitForCallWhere((request) => request?.provider === "deepseek");
  app.models.release(second, "在，刚换了个嗓子。");
  await waitForSaid(app);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "那就好" } });
  const deadline = Date.now() + 4000;
  let replied = [];
  while (Date.now() < deadline) {
    // 记忆维护也占模型出口，不能拿它在账上的第几次当聊天请求。
    replied = app.models.replyCalls();
    if (replied.length >= 2) break;
    await sleep(10);
  }
  assert.equal(replied.length, 2, "第二句也要真发出一次聊天请求");
  assert.equal(replied[1].request.provider, "deepseek", "额度没恢复之前，不该每句话都先去撞一次 gpt");
});

test("降级到不收图的模型：先用辅助识图模型看一遍，再把描述交过去", async () => {
  const app = await bootChahuahui({
    seed(store, ctx) {
      seedReady(store, { model: { provider: "openai-codex", model: "gpt-6.1-terra" } });
      store.setGlobalSettings({
        model: { provider: "deepseek", model: "deepseek-flash" },
        vision: { model: { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" }, status: "verified", testedAt: null, error: null },
      });
      const id = seedImageAttachment(ctx, AGENT);
      store.appendMessage(AGENT, {
        role: "user", text: "你看这个报错",
        attachment: { id, nativeVision: true, mimeType: "image/png" },
      });
    },
  });
  app.models.setCatalog([
    { provider: "openai-codex", model: "gpt-6.1-terra", input: ["text", "image"] },
    { provider: "deepseek", model: "deepseek-flash", input: ["text"] },
  ]);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });

  // 这条图还没人看过：回复前先让辅助识图模型看一眼（补上去的文字后面降级时正好用得上）。
  const visionCall = await app.models.waitForCallWhere((request) => request?.provider === "minimax");
  app.models.release(visionCall, "【标题】报错截图\n【描述】屏幕上一处 ENOENT 报错，路径是 dist/index.js。");

  const first = await app.models.waitForCallWhere((request) => request?.provider === "openai-codex");
  assert.match(JSON.stringify(first.request.messages), /"type":"image"/, "先配的那个收图，图要直接给它看");
  app.models.releaseError(first, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");

  const second = await app.models.waitForCallWhere((request) => request?.provider === "deepseek");
  const sent = JSON.stringify(second.request.messages);
  assert.equal(sent.includes('"type":"image"'), false, "不收图的模型不能塞图本体");
  assert.match(sent, /ENOENT/u, "至少得把它看见的那段交过去");
  app.models.release(second, "看到了，那个报错是路径拼错了。");

  const rows = await waitForSaid(app);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, "stream:deepseek/deepseek-flash");
});

test("识图那头一次也没成：降级前再试一次，别让她发的图白瞎", async () => {
  const app = await bootChahuahui({
    seed(store, ctx) {
      seedReady(store, { model: { provider: "openai-codex", model: "gpt-6.1-terra" } });
      store.setGlobalSettings({
        model: { provider: "deepseek", model: "deepseek-flash" },
        vision: { model: { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" }, status: "verified", testedAt: null, error: null },
      });
      const id = seedImageAttachment(ctx, AGENT);
      store.appendMessage(AGENT, {
        role: "user", text: "你看这个报错",
        attachment: { id, nativeVision: true, mimeType: "image/png" },
      });
    },
  });
  app.models.setCatalog([
    { provider: "openai-codex", model: "gpt-6.1-terra", input: ["text", "image"] },
    { provider: "deepseek", model: "deepseek-flash", input: ["text"] },
  ]);

  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });

  // 回复前那次补识图恰好赶上识图模型额度满。
  const firstVision = await app.models.waitForCallWhere((request) => request?.provider === "minimax");
  app.models.releaseError(firstVision, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");

  const first = await app.models.waitForCallWhere((request) => request?.provider === "openai-codex");
  app.models.releaseError(first, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded");

  // 降到不收图那一档之前，再问一次识图：这次成了。
  const secondVision = await waitForNth(app, "minimax", 2);
  app.models.release(secondVision, "【标题】报错截图\n【描述】屏幕上写着 Cannot find module 'dist/index.js'。");

  const second = await app.models.waitForCallWhere((request) => request?.provider === "deepseek");
  const sent = JSON.stringify(second.request.messages);
  assert.equal(sent.includes('"type":"image"'), false, "不收图的模型不能塞图本体");
  assert.match(sent, /Cannot find module/u, "降级前补回来的描述要真交过去");
  app.models.release(second, "看到了，说是找不到那个文件。");
  await waitForSaid(app);
});
