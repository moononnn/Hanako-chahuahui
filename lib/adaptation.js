/**
 * 关系适应层：把相处中形成的理解与茶话会自己的数据边界隔开。
 *
 * 这里只做纯逻辑：归一、有效期、覆盖、撤回和给模型看的简短人话。
 * 不读文件、不调模型，也不把原始聊天证据拼进提示词。
 */

export const GUIDE_KINDS = Object.freeze([
  "preference",
  "aversion",
  "permission",
  "boundary",
  "convention",
  "temporary-state",
]);
export const GUIDE_SCOPES = Object.freeze(["relationship", "user-wide"]);
export const GUIDE_DURATIONS = Object.freeze(["persistent", "life-day", "until", "current-turn"]);
export const GUIDE_ORIGINS = Object.freeze(["explicit", "observed"]);
export const GUIDE_STATUSES = Object.freeze(["active", "revoked", "superseded", "expired"]);

const CLAIMS = Object.freeze({
  "voice.frequency": {
    effect: ["prefer", "deny"],
    value: ["more", "less", "none"],
  },
  "sleep.reply": {
    effect: ["prefer", "deny"],
    value: ["wake-sooner", "wake-later", "none"],
  },
  "sticker.permission": {
    effect: ["allow", "deny"],
    value: ["specific", "none"],
  },
  "proactive.frequency": {
    effect: ["prefer", "deny"],
    value: ["more", "less", "none"],
  },
  "reply.advice-style": {
    effect: ["prefer", "deny"],
    value: ["comfort-first", "advice-first", "none"],
  },
  "reply.self-disclosure": {
    effect: ["prefer", "deny"],
    value: ["more", "less", "none"],
  },
  "reply.teasing": {
    effect: ["prefer", "deny"],
    value: ["more", "less", "none"],
  },
});

const text = (value, max) => String(value ?? "").trim().slice(0, max);
const idList = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => text(item, 120)).filter(Boolean))].slice(0, 12);
const iso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const atMs = (value, fallback = Date.now()) => {
  const date = new Date(value ?? fallback);
  return Number.isFinite(date.getTime()) ? date.getTime() : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function normalizeClaim(raw) {
  if (!raw || typeof raw !== "object") return null;
  const target = text(raw.target, 100);
  const spec = CLAIMS[target];
  if (!spec) return null;
  const effect = text(raw.effect, 40);
  const value = text(raw.value, 80);
  if (!spec.effect.includes(effect) || !spec.value.includes(value)) return null;
  const result = { target, effect, value };
  if (raw.subject !== undefined) result.subject = text(raw.subject, 160);
  return result;
}

export function normalizeClaims(value) {
  const claims = (Array.isArray(value) ? value : [])
    .map(normalizeClaim).filter(Boolean);
  const seen = new Set();
  return claims.filter((claim) => {
    const key = `${claim.target}|${claim.effect}|${claim.value}|${claim.subject ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

export function normalizeGuide(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const origin = GUIDE_ORIGINS.includes(source.origin) ? source.origin : "observed";
  const duration = GUIDE_DURATIONS.includes(source.duration) ? source.duration : "persistent";
  const status = GUIDE_STATUSES.includes(source.status) ? source.status : "active";
  const createdAt = iso(source.createdAt) ?? new Date(now).toISOString();
  const updatedAt = iso(source.updatedAt) ?? createdAt;
  const expiresAt = iso(source.expiresAt);
  const expired = status === "active" && expiresAt && atMs(expiresAt) <= atMs(now);
  return {
    id: text(source.id, 120),
    meaning: text(source.meaning, 240),
    kind: GUIDE_KINDS.includes(source.kind) ? source.kind : "preference",
    scope: GUIDE_SCOPES.includes(source.scope) ? source.scope : "relationship",
    context: text(source.context, 160),
    duration,
    lifeDay: text(source.lifeDay, 20) || null,
    expiresAt,
    origin,
    confidence: origin === "explicit" ? 1 : clamp(Number(source.confidence) || 0.5, 0, 0.99),
    sourceMessageIds: idList(source.sourceMessageIds),
    evidenceQuote: text(source.evidenceQuote, 160),
    claims: normalizeClaims(source.claims),
    status: expired ? "expired" : status,
    supersedesId: text(source.supersedesId, 120) || null,
    createdAt,
    updatedAt,
    revokedAt: iso(source.revokedAt),
  };
}

export function normalizeGuides(value, now = new Date()) {
  return (Array.isArray(value) ? value : [])
    .map((row) => normalizeGuide(row, now))
    .filter((row) => row.id && row.meaning)
    .slice(-128);
}

export function isGuideActive(guide, { now = new Date(), currentTurnId = "", lifeDay = "" } = {}) {
  const row = normalizeGuide(guide, now);
  if (row.status !== "active" || !row.meaning) return false;
  if (row.expiresAt && atMs(row.expiresAt) <= atMs(now)) return false;
  if (row.duration === "life-day" && row.lifeDay !== String(lifeDay ?? "")) return false;
  if (row.duration === "current-turn" && !row.sourceMessageIds.includes(String(currentTurnId ?? ""))) return false;
  return true;
}

function kindPriority(kind) {
  return kind === "boundary" || kind === "aversion" ? 4
    : kind === "permission" ? 3
      : kind === "preference" || kind === "convention" ? 2 : 1;
}
function durationPriority(duration) {
  return duration === "current-turn" ? 4 : duration === "until" ? 3 : duration === "life-day" ? 2 : 1;
}
function guideRank(row) {
  return [durationPriority(row.duration), kindPriority(row.kind), row.origin === "explicit" ? 1 : 0, row.scope === "relationship" ? 1 : 0, atMs(row.updatedAt)];
}
function newer(a, b) {
  const ra = guideRank(a); const rb = guideRank(b);
  for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b;
  return a;
}
function winningClaim(previous, candidate) {
  if (!previous) return candidate;
  const previousDeny = previous.claim.effect === "deny";
  const candidateDeny = candidate.claim.effect === "deny";
  if (previousDeny !== candidateDeny) return candidateDeny ? candidate : previous;
  return newer(previous.guide, candidate.guide) === candidate.guide ? candidate : previous;
}

/** 当前上下文里真正有效的机器 claim；覆盖精确到 claim，避免旧 guide 的其他失败 claim 跟着复活。 */
export function effectiveClaimEntries({ userGuides = [], partnerGuides = [], now = new Date(), currentTurnId = "", lifeDay = "", capability = "" } = {}) {
  const rows = normalizeGuides([...userGuides, ...partnerGuides], now)
    .filter((row) => isGuideActive(row, { now, currentTurnId, lifeDay }));
  const chosen = new Map();
  for (const guide of rows) {
    for (const claim of guide.claims) {
      if (capability && claim.target !== capability && !claim.target.startsWith(`${capability}.`) && !capability.startsWith(`${claim.target}.`)) continue;
      const key = `${claim.target}|${claim.subject ?? ""}`;
      chosen.set(key, winningClaim(chosen.get(key), { guide, claim }));
    }
  }
  return rows.flatMap((guide) => guide.claims
    .filter((claim) => chosen.get(`${claim.target}|${claim.subject ?? ""}`)?.guide.id === guide.id
      && chosen.get(`${claim.target}|${claim.subject ?? ""}`)?.claim === claim)
    .map((claim) => ({ guide, claim })));
}

/** 当前上下文里真正有效的 guide；文本层按 guide 展示，代码 claim 只保留决胜项。 */
export function effectiveGuides(options = {}) {
  const now = options.now ?? new Date();
  const rows = normalizeGuides([...(options.userGuides ?? []), ...(options.partnerGuides ?? [])], now)
    .filter((row) => isGuideActive(row, {
      now,
      currentTurnId: options.currentTurnId ?? "",
      lifeDay: options.lifeDay ?? "",
    }));
  const entries = effectiveClaimEntries({ ...options, now });
  const claimsByGuide = new Map();
  for (const { guide, claim } of entries) {
    const list = claimsByGuide.get(guide.id) ?? [];
    list.push(claim);
    claimsByGuide.set(guide.id, list);
  }
  return rows.flatMap((row) => {
    if (!row.claims.length) return [row];
    const claims = claimsByGuide.get(row.id) ?? [];
    return claims.length ? [{ ...row, claims }] : [];
  });
}

export function revokeGuidesBySource(guides, sourceMessageId, now = new Date()) {
  const id = text(sourceMessageId, 120);
  if (!id) return normalizeGuides(guides, now);
  return normalizeGuides(guides, now).map((row) => row.sourceMessageIds.includes(id)
    ? { ...row, status: "revoked", revokedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
    : row);
}

export function buildRelationshipAdaptationBlock({ userGuides = [], partnerGuides = [], habitChanges = [], relationship = null, personality = null, now = new Date(), currentContext = {} } = {}) {
  const guides = effectiveGuides({
    userGuides,
    partnerGuides,
    now,
    currentTurnId: currentContext.currentTurnId,
    lifeDay: currentContext.lifeDay,
  });
  const lines = guides.map((row) => {
    const prefix = row.origin === "observed"
      ? "轻微观察（仍可能看偏）："
      : row.kind === "boundary" || row.kind === "aversion" ? "边界：" : row.kind === "permission" ? "许可：" : "偏好：";
    return `${prefix}${row.meaning}`;
  });
  for (const habit of Array.isArray(habitChanges) ? habitChanges : []) {
    const description = text(habit?.description, 240);
    if (description && ["emerging", "settled"].includes(habit?.state)) lines.push(`相处形成的习惯：${description}`);
  }
  if (!lines.length) return "";
  return [
    "【你们相处出来的理解】",
    "这些是长期相处中形成的认识，不是要求你放弃自己。明确边界要尊重；偏好是靠近方向。按自己的性格回应，许可不代表每次都要做。",
    ...lines.slice(0, 12).map((line) => `- ${line}`),
  ].join("\n");
}

function extractObject(raw) {
  const source = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!source) return null;
  try { return JSON.parse(source); } catch { /* 继续尝试从寒暄中抠对象 */ }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

export function buildGuideReconcileSpec({ message, existingGuides = [], recentExceptions = [], userName = "", partnerName = "" } = {}) {
  const current = normalizeGuides(existingGuides).filter((row) => row.status === "active").map((row) => ({
    id: row.id,
    meaning: row.meaning,
    kind: row.kind,
    scope: row.scope,
    duration: row.duration,
    claims: row.claims,
  }));
  return {
    systemPrompt: [
      "你是茶话会的关系理解器。只判断用户这条消息是否明确表达了偏好、厌恶、许可、边界、约定或短期要求。",
      "只输出一个 JSON 对象，不要解释，不要复述原话，不要把伙伴自己的话当成用户偏好。",
      "operation 只能是 add、update、revoke、temporary、none。拿不准就 none。",
      "如果用户明确喜欢、要求继续、重复要求、讨厌、叫停或纠正最近一次具体破例，可额外输出 feedback：{exceptionId,type,polarity}；沉默或指代不清不要输出。",
      "meaning 是给伙伴看的简短人话；claims 只能使用已知 target/effect/value，未知 claim 不要猜。",
      "sourceMessageId 由系统补入，不要自己编。user-wide 只有用户明确说对所有伙伴、无论和谁都适用时才使用。",
      `当前用户：${String(userName || "用户").slice(0, 40)}；当前伙伴：${String(partnerName || "伙伴").slice(0, 80)}。`,
    ].join("\n"),
    userText: JSON.stringify({
      message: String(message ?? "").slice(0, 1200),
      existingGuides: current,
      recentExceptions: (Array.isArray(recentExceptions) ? recentExceptions : []).slice(-12).map((row) => ({
        id: row.id,
        behavior: row.behavior,
        description: row.description,
        committedAt: row.committedAt,
      })),
    }, null, 2),
  };
}

export function parseGuideReconcileResult(raw, { sourceMessageId = "", currentTurnId = "", lifeDay = "", message = "", now = new Date() } = {}) {
  const object = extractObject(raw);
  if (!object || !["add", "update", "revoke", "temporary", "none"].includes(object.operation)) {
    return { ok: false, reason: "invalid-operation" };
  }
  const feedbackProposal = object.feedback && typeof object.feedback === "object" ? {
    exceptionId: text(object.feedback.exceptionId, 120),
    type: text(object.feedback.type, 60),
    polarity: object.feedback.polarity === "negative" ? "negative" : "positive",
  } : null;
  if (object.operation === "none") return { ok: true, operation: "none", feedbackProposal };
  const sourceId = text(sourceMessageId, 120);
  if (!sourceId) return { ok: false, reason: "missing-source" };
  if (object.operation === "revoke") {
    const guideId = text(object.guideId || object.supersedesId, 120);
    return guideId ? { ok: true, operation: "revoke", guideId, feedbackProposal } : { ok: false, reason: "missing-guide-id" };
  }
  const meaning = text(object.meaning, 240);
  if (!meaning) return { ok: false, reason: "missing-meaning" };
  const universal = /(?:所有伙伴|无论和谁|跟谁都|大家都)/u.test(String(message ?? ""));
  const scope = universal && object.scope === "user-wide" ? "user-wide" : "relationship";
  let duration = object.operation === "temporary"
    ? (GUIDE_DURATIONS.includes(object.duration) && object.duration !== "persistent" ? object.duration : "life-day")
    : (GUIDE_DURATIONS.includes(object.duration) ? object.duration : "persistent");
  let expiresAt = object.expiresAt;
  if (duration === "until" && !iso(expiresAt)) {
    duration = "life-day";
    expiresAt = null;
  }
  const guide = normalizeGuide({
    // ID 由系统按 scope 命名，不能接受模型自填；跨账本回退只靠 ID 时也不会撞 scope。
    id: `guide:${scope}:${sourceId}`.slice(0, 120),
    meaning,
    kind: object.kind,
    scope,
    context: object.context,
    duration,
    lifeDay: duration === "life-day" ? text(lifeDay, 20) : null,
    expiresAt,
    origin: "explicit",
    confidence: 1,
    sourceMessageIds: [duration === "current-turn" ? text(currentTurnId, 120) || sourceId : sourceId],
    evidenceQuote: String(message ?? "").slice(0, 160),
    claims: object.claims,
    supersedesId: text(object.supersedesId, 120) || null,
    createdAt: now,
    updatedAt: now,
  }, now);
  return { ok: true, operation: object.operation, guide, feedbackProposal };
}

export function applyGuideOperation(book, parsed, now = new Date()) {
  const source = book && typeof book === "object" ? book : {};
  const guides = normalizeGuides(source.guides, now);
  if (!parsed?.ok || parsed.operation === "none") return { ...source, guides };
  if (parsed.operation === "revoke") {
    const target = guides.find((row) => row.id === parsed.guideId);
    return {
      ...source,
      guides: guides.map((row) => row.id === parsed.guideId
        ? { ...row, status: "revoked", revokedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
        : row),
      observationLocks: [...new Set([...(source.observationLocks ?? []), ...(target?.claims ?? []).map((claim) => claim.target)])].slice(-64),
    };
  }
  const row = parsed.guide;
  const superseded = row.supersedesId ? guides.find((item) => item.id === row.supersedesId) : null;
  const next = row.supersedesId
    ? guides.map((item) => item.id === row.supersedesId ? { ...item, status: "superseded", updatedAt: row.updatedAt } : item)
    : guides;
  const sameSource = next.findIndex((item) => item.sourceMessageIds.includes(row.sourceMessageIds[0]));
  if (sameSource >= 0) next[sameSource] = row;
  else next.push(row);
  return {
    ...source,
    guides: next.slice(-128),
    observationLocks: [...new Set([...(source.observationLocks ?? []), ...(superseded?.claims ?? []).map((claim) => claim.target)])].slice(-64),
  };
}

const CANDIDATE_TARGETS = Object.freeze([
  "语音", "声音", "睡", "醒", "表情", "图片", "分析", "建议", "安慰", "称呼", "玩笑", "打趣", "回复", "消息", "主动", "分享", "追问", "催", "提醒", "发一点", "少一点", "这样", "刚才", "这次",
]);
const CANDIDATE_MARKERS = Object.freeze([
  "喜欢", "不喜欢", "讨厌", "希望", "想要", "想让", "以后", "今天", "现在", "这会儿", "别", "不要", "不必", "可以", "允许", "请", "多一点", "少一点", "先", "继续", "就这样", "别再",
]);

/**
 * 低成本候选预筛：只回答“要不要交给 reconciler 看一眼”。
 * 它不能直接创建 guide，也不能把一次情绪或伙伴提问当成偏好。
 */
export function observeAdviceStyle(output, expected = "comfort-first") {
  if (expected !== "comfort-first") return { observed: false, reason: "unsupported-style" };
  const text = String(output ?? "").trim();
  if (!text) return { observed: false, reason: "empty" };
  const comfort = /(?:听起来|听着就|难受|委屈|辛苦|心疼|抱抱|我在|陪着你|先缓|先歇|能理解|怪不得你)/u.exec(text);
  const advice = /(?:建议|你可以|你不妨|不如|要不|可以试试|最好|应该|记得|先去|先把|接下来)/u.exec(text);
  if (!comfort || !advice) return { observed: false, reason: "missing-phase" };
  return comfort.index < advice.index
    ? { observed: true, style: "comfort-first", comfortAt: comfort.index, adviceAt: advice.index }
    : { observed: false, reason: "wrong-order", comfortAt: comfort.index, adviceAt: advice.index };
}

export function adaptationCandidate(textValue = "") {
  const text = String(textValue ?? "").trim();
  if (!text || text.length > 1200) return { candidate: false, signals: [] };
  const compact = text.replace(/[，。！？!?…~～\s]+$/gu, "").trim();
  const shortFeedback = compact.length <= 18 && (
    /^(?:停|停下|停一下|停一停|打住|不用了|不用继续了?|别(?:再)?[\p{Script=Han}A-Za-z0-9]{0,6}了)$/u.test(compact)
    || /^(?:再来|继续|接着来|再(?:来|发|说|做|试)?(?:一)?(?:次|遍))$/u.test(compact)
    || /^(?:(?:这|那)?不对|不是这样|不是这个意思|你?理解错了|搞错了|搞反了|改一下)$/u.test(compact)
  );
  if (shortFeedback) return { candidate: true, signals: ["recent-exception", "feedback"] };
  const hasTarget = CANDIDATE_TARGETS.some((word) => text.includes(word));
  const markerHits = CANDIDATE_MARKERS.filter((word) => text.includes(word));
  if (!hasTarget || !markerHits.length) return { candidate: false, signals: [] };
  if (/^(?:你觉得|你怎么看|你喜欢什么|你会不会|你最近怎么样)/u.test(text) && !/(?:以后|别|不要|希望|喜欢|可以|允许)/u.test(text)) {
    return { candidate: false, signals: [] };
  }
  const firstPerson = /(?:我|咱们|我们|跟我|对我)/u.test(text);
  const directive = /(?:别|不要|不必|请|可以|允许|以后|先|继续|就这样)/u.test(text);
  if (!firstPerson && !directive) return { candidate: false, signals: [] };
  const signals = [...new Set([
    ...(firstPerson ? ["first-person"] : []),
    ...(directive ? ["directive"] : []),
    ...(markerHits.some((word) => ["今天", "现在", "这会儿"].includes(word)) ? ["temporary-hint"] : []),
    ...(markerHits.some((word) => ["喜欢", "希望", "想要", "想让", "多一点", "少一点"].includes(word)) ? ["preference-hint"] : []),
    ...(markerHits.some((word) => ["别", "不要", "不必", "允许", "可以"].includes(word)) ? ["boundary-or-permission-hint"] : []),
  ])];
  return { candidate: true, signals };
}

export function guideClaimRegistry() {
  return Object.keys(CLAIMS).map((target) => ({ target, effect: [...CLAIMS[target].effect], value: [...CLAIMS[target].value] }));
}
