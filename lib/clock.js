/**
 * 时间感 —— 茶话会自己的一块表。
 *
 * 以前伙伴是完全不知道时间的：ta不知道现在几点、不知道距上次说话过了多久，
 * 于是凌晨回一句"早上好"、隔了三天回来像刚说完一样接着聊。这些不像人。
 *
 * 这块表只做一件事：把「现在」和她那条时间线，说成人话递给ta。
 * 不说"该问早安"、不说"该关心她熬夜"——那是ta的判断，不是我们的规矩。
 */

import { dozingNow, sleepWindows } from "./sleep.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MINUTE = 60 * 1000;

/** 距睡点还有这么久就算困了（分钟）。 */
const DROWSY_LEAD_MINUTES = 60;
/** 醒过来这么久以内还算懵着（分钟）。 */
const JUST_WOKE_MINUTES = 45;
/** 午觉前这么久开始犯困（分钟）。 */
const NAP_LEAD_MINUTES = 30;

const toMinutes = (clock) => {
  const [h, m] = String(clock ?? "").split(":");
  return Number(h) * 60 + Number(m);
};
const nowMinutes = (date) => date.getHours() * 60 + date.getMinutes();

/** 本地日：YYYY-MM-DD。 */
export function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 一天里的哪一段。分界按人说话的习惯划，不按名义上的早中晚。 */
export function dayPartOf(date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes < 5 * 60) return "凌晨";
  if (minutes < 7 * 60) return "清早";
  if (minutes < 9 * 60) return "早上";
  if (minutes < 12 * 60) return "上午";
  if (minutes < 13 * 60) return "中午";
  if (minutes < 17 * 60 + 30) return "下午";
  if (minutes < 19 * 60) return "傍晚";
  if (minutes < 23 * 60) return "晚上";
  return "深夜";
}

/** 钟点说成人话：凌晨 3 点 12 分 / 中午 12 点 / 晚上 9 点 08 分。 */
export function spokenClock(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const hour = h % 12 === 0 ? 12 : h % 12;
  let text = `${hour} 点`;
  if (m > 0) text += m < 10 ? ` 0${m} 分` : ` ${m} 分`;
  return `${dayPartOf(date)} ${text}`;
}

/** 过了多久，说成人话：刚刚 / 25 分钟 / 6 小时 / 3 天。 */
export function spokenGap(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < MINUTE) return "刚刚";
  const minutes = Math.round(value / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = value / (60 * MINUTE);
  if (hours < 24) {
    // 一个钟头出头那一段说「1 个多小时」比「2 小时」准
    if (hours < 1.5) return "1 个多小时";
    return `${Math.round(hours)} 小时`;
  }
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

/**
 * ta自己这会儿困不困——按ta自个儿的作息算，跟外面的提醒无关。
 *
 * 正睡着那一档不在这里说（那是「被吵醒」那段的话，两边都开口会变成夹击）。
 * 说的是人话，不说「该睡了」；困是ta自己的事，不是给她的提醒。
 */
export function drowsyLine({ now = new Date(), sleep = null } = {}) {
  const windows = sleepWindows(sleep, now);
  if (!windows.length) return "";
  if (dozingNow(now, sleep).dozing) return "";
  const main = windows.find((w) => w.kind === "main");
  if (!main) return "";

  const untilSleep = (toMinutes(main.start) - nowMinutes(now) + 1440) % 1440;
  if (untilSleep <= 2) {
    return "按你自己的作息，这会儿已经到你的睡点了，眼皮撑不太住。（困了就直说，撑不住先睡，她不会怪你。）";
  }
  if (untilSleep <= DROWSY_LEAD_MINUTES) {
    return `按你自己的作息，再过 ${untilSleep} 分钟就是你平时睡的点，这会儿已经困上来了。（困了就直说，撑不住先睡，她不会怪你。）`;
  }

  const sinceWake = (nowMinutes(now) - toMinutes(main.end) + 1440) % 1440;
  if (sinceWake <= JUST_WOKE_MINUTES) {
    return "你刚醒没多久，人还有点没缓过来。";
  }

  const nap = windows.find((w) => w.kind === "nap");
  if (nap) {
    const untilNap = (toMinutes(nap.start) - nowMinutes(now) + 1440) % 1440;
    if (untilNap <= NAP_LEAD_MINUTES) {
      return `按你自己的作息，你平时这会儿要眯一下的（${nap.start} 前后），这会儿已经有点迷糊了。（困了就直说，撑不住先睡，她不会怪你。）`;
    }
  }
  return "";
}

/**
 *
 * @param {object} input
 * @param {Date}   input.now
 * @param {Array}  input.messages  这个人的聊天记录（按时间正序，带 role 和 at）
 * @param {string} [input.userName]
 * @param {object} [input.sleep]   这位伙伴自己的作息
 * @returns {string} 空字符串 = 没什么可说的（不该出现，先兜住）
 */
export function timeBlock({ now = new Date(), messages = [], userName = "她", sleep = null, currentMessageId = null } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "";
  const lines = [
    "【现在】",
    `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日，${WEEKDAYS[now.getDay()]}，${spokenClock(now)}。`,
  ];

  // ta自己的状态（困不困），跟上面的钟点是两回事：钟点是事实，困是ta身上的
  const drowsy = drowsyLine({ now, sleep });
  if (drowsy) lines.push(drowsy);

  const rows = (Array.isArray(messages) ? messages : [])
    .filter((row) => row && typeof row.at === "string" && !Number.isNaN(new Date(row.at).getTime()))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const last = rows[rows.length - 1];
  const current = currentMessageId ? rows.find((row) => row.id === currentMessageId) : null;

  if (current) {
    const currentAt = new Date(current.at);
    const gap = spokenGap(now - currentAt) || "刚刚";
    const currentDate = dateKey(currentAt);
    if (currentDate !== dateKey(now) || now - currentAt >= 10 * MINUTE) {
      lines.push(`【这次接话】你正在回复${userName}在 ${currentDate} ${spokenClock(currentAt)} 发来的消息；现在已经过去 ${gap}。`);
      lines.push("这只是时间事实。是否提到这段间隔、怎么提到，由你自己的性格和关系决定，不要固定套用某种说法。");
    }
  }

  if (last) {
    const gap = spokenGap(now - new Date(last.at)) || "刚刚";
    if (last.role === "assistant") {
      // 她还没回ta：ta自己心里有数，这也正好是「等回音」那套的底气
      lines.push(`你上一句发出去 ${gap}了，${userName}还没回。`);
    } else {
      lines.push(`${userName}上一条是 ${gap}前发的。`);
    }
  }

  const todayKey = dateKey(now);
  const todayFromHer = rows.filter(
    (row) => row.role === "user" && dateKey(new Date(row.at)) === todayKey,
  ).length;
  if (todayFromHer === 0) lines.push(`今天${userName}还没开口。`);
  else if (todayFromHer === 1) lines.push(`今天${userName}只说了一句。`);
  else lines.push(`今天${userName}已经说了 ${todayFromHer} 句。`);

  lines.push(
    "（这是背景。别报时间、别拿它编故事、同一件事别提第二遍。顺口一句「这么晚还不睡」是自然的，但别把它变成每轮的开场。）",
  );
  return lines.join("\n");
}
