import test from "node:test";
import assert from "node:assert/strict";

import {
  COLD_MUTE,
  COLD_SLOW,
  MOOD_BASE_COOLDOWN_MS,
  MOOD_SLOW_COOLDOWN_MS,
  TOPIC_REJECT_RE,
  cooldownByMotif,
  cooldownForMood,
  emptyMoodBook,
  isLowEffortReply,
  mentionedMotifIds,
  moodSummary,
  mutedMotifIds,
  reactionOf,
  readMoodBook,
  recomputeMood,
  reviveMentioned,
} from "../lib/topic-mood.js";

const at = (hour) => `2026-10-06T0${hour}:00:00.000Z`;
const proactive = (id, motifId, name, hour = 0) => ({
  id,
  role: "assistant",
  proactive: true,
  interestId: motifId,
  interestName: name,
  text: "我自己惦记着的这一面",
  at: at(hour),
});
const user = (id, text, hour = 0) => ({ id, role: "user", text, at: at(hour) });
const poke = (id, hour = 0) => ({ id, role: "user", kind: "action", actionId: "poke", text: "戳了一下", at: at(hour) });

test("她怎么回应，分得清五档", () => {
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), user("u1", "我今天走了一段，回头试试", 1)], 0), "warm");
  // 只戳了一下、回一个「嗯」、只丢张图，都算低投入
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), poke("a1", 1)], 0), "light");
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), user("u1", "嗯", 1)], 0), "light");
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), user("u1", "", 1)], 0), "light");
  // 明说不聊这个：直接按到底
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), user("u1", "这个我不太想聊", 1)], 0), "reject");
  // 读了没回，比没读更明确
  const readRows = [proactive("p1", "m1", "半日路线", 0)];
  assert.equal(reactionOf(readRows, 0, { readThroughIndex: 0 }), "read");
  assert.equal(reactionOf(readRows, 0), "unseen");
  // 她还没回，下一条主动又出去了：前一条算没人接
  assert.equal(reactionOf([proactive("p1", "m1", "半日路线", 0), proactive("p2", "m1", "半日路线", 1)], 0), "unseen");
});

test("一个「嗯」判成低投入，真回话不算", () => {
  assert.equal(isLowEffortReply("嗯"), true);
  assert.equal(isLowEffortReply("好诶"), true);
  assert.equal(isLowEffortReply("浇完啦"), false);
  assert.equal(isLowEffortReply("我今天也想试试"), false);
  assert.equal(isLowEffortReply(""), false);
});

test("按方向记账，重跑得到同一本账", () => {
  const rows = [
    proactive("p1", "m1", "半日路线", 0),
    user("u1", "这个我也有点想法", 1),
    proactive("p2", "m2", "阳台种植", 2),
  ];
  const first = recomputeMood(emptyMoodBook(), rows, { now: new Date("2026-10-06T10:00:00Z") });
  assert.equal(first.changed, true);
  assert.equal(first.book.topics.m1.sent, 1);
  assert.equal(first.book.topics.m1.warm, 1);
  assert.equal(first.book.topics.m1.cold, 0);
  assert.equal(first.book.topics.m2.cold, 0.5, "没读的最轻");

  const again = recomputeMood(first.book, rows, { now: new Date("2026-10-06T10:05:00Z") });
  assert.equal(again.changed, false, "重跑不该再记一遍");
  assert.equal(again.book.topics.m1.sent, 1);
  assert.equal(again.book.topics.m1.cold, 0);
});

test("她过一阵才回话，那一条要能改成「接住了」", () => {
  const rows = [proactive("p1", "m1", "半日路线", 0)];
  const cold = recomputeMood(emptyMoodBook(), rows, { readThroughId: "p1" }).book;
  assert.equal(cold.topics.m1.cold, 2, "先是已读未回");

  const later = [...rows, user("u1", "刚忙完，你说的那个我试了一下", 3)];
  const warm = recomputeMood(cold, later).book;
  assert.equal(warm.topics.m1.cold, 0, "后补的回应也要算数");
  assert.equal(warm.topics.m1.warm, 1);
});

test("读了没回攒够就歇久，再攒够就不再提", () => {
  const rows = [
    proactive("p1", "m1", "半日路线", 0),
    proactive("p2", "m1", "半日路线", 1),
  ];
  const book = recomputeMood(emptyMoodBook(), rows, { readThroughId: "p2" }).book;
  assert.equal(book.topics.m1.cold, 4, "两条已读未回，各记 2");
  assert.equal(cooldownForMood(book, "m1"), MOOD_SLOW_COOLDOWN_MS);
  assert.equal(cooldownForMood(emptyMoodBook(), "m9"), MOOD_BASE_COOLDOWN_MS);
  assert.deepEqual(mutedMotifIds(book), ["m1"]);
  assert.equal(COLD_SLOW, 2);
  assert.equal(COLD_MUTE, 3);
});

test("她接住一次就回暖，被按下去的也一起解掉", () => {
  const rows = [
    proactive("p1", "m1", "半日路线", 0),
    proactive("p2", "m1", "半日路线", 1),
  ];
  const cold = recomputeMood(emptyMoodBook(), rows, { readThroughId: "p2" }).book;
  assert.deepEqual(mutedMotifIds(cold), ["m1"]);

  const warm = recomputeMood(cold, [...rows, user("u1", "说到这个，我下午真去走了一圈", 2)]).book;
  assert.equal(warm.topics.m1.cold, 0);
  assert.equal(warm.topics.m1.mutedAt, null);
  assert.deepEqual(mutedMotifIds(warm), []);
  assert.equal(cooldownForMood(warm, "m1"), MOOD_BASE_COOLDOWN_MS);
});

test("她说不想聊这个，当场就按到底", () => {
  assert.equal(TOPIC_REJECT_RE.test("这个我不想聊了"), true);
  assert.equal(TOPIC_REJECT_RE.test("换个话题吧"), true);
  assert.equal(TOPIC_REJECT_RE.test("今天薄荷浇过啦"), false);

  const rows = [proactive("p1", "m1", "半日路线", 0), user("u1", "这个我不太想聊，说说薄荷吧", 1)];
  const book = recomputeMood(emptyMoodBook(), rows).book;
  assert.deepEqual(mutedMotifIds(book), ["m1"], "一句「不想聊」就够了，不用攒三次");
});

test("她自己提起那个方向，当场解冻", () => {
  const rows = [proactive("p1", "m1", "半日步行路线编排", 0)];
  const cold = recomputeMood(emptyMoodBook(), rows, { readThroughId: "p1" }).book;
  cold.topics.m1.cold = COLD_MUTE;
  cold.topics.m1.mutedAt = "2026-10-06T05:00:00Z";

  assert.deepEqual(mentionedMotifIds(cold, "我最近在排一条半日步行路线"), ["m1"]);
  assert.deepEqual(mentionedMotifIds(cold, "今天薄荷该浇水了吧"), [], "别的方向不该被带出来");

  const revived = reviveMentioned(cold, "我最近在排一条半日步行路线");
  assert.deepEqual(revived.revived, ["m1"]);
  assert.equal(revived.book.topics.m1.mutedAt, null);

  // 解冻之后重算：她提起之前的旧账不再算，之后的新消息才重新记
  const after = [...rows, user("u1", "我最近在排一条半日步行路线", 6)];
  const again = recomputeMood(revived.book, after).book;
  assert.equal(again.topics.m1.cold, 0, "解冻之前那几条不再算冷");
  assert.equal(again.topics.m1.sent, 0);
});

test("挑种子要用的每方向冷却，冷过的更长", () => {
  const book = { topics: { m1: { name: "半日路线", cold: 3 }, m2: { name: "阳台种植", cold: 1 } } };
  const map = cooldownByMotif(book);
  assert.equal(map.get("m1"), MOOD_SLOW_COOLDOWN_MS);
  assert.equal(map.get("m2"), MOOD_BASE_COOLDOWN_MS);
  const rows = moodSummary(book);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === "m1").muted, false, "温度账只报冷度，mute 只看 mutedAt");
});

test("账本读回来形状要稳", () => {
  const raw = {
    topics: {
      m1: { name: "半日路线", object: "安排半日路线", cold: "3.5", sent: "2", revivedAt: "2026-10-06T02:00:00Z" },
      "": { name: "空的" },
    },
  };
  const book = readMoodBook(raw);
  assert.equal(book.topics.m1.cold, 3.5);
  assert.equal(book.topics.m1.sent, 2);
  assert.equal(book.topics.m1.revivedAt, "2026-10-06T02:00:00Z");
  assert.deepEqual(Object.keys(book.topics), ["m1"]);
  assert.deepEqual(readMoodBook(null), { topics: {} });
});
