import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerUsageQuery, summarizeUsage, usageFilter } from "../lib/usage-query.js";
const now = Date.parse("2026-10-22T14:00:00Z");
const filter = usageFilter({}, now);
const entry = (change = {}) => ({
  requestId: "request-1", startedAt: "2026-10-22T13:30:00Z", endedAt: "2026-10-22T13:30:01Z", durationMs: 1000, status: "ok",
  attribution: { kind: "plugin", agentId: "partner-1", sessionId: "private-session" },
  source: { subsystem: "plugin", operation: "models.infer" },
  model: { provider: "test", modelId: "test-model", api: "private-api" },
  usage: { input: { totalTokens: 100 }, output: { totalTokens: 40, reasoningTokens: 20 }, cache: { readTokens: 60, writeTokens: 0 }, totalTokens: 140, costTotal: 123 },
  ...change,
});

test("默认仅查最近一小时插件归因，不自动发请求", () => {
  assert.deepEqual(filter, { since: "2026-10-22T13:00:00.000Z", until: "2026-10-22T14:00:00.000Z", attributionKind: "plugin", limit: 100 });
});
test("拒绝含糊时间、反向窗口、超大范围和无效上限", () => {
  for (const input of [{ since: "2026-10-22" }, { since: "2026-10-22T15:00:00Z" }, { since: "2026-10-01T00:00:00Z" }, { limit: 0 }, { limit: 201 }, { limit: "100" }, { status: "all" }, { provider: "bad\nname" }]) {
    assert.throws(() => usageFilter(input, now));
  }
});
test("带时区时间与模型伙伴筛选通过，不能输入其他归因类型", () => {
  const f = usageFilter({ since: "2026-10-22T21:00:00+08:00", agentId: "partner-1", provider: "test", modelId: "test-model", status: "ok", attributionKind: "session" }, now);
  assert.equal(f.since, filter.since);
  assert.equal(f.attributionKind, "plugin");
  assert.equal(f.agentId, "partner-1");
});
test("精确用量不重复加思考和缓存，真零与未知区别保留", () => {
  const summary = summarizeUsage({ entries: [entry()], nextCursor: null }, filter);
  assert.equal(summary.amounts.totalTokens.knownSum, 140);
  assert.equal(summary.amounts.outputTokens.knownSum, 40);
  assert.equal(summary.amounts.reasoningTokens.knownSum, 20);
  assert.equal(summary.amounts.cacheWriteTokens.knownSum, 0);
  assert.equal(summary.truncated, false);
  assert.match(summary.scope, /可能包含其他App/);
});
test("失败与usage_missing保留，缺失用量不当零", () => {
  const summary = summarizeUsage({ entries: [entry(), entry({ requestId: "failed", status: "error", usage: null }), entry({ requestId: "missing", status: "usage_missing", usage: {} })] }, filter);
  assert.equal(summary.matchedRequests, 3);
  assert.equal(summary.amounts.totalTokens.knownSum, 140);
  assert.equal(summary.amounts.totalTokens.knownRequests, 1);
  assert.equal(summary.amounts.totalTokens.unknownRequests, 2);
  assert.equal(summary.entries[1].usage.totalTokens, null);
  assert.equal(summary.statuses.error, 1);
  assert.equal(summary.statuses.usage_missing, 1);
});
test("无效数字不累加，没有已知数据就保持null", () => {
  const summary = summarizeUsage({ entries: [entry({ usage: { totalTokens: -1, input: { totalTokens: "42" }, output: { totalTokens: Infinity } } })] }, filter);
  assert.equal(summary.amounts.totalTokens.knownSum, null);
  assert.equal(summary.amounts.inputTokens.knownSum, null);
  assert.equal(summary.amounts.outputTokens.knownSum, null);
});
test("不相信宿主已过滤：排除普通对话、时间越界、错伙伴和模型", () => {
  const rows = [entry(), entry({ attribution: { kind: "session" } }), entry({ startedAt: "2026-10-21T00:00:00Z" }), entry({ attribution: { kind: "plugin", agentId: "other" } }), entry({ model: { provider: "other", modelId: "test-model" } }), entry({ startedAt: "bad" })];
  const summary = summarizeUsage({ entries: rows }, { ...filter, agentId: "partner-1", provider: "test", modelId: "test-model" });
  assert.equal(summary.matchedRequests, 1);
  assert.equal(summary.excludedRequests, 5);
});
test("达到上限或有游标必须标部分统计，不能冒充全天", () => {
  assert.equal(summarizeUsage({ entries: [entry()] }, { ...filter, limit: 1 }).truncated, true);
  assert.equal(summarizeUsage({ entries: [entry()], nextCursor: "private-cursor" }, filter).truncated, true);
});
test("白名单输出不带正文、密钥、会话标识、原始API或金额", () => {
  const raw = entry({ text: "private text", apiKey: "secret", metadata: { original: "private" } });
  const serialized = JSON.stringify(summarizeUsage({ entries: [raw] }, filter));
  for (const text of ["private text", "apiKey", "private-session", "private-api", "costTotal", "metadata"]) assert.equal(serialized.includes(text), false);
});
test("空列表不编造用量，坏回包不能当零", () => {
  const result = summarizeUsage({ entries: [] }, filter);
  assert.equal(result.matchedRequests, 0);
  assert.equal(result.amounts.totalTokens.knownSum, null);
  assert.equal(result.emptyResult, true);
  assert.match(result.emptyNote, /不等于没有消耗/);
  assert.equal(result.fullRangeVerified, false);
  assert.match(result.coverage, /不承诺全时间段完整/);
  assert.throws(() => summarizeUsage({}, filter));
});
test("工具只在执行时调用正式usage:list，不碰模型或文件", async () => {
  let tool;
  const calls = [];
  registerUsageQuery({ tools: { register: (value) => { tool = value; } }, bus: { request: async (...args) => { calls.push(args); return { entries: [] }; } } });
  assert.equal(calls.length, 0);
  assert.equal(tool.name, "chahuahui_usage_query");
  const result = await tool.execute({ provider: "test" });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "usage:list");
  assert.equal(calls[0][1].attributionKind, "plugin");
});
test("权限与查询失败明确报错，不以空列表掩盖", async () => {
  let tool;
  registerUsageQuery({ tools: { register: (value) => { tool = value; } }, bus: { request: async () => { throw new Error("permission denied"); } } });
  const result = await tool.execute({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /读取用量权限尚未放行/);
  assert.match(result.content[0].text, /不代表消耗为零/);
});
test("错误文本也按白名单输出，不泄露宿主错误正文", async () => {
  let tool;
  registerUsageQuery({ tools: { register: (value) => { tool = value; } }, bus: { request: async () => { throw Object.assign(new Error("private secret session-id raw"), { code: "private-code" }); } } });
  const result = await tool.execute({});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text.includes("private"), false);
  assert.equal(result.content[0].text.includes("secret"), false);
});

test("安装声明读取用量，装载只注册工具", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.capabilities.includes("app/usage.read"));
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /registerUsageQuery\(ctx\)/);
  assert.doesNotMatch(fs.readFileSync(new URL("../lib/usage-query.js", import.meta.url), "utf8"), /usage-ledger\.(?:json|sqlite)|models\.(?:stream|utility)\(/);
});
