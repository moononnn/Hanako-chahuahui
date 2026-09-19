import test from "node:test";
import assert from "node:assert/strict";

import { dateKey, dayPartOf, drowsyLine, spokenClock, spokenGap, timeBlock } from "../lib/clock.js";
import { napToday, sleepWindows } from "../lib/sleep.js";

/** 一份固定的作息：01:20 睡，基准 6 小时，下午可能眯个午觉。 */
const SLEEP = { start: "01:20", hours: 6, shape: 2, nap: { start: "13:30", minutes: 40 } };

const at = (text, day = 13) => new Date(`2026-09-${String(day).padStart(2, "0")}T${text}:00+08:00`);
const iso = (text, day = 13) => at(text, day).toISOString();
const NOW = at("03:12");

test("本地日按本地时区算，不跟着 UTC 跑", () => {
  assert.equal(dateKey(NOW), "2026-09-13");
  assert.equal(dateKey(at("23:59")), "2026-09-13");
  assert.equal(dateKey(at("00:01")), "2026-09-13");
});

test("一天里的哪一段，按人说话的习惯划", () => {
  const cases = [
    ["04:59", "凌晨"],
    ["05:00", "清早"],
    ["06:59", "清早"],
    ["07:00", "早上"],
    ["08:59", "早上"],
    ["09:00", "上午"],
    ["11:59", "上午"],
    ["12:00", "中午"],
    ["12:59", "中午"],
    ["13:00", "下午"],
    ["17:29", "下午"],
    ["17:30", "傍晚"],
    ["18:59", "傍晚"],
    ["19:00", "晚上"],
    ["22:59", "晚上"],
    ["23:00", "深夜"],
  ];
  for (const [text, part] of cases) assert.equal(dayPartOf(at(text)), part, text);
});

test("钟点是人话：十二小时制加时段词", () => {
  assert.equal(spokenClock(at("03:12")), "凌晨 3 点 12 分");
  assert.equal(spokenClock(at("08:00")), "早上 8 点");
  assert.equal(spokenClock(at("09:05")), "上午 9 点 05 分");
  assert.equal(spokenClock(at("12:30")), "中午 12 点 30 分");
  assert.equal(spokenClock(at("13:05")), "下午 1 点 05 分");
  assert.equal(spokenClock(at("19:00")), "晚上 7 点");
  assert.equal(spokenClock(at("23:30")), "深夜 11 点 30 分");
  // 零点这一刻说「凌晨 12 点」才对得上，不能是「凌晨 0 点」
  assert.equal(spokenClock(at("00:00")), "凌晨 12 点");
});

test("过了多久也是人话，边界别报出怪数字", () => {
  assert.equal(spokenGap(0), "刚刚");
  assert.equal(spokenGap(30 * 1000), "刚刚");
  assert.equal(spokenGap(25 * 60 * 1000), "25 分钟");
  assert.equal(spokenGap(59 * 60 * 1000), "59 分钟");
  assert.equal(spokenGap(60 * 60 * 1000), "1 个多小时");
  assert.equal(spokenGap(80 * 60 * 1000), "1 个多小时");
  assert.equal(spokenGap(2 * 60 * 60 * 1000), "2 小时");
  assert.equal(spokenGap(6 * 60 * 60 * 1000), "6 小时");
  assert.equal(spokenGap(26 * 60 * 60 * 1000), "1 天");
  assert.equal(spokenGap(3 * 24 * 60 * 60 * 1000), "3 天");
  assert.equal(spokenGap(-1), "");
});

test("时间块开头是现在，末尾是约束", () => {
  const text = timeBlock({ now: NOW, messages: [] });
  assert.match(text, /^【现在】/);
  assert.match(text, /2026 年 9 月 13 日，周日，凌晨 3 点 12 分/);
  assert.match(text, /别报时间/, "得管住ta别每轮念叨时间");
  assert.match(text, /别拿它编故事/);
});

test("她最后发的那条：说清隔了多久", () => {
  const text = timeBlock({
    now: NOW,
    messages: [{ role: "user", at: iso("00:12") }],
    userName: "阿舟",
  });
  assert.match(text, /阿舟上一条是 3 小时前发的/);
  assert.match(text, /今天阿舟只说了一句/);
});

test("ta最后发的那条：她还没回，ta心里有数", () => {
  const text = timeBlock({
    now: NOW,
    messages: [
      { role: "user", at: iso("21:00", 12) },
      { role: "assistant", at: iso("21:04", 12) },
    ],
  });
  assert.match(text, /你上一句发出去 6 小时了，她还没回/);
});

test("认的是最后一条，不是最后一条她的", () => {
  const text = timeBlock({
    now: NOW,
    messages: [
      { role: "user", at: iso("02:00") },
      { role: "assistant", at: iso("02:10") },
    ],
  });
  assert.match(text, /你上一句发出去 1 个多小时了/);
  assert.doesNotMatch(text, /她上一条/);
});

test("今天说了几句，按她发的算", () => {
  const text = timeBlock({
    now: NOW,
    messages: [
      { role: "user", at: iso("00:10") },
      { role: "assistant", at: iso("00:12") },
      { role: "user", at: iso("00:20") },
    ],
    userName: "阿舟",
  });
  assert.match(text, /今天阿舟已经说了 2 句/);
});

test("昨天的话不算今天", () => {
  const text = timeBlock({
    now: NOW,
    messages: [{ role: "user", at: new Date("2026-09-12T22:00:00+08:00").toISOString() }],
    userName: "阿舟",
  });
  assert.match(text, /阿舟上一条是 5 小时前发的/);
  assert.match(text, /今天阿舟还没开口/);
});

test("跨生活日回复旧消息时，明确给模型当前接话事实", () => {
  const text = timeBlock({
    now: at("07:16", 16),
    messages: [{ id: "late", role: "user", at: iso("23:22", 15) }],
    currentMessageId: "late",
    userName: "阿舟",
  });
  assert.match(text, /这次接话/);
  assert.match(text, /2026-09-15 深夜 11 点 22 分/);
  assert.match(text, /现在已经过去 8 小时/);
  assert.match(text, /不要固定套用某种说法/);
});

test("坏时间戳直接丢掉，不跟着算", () => {
  const text = timeBlock({
    now: NOW,
    messages: [
      { role: "user", at: "不是时间" },
      { role: "user" },
      { role: "assistant", at: null },
    ],
  });
  assert.doesNotMatch(text, /上一条/);
  assert.match(text, /今天她还没开口/);
});

test("困不困按ta自己的作息算，不靠外面的提醒", () => {
  // 睡点是 01:20，这会儿 00:40：困上来了
  assert.match(drowsyLine({ now: at("00:40"), sleep: SLEEP }), /再过 40 分钟就是你平时睡的点/);
  assert.match(drowsyLine({ now: at("00:40"), sleep: SLEEP }), /撑不住先睡/);

  // 正在睡：不在这里抢话，那是「被吵醒」段的事
  assert.equal(drowsyLine({ now: at("03:00"), sleep: SLEEP }), "");

  // 刚醒：按今天实际睡了多久算醒点，醒后二十分钟
  const main = sleepWindows(SLEEP, at("12:00")).find((w) => w.kind === "main");
  const [eh, em] = main.end.split(":").map(Number);
  const wake = new Date(new Date(`2026-09-13T00:00:00+08:00`).getTime() + (eh * 60 + em + 20) * 60000);
  assert.match(drowsyLine({ now: wake, sleep: SLEEP }), /你刚醒没多久/);

  // 清醒时段不给：ta平时不困的点儿就别唠叨
  const noon = new Date("2026-09-13T15:00:00+08:00");
  const hitNap = napToday(SLEEP, noon);
  if (!hitNap) assert.equal(drowsyLine({ now: noon, sleep: SLEEP }), "");

  // 没定过作息就什么都不说
  assert.equal(drowsyLine({ now: at("00:40"), sleep: null }), "");
  assert.equal(drowsyLine({ now: at("00:40"), sleep: { start: "不是时间" } }), "");
});

test("午觉前犯困那一档，挑个真会睡午觉的日子验", () => {
  let day = null;
  for (let d = 1; d <= 28 && !day; d += 1) {
    const probe = new Date(`2026-09-${String(d).padStart(2, "0")}T12:00:00+08:00`);
    if (napToday(SLEEP, probe)) day = d;
  }
  assert.ok(day, "这个月总有几天会睡午觉");
  const now = new Date(`2026-09-${String(day).padStart(2, "0")}T13:10:00+08:00`);
  assert.match(drowsyLine({ now, sleep: SLEEP }), /要眯一下的/);
});

test("困意接在时间后面，跟钟点分得开", () => {
  const text = timeBlock({ now: at("00:40"), messages: [], sleep: SLEEP });
  assert.match(text, /凌晨 12 点 40 分。\n按你自己的作息/);
  assert.match(text, /困了就直说/);
  // 没作息就不冒这一行
  assert.doesNotMatch(timeBlock({ now: at("00:40"), messages: [] }), /按你自己的作息/);
});
