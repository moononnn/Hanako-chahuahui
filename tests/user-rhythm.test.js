import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUserRhythm, lateStartCue, userRhythmText } from "../lib/user-rhythm.js";

const row = (day, time, text = "早安哈~") => ({
  role: "user",
  at: `2026-09-${String(day).padStart(2, "0")}T${time}:00+08:00`,
  text,
});

test("数据不足时不硬凑生活节拍", () => {
  const profile = analyzeUserRhythm([row(1, "08:00"), row(2, "08:10")]);
  assert.equal(profile.ready, false);
  assert.equal(userRhythmText([row(1, "08:00")]), "");
});

test("同一天刷够消息也不能直接建立生活节拍", () => {
  const messages = Array.from({ length: 8 }, (_, i) => row(1, `08:${String(i).padStart(2, "0")}`));
  const profile = analyzeUserRhythm(messages);
  assert.equal(profile.ready, false);
  assert.equal(profile.distinctDays, 1);
});

test("从用户自己的发言提取常见时段，并按工作日分组", () => {
  const messages = [
    row(1, "08:00"), row(2, "08:20"), row(3, "08:10"), row(4, "08:30"),
    row(5, "08:00"), row(6, "23:30", "我睡啦"), row(7, "23:40", "晚安"), row(8, "08:15"),
  ];
  const profile = analyzeUserRhythm(messages);
  assert.equal(profile.ready, true);
  assert.match(profile.usualWindow.start, /^08:/);
  assert.ok(Object.keys(profile.weekdayWindows).length > 0);
});

test("早晚两个离散高峰不会被合并成横跨全天的窗口", () => {
  const messages = [
    row(1, "08:00"), row(2, "08:10"), row(3, "08:20"), row(4, "08:30"),
    row(5, "23:30"), row(6, "23:40"), row(7, "23:50"), row(8, "23:55"),
  ];
  const profile = analyzeUserRhythm(messages);
  assert.equal(profile.ready, true);
  assert.equal(profile.usualWindow.start, "08:00");
  assert.ok(profile.usualWindow.end < "10:00");
});

test("语气词变化只作为弱信号，且要有足够样本", () => {
  const messages = [
    ...Array.from({ length: 6 }, (_, i) => row(i + 1, "08:00", "今天处理点事情")),
    ...Array.from({ length: 6 }, (_, i) => row(i + 10, "08:00", "哈哈啦~")),
  ];
  const profile = analyzeUserRhythm(messages);
  assert.equal(profile.style.changed, true);
  assert.equal(profile.style.direction, "lighter");
  assert.match(userRhythmText(messages), /弱信号/);
});

test("今天没有出现且明显晚于平时才生成迟到观察", () => {
  const messages = [
    row(1, "08:00"), row(2, "08:20"), row(3, "08:10"), row(4, "08:30"),
    row(5, "08:00"), row(6, "08:15"), row(7, "08:10"), row(8, "08:25"),
  ];
  const cue = lateStartCue(messages, { now: new Date("2026-09-21T10:30:00+08:00") });
  assert.ok(cue);
  assert.match(cue.expectedAt, /^08:/);
});

test("今天已经聊过就不重复报早间偏离", () => {
  const messages = [
    row(1, "08:00"), row(2, "08:20"), row(3, "08:10"), row(4, "08:30"),
    row(5, "08:00"), row(6, "08:15"), row(7, "08:10"), row(8, "08:25"),
    row(21, "10:30", "我今天起晚了"),
  ];
  assert.equal(lateStartCue(messages, { now: new Date("2026-09-21T10:40:00+08:00") }), null);
});
