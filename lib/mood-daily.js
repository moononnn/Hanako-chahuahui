/**
 * 心情日盘（2026-10-24）
 *
 * 一句话：每天起床结算一个心情底子，白天在这个底子上加减，不给用户看。
 *
 * 为什么是「日盘」而不是随时辰流动的状态场：
 *   人要的是「今天起来莫名有点高兴」这种东西。它得有个结算点，也得有个说不清来处。
 *   所以这里一天只结一次，落完就定；白天的事只改浓淡，不重抽。
 *
 * 底子由四样摞成，权重写死在 DAILY_WEIGHTS：
 *   · 昨天收盘的余温（惯性，占大头）
 *   · 昨天睡多久（茶话会本来就记着作息）
 *   · 一点说不清的东西（按日期+伙伴算的种子，可复现：同一天重启几次都是同一个心情）
 *   拾光记那条线现在没开，暂时不列进来；接上也只需要加一项。
 *
 * 三条护栏，写在代码里而不是提示词里：
 *   1. **格子偏暖。** 基础权重就是偏的，低落是少数日子，不是常态。
 *   2. **连续低落两天，第三天拉回中性。** 不然下坡会自己走成惯性，人就得天天哄。
 *   3. **往下掉比往上快一点，但幅度小。** 这是真的人性，但不能让它变成日常。
 *
 * 情绪格用的是拾光记那 13 格（玥儿 2026-09-05 定稿），不是别人的七格。
 * 这里只抄一份常量和语义词，不 import 拾光记的代码：两个 App 各自独立，不互相绑死。
 *
 * 纯逻辑：不碰模型、不碰文件。
 */

import { dayKey } from "./days.js";
import { daySeed } from "./sleep.js";

/** 十三格。valence 是这个格大致在暖—冷轴上的位置，只用于算倾向，不对外显示。 */
export const MOOD_GRID = Object.freeze([
  { id: "bliss", label: "幸福", valence: 2.4 },
  { id: "excited", label: "兴奋", valence: 2.2 },
  { id: "happy", label: "开心", valence: 1.8 },
  { id: "moved", label: "感动", valence: 1.5 },
  { id: "missing", label: "想念", valence: 0.9 },
  { id: "calm", label: "平静", valence: 0 },
  { id: "bored", label: "无聊", valence: -0.5 },
  { id: "tired", label: "累", valence: -1.0 },
  { id: "annoyed", label: "烦躁", valence: -1.4 },
  { id: "anxious", label: "焦虑", valence: -1.6 },
  { id: "sad", label: "难过", valence: -2.0 },
  { id: "hurt", label: "委屈", valence: -2.1 },
  { id: "angry", label: "生气", valence: -2.4 },
]);

const BY_ID = new Map(MOOD_GRID.map((m) => [m.id, m]));

/**
 * 基础权重。这一版是玥儿看过草案没反对的那版：
 * 暖的那排 67、温和的沉 30、需要哄的 2。十天里七八天心情不错。
 */
export const MOOD_WEIGHTS = Object.freeze({
  calm: 24, happy: 18, bliss: 10, excited: 5, moved: 5, missing: 5,
  tired: 8, bored: 6, annoyed: 6, anxious: 5, sad: 3, hurt: 1, angry: 1,
});

/** 底子由哪几样决定。三个数加起来是 1。 */
export const DAILY_WEIGHTS = Object.freeze({ yesterday: 0.55, sleep: 0.25, seed: 0.2 });

/** 倾向对抽签的聚焦程度。越大越贴倾向，越小越随意。 */
export const FOCUS_SIGMA = 1.35;

/** 连续沉到第几天，强制拉回中性。 */
export const STREAK_LIMIT = 2;

/** 算不算「沉」的线：valence 在这条线下就算沉了一天。 */
export const LOW_LINE = -0.4;

/**
 * 白天的事能把心情推到多低。
 *
 * -1.7 这个数字是故意压的：十三格里「委屈」是 -2.1、「生气」是 -2.4。
 * 日盘能落到那两格，**白天的单句话不能**。你今天骂她一句，她最多有点闷、有点烦，
 * 不会当场委屈给你看——一旦当场，关系就变成「她一不舒服你就得立刻处理」。
 * 那两格只能从日盘里来，也就是从睡眠、昨天的余温和那点说不清的东西里来。
 */
export const EVENT_FLOOR = -1.7;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round(v * 100) / 100;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function moodById(id) {
  return BY_ID.get(String(id ?? "")) || null;
}

/** 空账：没有前一天时从平静起步。 */
export function emptyMoodDay(date = null) {
  return {
    date: date ?? null,
    moodId: "calm",
    intensity: 0.5,
    valence: 0,
    baseline: 0,
    streak: 0,
    settledAt: null,
    updatedAt: null,
    events: 0,
  };
}

export function readMoodDay(raw) {
  if (!raw || typeof raw !== "object") return emptyMoodDay();
  const mood = moodById(raw.moodId);
  return {
    date: typeof raw.date === "string" && raw.date ? raw.date : null,
    moodId: mood ? mood.id : "calm",
    intensity: isNum(raw.intensity) ? clamp(raw.intensity, 0, 1) : 0.5,
    valence: isNum(raw.valence) ? clamp(raw.valence, -3, 3) : 0,
    baseline: isNum(raw.baseline) ? clamp(raw.baseline, -3, 3) : 0,
    streak: Number.isFinite(Number(raw.streak)) ? Math.max(0, Math.floor(Number(raw.streak))) : 0,
    settledAt: typeof raw.settledAt === "string" && raw.settledAt ? raw.settledAt : null,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : null,
    events: Number.isFinite(Number(raw.events)) ? Math.max(0, Math.floor(Number(raw.events))) : 0,
  };
}

/**
 * 睡得好不好，换算成 -1..1 的偏移。
 * 睡够 7 小时上下算好，睡到 4.5 小时算差。没有作息数据就当 0（不多不少）。
 */
export function sleepOffset(hours) {
  const h = Number(hours);
  if (!isNum(h) || h <= 0) return 0;
  // 6 小时是中线，每差 1 小时偏 0.5，夹在 -1..1
  return clamp((h - 6) * 0.5, -1, 1) / 2;
}

/**
 * 一样东西的「说不清那部分」：按日期 + 伙伴算，落在 -1..1。
 * 同一天同一个伙伴永远是同一个值，重启也不变；换天换一个。
 */
export function dailyNoise(now = new Date(), agentId = "") {
  const r = daySeed(now, `mood:${String(agentId ?? "?")}`);
  return r * 2 - 1;
}

/**
 * 结算当天的底子。
 *
 * @param {object|null} yesterday 昨天的账（readMoodDay 过的）
 * @param {{now?: Date, agentId?: string, sleepHours?: number}} options
 * @returns {object} 今天的账（未结算时调用）
 */
export function settleDay(yesterday = null, { now = new Date(), agentId = "", sleepHours = 0 } = {}) {
  const prev = yesterday ? readMoodDay(yesterday) : emptyMoodDay();
  const date = dayKey(now);

  // 昨天剩多少：用收盘的 valence，不是底子。白天的事也要跟着过夜。
  const carried = clamp(prev.valence, -2.5, 2.5) * DAILY_WEIGHTS.yesterday;
  const sleep = sleepOffset(sleepHours) * 2.5 * DAILY_WEIGHTS.sleep;
  const noise = dailyNoise(now, agentId) * 2.5 * DAILY_WEIGHTS.seed;
  let target = carried + sleep + noise;

  // 护栏二：连着沉了两天，今天不许再沉。第三天把倾向抬到中性以上一点点。
  if (prev.streak >= STREAK_LIMIT && target < 0.2) target = 0.2;

  // 过去的惯性：连着暖的时候也别一路飘到天上
  target = clamp(target, -1.6, 1.8);

  const picked = pickGrid(target, daySeed(now, `mood-pick:${String(agentId ?? "?")}`));
  const mood = moodById(picked);

  // 浓淡：倾向离中性越远，这一格越浓
  const intensity = clamp(0.35 + Math.abs(target) * 0.3, 0.35, 0.95);
  const at = (now instanceof Date ? now : new Date(now)).toISOString();

  return {
    date,
    moodId: mood.id,
    intensity: round2(intensity),
    valence: round2(clamp(mood.valence * intensity, -3, 3)),
    baseline: round2(clamp(mood.valence * intensity, -3, 3)),
    streak: prev.streak,
    settledAt: at,
    updatedAt: at,
    events: 0,
  };
}

/**
 * 在十三格里按倾向抽一格。
 * 抽的是「落在哪格」（随机），不抽「往哪个方向偏」（被倾向决定）。
 * 这就是「莫名但不乱来」的落点。
 */
export function pickGrid(target, r = 0.5) {
  const t = clamp(Number(target) || 0, -3, 3);
  const rows = MOOD_GRID.map((m) => {
    const base = MOOD_WEIGHTS[m.id] ?? 1;
    const dist = m.valence - t;
    const weight = base * Math.exp(-(dist * dist) / (2 * FOCUS_SIGMA * FOCUS_SIGMA));
    return { id: m.id, weight };
  });
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) return "calm";
  let acc = 0;
  const draw = clamp(Number(r) || 0, 0, 0.999999);
  for (const row of rows) {
    acc += row.weight / total;
    if (draw <= acc) return row.id;
  }
  return rows[rows.length - 1].id;
}

/**
 * 白天的一件事改今天的浓淡。
 *
 * delta 是这件事的力度：夸一句 +0.15，闹一场 +0.3，被怼一句 -0.35，说句重的 -0.6。
 * 一次只改浓淡，不改格子；攒到一定程度才换格。这样「一句重话让她从幸福变成委屈」不会发生。
 *
 * @param {object} day 今天的账
 * @param {{delta: number, why?: string, now?: Date}} event
 */
export function applyDayEvent(day, event = {}) {
  const current = readMoodDay(day);
  const delta = clamp(Number(event.delta) || 0, -1, 1);
  if (!delta) return current;

  const now = event.now instanceof Date ? event.now : (event.now ? new Date(event.now) : new Date());
  const at = now.toISOString();
  const valence = clamp(current.valence + delta, EVENT_FLOOR, 3);

  // 换格：离当前格超过 1.1 才换，就近落
  const here = moodById(current.moodId) ?? moodById("calm");
  let moodId = current.moodId;
  if (Math.abs(valence - here.valence) > 1.1) {
    const nearest = MOOD_GRID.reduce((best, m) =>
      Math.abs(m.valence - valence) < Math.abs(best.valence - valence) ? m : best);
    moodId = nearest.id;
  }

  const intensity = clamp(0.35 + Math.abs(valence) * 0.28, 0.35, 0.95);
  return {
    ...current,
    moodId,
    intensity: round2(intensity),
    valence: round2(valence),
    updatedAt: at,
    events: current.events + 1,
  };
}

/**
 * 跨天时更新连续低落天数。换日那一刻调用一次。
 * 只数「沉」，不数「暖」：暖的日子不累计任何东西。
 */
export function nextStreak(day) {
  const current = readMoodDay(day);
  return current.valence < LOW_LINE ? current.streak + 1 : 0;
}

/**
 * 给生成用的一句话。**不给用户看**，只放进提示词。
 * 写的是她今天大概什么样子，不是数值，免得模型照着数字演。
 */
export function moodBrief(day) {
  const current = readMoodDay(day);
  const mood = moodById(current.moodId) ?? moodById("calm");
  const heavy = current.intensity >= 0.7;
  const table = {
    bliss: heavy ? "心情好得有点晃，看什么都顺眼" : "心情不错，人松快",
    excited: heavy ? "兴致高，憋着想跟人说点什么" : "有点小兴奋",
    happy: heavy ? "轻快，容易笑" : "还算高兴",
    moved: "心里有点软，容易被小事碰到",
    missing: "有点想念谁，说不上来为什么",
    calm: "平平的，不急不躁",
    bored: "提不起劲，什么都差点意思",
    tired: heavy ? "累得厉害，脑子转不动" : "有点累，话不多",
    annoyed: heavy ? "心里毛躁，容易不耐烦" : "有点烦，忍着",
    anxious: "心里悬着，说不清担心什么",
    sad: heavy ? "低落，看什么都灰一点" : "有点闷，不想多讲",
    hurt: "有块地方不太舒服，不想主动提",
    angry: "憋着火，但还没到要发作",
  };
  return table[mood.id] ?? "平平的";
}

/**
 * 从她的一句话里读出这次叫什么力气。纯词表，不调模型。
 * 拿不准就返回 0：宁可不动，也不要每句话都去改心情。
 */
export function reactionDelta(text) {
  const clean = String(text ?? "").replace(/[\s，,。！？!?~～…、；;：:「」『』（）()"'"]+/gu, "");
  if (!clean) return 0;
  if (/伤心|难过|失望|气死|你都不|不理我|不在乎|难受/u.test(clean)) return -0.6;
  if (/烦|难看|笨|听不懂|看不懂|别给我|不许|可恶/u.test(clean)) return -0.35;
  if (/亲|抱|rua|闺闺|老婆|花宝|喜欢|爱|想你|陪|mua|啵|谢谢|厉害/u.test(clean)) return 0.3;
  if (clean.length >= 30) return 0.2;
  if (clean.length <= 2) return 0.05;
  return 0;
}

/** 诊断用。永远不该出现在界面上。 */
export function moodDebugLine(day) {
  const current = readMoodDay(day);
  const mood = moodById(current.moodId);
  return [
    current.date ?? "?",
    `${mood?.label ?? "平静"}(${current.intensity})`,
    `价 ${current.valence >= 0 ? "+" : ""}${current.valence}`,
    `连续沉 ${current.streak} 天`,
    `事件 ${current.events}`,
  ].join(" · ");
}
