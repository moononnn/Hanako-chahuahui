// 只读宿主公开账本，不另存用量，不读取模型输入、回复或密钥。
// 当前公开契约没有 App 身份字段，不能把 plugin 范围误称为本应用账单。
const STATUSES = new Set(["ok", "error", "aborted", "usage_missing"]);
const AMOUNTS = {
  inputTokens: (u) => u?.input?.totalTokens,
  outputTokens: (u) => u?.output?.totalTokens,
  reasoningTokens: (u) => u?.output?.reasoningTokens,
  cacheReadTokens: (u) => u?.cache?.readTokens,
  cacheWriteTokens: (u) => u?.cache?.writeTokens,
  totalTokens: (u) => u?.totalTokens,
};
const amount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

function timestamp(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name}须为带时区的完整时间，例如2026-10-22T21:00:00+08:00`);
  }
  return Date.parse(value);
}

export function usageFilter(input = {}, now = Date.now()) {
  const until = timestamp(input.until, now, "until");
  const since = timestamp(input.since, until - 60 * 60 * 1000, "since");
  if (since >= until || until - since > 7 * 86400000) throw new Error("查询起止时间须递增，范围最多7天");
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit须为1至200的整数");
  const filter = { since: new Date(since).toISOString(), until: new Date(until).toISOString(), attributionKind: "plugin", limit };
  for (const key of ["agentId", "provider", "modelId"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 200 || /[\u0000-\u001f\u007f]/u.test(input[key])) throw new Error(`${key}格式无效`);
    filter[key] = input[key].trim();
  }
  if (input.status !== undefined) {
    if (!STATUSES.has(input.status)) throw new Error("未知请求状态");
    filter.status = input.status;
  }
  return filter;
}

function usageRow(row) {
  return {
    requestId: typeof row?.requestId === "string" ? row.requestId : null,
    startedAt: typeof row?.startedAt === "string" ? row.startedAt : null,
    endedAt: typeof row?.endedAt === "string" ? row.endedAt : null,
    durationMs: amount(row?.durationMs),
    status: typeof row?.status === "string" ? row.status : "unknown",
    agentId: typeof row?.attribution?.agentId === "string" ? row.attribution.agentId : null,
    provider: typeof row?.model?.provider === "string" ? row.model.provider : null,
    modelId: typeof row?.model?.modelId === "string" ? row.model.modelId : null,
    operation: typeof row?.source?.operation === "string" ? row.source.operation : null,
    usage: Object.fromEntries(Object.entries(AMOUNTS).map(([key, read]) => [key, amount(read(row?.usage))])),
  };
}

export function summarizeUsage(result, filter) {
  if (!Array.isArray(result?.entries)) throw new Error("宿主未返回有效用量列表，不能当作零消耗");
  // 防御性复核公开过滤条件；不信任无归因记录，避免误把普通会话当插件用量。
  const rows = result.entries.filter((row) => row?.attribution?.kind === "plugin"
    && (!filter.agentId || row.attribution.agentId === filter.agentId)
    && (!filter.provider || row.model?.provider === filter.provider)
    && (!filter.modelId || row.model?.modelId === filter.modelId)
    && (!filter.status || row.status === filter.status)
    && Number.isFinite(Date.parse(row.startedAt))
    && Date.parse(row.startedAt) >= Date.parse(filter.since)
    && Date.parse(row.startedAt) <= Date.parse(filter.until)).map(usageRow);
  const fields = Object.fromEntries(Object.keys(AMOUNTS).map((key) => {
    const known = rows.map((r) => r.usage[key]).filter((n) => n !== null);
    return [key, { knownSum: known.length ? known.reduce((a, b) => a + b, 0) : null, knownRequests: known.length, unknownRequests: rows.length - known.length }];
  }));
  const statuses = Object.create(null);
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  const truncated = Boolean(result.nextCursor) || result.entries.length >= filter.limit;
  return {
    scope: "宿主插件调用；可能包含其他App，不是茶话会专属账单",
    attributionNote: "agentId是宿主账本归因，不保证等于茶话会里当前说话的伙伴；未按视频或业务用途自动拆分",
    filter, fetchedRequests: result.entries.length, matchedRequests: rows.length,
    excludedRequests: result.entries.length - rows.length,
    truncated, fullRangeVerified: false,
    emptyResult: rows.length === 0,
    emptyNote: rows.length === 0 ? "本次条件下没有可展示条目，不等于没有消耗；可能有归因、筛选、保留范围或用量缺失等原因" : null,
    coverage: truncated ? "仅本次取回的有限条目，不能当整个时间段的全量总数" : "仅宿主本次查询返回且符合条件的条目；无法排除宿主内部限额或保留范围，不承诺全时间段完整",
    statuses, amounts: fields,
    countingNote: "各字段按宿主返回值独立展示，不自行把思考或缓存再次加到totalTokens；未知为null，knownSum仅为已知部分。未计算金额",
    entries: rows,
  };
}

export function registerUsageQuery(ctx) {
  ctx.tools.register({
    name: "chahuahui_usage_query",
    description: "只读查询宿主模型用量，默认最近1小时插件调用，可按时间、宿主归因伙伴、provider/model筛选。范围可能包含其他App，绝不是茶话会专属账单。缺失用量不当零；不发模型请求、不读聊天正文、不估金额。最多200条，截断会明确标注。",
    parameters: { type: "object", properties: {
      since: { type: "string", description: "带时区的开始时间，默认1小时前；范围最多7天" },
      until: { type: "string", description: "带时区的结束时间，默认现在" },
      agentId: { type: "string", description: "可选：按宿主账本归因的伙伴编号筛选，不等于业务聊天对象" },
      provider: { type: "string" }, modelId: { type: "string" },
      status: { type: "string", enum: [...STATUSES] },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "最多取回条数，默认100；达到上限保守标截断" },
    }, additionalProperties: false },
    execute: async (input) => {
      try {
        const filter = usageFilter(input);
        const result = await ctx.bus.request("usage:list", filter);
        return { content: [{ type: "text", text: JSON.stringify(summarizeUsage(result, filter)) }] };
      } catch (error) {
        const denied = /permission|capability|grant|authority|授权|权限/iu.test(String(error?.message ?? ""));
        const code = typeof error?.code === "string" && /^APP_[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null;
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, error: denied ? "读取用量权限尚未放行" : "用量查询失败或输入条件无效", note: "未取得有效账本，不代表消耗为零；若缺少读取用量授权，请在Hana应用管理里审阅茶话会权限" }) }] };
      }
    },
  });
}
