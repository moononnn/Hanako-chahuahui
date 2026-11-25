import { dayKey } from "./days.js";

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

/**
 * 原文证据（2026-11-25）：一条理解要落成长久的，得有原文里看得见的长期证据。
 *
 * 四件事在这里分开：
 * ① 日常状态、行程、一次性事件 —— 不学（模型说“只是临时的”也不放行）；
 * ② 本轮/当天/截至日期这类明确边界 —— 当下生效，但不泛化成长久，短期边界优先；
 * ③ 「从今天起…」这种明确起步的长久说法 —— 照长久算；
 * ④ 明确的长期偏好/许可/边界/约定 —— 说一次也收，但长信号得和相处行为同句。
 *
 * 判定只看原文与这句 meaning；指示词单独出现不算数，
 * 得真有“怎么跟 ta 相处”的落点。
 */
const MOMENTARY_TIME = /(?:今天|今晚|明天|明早|后天|昨天|昨晚|刚才|刚刚|现在|这会儿|待会儿|等会儿|马上|这次|这轮|这一轮|这周|本周|下周|上个?周末|这几天|最近|眼下)/u;
/** 怎么跟 ta 相处的落点：一条相处理解至少得管到其中一样。 */
const INTERACTION = /(?:(?<![特区分级个类性])别(?!人|处|的|提)|不要|不用|不必|不许|禁止|可以|允许|同意|随时|请|哄|提醒|叫我|喊我|跟我说|跟我讲|跟我聊|发给我|问我|催我|夸我|逗我|安慰|分析|建议|称呼|开玩笑|发表情|发语音|发消息|发信息|打电话|回我|理我|找我|陪我(?!去|到|上|看|吃|办|跑|排|买)|分享|报备|追问|查岗)/u;
/** 忌口、体质这类话本身就管着“别给我吃什么”，也算相处落点。 */
const INHERENT_FACT = /(?:过敏|忌口|不能吃|不能喝|吃不了|喝不了|吃素|素食|乳糖不耐)/u;
/** 明确了“我”的偏好：喜欢/讨厌/不吃喝——这是“明确长久的偏好”那种说法。 */
const PREFERENCE_VERB = /我(?:很|更|最)?(?:喜欢|希望|想要|讨厌|受不了|不吃|不喝)/u;
/** “说好了…”“咱们的规矩…”——约定本身就是相处落点。 */
const CONVENTION = /(?:说好了?|约好了?|约定|规矩)/u;
/** 日常状态：我今天好累、有点不舒服。 */
const DAILY_STATE = /我[^，。！？!?]{0,8}(?:累|困|饿|难受|不舒服|感冒|发烧|头疼|心情不好|烦|emo|生理期|想睡|想休息|撑不住)/u;
/** 行程与一次性事件：今天要去、明天去医院、这周末去爬山、今天晚上吃面条。 */
const DAILY_PLAN = /(?:今天|今晚|明天|明早|后天|昨天|昨晚|周末|这周|下周|等会儿|待会儿|马上|下午|晚上|早上|上午|中午|刚才|刚刚)[^，。！？!?]{0,10}(?:要|得|准备|打算|去|来|回|吃|喝|上班|加班|开会|出差|体检|看病|考试|聚会|吃饭|睡觉|出门|见|办)/u;
/** 「别…了」这种叫停通常是眼下一下。 */
const STOP_NOW = /(?:别|不要|不用|不必)[^，。！？!?]{0,10}了[。！？!?…~～]*$/u;
/** 明确说长久：必须和相处行为同句才算数。 */
const DURABLE_STRONG = /(?:以后|今后|往后|从此|再也|永远|一直|总是|每次|每回|平时|平常|长期|向来|一向|从来|习惯|一律|都别|都说|记住|说好了?|约好了?|约定|规矩)/u;
/** 「从今天起/今天开始…」是明确的长久起步，优先于同句里的“今天”。 */
const START_OF_LONG = /(?:从今天起|从今天开始|今天开始|从今以后|从今往后|往后都|以后都)/u;
/** 话本身就在讲一件长久的事：忌口、体质、明确偏好。 */
const DURABLE_CONTENT = /(?:过敏|忌口|不能吃|不能喝|吃不了|喝不了|吃素|素食|乳糖不耐|不吃|不喝|受不了|我喜欢|我更喜欢|我最喜欢|我不喜欢|我讨厌|我希望|我想要|我更想)/u;
/** 「…的时候/如果…就先/别…」是条件式相处约定，对事不对时。 */
const CONDITIONAL_RULE = /(?:的?时候|时|如果|要是|万一)[^。！？!?]{0,20}(?:先|再|就|别|不要|可以|请|陪|哄|提醒|叫)/u;
/** 「半夜/睡前/上班时间…别…」是固定在某个时段上的规矩。 */
const TIME_WINDOW_RULE = /(?:早上|上午|中午|下午|晚上|半夜|深夜|夜里|睡前|起床|工作日|上班|下班|周末)[^。！？!?]{0,14}(?:别|不要|不用|可以|允许|少|多|发|说|找|叫|提醒)/u;
const PERMISSION_RULE = /(?:可以|允许|同意|随时)[^。！？!?]{0,12}(?:发|说|问|找|用|叫|提)/u;

/** 把一句话拆成内容词块：中文两字一组，英文数字整词，标点当分隔。 */
function contentTokens(value) {
  const source = String(value ?? "").replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, " ").trim();
  const out = new Set();
  for (const chunk of source.split(/\s+/u).filter(Boolean)) {
    if (/^[A-Za-z0-9]{2,}$/u.test(chunk)) { out.add(chunk.toLowerCase()); continue; }
    const chars = [...chunk];
    for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

/** meaning 得真的从这句原文里长出来：短句一个实词就够，长一点的至少两个。 */
export function guideGroundedIn(message, meaning) {
  const said = contentTokens(message);
  const gist = contentTokens(meaning);
  if (!said.size || !gist.size) return false;
  let hits = 0;
  for (const token of gist) if (said.has(token)) hits += 1;
  return hits >= ([...String(meaning ?? "").trim()].length <= 8 ? 1 : 2);
}

/** 按标点拆句：「今天太累了，以后十点后别发消息」两句得分开评。 */
function clausesOf(said) {
  return String(said ?? "").split(/[，。；！？!?；\n]+/u).map((row) => row.trim()).filter(Boolean);
}

/**
 * 「这次别说以后」「以后再说」里的“以后”不是在立长久的规矩，不能拿来当证据。
 */
function stripDeferredLong(said) {
  return String(said ?? "")
    .replace(/(?:别|不要|不用|不必|先别|先不要|先不用|先不提|先不说|先别想)以后/gu, "")
    .replace(/以后(?:再说|再讲|再看|再聊|再议|再提)/gu, "");
}

/** 原文里写明的临时边界：这就是“当下生效、不泛化”的那个范围。 */
function boundaryDuration(said) {
  if (/(?:这(?:一)?轮|这(?:一)?次|这(?:一)?回)/u.test(said)) return "current-turn";
  if (/(?:今天|今晚)/u.test(said)) return "life-day";
  if (/(?:截至|到.{0,8}(?:为止|之前)|明天之前|今晚之前)/u.test(said)) return "until";
  return "";
}

/**
 * 这条理解能不能按它说的那个有效期落账。
 *
 * 落账之前都得过同一道门：原文里得有“怎么跟 ta 相处”的落点。
 * 过了之后，短期边界（今天/这一轮/到某天为止）优先于长期说法；
 * 「从今天起…」是唯一的例外——它本来就明说了要长久。
 */
export function guideEvidenceVerdict({ message = "", meaning = "", duration = "persistent", kind = "", temporary = false } = {}) {
  const said = String(message ?? "").trim();
  const gist = String(meaning ?? "").trim();
  if (!said || !gist) return { ok: false, reason: "no-evidence" };
  if (!guideGroundedIn(said, gist)) return { ok: false, reason: "not-in-message" };
  const clauses = clausesOf(said);
  const dailyLog = DAILY_STATE.test(said) || DAILY_PLAN.test(said);
  const directiveAnchor = clauses.some((clause) => INTERACTION.test(clause));
  // 落点三类：对着 ta 的要求、忌口体质这类长久事实、明确的偏好与约定。
  // 但后两类碰上今天/明天的状态行程就不算——那是日常流水，不是理解。
  const anchored = directiveAnchor
    || clauses.some((clause) => INHERENT_FACT.test(clause))
    || (!dailyLog && (PREFERENCE_VERB.test(said) || CONVENTION.test(said)));
  if (!anchored) {
    return { ok: false, reason: dailyLog ? "daily-log" : "not-interaction" };
  }
  if (kind === "temporary-state" && duration === "persistent") return { ok: false, reason: "temporary-kind-not-persistent" };
  // 当场叫停（别…了）不是可留存的理解：既不是长久边界，也不该存成一整天的规矩。
  const deferredLong = stripDeferredLong(said);
  if (STOP_NOW.test(said) && !boundaryDuration(said) && !START_OF_LONG.test(deferredLong) && !DURABLE_STRONG.test(deferredLong)) {
    return { ok: false, reason: "stop-now" };
  }
  // “刚才那样我喜欢”是对上一轮的反馈，不是长久偏好：别把一次性行为固定下来。
  const aboutLastTurn = /(?:刚才|刚刚|上次|那次|上一条|这一?条)/u.test(said);
  if (aboutLastTurn && !boundaryDuration(said) && !START_OF_LONG.test(deferredLong) && !DURABLE_STRONG.test(deferredLong)) {
    return { ok: false, reason: "recent-feedback" };
  }
  // 模型自己说了只算这次/今天/到某天为止：照它说的当下生效，但不往长久推。
  if (temporary || duration !== "persistent") {
    return { ok: true, duration: duration === "persistent" ? "life-day" : duration };
  }
  // ① 明确的长久起步（从今天起…）：优先于同句里的“今天”。
  const startsLong = START_OF_LONG.test(deferredLong) && anchored;
  if (startsLong) return { ok: true, duration: "persistent" };
  // ② 短期边界优先：今天/这一轮/到某天为止，当下生效、不泛化。
  const shortClause = clauses.find((clause) => boundaryDuration(clause) && (INTERACTION.test(clause) || INHERENT_FACT.test(clause)));
  if (shortClause) return { ok: true, duration: boundaryDuration(shortClause), narrowed: true };
  // ③ 长期说法（或两人说好的约定）得和相处行为在同一句里，不能凭一个指示词单独通过。
  const longClause = clauses.some((clause) => (DURABLE_STRONG.test(stripDeferredLong(clause)) || CONVENTION.test(clause))
    && (INTERACTION.test(clause) || INHERENT_FACT.test(clause) || CONVENTION.test(clause)));
  if (longClause) return { ok: true, duration: "persistent" };
  // ④ 话本身就是长久的事：明确偏好、忌口、条件式约定、固定时段、许可。
  const lasting = DURABLE_CONTENT.test(said) || CONDITIONAL_RULE.test(said)
    || TIME_WINDOW_RULE.test(said) || PERMISSION_RULE.test(said);
  if (lasting) return { ok: true, duration: "persistent" };
  if (dailyLog) return { ok: false, reason: "daily-log" };
  return { ok: false, reason: STOP_NOW.test(said) ? "stop-now" : "no-durable-evidence" };
}

/**
 * 旧记录的只读复核标记（2026-11-25）。
 *
 * 只标一种：原文证据里明明写着今天/这次/叫停，却被记成了长久。
 * 不因为原文没写“以后”就怀疑长久边界——那种多半本来就是长久的。
 * 标了也不自动停用，要不要改由她逐条点。
 */
export function guideReviewReason(guide) {
  const row = guide && typeof guide === "object" ? guide : {};
  if (row.status && row.status !== "active") return "";
  const duration = GUIDE_DURATIONS.includes(row.duration) ? row.duration : "persistent";
  if (duration !== "persistent") return "";
  const quote = String(row.evidenceQuote ?? "");
  if (!quote || DURABLE_STRONG.test(stripDeferredLong(quote))) return "";
  return MOMENTARY_TIME.test(quote) || STOP_NOW.test(quote) ? "temporary-evidence" : "";
}
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

/**
 * 已经确定过期的临时理解（2026-11-25）。
 *
 * 只认三类带得住、说得清的过期证据：
 * - until：写了 expiresAt，而且真过了那个时刻；
 * - life-day：它记着自己属于哪一天，而那天已经过了；
 * - current-turn：落地那天已经过去——回合肯定结束了。（落地当天的不动：
 *   当下是不是还在这一轮，从账本上看不出来，宁可不删。）
 *
 * 长期的一律不碰（包括带「建议复核」标记的）；撤回、被取代属于历史，也留着。
 * 字段缺失、写法认不得、时间解不开：一律当作“还不能确定”，不删。
 */
export function expiredTemporaryGuideReason(guide, { now = new Date(), lifeDay = "" } = {}) {
  const row = guide && typeof guide === "object" ? guide : {};
  const duration = GUIDE_DURATIONS.includes(row.duration) ? row.duration : "persistent";
  if (duration === "persistent") return "";
  // 只清还生效、或已被归一成 expired 的；撤回/被取代的是历史。
  if (row.status && !["active", "expired"].includes(row.status)) return "";
  const today = text(lifeDay, 20) || dayKey(now) || "";
  if (duration === "until") {
    const at = Date.parse(String(row.expiresAt ?? ""));
    if (!Number.isFinite(at)) return "";
    return at <= new Date(now).getTime() ? "until-passed" : "";
  }
  if (duration === "life-day") {
    const day = text(row.lifeDay, 20);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !today) return "";
    const parsed = new Date(`${day}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return "";
    return day < today ? "life-day-passed" : "";
  }
  // current-turn：只看“落地那天已经过去”这一条硬证据，不拿空 currentTurnId 去推。
  const created = Date.parse(String(row.createdAt ?? ""));
  if (!Number.isFinite(created) || !today) return "";
  const createdDay = dayKey(new Date(created));
  return createdDay && createdDay < today ? "turn-ended" : "";
}

/**
 * 把一本账里已经过期的临时理解清掉（纯函数，不碰文件）。
 *
 * 只动 guides；exceptions / feedbackEvents / habitChanges 一条不删——
 * 它们记录的“发生过什么”不会因为一条理解过期就不存在。
 * 引用被清掉那条的 exception / habit 只做个标记，跟撤回那条路一致。
 */
export function pruneExpiredTemporaryGuides(book, { now = new Date(), lifeDay = "" } = {}) {
  const source = book && typeof book === "object" ? book : {};
  const guides = Array.isArray(source.guides) ? source.guides : [];
  const removed = [];
  const kept = [];
  for (const guide of guides) {
    const reason = expiredTemporaryGuideReason(guide, { now, lifeDay });
    if (reason) removed.push({ id: String(guide?.id ?? ""), reason });
    else kept.push(guide);
  }
  if (!removed.length) return { book: source, removed: [] };
  const ids = new Set(removed.map((row) => row.id).filter(Boolean));
  const at = new Date(now).toISOString();
  const referenced = (row) => Array.isArray(row?.guideIds) && row.guideIds.some((id) => ids.has(id));
  return {
    book: {
      ...source,
      guides: kept,
      exceptions: (Array.isArray(source.exceptions) ? source.exceptions : []).map((row) =>
        referenced(row) && row.sourceGuideRevoked !== true ? { ...row, sourceGuideRevoked: true } : row),
      habitChanges: (Array.isArray(source.habitChanges) ? source.habitChanges : []).map((row) =>
        referenced(row) && row.state !== "reverted" ? { ...row, state: "reverted", updatedAt: at } : row),
    },
    removed,
  };
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
      "日常状态、行程、一次性事件（今天累了、明天去医院、这周末去爬山）不要报；那些不是相处理解。",
      "原文只给了今天/这一轮/到某天为止的边界时，operation 用 temporary 并写对 duration（life-day / current-turn / until），不要报成长久。",
      "没有长期证据就不要写 duration=persistent：只有她明说了以后/每次/一直/习惯/约定，或是忌口、过敏这类长久事实，才算长期。",
      "meaning 必须能在这条原文里找到对应，不要补原文里没有的意思。",
      "只输出一个 JSON 对象，不要解释，不要复述原话，不要把伙伴自己的话当成用户偏好。",
      "operation 只能是 add、update、revoke、temporary、none。拿不准就 none。",
      "如果用户明确喜欢、要求继续、重复要求、讨厌、叫停或纠正最近一次具体破例，可额外输出 feedback：{exceptionId,type,polarity}；沉默或指代不清不要输出。",
      "meaning 是给伙伴看的简短人话；claims 只能使用已知 target/effect/value，未知 claim 不要猜。",
      "私有梗图的新旧版本、用户嫌旧图丑或催伙伴换图属于审美分歧；可在 meaning 留下用户的态度供伙伴自己考虑，不要生成 sticker.permission 禁发 claim 或负面破例反馈。伙伴可坚持旧版、接受新版或要求再画；真正撤回素材权限、取消收藏与明确禁止全部表情的要求仍按资源/许可处理。",
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
  // 更新被本地证据筛掉时，这轮明确说出的破例反馈不能跟着丢：
  // 以 operation=none 返回，让调用方照常落 feedback。
  const vetoed = (reason) => (feedbackProposal
    ? { ok: true, operation: "none", feedbackProposal, filtered: { operation: object.operation, reason } }
    : { ok: false, reason });
  const sourceId = text(sourceMessageId, 120);
  if (!sourceId) return { ok: false, reason: "missing-source" };
  if (object.operation === "revoke") {
    const guideId = text(object.guideId || object.supersedesId, 120);
    return guideId ? { ok: true, operation: "revoke", guideId, feedbackProposal } : vetoed("missing-guide-id");
  }
  const meaning = text(object.meaning, 240);
  if (!meaning) return vetoed("missing-meaning");
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
  // 原文证据（2026-11-25）：没长期证据不许落成 persistent；日常状态/行程不学；
  // 原文只给了当天/本轮/到某天为止，就按那个边界当下生效、不泛化。
  const verdict = guideEvidenceVerdict({
    message,
    meaning,
    duration,
    kind: object.kind,
    temporary: object.operation === "temporary",
  });
  if (!verdict.ok) return vetoed(verdict.reason);
  duration = verdict.duration;
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
