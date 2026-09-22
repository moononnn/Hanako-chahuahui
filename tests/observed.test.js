import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { inferObservedGuide } from "../lib/observed.js";
import { buildRelationshipAdaptationBlock, effectiveClaimEntries } from "../lib/adaptation.js";

const appSource = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

const messages = [
  { id: "m1", role: "user", text: "你呢，今天过得怎么样", at: "2026-09-18T08:00:00.000Z" },
  { id: "m2", role: "user", text: "也说说你自己嘛", at: "2026-09-19T08:00:00.000Z" },
  { id: "m3", role: "user", text: "先别只聊我，讲讲你自己", at: "2026-09-20T08:00:00.000Z" },
];

const observed = {
  id: "obs-self",
  meaning: "你似乎喜欢我也多分享一点自己",
  kind: "preference",
  scope: "relationship",
  duration: "persistent",
  origin: "observed",
  confidence: 0.72,
  sourceMessageIds: ["m1", "m2", "m3"],
  claims: [{ target: "reply.self-disclosure", effect: "prefer", value: "more" }],
  status: "active",
  createdAt: messages[2].at,
  updatedAt: messages[2].at,
};

test("同一安全模式至少跨 3 个生活日、有 3 条用户行为证据才形成 observed", () => {
  assert.equal(inferObservedGuide({ messages: messages.slice(0, 2), guides: [], now: new Date(messages[1].at) }).guide, null);
  const result = inferObservedGuide({ messages, guides: [], now: new Date(messages[2].at) });
  assert.equal(result.guide.origin, "observed");
  assert.ok(result.guide.confidence < 1);
  assert.deepEqual(result.guide.sourceMessageIds, ["m1", "m2", "m3"]);
  assert.equal(result.guide.claims[0].target, "reply.self-disclosure");
  assert.match(buildRelationshipAdaptationBlock({ partnerGuides: [result.guide], now: new Date(messages[2].at) }), /轻微观察（仍可能看偏）/);
});

test("explicit 冲突、曾被纠错/忘掉的 observed 与敏感行为都不得自动观察", () => {
  const explicit = { ...observed, id: "exp", origin: "explicit", claims: [{ target: "reply.self-disclosure", effect: "prefer", value: "less" }] };
  assert.equal(inferObservedGuide({ messages, guides: [explicit], now: new Date(messages[2].at) }).guide, null);
  assert.equal(inferObservedGuide({ messages, guides: [{ ...explicit, status: "revoked" }], now: new Date(messages[2].at) }).guide, null, "用户忘掉 explicit 后不能拿旧证据换 observed 复活");
  assert.equal(inferObservedGuide({ messages, guides: [{ ...observed, status: "revoked" }], now: new Date(messages[2].at) }).guide, null);
  assert.equal(inferObservedGuide({ messages, guides: [], locks: ["reply.self-disclosure"], now: new Date(messages[2].at) }).guide, null, "历史 guide 被容量裁掉后仍要靠持久锁防复活");
  const sensitive = [
    { id: "s1", role: "user", text: "可以骂我", at: "2026-09-18T08:00:00.000Z" },
    { id: "s2", role: "user", text: "你可以碰我", at: "2026-09-19T08:00:00.000Z" },
    { id: "s3", role: "user", text: "帮我付款", at: "2026-09-20T08:00:00.000Z" },
  ];
  assert.equal(inferObservedGuide({ messages: sensitive, guides: [], now: new Date(messages[2].at) }).guide, null);
});

test("真实发送链先落 explicit reconciler，再跑弱观察，且只读已落盘用户消息", () => {
  assert.match(appSource, /await reconcileAdaptationFromUserMessage\(agentId, stored\);[\s\S]*?observeAdaptationFromHistory\(agentId\);/);
  assert.match(appSource, /messages: store\.getThread\(agentId\)\.messages/);
});

test("同目标 explicit 永远压过更新的 observed", () => {
  const explicit = { ...observed, id: "exp", origin: "explicit", updatedAt: "2026-09-01T00:00:00.000Z", claims: [{ target: "reply.self-disclosure", effect: "prefer", value: "less" }] };
  const newerObserved = { ...observed, updatedAt: "2026-09-22T00:00:00.000Z" };
  const entries = effectiveClaimEntries({ partnerGuides: [explicit, newerObserved], now: new Date("2026-09-22T01:00:00.000Z") });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].guide.id, "exp");
  assert.equal(entries[0].claim.value, "less");
});
