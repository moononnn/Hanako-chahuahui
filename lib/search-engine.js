/**
 * 搜索引擎增强层：默认搜索之外，用户可以自己挑一家搜索服务。
 *
 * 引擎清单对标 Hana 内置 web_search 的那几家（anysearch / tavily / brave / serper），
 * 再加上 DeepSeek 刚开放的 Search API。每家一把自己的 Key，互不干扰：
 * 换引擎不会把别家已经填好的 Key 弄丢。
 *
 * 三条铁律：
 * - 默认那条路（必应 + 热榜）一行没动，不填任何东西就还是原来的行为。
 * - 任何一家不通（401、超时、额度用尽、空结果）都静默退回默认搜索，聊天不中断、不编来源。
 * - 隐私门在换引擎之前就过一遍：不让私聊线索跟着新引擎出门。
 */

import { isSafeSearchQuery, searchTimelyTopic } from "./topic-search.js";

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 8_000;
const STATUSES = new Set(["untested", "verified", "failed"]);

/** 每家引擎长什么样：要不要 Key、要不要填、界面怎么写。 */
const ENGINE_SPECS = {
  bing: { id: "bing", label: "默认搜索（不用填 Key）", needsKey: false, keyRequired: false, keyHint: "", maxQueryLength: 200 },
  anysearch: { id: "anysearch", label: "AnySearch（不填 Key 也能用）", needsKey: false, keyRequired: false, keyHint: "留空走免费层；填了就走付费层", maxQueryLength: 200, maxResults: 10 },
  tavily: { id: "tavily", label: "Tavily（专为 AI 准备的搜索）", needsKey: true, keyRequired: true, keyHint: "Tavily 的 API Key（tvly- 开头）", maxQueryLength: 200, maxResults: 20 },
  serper: { id: "serper", label: "Serper（Google 的结果）", needsKey: true, keyRequired: true, keyHint: "Serper 的 API Key", maxQueryLength: 200, maxResults: 20 },
  brave: { id: "brave", label: "Brave Search（自己的索引）", needsKey: true, keyRequired: true, keyHint: "Brave Search 的 API Key", maxQueryLength: 200, maxResults: 20 },
  deepseek: { id: "deepseek", label: "DeepSeek 自研搜索（带摘要和日期）", needsKey: true, keyRequired: true, keyHint: "DeepSeek 平台上申请的那把 Key", maxQueryLength: 128, maxResults: 50 },
};

export function listSearchEngines() {
  return Object.values(ENGINE_SPECS).map((spec) => ({ ...spec }));
}

/**
 * 搜索顺序归一：认得的、不重复，且一定包含默认搜索。
 *
 * 只有这一份真相：order[0] 就是现在走的那家。没有“首选”与“备选”两套概念——
 * 默认搜索也只是一行（免费的兜底），不能从名单里移掉，但可以调位置。
 */
export function normalizeSearchOrder(raw) {
  const order = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = String(item ?? "").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ENGINE_SPECS, id)) continue;
    if (order.includes(id)) continue;
    order.push(id);
  }
  if (!order.length) return ["bing"];
  if (!order.includes("bing")) order.push("bing");
  return order;
}

/** 这一轮要按什么顺序试，就是她排的那份。 */
export function searchChain(config = {}) {
  const raw = Array.isArray(config?.order) && config.order.length ? config.order : [config?.engine];
  return normalizeSearchOrder(raw);
}

/**
 * 一次回复里搜索能花的钱和时都得有上限：链子越长，这个上限越要紧。
 * 付费额度按“真发出去的包”扣；免费那几家不占额度，但也占时间。
 */
export const SEARCH_SESSION_TOTAL_MS = 16_000;
export const SEARCH_SESSION_PAID_BUDGET = 3;

/** 这家到底算不算付费：要 Key 且真填了才扣预算；AnySearch 的免费层不算。 */
export function isPaidEngine(id, apiKey) {
  const spec = ENGINE_SPECS[normalizeSearchEngine(id)] ?? ENGINE_SPECS.bing;
  return Boolean(spec.keyRequired && String(apiKey ?? "").trim());
}

/** 一次回复共用的搜索会话：总截止时间 + 付费预算 + “哪几家本轮已经确定不行”。 */
export function createSearchSession({ totalMs = SEARCH_SESSION_TOTAL_MS, paidBudget = SEARCH_SESSION_PAID_BUDGET, clock = () => Date.now() } = {}) {
  const budget = Number.isFinite(Number(paidBudget)) ? Math.max(0, Math.floor(Number(paidBudget))) : SEARCH_SESSION_PAID_BUDGET;
  const deadlineAt = clock() + Math.max(1000, Number(totalMs) || SEARCH_SESSION_TOTAL_MS);
  let paidLeft = budget;
  const down = new Set();
  return {
    remaining: () => deadlineAt - clock(),
    paidLeft: () => paidLeft,
    isDown: (engine) => down.has(normalizeSearchEngine(engine)),
    markDown(engine) { down.add(normalizeSearchEngine(engine)); },
    spend(paid) { if (paid) paidLeft = Math.max(0, paidLeft - 1); },
  };
}

/** 这家这一轮是不是“真的不通了”（跟“这个角度没东西”分得开）。 */
const ENGINE_FAULT_RE = /http-\d{3}|request-failed|bad-response|network-unavailable/iu;
export function isEngineFault(reason) {
  return ENGINE_FAULT_RE.test(String(reason ?? ""));
}

export function engineSpec(engine) {
  return ENGINE_SPECS[normalizeSearchEngine(engine)] ?? ENGINE_SPECS.bing;
}

/** 引擎认得的就留着，不认得的归到默认那档——不假装能用。 */
export function normalizeSearchEngine(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENGINE_SPECS, id) ? id : "bing";
}

/** 除了默认那路（bing），别家都允许结果没有日期——各家给日期的规矩不一样。 */
export function engineAllowsUndated(engine) {
  return normalizeSearchEngine(engine) !== "bing";
}

function normalizeStates(raw) {
  const states = {};
  for (const [engine, value] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (!Object.prototype.hasOwnProperty.call(ENGINE_SPECS, engine)) continue;
    const item = value && typeof value === "object" ? value : {};
    states[engine] = {
      status: STATUSES.has(item.status) ? item.status : "untested",
      testedAt: typeof item.testedAt === "string" && item.testedAt ? item.testedAt : null,
      error: typeof item.error === "string" && item.error ? item.error.slice(0, 200) : null,
    };
  }
  return states;
}

export function normalizeSearchEnhancement(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const keys = {};
  for (const [engine, value] of Object.entries(input.keys && typeof input.keys === "object" ? input.keys : {})) {
    if (!Object.prototype.hasOwnProperty.call(ENGINE_SPECS, engine)) continue;
    const key = String(value ?? "");
    if (key) keys[engine] = key;
  }
  const engine = normalizeSearchEngine(input.engine);
  // 兼容老数据：以前是“单个 engine + backups”，搬成一条顺序；搬过之后就只认 order。
  const order = normalizeSearchOrder(
    Array.isArray(input.order) && input.order.length ? input.order : [engine, ...(Array.isArray(input.backups) ? input.backups : [])],
  );
  return {
    // 兼容字段：order[0] 就是“现在走的那家”，老代码与状态映射都靠它。
    engine: order[0],
    order,
    keys,
    states: normalizeStates(input.states),
    usage: normalizeUsage(input.usage),
    usageByEngine: normalizeUsage(input.usageByEngine),
    /**
     * 早期只有一个 Key 槽的旧数据。**这里不自动搬进 keys**——
     * 旧值可能还没加密，搬过去就是明文换个位置躺着。
     * 加密与搬迁由 index.js 那个 async 的地方做（searchEnhancementConfig）。
     */
    legacyApiKey: typeof input.apiKey === "string" && input.apiKey ? input.apiKey : "",
  };
}

function normalizeUsage(raw) {
  const usage = {};
  for (const [key, count] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const value = Math.floor(Number(count));
    if (Number.isFinite(value) && value > 0) usage[key] = value;
  }
  return usage;
}

/** 用量按自然月记，跨月自动另起一格。 */
export function usageMonth(now = new Date()) {
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function usageCount(usage, now = new Date()) {
  return normalizeUsage(usage)[usageMonth(now)] ?? 0;
}

/** 记一次真实发出的请求。返回新的用量表，不改原对象。 */
export function recordSearchUsage(usage, now = new Date()) {
  const normalized = normalizeUsage(usage);
  const month = usageMonth(now);
  return { ...normalized, [month]: (normalized[month] ?? 0) + 1 };
}

/**
 * 这一家是不是暂时别用了。
 * - 长期的（401 鉴权失败、403、433 额度用尽、缺 Key）：不试了，等她自己重新配。
 * - 瞬时的（429 限流）：拦十分钟就放行重试——限流不是永久故障。
 * - 402 分两种：付费 Key 是余额耗尽，长期拦；**匿名层是每日免费额度用完，当天拦着、第二天自动回来**。
 */
const PERMANENT_BLOCK_RE = /http-401|http-403|http-433|missing-key|invalid|余额不足/iu;
const TRANSIENT_BLOCK_RE = /http-429|quota/iu;
const TRANSIENT_BLOCK_MS = 10 * 60_000;
const ANONYMOUS_QUOTA_BLOCK_MS = 20 * 60 * 60_000;

function withinWindow(item, now, windowMs) {
  const at = Date.parse(item.testedAt || "");
  if (!Number.isFinite(at)) return true;
  const moment = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return moment.getTime() - at < windowMs;
}

export function tavilyBlocked(state, options = {}) {
  const item = state && typeof state === "object" ? state : {};
  if (item.status !== "failed") return false;
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const error = String(item.error || "");
  if (/http-402|余额不足/iu.test(error)) {
    // 匿名层的 402 是「今天的免费额度用完了」，不是钱的事。
    if (options.anonymous === true) return withinWindow(item, now, ANONYMOUS_QUOTA_BLOCK_MS);
    return true;
  }
  if (PERMANENT_BLOCK_RE.test(error)) return true;
  if (TRANSIENT_BLOCK_RE.test(error)) return withinWindow(item, now, TRANSIENT_BLOCK_MS);
  return false;
}

function cleanQuery(query) {
  return String(query ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, 200);
}

function pickText(...values) {
  for (const value of values) {
    const text = String(value ?? "").replace(/\s+/gu, " ").trim();
    if (text) return text;
  }
  return "";
}

function normalizeRows(rows, maxResults, mapper) {
  return (Array.isArray(rows) ? rows : []).slice(0, maxResults)
    .map(mapper)
    .filter((row) => row.title && row.snippet);
}

// ── 各家适配器：统一吐 title / snippet / url / publishedAt ──────────────

/** Tavily：专为 AI 做的搜索，摘要清洗过，日期要显式开口子才有。 */
async function runTavily(fetcher, { query, apiKey, maxResults, timeoutMs }) {
  const response = await fetcher("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: Math.min(Number(maxResults) || 10, 20),
      search_depth: "basic",
      include_published_date: true,
    }),
    timeoutMs,
    maxResponseBytes: 1_048_576,
  });
  if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}` };
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad-response" };
  const results = normalizeRows(payload.results, maxResults, (row) => ({
    title: String(row?.title ?? "").trim().slice(0, 200),
    snippet: String(row?.content ?? "").replace(/\s+/gu, " ").trim().slice(0, 600),
    url: String(row?.url ?? "").trim().slice(0, 500),
    publishedAt: String(row?.published_date ?? "").trim().slice(0, 40),
  }));
  return results.length ? { ok: true, reason: "found", results } : { ok: false, reason: "no-results" };
}

/** Serper：Google 的结果，日期是标准日期串。 */
async function runSerper(fetcher, { query, apiKey, maxResults, timeoutMs }) {
  const response = await fetcher("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: maxResults }),
    timeoutMs,
    maxResponseBytes: 1_048_576,
  });
  if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}` };
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad-response" };
  const results = normalizeRows(payload.organic, maxResults, (row) => ({
    title: String(row?.title ?? "").trim().slice(0, 200),
    snippet: String(row?.snippet ?? "").replace(/\s+/gu, " ").trim().slice(0, 600),
    url: String(row?.link ?? "").trim().slice(0, 500),
    publishedAt: String(row?.date ?? "").trim().slice(0, 40),
  }));
  return results.length ? { ok: true, reason: "found", results } : { ok: false, reason: "no-results" };
}

/** Brave：自己的索引，摘要字段叫 description，日期常是相对时间。 */
async function runBrave(fetcher, { query, apiKey, maxResults, timeoutMs }) {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const response = await fetcher(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    method: "GET",
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    timeoutMs,
    maxResponseBytes: 1_048_576,
  });
  if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}` };
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad-response" };
  const results = normalizeRows(payload.web?.results, maxResults, (row) => ({
    title: String(row?.title ?? "").trim().slice(0, 200),
    snippet: String(row?.description ?? "").replace(/\s+/gu, " ").trim().slice(0, 600),
    url: String(row?.url ?? "").trim().slice(0, 500),
    // Brave 给了 page_age（ISO 8601）和 age（相对时间）：用上前者，别把老文章当今天的。
    publishedAt: String(row?.page_age ?? "").trim().slice(0, 40),
  }));
  return results.length ? { ok: true, reason: "found", results } : { ok: false, reason: "no-results" };
}

/** AnySearch：不填 Key 走匿名免费层，填了走付费层。 */
async function runAnySearch(fetcher, { query, apiKey, maxResults, timeoutMs }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetcher("https://api.anysearch.com/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, max_results: maxResults, language: "zh-CN" }),
    timeoutMs,
    maxResponseBytes: 1_048_576,
  });
  if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}` };
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad-response" };
  const rows = Array.isArray(payload.data?.results) ? payload.data.results : (Array.isArray(payload.results) ? payload.results : []);
  const results = normalizeRows(rows, maxResults, (row) => ({
    title: String(row?.title ?? "").trim().slice(0, 200),
    snippet: pickText(row?.content, row?.description, row?.snippet).slice(0, 600),
    url: String(row?.url ?? "").trim().slice(0, 500),
    publishedAt: String(row?.published_at ?? "").trim().slice(0, 40),
  }));  return results.length ? { ok: true, reason: "found", results } : { ok: false, reason: "no-results" };
}

/**
 * DeepSeek 自研搜索（2026-10 开放）：Search 接口。
 * 它的 summary 是给模型读的长摘要，date 是标准 RFC 3339——比别家都省事。
 */
async function runDeepSeek(fetcher, { query, apiKey, maxResults, timeoutMs }) {
  const response = await fetcher("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: Math.min(Number(maxResults) || 10, 50), need_content: false }),
    timeoutMs,
    maxResponseBytes: 2_097_152,
  });
  if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}` };
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad-response" };
  const results = normalizeRows(payload.results, maxResults, (row) => ({
    title: String(row?.title ?? "").trim().slice(0, 200),
    // summary 是给模型读的长摘要，snippet 太短，优先用它。
    snippet: pickText(row?.summary, row?.snippet, row?.content).slice(0, 800),
    url: String(row?.url ?? "").trim().slice(0, 500),
    publishedAt: String(row?.date ?? "").trim().slice(0, 40),
  }));
  return results.length ? { ok: true, reason: "found", results } : { ok: false, reason: "no-results" };
}

const ENGINE_FETCHERS = {
  tavily: runTavily,
  serper: runSerper,
  brave: runBrave,
  anysearch: runAnySearch,
  deepseek: runDeepSeek,
};

/** 调某一家。sent 只表示「真把这个包发出去了」：没发出去的不能算她的额度。 */
export async function searchWithEngine(engine, fetcher, { query, apiKey, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = normalizeSearchEngine(engine);
  const spec = ENGINE_SPECS[id];
  const run = ENGINE_FETCHERS[id];
  if (!run) return { ok: false, reason: "unknown-engine", sent: false, results: [] };
  if (typeof fetcher !== "function") return { ok: false, reason: "network-unavailable", sent: false, results: [] };
  const key = String(apiKey ?? "").trim();
  if (spec.keyRequired && !key) return { ok: false, reason: "missing-key", sent: false, results: [] };
  const clean = cleanQuery(query);
  if (!clean) return { ok: false, reason: "no-query", sent: false, results: [] };
  // 每家对查询词与条数都有自己的上限，超了就 400。
  const bounded = clean.slice(0, spec.maxQueryLength || 200);
  const limit = Math.min(Number(maxResults) || DEFAULT_MAX_RESULTS, spec.maxResults || DEFAULT_MAX_RESULTS);
  let sent = false;
  try {
    sent = true;
    const result = await run(fetcher, { query: bounded, apiKey: key, maxResults: limit, timeoutMs });
    return { ...result, sent };
  } catch {
    return { ok: false, reason: "request-failed", sent, results: [] };
  }
}

/** 旧接口留着：设置页的「测试一下」按引擎调它。 */
export async function searchTavily(fetcher, options = {}) {
  return searchWithEngine("tavily", fetcher, options);
}

/**
 * 统一出口：按她排的顺序（首选 → 备选）逐家试，哪家都不行就静默退回默认搜索。
 *
 * 三条边界：
 * - 只在「这家真的不通」时往下走（401/额度/超时/坏回包）；它说“这个角度没东西”（no-results）
 *   不算故障，不再换别家付费重问一遍——那是“为了质量多掏钱”，这一层不做。
 * - 冷却中的、本轮已经确定不行的直接跳级，不白等一次超时。
 * - 一次回复的付费次数与总时长有限（searchSession）：到顶了剩下的候选直接走免费的。
 *
 * 返回里 engine 说明这轮结果是谁给的；failures 按顺序记下每家为什么没成；
 * calls 只算真发出去的包（额度是她的，得能对账）。
 */
export async function searchWeb(fetcher, { query, enhancement, privateTerms = [], maxResults = DEFAULT_MAX_RESULTS, session = null } = {}) {
  const config = normalizeSearchEnhancement(enhancement);
  const clean = cleanQuery(query);
  const empty = (reason) => ({ ok: false, engine: "bing", reason, results: [], usedEnhanced: false, enhancedCalls: 0, enhancedEngine: null, failures: [], calls: [] });
  if (!clean) return empty("no-query");
  // 隐私门在换引擎之前就过一遍：不让私聊线索跟着新引擎一起出门。
  if (!isSafeSearchQuery(clean, privateTerms)) return empty("unsafe-query");
  const book = session ?? createSearchSession();
  const order = searchChain(config);
  const failures = [];
  const calls = [];
  let enhancedCalls = 0;
  let usedEnhanced = false;
  let bingTried = false;
  let bingReason = null;
  const runBing = async () => {
    bingTried = true;
    const result = await searchTimelyTopic(fetcher, { searchQuery: clean }, { privateTerms, maxResults });
    if (!result.ok) bingReason = result.reason;
    return result;
  };
  const done = (id, results) => ({
    ok: true,
    engine: id,
    reason: "found",
    results,
    usedEnhanced,
    enhancedCalls,
    enhancedEngine: id === "bing" ? (failures.find((row) => row.engine !== "bing")?.engine ?? null) : id,
    // 前面几家的原因留着：熔断要靠它上膛。
    fallbackReason: failures[0]?.reason ?? null,
    failures,
    calls,
  });
  for (const id of order) {
    // 默认搜索也在名单里（免费的兜底）：轮到它的那一格就真走它，上一家成功就不会轮到这里。
    if (id === "bing") {
      if (book.remaining() <= 0) {
        failures.push({ engine: "bing", reason: "search-out-of-time" });
        continue;
      }
      const result = await runBing();
      if (result.ok) return done("bing", result.results ?? []);
      failures.push({ engine: "bing", reason: result.reason });
      continue;
    }
    const apiKey = config.keys?.[id] ?? "";
    const paid = isPaidEngine(id, apiKey);
    const state = config.states?.[id] ?? {};
    // 熔断没到期的、本轮已经确定不通的：跳级，不白等一次超时。
    if (tavilyBlocked(state, { anonymous: !apiKey }) || book.isDown(id)) {
      failures.push({ engine: id, reason: "engine-disabled" });
      continue;
    }
    const left = book.remaining();
    if (left <= 0) {
      failures.push({ engine: id, reason: "search-out-of-time" });
      continue;
    }
    if (paid && book.paidLeft() <= 0) {
      failures.push({ engine: id, reason: "search-budget-spent" });
      continue;
    }
    const timeoutMs = Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, left - 300));
    const result = await searchWithEngine(id, fetcher, { query: clean, apiKey, maxResults, timeoutMs });
    if (result.sent) {
      enhancedCalls += 1;
      usedEnhanced = true;
      calls.push({ engine: id, sent: true });
      book.spend(paid);
    }
    if (result.ok) return done(id, result.results);
    // 没填 Key 的那家只是没准备好，不算故障，后面的还值得试（也不该记成失败）。
    if (!result.sent && result.reason === "missing-key") continue;
    failures.push({ engine: id, reason: result.reason });
    if (result.sent && isEngineFault(result.reason)) book.markDown(id);
    // 它明确说这个角度没东西：不是它坏了，不拿别家付费重问一遍，直接走默认搜索。
    if (result.reason === "no-results") break;
  }
  // 名单里没有默认搜索、或者轮到它时时间已经不够：最后还是走它，聊天不能因为搜索断掉。
  if (!bingTried) {
    const result = await runBing();
    if (result.ok) return done("bing", result.results ?? []);
    failures.push({ engine: "bing", reason: result.reason });
  }
  return {
    ok: false,
    engine: "bing",
    // 默认搜索也不行时，说的该是它的原因，别把人往别家引。
    reason: bingReason ?? failures.at(-1)?.reason ?? "no-results",
    results: [],
    usedEnhanced,
    enhancedCalls,
    enhancedEngine: failures.find((row) => row.engine !== "bing")?.engine ?? null,
    fallbackReason: failures[0]?.reason ?? null,
    failures,
    calls,
  };
}
