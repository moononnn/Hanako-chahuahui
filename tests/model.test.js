import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  askUtility,
  classifyModelFailure,
  generateReply,
  normalizeToolCallId,
  withModelDeadline,
  parseNdjson,
  pickFromCatalog,
  normalizeModelRef,
  chatModelOptions,
  isChatModel,
  resolveModelChoice,
  modelKey,
  STREAM_RETRY_DELAYS_MS,
} from "../lib/model.js";

const ndjson = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

// 真实基线：MiniMax 短任务的 180/400/500 输出全部耗在思考上；
// 假宿主复现同一预算条件，不读取或写入真实聊天，也不冒充真实模型验收。
function utilityCtx(run) {
  const requests = [];
  return {
    requests,
    models: {
      utility: async (request) => {
        requests.push(request);
        return run(request, requests.length);
      },
      cancel: async () => {},
      list: async () => { throw new Error("不能拿当前焦点反推后台模型"); },
      stream: async () => { throw new Error("不能静默切换模型或通道"); },
    },
  };
}

test("utility：180/400/500 小预算保留思考余量，仍使用原宿主通道", async () => {
  for (const maxTokens of [180, 400, 500]) {
    const ctx = utilityCtx(async (request) => {
      if (request.maxTokens < 8192) throw Object.assign(new Error("The auxiliary model provider could not complete the request."), { code: "APP_MODEL_PROVIDER_ERROR" });
      return { text: '{"query":"公开主题"}' };
    });
    const text = await askUtility(ctx, { systemPrompt: "只给短 JSON", userText: "测试输入", maxTokens });
    assert.equal(text, '{"query":"公开主题"}');
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].maxTokens, 8192);
    assert.equal(ctx.requests[0].scope, "app");
    assert.equal(ctx.requests[0].systemPrompt, "只给短 JSON");
    assert.deepEqual(ctx.requests[0].messages, [{ role: "user", content: "测试输入" }]);
    assert.equal("provider" in ctx.requests[0], false);
    assert.equal("model" in ctx.requests[0], false);
    assert.equal("thinking" in ctx.requests[0], false, "utility 不接受的参数不能乱塞");
  }
});

test("utility：已足够的预算不缩小，不虚增成无限上限", async () => {
  const ctx = utilityCtx(async () => ({ text: "好" }));
  await askUtility(ctx, { userText: "测试", maxTokens: 12000 });
  assert.equal(ctx.requests[0].maxTokens, 12000);
});

test("utility：空正文只在同一路增加预算重试一次，每次使用新编号", async () => {
  const seen = [];
  const ctx = utilityCtx(async (_request, attempt) => ({ text: attempt === 1 ? "  " : "  可用正文  " }));
  assert.equal(await askUtility(ctx, { userText: "测试", maxTokens: 180, diagnostics: (row) => seen.push(row) }), "可用正文");
  assert.deepEqual(ctx.requests.map((row) => row.maxTokens), [8192, 16384]);
  assert.notEqual(ctx.requests[0].requestId, ctx.requests[1].requestId);
  assert.ok(seen.some((row) => row.event === "models.utility.retry" && row.reason === "empty"));
  assert.ok(seen.some((row) => row.event === "models.utility.ok" && row.attempt === 2));
  assert.ok(!JSON.stringify(seen).includes("测试"), "诊断不记录输入原话");
});

test("utility：宿主明说空正文才增加预算，不把所有 provider 错误当预算不足", async () => {
  const ctx = utilityCtx(async (_request, attempt) => {
    if (attempt === 1) throw Object.assign(new Error("模型未回复正文，请检查思考内容或稍后重试。"), { code: "LLM_EMPTY_RESPONSE" });
    return { text: "恢复" };
  });
  assert.equal(await askUtility(ctx, { userText: "测试" }), "恢复");
  assert.deepEqual(ctx.requests.map((row) => row.maxTokens), [8192, 16384]);
});

test("utility：重复空正文是失败，最多两次，不返回空串假成功", async () => {
  const ctx = utilityCtx(async () => ({ text: "" }));
  await assert.rejects(askUtility(ctx, { userText: "测试" }), { code: "MODEL_EMPTY_RESPONSE" });
  assert.equal(ctx.requests.length, 2);
});

test("utility：16384 已到重试上限时空正文立即失败", async () => {
  const ctx = utilityCtx(async () => ({ text: "" }));
  await assert.rejects(askUtility(ctx, { userText: "测试", maxTokens: 16384 }), { code: "MODEL_EMPTY_RESPONSE" });
  assert.equal(ctx.requests.length, 1);
});

test("utility：鉴权、限额、内容拦截、超时及模糊 provider 错误原样失败且不重试", async () => {
  for (const [code, message] of [
    ["APP_MODEL_PROVIDER_ERROR", "The auxiliary model provider could not complete the request."],
    ["401", "invalid api key"], ["429", "rate limit"],
    ["1026", "input new_sensitive (1026)"], ["MODEL_TIMEOUT", "timeout"],
  ]) {
    const error = Object.assign(new Error(message), { code });
    const ctx = utilityCtx(async () => { throw error; });
    await assert.rejects(askUtility(ctx, { userText: "测试" }), (actual) => actual === error);
    assert.equal(ctx.requests.length, 1, code);
  }
});

test("utility：重试共用总耗时上限，耗尽后不得发第二次请求", async () => {
  const ctx = utilityCtx(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { text: "" };
  });
  await assert.rejects(askUtility(ctx, { userText: "测试", timeoutMs: 10 }), { code: "MODEL_TIMEOUT" });
  assert.equal(ctx.requests.length, 1);
});

test("utility：没有 text 的回包也不能当成成功", async () => {
  const ctx = utilityCtx(async () => ({ reasoning_content: "内部思考" }));
  await assert.rejects(askUtility(ctx, { userText: "测试" }), { code: "MODEL_EMPTY_RESPONSE" });
  assert.equal(ctx.requests.length, 2);
});

test("utility：主入口统一传诊断，仅延长后台任务，前台搜索仍有短时限", async () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("  const askCheap =");
  assert.ok(start >= 0);
  const diagnostics = () => {};
  const end = source.indexOf("\n  });", start);
  assert.ok(end > start);
  const ask = vm.runInNewContext(source.slice(start, end + "\n  });".length) + "\naskCheap;", {
    ctx: {}, askUtility: (_ctx, input) => input, diagnostics,
  });
  for (const timeoutMs of [10000, 20000]) {
    const input = await ask("简短任务", "测试", 180, { timeoutMs });
    assert.equal(input.timeoutMs, timeoutMs);
    assert.equal(input.diagnostics, diagnostics);
    assert.equal(input.maxTokens, 180, "最终预算由共享 utility 入口调整");
  }
  assert.equal((await ask("", "", 400)).timeoutMs, 120000);
  assert.match(source, /raw = await askCheap\(spec\.systemPrompt, spec\.userText, 420, \{ timeoutMs: 60_000 \}\)/);
  // 2026-10-20：探索问句那步从 180 抬到 800（180 被思考吃干净，整天取不到料），契约跟着改。
  assert.match(source, /rawPlan = await askCheap\(spec\.systemPrompt, spec\.userText, 800, \{ timeoutMs: 60_000 \}\)/);
  assert.match(source, /ask: \(prompt, text\) => askCheap\(prompt, text, 180, \{ timeoutMs: 10_000 \}\)/);
});

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
  assert.deepEqual(parseNdjson(""), { text: "", events: 0, errorMessage: null, toolCalls: [], assistantContent: null, stopReason: null });
  assert.deepEqual(parseNdjson(null), { text: "", events: 0, errorMessage: null, toolCalls: [], assistantContent: null, stopReason: null });
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

// ── 失败分类：哪些能拿备用模型顶一下，哪些不能 ───────────────────

test("配额、凭据/provider 挂掉不能兜底，超时和连接断了才能", () => {
  assert.equal(classifyModelFailure({ message: "You've hit your usage limit" }), "quota");
  assert.equal(classifyModelFailure({ code: "429", message: "rate limit" }), "quota");
  assert.equal(classifyModelFailure({ message: "The model provider could not complete the request." }), "provider");
  assert.equal(classifyModelFailure({ code: "APP_MODEL_PROVIDER_ERROR", message: "中断" }), "provider");
  assert.equal(classifyModelFailure({ code: "MODEL_TIMEOUT" }), "transient");
  assert.equal(classifyModelFailure({ message: "fetch failed" }), "transient");
  // 认不出来的按临时算：宁可照旧兜底，也不因为没见过的报错就哑掉
  assert.equal(classifyModelFailure({ message: "某种没见过的毛病" }), "transient");
  assert.equal(classifyModelFailure({}), "transient");
});

/** 假宿主：stream 回指定的流，utility 记一笔（用它判断有没有去借别的模型）。 */
function fakeCtx(raw, { utilityText = "借来的声音" } = {}) {
  const seen = { utility: 0, stream: 0 };
  return {
    seen,
    models: {
      cancel: async () => {},
      stream: async () => {
        seen.stream += 1;
        return { text: async () => raw };
      },
      utility: async () => {
        seen.utility += 1;
        return { text: utilityText };
      },
    },
  };
}

test("provider 挂掉时不借别的模型顶嘴，同一个模型原地重试到底才报模型不可用", async () => {
  const raw = ndjson({ type: "error", requestId: "r", code: "APP_MODEL_PROVIDER_ERROR", message: "The model provider could not complete the request." });
  const ctx = fakeCtx(raw);
  await assert.rejects(
    generateReply(ctx, {
      systemPrompt: "",
      messages: [],
      modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
      catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
      retryDelaysMs: [0, 0, 0],
    }),
    { code: "MODEL_UNAVAILABLE", kind: "provider" },
  );
  assert.equal(ctx.seen.stream, 4, "一次加三次重试");
  assert.equal(ctx.seen.utility, 0, "不许拿另一个模型的嘴替 ta 说话");
});

test("provider 抖一下就好：原地重试接上，不挂「接不上话」也不借别的模型", async () => {
  const bad = ndjson({ type: "error", requestId: "r", code: "APP_MODEL_PROVIDER_ERROR", message: "The model provider could not complete the request." });
  const good = ndjson({ type: "text-delta", delta: "在呢" }, { type: "done", requestId: "r", stopReason: "stop" });
  const ctx = fakeCtx(bad);
  let call = 0;
  ctx.models.stream = async () => {
    call += 1;
    return { text: async () => (call === 1 ? bad : good) };
  };
  const events = [];
  const out = await generateReply(ctx, {
    systemPrompt: "", messages: [],
    modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
    catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
    retryDelaysMs: [0, 0, 0],
    diagnostics: (row) => events.push(row),
  });
  assert.equal(out.text, "在呢");
  assert.equal(out.via, "stream:openai-codex/gpt-6-luna");
  assert.equal(ctx.seen.utility, 0, "不需要借 utility，也就没有换嗓子");
  assert.equal(events.filter((row) => row.event === "models.stream.retry").length, 1);
});

test("重试的是同一个模型：每次尝试都带同一个 provider/model 和不同 requestId", async () => {
  const bad = ndjson({ type: "error", requestId: "r", code: "APP_MODEL_PROVIDER_ERROR", message: "The model provider could not complete the request." });
  const calls = [];
  const ctx = fakeCtx(bad);
  ctx.models.stream = async (request) => {
    calls.push(request);
    return { text: async () => bad };
  };
  await assert.rejects(generateReply(ctx, {
    systemPrompt: "", messages: [],
    modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
    catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
    retryDelaysMs: [0, 0, 0],
  }), { code: "MODEL_UNAVAILABLE", kind: "provider" });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.provider, "openai-codex");
    assert.equal(call.model, "gpt-6-luna");
  }
  assert.equal(new Set(calls.map((call) => call.requestId)).size, 4, "同一 requestId 不能复用于两次活动请求");
});

test("配额用完不重试也不兜底", async () => {
  const raw = ndjson({ type: "error", requestId: "r", code: "429", message: "usage limit reached" });
  const ctx = fakeCtx(raw);
  await assert.rejects(
    generateReply(ctx, {
      systemPrompt: "",
      messages: [],
      modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
      catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
      retryDelaysMs: [0, 0, 0],
    }),
    { code: "MODEL_UNAVAILABLE", kind: "quota" },
  );
  assert.equal(ctx.seen.stream, 1, "钱包在哭的时候不该再敲");
  assert.equal(ctx.seen.utility, 0);
});

test("重试间隔是拉开的，不是连着敲门", () => {
  assert.equal(STREAM_RETRY_DELAYS_MS.length, 3);
  assert.equal(STREAM_RETRY_DELAYS_MS[0], 1500);
  for (let i = 1; i < STREAM_RETRY_DELAYS_MS.length; i += 1) {
    assert.ok(STREAM_RETRY_DELAYS_MS[i] > STREAM_RETRY_DELAYS_MS[i - 1]);
  }
});

test("超时这类临时故障仍然借 utility 顶一下", async () => {
  const ctx = fakeCtx("");
  const out = await generateReply(ctx, {
    systemPrompt: "",
    messages: [],
    modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
    catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
  });
  assert.equal(out.via, "utility");
  assert.equal(ctx.seen.utility, 1);
});

test("回复的原有 utility 兜底也留出思考预算，完整上下文不被压成一条", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "第一条" }] },
    { role: "assistant", content: [{ type: "text", text: "已有回复" }] },
    { role: "user", content: [{ type: "text", text: "第二条" }] },
  ];
  const ctx = utilityCtx(async (request) => {
    assert.equal(request.maxTokens, 8192);
    assert.equal(request.messages, messages);
    return { text: "恢复原有备用回复" };
  });
  ctx.models.stream = async () => ({ text: async () => "" });
  const out = await generateReply(ctx, {
    systemPrompt: "保留人格", messages,
    modelRef: { provider: "test", model: "test" }, maxTokens: 900,
    catalog: { models: [{ provider: "test", model: "test" }] },
  });
  assert.equal(out.via, "utility");
  assert.equal(out.text, "恢复原有备用回复");
  assert.equal(ctx.requests[0].systemPrompt, "保留人格");
});

test("回复的 utility 兜底重复空正文仍失败，不返回空答案", async () => {
  const ctx = utilityCtx(async () => ({ text: "" }));
  ctx.models.stream = async () => ({ text: async () => "" });
  await assert.rejects(generateReply(ctx, {
    systemPrompt: "", messages: [{ role: "user", content: "测试" }],
    modelRef: { provider: "test", model: "test" },
    catalog: { models: [{ provider: "test", model: "test" }] },
  }), { code: "MODEL_EMPTY_RESPONSE" });
  assert.equal(ctx.requests.length, 2);
});

test("signal：预先取消的 generateReply 不列目录、不发模型、不走 utility", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = fakeCtx(ndjson({ type: "text-delta", delta: "不该成功" }, { type: "done", stopReason: "stop" }));
  let lists = 0;
  ctx.models.list = async () => { lists++; return { models: [{ provider: "test", model: "test" }] }; };
  await assert.rejects(generateReply(ctx, {
    systemPrompt: "", messages: [], signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(lists, 0);
  assert.deepEqual(ctx.seen, { stream: 0, utility: 0 });
});

test("signal：withModelDeadline 预取消不执行 run，也不 cancel 未发出的请求", async () => {
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  let cancels = 0;
  await assert.rejects(withModelDeadline({ models: { cancel: async () => { cancels++; } } }, {
    requestId: "pre-aborted", timeoutMs: 100, signal: controller.signal,
    run: async () => { runs++; return "不该执行"; },
  }), { name: "AbortError" });
  assert.equal(runs, 0);
  assert.equal(cancels, 0);
});

test("signal：读取流正文期间取消会 cancel 同一请求，丢弃晚到正文且不重试不兜底", async () => {
  const controller = new AbortController();
  const ctx = fakeCtx("");
  const cancelled = [];
  const diagnostics = [];
  let requestId;
  let bodyRead = false;
  ctx.models.cancel = async (id) => { cancelled.push(id); };
  ctx.models.stream = async (request) => {
    ctx.seen.stream++;
    requestId = request.requestId;
    return { text: async () => {
      queueMicrotask(() => controller.abort());
      await new Promise((resolve) => setTimeout(resolve, 25));
      bodyRead = true;
      return ndjson({ type: "text-delta", delta: "取消后才读完的正文" }, { type: "done", stopReason: "stop" });
    } };
  };
  await assert.rejects(generateReply(ctx, {
    systemPrompt: "", messages: [], signal: controller.signal, strictOutput: true,
    modelRef: { provider: "test", model: "test" }, catalog: [], retryDelaysMs: [0, 0],
    diagnostics: (row) => diagnostics.push(row),
  }), { name: "AbortError" });
  assert.equal(bodyRead, false, "取消不应继续等待正文读完");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bodyRead, true, "假流确实在取消后返回了完整正文");
  assert.deepEqual(cancelled, [requestId]);
  assert.deepEqual(ctx.seen, { stream: 1, utility: 0 });
  assert.equal(diagnostics.some((row) => ["models.stream.ok", "models.stream.retry"].includes(row.event)), false);
});

test("signal：deadline 取消不等待挂起的 cancel，并清理 abort 监听", async () => {
  const controller = new AbortController();
  const { signal } = controller;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { if (args[0] === "abort") listeners++; return add(...args); };
  signal.removeEventListener = (...args) => { if (args[0] === "abort") listeners--; return remove(...args); };
  const cancelled = [];
  const reason = new Error("宿主服务取消");
  const result = withModelDeadline({ models: { cancel: async (id) => {
    cancelled.push(id);
    return new Promise(() => {});
  } } }, {
    requestId: "running-abort", timeoutMs: 100, signal,
    run: async () => {
      queueMicrotask(() => controller.abort(reason));
      await new Promise((resolve) => setTimeout(resolve, 25));
      return "晚到结果";
    },
  });
  await assert.rejects(result, (error) => error === reason);
  assert.deepEqual(cancelled, ["running-abort"]);
  assert.equal(listeners, 0);
});

test("signal：正常完成会移除 abort 监听，之后取消不再 cancel 请求", async () => {
  const controller = new AbortController();
  const { signal } = controller;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { if (args[0] === "abort") listeners++; return add(...args); };
  signal.removeEventListener = (...args) => { if (args[0] === "abort") listeners--; return remove(...args); };
  let cancels = 0;
  assert.equal(await withModelDeadline({ models: { cancel: async () => { cancels++; } } }, {
    requestId: "normal-signal", timeoutMs: 100, signal, run: async () => "完整正文",
  }), "完整正文");
  assert.equal(listeners, 0);
  controller.abort();
  await Promise.resolve();
  assert.equal(cancels, 0);
});

test("陪读提醒严格路径：空正文不换utility、不重试", async () => {
  const ctx = fakeCtx("");
  await assert.rejects(generateReply(ctx, {
    systemPrompt: "", messages: [], retryDelaysMs: [], allowUtilityFallback: false,
    modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
    catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
  }), { code: "MODEL_UNAVAILABLE" });
  assert.equal(ctx.seen.stream, 1);
  assert.equal(ctx.seen.utility, 0);
});

test("strictOutput：带 error 的非空半截输出失败，即使随后有 done", async () => {
  for (const error of [
    { code: "APP_MODEL_PROVIDER_ERROR", message: "provider interrupted" },
    { code: "X", message: "普通错误" },
    { code: "X", message: "" },
  ]) {
    const ctx = fakeCtx(ndjson(
      { type: "text-delta", delta: '{"memory":"半截' },
      { type: "error", ...error },
      { type: "done", stopReason: "stop" },
    ));
    await assert.rejects(generateReply(ctx, {
      systemPrompt: "", messages: [], strictOutput: true,
      retryDelaysMs: [], allowUtilityFallback: false,
      modelRef: { provider: "test", model: "test" }, catalog: [],
    }), { code: "MODEL_UNAVAILABLE" });
    assert.equal(ctx.seen.stream, 1);
    assert.equal(ctx.seen.utility, 0);
  }
});

test("strictOutput：缺少正常完成标志的非空流失败", async () => {
  for (const raw of [
    ndjson({ type: "text-delta", delta: "半截正文" }),
    "兼容纯文本也没有完成标志",
    ...[undefined, "length", "toolUse", "deferred"].map((stopReason) => ndjson(
      { type: "text-delta", delta: "非正常完成正文" },
      { type: "done", stopReason },
    )),
  ]) {
    const ctx = fakeCtx(raw);
    await assert.rejects(generateReply(ctx, {
      systemPrompt: "", messages: [], strictOutput: true,
      retryDelaysMs: [], allowUtilityFallback: false,
      modelRef: { provider: "test", model: "test" }, catalog: [],
    }), { code: "MODEL_UNAVAILABLE" });
    assert.equal(ctx.seen.stream, 1);
    assert.equal(ctx.seen.utility, 0);
  }
});

test("strictOutput：正常 stop 正文成功，支持 done assistant 回填并丢弃思考", async () => {
  for (const raw of [
    ndjson(
      { type: "reasoning-delta", delta: "内部思考" },
      { type: "text-delta", delta: "  完整正文  " },
      { type: "done", stopReason: "stop", assistant: { role: "assistant", content: [] } },
    ),
    ndjson({ type: "done", stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text: "完整正文" }] } }),
  ]) {
    const ctx = fakeCtx(raw);
    const out = await generateReply(ctx, {
      systemPrompt: "", messages: [], strictOutput: true,
      retryDelaysMs: [], allowUtilityFallback: false,
      modelRef: { provider: "test", model: "test" }, catalog: [],
    });
    assert.equal(out.text, "完整正文");
    assert.equal(out.via, "stream:test/test");
    assert.equal(ctx.seen.stream, 1);
    assert.equal(ctx.seen.utility, 0);
  }
});

test("strictOutput 默认关闭：普通聊天仍接受错误前正文和无 done 正文", async () => {
  for (const strictOutput of [undefined, false]) {
    for (const raw of [
      ndjson({ type: "text-delta", delta: "保留正文" }, { type: "error", code: "APP_MODEL_PROVIDER_ERROR", message: "中断" }),
      ndjson({ type: "text-delta", delta: "保留正文" }),
      "保留正文",
    ]) {
      const ctx = fakeCtx(raw);
      const out = await generateReply(ctx, {
        systemPrompt: "", messages: [], ...(strictOutput === undefined ? {} : { strictOutput }),
        modelRef: { provider: "test", model: "test" }, catalog: [],
      });
      assert.equal(out.text, "保留正文");
      assert.equal(ctx.seen.stream, 1);
      assert.equal(ctx.seen.utility, 0);
    }
  }
});

test("正常回包不碰 utility", async () => {
  const raw = ndjson({ type: "text-delta", delta: "在呢" }, { type: "done", requestId: "r", stopReason: "stop" });
  const ctx = fakeCtx(raw);
  const out = await generateReply(ctx, {
    systemPrompt: "",
    messages: [],
    modelRef: { provider: "openai-codex", model: "gpt-6-luna" },
    catalog: { models: [{ provider: "openai-codex", model: "gpt-6-luna" }] },
  });
  assert.equal(out.via, "stream:openai-codex/gpt-6-luna");
  assert.equal(ctx.seen.utility, 0);
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

test("名字带 image 的理解型模型不再被当成生图筛掉", () => {
  assert.equal(isChatModel({ provider: "p", model: "some-vendor/vision-image-llm" }), true);
  assert.equal(isChatModel({ provider: "p", model: "qwen-image-edit" }), false);
  assert.equal(isChatModel({ provider: "p", model: "gpt-image-1" }), false);
  assert.equal(isChatModel({ provider: "p", model: "doubao-seedream-4" }), false);
  assert.equal(isChatModel({ provider: "p", model: "flux-dev" }), false);
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

test("定模型：伙伴在 Hana 里的默认模型垫在宿主焦点模型前面", () => {
  // 2026-09-28：以前没这一档，没单独指定就直接退到宿主的“当前焦点模型”，
  // 结果是每位伙伴在 Hana 里各配各的，茶话会里却全员都用同一个模型。
  const byAgent = resolveModelChoice(CATALOG, { agentRef: { provider: "deepseek", id: "deepseek-flash" } });
  assert.deepEqual([byAgent.provider, byAgent.model, byAgent.source], ["deepseek", "deepseek-flash", "agent"]);

  // 本应用里显式指定的，仍然压在伙伴默认前面（显式 > 隐式）
  const explicitWins = resolveModelChoice(CATALOG, {
    globalRef: { provider: "deepseek", model: "deepseek-flash" },
    agentRef: { provider: "openai-codex", model: "gpt-5.6-luna" },
  });
  assert.deepEqual([explicitWins.provider, explicitWins.model, explicitWins.source], ["deepseek", "deepseek-flash", "global"]);

  // 伙伴默认那个模型不在目录里了（换 provider、删了）就往下退，不硬用
  const gone = resolveModelChoice(CATALOG, { agentRef: { provider: "deepseek", model: "已经没了" } });
  assert.deepEqual([gone.provider, gone.model, gone.source], ["openai-codex", "gpt-5.6-luna", "current"]);
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

// ── 工具回合（2026-10-21）：伙伴自己发起搜索，结果回喂后才开口 ──

function toolCtx(turns, { onStream } = {}) {
  const requests = [];
  let turn = 0;
  return {
    requests,
    models: {
      list: async () => ({ models: [{ provider: "p", model: "m", isCurrent: true }] }),
      cancel: async () => {},
      utility: async () => { throw new Error("这条不该退到 utility"); },
      stream: async (request) => {
        requests.push(request);
        onStream?.(request, turn);
        const body = turns[Math.min(turn, turns.length - 1)];
        turn += 1;
        if (typeof body === "function") return body(request);
        return { text: async () => body };
      },
    },
  };
}

const TOOL_DECL = [{ name: "web_search", description: "搜", parameters: { type: "object", properties: { query: { type: "string" } } } }];

test("工具回合：模型自己发起搜索，工具结果回喂之后才给正文", async () => {
  const ctx = toolCtx([
    ndjson(
      { type: "tool-call", requestId: "r", id: "call_1", name: "web_search", arguments: { query: "PCL 我的世界 下载 争议" } },
      { type: "done", requestId: "r", stopReason: "toolUse", assistant: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "PCL 我的世界 下载 争议" } }] } },
    ),
    ndjson(
      { type: "text-delta", requestId: "r", delta: "查到了，PCL 那边确实停了下载。" },
      { type: "done", requestId: "r", stopReason: "stop", assistant: { role: "assistant", content: [] } },
    ),
  ]);
  const calls = [];
  const result = await generateReply(ctx, {
    systemPrompt: "你是伙伴",
    messages: [{ role: "user", content: "你去找找" }],
    diagnostics: () => {},
    modelRef: { provider: "p", model: "m" },
    tools: TOOL_DECL,
    executeTool: async (call) => {
      calls.push(call);
      return { isError: false, text: "【搜索结果】· PCL 停止下载" };
    },
  });
  assert.equal(result.text, "查到了，PCL 那边确实停了下载。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "web_search");
  assert.equal(calls[0].arguments.query, "PCL 我的世界 下载 争议");
  assert.equal(ctx.requests.length, 2, "工具回合一共两轮模型请求");
  assert.equal(ctx.requests[0].tools.length, 1, "第一轮带工具声明");
  const second = ctx.requests[1].messages;
  const toolResult = second[second.length - 1];
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.toolCallId, "call_1");
  assert.equal(toolResult.toolName, "web_search");
  assert.equal(toolResult.isError, false);
  assert.match(toolResult.content[0].text, /PCL 停止下载/);
  const assistantTurn = second[second.length - 2];
  assert.equal(assistantTurn.role, "assistant");
  assert.equal(assistantTurn.content[0].type, "toolCall");
});

test("工具回合：搜索次数有上限，超了就停手并如实说", async () => {
  const callBody = () => ({ text: async () => ndjson(
    { type: "tool-call", requestId: "r", id: "call_x", name: "web_search", arguments: { query: "热搜" } },
    { type: "done", requestId: "r", stopReason: "toolUse", assistant: { role: "assistant", content: [] } },
  ) });
  const ctx = toolCtx([callBody]);
  const calls = [];
  const result = await generateReply(ctx, {
    systemPrompt: "你是伙伴",
    messages: [{ role: "user", content: "你查查" }],
    diagnostics: () => {},
    modelRef: { provider: "p", model: "m" },
    tools: TOOL_DECL,
    executeTool: async (call) => {
      calls.push(call);
      return { isError: false, text: "【搜索结果】· 某条消息" };
    },
    maxToolCalls: 2,
    maxToolRounds: 2,
  });
  assert.equal(calls.length, 2, "一轮最多两次搜索");
  const last = ctx.requests[ctx.requests.length - 1];
  assert.equal(last.tools, undefined, "最后一轮不给工具：逼出一句人话");
});

test("工具回合：模型不接工具声明时，退回不带工具的普通回复", async () => {
  let turn = 0;
  const ctx = toolCtx([
    () => { throw new Error("tools are not supported by this provider"); },
    ndjson(
      { type: "text-delta", requestId: "r", delta: "那我只能按我手头说的讲。" },
      { type: "done", requestId: "r", stopReason: "stop", assistant: { role: "assistant", content: [] } },
    ),
  ]);
  const seen = [];
  const result = await generateReply(ctx, {
    systemPrompt: "你是伙伴",
    messages: [{ role: "user", content: "你查查" }],
    diagnostics: (row) => seen.push(row),
    modelRef: { provider: "p", model: "m" },
    tools: TOOL_DECL,
    executeTool: async () => ({ isError: false, text: "不该被执行" }),
  });
  assert.equal(result.text, "那我只能按我手头说的讲。");
  assert.ok(seen.some((row) => row.event === "models.tools.unsupported"));
});

test("工具回合：没有工具时就是普通回复，不多花一次往返", async () => {  const ctx = toolCtx([
    ndjson(
      { type: "text-delta", requestId: "r", delta: "在呢" },
      { type: "done", requestId: "r", stopReason: "stop", assistant: { role: "assistant", content: [] } },
    ),
  ]);
  const result = await generateReply(ctx, {
    systemPrompt: "你是伙伴",
    messages: [{ role: "user", content: "在吗" }],
    diagnostics: () => {},
    modelRef: { provider: "p", model: "m" },
  });
  assert.equal(result.text, "在呢");
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].tools, undefined);
});

test("工具 id 规整：不合法的 id 换成能用的标识符", () => {
  // 2026-10-21 实机踩过：原样回放 provider 给的 id 会被宿主拒（APP_MODEL_INVALID_REQUEST）。
  assert.equal(normalizeToolCallId("call_abc123"), "call_abc123", "本来就合法的别动");
  assert.equal(normalizeToolCallId(""), "call_1", "空串也要有个能用的");
  assert.equal(normalizeToolCallId("call.abc/123"), "callabc123", "非法字符去掉");
  assert.equal(normalizeToolCallId("工具一"), "call_1", "中文 id 换成一个能用的");
  assert.equal(normalizeToolCallId(null, 3), "call_4");
});

test("工具回合：回喂时 assistant 与 toolResult 用同一个合法 id", async () => {
  const ctx = toolCtx([
    ndjson(
      { type: "tool-call", requestId: "r", id: "call.有斜杠/和点", name: "web_search", arguments: { query: "热搜" } },
      { type: "done", requestId: "r", stopReason: "toolUse", assistant: { role: "assistant", content: [{ type: "toolCall", id: "call.有斜杠/和点", name: "web_search", arguments: { query: "热搜" } }] } },
    ),
    ndjson(
      { type: "text-delta", requestId: "r", delta: "查到了，趁着热。" },
      { type: "done", requestId: "r", stopReason: "stop", assistant: { role: "assistant", content: [] } },
    ),
  ]);
  const result = await generateReply(ctx, {
    systemPrompt: "你是伙伴",
    messages: [{ role: "user", content: "你去查查" }],
    diagnostics: () => {},
    modelRef: { provider: "p", model: "m" },
    tools: TOOL_DECL,
    executeTool: async () => ({ isError: false, text: "【搜索结果】· 某条消息" }),
  });
  assert.equal(result.text, "查到了，趁着热。");
  const second = ctx.requests[1].messages;
  const assistantTurn = second[second.length - 2];
  const toolResult = second[second.length - 1];
  assert.match(assistantTurn.content[0].id, /^[A-Za-z0-9_-]{1,128}$/, "回放的 toolCall id 必须是合法标识符");
  assert.equal(toolResult.toolCallId, assistantTurn.content[0].id, "两边必须是同一个 id");
});
