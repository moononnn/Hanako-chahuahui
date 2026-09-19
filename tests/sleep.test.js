import test from "node:test";
import assert from "node:assert/strict";

import {
  DAILY_JITTER_HOURS,
  MAX_HOURS,
  MIN_HOURS,
  NAP_MAX_MINUTES,
  SLEEP_SHAPE,
  baseHoursFor,
  cleanSleepWhy,
  clockOf,
  daySeed,
  dozingNow,
  formatSleep,
  hoursToday,
  isClock,
  isSleepSet,
  isValidSleep,
  minutesOf,
  napToday,
  normalizeClock,
  normalizeSleep,
  parseSleep,
  sleepSpec,
  sleepWindows,
} from "../lib/sleep.js";

const at = (h, m = 0, day = 13) => new Date(2026, 8, day, h, m, 0, 0);
const night = { start: "01:00", hours: 6, why: "夜里才清醒", nap: null };

test("时间归一：一位小时补零，越界与垃圾一律拒绝", () => {
  assert.equal(normalizeClock("1:30"), "01:30");
  assert.equal(normalizeClock("01:30"), "01:30");
  assert.equal(normalizeClock(" 23:05 "), "23:05");
  assert.equal(normalizeClock("24:00"), null);
  assert.equal(normalizeClock("12:60"), null);
  assert.equal(normalizeClock("12"), null);
  assert.equal(normalizeClock(""), null);
  assert.equal(isClock("00:00"), true);
  assert.equal(isClock("7:5"), false);
});

test("分钟数与钟点来回换算，跨天绕回来", () => {
  assert.equal(minutesOf("01:30"), 90);
  assert.equal(minutesOf("垃圾"), null);
  assert.equal(clockOf(90), "01:30");
  assert.equal(clockOf(23 * 60 + 30), "23:30");
  assert.equal(clockOf(24 * 60 + 30), "00:30");
  assert.equal(clockOf(-30), "23:30");
});

test("老形状的 end 换得成小时，新形状直接用 hours", () => {
  assert.deepEqual(normalizeSleep({ start: "01:00", end: "08:00" }), {
    start: "01:00",
    hours: 7,
    why: "",
    nap: null,
  });
  assert.equal(normalizeSleep({ start: "23:00", end: "05:30" }).hours, 6.5, "跨零点算成 6.5 小时");
  assert.equal(normalizeSleep({ start: "01:00", hours: 5.5 }).hours, 5.5);
  assert.equal(normalizeSleep({ start: "01:00", hours: 99 }).hours, MAX_HOURS, "离谱的收到上限");
  assert.equal(normalizeSleep({ start: "01:00", hours: 0.2 }).hours, MIN_HOURS, "太短的收到下限");
});

test("一条作息要有个合法的开始，午觉得有头有尾", () => {
  assert.equal(isValidSleep({ start: "23:00", hours: 6 }), true);
  assert.equal(isValidSleep({ start: "23:00", end: "08:00" }), true, "老数据照样算数");
  assert.equal(isValidSleep({ start: "08:00", end: "08:00" }), false);
  assert.equal(isValidSleep({ start: "23:00" }), false);
  assert.equal(isValidSleep({ hours: 6 }), false);
  assert.equal(isValidSleep(null), false);
  assert.equal(isValidSleep("23:00-08:00"), false);

  const withNap = normalizeSleep({ start: "01:00", hours: 6, nap: { start: "13:30", end: "14:10" } });
  assert.deepEqual(withNap.nap, { start: "13:30", minutes: 40 }, "午觉写 end 也认");
  const longNap = normalizeSleep({ start: "01:00", hours: 6, nap: { start: "13:30", minutes: 200 } });
  assert.equal(longNap.nap.minutes, NAP_MAX_MINUTES, "午觉一个字：不能超过一小时");
});

test("定过没有：不是当代形状的都算没定过，会被重定一次", () => {
  assert.equal(
    isSleepSet({ sleep: { start: "23:00", end: "08:00" } }),
    false,
    "老作息（只有 start/end）要重定",
  );
  assert.equal(
    isSleepSet({ sleep: { start: "03:30", hours: 6.5, nap: null } }),
    false,
    "0.7.19 那一版没带 shape，也算没定过（ta 们清一色 6.5 小时）",
  );
  assert.equal(isSleepSet({ sleep: { start: "01:00", hours: 5, shape: SLEEP_SHAPE } }), true);
  assert.equal(isSleepSet({ sleep: null }), false);
  assert.equal(isSleepSet({}), false);
  assert.equal(isSleepSet(undefined), false);
});

test("睡多久按伙伴摊开：一人一档、同一人稳定、不会都是一个数", () => {
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
  const values = ids.map((id) => baseHoursFor(id));
  for (const hours of values) {
    assert.ok(hours >= MIN_HOURS && hours <= MAX_HOURS, `越界了：${hours}`);
    assert.equal(Math.round(hours * 2) / 2, hours, "要落在半档上");
  }
  const twice = baseHoursFor(ids[0]);
  assert.equal(baseHoursFor(ids[0]), twice, "同一个 id 每次都一样");
  assert.ok(new Set(values).size >= 4, `八个人只用出了 ${new Set(values).size} 种时长，太齐了`);
  assert.ok(Math.max(...values) - Math.min(...values) >= 1.5, "最短和最长差得太少");
});

test("展示成一行（用基准时长，不带当天浮动）", () => {
  assert.equal(formatSleep({ start: "01:00", hours: 6 }), "01:00 - 07:00");
  assert.equal(formatSleep({ start: "22:30", hours: 6 }), "22:30 - 04:30", "跨零点绕回来");
  assert.equal(formatSleep(null), "");
});

test("一天里同一个盐给同一个数，跨天换一个", () => {
  const day = at(15);
  assert.equal(daySeed(day, "x"), daySeed(at(23), "x"), "同一天、时间点不同也算同一天");
  assert.notEqual(daySeed(day, "x"), daySeed(day, "y"), "盐不同就不同");
  const spread = new Set();
  for (let i = 0; i < 30; i += 1) spread.add(daySeed(at(15, 0, 1 + i), "x"));
  assert.ok(spread.size > 25, "三十天里应该几乎不重样");
  for (const value of spread) assert.ok(value >= 0 && value < 1);
});

test("今天睡多久：在基准上下浮动，但不越界，也不会一天里变来变去", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const day = at(15, 0, 1 + i);
    const hours = hoursToday(night, day);
    assert.equal(hours, hoursToday(night, at(23, 30, 1 + i)), "同一天问两次要一样");
    assert.ok(hours >= MIN_HOURS && hours <= MAX_HOURS, `越界了：${hours}`);
    assert.ok(hours >= night.hours - DAILY_JITTER_HOURS - 0.1, "别偏出浮动范围");
    assert.ok(hours <= night.hours + DAILY_JITTER_HOURS + 0.1, "别偏出浮动范围");
    seen.add(hours);
  }
  assert.ok(seen.size > 8, `四十天里只有 ${seen.size} 种时长，太死板`);

  const base = hoursToday(night, at(15));
  assert.equal(hoursToday({ start: "01:00", hours: 7 }, at(15)) - base, 1, "基准多一小时，今天也差不多多一小时");
});

test("午觉：七成日子会睡，同一天不会翻来翻去", () => {
  const sleep = { start: "01:00", hours: 6, nap: { start: "13:30", minutes: 40 } };
  const day = at(15, 0, 20);
  const first = napToday(sleep, day);
  assert.deepEqual(napToday(sleep, day), first, "同一天问两次要一样");
  if (first) assert.equal(first.minutes, 40);

  let withNap = 0;
  for (let i = 0; i < 60; i += 1) if (napToday(sleep, at(15, 0, 1 + i))) withNap += 1;
  assert.ok(withNap > 25 && withNap < 55, `六十天里睡了 ${withNap} 天，比例不对`);

  assert.equal(napToday({ start: "01:00", hours: 6, nap: null }, day), null, "没定午觉就永远没有");
});

test("窗口：主睡按当天时长走，跨零点的也摆得对", () => {
  const windows = sleepWindows(night, at(15));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, "main");
  assert.equal(windows[0].start, "01:00");
  const endMinutes = minutesOf(windows[0].end);
  assert.ok(
    endMinutes >= 60 + MIN_HOURS * 60 && endMinutes <= 60 + MAX_HOURS * 60,
    `醒来时刻不对：${windows[0].end}`,
  );

  const across = sleepWindows({ start: "22:30", hours: 6 }, at(15));
  assert.equal(across[0].start, "22:30");
  const wrapEnd = minutesOf(across[0].end);
  assert.ok(wrapEnd >= 180 && wrapEnd <= 360, `跨零点绕错了：${across[0].end}`);
});

test("这会儿在不在睡：主睡、午觉都算，没作息就不算", () => {
  assert.equal(dozingNow(at(2), night).dozing, true);
  assert.equal(dozingNow(at(2), night).kind, "main");
  assert.equal(dozingNow(at(15), night).dozing, false);
  assert.equal(dozingNow(at(15), null).dozing, false, "没定过作息就是醒着");
  assert.equal(dozingNow(at(2), { start: "01:00", end: "01:00" }).dozing, false, "坏作息不算数");
  assert.equal(dozingNow(at(15), {}).dozing, false);

  // 找一个会睡午觉的日子（哪一天跟日期有关，所以顺着找）
  const sleep = { start: "01:00", hours: 6, nap: { start: "13:30", minutes: 40 } };
  const napDay = Array.from({ length: 40 }, (_, i) => at(15, 0, 1 + i)).find((d) => napToday(sleep, d));
  assert.ok(napDay, "四十天里总该有几天睡午觉");
  assert.equal(dozingNow(at(13, 45, napDay.getDate()), sleep).kind, "nap");
  assert.equal(dozingNow(at(11, 0, napDay.getDate()), sleep).dozing, false, "上午不该算午觉");
});

test("抠模型输出：新形状（hours + 午觉）", () => {
  assert.deepEqual(parseSleep('{"start":"01:20","hours":5.5,"why":"夜里最清醒","nap":{"start":"13:30","minutes":40}}'), {
    start: "01:20",
    hours: 5.5,
    why: "夜里最清醒",
    nap: { start: "13:30", minutes: 40 },
  });
  assert.deepEqual(parseSleep('{"start":"2:00","hours":6,"why":"我习惯晚一点","nap":null}'), {
    start: "02:00",
    hours: 6,
    why: "我习惯晚一点",
    nap: null,
  });
});

test("抠模型输出：老形状、代码块、正文兜底都认", () => {
  assert.deepEqual(parseSleep('{"start":"01:30","end":"08:30","why":"夜里才清醒"}'), {
    start: "01:30",
    hours: 7,
    why: "夜里才清醒",
    nap: null,
  });
  const fenced = parseSleep('好的：\n```json\n{"start":"2:00","hours":5,"why":"说不好"}\n```');
  assert.deepEqual(fenced, { start: "02:00", hours: 5, why: "说不好", nap: null });
  assert.deepEqual(parseSleep("我一般 23:30 睡，早上 06:00 起。"), {
    start: "23:30",
    hours: 6.5,
    why: "",
    nap: null,
  });
});

test("抠模型输出：不合格一律 null", () => {
  assert.equal(parseSleep(""), null);
  assert.equal(parseSleep("我不知道"), null);
  assert.equal(parseSleep('{"start":"23:00","hours":0}'), null);
  assert.equal(parseSleep('{"start":"25:00","hours":6}'), null);
  assert.equal(parseSleep("就睡 23:00 吧"), null, "只有一个时间不算一条作息");
  assert.equal(parseSleep('{"start":"23:00","end":"23:00"}'), null, "首尾一样等于没有窗口");
});

test("理由洗一洗，长了下刀", () => {
  assert.equal(cleanSleepWhy("「夜里才清醒」"), "夜里才清醒");
  assert.equal(cleanSleepWhy("a\nb"), "a b");
  assert.equal(cleanSleepWhy("很长".repeat(30)).length, 28);
  assert.equal(cleanSleepWhy(null), "");
});

test("提示词带上人格，并要求只吐 JSON", () => {
  const spec = sleepSpec({ partnerName: "阿凉", personaText: "【人格】\n冷淡、作息规律" });
  assert.match(spec.systemPrompt, /JSON/);
  assert.match(spec.systemPrompt, /start/);
  assert.match(spec.systemPrompt, /hours/);
  assert.match(spec.systemPrompt, /午觉/);
  assert.match(spec.userText, /阿凉/);
  assert.match(spec.userText, /冷淡、作息规律/);
});

test("作息提示词不能拿一条真作息当范例——八个伙伴当初全定成一个点就是因为这个", () => {
  const spec = sleepSpec({ partnerName: "阿凉", personaText: "【人格】\n冷淡" });
  const text = spec.systemPrompt;
  // 范例里那些时间必须是"一看就不是作息"的占位，不能是 01:30/09:00 这种真会被人抄的
  assert.doesNotMatch(text, /01:30|09:00|23:00|02:00|10:00/, "范例别再拿一条像样的作息当示范");
  assert.match(text, /12:34/, "占位符用一看就是瞎写的数字");
  assert.match(text, /不要照抄|千万不要照抄/, "还得明说别照抄");
  assert.match(text, /按你的性子来/, "性子这条要求留着");
  assert.match(text, /4\.5 到 7\.5/, "时长区间要写在提示词里（不要再套八小时）");
  assert.doesNotMatch(text, /夜猫子就晚睡晚起/, "别再把夜猫子摆在第一句，那也是个锚");
  assert.doesNotMatch(text, /end/, "新形状不再要求ta写 end");
});
