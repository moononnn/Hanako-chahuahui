import test from "node:test";
import assert from "node:assert/strict";

import { askUtility, withModelDeadline, parseNdjson, pickFromCatalog, normalizeModelRef, chatModelOptions, resolveModelChoice, modelKey } from "../lib/model.js";

const ndjson = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

test("模型请求到 deadline 会 cancel 并退出等待", async () => {
  const calls = [];
  const ctx = { models: { cancel: async (requestId) => calls.push(requestId) } };
  await assert.rejects(
    withModelDeadline(ctx, { requestId: "req-1", timeoutMs: 10, operation: "test", run: () => new Promise(() => {}) }),
    { code: "MODEL_TIMEOUT" },
  );
  assert.deepEqual(calls, ["req-1"]);
});

test("utility 也受 deadline 保护", async () => {
  const calls = [];
  const ctx = { models: { utility: async () => new Promise(() => {}), cancel: async (requestId) => calls.push(requestId) } };
  await assert.rejects(askUtility(ctx, { systemPrompt: "", userText: "", timeoutMs: 10 }), { code: "MODEL_TIMEOUT" });
  assert.equal(calls.length, 1);
});

test("流式事件里只取正文，思考通道被丢掉", () => {
  const raw = ndjson(
    { type: "start", requestId: "r" },
    { type: "reasoning-delta", requestId: "r", delta: "（这里在想事情）" },
    { type: "text-delta", requestId: "r", delta: "在呢" },
    { type: "text-delta", requestId: "r", delta: "刚洗完澡" },
    { type: "done", requestId: "r", stopReason: "stop", assistant: { role: "assistant", content: [] } },
  );
  const parsed = parseNdjson(raw);
  assert.equal(parsed.text, "在呢刚洗完澡");
  assert.equal(parsed.events, 5);
  assert.equal(parsed.errorMessage, null);
});

test("done 事件没有 text-delta 时回落到 assistant 内容", () => {
  const raw = ndjson({
    type: "done",
    requestId: "r",
    stopReason: "stop",
    assistant: { role: "assistant", content: [{ type: "text", text: "行，知道了" }] },
  });
  assert.equal(parseNdjson(raw).text, "行，知道了");
});

test("error 事件被记下来", () => {
  const raw = ndjson({ type: "error", requestId: "r", code: "X", message: "炸了" });
  const parsed = parseNdjson(raw);
  assert.equal(parsed.errorMessage, "炸了");
  assert.equal(parsed.text, "");
});

test("provider 报错后到达的片段不进入正文，错误前的正文保留", () => {
  const raw = ndjson(
    { type: "text-delta", delta: "早安阿舟，我再赖五分钟哈" },
    { type: "error", requestId: "r", code: "APP_MODEL_PROVIDER_ERROR", message: "中断" },
    { type: "text-delta", delta: " unerquickl" },
  );
  const parsed = parseNdjson(raw);
  assert.equal(parsed.text, "早安阿舟，我再赖五分钟哈");
});

test("provider 报错但完整英文在报错前，正常英文保留", () => {
  const raw = ndjson(
    { type: "text-delta", delta: "这个名字叫 strawberry" },
    { type: "error", requestId: "r", code: "APP_MODEL_PROVIDER_ERROR", message: "中断" },
  );
  assert.equal(parseNdjson(raw).text, "这个名字叫 strawberry");
});

test("普通 error 不触发 provider 片段截断", () => {
  const raw = ndjson(
    { type: "text-delta", delta: "保留这个 please" },
    { type: "error", requestId: "r", code: "X", message: "普通错误" },
    { type: "text-delta", delta: " tail" },
  );
  assert.equal(parseNdjson(raw).text, "保留这个 please tail");
});

test("非 JSON 行按纯文本累加", () => {
  assert.equal(parseNdjson("随便一行\n").text, "随便一行");
});

test("合法事件里混进来的杂项行不进正文，只留一条诊断", () => {
  // 2026-09-13：正文里偶发冒出西里尔、私用区码位、中文碎片这类怪字符，
  // 这道守卫钉住：已经有合法事件的时候，杂项行一句话都不许进气泡。
  const raw = [
    JSON.stringify({ type: "text-delta", delta: "在呢" }),
    "осколок 彩在线",
    JSON.stringify({ type: "text-delta", delta: "好" }),
  ].join("\n");
  const seen = [];
  const parsed = parseNdjson(raw, (row) => seen.push(row));
  assert.equal(parsed.text, "在呢好");
  assert.equal(seen.some((row) => row.event === "models.stream.stray"), true);
});

test("整份都是纯文本时仍然当正文（兼容某些 provider）", () => {
  assert.equal(parseNdjson("第一行\n第二行").text, "第一行\n第二行");
});

test("空输入不炸", () => {
  assert.deepEqual(parseNdjson(""), { text: "", events: 0, errorMessage: null });
  assert.deepEqual(parseNdjson(null), { text: "", events: 0, errorMessage: null });
});

test("选模型优先取 current，其次第一条", () => {
  const chosen = pickFromCatalog({
    models: [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2", isCurrent: true },
    ],
  });
  assert.deepEqual({ provider: chosen.provider, model: chosen.model }, { provider: "p2", model: "m2" });
});

test("模型目录缺少 provider 或 model 时返回 null，不瞎猜", () => {
  assert.equal(pickFromCatalog({ models: [{ name: "x" }] }), null);
  assert.equal(pickFromCatalog({ models: [] }), null);
  assert.equal(pickFromCatalog(null), null);
});

// ── 模型选择（全局默认 + 每位伙伴单独压一个）────────────────────

const CATALOG = {
  models: [
    { provider: "deepseek", model: "deepseek-flash", name: "Deepseek Flash" },
    { provider: "openai-codex", model: "gpt-5.6-luna", name: "GPT-5.6 Luna", isCurrent: true },
    { provider: "siliconflow", model: "BAAI/bge-m3", name: "BAAI/Bge M3" },
    { provider: "siliconflow", model: "Qwen/Qwen-Image", name: "Qwen/Qwen Image" },
  ],
};

test("模型引用：形状不对就当没设", () => {
  assert.deepEqual(normalizeModelRef({ provider: "p", model: "m" }), { provider: "p", model: "m" });
  assert.deepEqual(normalizeModelRef({ provider: "p", id: "m" }), { provider: "p", model: "m" });
  assert.equal(normalizeModelRef({ provider: "p" }), null);
  assert.equal(normalizeModelRef(null), null);
  assert.equal(normalizeModelRef("p/m"), null);
  assert.equal(modelKey({ provider: "p", model: "m" }), "p/m");
  assert.equal(modelKey(null), "");
});

test("下拉目录：嵌入和生图那些不往里塞，当前焦点排最前", () => {
  const rows = chatModelOptions(CATALOG);
  assert.deepEqual(rows.map((row) => row.key), ["openai-codex/gpt-5.6-luna", "deepseek/deepseek-flash"]);
  assert.equal(rows[0].isCurrent, true);
  assert.equal(chatModelOptions(null).length, 0);
});

test("定模型：伙伴指定 > 全局默认 > 宿主当前", () => {
  const byPartner = resolveModelChoice(CATALOG, {
    partnerRef: { provider: "deepseek", model: "deepseek-flash" },
    globalRef: { provider: "openai-codex", model: "gpt-5.6-luna" },
  });
  assert.deepEqual([byPartner.provider, byPartner.model, byPartner.source], ["deepseek", "deepseek-flash", "partner"]);

  const byGlobal = resolveModelChoice(CATALOG, { globalRef: { provider: "deepseek", model: "deepseek-flash" } });
  assert.deepEqual([byGlobal.provider, byGlobal.model, byGlobal.source], ["deepseek", "deepseek-flash", "global"]);

  const byCurrent = resolveModelChoice(CATALOG, {});
  assert.deepEqual([byCurrent.provider, byCurrent.model, byCurrent.source], ["openai-codex", "gpt-5.6-luna", "current"]);
});

test("定模型：指定那个不在目录里（换掉了、删了）就往下退，不硬用", () => {
  const gone = resolveModelChoice(CATALOG, {
    partnerRef: { provider: "deepseek", model: "已经没了" },
    globalRef: { provider: "deepseek", model: "deepseek-flash" },
  });
  assert.deepEqual([gone.provider, gone.model, gone.source], ["deepseek", "deepseek-flash", "global"]);
});

test("定模型：目录拉不到就先给 null，让上层走老路", () => {
  assert.equal(resolveModelChoice(null, { globalRef: { provider: "p", model: "m" } }), null);
});
