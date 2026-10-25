import test from "node:test";
import assert from "node:assert/strict";
import {
  LOW_LINE, MOOD_GRID, MOOD_WEIGHTS, STREAK_LIMIT,
  EVENT_FLOOR, applyDayEvent, dailyNoise,
  reactionDelta, emptyMoodDay, moodBrief, moodById,
  nextStreak, pickGrid, readMoodDay, settleDay, sleepOffset,
} from "../lib/mood-daily.js";

const at = (iso) => new Date(iso);

test("同一天同一个伙伴，结算几次都是同一个心情", () => {
  const opts = { now: at("2026-10-24T09:00:00+08:00"), agentId: "hanako", sleepHours: 6.5 };
  const a = settleDay(null, opts);
  const b = settleDay(null, opts);
  assert.equal(a.moodId, b.moodId);
  assert.equal(a.intensity, b.intensity);
  assert.equal(a.valence, b.valence);
});

test("换一天就换一个运气：一百天里至少出现三种心情", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const now = new Date(Date.UTC(2026, 0, 1 + i, 1, 0, 0));
    seen.add(settleDay(null, { now, agentId: "hanako" }).moodId);
  }
  assert.ok(seen.size >= 3, `一百天只落了 ${seen.size} 种`);
});

test("不同伙伴同一天不是同一个心情", () => {
  const now = at("2026-10-24T09:00:00+08:00");
  const ids = ["hanako", "alpha", "beta", "gamma"];
  const moods = new Set(ids.map((agentId) => settleDay(null, { now, agentId }).moodId));
  assert.ok(moods.size >= 2, "四个人同一天全是同一个心情，那就不叫各过各的");
});

test("说不清那部分落在 -1..1，同一天稳定", () => {
  const now = at("2026-10-24T09:00:00+08:00");
  const a = dailyNoise(now, "hanako");
  assert.equal(a, dailyNoise(now, "hanako"));
  assert.ok(a >= -1 && a <= 1);
  const next = at("2026-10-25T09:00:00+08:00");
  assert.notEqual(a, dailyNoise(next, "hanako"));
});

test("睡得够睡得好，睡得少偏沉", () => {
  assert.equal(sleepOffset(0), 0, "没数据不多不少");
  assert.ok(sleepOffset(7.5) > sleepOffset(5));
  assert.ok(sleepOffset(4.5) < 0);
  assert.ok(sleepOffset(20) <= 0.5);
});

test("大样本分布偏暖：低落是少数日子，需要哄的极少", () => {
  const tally = {};
  const N = 4000;
  for (let i = 0; i < N; i += 1) {
    const now = new Date(Date.UTC(2026, 0, 1 + (i % 365), 1, 0, 0));
    const day = settleDay(null, { now, agentId: `a${i}` });
    tally[day.moodId] = (tally[day.moodId] ?? 0) + 1;
  }
  const share = (ids) => ids.reduce((sum, id) => sum + (tally[id] ?? 0), 0) / N;
  const warm = share(["happy", "calm", "bliss", "excited", "moved", "missing"]);
  const askCare = share(["hurt", "angry"]);
  assert.ok(warm > 0.62, `暖的日子只占 ${(warm * 100).toFixed(1)}%`);
  assert.ok(askCare < 0.09, `要哄的日子占 ${(askCare * 100).toFixed(1)}%，太多了`);
});

test("连着沉两天，第三天拉回中性以上", () => {
  const low = { ...emptyMoodDay("2026-10-22"), moodId: "sad", valence: -2, streak: STREAK_LIMIT, settledAt: "2026-10-22T20:00:00.000Z" };
  for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) {
    const now = at("2026-10-23T09:00:00+08:00");
    const day = settleDay(low, { now, agentId: id, sleepHours: 4.5 });
    assert.ok(day.valence >= -0.4, `${id} 第三天落到 ${day.label ?? day.moodId}(${day.valence})，没拉回来`);
  }
});

test("事件只动浓淡：一句好话不能让她从委屈变成幸福", () => {
  const day = { ...emptyMoodDay("2026-10-24"), moodId: "hurt", valence: -1.8, intensity: 0.6, settledAt: "2026-10-24T00:00:00.000Z" };
  const next = applyDayEvent(day, { delta: 0.3 });
  assert.equal(next.moodId, "hurt", "一句好话不该换格");
  assert.ok(next.valence > day.valence);
});

test("攒够了才换格", () => {
  const day = { ...emptyMoodDay("2026-10-24"), moodId: "calm", valence: 0, intensity: 0.4, settledAt: "2026-10-24T00:00:00.000Z" };
  let current = day;
  for (let i = 0; i < 6; i += 1) current = applyDayEvent(current, { delta: 0.35 });
  assert.notEqual(current.moodId, "calm");
  assert.ok(current.valence > 1.5);
});

test("往下掉比往上快", () => {
  const day = { ...emptyMoodDay("2026-10-24"), moodId: "calm", valence: 0, intensity: 0.4, settledAt: "2026-10-24T00:00:00.000Z" };
  const down = applyDayEvent(day, { delta: -0.6 });
  const up = applyDayEvent(day, { delta: 0.35 });
  assert.ok(Math.abs(down.valence) > Math.abs(up.valence));
});

test("连续低落天数只数沉、不数暖", () => {
  assert.equal(nextStreak({ ...emptyMoodDay("2026-10-24"), valence: -1.2, streak: 1 }), 2);
  assert.equal(nextStreak({ ...emptyMoodDay("2026-10-24"), valence: 1.2, streak: 2 }), 0);
  assert.equal(nextStreak({ ...emptyMoodDay("2026-10-24"), valence: LOW_LINE - 0.01, streak: 0 }), 1);
});

test("给生成用的话里不出现数字，也不许出现哄人求助", () => {
  for (const mood of MOOD_GRID) {
    const line = moodBrief({ ...emptyMoodDay("2026-10-24"), moodId: mood.id, intensity: 0.8 });
    assert.equal(typeof line, "string");
    assert.ok(line.length > 0);
    assert.doesNotMatch(line, /\d/, `${mood.label} 的说明里带了数字`);
    assert.doesNotMatch(line, /哄|安慰我|你都不|陪陪我/u, `${mood.label} 的说明在索取`);
  }
});

test("账本字段坏了也不抛", () => {
  const day = readMoodDay({ moodId: "乱写", intensity: "很大", valence: null, streak: -3, events: "几次" });
  assert.equal(day.moodId, "calm");
  assert.equal(day.intensity, 0.5);
  assert.equal(day.streak, 0);
  assert.equal(day.events, 0);
  assert.deepEqual(readMoodDay(null), emptyMoodDay());
});

test("抽签不会掉到权重为零的格外面", () => {
  for (const r of [0, 0.01, 0.5, 0.99, 0.999999]) {
    const id = pickGrid(0, r);
    assert.ok(moodById(id), `${r} 抽出了不存在的格 ${id}`);
  }
});

test("从一句话读力度：重的掉得多，夸的涨得少，拿不准就不动", () => {
  assert.equal(reactionDelta("你都不管我，我伤心了"), -0.6);
  assert.equal(reactionDelta("你老给我推这个，我都看不懂！"), -0.35);
  assert.equal(reactionDelta("闺闺抱抱我"), 0.3);
  assert.ok(reactionDelta("今天试了一下那个长截图，整页都撑开了，看着比之前舒服很多，界面也比原来那个版本清爽") > 0);
  assert.equal(reactionDelta("嗯"), 0.05);
  assert.equal(reactionDelta(""), 0);
  assert.equal(reactionDelta("在写代码"), 0);
});

test("白天的单句话掉不到委屈和生气：那两格只从日盘来", () => {
  let day = { ...emptyMoodDay("2026-10-24"), moodId: "calm", valence: 0, intensity: 0.4, settledAt: "2026-10-24T00:00:00.000Z" };
  for (let i = 0; i < 20; i += 1) day = applyDayEvent(day, { delta: -1 });
  assert.ok(day.valence >= EVENT_FLOOR, `掉到 ${day.valence} 了`);
  assert.notEqual(day.moodId, "hurt");
  assert.notEqual(day.moodId, "angry");
});

