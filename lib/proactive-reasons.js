/**
 * 关系式由头：长期兴趣之外，给「没什么事也想找她」留几条路。
 *
 * 这里只做选择，不碰发送：频率、间隔、日上限、静默、未回复护栏都在 index 那边原样留着。
 *
 * 口径：
 *   · 由头就五种。interest 之外的都不带兴趣钩子，也不占用种子和探索——
 *     它们是「ta 自己想找她」，跟她在玩什么没关系。
 *   · 熟悉度顶「无主题搭话」；想念要熟悉度和亲密度一起顶。陌生时这两条都起不来。
 *   · 共同经历和吐槽只认真凭据（同一位伙伴最近一轮真聊过的，或电脑那边确有动静），
 *     刚认识一起做过事照样能回味，所以不设熟悉门槛。
 *   · 性格只调占比：会贫嘴的抬一点，性子憋着的压一点，但没有哪个标签能把一整条路关掉。
 *
 * 纯计算：关系两轨 + 已配置的性格字段 + 可注入的随机数，不调模型。
 */

/** 由头就这五种。 */
export const REASON_KINDS = Object.freeze(["interest", "shared", "tease", "contact", "affection"]);

export const REASON_LABELS = Object.freeze({
  interest: "长期兴趣",
  shared: "共同经历",
  tease: "吐槽",
  contact: "无主题搭话",
  affection: "想念",
});

/** 这两种没凭据就不算由头。 */
export const CONTEXT_REQUIRED_KINDS = Object.freeze(["shared", "tease"]);
// 只谈关系本身的由头（2026-10-18）：搭话和想念本来就没有另一件必须聊的事，
// 电脑那边一整段开发对话铺在眼前，模型手上有了更具体的东西，写出来就是一排开发题。
// 这两类不接工作台账；共同经历和吐槽的凭据正取自那段，照旧给。
export const RELATION_ONLY_KINDS = Object.freeze(["contact", "affection"]);

/** 饱和常数，跟 relationship.js 同一把尺。 */
const FAMILIARITY_TURNS_FULL = 24;
const FAMILIARITY_DAYS_FULL = 12;
const INTIMACY_FULL = 24;

/** 搭话和想念各自的门槛：过了才有资格进候选。 */
export const FAMILIARITY_FLOOR = 0.18;
export const AFFECTION_FLOOR = 0.34;

export const CONTEXT_MAX_CHARS = 600;
/** 「已经说过的话」是防重复用的，不是内容来源，单独封顶。 */
const SENT_CONTEXT_MAX_CHARS = 400;

/** 已实际送出的正文：最多这么多条、总共这么长。 */
export const INTRODUCED_LIMIT = 12;
export const INTRODUCED_MAX_CHARS = 1800;

const OUTGOING_TAGS = Object.freeze(["热情", "活泼", "外向"]);
const RESERVED_TAGS = Object.freeze(["安静", "有分寸", "敏感", "克制", "慢热"]);
const TEASE_TAGS = Object.freeze(["俏皮", "爱损", "毒舌", "跳脱", "爱逗", "贫"]);

const clamp01 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const round3 = (value) => Math.round(clamp01(value) * 1000) / 1000;

/** 权重是相对值，可以大于 1，round 就行，不再 clamp。 */
const roundWeight = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
};

function saturate(value, full) {
  const v = Math.max(0, Number(value) || 0);
  if (v <= 0) return 0;
  return 1 - Math.exp(-v / full);
}

/** 关系账那两条轨折成 0~1：熟悉度看回合数与跨过的日子，亲密度看分值。不另立好感分。 */
export function relationBasis(relationship) {
  const fam = relationship?.familiarity ?? {};
  const inti = relationship?.intimacy ?? {};
  const familiarity = 0.6 * saturate(fam.turns, FAMILIARITY_TURNS_FULL)
    + 0.4 * saturate(fam.activeDays, FAMILIARITY_DAYS_FULL);
  return { familiarity: round3(familiarity), intimacy: round3(saturate(inti.score, INTIMACY_FULL)) };
}

export function personalityTags(personality) {
  const value = personality && typeof personality === "object" ? personality : {};
  const surface = Array.isArray(value.surface?.tags) ? value.surface.tags : [];
  const inner = Array.isArray(value.inner?.tags) ? value.inner.tags : [];
  return [...surface, ...inner].map((tag) => String(tag).trim()).filter(Boolean);
}

/**
 * 性格怎么调占比。混合标签是叠加的，不是二选一：
 * 会贫嘴的抬一点，性子憋着的压一点，两样都有时以「会贫嘴」为主、压得轻一些，
 * 这样「安静但嘴上不饶人」不会被一刀切成不会贫嘴。
 * 搭话与想念各有一个系数，且不一样：憋着的人搭话少，但想念只是憋着，不是不想。
 */
export function reasonPersonality(personality) {
  const tags = personalityTags(personality);
  const has = (list) => tags.some((tag) => list.includes(tag));
  const outgoing = has(OUTGOING_TAGS);
  const reserved = has(RESERVED_TAGS);
  const teasing = has(TEASE_TAGS);
  if (!tags.length) return { temperament: "neutral", contactFactor: 1, affectionFactor: 1, teaseFactor: 1, tags };
  const teasingOrOutgoing = teasing || outgoing;
  return {
    temperament: teasingOrOutgoing ? "outgoing" : reserved ? "reserved" : "neutral",
    contactFactor: teasingOrOutgoing ? (reserved ? 1.05 : 1.15) : (reserved ? 0.7 : 1),
    affectionFactor: teasingOrOutgoing ? (reserved ? 1.1 : 1.2) : (reserved ? 0.85 : 1),
    teaseFactor: teasing ? (reserved ? 1 : 1.35) : (reserved ? 0.5 : outgoing ? 1.2 : 1),
    tags,
  };
}

/**
 * 收一条由头。认不出来的 kind、缺凭据的共同经历和吐槽，一律当没有。
 *
 * @param {object} raw
 * @param {boolean} [options.requireContext] 传进来时还没拼凭据（调度那一步只有「有没有」这个判断）置 false
 * @returns {{kind: string, contextText: string, familiarity?: number, intimacy?: number}|null}
 */
export function normalizeReason(raw, { requireContext = true } = {}) {
  const source = raw && typeof raw === "object" ? raw : null;
  const kind = String(source?.kind ?? "").trim();
  if (!REASON_KINDS.includes(kind)) return null;
  const contextText = String(source?.contextText ?? "").trim().slice(0, CONTEXT_MAX_CHARS);
  if (requireContext && CONTEXT_REQUIRED_KINDS.includes(kind) && !contextText) return null;
  const reason = { kind, contextText };
  if (Number.isFinite(Number(source?.familiarity))) reason.familiarity = round3(source.familiarity);
  if (Number.isFinite(Number(source?.intimacy))) reason.intimacy = round3(source.intimacy);
  return reason;
}

/**
 * 候选与相对权重（不是概率，抽签那一步再归一）。
 * interestAvailable 是调度那侧给的：只有过了锚点门的兴趣素材才算数。
 */
export function reasonWeights({ relationship = null, personality = null, interestAvailable = false, hasContext = false } = {}) {
  const { familiarity, intimacy } = relationBasis(relationship);
  const self = reasonPersonality(personality);
  const rows = [];

  if (interestAvailable) rows.push({ kind: "interest", weight: 1 });

  // 搭话：只认熟悉度。熟了但还不亲的时候，这一路顶事。
  if (familiarity > FAMILIARITY_FLOOR) {
    rows.push({
      kind: "contact",
      weight: ((familiarity - FAMILIARITY_FLOOR) / (1 - FAMILIARITY_FLOOR)) * 1.1 * self.contactFactor,
    });
  }

  // 想念：熟悉度和亲密度一起顶，两道门槛都得过。
  if (familiarity > FAMILIARITY_FLOOR && intimacy > AFFECTION_FLOOR) {
    const blend = 0.45 * familiarity + 0.55 * intimacy;
    const ramp = (blend - AFFECTION_FLOOR) / (1 - AFFECTION_FLOOR);
    if (ramp > 0) rows.push({ kind: "affection", weight: ramp * 1.25 * self.affectionFactor });
  }

  // 共同经历：只认真凭据。刚认识一起做过事也能回味，所以不拿熟悉度卡它。
  if (hasContext) rows.push({ kind: "shared", weight: 0.45 + 0.45 * familiarity });

  // 吐槽：同样要凭据，性格只调分量（见 reasonPersonality），不归零。
  if (hasContext) rows.push({ kind: "tease", weight: (0.25 + 0.7 * familiarity) * 0.7 * self.teaseFactor });

  return rows.map((row) => ({ kind: row.kind, weight: roundWeight(row.weight) })).filter((row) => row.weight > 0);
}

/**
 * 这一趟挑哪条由头。抽签函数可注入，测试里能指定落点。
 * @returns {{reason: object|null, candidates: {kind: string, weight: number}[], basis: {familiarity: number, intimacy: number}, temperament: string}}
 */
export function pickReason({
  relationship = null,
  personality = null,
  interestAvailable = false,
  hasContext = false,
  contextText = "",
  rnd = Math.random,
} = {}) {
  const basis = relationBasis(relationship);
  const self = reasonPersonality(personality);
  const candidates = reasonWeights({ relationship, personality, interestAvailable, hasContext });
  if (!candidates.length) return { reason: null, candidates, basis, temperament: self.temperament };
  const total = candidates.reduce((sum, row) => sum + row.weight, 0);
  let point = clamp01(Number(rnd())) * total;
  let chosen = candidates[candidates.length - 1];
  for (const row of candidates) {
    point -= row.weight;
    if (point < 0) {
      chosen = row;
      break;
    }
  }
  const reason = normalizeReason(
    { kind: chosen.kind, contextText, familiarity: basis.familiarity, intimacy: basis.intimacy },
    { requireContext: false },
  );
  return { reason, candidates, basis, temperament: self.temperament };
}

/**
 * 真凭据只看两样：这一段对话里真聊过的，和电脑那边这位伙伴确有过的动静。
 * 「已经说过的话」只用来去重，不算凭据——拿旧消息冒充共同经历是穿帮。
 */
function sceneContext(sceneEcho = null) {
  const userText = String(sceneEcho?.userText ?? "").trim();
  const assistantText = String(sceneEcho?.assistantText ?? "").trim();
  if (!userText && !assistantText) return "";
  return [
    "【最近一轮真聊过的（就发生在这条对话里）】",
    userText ? `她说过：${userText}` : "",
    assistantText ? `你回过：${assistantText}` : "",
  ].filter(Boolean).join("\n");
}

function workfeedContext(workfeedText = "") {
  const feed = String(workfeedText ?? "").trim();
  return feed ? `【电脑那边这位伙伴确实有过的动静（按上面写的时间，别补成刚刚亲历）】\n${feed}` : "";
}

/**
 * 真凭据只看两样：这一段对话里真聊过的，和电脑那边这位伙伴确有过的动静。
 * 「已经说过的话」只用来去重，不算凭据——拿旧消息冒充共同经历是穿帮。
 */
export function substantiveContext({ sceneEcho = null, workfeedText = "" } = {}) {
  return [sceneContext(sceneEcho), workfeedContext(workfeedText)].filter(Boolean).join("\n\n");
}

/** 凭据整块（含去重段）的成文形式。 */
export function buildReasonContext({ sceneEcho = null, workfeedText = "", sentTexts = [] } = {}) {
  const parts = [sceneContext(sceneEcho), workfeedContext(workfeedText)];
  const said = (Array.isArray(sentTexts) ? sentTexts : [])
    .map((row) => String(row ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, SENT_CONTEXT_MAX_CHARS);
  if (said) parts.push(`【你已经实际说过的话（这次别重复，也别当新发现讲一遍）】\n${said}`);
  return parts.filter(Boolean).join("\n\n").slice(0, CONTEXT_MAX_CHARS);
}

/**
 * 补齐由头要带的凭据：调度那一步只判断「有没有」，内容到出站才拼得全。
 * 共同经历和吐槽到这一步仍拿不出实质来源就作废——宁可这轮退回原来的走法。
 *
 * @returns {{reason: object|null, dropped: boolean}}
 */
export function enrichReasonContext(reason, sources = {}) {
  const normalized = normalizeReason(reason, { requireContext: false });
  if (!normalized) return { reason: null, dropped: Boolean(reason) };
  // 掐工作台账必须掐在这儿：出站那一步的凭据正文会原样写进提示词，
  // 只在拼装时清空「电脑那边」那一段，话照样从由头这块绕进去。
  const scoped = RELATION_ONLY_KINDS.includes(normalized.kind) ? { ...sources, workfeedText: "" } : sources;
  const contextText = buildReasonContext(scoped);
  if (!CONTEXT_REQUIRED_KINDS.includes(normalized.kind)) return { reason: { ...normalized, contextText }, dropped: false };
  if (!substantiveContext(sources).trim()) return { reason: null, dropped: true };
  return { reason: { ...normalized, contextText }, dropped: false };
}

/**
 * 「已经介绍过什么」：只认这位伙伴实际送出过的正文（普通回复和主动消息都算），
 * 后台的种子和探索不算，那只是备料。逐条完整带上；单条就超预算就跳过，不硬塞。
 *
 * @param {Array} messages
 * @returns {string}
 */
export function introducedTextFrom(messages, { limit = INTRODUCED_LIMIT, budget = INTRODUCED_MAX_CHARS } = {}) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((row) => row && row.role === "assistant" && !row.recalled
      && row.kind !== "action" && row.kind !== "poke" && row.kind !== "tavern-opening")
    .map((row) => String(row.text ?? "").trim())
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 1));
  const total = Math.max(1, Number(budget) || INTRODUCED_MAX_CHARS);
  const kept = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const cost = row.length + (kept.length ? 1 : 0); // 换行计入总长
    if (used + cost > total) continue;
    kept.unshift(row);
    used += cost;
  }
  return kept.join("\n");
}