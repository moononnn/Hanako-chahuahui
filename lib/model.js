/**
 * 调模型。（文件预算豁免）
 *
 * 为什么先合着：这是与宿主 `ctx.models` 的唯一适配面，选模型、拼请求、解 NDJSON
 * 事件流、算预算、归一错误、重试退避全在这一层。选出来的 ref 和真正发出去的那次
 * 调用必须成对，行数主要花在事件分支与错误映射上，不是职责发散。
 *
 * 已知最弱的一处：上面「选模型」（normalize / resolve / pick）与下面「跑一次调用」
 * （withModelDeadline / askUtility / generateReply）本可以分家。目前选与用绑在一起
 * 是因为很多测试就是成对钉它们的（选了就必须按那个选去发、失败得按那个选归一）；
 * 哪天测试改成只钉一端，这里就该拆。拆的时候两边都不动宿主契约面。
 *
 * 契约以 `@hana/app-sdk` 的 app-contract/models.d.ts 为准（Hana 0.951.4）：
 *
 *  - `ctx.models.list()` → { models: [...] }
 *  - `ctx.models.stream(request)` → **Promise<Response>**（NDJSON）
 *      每行一个事件：{type:"text-delta", delta} / {type:"reasoning-delta", delta}
 *      / {type:"done", assistant, usage} / {type:"error", code, message}
 *      正文与思考是两条独立事件通道 →「看不到思考内容」天生做得到
 *  - `ctx.models.utility(request)` → { requestId, text }（用宿主 utility 配置，不能选模型）
 *  - `ctx.models.cancel(requestId)` → 释放一个仍在活动的请求
 *
 * ⚠️ 同一个 requestId 不能重复用于两个活动请求（会 APP_MODEL_DUPLICATE_REQUEST），
 *    所以每次尝试各用一个新 id。
 */

import { setTimeout as waitMs } from "node:timers/promises";
import { modelSupportsImage } from "./vision.js";

function rid(tag) {
  return `chahuahui_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 用量归属：宿主账本把插件调用统一记成「茶话会」，不记是哪位伙伴、干什么活儿。
// 所以每次发请求时把 requestId 与身份递给观察者，由 index.js 落到
// usage-book；展示时再用 requestId 把宿主条目对上号。
let usageObserver = null;

export function setUsageObserver(fn) {
  usageObserver = typeof fn === "function" ? fn : null;
}

function noteUsage(entry) {
  if (!usageObserver) return;
  try {
    usageObserver(entry);
  } catch {
    // 记账不能拖垮聊天：宿主账本本来也有一份，这里只是补一维身份。
  }
}


// ────────────────────────── 模型选择 ──────────────────────────
//
// 2026-09-13 加：以前固定“跟当前主模型走”，她要求能给全局和每位伙伴各配一个。
// 规矩：伙伴指定 > 全局指定 > 宿主当前模型 > 目录第一个。
// 指定的那个在目录里找不到（模型被删了、provider 改了）就往下退，不硬用。

export const FOLLOW_CURRENT = "follow";

/** 一个模型引用的规范形状：{ provider, model }；不成形状就当没设。 */
export function normalizeModelRef(value) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider ?? "").trim();
  const model = String(value.model ?? value.id ?? "").trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/** UI 和存储都用这个 key 表示“哪个模型”。 */
export function modelKey(ref) {
  const norm = normalizeModelRef(ref);
  return norm ? `${norm.provider}/${norm.model}` : "";
}

/** 把目录里的一条投影成 { provider, model }。 */
export function entryRef(row) {
  const provider = row?.provider ?? row?.providerId ?? null;
  const model = row?.model ?? row?.modelId ?? row?.id ?? null;
  if (!provider || !model) return null;
  return { provider: String(provider), model: String(model) };
}

/**
 * 看着就不像能聊天的：嵌入、重排、生图、语音、视频。
 * 宿主这份目录投影里没有“用途”字段，只能按名字认——拿到新字段再换掉这里。
 * 宁可少列一个，也别让她选到一个生成必报错的图。
 *
 * 生图那几个词按家族列，不用裸 `image`：宿主自己用目录源条目的 `type` 已经挡掉了
 * gpt-image / dall-e / doubao-seedream 这一批，裸 `image` 在这层只会误伤名字带 image
 * 的理解型模型；而宿主漏标 `type` 的 flux 又拦不住。
 */
const NON_CHAT_RE = /(embedding|embed|rerank|bge|\btts\b|whisper|speech|\basr\b|gpt-image|qwen-image|dall-e|dalle|seedream|flux|modnet|\bsam-)/i;

export function isChatModel(ref) {
  const norm = normalizeModelRef(ref);
  if (!norm) return false;
  return !NON_CHAT_RE.test(norm.model);
}

/** 给设置页的下拉用：只留能聊天的，当前焦点提到最前，其余保持宿主原顺序。 */
export function chatModelOptions(catalog) {
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  const out = [];
  for (const row of rows) {
    const ref = entryRef(row);
    if (!ref || !isChatModel(ref)) continue;
    out.push({
      key: modelKey(ref),
      provider: ref.provider,
      model: ref.model,
      name: String(row?.name ?? "").trim() || ref.model,
      isCurrent: Boolean(row?.isCurrent || row?.current || row?.isDefault || row?.default),
    });
  }
  return [...out.filter((row) => row.isCurrent), ...out.filter((row) => !row.isCurrent)];
}

/** 给辅助识图模型下拉用：只列宿主明确标成能收图片的模型。 */
export function visionModelOptions(catalog) {
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  const out = [];
  for (const row of rows) {
    const ref = entryRef(row);
    if (!ref) continue;
    if (!modelSupportsImage(row)) continue;
    out.push({
      key: modelKey(ref),
      provider: ref.provider,
      model: ref.model,
      name: String(row?.name ?? "").trim() || ref.model,
      isCurrent: Boolean(row?.isCurrent || row?.current || row?.isDefault || row?.default),
    });
  }
  return [...out.filter((row) => row.isCurrent), ...out.filter((row) => !row.isCurrent)];
}

/**
 * 选出来的这个模型自己能不能收图。
 *
 * 为什么不用 `choice` 自己判：`resolveModelChoice` 只带回 `{provider, model, source}`，
 * 不带目录原条目。所以拿它回目录里找回那一行，再看 `input`。
 * 找不到就把“不能”当答案：宁可多转述一次，也不给一个收不了图的模型塞图。
 */
export function choiceSupportsImage(catalog, choice) {
  const ref = normalizeModelRef(choice);
  if (!ref) return false;
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  for (const row of rows) {
    const got = entryRef(row);
    if (!got || got.provider !== ref.provider || got.model !== ref.model) continue;
    return modelSupportsImage(row);
  }
  return false;
}

/**
 * 定这一次用哪个模型。
 *
 * 优先顺序（2026-09-28 重排）：
 *   ① 本应用里给这位伙伴单独指定 > ② 本应用全局指定
 *   > ③ 这位伙伴在 Hana 里给自己配的默认模型 > ④ 兜底跟宿主当前焦点模型
 *
 * 第三档是 2026-09-28 加的。以前没有它，第二档之后直接退到宿主的
 * “当前焦点模型”——那是模型选择器里选中的那个，跟“这位伙伴平时用什么”
 * 是两套账。实机结果是茶话会全员都用上了那个焦点模型，而每位伙伴在
 * Hana 里明明各配各的（gpt-6-luna / MiniMax …），一个都对不上。
 * 现在没单独指定时，跟的就是这位伙伴自己的默认模型，跟用户想的是同一件事。
 *
 * @returns {{provider: string, model: string, source: "partner"|"global"|"agent"|"current"}|
 *           {provider: string, model: string, source: "current"}|null}
 *          source 说明这个决定是从哪儿来的，日志和设置页都用得上。
 */
export function resolveModelChoice(catalog, { partnerRef = null, globalRef = null, agentRef = null } = {}) {
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  const find = (ref) => {
    const want = normalizeModelRef(ref);
    if (!want) return null;
    for (const row of rows) {
      const got = entryRef(row);
      if (got && got.provider === want.provider && got.model === want.model) return got;
    }
    return null;
  };
  const byPartner = find(partnerRef);
  if (byPartner) return { ...byPartner, source: "partner" };
  const byGlobal = find(globalRef);
  if (byGlobal) return { ...byGlobal, source: "global" };
  const byAgent = find(agentRef);
  if (byAgent) return { ...byAgent, source: "agent" };
  const current = pickFromCatalog(rows);
  return current ? { provider: current.provider, model: current.model, source: "current" } : null;
}

export function pickFromCatalog(catalog) {
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const preferred =
    rows.find((row) => row?.isCurrent || row?.current || row?.isDefault || row?.default) ?? rows[0];
  const provider = preferred?.provider ?? preferred?.providerId ?? null;
  const model = preferred?.model ?? preferred?.modelId ?? preferred?.id ?? null;
  if (!provider || !model) return null;
  return { provider: String(provider), model: String(model), raw: preferred };
}

/** 把 NDJSON 文本解析成正文；严格模式拒绝错误事件及非 stop 完成的流。 */
export function parseNdjson(text, diagnostics, { strictOutput = false } = {}) {
  let out = "";
  let events = 0;
  let errorMessage = null;
  let providerError = false;
  let streamError = null;
  let completed = false;
  // 工具回合：模型要自己去查一件事时，正文可能是空的，工具调用才是这一回合的产出。
  const toolCalls = [];
  const seenToolIds = new Set();
  let assistantContent = null;
  let stopReason = null;
  const strays = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      strays.push(trimmed);
      continue;
    }
    events += 1;
    const type = payload?.type ?? null;
    if (type === "text-delta") {
      // provider 已报错后，后续片段可能是协议残留；错误前的正文仍然保留。
      if (!providerError && typeof payload.delta === "string") out += payload.delta;
    } else if (type === "reasoning-delta") {
      // 思考通道：故意丢掉，不进气泡也不进历史
    } else if (type === "error") {
      errorMessage = payload.message ?? payload.code ?? "unknown error";
      providerError = payload.code === "APP_MODEL_PROVIDER_ERROR";
      if (strictOutput && !streamError) {
        streamError = new Error(String(errorMessage));
        streamError.code = payload.code ?? "MODEL_STREAM_ERROR";
      }
      diagnostics?.({ event: "models.stream.event.error", code: payload.code, message: payload.message });
    } else if (type === "tool-call") {
      // 伙伴自己发起的工具调用（2026-10-21）：搜索工具从这条路进来。
      const id = String(payload?.id ?? "");
      if (id && !seenToolIds.has(id)) {
        seenToolIds.add(id);
        toolCalls.push({ id, name: String(payload?.name ?? ""), arguments: payload?.arguments ?? {} });
      }
    } else if (type === "done") {
      stopReason = payload?.stopReason ?? null;
      const parts = payload?.assistant?.content;
      if (Array.isArray(parts)) {
        assistantContent = parts;
        // 有些 provider 不单独发 tool-call 事件，只在 done 的 assistant 内容里带 toolCall。
        for (const part of parts) {
          if (part?.type !== "toolCall") continue;
          const id = String(part?.id ?? "");
          if (!id || seenToolIds.has(id)) continue;
          seenToolIds.add(id);
          toolCalls.push({ id, name: String(part?.name ?? ""), arguments: part?.arguments ?? {} });
        }
      }
      // toolUse 也是这一回合的正常完成：正文空是正常的，它接下来要拿工具结果再说话。
      completed = stopReason === "stop" || (stopReason === "toolUse" && toolCalls.length > 0);
      if (!out && !providerError && Array.isArray(parts)) {
        for (const part of parts) {
          if (part?.type === "text" && typeof part.text === "string") out += part.text;
        }
      }
    }
  }
  // done 本身也可能表示 length/toolUse/deferred；只有 stop 才是正文正常完成。
  // error 优先于 done，不能因前面已有文字或后面跟着 done 就当作成功。
  if (streamError) throw streamError;
  if (strictOutput && !completed) {
    const error = new Error("模型流未正常完成，拒绝使用半截正文。");
    error.code = "MODEL_INCOMPLETE_RESPONSE";
    throw error;
  }
  // 2026-09-13：杂项行（不是合法 JSON 的那些）以前是一条一条直接接进正文的。
  // 实测回复里偶发冒出怪字符（西里尔、私用区码位、中文碎片，全在末尾或中后段），
  // 怀疑就是 provider 的杂项行被这样吞进了气泡。现在分两种：
  //   ① 整份就是纯文本（一条合法事件都没有）——仍然当正文，兼容某些 provider 的发法；
  //   ② 已经有合法事件的——杂项行一律丢掉，只记一条诊断，不让它进气泡。
  if (!events && strays.length) {
    diagnostics?.({ event: "models.stream.plaintext", lines: strays.length });
    return { text: strays.join("\n"), events: 0, errorMessage: null, toolCalls: [], assistantContent: null, stopReason: null };
  }
  if (strays.length) {
    diagnostics?.({
      event: "models.stream.stray",
      lines: strays.length,
      sample: strays.slice(0, 3).map((row) => row.slice(0, 80)),
    });
  }
  return { text: out, events, errorMessage, toolCalls, assistantContent, stopReason };
}

async function cancelModelRequest(ctx, requestId, diagnostics, operation) {
  try {
    await ctx.models.cancel(requestId);
    return true;
  } catch (error) {
    diagnostics?.({ event: "models.cancel.failed", operation, error: error?.message ?? String(error) });
    return false;
  }
}

export async function withModelDeadline(ctx, { requestId, timeoutMs, operation = "model", diagnostics = null, signal = null, run }) {
  signal?.throwIfAborted();
  const deadline = Math.max(1, Number(timeoutMs) || 90_000);
  let timer;
  let onAbort;
  let timedOut = false;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { signal?.throwIfAborted(); return run(); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error(`${operation} timeout`);
          error.code = "MODEL_TIMEOUT";
          reject(error);
        }, deadline);
        timer.unref?.();
      }),
      new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) {
      const cancellation = cancelModelRequest(ctx, requestId, diagnostics, operation);
      // 连续插话需要确认旧请求退场；普通宿主取消仍保持立即退出的既有契约。
      if (signal.reason?.waitForRelease) {
        const confirmed = await Promise.race([cancellation, waitMs(1000, false, { ref: false })]);
        if (!confirmed) {
          const failure = new Error("无法确认旧模型请求已取消，暂不启动新的生成");
          failure.code = "MODEL_CANCEL_UNCONFIRMED";
          throw failure;
        }
      }
      signal.throwIfAborted();
    }
    if (timedOut || error?.code === "MODEL_TIMEOUT") {
      diagnostics?.({ event: "models.timeout", operation, timeoutMs: deadline });
      const cancellation = cancelModelRequest(ctx, requestId, diagnostics, operation);
      if (!signal) await cancellation;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function readBody(source, diagnostics) {
  if (source == null) return "";
  // Response 对象
  if (typeof source.text === "function") {
    try {
      return await source.text();
    } catch (error) {
      diagnostics?.({ event: "models.response.text.failed", error: error?.message ?? String(error) });
    }
  }
  // Web ReadableStream
  const stream = source.body && typeof source.body.getReader === "function" ? source.body : source;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  }
  // 异步迭代
  if (typeof source?.[Symbol.asyncIterator] === "function") {
    let buffer = "";
    for await (const chunk of source) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    return buffer;
  }
  return "";
}

/**
 * 宿主 utility 的预算同时包含思考和正文。MiniMax 实测 180/400/500
 * 全被思考耗尽；utility 不暴露实际模型，不能拿目录焦点猜它或偷偷换模型。
 * 留出兼容余量，只对明确空正文增加一次预算；上限与总耗时都有限。
 * @returns Promise<string> 可见正文；空正文按失败抛出，不假报成功。
 */
export async function askUtility(ctx, {
  systemPrompt, userText, messages = null, maxTokens = 200, temperature = 0.4,
  timeoutMs = 120_000, diagnostics = null, signal = null,
}) {
  signal?.throwIfAborted();
  let budget = Math.max(8192, maxTokens);
  const retryBudget = Math.min(16384, budget * 2);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 120_000);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const error = new Error("utility timeout");
      error.code = "MODEL_TIMEOUT";
      throw error;
    }
    const requestId = rid(`utility_${attempt}`);
    try {
      const result = await withModelDeadline(ctx, {
        requestId,
        timeoutMs: remainingMs,
        operation: "utility",
        diagnostics,
        signal,
        run: () => ctx.models.utility({
          requestId,
          scope: "app",
          systemPrompt,
          messages: messages ?? [{ role: "user", content: String(userText ?? "") }],
          maxTokens: budget,
          temperature,
        }),
      });
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (!text) {
        const error = new Error("后台模型没有返回可用正文。");
        error.code = "MODEL_EMPTY_RESPONSE";
        throw error;
      }
      diagnostics?.({ event: "models.utility.ok", attempt, requestedMaxTokens: maxTokens, maxTokens: budget, chars: text.length });
      return text;
    } catch (error) {
      signal?.throwIfAborted();
      const empty = ["MODEL_EMPTY_RESPONSE", "LLM_EMPTY_RESPONSE"].includes(error?.code);
      if (empty && attempt === 1 && retryBudget > budget && Date.now() < deadline) {
        diagnostics?.({ event: "models.utility.retry", reason: "empty", attempt, maxTokens: budget, nextMaxTokens: retryBudget });
        budget = retryBudget;
        continue;
      }
      // APP_MODEL_PROVIDER_ERROR 可能包装了空正文，也可能是鉴权/内容拦截；
      // 无内层证据就不猜成预算问题，不追加请求、不降级到另一个模型。
      diagnostics?.({ event: "models.utility.failed", attempt, requestedMaxTokens: maxTokens, maxTokens: budget, code: error?.code ?? null,
        reason: empty ? "empty" : error?.code === "APP_MODEL_PROVIDER_ERROR" ? "provider-or-empty" : "request-failed" });
      throw error;
    }
  }
}

/**
 * @returns {Promise<{text: string, via: string, reasoningChars: number, events?: number}>}
 */
/**
 * 模型这次为什么没能出声。
 *
 * 配额/凭据/provider 挂掉不是「临时抖一下」：那种情况借 utility 顶一下，
 * 换的其实是 ta 的嗓子和记性——同一位伙伴在两个模型之间跳，语气和记性都会露馅。
 * 这类得原样报上去，让界面老老实实说 ta 这会儿接不上话。
 * 超时、连接断了才是真临时，借一下没人在乎，也比干等强。
 *
 * 认不出来的按 transient 算：宁可照旧兜底，也不因为一句没见过的报错就哑掉。
 */
export function classifyModelFailure({ code = null, message = "", status = null } = {}) {
  const text = `${code ?? ""} ${status ?? ""} ${message ?? ""}`;
  if (/limit|quota|rate.?limit|429|insufficient|credit|余额|配额|限额/i.test(text)) return "quota";
  if (/APP_MODEL_PROVIDER_ERROR|provider could not complete|unauthor|401|403|invalid.?api.?key|account|凭据|鉴权/i.test(text)) return "provider";
  return "transient";
}

/** 带 code 的错误：让调用方一眼分出「换模型就换人了」和「临时抣一下」。 */
export function modelUnavailableError(kind, modelRef, cause) {
  const label = modelRef ? `${modelRef.provider ?? ""}/${modelRef.model ?? ""}`.replace(/^\/|\/$/g, "") : "";
  const error = new Error(kind === "quota" ? "模型额度用完了" : "模型这会儿用不了");
  error.code = "MODEL_UNAVAILABLE";
  error.kind = kind;
  error.model = label;
  error.cause = cause;
  return error;
}

/**
 * 上游 provider 挂一下时的原地重试间隔（毫秒）。
 *
 * 实测（2026-10-08）codex 这条线是间歇性抽风：同一 provider 今天挂过两次，
 * 下一两轮就自己好了。以前一次失败就把 ta 判成「接不上话」沉默 45 分钟，
 * 代价远大于多问两声——所以这里按同一个模型、同一个嗓子重试，
 * 绝不换模型：换了 ta 的语气和记性就露馅了。
 * 间隔拉得越来越开：抖一下多半几秒内就好，等太久反而白等。
 */
export const STREAM_RETRY_DELAYS_MS = [1500, 4000, 9000];

/** 连着重试的总时间上限：别让「还在重试」拖成另一种「接不上话」。 */
const STREAM_RETRY_BUDGET_MS = 150_000;

/**
 * 走一次流式。失败不往上抛，把「能重试的」和「该走的」分开报给调用方。
 *
 * @returns {Promise<{ok: true, value: object}
 *   |{unavailable: "provider"|"quota", cause: string}
 *   |{fallThrough: true}>}
 */
async function streamOnce(ctx, { chosen, systemPrompt, messages, maxTokens, temperature, diagnostics, onRaw, attempt, timeoutMs, strictOutput = false, signal = null, tools = null, usageTag = null }) {
  signal?.throwIfAborted();
  let streamRequestId = null;
  let bodyReceived = false;
  try {
    streamRequestId = rid(`stream_${attempt}`);
    // 先报身份再发请求：宿主那边无论成或败都会落一条账，两边用同一个 requestId 对号。
    noteUsage({
      requestId: streamRequestId,
      at: new Date().toISOString(),
      agentId: usageTag?.agentId ?? null,
      kind: usageTag?.kind ?? null,
    });
    const request = {
      requestId: streamRequestId,
      provider: chosen.provider,
      model: chosen.model,
      systemPrompt,
      messages,
      maxTokens,
      temperature,
    };
    // 有工具才带 tools：没有工具的调用不给宿主塞这个字段，免得某些 provider 挑理。
    if (Array.isArray(tools) && tools.length) request.tools = tools;
    const response = await withModelDeadline(ctx, {
      requestId: streamRequestId,
      timeoutMs,
      operation: "stream",
      diagnostics,
      signal,
      run: () => ctx.models.stream(request).then((result) => readBody(result, diagnostics)),
    });
    bodyReceived = true;
    signal?.throwIfAborted();
    const raw = response;
    // 调试回调只把原始流交给调用方，帮助定位正文解析边界；不写入聊天记录。
    onRaw?.(raw);
    signal?.throwIfAborted();
    const parsed = parseNdjson(raw, diagnostics, { strictOutput });
    const toolCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    if (parsed.text.trim() || toolCalls.length) {
      diagnostics?.({
        event: "models.stream.ok",
        provider: chosen.provider,
        model: chosen.model,
        events: parsed.events,
        chars: parsed.text.length,
        toolCalls: toolCalls.length,
        tail: parsed.text.slice(-24),
      });
      return {
        ok: true,
        value: {
          text: parsed.text.trim(),
          via: `stream:${chosen.provider}/${chosen.model}`,
          reasoningChars: 0,
          events: parsed.events,
          toolCalls,
          assistantContent: parsed.assistantContent ?? null,
          stopReason: parsed.stopReason ?? null,
        },
      };
    }
    diagnostics?.({
      event: "models.stream.empty",
      provider: chosen.provider,
      model: chosen.model,
      events: parsed.events,
      rawHead: String(raw ?? "").slice(0, 300),
      errorMessage: parsed.errorMessage,
    });
    // 空回包里就带着原因（codex 的配额/鉴权类是这么回的）时，不许再拿别的模型顶上来。
    const emptyKind = classifyModelFailure({ message: parsed.errorMessage });
    if (parsed.errorMessage && emptyKind !== "transient") {
      diagnostics?.({ event: "models.stream.unavailable", kind: emptyKind, provider: chosen.provider, model: chosen.model });
      return { unavailable: emptyKind, cause: parsed.errorMessage };
    }
    // 连原因都没有的空回包：不算「用不了」，交给底下的 utility 兜底。
    return { fallThrough: true };
  } catch (error) {
    if (signal?.aborted) {
      if (!bodyReceived) streamRequestId = null; // deadline 已发 cancel，避免重复或等待它结束。
      if (error?.code === "MODEL_CANCEL_UNCONFIRMED") throw error;
      signal.throwIfAborted();
    }
    if (error?.code === "MODEL_TIMEOUT") streamRequestId = null;
    const failedKind = classifyModelFailure({ code: error?.code, message: error?.message, status: error?.status });
    diagnostics?.({ event: "models.stream.failed", kind: failedKind, error: error?.message ?? String(error), code: error?.code ?? null });
    // 有些 provider 直接不接工具声明：回包会明说。这不是「模型用不了」，
    // 是不带工具重发一次就能好的那种，得单独报上去让上层退回普通回复。
    if (Array.isArray(tools) && tools.length && /tool/i.test(String(error?.message ?? ""))) {
      return { unavailable: "tools-unsupported", cause: error?.message ?? String(error) };
    }
    if (failedKind !== "transient") return { unavailable: failedKind, cause: error?.message ?? String(error) };
    return { fallThrough: true };
  } finally {
    // 流式这条路无论是空回还是报错，先把请求释放掉，别让 requestId 一直占着
    if (streamRequestId) {
      const cancellation = cancelModelRequest(ctx, streamRequestId, diagnostics);
      if (!signal) await cancellation;
    }
  }
}

/**
 * utility 那条路只认纯文字：工具结果消息与 toolCall 部件它不收（实机报
 * “Utility message content only accepts text entries”）。退到 utility 前先把对话洗一遍。
 */
export function utilitySafeMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const row of rows) {
    const role = row?.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    if (typeof row?.content === "string") {
      out.push(row);
      continue;
    }
    if (!Array.isArray(row?.content)) continue;
    // 只留文字部件：toolCall 与工具结果消息 utility 不收（实机报
    // “Utility message content only accepts text entries”）。文字形态保持原样，不压成一条。
    const parts = row.content.filter((part) => part?.type === "text" && typeof part.text === "string");
    if (parts.length === row.content.length) {
      out.push(row);
      continue;
    }
    if (!parts.length) continue;
    out.push({ ...row, content: parts });
  }
  // 一条都不用动时就把原数组原样交回去（不为了“统一”而重建一份）。
  if (out.length === rows.length && out.every((row, index) => row === rows[index])) return rows;
  return out;
}

/**
 * 哪些 provider 吃不下「带工具结果的那一轮」。
 *
 * 2026-10-21 实机：openai-codex/gpt-6-luna 接受工具声明、也真的发了工具调用，
 * 但把工具结果原样回喂时直接报 “The model provider could not complete the request.”。
 * 同一个形状再试几遍也是同一个错，浪费时间还把 30 秒的调用窗口耗光——
 * 所以记下来：这家 provider 以后直接走「材料当文本块交回去」那条路。
 * 只记 provider+model，不记对话内容。
 */
const brokenToolResultShapes = new Set();

function toolResultShapeKey(provider, model) {
  return `${provider ?? ""}/${model ?? ""}`;
}

/**
 * 工具调用的 id 必须是个像样的标识符。
 *
 * 2026-10-21 实机：宿主把 tool-call 事件发出来了，工具也真跑了，但回喂那一轮被拒：
 * `APP_MODEL_INVALID_REQUEST: assistant.toolCall.id must be 1-128 ASCII identifier characters.`
 * ——原样回放 provider 给的 id 不行（空串、带点、带斜杠都算）。
 * 所以回放前先规整成一个合法标识符，assistant 那条与 toolResult 那条用同一个，
 * 两边对得上就行（provider 只认这层配对，不认原串）。
 */
const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeToolCallId(id, index = 0) {
  const raw = String(id ?? "").trim();
  if (TOOL_ID_RE.test(raw)) return raw;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 96);
  return cleaned.length >= 1 ? cleaned : `call_${index + 1}`;
}

/**
 * 这一回合的 assistant 内容：工具调用要原样回放给模型（契约里 assistant.content 必须是数组）。
 * 宿主给的 done.assistant 就是可回放的那一份，优先用它；没有就自己拼一份。
 */
function toolTurnContent(value, calls) {
  const canonical = Array.isArray(value?.assistantContent) ? value.assistantContent : null;
  const parts = [];
  if (canonical) {
    // 保留正文与思考（有些 provider 要求把思考原样带回去），但 toolCall 那几条要重建：
    // 宿主给的 id 不一定合法，回放时得用规整过的那个，而且必须跟 toolResult 那条一模一样。
    for (const part of canonical) {
      if (part?.type === "toolCall") continue;
      parts.push(part);
    }
  } else {
    const text = String(value?.text ?? "").trim();
    if (text) parts.push({ type: "text", text });
  }
  calls.forEach((call, index) => {
    parts.push({
      type: "toolCall",
      id: normalizeToolCallId(call?.id, index),
      name: String(call?.name ?? ""),
      arguments: call?.arguments && typeof call.arguments === "object" ? call.arguments : {},
    });
  });
  return parts;
}

/** 有些 provider 不接工具声明：回包会明说不支持，这时候退回不带工具的普通回复。 */
function looksLikeToolsUnsupported(error) {
  const text = `${error?.cause ?? ""} ${error?.message ?? ""}`;
  if (!/tool/i.test(text)) return false;
  return /not support|unsupported|not allowed|invalid|unknown|unrecognized|unexpected|no such/i.test(text);
}

export async function generateReply(ctx, {
  systemPrompt, messages, diagnostics, maxTokens = 900, modelRef = null, catalog = null,
  onRaw = null, temperature = 0.95, retryDelaysMs = STREAM_RETRY_DELAYS_MS, allowUtilityFallback = true,
  strictOutput = false, signal = null,
  tools = null, executeTool = null, maxToolCalls = 2, maxToolRounds = 2,
  usageTag = null,
}) {
  signal?.throwIfAborted();
  // ── 路线 1：显式选模型 + 流式（正文与思考分通道） ──
  // 调用方已经把目录递过来了就别再问一次；它没给（或递了个空的）才自己拉
  const list = Array.isArray(catalog) ? catalog : (catalog?.models ?? null);
  const rows = list ?? (await ctx.models.list())?.models ?? [];
  signal?.throwIfAborted();
  const chosen = normalizeModelRef(modelRef) ?? pickFromCatalog(rows);
  const delays = (Array.isArray(retryDelaysMs) ? retryDelaysMs : [])
    .map(Number)
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const retryDeadline = Date.now() + STREAM_RETRY_BUDGET_MS;
  const toolList = Array.isArray(tools) && tools.length ? tools : null;
  const toolRunner = toolList && typeof executeTool === "function" ? executeTool : null;

  if (!chosen) {
    diagnostics?.({
      event: "models.list.no-usable-entry",
      keys: catalog && !Array.isArray(catalog) && typeof catalog === "object" ? Object.keys(catalog).slice(0, 20) : null,
    });
  }

  /** 跑一轮流式；这一轮给不给工具，由调用方决定。 */
  const runTurn = async (turnMessages, turnTools, { attemptDelays = delays } = {}) => {
    if (!chosen) return null;
    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      const timeoutMs = Math.max(1000, Math.min(90_000, retryDeadline - Date.now()));
      const outcome = await streamOnce(ctx, {
        chosen, systemPrompt, messages: turnMessages, maxTokens, temperature, diagnostics, onRaw, attempt, timeoutMs, strictOutput, signal,
        tools: turnTools, usageTag,
      });
      signal?.throwIfAborted();
      if (outcome.ok) return outcome.value;
      // 额度用完不是抖：再问几声也只是让钱包再哭一次，立刻报上去。
      if (outcome.unavailable === "quota") throw modelUnavailableError("quota", chosen, outcome.cause);
      if (outcome.unavailable === "tools-unsupported") {
        const error = new Error("这个模型不接工具调用");
        error.code = "MODEL_TOOLS_UNSUPPORTED";
        error.cause = outcome.cause;
        throw error;
      }
      if (outcome.fallThrough) break;
      const delay = attemptDelays[attempt - 1];
      if (delay === undefined || Date.now() >= retryDeadline) {
        throw modelUnavailableError("provider", chosen, outcome.cause);
      }
      diagnostics?.({
        event: "models.stream.retry", attempt, provider: chosen.provider, model: chosen.model,
        cause: outcome.cause, nextDelayMs: delay,
      });
      await waitMs(delay, undefined, { ref: false, signal: signal ?? undefined });
    }
    return null;
  };

  /** 不带工具的收尾：流式彻底不行就退到宿主 utility。 */
  const finish = async (turnMessages) => {
    const value = await runTurn(turnMessages, null);
    if (value) return value;
    signal?.throwIfAborted();
    if (!allowUtilityFallback) throw modelUnavailableError('provider', chosen, '本次提醒没有有效正文，不切换模型');

    // ── 路线 2：宿主 utility（用新 requestId，绝不复用上面那个） ──
    const text = await askUtility(ctx, {
      systemPrompt,
      messages: utilitySafeMessages(turnMessages),
      maxTokens,
      temperature,
      timeoutMs: 120_000,
      diagnostics,
      signal,
    });
    signal?.throwIfAborted();
    return { text, via: "utility", reasoningChars: 0 };
  };

  // ── 工具回合（2026-10-21）：伙伴自己决定要不要查、自己写搜索词 ──
  if (toolRunner) {
    const convo = [...messages];
    const shapeKey = toolResultShapeKey(chosen?.provider, chosen?.model);
    let spent = 0;
    let materialText = "";

    /** 材料当一段文本块交给它：这条路不靠 provider 的工具协议，哪家都认。 */
    const speakWithMaterial = async () => {
      const injected = convo
        .filter((row) => row.role !== "toolResult")
        .map((row) => (row.role === "assistant" && Array.isArray(row.content)
          // 连那条工具调用也不留：没有对应结果的 function_call 照样会让 provider 报同一个错。
          ? { ...row, content: row.content.filter((part) => part?.type !== "toolCall") }
          : row))
        .concat([{
          role: "user",
          content: `【你刚才用搜索工具查到的材料】\n${materialText}\n（这是你自己搜出来的，接着说你要说的话。）`,
        }]);
      return await runTurn(injected, null, { attemptDelays: [] });
    };

    for (let round = 0; round <= maxToolRounds; round += 1) {
      // 这家 provider 已经证明吃不下「带工具结果的那一轮」：后面几轮直接走文本块那条路。
      const shapeBroken = brokenToolResultShapes.has(shapeKey);
      // 最后一轮不给工具：逼出一句人话，而不是让模型停在工具调用上。
      const turnTools = (round < maxToolRounds && !(shapeBroken && round >= 1)) ? toolList : null;
      let value = null;
      try {
        // 带工具结果的那一轮不重试：同一个形状再试几遍也是同一个错，
        // 还会把 30 秒的调用窗口耗光（后面降级就发不出去了）。
        value = await runTurn(convo, turnTools, { attemptDelays: round >= 1 ? [] : delays });
      } catch (error) {
        const toolIssue = error?.code === "MODEL_TOOLS_UNSUPPORTED" || looksLikeToolsUnsupported(error);
        const providerIssue = error?.code === "MODEL_UNAVAILABLE" && error?.kind === "provider";
        if (!toolIssue && !providerIssue) throw error;
        if (toolIssue) {
          diagnostics?.({ event: "models.tools.unsupported", provider: chosen?.provider ?? null, model: chosen?.model ?? null, round });
        } else {
          // 这家 provider 不吃工具结果回喂：记下来，下次直接走文本块。
          brokenToolResultShapes.add(shapeKey);
        }
        diagnostics?.({
          event: "models.tools.fallback",
          reason: toolIssue ? "tools-unsupported" : "provider-error",
          provider: chosen?.provider ?? null,
          model: chosen?.model ?? null,
          round,
        });
        // 材料已经拿到了（工具真跑过了），别把它丢了——丢了它就会改口说自己没工具可用，
        // 那正是这次要修的老毛病。逐级降级：
        //   ① 不带工具声明、但保留工具结果那条消息；
        //   ② 还不行，就把材料当一段文本块交给它；
        //   ③ 再不行，才退回没有材料的普通回复。
        if (materialText) {
          // 每一步各自包住：这一步挂了要接着走下一步，不能带着错退出整轮。
          try {
            const withoutTools = await runTurn(convo, null, { attemptDelays: [] });
            if (withoutTools) return withoutTools;
          } catch (stepError) {
            diagnostics?.({ event: "models.tools.fallback.step", step: "without-tools", error: stepError?.message ?? String(stepError) });
          }
          try {
            const asText = await speakWithMaterial();
            if (asText) return asText;
          } catch (stepError) {
            diagnostics?.({ event: "models.tools.fallback.step", step: "as-text", error: stepError?.message ?? String(stepError) });
          }
          diagnostics?.({ event: "models.tools.material-lost", provider: chosen?.provider ?? null, model: chosen?.model ?? null });
        }
        return await finish(messages);
      }
      if (!value) return await finish(convo);
      const calls = (Array.isArray(value.toolCalls) ? value.toolCalls : []).map((call, index) => ({
        ...call,
        id: normalizeToolCallId(call?.id, index),
        name: String(call?.name ?? ""),
        arguments: call?.arguments && typeof call.arguments === "object" ? call.arguments : {},
      }));
      if (!calls.length) return value;
      if (round >= maxToolRounds) {
        diagnostics?.({ event: "models.tools.budget", calls: calls.length, spent });
        return value;
      }
      const results = [];
      for (const call of calls) {
        const id = String(call?.id ?? "");
        const name = String(call?.name ?? "");
        if (spent >= maxToolCalls) {
          results.push({ id, name, isError: true, text: "这轮不查了：把已经拿到的说清楚就行，别编来源。" });
          continue;
        }
        spent += 1;
        let outcome = null;
        try {
          outcome = await toolRunner({ name, arguments: call?.arguments ?? {}, callId: id });
        } catch (error) {
          outcome = { isError: true, text: "这次没查成。就说暂时没找到，别编来源。" };
          diagnostics?.({ event: "models.tools.failed", name, error: error?.message ?? String(error) });
        }
        const text = String(outcome?.text ?? "").trim();
        results.push({ id, name, isError: Boolean(outcome?.isError), text });
        diagnostics?.({ event: "models.tools.called", name, isError: Boolean(outcome?.isError), chars: text.length, spent });
        // 降级时用：工具真的跑出了东西，就把材料留一份。
        if (text && !outcome?.isError) materialText = materialText ? `${materialText}\n${text}` : text;
      }
      // 这家 provider 已知不吃工具结果回喂：材料直接当文本块交回去，不走那条必被拒的路。
      if (brokenToolResultShapes.has(shapeKey)) {
        try {
          const spoken = await speakWithMaterial();
          if (spoken) return spoken;
        } catch (stepError) {
          diagnostics?.({ event: "models.tools.fallback.step", step: "as-text", error: stepError?.message ?? String(stepError) });
        }
        return await finish(messages);
      }
      convo.push({ role: "assistant", content: toolTurnContent(value, calls) });
      for (const row of results) {
        convo.push({
          role: "toolResult",
          toolCallId: row.id,
          toolName: row.name,
          content: [{ type: "text", text: row.text }],
          isError: row.isError,
        });
      }
    }
  }

  return await finish(messages);
}
