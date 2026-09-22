import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceWakeTransaction,
  appendException,
  attributeFeedback,
  buildAdaptationFeedbackRuntime,
  consolidateHabitChanges,
  classifyLimit,
  commitWakeOutcome,
  exceptionIdempotencyKey,
  fatigueFactor,
  finalizeWakeReply,
  relationshipFactor,
  resolveDeferredWake,
  resolveRelationalPolicy,
  resolveSleepPolicy,
  sleepWakeDecision,
} from "../lib/plasticity.js";
import { createRelationship } from "../lib/relationship.js";

const now = new Date("2026-09-22T08:35:00+08:00");
const rel = (turns, days, score = 0) => ({
  ...createRelationship(now),
  familiarity: { turns, activeDays: days },
  intimacy: { score },
});
const pref = (extra = {}) => ({
  id: "g-voice",
  meaning: "我喜欢你多发一点语音",
  kind: "preference",
  scope: "relationship",
  duration: "persistent",
  origin: "explicit",
  sourceMessageIds: ["m-pref"],
  claims: [{ target: "voice.frequency", effect: "prefer", value: "more" }],
  createdAt: now.toISOString(),
  ...extra,
});

test("睡眠随机值按 baseline / exception / deferred 三段落位", () => {
  assert.equal(sleepWakeDecision({ baselineWakeChance: 0.2, effectiveWakeChance: 0.5, random: () => 0.1 }).decision, "normal");
  assert.equal(sleepWakeDecision({ baselineWakeChance: 0.2, effectiveWakeChance: 0.5, random: () => 0.3 }).decision, "exception");
  assert.equal(sleepWakeDecision({ baselineWakeChance: 0.2, effectiveWakeChance: 0.5, random: () => 0.8 }).decision, "deferred");
});

test("关系越深，睡眠 effectiveWakeChance 不下降，且不超过硬上限", () => {
  const args = { baselineWakeChance: 0.2, personality: { inner: { tags: ["敏感"] } }, random: () => 0.9 };
  const newPolicy = resolveSleepPolicy({ ...args, relationship: rel(0, 0, 0) });
  const closePolicy = resolveSleepPolicy({ ...args, relationship: rel(80, 30, 40) });
  assert.ok(closePolicy.effectiveWakeChance >= newPolicy.effectiveWakeChance);
  assert.ok(closePolicy.effectiveWakeChance <= 0.95);
  assert.ok(closePolicy.hardDelayCapMs > 0);
});

test("运行时不会沿用已失效 guide 派生的旧 habit", () => {
  const habitChanges = [{ key: "voice.frequency", state: "settled", guideIds: ["g-wide"] }];
  const active = pref({ id: "g-wide", status: "active" });
  const revoked = { ...active, status: "revoked" };
  assert.equal(buildAdaptationFeedbackRuntime({ habitChanges, guides: [active] }).habitStates["voice.frequency"], "settled");
  assert.equal(buildAdaptationFeedbackRuntime({ habitChanges, guides: [revoked] }).habitStates["voice.frequency"], undefined);
});

test("睡眠负反馈只撤掉关系额外醒来，习惯则按 emerging / settled 逐级反哺", () => {
  const relationship = rel(80, 30, 40);
  const guide = pref({ claims: [{ target: "sleep.reply", effect: "prefer", value: "wake-sooner" }] });
  const baseline = resolveSleepPolicy({ baselineWakeChance: 0.2, relationship, guides: [guide] });
  const blocked = resolveSleepPolicy({ baselineWakeChance: 0.2, relationship, guides: [guide], runtime: { negativeFeedbackBehaviors: ["sleep.wake"] } });
  const emerging = resolveSleepPolicy({ baselineWakeChance: 0.2, runtime: { habitStates: { "sleep.wake": "emerging" } } });
  const settled = resolveSleepPolicy({ baselineWakeChance: 0.2, runtime: { habitStates: { "sleep.wake": "settled" } } });
  assert.equal(blocked.effectiveWakeChance, 0.2);
  assert.ok(baseline.effectiveWakeChance > blocked.effectiveWakeChance);
  assert.ok(emerging.effectiveWakeChance > 0.2);
  assert.ok(settled.effectiveWakeChance > emerging.effectiveWakeChance);
});

test("wake-sooner / baseline / wake-later 单调，明确 none 固定 deferred", () => {
  const relationship = rel(80, 30, 40);
  const guideFor = (effect, value, kind = "preference") => pref({
    id: `sleep-${value}`,
    kind,
    claims: [{ target: "sleep.reply", effect, value }],
  });
  const sooner = resolveSleepPolicy({ relationship, guides: [guideFor("prefer", "wake-sooner")], random: () => 0.1 });
  const baseline = resolveSleepPolicy({ relationship, random: () => 0.1 });
  const later = resolveSleepPolicy({ relationship, guides: [guideFor("prefer", "wake-later")], random: () => 0.1 });
  const denied = resolveSleepPolicy({ relationship, guides: [guideFor("deny", "none", "boundary")], random: () => 0 });
  assert.ok(sooner.effectiveWakeChance >= baseline.effectiveWakeChance);
  assert.ok(baseline.effectiveWakeChance > later.effectiveWakeChance);
  assert.equal(denied.wakeDecision.decision, "deferred");
});

test("deferred 只能单向变成 later-notice，不能重复转换", () => {
  const first = resolveDeferredWake({ wakeDecision: "deferred" }, now);
  assert.equal(first.wakeDecision, "later-notice");
  assert.equal(resolveDeferredWake(first, now), first);
  assert.equal(resolveDeferredWake({ wakeDecision: "exception", wakeResolvedAt: null }, now).wakeDecision, "exception");
});

test("醒来事务满足交换律：read 与 reply-ready 谁先来，最终结果一致", () => {
  const pending = { wakeDecision: "exception", triggerMessageId: "m-trigger", wakeOutcome: "pending" };
  const readFirst = advanceWakeTransaction(
    advanceWakeTransaction(pending, { type: "read", at: now }),
    { type: "reply-ready", resultMessageId: "m-reply", at: now },
  );
  const replyFirst = advanceWakeTransaction(
    advanceWakeTransaction(pending, { type: "reply-ready", resultMessageId: "m-reply", at: now }),
    { type: "read", at: now },
  );
  assert.deepEqual(readFirst, replyFirst);
  assert.equal(readFirst.wakeOutcome, "committed");
  assert.equal(readFirst.resultMessageId, "m-reply");
});

test("醒来事务重复事件幂等，normal 不写 exception，later-notice 不算醒来", () => {
  const normal = advanceWakeTransaction({ wakeDecision: "normal", wakeOutcome: "pending" }, { type: "read", at: now });
  assert.equal(normal.wakeOutcome, "normal");
  assert.equal(advanceWakeTransaction(normal, { type: "read", at: now }), normal);
  const ready = advanceWakeTransaction(normal, { type: "reply-ready", resultMessageId: "m-normal", at: now });
  assert.equal(ready.wakeOutcome, "committed");
  assert.equal(ready.exceptionId, undefined);
  const later = advanceWakeTransaction({ wakeDecision: "deferred", wakeOutcome: "pending" }, { type: "deferred-resolved", at: now });
  assert.equal(later.wakeDecision, "later-notice");
  assert.equal(later.wakeOutcome, "later-notice");
  assert.equal(advanceWakeTransaction(later, { type: "read", at: now }), later);
});

test("旧提交 helper 继续走唯一事务推进器", () => {
  const woken = commitWakeOutcome({ wakeDecision: "exception" }, { at: now });
  assert.equal(woken.wakeOutcome, "woken");
  const committed = finalizeWakeReply(woken, "m-reply", now);
  assert.equal(committed.wakeOutcome, "committed");
  assert.equal(commitWakeOutcome(committed, { resultMessageId: "other" }), committed);
});

test("限制层只认四类，未知值回到 soft-limit", () => {
  assert.equal(classifyLimit("hard"), "hard");
  assert.equal(classifyLimit("identity"), "identity");
  assert.equal(classifyLimit("unknown"), "soft-limit");
});

test("关系因子单调增加，疲劳因子递减", () => {
  assert.ok(relationshipFactor(rel(20, 5, 10)) > relationshipFactor(rel(0, 0, 0)));
  assert.equal(fatigueFactor(0), 1);
  assert.ok(fatigueFactor(3) < fatigueFactor(1));
});

test("hard 永远压过偏好与关系", () => {
  const result = resolveRelationalPolicy({
    capability: "voice",
    baseline: { chance: 0.2 },
    hardLimits: { blocked: true, reason: "费用上限" },
    partnerGuides: [pref()],
    relationship: rel(80, 30, 40),
    now,
    random: () => 0,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.hardBlockedBy, "费用上限");
});

test("策略指纹精确到 claim 内容，同 guide id 改口也会变化", () => {
  const more = resolveRelationalPolicy({ capability: "voice", partnerGuides: [pref()], relationship: rel(20, 5, 10), now });
  const less = resolveRelationalPolicy({
    capability: "voice",
    partnerGuides: [pref({ claims: [{ target: "voice.frequency", effect: "prefer", value: "less" }] })],
    relationship: rel(20, 5, 10),
    now,
  });
  assert.notDeepEqual(more.claimFingerprint, less.claimFingerprint);
});

test("明确 deny 压过 permission/preference，且不被亲密度补回", () => {
  const result = resolveRelationalPolicy({
    capability: "voice",
    baseline: { chance: 0.2 },
    partnerGuides: [pref({ id: "deny", kind: "boundary", claims: [{ target: "voice.frequency", effect: "deny", value: "none" }] })],
    relationship: rel(80, 30, 40),
    now,
    random: () => 0,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasons[0], "explicit-deny");
});

test("相同随机源下，亲近关系的破例机会不低于初识", () => {
  const args = {
    capability: "voice",
    baseline: { chance: 0.2 },
    partnerGuides: [pref()],
    adapter: { baseExceptionChance: 0.8, maxExceptionChance: 0.95, plasticity: 1 },
    now,
    random: () => 0.2,
  };
  const newRel = resolveRelationalPolicy({ ...args, relationship: rel(0, 0, 0) });
  const closeRel = resolveRelationalPolicy({ ...args, relationship: rel(80, 30, 40) });
  assert.ok(closeRel.exceptionChance >= newRel.exceptionChance);
  assert.equal(closeRel.exceptionChosen, true);
});

test("同日破例越多，疲劳成本越高，但不会把硬上限改掉", () => {
  const base = {
    capability: "voice",
    baseline: { chance: 0.2 },
    partnerGuides: [pref()],
    adapter: { baseExceptionChance: 0.8, maxExceptionChance: 0.95, plasticity: 1 },
    relationship: rel(80, 30, 40),
    now,
    random: () => 0.2,
  };
  const first = resolveRelationalPolicy({ ...base, runtime: { sameDayExceptionCount: 0 } });
  const tired = resolveRelationalPolicy({ ...base, runtime: { sameDayExceptionCount: 4 } });
  assert.ok(tired.exceptionChance < first.exceptionChance);
  assert.equal(tired.effective.chance, 0.2);
});

test("反馈只能绑定 24 小时内具体 committed exception，同一用户消息不能重复占用", () => {
  const exceptions = [{ id: "ex-1", behavior: "voice.frequency", outcome: "committed", committedAt: now.toISOString(), lifeDay: "2026-09-22" }];
  const feedback = attributeFeedback({
    exceptions,
    feedbackEvents: [],
    proposal: { exceptionId: "ex-1", polarity: "positive", type: "explicit-like" },
    sourceMessageId: "m-like",
    lifeDay: "2026-09-22",
    now,
  });
  assert.equal(feedback.ok, true);
  assert.equal(feedback.event.exceptionId, "ex-1");
  assert.equal(attributeFeedback({ exceptions, feedbackEvents: [feedback.event], proposal: feedback.event, sourceMessageId: "m-like", lifeDay: "2026-09-22", now }).ok, false);
  assert.equal(attributeFeedback({ exceptions: [{ ...exceptions[0], committedAt: "2026-09-20T00:00:00.000Z" }], proposal: feedback.event, sourceMessageId: "m-old", lifeDay: "2026-09-22", now }).ok, false);
});

test("跨日破例与独立正反馈依次形成 emerging / settled，负反馈立即 reverted", () => {
  const exception = (n, day) => ({ id: `ex-${n}`, behavior: "voice.frequency", outcome: "committed", committedAt: `${day}T08:00:00.000Z`, lifeDay: day, guideIds: ["g-voice"] });
  const feedback = (n, day, polarity = "positive") => ({ id: `fb-${n}`, exceptionId: `ex-${n}`, type: polarity === "positive" ? "explicit-like" : "explicit-dislike", polarity, sourceMessageId: `m-${n}`, lifeDay: day, at: `${day}T09:00:00.000Z` });
  const guides = [pref()];
  const emerging = consolidateHabitChanges({ exceptions: [exception(1, "2026-09-18"), exception(2, "2026-09-19"), exception(3, "2026-09-20")], feedbackEvents: [feedback(3, "2026-09-20")], guides });
  assert.equal(emerging[0].state, "emerging");
  const settled = consolidateHabitChanges({ exceptions: [...emerging[0].exceptionIds.map((id, i) => exception(i + 1, ["2026-09-18", "2026-09-19", "2026-09-20"][i])), exception(4, "2026-09-21"), exception(5, "2026-09-22")], feedbackEvents: [feedback(3, "2026-09-20"), feedback(5, "2026-09-22")], habitChanges: emerging, guides });
  assert.equal(settled[0].state, "settled");
  const reverted = consolidateHabitChanges({ exceptions: [exception(1, "2026-09-22")], feedbackEvents: [feedback(1, "2026-09-22", "negative")], habitChanges: settled, guides });
  assert.equal(reverted[0].state, "reverted");
});

test("负反馈锁住 habit 与后续破例，普通正反馈不能解锁，只有新的明确偏好才行", () => {
  const exceptions = [1, 2, 3].map((n) => ({ id: `ex-${n}`, behavior: "voice.frequency", outcome: "committed", committedAt: `2026-09-2${n}T00:00:00.000Z`, lifeDay: `2026-09-2${n}`, guideIds: ["g-old"] }));
  const feedbackEvents = [
    { id: "fb-neg", exceptionId: "ex-1", polarity: "negative", sourceMessageId: "m-neg", lifeDay: "2026-09-21", at: "2026-09-21T01:00:00.000Z" },
    { id: "fb-pos", exceptionId: "ex-3", polarity: "positive", sourceMessageId: "m-pos", lifeDay: "2026-09-23", at: "2026-09-23T01:00:00.000Z" },
  ];
  const oldGuide = pref({ id: "g-old", createdAt: "2026-09-20T00:00:00.000Z" });
  const locked = consolidateHabitChanges({ exceptions, feedbackEvents, habitChanges: [{ key: "voice.frequency", state: "emerging" }], guides: [oldGuide] });
  assert.equal(locked[0].state, "reverted");
  assert.deepEqual(buildAdaptationFeedbackRuntime({ exceptions, feedbackEvents, habitChanges: locked, guides: [oldGuide] }).negativeFeedbackBehaviors, ["voice.frequency"]);
  const newGuide = pref({ id: "g-new", createdAt: "2026-09-23T02:00:00.000Z" });
  const freshExceptions = [4, 5, 6].map((n, i) => ({ id: `ex-${n}`, behavior: "voice.frequency", outcome: "committed", committedAt: `2026-09-${24 + i}T00:00:00.000Z`, lifeDay: `2026-09-${24 + i}`, guideIds: ["g-new"] }));
  const freshFeedback = { id: "fb-new", exceptionId: "ex-6", polarity: "positive", sourceMessageId: "m-new", lifeDay: "2026-09-26", at: "2026-09-26T01:00:00.000Z" };
  const unlocked = consolidateHabitChanges({ exceptions: [...exceptions, ...freshExceptions], feedbackEvents: [...feedbackEvents, freshFeedback], habitChanges: locked, guides: [oldGuide, newGuide] });
  assert.equal(unlocked[0].state, "emerging");
});

test("permission/boundary 不能被次数堆成 habit", () => {
  const exceptions = [1, 2, 3].map((n) => ({ id: `ex-p-${n}`, behavior: "sticker.permission", outcome: "committed", committedAt: `2026-09-2${n}T00:00:00.000Z`, lifeDay: `2026-09-2${n}`, guideIds: ["g-permission"] }));
  const feedbackEvents = [{ id: "fb-p", exceptionId: "ex-p-3", polarity: "positive", sourceMessageId: "m-p", lifeDay: "2026-09-23", at: "2026-09-23T01:00:00.000Z" }];
  const permission = pref({ id: "g-permission", kind: "permission", claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:stk-1" }] });
  assert.deepEqual(consolidateHabitChanges({ exceptions, feedbackEvents, guides: [permission] }), []);
});

test("破例幂等键不依赖以后才补写的字段", () => {
  assert.equal(exceptionIdempotencyKey("voice.frequency", "m-result"), "voice.frequency|m-result");
  assert.equal(exceptionIdempotencyKey("voice.frequency", ""), "");
  const first = appendException([], { id: "ex-1", behavior: "voice.frequency", resultMessageId: "m-1", outcome: "woken" });
  const next = appendException(first, { id: "ex-1", behavior: "voice.frequency", resultMessageId: "m-1", outcome: "committed" });
  assert.equal(next.length, 1);
  assert.equal(next[0].outcome, "committed");
});
