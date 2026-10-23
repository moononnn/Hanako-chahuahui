/**
 * 公共事件：今天确实发生的事，由谁开口。
 *
 * 两类事件的规矩不一样，2026-10-24 玥儿定的：
 *
 *   · **节日**要的是人情味。开了主动消息的伙伴各自说一句，按自己的性格说，
 *     一人一条，当天说过的不再重复。四条合成一个热闹，不是四条群发短信。
 *   · **天气**要的是有人记得。一件事只归一位——按亲密度加权抽一位，
 *     抽完当天定死，别人一概不提。四个人报同一场降温，那是小区广播。
 *
 * 这一层只管「谁、说过没有」，不碰语气也不碰门禁：
 * 静默时段、每日配额、相邻间隔仍然在 proactive.js 与 index.js 那边原样管着。
 *
 * 纯逻辑 + 一次只读快照，不调模型，方便测。
 */

import { FESTIVAL_RESPONSE_NAMES } from "./daybook.js";

/** 拾光记对外契约：天气提醒事件。 */
export const ALERTS_APP_ID = "shiguangji-app";
export const ALERTS_KEY = "alerts";
export const ALERTS_SCHEMA_VERSION = 1;

/** 天气事件的时效宽限：过了这个点再说就是马后炮。 */
const WEATHER_LATE_GRACE_MS = 30 * 60 * 1000;
/** 亲密度权重的下限：刚认识的人也有机会，但压不过最亲的那位。 */
const WEIGHT_FLOOR = 0.15;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 本地日历日 YYYY-MM-DD。 */
export function dayOf(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地小时键 YYYY-MM-DDTHH，跟拾光记事件里的 at 同一形状，能直接比大小。 */
export function hourKeyOf(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(d.getTime())) return "";
  return `${dayOf(d)}T${pad2(d.getHours())}`;
}

function cleanText(value, maxLength = 80) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanList(values, limit = 20) {
  return (Array.isArray(values) ? values : []).map((row) => cleanText(row, 40)).filter(Boolean).slice(0, limit);
}

/**
 * 读拾光记摊出来的天气提醒事件。
 * 每次异步读当前发布，不缓存成功结果：撤权、卸载、停用都要立刻反映过来。
 * @returns {Promise<object|null>} 契约内容，读不到就是 null
 */
export async function readPublicAlerts(ctx) {
  if (typeof ctx?.publicData?.get !== "function") return null;
  try {
    const result = await ctx.publicData.get({ appId: ALERTS_APP_ID, key: ALERTS_KEY });
    if (result?.appId !== ALERTS_APP_ID || result?.key !== ALERTS_KEY) return null;
    if (Number(result.schemaVersion) !== ALERTS_SCHEMA_VERSION) return null;
    const data = result.data;
    if (!data || typeof data !== "object") return null;
    if (!Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 今天该不该有节日祝福。从拾光记的日子账本里认，不另立一套节日表。
 * @returns {string} 节日名，没有就是空串
 */
export function festivalOf(snapshot) {
  const festivals = cleanList(snapshot?.today?.festivals, 10);
  return festivals.find((name) => FESTIVAL_RESPONSE_NAMES.has(name)) || "";
}

function festivalBook(state) {
  const book = state?.publicEvents?.festival;
  return book && typeof book === "object" ? book : null;
}

/**
 * 这位伙伴今天还没送过这个节日的祝福吗。
 * 节日一人一条：当天同一节日，谁说过谁就不再提。
 */
export function shouldSendFestival({ festival, day, agentId, state = null } = {}) {
  if (!festival || !day || !agentId) return false;
  const book = festivalBook(state);
  if (!book || book.day !== day || book.festival !== festival) return true;
  return !(Array.isArray(book.sent) ? book.sent : []).includes(agentId);
}

/** 记下这位已经把节日祝福说出口了。 */
export function noteFestivalSent(state = null, { festival, day, agentId, at = new Date() } = {}) {
  if (!festival || !day || !agentId) return state;
  const base = state && typeof state === "object" ? state : {};
  const book = festivalBook(base);
  const fresh = book && book.day === day && book.festival === festival;
  const sent = fresh ? [...(Array.isArray(book.sent) ? book.sent : [])] : [];
  if (!sent.includes(agentId)) sent.push(agentId);
  return {
    ...base,
    publicEvents: {
      ...(base.publicEvents ?? {}),
      festival: {
        day,
        festival,
        sent,
        at: (at instanceof Date ? at : new Date(at)).toISOString(),
      },
    },
  };
}

/**
 * 挑一件现在说还不算晚的天气事件。
 *
 * 事件到点了就不再提：`at` 之后过了一点宽限还说「下午会到 18 度」，
 * 那是复读机不是提醒。整份清单都没有还没到点的，就今天不说了。
 */
export function pickWeatherEvent(alerts, now = new Date()) {
  if (!alerts || alerts.reason !== "ok") return null;
  const events = Array.isArray(alerts.events) ? alerts.events : [];
  const nowTs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const currentKey = hourKeyOf(new Date(nowTs));
  for (const event of events) {
    const at = cleanText(event?.at, 20);
    const facts = Array.isArray(event?.facts) ? event.facts.map((row) => cleanText(row, 60)).filter(Boolean) : [];
    if (!at || !facts.length) continue;
    // 小时级事件比到小时；全天事件（只有日期）只比日期。
    const target = at.length >= 13 ? at.slice(0, 13) : at.slice(0, 10);
    const cursor = at.length >= 13 ? currentKey : currentKey.slice(0, 10);
    if (target < cursor) continue;
    // 同一小时里也要看表：过了这个钟点太久就不提了。
    if (target === cursor && at.length >= 13) {
      const hourStart = new Date(nowTs);
      hourStart.setMinutes(0, 0, 0);
      if (nowTs - hourStart.getTime() > WEATHER_LATE_GRACE_MS) continue;
    }
    return {
      key: cleanText(event.key, 80),
      kind: cleanText(event.kind, 20),
      label: cleanText(event.label, 20),
      dayLabel: cleanText(event.dayLabel, 20),
      slot: cleanText(event.slot, 20),
      at,
      facts,
      keywords: cleanList(event.keywords, 8),
    };
  }
  return null;
}

function saturate(value, full) {
  const v = Math.max(0, num(value, 0));
  if (v <= 0) return 0;
  return 1 - Math.exp(-v / full);
}

/**
 * 亲密度权重：跟 proactive-reasons 同一把尺（熟悉度看回合数与跨过的日子，亲密度看分值），
 * 但这里不是抽由头，是抽「今天这件事归谁」，所以两轨合起来算一个更重的比重。
 * 她说的「亲密度、聊得最多」正好对上这两轨。
 */
export function intimacyWeight(relationship) {
  const fam = relationship?.familiarity ?? {};
  const inti = relationship?.intimacy ?? {};
  const familiarity = 0.6 * saturate(fam.turns, 24) + 0.4 * saturate(fam.activeDays, 12);
  const intimacy = saturate(inti.score, 24);
  const blend = 0.45 * familiarity + 0.55 * intimacy;
  return WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * blend;
}

/**
 * 这一件事今天归谁说。抽一次定死，之后同一天同一件事再用就直接读账，不重抽。
 *
 * 定死而不是「谁先撞上谁发」：伙伴之间互相不知道对方在干嘛，
 * 让模型现场判断一定会踩，撞车了也看不出是谁的错。
 *
 * @returns {{ownerId: string|null, state: object, reused: boolean}}
 */
export function claimWeatherOwner({
  day,
  eventKey,
  partners = [],
  weights = {},
  state = null,
  now = new Date(),
  rnd = Math.random,
} = {}) {
  const base = state && typeof state === "object" ? state : {};
  const book = base?.publicEvents?.weather;
  if (book && book.day === day && book.eventKey === eventKey && book.ownerId) {
    return { ownerId: String(book.ownerId), state: base, reused: true };
  }
  const candidates = (Array.isArray(partners) ? partners : [])
    .map((row) => ({ id: String(row?.id ?? "").trim(), name: String(row?.name ?? "").trim() }))
    .filter((row) => row.id);
  if (!candidates.length) return { ownerId: null, state: base, reused: false };

  const weightOf = (id) => {
    const value = num(weights?.[id], NaN);
    return Number.isFinite(value) && value > 0 ? value : WEIGHT_FLOOR;
  };
  const total = candidates.reduce((sum, row) => sum + weightOf(row.id), 0);
  const roll = Math.min(Math.max(num(rnd(), 0), 0), 0.999999) * total;
  let chosen = candidates[candidates.length - 1];
  let point = roll;
  for (const row of candidates) {
    point -= weightOf(row.id);
    if (point < 0) {
      chosen = row;
      break;
    }
  }
  const at = now instanceof Date ? now : new Date(now);
  return {
    ownerId: chosen.id,
    reused: false,
    state: {
      ...base,
      publicEvents: {
        ...(base.publicEvents ?? {}),
        weather: {
          day,
          eventKey,
          ownerId: chosen.id,
          at: Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString(),
        },
      },
    },
  };
}

/** 这位是不是今天这件事的负责人，且还没说过。 */
export function weatherPendingFor({ day, eventKey, agentId, state = null } = {}) {
  if (!agentId) return false;
  const book = state?.publicEvents?.weather;
  if (!book || book.day !== day || book.eventKey !== eventKey) return false;
  if (String(book.ownerId) !== String(agentId)) return false;
  return !book.sentAt;
}

/** 记下这件事说出口了（同一个 owner 当天不再说第二遍）。 */
export function noteWeatherSent(state = null, { day, eventKey, agentId, at = new Date() } = {}) {
  const base = state && typeof state === "object" ? state : {};
  const book = base?.publicEvents?.weather;
  if (!book || book.day !== day || book.eventKey !== eventKey) return base;
  if (String(book.ownerId) !== String(agentId)) return base;
  const stamp = at instanceof Date ? at : new Date(at);
  return {
    ...base,
    publicEvents: {
      ...(base.publicEvents ?? {}),
      weather: {
        ...book,
        sentAt: Number.isFinite(stamp.getTime()) ? stamp.toISOString() : new Date().toISOString(),
      },
    },
  };
}
