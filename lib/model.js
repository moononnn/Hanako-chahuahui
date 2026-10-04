/**
 * 调模型。契约以 `@hana/app-sdk` 的 app-contract/models.d.ts 为准（Hana 0.951.4）：
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

import { modelSupportsImage } from "./vision.js";

function rid(tag) {
  return `chahuahui_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
 */
const NON_CHAT_RE = /(embedding|embed|rerank|bge|\btts\b|whisper|speech|\basr\b|image|modnet|\bsam-)/i;

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

/** 把 NDJSON 文本解析成正文。 */
export function parseNdjson(text, diagnostics) {
  let out = "";
  let events = 0;
  let errorMessage = null;
  let providerError = false;
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
      diagnostics?.({ event: "models.stream.event.error", code: payload.code, message: payload.message });
    } else if (type === "done") {
      const parts = payload?.assistant?.content;
      if (!out && !providerError && Array.isArray(parts)) {
        for (const part of parts) {
          if (part?.type === "text" && typeof part.text === "string") out += part.text;
        }
      }
    }
  }
  // 2026-09-13：杂项行（不是合法 JSON 的那些）以前是一条一条直接接进正文的。
  // 实测回复里偶发冒出怪字符（西里尔、私用区码位、中文碎片，全在末尾或中后段），
  // 怀疑就是 provider 的杂项行被这样吞进了气泡。现在分两种：
  //   ① 整份就是纯文本（一条合法事件都没有）——仍然当正文，兼容某些 provider 的发法；
  //   ② 已经有合法事件的——杂项行一律丢掉，只记一条诊断，不让它进气泡。
  if (!events && strays.length) {
    diagnostics?.({ event: "models.stream.plaintext", lines: strays.length });
    return { text: strays.join("\n"), events: 0, errorMessage: null };
  }
  if (strays.length) {
    diagnostics?.({
      event: "models.stream.stray",
      lines: strays.length,
      sample: strays.slice(0, 3).map((row) => row.slice(0, 80)),
    });
  }
  return { text: out, events, errorMessage };
}

export async function withModelDeadline(ctx, { requestId, timeoutMs, operation = "model", diagnostics = null, run }) {
  const deadline = Math.max(1, Number(timeoutMs) || 90_000);
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error(`${operation} timeout`);
          error.code = "MODEL_TIMEOUT";
          reject(error);
        }, deadline);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut || error?.code === "MODEL_TIMEOUT") {
      diagnostics?.({ event: "models.timeout", operation, timeoutMs: deadline });
      try {
        await ctx.models.cancel(requestId);
      } catch (cancelError) {
        diagnostics?.({ event: "models.cancel.failed", operation, error: cancelError?.message ?? String(cancelError) });
      }
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
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
  timeoutMs = 120_000, diagnostics = null,
}) {
  let budget = Math.max(8192, maxTokens);
  const retryBudget = Math.min(16384, budget * 2);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 120_000);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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

export async function generateReply(ctx, { systemPrompt, messages, diagnostics, maxTokens = 900, modelRef = null, catalog = null, onRaw = null, temperature = 0.95 }) {
  // ── 路线 1：显式选模型 + 流式（正文与思考分通道） ──
  let streamRequestId = null;
  try {
    // 调用方已经把目录递过来了就别再问一次；它没给（或递了个空的）才自己拉
    const list = Array.isArray(catalog) ? catalog : (catalog?.models ?? null);
    const rows = list ?? (await ctx.models.list())?.models ?? [];
    const chosen = normalizeModelRef(modelRef) ?? pickFromCatalog(rows);
    if (chosen) {
      streamRequestId = rid("stream");
      const response = await withModelDeadline(ctx, {
        requestId: streamRequestId,
        timeoutMs: 90_000,
        operation: "stream",
        diagnostics,
        run: () => ctx.models.stream({
          requestId: streamRequestId,
          provider: chosen.provider,
          model: chosen.model,
          systemPrompt,
          messages,
          maxTokens,
          temperature,
        }).then((result) => readBody(result, diagnostics)),
      });
      const raw = response;
      // 调试回调只把原始流交给调用方，帮助定位正文解析边界；不写入聊天记录。
      onRaw?.(raw);
      const parsed = parseNdjson(raw, diagnostics);
      if (parsed.text.trim()) {
        diagnostics?.({
          event: "models.stream.ok",
          provider: chosen.provider,
          model: chosen.model,
          events: parsed.events,
          chars: parsed.text.length,
          tail: parsed.text.slice(-24),
        });
        return { text: parsed.text.trim(), via: `stream:${chosen.provider}/${chosen.model}`, reasoningChars: 0, events: parsed.events };
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
        throw modelUnavailableError(emptyKind, chosen, parsed.errorMessage);
      }
    } else {
      diagnostics?.({
        event: "models.list.no-usable-entry",
        keys: catalog && !Array.isArray(catalog) && typeof catalog === "object" ? Object.keys(catalog).slice(0, 20) : null,
      });
    }
  } catch (error) {
    if (error?.code === "MODEL_TIMEOUT") streamRequestId = null;
    // 已经决定是「模型这会儿用不了」的，往上抛，不走底下的 utility 兜底。
    if (error?.code === "MODEL_UNAVAILABLE") throw error;
    const failedKind = classifyModelFailure({ code: error?.code, message: error?.message, status: error?.status });
    diagnostics?.({ event: "models.stream.failed", kind: failedKind, error: error?.message ?? String(error), code: error?.code ?? null });
    if (failedKind !== "transient") throw modelUnavailableError(failedKind, modelRef, error);
  } finally {
    // 流式这条路无论是空回还是报错，先把请求释放掉，别让 requestId 一直占着
    if (streamRequestId) {
      try {
        await ctx.models.cancel(streamRequestId);
      } catch (error) {
        diagnostics?.({ event: "models.cancel.failed", error: error?.message ?? String(error) });
      }
    }
  }

  // ── 路线 2：宿主 utility（用新 requestId，绝不复用上面那个） ──
  const text = await askUtility(ctx, {
    systemPrompt,
    messages,
    maxTokens,
    temperature,
    timeoutMs: 120_000,
    diagnostics,
  });
  return { text, via: "utility", reasoningChars: 0 };
}
