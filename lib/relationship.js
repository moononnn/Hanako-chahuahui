/**
 * 关系账本：熟悉度 + 亲密度双轨。
 *
 * 熟悉度记相处事实（聊了多少回合、跨了几个日子），只增不减，骗不了；
 * 亲密度记有依据的关系信号（认可、分享、想念、玩闹、问她、道歉），带每日上限。
 * 两轨一起决定关系到哪一步，再决定放开多少ta更私下的一面。
 *
 * 这一层的账只留在应用内部，给模型看的永远是自然语言，不是分数。
 * 纯逻辑：不碰文件、不碰模型、不读时间以外的任何东西，方便测。
 */

import { dayKey } from "./days.js";

export const RELATIONSHIP_SCHEMA_VERSION = 1;

/** 亲密度封顶 */
const SCORE_MAX = 100;
/** 一天最多涨这么多：单日猛聊刷不上去 */
const MAX_DAILY_INTIMACY = 4;
/** 事件最多留这么多条，老的丢掉 */
const MAX_EVENTS = 32;

/**
 * 认得出「这话有分量」的几类信号。
 * 日常陪伴收轻分，明确亲近收重分；宁可漏，不要错：认错了关系会虚高。
 */
const SIGNAL_RULES = Object.freeze([
  Object.freeze({
    type: "appreciation",
    delta: 2,
    reason: "她道了谢或认了这份心意",
    patterns: [/谢谢/u, /感谢/u, /辛苦(?:你了|你|啦|了)?/u, /你真好/u, /喜欢你/u, /爱你/u, /夸(?:我|你)?/u, /你真厉害/u, /厉害得很/u],
  }),
  Object.freeze({
    type: "self-disclosure",
    delta: 2,
    reason: "她说起了自己的事或心情",
    patterns: [
      /跟你(?:说|聊|讲|分享)/u,
      /告诉你/u,
      /我(?:最近|有点|今天|这两天|昨天|好累|难过|开心|害怕|担心|想吃|想睡)/u,
      /今天(?:吃|去了|在|看到|发现|遇到|做了)/u,
      /我(?:家|刚刚|刚才|正在|准备|已经)/u,
    ],
  }),
  Object.freeze({
    type: "curiosity",
    delta: 2,
    reason: "她主动问了你的想法或状态",
    patterns: [/你(?:觉得|怎么看|喜欢什么|在想什么|最近怎么样|会不会|想不想|在干嘛)/u, /对你来说/u],
  }),
  Object.freeze({
    type: "repair",
    delta: 3,
    reason: "她表示了理解、歉意或修复",
    patterns: [/对不起/u, /抱歉/u, /我理解了/u, /你说得对/u, /我会注意/u, /我不是那个意思/u],
  }),
  Object.freeze({
    type: "affection",
    delta: 2,
    reason: "她用想念、拥抱或熟人玩闹靠近你",
    patterns: [/想你/u, /想我/u, /想念/u, /抱抱/u, /亲亲/u, /晚安/u, /早安/u, /谁跟谁/u, /我们家/u, /撒娇/u, /卖萌/u, /求夸奖/u, /夸夸/u],
  }),
  Object.freeze({
    type: "daily-sharing",
    delta: 1,
    reason: "她把日常小事带来和你一起过",
    patterns: [/今天[^。！？\n]{0,20}(?:吃|去了|看到|发现|遇到|做了)/u, /刚刚[^。！？\n]{0,20}(?:想到|看到|遇到)/u, /哈哈哈/u],
  }),
]);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value, fallback = 0) {
  return Math.max(0, Math.floor(num(value, fallback)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeDaily(raw, fallbackDay = null) {
  const source = raw && typeof raw === "object" ? raw : {};
  const day = typeof source.day === "string" && source.day ? source.day : fallbackDay;
  const types = Array.isArray(source.types)
    ? [...new Set(source.types.filter((item) => typeof item === "string" && item))]
    : [];
  return {
    day,
    score: clamp(num(source.score, 0), 0, MAX_DAILY_INTIMACY),
    types: types.slice(0, SIGNAL_RULES.length),
  };
}

export function createRelationship(now = new Date()) {
  const at = isoOrNull(now) ?? new Date().toISOString();
  return {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    familiarity: {
      turns: 0,
      activeDays: 0,
      firstSeenAt: null,
      lastInteractionAt: null,
      lastActiveDay: null,
    },
    intimacy: {
      score: 0,
      signalCount: 0,
      signalDays: 0,
      lastSignalAt: null,
      lastSignalDay: null,
      lastReason: "",
      daily: normalizeDaily(null),
    },
    events: [],
    stage: 0,
    updatedAt: at,
  };
}

/** 把盘上读回来的东西收成能用的形状；坏了就当新账，不抛。 */
export function normalizeRelationship(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fam = source.familiarity && typeof source.familiarity === "object" ? source.familiarity : {};
  const inti = source.intimacy && typeof source.intimacy === "object" ? source.intimacy : {};
  const turns = int(fam.turns, 0);
  const fallbackAt = isoOrNull(source.updatedAt) ?? (isoOrNull(now) || new Date().toISOString());
  const lastInteractionAt = isoOrNull(fam.lastInteractionAt) ?? (turns > 0 ? fallbackAt : null);
  const lastSignalAt = inti.signalCount ? isoOrNull(inti.lastSignalAt) : null;

  const relationship = {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    familiarity: {
      turns,
      activeDays: int(fam.activeDays, turns > 0 ? 1 : 0),
      firstSeenAt: isoOrNull(fam.firstSeenAt) ?? (turns > 0 ? lastInteractionAt : null),
      lastInteractionAt,
      lastActiveDay:
        typeof fam.lastActiveDay === "string" && fam.lastActiveDay
          ? fam.lastActiveDay
          : (lastInteractionAt ? dayKey(lastInteractionAt) : null),
    },
    intimacy: {
      score: clamp(num(inti.score, 0), 0, SCORE_MAX),
      signalCount: int(inti.signalCount, 0),
      signalDays: int(inti.signalDays, 0),
      lastSignalAt,
      lastSignalDay:
        typeof inti.lastSignalDay === "string" && inti.lastSignalDay
          ? inti.lastSignalDay
          : (lastSignalAt ? dayKey(lastSignalAt) : null),
      lastReason: String(inti.lastReason ?? "").trim().slice(0, 240),
      daily: normalizeDaily(inti.daily),
    },
    events: Array.isArray(source.events)
      ? source.events.filter((row) => row && typeof row === "object").slice(-MAX_EVENTS)
      : [],
    stage: 0,
    updatedAt: fallbackAt,
  };
  relationship.stage = getStage(relationship);
  return relationship;
}

/** 这句话里有哪几类信号（可能一次命中多条）。 */
export function classifySignals(text = "") {
  const source = typeof text === "string" ? text.trim() : "";
  if (!source) return [];
  // 宁可漏掉一句暧昧表达，也不能把明确拒绝记成亲近；正则只负责初筛，否定语境在这里先拦一层。
  if (/(?:^|[，。！？\s])(?:我)?(?:不|没|没有|才不|并不|不是|别|未)[^。！？\n]{0,4}(?:喜欢你|爱你|想你|想我)/u.test(source)
    || /想我(?:还是|觉得|算了)/u.test(source)) return [];
  return SIGNAL_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(source)))
    .map(({ type, delta, reason }) => ({ type, delta, reason }));
}

/** 撤回尚未被伙伴看到的消息时，撤掉这条消息贡献的亲近信号。老事件没有来源 id，保持不动。 */
export function retractRelationshipSource(raw, sourceMessageId) {
  const id = String(sourceMessageId ?? "").trim();
  const base = normalizeRelationship(raw);
  if (!id) return null;
  const removed = base.events.filter((event) => event?.sourceMessageId === id);
  if (!removed.length) return null;
  const remainingEvents = base.events.filter((event) => event?.sourceMessageId !== id);
  const removedScore = removed.reduce((sum, event) => sum + Math.max(0, num(event.delta, 0)), 0);
  const daily = normalizeDaily(base.intimacy.daily);
  const removedDailyScore = removed
    .filter((event) => event?.day === daily.day)
    .reduce((sum, event) => sum + Math.max(0, num(event.delta, 0)), 0);
  const remainingDailyTypes = new Set(remainingEvents.filter((event) => event?.day === daily.day).map((event) => event.type));
  const next = {
    ...base,
    intimacy: {
      ...base.intimacy,
      score: Math.max(0, num(base.intimacy.score, 0) - removedScore),
      signalCount: Math.max(0, int(base.intimacy.signalCount, 0) - removed.length),
      daily: {
        ...daily,
        score: Math.max(0, daily.score - removedDailyScore),
        types: daily.types.filter((type) => remainingDailyTypes.has(type)),
      },
    },
    events: remainingEvents,
  };
  next.stage = getStage(next);
  return next;
}

/**
 * 关系到哪一步了。
 * 跨日与证据都要够：单日猛聊不能跳级。
 */
export function getStage(relationship) {
  const fam = relationship?.familiarity ?? {};
  const inti = relationship?.intimacy ?? {};
  const activeDays = int(fam.activeDays, 0);
  const turns = int(fam.turns, 0);
  const score = clamp(num(inti.score, 0), 0, SCORE_MAX);
  const signalDays = int(inti.signalDays, 0);

  if (activeDays >= 14 && turns >= 20 && score >= 35 && signalDays >= 4) return 2;
  if (activeDays >= 5 && turns >= 8 && score >= 12 && signalDays >= 2) return 1;
  return 0;
}

/** 一份材料的真实份量：被截断过就认尾巴上那句「原文 N 字」，没截断就是它现在的长度。 */
export function materialSize(text) {
  const value = typeof text === "string" ? text : "";
  const marked = /原文\s*(\d+)\s*字/u.exec(value);
  return marked ? int(marked[1], 0) : value.length;
}

/**
 * 相处痕迹的份量：只看钉选、事实、经历三样。
 * 人格设定不算——那是她配的，不是相处出来的。
 */
export function traceSizeFromFiles(files) {
  return ["pinned", "facts", "experience"]
    .reduce((sum, key) => sum + materialSize(files?.[key]), 0);
}

/**
 * 起跑线：拿 Hana 那边留下的痕量换算一个起点。
 *
 * 只抬相处史（聊了多少、跮了几个日子），亲近度一个字不动。
 * 亲近是在这段关系里长出来的，不能靠一个开关一次性宣布。
 */
export const TRACE_TIERS = Object.freeze([
  Object.freeze({ id: "close", at: 9000, turns: 80, activeDays: 30, label: "已经很熟了" }),
  Object.freeze({ id: "chatty", at: 2000, turns: 40, activeDays: 14, label: "聊过一阵" }),
  Object.freeze({ id: "starting", at: 400, turns: 12, activeDays: 4, label: "刚开始熟" }),
]);

/** 她自己能锁的档：跟自动量出来的三档同一套名字，不会出现对不上的档。 */
export const SEED_TIER_IDS = Object.freeze(TRACE_TIERS.map((row) => row.id));

/**
 * 界面上摆的手动档（从低到高）。
 *
 * 自动量字保留三档（细），手动表态只需要粗的：最低那档跟「从这儿开始」
 * 在体感上一个样（都是「我们还不熟」），一列里摆两个同义项纯属噪音。
 */
export const SEED_PICK_TIERS = Object.freeze(
  [...TRACE_TIERS].reverse().filter((row) => row.id !== "starting"),
);

/** 痕量太少（或者根本没有）就不给起点，从零开始。 */
export function seedFromTrace(chars, now = new Date()) {
  const size = Math.max(0, int(chars, 0));
  const tier = TRACE_TIERS.find((row) => size >= row.at);
  if (!tier) return null;
  return {
    turns: tier.turns,
    activeDays: tier.activeDays,
    label: tier.label,
    trace: size,
    source: "auto",
    pick: "auto",
    measuredAt: new Date(now).toISOString(),
  };
}

/** 她自己锁的某一档：跟自动那份一个形状，只把来历写成 manual。 */
export function seedByPick(pick, chars = 0, now = new Date()) {
  const tier = TRACE_TIERS.find((row) => row.id === pick);
  if (!tier) return null;
  return {
    turns: tier.turns,
    activeDays: tier.activeDays,
    label: tier.label,
    trace: Math.max(0, int(chars, 0)),
    source: "manual",
    pick: tier.id,
    measuredAt: new Date(now).toISOString(),
  };
}

/** 「我们早就很熟了」＝最高那档；老的调用点还留着。 */
export function closeSeed(chars = 0, now = new Date()) {
  return seedByPick("close", chars, now);
}

/**
 * 「从这儿开始」：清掉起点，就当刚认识。
 * 这也是一个明确的声明（不是「没量出来」），存下来界面才知道是她选的。
 */
export function zeroSeed(now = new Date()) {
  return {
    turns: 0,
    activeDays: 0,
    label: "",
    trace: 0,
    source: "manual",
    pick: "zero",
    measuredAt: new Date(now).toISOString(),
  };
}

/** 盘上读回来收一手；没有起点（也没说「从这儿开始」）就是 null。 */
export function normalizeSeed(raw) {
  if (!raw || typeof raw !== "object") return null;
  const turns = Math.max(0, int(raw.turns, 0));
  const activeDays = Math.max(0, int(raw.activeDays, 0));
  const pick = normalizeSeedPick(raw);
  if (!turns && !activeDays && pick !== "zero") return null;
  return {
    turns,
    activeDays,
    label: typeof raw.label === "string" ? raw.label.slice(0, 12) : "",
    trace: Math.max(0, int(raw.trace, 0)),
    source: pick === "auto" ? "auto" : "manual",
    pick,
    measuredAt: isoOrNull(raw.measuredAt),
  };
}

/** 老数据没有 pick：手动那份以前只有「很熟」一档，按来历回推；其余都当自动。 */
function normalizeSeedPick(raw) {
  if (raw.pick === "auto" || raw.pick === "zero") return raw.pick;
  if (SEED_TIER_IDS.includes(raw.pick)) return raw.pick;
  return raw.source === "manual" ? "close" : "auto";
}

/**
 * 账本 + 起跑线 = 拿来判断的那份；账本本身不动（它只记茶话会里真实聊出来的）。
 * 这样开关什么时候关掉、起点什么时候撤，都不会弄丢在这边真实长出来的进度。
 */
export function mergeRelationship(relationship, seed) {
  const base = normalizeRelationship(relationship);
  const extraTurns = Math.max(0, int(seed?.turns, 0));
  const extraDays = Math.max(0, int(seed?.activeDays, 0));
  if (!extraTurns && !extraDays) return base;
  const merged = {
    ...base,
    familiarity: {
      ...base.familiarity,
      turns: base.familiarity.turns + extraTurns,
      activeDays: base.familiarity.activeDays + extraDays,
    },
  };
  merged.stage = getStage(merged);
  return merged;
}

export function stageLabel(stage) {
  if (stage >= 2) return "亲近";
  if (stage >= 1) return "逐渐熟悉";
  return "初识";
}

/**
 * 披露系数：把两轨账揉成一个 0~1 的平滑系数。
 *
 * 与 stage 的区别：stage 是台阶（跨过门槛就跳一级），这个是一直往上爬的坡——
 * 同样的 20 个回合，每天聊一点和隔三差五聊，系数不一样。
 * 熟悉度取「回合数 + 跨了几个日子」，亲密度看分值；两头都用饱和曲线，越往后涨得越慢，不封顶。
 * 最后过一道 smoothstep，临界处才不会硌人。
 */
const RATIO_TURNS_FULL = 24;
const RATIO_DAYS_FULL = 12;
const RATIO_SCORE_FULL = 24;

function saturate(value, full) {
  const v = Math.max(0, num(value, 0));
  if (v <= 0) return 0;
  return 1 - Math.exp(-v / full);
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function disclosureRatio(relationship) {
  const fam = relationship?.familiarity ?? {};
  const inti = relationship?.intimacy ?? {};
  const familiarityPart =
    0.6 * saturate(fam.turns, RATIO_TURNS_FULL) + 0.4 * saturate(fam.activeDays, RATIO_DAYS_FULL);
  const intimacyPart = saturate(inti.score, RATIO_SCORE_FULL);
  return smoothstep(0.42 * familiarityPart + 0.58 * intimacyPart);
}

/** 给模型看的状态，只给人话，不给分数。 */
export function describeStage(stage) {
  if (stage >= 2) return "你们已经比较亲近，形成了稳定的共同语境，彼此相处时更自在。";
  if (stage >= 1) return "你们正在慢慢熟悉，已经有一些共同语境，但仍保留适度分寸。";
  return "你们还在认识彼此，先保持自然和适度距离。";
}

/**
 * 开口那句的轻重：起点越高越敢说「不用重新自我介绍」。
 * 最低那档（才打过照面的量）配不上「相处很久」这种重话。
 */
function openingLine(seed) {
  const turns = int(seed?.turns, 0);
  if (turns >= 80) return "你们在别的地方已经相处很久了，不是第一天认识，不用重新自我介绍。";
  if (turns >= 40) return "你们在别的地方已经认识一阵子了，不是第一天见面，不用从头自我介绍。";
  return "你们以前在别的地方打过照面，不必完全从头认识。";
}

/**
 * 给模型的那句关系状态。
 *
 * 有来处才说那一句：刚开姑认识（还没起跑线、台阶也还在零）就什么也不添，
 * 别先替天说“你们还很疏远”；有起跑线时特意说一句：不是第一天见面，不用重新自我介绍——
 * 但这话的轻重跟着起点走，而且“认识很久”不等于“什么都能说”，更私下的那面还是在茶话会里长出来的。
 */
export function relationshipNote(relationship, seed) {
  const seeded = int(seed?.turns, 0) > 0 || int(seed?.activeDays, 0) > 0;
  const stage = getStage(relationship);
  if (!seeded) return stage >= 1 ? describeStage(stage) : "";
  const tail = stage >= 2
    ? "在这儿也已经处得挺深了。"
    : stage >= 1
      ? "在这儿也算熟起来了。"
      : "不过在这儿刚开始聊，更私下的那面还要慢慢来。";
  return `${openingLine(seed)}${tail}`;
}

/**
 * 她说完一句，账就往前挪一格。
 * @param {object} raw 盘上那份账
 * @param {{text?: string, stickerText?: string, now?: Date|string, sourceMessageId?: string}} options
 */
export function advanceRelationship(raw, options = {}) {
  const text = [options.text, options.stickerText]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
  const now = options.now ?? new Date();
  const at = isoOrNull(now) ?? new Date().toISOString();
  const day = dayKey(at);
  const relationship = normalizeRelationship(raw, at);

  const familiarity = { ...relationship.familiarity };
  const intimacy = { ...relationship.intimacy, daily: normalizeDaily(relationship.intimacy.daily) };

  familiarity.turns += 1;
  if (familiarity.lastActiveDay !== day) {
    familiarity.activeDays += 1;
    familiarity.lastActiveDay = day;
  }
  if (!familiarity.firstSeenAt) familiarity.firstSeenAt = at;
  familiarity.lastInteractionAt = at;

  const daily =
    intimacy.daily.day === day
      ? { ...intimacy.daily, types: [...intimacy.daily.types] }
      : normalizeDaily(null, day);

  const accepted = [];
  let room = Math.max(0, MAX_DAILY_INTIMACY - daily.score);
  for (const signal of classifySignals(text)) {
    if (room <= 0 || daily.types.includes(signal.type)) continue;
    const delta = Math.min(signal.delta, room);
    if (delta <= 0) continue;
    daily.score += delta;
    daily.types.push(signal.type);
    room -= delta;
    accepted.push({ ...signal, delta });
  }

  if (accepted.length) {
    intimacy.score = clamp(
      intimacy.score + accepted.reduce((sum, item) => sum + item.delta, 0),
      0,
      SCORE_MAX,
    );
    intimacy.signalCount += accepted.length;
    if (intimacy.lastSignalDay !== day) intimacy.signalDays += 1;
    intimacy.lastSignalDay = day;
    intimacy.lastSignalAt = at;
    intimacy.lastReason = accepted.map((item) => item.reason).join("；").slice(0, 240);
  }
  intimacy.daily = { ...daily, types: [...new Set(daily.types)].slice(0, SIGNAL_RULES.length) };

  const next = {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    familiarity,
    intimacy,
    events: [
      ...relationship.events,
      ...accepted.map((signal) => ({
        type: signal.type,
        delta: signal.delta,
        day,
        at,
        reason: signal.reason,
        sourceMessageId: String(options.sourceMessageId ?? "").trim() || null,
      })),
    ].slice(-MAX_EVENTS),
    stage: 0,
    updatedAt: at,
  };
  next.stage = getStage(next);

  return {
    relationship: next,
    signals: accepted,
    /** 这一步刚好跨过了台阶 */
    stageChanged: next.stage !== relationship.stage,
  };
}
