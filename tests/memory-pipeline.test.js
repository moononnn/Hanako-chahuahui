import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { bootChahuahui } from "./helpers/app-harness.js";
import { PROFILE_SYSTEM } from "../lib/summarize.js";
import { createStore } from "../lib/store.js";
import { AsyncLocalStorage } from "node:async_hooks";

const PROFILE = "你喜欢在院子里种薄荷，我们约好一起照看它。";
const entryUrl = process.env.CHAHUHUI_TEST_ENTRY ? pathToFileURL(process.env.CHAHUHUI_TEST_ENTRY) : undefined;
async function setup(t, seedExtra = () => {}) {
  let utilityCalls = 0;
  const app = await bootChahuahui({ entryUrl, seed(store, ctx) {
    store.setGlobalSettings({ proactiveEnabled: false });
    store.appendMessage("nova", { id: "u", role: "user", text: "我们一起照看院子里的薄荷吧" });
    store.appendMessage("nova", { id: "a", role: "assistant", text: "好，记得浇水", repliedTo: "u" });
    ctx.models.utility = async () => { utilityCalls++; throw new Error("shared utility must not be used"); };
    seedExtra(store, ctx);
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return { ...app, utilityCalls: () => utilityCalls };
}
function answerNormally(app) {
  app.models.answer((request) => request.systemPrompt === PROFILE_SYSTEM, PROFILE);
  app.models.answer(() => true, "[]");
}
const tidy = (app) => app.request("POST", "/memory/nova/tidy", { json: {} });

test("记忆整理跟随伙伴显式聊天模型，画像和话题均不调用共享工具模型", async (t) => {
  const app = await setup(t, (store, ctx) => {
    store.setPartnerSettings("nova", { model: { provider: "partner-provider", model: "partner-model" } });
    store.setGlobalSettings({ model: { provider: "global-provider", model: "global-model" } });
    ctx.models.list = async () => ({ models: [
      { provider: "test-provider", model: "test-model", isCurrent: true },
      { provider: "global-provider", model: "global-model" },
      { provider: "partner-provider", model: "partner-model" },
    ] });
  });
  answerNormally(app);
  const response = await tidy(app);
  assert.equal(response.body.profile.updated, true);
  assert.equal(response.body.topics.extracted, true);
  assert.equal(app.store.readMemory("nova").profile.text, PROFILE);
  assert.equal(app.utilityCalls(), 0);
  assert.equal(app.models.calls.length, 2);
  for (const { request } of app.models.calls) {
    assert.equal(request.provider, "partner-provider");
    assert.equal(request.model, "partner-model");
    assert.ok(request.maxTokens >= 8192, "短正文也要给思考和正文留足总预算");
  }
});

test("未单独选模时，记忆沿用同一伙伴的Hana默认模型", async (t) => {
  const app = await setup(t, (_store, ctx) => {
    const original = ctx.bus.request;
    ctx.bus.request = async (type, payload) => type === "agent:profile"
      ? { agent: { id: "nova", name: "小花" }, profile: { models: { chat: { provider: "agent-provider", model: "agent-model" } } } }
      : original(type, payload);
    ctx.models.list = async () => ({ models: [
      { provider: "test-provider", model: "test-model", isCurrent: true },
      { provider: "agent-provider", model: "agent-model" },
    ] });
  });
  answerNormally(app);
  const response = await tidy(app);
  assert.equal(response.body.profile.updated, true);
  assert.equal(app.models.calls[0].request.provider, "agent-provider");
  assert.equal(app.models.calls[0].request.model, "agent-model");
  assert.equal(app.utilityCalls(), 0);
});

test("延后任务继承的旧工具凭证不进入记忆模型服务", async (t) => {
  const invocation = new AsyncLocalStorage();
  const app = await setup(t);
  const original = app.ctx.models.stream;
  app.ctx.models.stream = async (request) => {
    if (invocation.getStore()?.expired) {
      const error = new Error("App invocation expired or belongs to another App");
      error.code = "APP_CALL_TOKEN_INVALID";
      throw error;
    }
    return original(request);
  };
  answerNormally(app);
  const token = { expired: false };
  const pending = new Promise((resolve, reject) => invocation.run(token, () => {
    setTimeout(() => tidy(app).then(resolve, reject), 0);
  }));
  token.expired = true;
  const response = await pending;
  assert.equal(response.body.profile.updated, true);
  assert.equal(response.body.topics.extracted, true);
  assert.equal(app.utilityCalls(), 0);
  assert.equal(app.serviceCalls.length, 2);
  assert.ok(app.serviceCalls.every((call) => call.type === "app:chahuahui/memory-generate" && call.options.timeout === 180_000));
});

test("记忆生成服务拒绝外部调用身份，不发模型请求", async (t) => {
  const app = await setup(t);
  const service = app.serviceHandlers.get("memory-generate");
  assert.equal(typeof service, "function");
  await assert.rejects(service({}, { callerAppId: "other-app", signal: new AbortController().signal }), /仅供本应用/);
  assert.equal(app.models.calls.length, 0);
  assert.equal(app.utilityCalls(), 0);
});

for (const kind of ["error", "unfinished"]) {
  test(`记忆流${kind}时拒绝非空半截，画像和话题水位不推进`, async (t) => {
    const app = await setup(t, (store, ctx) => {
      store.setProfile("nova", "你喜欢薄荷，这是已有的稳定档案。");
      ctx.models.stream = async () => new Response([
        JSON.stringify({ type: "text-delta", delta: PROFILE }),
        ...(kind === "error" ? [JSON.stringify({ type: "error", code: "APP_MODEL_PROVIDER_ERROR", message: "test failure" })] : []),
      ].join("\n"));
    });
    const before = app.store.readMemory("nova").profile;
    const response = await tidy(app);
    assert.equal(response.body.profile.updated, false);
    assert.equal(response.body.topics.extracted, false);
    assert.deepEqual(app.store.readMemory("nova").profile, before);
    assert.equal(createStore(app.dataDir).getPartnerSettings("nova").profileRefreshedAt ?? null, null);
    assert.equal(app.store.getTopicBook("nova").extractedThroughId ?? null, null);
    assert.equal(app.utilityCalls(), 0);
  });
}

test("画像等待期间来源变化，旧结果不落盘且不推进刷新时间", async (t) => {
  const app = await setup(t);
  app.models.answer((request) => request.systemPrompt !== PROFILE_SYSTEM, "[]");
  const pending = tidy(app);
  const call = await app.models.waitForCallWhere((request) => request.systemPrompt === PROFILE_SYSTEM, "画像");
  app.store.patchMessage("nova", "u", { text: "这条材料已经被修订" });
  app.models.release(call, PROFILE);
  const response = await pending;
  assert.equal(response.body.profile.updated, false);
  assert.equal(response.body.profile.reason, "source-changed");
  assert.equal(app.store.readMemory("nova").profile.text, "");
  assert.equal(createStore(app.dataDir).getPartnerSettings("nova").profileRefreshedAt ?? null, null);
});

test("没有可用聊天模型时保留空画像，不回退共享工具模型", async (t) => {
  const app = await setup(t, (_store, ctx) => { ctx.models.list = async () => ({ models: [] }); });
  const response = await tidy(app);
  assert.equal(response.body.profile.updated, false);
  assert.equal(response.body.topics.extracted, false);
  assert.equal(app.store.readMemory("nova").profile.text, "");
  assert.equal(app.models.calls.length, 0);
  assert.equal(app.utilityCalls(), 0);
});
