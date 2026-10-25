// 设置页「用量」那一页的取数与汇总。只读宿主公开账本（usage:list），
// 不另存一份用量，也不读模型输入、回复和密钥。
//
// 两条口径记在这里，因为都容易算错：
// ① 宿主不按应用过滤，一个窗口里绝大部分是别的 App 的调用（真机一天里表情包
//    3409 次、茶话会 76 次）。条目里带 attribution.pluginId，所以自己按
//    chahuahui 筛；拿不到编号时就诚实标成不精确，不冒称专属账单。
// ② 宿主 input.totalTokens 是含缓存的输入总量（真机样本 424 = 296 + 128），
//    命中率必须拿 input.uncachedTokens 当分母，不然会算低一大截。

import { readUsageBook, usageIndex } from "./usage-book.js";

const MAX_DAYS = 31;
// 宿主账本一共就这么多条（旧版 5000，现在两万），一次把它全拉回来比按天分段更省：
// 宿主不按应用过滤，分段每小时也要带上别人的几千条。
const FETCH_LIMIT = 20000;
// 一趟可能几 MB，同一分钟内切栏不重复拉。
const ENTRIES_TTL_MS = 60_000;
const entriesCache = new WeakMap();
const RECENT_COUNT = 6;

const amount = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const stamp = (n) => String(n).padStart(2, "0");

function localDayKey(date) {
  return `${date.getFullYear()}-${stamp(date.getMonth() + 1)}-${stamp(date.getDate())}`;
}

/** 已知部分的和。全未知时给 null——未知不是零。 */
function bucket(rows, pick) {
  const known = rows.map(pick).filter((n) => n !== null);
  return {
    value: known.length ? known.reduce((a, b) => a + b, 0) : null,
    unknown: rows.length - known.length,
  };
}

/**
 * 缓存命中率 = 缓存读 ÷（缓存读 + 未缓存输入）。
 * 用未缓存那半边做分母：不同家报的输入总量含不含缓存并不一致，
 * 但"缓存读"与"未缓存"是拆开的。两边都没上报时给 null，不当 0%。
 */
export function cacheHitRate(cacheRead, uncached) {
  if (cacheRead === null && uncached === null) return null;
  const read = cacheRead ?? 0;
  const fresh = uncached ?? 0;
  const total = read + fresh;
  return total > 0 ? read / total : null;
}

/** 统计窗口从本地零点切，跟她在屏幕上看到的日期一致。 */
export function usageWindow(days = 7, now = new Date()) {
  const requested = Math.floor(Number(days));
  const span = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : 7;
  const until = new Date(now);
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (span - 1));
  return { days: span, since, until };
}

function toRow(entry, startedMs, calls) {
  const usage = entry?.usage ?? {};
  const requestId = typeof entry?.metadata?.requestId === "string" ? entry.metadata.requestId : null;
  const tag = requestId && calls ? (calls.get(requestId) ?? null) : null;
  return {
    startedMs,
    day: localDayKey(new Date(startedMs)),
    agentId: tag?.agentId ?? null,
    kind: tag?.kind ?? null,
    status: typeof entry?.status === "string" ? entry.status : "unknown",
    provider: typeof entry?.model?.provider === "string" ? entry.model.provider : null,
    modelId: typeof entry?.model?.modelId === "string" ? entry.model.modelId : null,
    durationMs: amount(entry?.durationMs),
    input: amount(usage?.input?.totalTokens),
    uncached: amount(usage?.input?.uncachedTokens),
    cacheRead: amount(usage?.cache?.readTokens),
    cacheWrite: amount(usage?.cache?.writeTokens),
    output: amount(usage?.output?.totalTokens),
    reasoning: amount(usage?.output?.reasoningTokens),
    total: amount(usage?.totalTokens),
  };
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function tokensOf(rows) {
  return {
    input: bucket(rows, (r) => r.input),
    uncached: bucket(rows, (r) => r.uncached),
    cacheRead: bucket(rows, (r) => r.cacheRead),
    cacheWrite: bucket(rows, (r) => r.cacheWrite),
    output: bucket(rows, (r) => r.output),
    reasoning: bucket(rows, (r) => r.reasoning),
    total: bucket(rows, (r) => r.total),
  };
}

/**
 * 汇总一段账本条目。
 * @param {Array} entries 宿主 usage:list 的 entries
 * @param {{since: Date, until: Date, pluginId?: string, calls?: Map}} options
 */
export function aggregateUsage(entries, { since, until, pluginId = "chahuahui", calls = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const sinceMs = since instanceof Date ? since.getTime() : Date.parse(since);
  const untilMs = until instanceof Date ? until.getTime() : Date.parse(until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) throw new Error("用量统计需要有效的起止时间");

  const rows = [];
  let foreignApp = 0;
  let unknownApp = 0;
  for (const entry of list) {
    if (entry?.attribution?.kind !== "plugin") continue;
    const appId = typeof entry.attribution.pluginId === "string" ? entry.attribution.pluginId.trim() : "";
    if (!appId) unknownApp += 1;
    else if (pluginId && appId !== pluginId) {
      foreignApp += 1;
      continue;
    }
    const startedMs = Date.parse(entry?.startedAt);
    // 不信任宿主已经按时间筛过：越界的、时间坏掉的都不进这段统计
    if (!Number.isFinite(startedMs) || startedMs < sinceMs || startedMs > untilMs) continue;
    rows.push(toRow(entry, startedMs, calls));
  }

  const statuses = Object.create(null);
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;

  const byDay = [...groupBy(rows, (row) => row.day)]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, group]) => {
      const tokens = tokensOf(group);
      return {
        day,
        requests: group.length,
        total: tokens.total.value,
        input: tokens.input.value,
        cacheRead: tokens.cacheRead.value,
        output: tokens.output.value,
        hitRate: cacheHitRate(tokens.cacheRead.value, tokens.uncached.value),
      };
    });

  const byModel = [...groupBy(rows, (row) => `${row.provider ?? ""}/${row.modelId ?? ""}`)]
    .map(([, group]) => {
      const tokens = tokensOf(group);
      return {
        provider: group[0].provider,
        modelId: group[0].modelId,
        requests: group.length,
        total: tokens.total.value,
        input: tokens.input.value,
        cacheRead: tokens.cacheRead.value,
        output: tokens.output.value,
        hitRate: cacheHitRate(tokens.cacheRead.value, tokens.uncached.value),
      };
    })
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const byPartner = [...groupBy(rows, (row) => row.agentId ?? "")]
    .map(([agentId, group]) => {
      const tokens = tokensOf(group);
      return {
        agentId: agentId || null,
        requests: group.length,
        total: tokens.total.value,
        cacheRead: tokens.cacheRead.value,
        output: tokens.output.value,
        hitRate: cacheHitRate(tokens.cacheRead.value, tokens.uncached.value),
      };
    })
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const byKind = [...groupBy(rows, (row) => row.kind ?? "")]
    .map(([kind, group]) => {
      const tokens = tokensOf(group);
      return {
        kind: kind || null,
        requests: group.length,
        total: tokens.total.value,
      };
    })
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const recent = [...rows]
    .sort((a, b) => b.startedMs - a.startedMs)
    .slice(0, RECENT_COUNT)
    .map((row) => ({
      at: new Date(row.startedMs).toISOString(),
      modelId: row.modelId,
      status: row.status,
      durationMs: row.durationMs,
      total: row.total,
      input: row.input,
      uncached: row.uncached,
      cacheRead: row.cacheRead,
      output: row.output,
    }));

  const tokens = tokensOf(rows);
  const exact = unknownApp === 0;

  return {
    scope: {
      exact,
      note: exact
        ? "这些都是茶话会自己的调用。"
        : "宿主账本里分不清是哪个 App 的插件调用，这里可能含别的应用。",
      unknownApp,
      foreignApp,
    },
    requests: rows.length,
    statuses,
    tokens,
    hitRate: cacheHitRate(tokens.cacheRead.value, tokens.uncached.value),
    byDay,
    byModel,
    byPartner,
    byKind,
    recent,
    fetched: list.length,
  };
}

/**
 * 去宿主那儿取账本再汇总。
 * 不按天分段：账本总量就这么点，一次拉回来，切范围只在本地过滤。
 * 取不到、没权限都往上抛，由调用方给一句人话——空结果不当零消耗。
 */
export async function collectUsage(ctx, { days = 7, now = new Date(), diagnostics = null } = {}) {
  const window = usageWindow(days, now);
  const stale = now.getTime() - MAX_DAYS * 86400000;
  const cached = entriesCache.get(ctx);
  let entries;
  let truncated = false;
  if (cached && now.getTime() - cached.at < ENTRIES_TTL_MS) {
    entries = cached.entries;
    truncated = cached.truncated;
  } else {
    const result = await ctx.bus.request("usage:list", {
      since: new Date(stale).toISOString(),
      until: now.toISOString(),
      attributionKind: "plugin",
      limit: FETCH_LIMIT,
    });
    entries = Array.isArray(result?.entries) ? result.entries : [];
    truncated = entries.length >= FETCH_LIMIT || Boolean(result?.nextCursor);
    entriesCache.set(ctx, { at: now.getTime(), entries, truncated });
  }
  // 伙伴这一维靠自家的小索引：宿主条目的 metadata.requestId 就是我们发过去的 id。
  let calls = null;
  try {
    calls = usageIndex(readUsageBook(ctx.dataDir, now.getTime()));
  } catch {
    calls = null;
  }
  const summary = aggregateUsage(entries, { since: window.since, until: window.until, calls });
  diagnostics?.({
    event: "usage.stats.loaded",
    days: window.days,
    fetched: entries.length,
    appIdsReadable: summary.scope.exact,
    unknownApp: summary.scope.unknownApp,
    foreignApp: summary.scope.foreignApp,
    truncated,
  });
  return {
    ...summary,
    days: window.days,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    truncated,
  };
}
