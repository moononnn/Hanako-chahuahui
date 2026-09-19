import test from "node:test";
import assert from "node:assert/strict";

import {
  CORRECTION_MIN_HITS,
  DEFAULT_WINDOW_DAYS,
  REVIEW_MIN_NOTES,
  classifyReason,
  correctionsFor,
  emptyWatch,
  kindSays,
  noteReview,
  noteWatch,
  readWatch,
  reasonSays,
  reviewDue,
  reviewSpec,
  watchSummary,
} from "../lib/selfwatch.js";

const T0 = new Date("2026-09-12T10:00:00.000Z");
const at = (hours) => new Date(T0.getTime() + hours * 3600 * 1000);

test("记账：原因归类，也说得出人话", () => {
  assert.equal(classifyReason("global-gap"), "tooClose");
  assert.equal(classifyReason("no-topic"), "noTopic");
  assert.equal(classifyReason("repeat-phrasing"), "repeat");
  assert.equal(classifyReason("没见过这个原因"), "other");
  assert.equal(classifyReason(null), "other");
  assert.equal(reasonSays("no-topic"), "手上没有像样的由头");
  assert.equal(reasonSays("没见过这个原因"), "这一趟没说成");
  assert.equal(kindSays("quiet"), "那会儿她在睡");
});

test("记账：一笔一笔往上加，动作认不出来当 skip，原因空的不算数", () => {
  let watch = noteWatch(emptyWatch(), { action: "blocked", reason: "no-topic", topic: "她想去云南" }, T0);
  watch = noteWatch(watch, { action: "乱写", reason: "global-gap" }, at(1));
  assert.equal(watch.notes.length, 2);
  assert.equal(watch.notes[0].action, "blocked");
  assert.equal(watch.notes[0].topic, "她想去云南");
  assert.equal(watch.notes[1].action, "skip");
  assert.equal(watch.notes[1].kind, "tooClose");
  // 原因缺省成 unspecified 而不是把这条丢掉
  assert.equal(noteWatch(watch, {}, at(2)).notes.length, 3);
});

test("归纳：窗口内计数，挑出最常出问题的那一类，other/off 不算", () => {
  let watch = emptyWatch();
  watch = noteWatch(watch, { reason: "no-topic" }, at(0));
  watch = noteWatch(watch, { reason: "no-topic" }, at(1));
  watch = noteWatch(watch, { reason: "no-form" }, at(2));
  watch = noteWatch(watch, { reason: "no-partners" }, at(3));
  const summary = watchSummary(watch, at(4));
  assert.equal(summary.total, 4);
  assert.equal(summary.counts.noTopic, 2);
  assert.equal(summary.dominant, "noTopic");
  assert.equal(summary.dominantCount, 2);
  assert.equal(summary.windowDays, DEFAULT_WINDOW_DAYS);
  // 窗口外的老账不算
  assert.equal(watchSummary(watch, at(24 * 30)).total, 0);
});

test("修正：一类问题不够三次就什么都不改", () => {
  let watch = emptyWatch();
  for (let i = 0; i < CORRECTION_MIN_HITS - 1; i += 1) {
    watch = noteWatch(watch, { reason: "global-gap" }, at(i));
  }
  const summary = watchSummary(watch, at(5));
  const corrections = correctionsFor(summary);
  assert.equal(corrections.laterBy, 0);
  assert.equal(corrections.allowEarlyRevive, false);
  assert.equal(corrections.avoidQuiet, false);
  assert.equal(corrections.note, "");
});

test("修正：太勤/挨太近就把落点往后挪", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 3; i += 1) watch = noteWatch(watch, { reason: "tier-daily-max" }, at(i));
  const corrections = correctionsFor(watchSummary(watch, at(5)));
  assert.equal(corrections.laterBy, 0.2);
  assert.match(corrections.note, /往后挪/);
});

test("修正：总撞睡觉就避开睡觉那段", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 4; i += 1) watch = noteWatch(watch, { reason: "quiet-used-tonight" }, at(i));
  const corrections = correctionsFor(watchSummary(watch, at(5)));
  assert.equal(corrections.avoidQuiet, true);
  assert.equal(corrections.laterBy, 0);
});

test("修正：手上总缺由头就把冷却过半的话题放回来", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 3; i += 1) watch = noteWatch(watch, { reason: "no-topic" }, at(i));
  assert.equal(correctionsFor(watchSummary(watch, at(5))).allowEarlyRevive, true);
  let told = emptyWatch();
  for (let i = 0; i < 3; i += 1) told = noteWatch(told, { reason: "repeat-phrasing" }, at(i));
  const repeat = correctionsFor(watchSummary(told, at(5)));
  assert.equal(repeat.allowEarlyRevive, false);
  assert.match(repeat.note, /聊过哪几面/);
});

test("自省到点：记录不够不跑，隔够一天才跑", () => {
  let watch = emptyWatch();
  for (let i = 0; i < REVIEW_MIN_NOTES; i += 1) watch = noteWatch(watch, { reason: "no-topic" }, at(i));
  assert.equal(reviewDue(watch, at(4)), true);
  const reviewed = noteReview(watch, { text: "我最近老是没话找话", corrections: { laterBy: 0.2 } }, at(4));
  // 刚自省过（待看的那一叠也空了）：不马上再跑
  assert.equal(reviewDue(reviewed, at(5)), false);
  // 又攒了记录，但才隔了几个小时，还是不跑
  let again = reviewed;
  for (let i = 0; i < REVIEW_MIN_NOTES; i += 1) again = noteWatch(again, { reason: "no-topic" }, at(6 + i));
  assert.equal(reviewDue(again, at(10)), false);
  // 隔够一天才跑
  assert.equal(reviewDue(again, at(24 * 2)), true);
  assert.equal(reviewDue(again, at(24 * 2), { minNotes: 99 }), false);
});

test("小结写回去：待看的那一叠清空，修正只留这一轮，小结留最近五条", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 5; i += 1) watch = noteWatch(watch, { reason: "global-gap" }, at(i));
  watch = noteReview(watch, { text: "这阵子太急了", corrections: { laterBy: 0.2 } }, at(6));
  assert.equal(watch.notes.length, 0);
  assert.equal(watch.reviews.length, 1);
  assert.equal(watch.corrections.laterBy, 0.2);
  assert.equal(watch.lastReviewedAt, at(6).toISOString());
  for (let i = 1; i <= 6; i += 1) {
    watch = noteReview(watch, { text: `第${i}回小结`, corrections: {} }, at(24 * i));
  }
  assert.equal(watch.reviews.length, 5);
  assert.equal(watch.reviews[4].text, "第6回小结");
  assert.equal(watch.corrections.laterBy ?? 0, 0);
});

test("模型没写出小结也照常往前走：不清修正、不改上一次的小结", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 3; i += 1) watch = noteWatch(watch, { reason: "no-topic" }, at(i));
  watch = noteReview(watch, { text: "第一回", corrections: { allowEarlyRevive: true } }, at(4));
  watch = noteReview(watch, { text: "", corrections: { allowEarlyRevive: true } }, at(24 * 2));
  assert.equal(watch.reviews.length, 1);
  assert.equal(watch.notes.length, 0);
  assert.equal(watch.corrections.allowEarlyRevive, true);
});

test("自省提示词：带上次数和人话，不喊口号", () => {
  let watch = emptyWatch();
  for (let i = 0; i < 3; i += 1) watch = noteWatch(watch, { reason: "no-topic" }, at(i));
  watch = noteWatch(watch, { reason: "global-gap" }, at(3));
  const spec = reviewSpec({
    partnerName: "小七",
    userName: "阿舟",
    summary: watchSummary(watch, at(5)),
    latestNote: "上回说过别急",
  });
  assert.match(spec.systemPrompt, /只写给自己看/);
  assert.match(spec.systemPrompt, /第一人称/);
  assert.match(spec.userText, /小七/);
  assert.match(spec.userText, /阿舟看不到/);
  assert.match(spec.userText, /一共 4 趟/);
  assert.match(spec.userText, /手上没有像样的由头（3 趟）/);
  assert.match(spec.userText, /上回你自己写的：上回说过别急/);
  // 机制词不上提示词
  assert.doesNotMatch(spec.userText, /noTopic|dominant|correction/i);
});

test("坏数据收得住：不是本子就当空本子", () => {
  assert.deepEqual(readWatch(null), emptyWatch());
  assert.deepEqual(readWatch("不是对象"), emptyWatch());
  const messy = readWatch({
    notes: [null, { reason: "no-topic" }, { reason: "" }, "字符串"],
    reviews: [{ text: "  " }, { text: "有内容" }],
    lastReviewedAt: 12345,
    corrections: "不是对象",
  });
  assert.equal(messy.notes.length, 1);
  assert.equal(messy.notes[0].kind, "noTopic");
  assert.equal(messy.reviews.length, 1);
  assert.equal(messy.reviews[0].text, "有内容");
  assert.deepEqual(messy.corrections, {});
  assert.equal(messy.lastReviewedAt, 12345);
});
