import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, cacheHitRate, collectUsage, usageWindow } from "../lib/usage-stats.js";

const now = new Date("2026-10-25T21:00:00+08:00");

const entry = (change = {}) => ({
  requestId: "request-1",
  startedAt: "2026-10-25T20:30:00+08:00",
  endedAt: "2026-10-25T20:30:05+08:00",
  durationMs: 5000,
  status: "ok",
  attribution: { kind: "plugin", pluginId: "chahuahui", agentId: null },
  source: { subsystem: "plugin", operation: "models.infer" },
  model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash-Preview", api: "internal" },
  usage: {
    input: { totalTokens: 1000, uncachedTokens: 100 },
    output: { totalTokens: 40, reasoningTokens: 10 },
    cache: { readTokens: 900, writeTokens: 0 },
    totalTokens: 1040,
  },
  ...change,
});

const nineDaysWindow = usageWindow(7, now);

test("今天从本地零点算起，跨度不超上限", () => {
  const today = usageWindow(1, now);
  assert.equal(today.days, 1);
  assert.equal(today.since.getHours(), 0);
  assert.equal(today.since.getMinutes(), 0);
  assert.equal(today.since.getDate(), now.getDate());
  const week = usageWindow(7, now);
  assert.equal(week.since.getDate(), now.getDate() - 6);
  assert.equal(usageWindow(999, now).days, 31);
  assert.equal(usageWindow(0, now).days, 7);
  assert.equal(usageWindow("abc", now).days, 7);
});

test("命中率按未缓存那半边算，没上报时是 null 不是 0", () => {
  assert.equal(cacheHitRate(900, 100), 0.9);
  assert.equal(cacheHitRate(0, 100), 0);
  assert.equal(cacheHitRate(50, 0), 1);
  assert.equal(cacheHitRate(0, 0), null);
  assert.equal(cacheHitRate(null, null), null);
  assert.equal(cacheHitRate(null, 100), 0);
});

test("只算插件归因、只算时间窗内的，其他 App 单独计数", () => {
  const rows = [
    entry(),
    entry({ requestId: "session", attribution: { kind: "session", agentId: "hanako" } }),
    entry({ requestId: "other-app", attribution: { kind: "plugin", pluginId: "biaoqingbao-app" } }),
    entry({ requestId: "too-old", startedAt: "2026-10-01T10:00:00+08:00" }),
    entry({ requestId: "bad-time", startedAt: "not-a-time" }),
  ];
  const summary = aggregateUsage(rows, nineDaysWindow);
  assert.equal(summary.requests, 1);
  assert.equal(summary.scope.foreignApp, 1);
  assert.equal(summary.scope.exact, true);
  assert.equal(summary.fetched, 5);
});

test("条目里没有应用编号时照算，但明确标成不精确", () => {
  const summary = aggregateUsage([entry({ attribution: { kind: "plugin" } })], nineDaysWindow);
  assert.equal(summary.requests, 1);
  assert.equal(summary.scope.exact, false);
  assert.equal(summary.scope.unknownApp, 1);
  assert.match(summary.scope.note, /可能含别的应用/);
});

test("token 各算各的，未知不当零，总量不重复加缓存", () => {
  const summary = aggregateUsage([
    entry(),
    entry({ requestId: "second", usage: { input: { totalTokens: 200, uncachedTokens: 200 }, output: { totalTokens: 60 }, cache: { readTokens: 300 }, totalTokens: 560 } }),
    entry({ requestId: "failed", status: "error", usage: null }),
  ], nineDaysWindow);
  assert.equal(summary.tokens.input.value, 1200);
  assert.equal(summary.tokens.uncached.value, 300);
  assert.equal(summary.tokens.cacheRead.value, 1200);
  assert.equal(summary.tokens.output.value, 100);
  assert.equal(summary.tokens.reasoning.value, 10);
  assert.equal(summary.tokens.reasoning.unknown, 2);
  assert.equal(summary.tokens.total.value, 1600);
  assert.equal(summary.hitRate, 0.8);
  assert.equal(summary.statuses.error, 1);
  assert.equal(summary.requests, 3);
});

test("全都没上报用量时保持 null", () => {
  const summary = aggregateUsage([entry({ usage: null }), entry({ requestId: "b", usage: {} })], nineDaysWindow);
  assert.equal(summary.tokens.total.value, null);
  assert.equal(summary.tokens.total.unknown, 2);
  assert.equal(summary.hitRate, null);
});

test("输入总量含缓存时不把命中率算低（真机形态）", () => {
  const summary = aggregateUsage([entry({
    usage: {
      input: { totalTokens: 424, uncachedTokens: 296 },
      output: { totalTokens: 266, reasoningTokens: 262 },
      cache: { readTokens: 128, writeTokens: null, hitRatio: 0.3018867924528302, support: "reported" },
      totalTokens: 690,
    },
  })], nineDaysWindow);
  assert.equal(Math.round(summary.hitRate * 10000) / 10000, 0.3019);
  assert.equal(summary.tokens.uncached.value, 296);
  assert.equal(summary.tokens.input.value, 424);
});

test("按伙伴归因靠 requestId 对号，对不上的归未标注", () => {
  const calls = new Map([
    ["req-a", { agentId: "hanako", kind: "chat" }],
    ["req-b", { agentId: "beta", kind: "proactive" }],
  ]);
  const summary = aggregateUsage([
    entry({ requestId: "a", metadata: { requestId: "req-a" } }),
    entry({ requestId: "b", metadata: { requestId: "req-b" }, usage: { input: { totalTokens: 10, uncachedTokens: 10 }, output: { totalTokens: 90 }, cache: { readTokens: 0 }, totalTokens: 5000 } }),
    entry({ requestId: "c", metadata: null }),
    entry({ requestId: "d", metadata: { requestId: "不认识" } }),
  ], { ...nineDaysWindow, calls });
  assert.equal(summary.byPartner.length, 3);
  const byId = Object.fromEntries(summary.byPartner.map((row) => [row.agentId ?? "(none)", row]));
  assert.equal(byId.hanako.requests, 1);
  assert.equal(byId.beta.requests, 1);
  assert.equal(byId.beta.total, 5000);
  assert.equal(byId["(none)"].requests, 2);
  assert.equal(summary.byKind.find((row) => row.kind === "chat").requests, 1);
});

test("按天按模型分组，模型按用量从多到少", () => {
  const rows = [
    entry(),
    entry({ requestId: "yesterday", startedAt: "2026-10-24T22:00:00+08:00" }),
    entry({ requestId: "big", model: { provider: "deepseek", modelId: "deepseek-v4" }, usage: { input: { totalTokens: 10, uncachedTokens: 10 }, output: { totalTokens: 10 }, cache: { readTokens: 0 }, totalTokens: 5000 } }),
  ];
  const summary = aggregateUsage(rows, nineDaysWindow);
  assert.deepEqual(summary.byDay.map((row) => row.day), ["2026-10-24", "2026-10-25"]);
  assert.equal(summary.byDay[1].requests, 2);
  assert.equal(summary.byModel[0].modelId, "deepseek-v4");
  assert.equal(summary.byModel[0].requests, 1);
  assert.equal(summary.recent.length, 3);
  assert.equal(summary.recent[0].at, new Date("2026-10-25T20:30:00+08:00").toISOString());
  assert.equal(summary.recent[2].at, new Date("2026-10-24T22:00:00+08:00").toISOString());
});

test("只回最近几条请求，不带正文、密钥、会话标识和费用", () => {
  const raw = entry({ text: "private text", apiKey: "secret-key", metadata: { original: "private" } });
  const serialized = JSON.stringify(aggregateUsage([raw], nineDaysWindow));
  for (const text of ["private text", "secret-key", "metadata", "costTotal"]) {
    assert.equal(serialized.includes(text), false);
  }
});

test("空账本不编造用量", () => {
  const summary = aggregateUsage([], nineDaysWindow);
  assert.equal(summary.requests, 0);
  assert.equal(summary.tokens.total.value, null);
  assert.deepEqual(summary.byDay, []);
  assert.deepEqual(summary.recent, []);
});

test("一次拉回整本账，按插件归因取，切范围只在本地过滤", async () => {
  const calls = [];
  const diagnostics = [];
  const ctx = {
    bus: {
      request: async (...args) => {
        calls.push(args);
        return { entries: [entry()], nextCursor: null };
      },
    },
  };
  const today = await collectUsage(ctx, { days: 1, now, diagnostics: (event) => diagnostics.push(event) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "usage:list");
  assert.equal(calls[0][1].attributionKind, "plugin");
  assert.equal(calls[0][1].limit, 20000);
  assert.equal(calls[0][1].until, now.toISOString());
  assert.equal(new Date(calls[0][1].since).getTime(), now.getTime() - 31 * 86400000);
  assert.equal(today.days, 1);
  assert.equal(today.requests, 1);
  assert.equal(today.truncated, false);
  assert.equal(diagnostics[0].event, "usage.stats.loaded");

  // 同一分钟内换范围不重新拉账本
  const week = await collectUsage(ctx, { days: 7, now: new Date(now.getTime() + 5000) });
  assert.equal(calls.length, 1);
  assert.equal(week.days, 7);

  // 过了一分钟才重新拉
  await collectUsage(ctx, { days: 7, now: new Date(now.getTime() + 61000) });
  assert.equal(calls.length, 2);
});

test("取满上限要标截断，取数失败照常抛", async () => {
  const full = { entries: Array.from({ length: 20000 }, (_, index) => entry({ requestId: `r-${index}` })) };
  const ok = await collectUsage({ bus: { request: async () => full } }, { days: 7, now });
  assert.equal(ok.truncated, true);
  await assert.rejects(
    collectUsage({ bus: { request: async () => { throw new Error("permission denied"); } } }, { now }),
    /permission denied/,
  );
});
