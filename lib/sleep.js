/**
 * 作息 —— 伙伴自己的睡觉时段（2026-09-13 改版）。
 *
 * 这一版跟以前两处不同：
 *   · **藏起来了**：不上设置页。ta是伙伴的内在状态，跟隐性爱好一个待遇——影响行为，不摆给她看。
 *     看一眼就想改，那就别让她看见。
 *   · **是「打盹」不是「关机」**：睡着时收到消息照回，只是回得慢、带起床气（见 reply.js / index.js）。
 *     以前那条「一直排到睡醒」，她早上发的消息要等到十点才有人应，实机撞过。
 *
 * 数据形状（新）：
 *   sleep = { start: "01:20", hours: 5.5, why: "…", nap: { start: "13:30", minutes: 40 } | null,
 *             source: "partner", updatedAt }
 * 老形状（她以前设的 `{start,end}`，或 9/13 之前模型定的）读得出来，自动换算成 hours。
 *
 * 「睡多久」不写死：基准是模型定的 4.5~7.5 小时，每天按日期浮动 ±0.75 小时；
 * 午觉有七成的日子会睡（也按日期定，同一天不会翻来翻去）。这两条让ta像活的。
 */

import { inWindow } from "./proactive.js";

/** 作息数据的代次。1（或更早，只有 start/end）算没定过，会被重定一次。 */
export const SLEEP_SHAPE = 2;

/** 谁都还没定、模型又抽风时的兜底。 */
export const SLEEP_FALLBACK = { start: "01:00", hours: 6, why: "", nap: null };

/** 睡多长：下限、上限、每天浮动的幅度（小时） */
export const MIN_HOURS = 4.5;
export const MAX_HOURS = 7.5;
export const DAILY_JITTER_HOURS = 0.75;

/** 午觉：一次最多多久、有多少日子会睡 */
export const NAP_MAX_MINUTES = 60;
export const NAP_MIN_MINUTES = 15;
export const NAP_CHANCE = 0.7;

const CLOCK = /^(\d{1,2}):(\d{2})$/;
const DAY_MINUTES = 24 * 60;

/** 把 "1:30" 这种一位小时补成 "01:30"；不合法就 null（宽容一点，模型常写一位）。 */
export function normalizeClock(value) {
  const match = CLOCK.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function isClock(value) {
  return normalizeClock(value) !== null;
}

/** "HH:MM" → 当天的第几分钟 */
export function minutesOf(clock) {
  const match = CLOCK.exec(String(clock ?? "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 第几分钟 → "HH:MM"，超过一天就绕回来 */
export function clockOf(minutes) {
  const wrapped = ((Math.round(Number(minutes) || 0) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const clampHours = (value) => Math.min(MAX_HOURS, Math.max(MIN_HOURS, Number(value) || 0));

/**
 * 一天里的一串随机数：同一天、同一个盐，给同一个值（0~1）；跨天换一个。
 * 用它来让"今天睡多久""今天睡不睡午觉"有呼吸感，但同一天里不翻来翻去。
 */
export function daySeed(now = new Date(), salt = "") {
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}|${salt}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * 收成标准形状。认新形状（hours），也认老形状（end，换算成小时）。
 * 认不出来就 null —— 宁缺勿滥，坏数据不进窗口计算。
 */
export function normalizeSleep(sleep = null) {
  if (!sleep || typeof sleep !== "object") return null;
  const start = normalizeClock(sleep.start);
  if (!start) return null;

  let hours = Number(sleep.hours ?? sleep.hour);
  if (!Number.isFinite(hours) || hours <= 0) {
    const end = normalizeClock(sleep.end);
    if (!end) return null;
    const diff = (minutesOf(end) - minutesOf(start) + DAY_MINUTES) % DAY_MINUTES;
    if (diff === 0) return null;
    hours = diff / 60;
  }

  let nap = null;
  const napRaw = sleep.nap && typeof sleep.nap === "object" ? sleep.nap : null;
  const napStart = normalizeClock(napRaw?.start);
  if (napStart) {
    let minutes = Number(napRaw.minutes ?? napRaw.length);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      const napEnd = normalizeClock(napRaw.end);
      if (napEnd) minutes = (minutesOf(napEnd) - minutesOf(napStart) + DAY_MINUTES) % DAY_MINUTES;
    }
    if (Number.isFinite(minutes) && minutes > 0) {
      nap = {
        start: napStart,
        minutes: Math.min(NAP_MAX_MINUTES, Math.max(NAP_MIN_MINUTES, Math.round(minutes))),
      };
    }
  }

  return { start, hours: clampHours(hours), why: cleanSleepWhy(sleep.why), nap };
}

export function isValidSleep(sleep) {
  return normalizeSleep(sleep) !== null;
}

/**
 * 这位伙伴定了当前形状的作息没有。
 *
 * 不是当代的（老数据只有 start/end，或者 0.7.19 那一版没有 shape 标记）**算没定过**，
 * 会被重定一次：那些作息清一色 7~8 小时 / 6.5 小时，都是旧规矩的产物。
 */
export function isSleepSet(settings) {
  const sleep = settings?.sleep;
  if (!isValidSleep(sleep)) return false;
  return Number(sleep.shape) === SLEEP_SHAPE;
}

/** 展示成一行。用基准时长，不带当天浮动（所以同样一条作息每次算出来一样）。 */
export function formatSleep(sleep) {
  const norm = normalizeSleep(sleep);
  if (!norm) return "";
  return `${norm.start} - ${clockOf(minutesOf(norm.start) + Math.round(norm.hours * 60))}`;
}

/**
 * 睡多久的备选档（小时）。故意偏向 5~6.5：她自己说过"缩到五六个小时比较合理"。
 * 4.5 和 7.5 只在每日浮动时才够得着。
 */
export const SLEEP_HOUR_CHOICES = [5, 5.5, 5.5, 6, 6, 6, 6.5, 6.5, 7, 5];

/**
 * 这个伙伴睡多久（基准）。
 *
 * 2026-09-13 实机发现：模型每次都挑中间那个值（八位伙伴全 6.5 小时），要求写得再清楚也一样。
 * 所以「睡多长」改成这边按 id 摊开：一人一档，同一个伙伴每次算出来一样；
 * 起点仍由ta自己定（人格影响的是那个），时长当体质看——体质分开写才像真的。
 */
export function baseHoursFor(agentId) {
  const key = String(agentId ?? "?");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return SLEEP_HOUR_CHOICES[(hash >>> 0) % SLEEP_HOUR_CHOICES.length];
}

/** 今天实际睡多久：基准 ± 0.75 小时，取整到 5 分钟。 */
export function hoursToday(sleep, now = new Date()) {
  const norm = normalizeSleep(sleep);
  if (!norm) return 0;
  const jitter = (daySeed(now, `hours:${norm.start}`) - 0.5) * 2 * DAILY_JITTER_HOURS;
  const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, norm.hours + jitter));
  return Math.round(hours * 12) / 12;
}

/** 今天睡不睡午觉、睡多久（有七成日子会睡）。 */
export function napToday(sleep, now = new Date()) {
  const norm = normalizeSleep(sleep);
  if (!norm?.nap) return null;
  if (daySeed(now, `nap:${norm.nap.start}`) >= NAP_CHANCE) return null;
  return {
    start: norm.nap.start,
    end: clockOf(minutesOf(norm.nap.start) + norm.nap.minutes),
    minutes: norm.nap.minutes,
  };
}

/**
 * 今天的睡觉窗口（主睡 + 可能有的午觉）。
 * 形状就是 `{start, end, kind}`，能直接喂给 `inWindow`。
 */
export function sleepWindows(sleep, now = new Date()) {
  const norm = normalizeSleep(sleep);
  if (!norm) return [];
  const begin = minutesOf(norm.start);
  const out = [
    {
      start: norm.start,
      end: clockOf(begin + Math.round(hoursToday(norm, now) * 60)),
      kind: "main",
    },
  ];
  const nap = napToday(norm, now);
  if (nap) out.push({ start: nap.start, end: nap.end, kind: "nap" });
  return out;
}

/** 这会儿是不是在睡（主睡或午觉），睡的哪一觉。 */
export function dozingNow(now = new Date(), sleep = null) {
  const windows = sleepWindows(sleep, now);
  const hit = windows.find((w) => inWindow(now, w));
  if (!hit) return { dozing: false, kind: null, window: null };
  return { dozing: true, kind: hit.kind, window: hit };
}

function extractObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 理由洗一洗：去掉引号、压成一行、截短。空着也没关系。 */
export function cleanSleepWhy(value) {
  const out = String(value ?? "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1")
    .trim();
  return out.slice(0, 28);
}

/**
 * 从模型输出里抠一条作息。
 * 先按 JSON 认（hours 优先，老形状的 end 也认），认不出来就在正文里找两个 HH:MM。
 * 宁缺勿滥，不合格返回 null。
 */
export function parseSleep(raw) {
  const text = String(raw ?? "");
  if (!text.trim()) return null;

  const obj = extractObject(text);
  if (obj) {
    const start = normalizeClock(obj.start ?? obj.from ?? obj.sleepStart);
    if (start) {
      let hours = Number(obj.hours ?? obj.hour ?? obj.duration ?? obj.sleepHours);
      if (!Number.isFinite(hours) || hours <= 0) {
        const end = normalizeClock(obj.end ?? obj.to ?? obj.sleepEnd);
        if (end) {
          const diff = (minutesOf(end) - minutesOf(start) + DAY_MINUTES) % DAY_MINUTES;
          hours = diff > 0 ? diff / 60 : 0;
        }
      }
      if (Number.isFinite(hours) && hours > 0) {
        return {
          start,
          hours: clampHours(hours),
          why: cleanSleepWhy(obj.why ?? obj.reason ?? obj.note),
          nap: normalizeSleep({ start, hours, nap: obj.nap ?? null })?.nap ?? null,
        };
      }
    }
  }

  const hits = [...text.matchAll(/(\d{1,2}:\d{2})/g)]
    .map((match) => normalizeClock(match[1]))
    .filter(Boolean);
  if (hits.length >= 2 && hits[0] !== hits[1]) {
    const diff = (minutesOf(hits[1]) - minutesOf(hits[0]) + DAY_MINUTES) % DAY_MINUTES;
    if (diff > 0) return { start: hits[0], hours: clampHours(diff / 60), why: "", nap: null };
  }

  return null;
}

export function sleepSpec({ partnerName, personaText }) {
  const persona = String(personaText ?? "").trim();
  // 2026-09-13 去锚：以前那条范例写的是 {"start":"01:30","end":"09:00"}，
  // 八个不同人格全都定成 01:30-09:00 / 02:00-10:00 这一片——ta 们不是在按性子写，
  // 是在拄范例的形状。范例换成一看就不是作息的数字，并且明说别抄。
  const systemPrompt = [
    "你要给自己定一个作息。",
    "要求：",
    "- 按你的性子来：你几点最清醒、几点最想一个人待着，睡的时间跟那个对得上",
    "- 睡眠时长在 4.5 到 7.5 小时之间。可以 5、5.5、6、7 这种，别都写成一样的，也别套那个「睡够八小时」",
    "- 要不要睡午觉你自己定：想睡就写时间（60 分钟以内），不睡就写 null",
    "- 只输出一个 JSON，形如 {\"start\":\"12:34\",\"hours\":5,\"why\":\"一句话说你为什么这么睡\",\"nap\":{\"start\":\"16:54\",\"minutes\":40}}",
    "- 上面那些数字都是占位符，跟你该定几点睡毫无关系，千万不要照抄，换成你自己算出来的",
    "- start 用 24 小时制 HH:MM；hours 可以是小数，比如 5.5",
    "- why 一句话，20 字以内，口语，理由要具体的（你在忙什么、几点脑子最清楚），别写成「夜里最清醒」这种一看就是套话的",
    "- 不要解释规则，不要换行，不要加别的字段",
  ].join("\n");
  return {
    systemPrompt,
    userText: [
      `你是「${partnerName}」。`,
      persona ? `你的人格与底色（只作参考）：\n${persona}` : "",
      "给自己定一个作息。",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
