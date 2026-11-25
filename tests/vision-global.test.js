/**
 * 辅助识图配置只认全局（2026-11-25）。
 *
 * 这一轮钉住：
 * 1. 视觉回退、收图、后台审图、历史识图、状态视图都不再读伙伴那份覆盖。
 * 2. 伙伴旧的 vision 值留在账本里：不删、不改、不顶替全局。
 * 3. 全局没配就是没配：状态视图明说「需要配置」，不拿旧的顶。
 * 4. 伙伴设置不再接受 vision；识图测试不再单独测伙伴——两条路都当场说清楚。
 * 5. 原生看图那条路不动：伙伴自己的聊天模型能看图时，照旧直接给图。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui } from "./helpers/app-harness.js";
import { globalVisionConfig, canUnderstandImages } from "../lib/vision.js";
import { createStore } from "../lib/store.js";

const AGENT = "nova";
const GLOBAL_VISION = { model: { provider: "test-provider", model: "test-model" }, status: "verified" };
/** 伙伴自己那份旧的：未验证。以前它能盖住全局。 */
const LEGACY_VISION = { model: { provider: "legacy-provider", model: "old-model" }, status: "unverified" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 纯函数 ── */

test("辅助识图只有全局那一份：伙伴旧的配置不再顶替它", () => {
  const global = globalVisionConfig(GLOBAL_VISION);
  assert.equal(global.source, "global");
  assert.equal(global.model.provider, "test-provider");
  assert.equal(canUnderstandImages(GLOBAL_VISION), true);
  // 全局没配就是没配：不能拿谁那份旧的来顶。
  assert.equal(canUnderstandImages(undefined), false);
  assert.equal(globalVisionConfig(undefined).model, null);
  assert.equal(globalVisionConfig(undefined).source, "global");
});

/* ── 集成 ── */

/** 手写一份附件：走真磁盘，让识图那条路跑到真代码。 */
function seedImageAttachment(ctx, agentId) {
  const dir = path.join(ctx.dataDir, "v2", "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const id = "img_vision_global";
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, agentId, name: "截图.png", mimeType: "image/png", size: bytes.length,
    createdAt: new Date().toISOString(), nativeVision: true,
  }, null, 2));
  fs.writeFileSync(path.join(dir, `${id}.bin`), bytes);
  return id;
}

async function boot(t, { globalVision = GLOBAL_VISION, partnerVision = LEGACY_VISION, chatModel = { provider: "deepseek", model: "deepseek-flash" } } = {}) {
  const app = await bootChahuahui({ seed(store, ctx) {
    store.setGlobalSettings({
      model: chatModel,
      ...(globalVision ? { vision: globalVision } : {}),
    });
    store.setPartnerSettings(AGENT, {
      phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
      rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
      voice: { enabled: false },
      // 伙伴自己那份旧的识图配置：留着，但不再生效。
      ...(partnerVision ? { vision: partnerVision } : {}),
    });
    const id = seedImageAttachment(ctx, AGENT);
    store.appendMessage(AGENT, {
      role: "user", text: "你看这个报错",
      attachment: { id, nativeVision: true, mimeType: "image/png" },
    });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return app;
}

test("降级回退用全局那一份：伙伴旧的未验证配置不再挡路", async t => {
  const app = await boot(t);
  // 目录里的聊天模型不收图 → 先用辅助识图看一遍，把描述交过去。
  app.models.setCatalog([{ provider: "deepseek", model: "deepseek-flash", input: ["text"] }]);
  await app.request("POST", "/turns", { json: { agentId: AGENT, watching: true, text: "在吗" } });

  const deadline = Date.now() + 4000;
  let visionCall = null;
  while (!visionCall && Date.now() < deadline) {
    visionCall = app.models.calls.find((call) => call.request?.provider === "test-provider") ?? null;
    if (!visionCall) await sleep(10);
  }
  assert.ok(visionCall, "该用全局那份辅助识图去看一眼");
  assert.equal(app.models.calls.some((call) => call.request?.provider === "legacy-provider"), false,
    "伙伴旧的识图配置不再被调用");
  app.models.release(visionCall, "【标题】报错截图\n【描述】屏幕上一处 ENOENT 报错。");
});

test("状态视图只认全局：全局没配就明说需要配置，不拿旧的顶", async t => {
  const app = await boot(t, { globalVision: null, partnerVision: LEGACY_VISION });
  app.models.setCatalog([{ provider: "deepseek", model: "deepseek-flash", input: ["text"] }]);
  const view = await app.request("GET", "/partners");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const capability = view.body.partners?.[0]?.imageCapability;
  assert.ok(capability, "状态视图该有这一段");
  assert.equal(capability.source, "global");
  assert.equal(capability.configured, false, "全局没配就是没配");
  assert.equal(capability.needsSetup, true, "要明说需要配置");
  assert.equal(capability.allowed, false, "聊天模型不收图、辅助识图也没配：发图这一路确实不通");
});

test("原生看图不变：伙伴自己的模型能看图时，照旧直接给图", async t => {
  const app = await boot(t, { globalVision: null, partnerVision: LEGACY_VISION });
  app.models.setCatalog([{ provider: "deepseek", model: "deepseek-flash", input: ["text", "image"] }]);
  const view = await app.request("GET", "/partners");
  const capability = view.body.partners?.[0]?.imageCapability;
  assert.equal(capability.native, true, "聊天模型收图就走原生那条路");
  assert.equal(capability.allowed, true, "原生能看图，辅助识图没配也不挡");
});

test("伙伴设置不再接受识图：当场拒绝，旧值一个字也不改", async t => {
  const app = await boot(t);
  // 伙伴设置存在账本文件里：读盘上的那份，才看得出服务端到底写了什么。
  const disk = () => createStore(app.dataDir);
  const before = disk().getPartnerSettings(AGENT).vision;
  assert.equal(before.model.provider, "legacy-provider", "旧值本来就留着");

  const rejected = await app.request("PUT", `/settings/partner/${AGENT}`, { json: { vision: { model: { provider: "x", model: "y" }, status: "verified" } } });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body?.error?.message ?? ""), /全局/u, "要说清楚识图归全局管");
  assert.deepEqual(disk().getPartnerSettings(AGENT).vision, before, "旧值不被覆盖");

  // 普通的伙伴设置也不能顺手把它改掉。
  const ordinary = await app.request("PUT", `/settings/partner/${AGENT}`, { json: { tier: "often" } });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.deepEqual(disk().getPartnerSettings(AGENT).vision, before, "普通伙伴设置不重写旧配置");
});

test("识图测试不再单独测伙伴：带 agentId 当场拒绝，全局也不动", async t => {
  const app = await boot(t, { globalVision: null });
  const rejected = await app.request("POST", "/vision/test", { json: { agentId: AGENT, model: { provider: "test-provider", model: "test-model" } } });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body?.error?.message ?? ""), /全局/u);
  assert.equal(createStore(app.dataDir).getGlobalSettings().vision?.model, null, "拒绝时全局一个字也不写");

  // 不带 agentId：照旧测全局那一份并存回去。
  app.models.answer((request) => request?.provider === "test-provider", "识图测试通过");
  const ok = await app.request("POST", "/vision/test", { json: { model: { provider: "test-provider", model: "test-model" } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(createStore(app.dataDir).getGlobalSettings().vision?.status, "verified");
});
