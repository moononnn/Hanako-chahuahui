/**
 * 关系可塑性的纯逻辑核心。
 *
 * 统一处理 hard / soft-limit / habit / identity 的边界，以及关系破例概率。
 * 具体行为模块只提供自己的 baseline、性格因子和情境因子，不各自发明亲密度算法。
 */

import { disclosureRatio, getStage } from "./relationship.js";
import { effectiveClaimEntries } from "./adaptation.js";

export const LIMIT_LAYERS = Object.freeze(["hard", "soft-limit", "habit", "identity"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const copy = (value) => value && typeof value === "object" ? structuredClone(value) : {};

export function classifyLimit(layer) {
  return LIMIT_LAYERS.includes(layer) ? layer : "soft-limit";
}

export function relationshipFactor(relationship) {
  return 0.35 + 0.65 * clamp(disclosureRatio(relationship), 0, 1);
}

export function fatigueFactor(sameDayExceptionCount = 0) {
  return 1 / (1 + 0.35 * Math.max(0, number(sameDayExceptionCount, 0)));
}

export function contextFactor(context = {}) {
  const value = String(context.kind ?? context.urgency ?? "normal").toLowerCase();
  if (["urgent", "distressed", "important", "急切", "难过"].includes(value)) return 1.25;
  if (["expected", "requested", "明确期待"].includes(value)) return 1;
  return 0.75;
}

function personalityFactor(personality, adapter) {
  if (typeof adapter?.personalityFactor === "function") {
    return clamp(number(adapter.personalityFactor(personality), 1), 0, 2);
  }
  const value = personality && typeof personality === "object" ? personality : {};
  const tags = [...(Array.isArray(value.surface) ? value.surface : []), ...(Array.isArray(value.inner) ? value.inner : []), ...(Array.isArray(value.tags) ? value.tags : [])]
    .map((item) => String(item).toLowerCase()).join(" ");
  if (!tags) return 1;
  if (/克制|安静|谨慎|慢热|分寸/u.test(tags)) return 0.75;
  if (/热情|外向|敏感|黏|活泼/u.test(tags)) return 1.15;
  return 1;
}

function claimMatches(claim, capability) {
  const target = String(claim?.target ?? "");
  return target === capability || target.startsWith(`${capability}.`) || capability.startsWith(`${target}.`);
}


function hasBlockingGuide(entries) {
  return entries.some(({ guide, claim }) =>
    guide.kind === "boundary" || guide.kind === "aversion" || claim.effect === "deny");
}

function preferenceDirection(entries) {
  let direction = 0;
  for (const { guide, claim } of entries) {
    if (guide.kind === "boundary" || guide.kind === "aversion" || claim.effect === "deny") continue;
    if (claim.value === "more" || claim.value === "wake-sooner" || claim.value === "comfort-first") direction += 1;
    if (claim.value === "less" || claim.value === "wake-later" || claim.value === "advice-first") direction -= 1;
  }
  return Math.sign(direction);
}

/**
 * 统一解析本轮关系策略。随机值与适配器都可注入，方便阶段 A 单测。
 */
export function resolveRelationalPolicy({
  capability = "",
  baseline = {},
  hardLimits = {},
  guides = [],
  userGuides = [],
  partnerGuides = [],
  habitChanges = [],
  personality = null,
  relationship = null,
  context = {},
  runtime = {},
  adapter = {},
  now = new Date(),
  random = Math.random,
} = {}) {
  const name = String(capability ?? "").trim();
  const reasons = [];
  const base = copy(baseline);
  const effective = copy(baseline);
  const entries = effectiveClaimEntries({
    userGuides: guides.length ? [] : userGuides,
    partnerGuides: guides.length ? guides : partnerGuides,
    now,
    currentTurnId: context.currentTurnId,
    lifeDay: context.lifeDay,
    capability: name,
  }).filter(({ claim }) => claimMatches(claim, name));
  const guideIds = [...new Set(entries.map(({ guide }) => guide.id).filter(Boolean))];
  const claimFingerprint = entries.map(({ guide, claim }) => [
    guide.id,
    claim.target,
    claim.effect,
    claim.value,
    claim.subject ?? "",
  ].join("|")).sort();
  const hardBlocked = hardLimits?.allowed === false || hardLimits?.blocked === true;
  if (hardBlocked) {
    return { allowed: false, baseline: base, effective: base, exceptionEligible: false, exceptionChosen: false, reasons: ["hard-limit"], guideIds, claimFingerprint, hardBlockedBy: hardLimits.reason || "hard-limit" };
  }
  if (hasBlockingGuide(entries)) {
    return { allowed: false, baseline: base, effective: base, exceptionEligible: false, exceptionChosen: false, reasons: ["explicit-deny"], guideIds, claimFingerprint, hardBlockedBy: null };
  }
  if (adapter.requiresPermission && !entries.some(({ guide }) => guide.kind === "permission" && guide.origin === "explicit")) {
    return { allowed: false, baseline: base, effective: base, exceptionEligible: false, exceptionChosen: false, reasons: ["permission-required"], guideIds, claimFingerprint, hardBlockedBy: null };
  }

  const direction = preferenceDirection(entries);
  const preference = typeof adapter.applyPreference === "function"
    ? adapter.applyPreference(effective, direction, { entries, habitChanges, runtime })
    : effective;
  const nextEffective = preference && typeof preference === "object" ? preference : effective;
  const ratio = clamp(disclosureRatio(relationship), 0, 1);
  const relationshipPart = relationshipFactor(relationship);
  const plasticity = clamp(number(adapter.plasticity, 1), 0, 1);
  const pFactor = personalityFactor(personality, adapter);
  const cFactor = clamp(number(adapter.contextFactor?.(context), contextFactor(context)), 0, 2);
  const fFactor = clamp(number(adapter.fatigueFactor?.(runtime), fatigueFactor(runtime.sameDayExceptionCount)), 0, 1);
  const baseChance = clamp(number(adapter.baseExceptionChance, 0), 0, 1);
  const maxChance = clamp(number(adapter.maxExceptionChance, 1), 0, 1);
  const exceptionChance = clamp(baseChance * plasticity * pFactor * relationshipPart * cFactor * fFactor, 0, maxChance);
  const eligible = baseChance > 0 && plasticity > 0 && ratio > 0;
  const randomValue = typeof random === "function" ? clamp(number(random(), 0), 0, 0.999999) : 0;
  const chosen = eligible && randomValue < exceptionChance;
  if (direction) reasons.push(direction > 0 ? "explicit-preference" : "explicit-aversion");
  if (chosen) reasons.push("relationship-exception");
  if (getStage(relationship) > 0) reasons.push("shared-history");
  return {
    allowed: true,
    baseline: base,
    effective: nextEffective,
    exceptionEligible: eligible,
    exceptionChosen: chosen,
    exceptionChance,
    ratio,
    relationshipFactor: relationshipPart,
    plasticity,
    personalityFactor: pFactor,
    contextFactor: cFactor,
    fatigueFactor: fFactor,
    reasons,
    guideIds,
    claimFingerprint,
    hardBlockedBy: null,
  };
}

export function sleepWakeDecision({ baselineWakeChance = 0, effectiveWakeChance = baselineWakeChance, random = Math.random } = {}) {
  const baseline = clamp(number(baselineWakeChance, 0), 0, 1);
  const effective = clamp(number(effectiveWakeChance, baseline), 0, 1);
  const rnd = typeof random === "function" ? clamp(number(random(), 0), 0, 0.999999) : 0;
  if (rnd < Math.min(baseline, effective)) return { decision: "normal", random: rnd, baselineWakeChance: baseline, effectiveWakeChance: effective };
  if (effective > baseline && rnd < effective) return { decision: "exception", random: rnd, baselineWakeChance: baseline, effectiveWakeChance: effective };
  return { decision: "deferred", random: rnd, baselineWakeChance: baseline, effectiveWakeChance: effective };
}

export function resolveSleepPolicy({ relationship = null, personality = null, guides = [], context = {}, runtime = {}, baselineWakeChance = 0.18, hardDelayCapMs = 6 * 60 * 60 * 1000, random = Math.random } = {}) {
  const resolved = resolveRelationalPolicy({
    capability: "sleep.reply",
    baseline: { wakeChance: baselineWakeChance },
    guides,
    relationship,
    personality,
    context,
    runtime,
    adapter: {
      baseExceptionChance: 0.55,
      maxExceptionChance: 0.72,
      plasticity: 0.85,
      applyPreference(effective, direction) {
        effective.direction = direction;
        return effective;
      },
      personalityFactor(value) {
        const tags = JSON.stringify(value ?? "");
        if (/敏感|在意|热情|黏/u.test(tags)) return 1.15;
        if (/克制|安静|慢热|有分寸/u.test(tags)) return 0.72;
        return 1;
      },
    },
    // 这里只解析阈值，不在策略阶段抽签；同一个随机值由 sleepWakeDecision 统一消费。
    random: () => 0,
  });
  const baseline = clamp(number(baselineWakeChance, 0.18), 0, 1);
  const direction = number(resolved.effective?.direction, 0);
  const exceptionBlocked = Array.isArray(runtime.negativeFeedbackBehaviors) && runtime.negativeFeedbackBehaviors.includes("sleep.wake");
  const habitState = runtime.habitStates?.["sleep.wake"];
  const habitBoost = habitState === "settled" ? 0.12 : habitState === "emerging" ? 0.04 : 0;
  const added = exceptionBlocked ? 0 : clamp(number(resolved.exceptionChance, 0), 0, 1);
  const effectiveWakeChance = resolved.allowed === false ? 0
    : direction < 0 ? clamp(baseline * 0.45, 0.02, baseline)
      : clamp(baseline + habitBoost + added * (1 - baseline), baseline, 0.95);
  return {
    ...resolved,
    baselineWakeChance: baseline,
    effectiveWakeChance,
    hardDelayCapMs: Math.max(1, number(hardDelayCapMs, 6 * 60 * 60 * 1000)),
    wakeDecision: sleepWakeDecision({ baselineWakeChance: baseline, effectiveWakeChance, random }),
  };
}

export function advanceWakeTransaction(pending, event = {}) {
  const source = pending && typeof pending === "object" ? pending : null;
  if (!source || !event?.type || ["committed", "cancelled"].includes(source.wakeOutcome)) return source;
  const at = new Date(event.at ?? new Date()).toISOString();
  if (event.type === "cancel") {
    return { ...source, wakeOutcome: "cancelled", cancelledAt: source.cancelledAt ?? at };
  }
  if (event.type === "deferred-resolved") {
    if (source.wakeDecision !== "deferred" || source.wakeResolvedAt) return source;
    return { ...source, wakeDecision: "later-notice", wakeOutcome: "later-notice", wakeResolvedAt: at };
  }
  if (source.wakeDecision === "later-notice" || source.wakeOutcome === "later-notice") return source;
  if (!["normal", "exception"].includes(source.wakeDecision)) return source;

  let next = source;
  if (event.type === "read") {
    if (source.wakeReadAt) return source;
    next = {
      ...source,
      wakeReadAt: at,
      wakeCountCommittedAt: at,
      wakeOutcome: source.wakeDecision === "exception" ? "woken" : "normal",
    };
  } else if (event.type === "reply-ready") {
    const resultMessageId = String(event.resultMessageId ?? "").trim();
    if (!resultMessageId || source.replyReadyAt) return source;
    next = { ...source, resultMessageId, replyReadyAt: at };
  } else {
    return source;
  }

  if (next.wakeReadAt && next.replyReadyAt) {
    return { ...next, wakeOutcome: "committed", committedAt: next.committedAt ?? at };
  }
  return next;
}

export function resolveDeferredWake(pending, now = new Date()) {
  return advanceWakeTransaction(pending, { type: "deferred-resolved", at: now });
}

export function commitWakeOutcome(pending, { resultMessageId = null, at = new Date() } = {}) {
  let next = advanceWakeTransaction(pending, { type: "read", at });
  if (resultMessageId) next = advanceWakeTransaction(next, { type: "reply-ready", resultMessageId, at });
  return next;
}

export function finalizeWakeReply(pending, resultMessageId, at = new Date()) {
  return advanceWakeTransaction(pending, { type: "reply-ready", resultMessageId, at });
}

export function exceptionIdempotencyKey(behavior, resultMessageId) {
  const name = String(behavior ?? "").trim();
  const result = String(resultMessageId ?? "").trim();
  return name && result ? `${name}|${result}` : "";
}

export function normalizeException(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(source.id ?? "").trim().slice(0, 120),
    behavior: String(source.behavior ?? "").trim().slice(0, 120),
    description: String(source.description ?? "").trim().slice(0, 240),
    normalRule: String(source.normalRule ?? "").trim().slice(0, 160),
    chosenAction: String(source.chosenAction ?? "").trim().slice(0, 240),
    subject: String(source.subject ?? "").trim().slice(0, 160),
    guideIds: Array.isArray(source.guideIds) ? [...new Set(source.guideIds.map(String).filter(Boolean))].slice(0, 12) : [],
    sourceMessageIds: Array.isArray(source.sourceMessageIds) ? [...new Set(source.sourceMessageIds.map(String).filter(Boolean))].slice(0, 12) : [],
    triggerMessageId: String(source.triggerMessageId ?? "").trim().slice(0, 120),
    resultMessageId: source.resultMessageId ? String(source.resultMessageId).trim().slice(0, 120) : null,
    outcome: ["woken", "committed", "failed", "cancelled"].includes(source.outcome) ? source.outcome : "committed",
    committedAt: source.committedAt || null,
    lifeDay: String(source.lifeDay ?? "").trim().slice(0, 20),
    consolidated: source.consolidated === true,
    sourceGuideRevoked: source.sourceGuideRevoked === true,
  };
}

const POSITIVE_FEEDBACK_TYPES = new Set(["explicit-like", "repeat-request", "explicit-continue"]);
const NEGATIVE_FEEDBACK_TYPES = new Set(["explicit-dislike", "stop-request", "correction"]);

export function attributeFeedback({ exceptions = [], feedbackEvents = [], proposal = null, sourceMessageId = "", lifeDay = "", now = new Date() } = {}) {
  const sourceId = String(sourceMessageId ?? "").trim();
  const exceptionId = String(proposal?.exceptionId ?? "").trim();
  const type = String(proposal?.type ?? "").trim();
  const polarity = proposal?.polarity === "negative" ? "negative" : "positive";
  if (!sourceId || !exceptionId) return { ok: false, reason: "missing-source" };
  if (!(polarity === "positive" ? POSITIVE_FEEDBACK_TYPES : NEGATIVE_FEEDBACK_TYPES).has(type)) return { ok: false, reason: "invalid-type" };
  if (feedbackEvents.some((row) => row?.sourceMessageId === sourceId)) return { ok: false, reason: "source-used" };
  const exception = exceptions.find((row) => row?.id === exceptionId && row?.outcome === "committed");
  if (!exception) return { ok: false, reason: "exception-missing" };
  const committedAt = Date.parse(String(exception.committedAt ?? ""));
  const ageMs = new Date(now).getTime() - committedAt;
  if (!Number.isFinite(committedAt) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return { ok: false, reason: "outside-window" };
  const event = {
    id: `${exception.behavior}|${lifeDay}|${sourceId}|${polarity}`,
    exceptionId,
    type,
    polarity,
    sourceMessageId: sourceId,
    lifeDay: String(lifeDay ?? ""),
    at: new Date(now).toISOString(),
  };
  if (feedbackEvents.some((row) => row?.id === event.id)) return { ok: false, reason: "duplicate" };
  return { ok: true, event, exception };
}

const HABIT_TARGET_BY_BEHAVIOR = Object.freeze({
  "voice.frequency": "voice.frequency",
  "sleep.wake": "sleep.reply",
  "reply.advice-style": "reply.advice-style",
});

function guideTime(guide) {
  return Date.parse(String(guide?.updatedAt ?? guide?.createdAt ?? ""));
}

function activeGuide(guide) {
  return guide && !["revoked", "superseded", "expired"].includes(guide.status);
}

function guideSupportsHabit(guide, behavior, { after = Number.NEGATIVE_INFINITY, explicitOnly = false } = {}) {
  if (!activeGuide(guide) || guide.kind !== "preference") return false;
  if (explicitOnly ? guide.origin !== "explicit" : !(guide.origin === "explicit" || (guide.origin === "observed" && Number(guide.confidence) >= 0.8))) return false;
  if (Number.isFinite(after) && !(guideTime(guide) > after)) return false;
  const target = HABIT_TARGET_BY_BEHAVIOR[behavior];
  return Boolean(target && guide.claims?.some((claim) => claim.target === target && claim.effect === "prefer"));
}

function guideReopensStickerSubject(guide, subject, after) {
  return activeGuide(guide) && guide.origin === "explicit" && guide.kind === "permission" && guideTime(guide) > after
    && guide.claims?.some((claim) => claim.target === "sticker.permission" && claim.effect === "allow" && claim.value === "specific" && claim.subject === subject);
}

export function buildAdaptationFeedbackRuntime({ exceptions = [], feedbackEvents = [], habitChanges = [], guides = [] } = {}) {
  const byId = new Map(exceptions.map((row) => [row.id, row]));
  const latestNegativeByBehavior = new Map();
  const latestNegativeByStickerSubject = new Map();
  for (const feedback of feedbackEvents) {
    if (feedback.polarity !== "negative") continue;
    const exception = byId.get(feedback.exceptionId);
    if (!exception) continue;
    latestNegativeByBehavior.set(exception.behavior, { feedback, exception });
    if (exception.behavior === "sticker.permission" && exception.subject) latestNegativeByStickerSubject.set(exception.subject, { feedback, exception });
  }
  const negativeFeedbackBehaviors = [...latestNegativeByBehavior.entries()]
    .filter(([behavior, { feedback }]) => !guides.some((guide) => guideSupportsHabit(guide, behavior, { after: Date.parse(String(feedback.at ?? "")), explicitOnly: true })))
    .map(([behavior]) => behavior);
  const negativeStickerSubjects = [...latestNegativeByStickerSubject.entries()]
    .filter(([subject, { feedback }]) => !guides.some((guide) => guideReopensStickerSubject(guide, subject, Date.parse(String(feedback.at ?? "")))))
    .map(([subject]) => subject);
  return {
    negativeFeedbackBehaviors,
    negativeStickerSubjects,
    habitStates: Object.fromEntries(habitChanges.filter((row) => ["emerging", "settled"].includes(row.state)
      && row.guideIds?.some((guideId) => guides.some((guide) => guide.id === guideId && guideSupportsHabit(guide, row.key))))
      .map((row) => [row.key, row.state])),
  };
}

export function consolidateHabitChanges({ exceptions = [], feedbackEvents = [], habitChanges = [], guides = [] } = {}) {
  const previous = new Map((Array.isArray(habitChanges) ? habitChanges : []).map((row) => [row.key, row]));
  const behaviors = new Set([
    ...exceptions.map((row) => row?.behavior).filter(Boolean),
    ...previous.keys(),
  ]);
  const result = [];
  for (const behavior of behaviors) {
    const eligibleGuideIds = new Set(guides.filter((guide) => guideSupportsHabit(guide, behavior)).map((guide) => guide.id));
    const allCommitted = exceptions.filter((row) => row?.behavior === behavior && row?.outcome === "committed" && row?.sourceGuideRevoked !== true && row?.guideIds?.some((guideId) => eligibleGuideIds.has(guideId)));
    const allIds = new Set(allCommitted.map((row) => row.id));
    const allFeedback = feedbackEvents.filter((row) => allIds.has(row?.exceptionId));
    const lastNegative = [...allFeedback].reverse().find((row) => row.polarity === "negative");
    const latestFeedback = allFeedback.at(-1);
    const old = previous.get(behavior);
    if (!eligibleGuideIds.size) {
      if (old) result.push({ ...old, state: "reverted", updatedAt: new Date().toISOString() });
      continue;
    }
    const negativeAt = lastNegative ? Date.parse(String(lastNegative.at ?? "")) : Number.NEGATIVE_INFINITY;
    const reopenedByPreference = lastNegative && guides.some((guide) => guideSupportsHabit(guide, behavior, { after: negativeAt, explicitOnly: true }));
    if (latestFeedback?.polarity === "negative" || (lastNegative && !reopenedByPreference)) {
      result.push({ ...(old ?? {}), key: behavior, description: old?.description || `${behavior} 的关系习惯`, state: "reverted", guideIds: [...new Set(allCommitted.flatMap((row) => row.guideIds ?? []))], exceptionIds: [...allIds], updatedAt: new Date().toISOString() });
      continue;
    }
    const cutoff = lastNegative ? negativeAt : Number.NEGATIVE_INFINITY;
    const committed = Number.isFinite(cutoff) ? allCommitted.filter((row) => Date.parse(String(row.committedAt ?? "")) > cutoff) : allCommitted;
    const ids = new Set(committed.map((row) => row.id));
    const feedback = allFeedback.filter((row) => ids.has(row?.exceptionId) && Date.parse(String(row.at ?? "")) > cutoff);
    const days = new Set(committed.map((row) => row.lifeDay).filter(Boolean));
    const positive = feedback.filter((row) => row.polarity === "positive");
    const positiveExceptions = new Set(positive.map((row) => row.exceptionId));
    const positiveSources = new Set(positive.map((row) => row.sourceMessageId));
    const positiveDays = new Set(positive.map((row) => row.lifeDay).filter(Boolean));
    let state = old?.state;
    if (committed.length >= 3 && days.size >= 3 && positive.length >= 1) state = state === "settled" ? "settled" : "emerging";
    if (old?.state === "emerging" && committed.length >= 5 && days.size >= 5 && positive.length >= 2 && positiveExceptions.size >= 2 && positiveSources.size >= 2 && positiveDays.size >= 2) state = "settled";
    if (!["emerging", "settled"].includes(state)) continue;
    result.push({
      ...(old ?? {}),
      key: behavior,
      description: old?.description || `${behavior} 的关系习惯`,
      state,
      guideIds: [...new Set(committed.flatMap((row) => row.guideIds ?? []))],
      exceptionIds: [...ids],
      startedAt: old?.startedAt ?? committed[0]?.committedAt ?? null,
      settledAt: state === "settled" ? old?.settledAt ?? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    });
  }
  return result.slice(-32);
}

export function appendException(exceptions, exception, max = 64) {
  const next = Array.isArray(exceptions) ? exceptions.map(normalizeException) : [];
  const row = normalizeException(exception);
  if (!row.id && !row.behavior) return next.slice(-max);
  const key = row.id || exceptionIdempotencyKey(row.behavior, row.resultMessageId);
  const index = next.findIndex((item) => (item.id || exceptionIdempotencyKey(item.behavior, item.resultMessageId)) === key);
  if (index >= 0) next[index] = { ...next[index], ...row };
  else next.push(row);
  return next.slice(-Math.max(1, max));
}
