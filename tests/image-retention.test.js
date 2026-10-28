import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_CHOICES,
  isExpired,
  normalizeRetentionDays,
  planCleanup,
  summarizeStorage,
} from "../lib/image-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-27T12:00:00");
const daysAgo = (n) => new Date(now - n * DAY).toISOString();

test("期限只认设置页那几档，其余回默认；0 是永久", () => {
  assert.deepEqual(RETENTION_CHOICES, [30, 45, 60, 90, 0]);
  for (const days of RETENTION_CHOICES) assert.equal(normalizeRetentionDays(days), days);
  assert.equal(normalizeRetentionDays(0), 0);
  assert.equal(normalizeRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
  assert.equal(normalizeRetentionDays("abc"), DEFAULT_RETENTION_DAYS);
  assert.equal(normalizeRetentionDays(-3), DEFAULT_RETENTION_DAYS);
  // 老数据里存了个别的正数就认它，不硬拽回 30。
  assert.equal(normalizeRetentionDays(120), 120);
});

test("永久模式下没有一张算过期", () => {
  const old = { at: daysAgo(999), lastSeenAt: daysAgo(999), size: 100 };
  assert.equal(isExpired(old, 0, now), false);
});

test("过了线才算过期，差一天都不算", () => {
  assert.equal(isExpired({ lastSeenAt: daysAgo(31) }, 30, now), true);
  assert.equal(isExpired({ lastSeenAt: daysAgo(29) }, 30, now), false);
  assert.equal(isExpired({ lastSeenAt: daysAgo(46) }, 45, now), true);
});

test("按最后一次发送算，不按第一次：隔两个月又发一遍，它还是活的", () => {
  const meta = { at: daysAgo(200), lastSeenAt: daysAgo(2) };
  assert.equal(isExpired(meta, 30, now), false, "她刚又发过一次，不能因为第一次很久以前就清掉");
  // 只有第一次记录的老图退回按 at 算。
  assert.equal(isExpired({ at: daysAgo(200) }, 30, now), true);
});

test("已经清过的不再进名单，免得她点两次看到同一张又被算一遍", () => {
  assert.equal(isExpired({ lastSeenAt: daysAgo(99), purgedAt: daysAgo(1) }, 30, now), false);
});

test("统计只算还在盘上的：清掉的那部分不能还占着数", () => {
  const metas = [
    { id: "a", at: daysAgo(40), lastSeenAt: daysAgo(40), size: 1000 },
    { id: "b", at: daysAgo(3), lastSeenAt: daysAgo(3), size: 2000 },
    { id: "c", at: daysAgo(80), lastSeenAt: daysAgo(80), size: 4000, purgedAt: daysAgo(3) },
  ];
  const s = summarizeStorage(metas, 30, now);
  assert.equal(s.count, 2, "清过的那张不再算在张数里");
  assert.equal(s.bytes, 3000, "清过的那张也不再占体积");
  assert.equal(s.expiredCount, 1);
  assert.equal(s.expiredBytes, 1000);
  assert.equal(s.oldestAt, Date.parse(daysAgo(80)));
  assert.equal(s.keepsForever, false);
});

test("永久模式：占用照报，但不说有东西可清", () => {
  const s = summarizeStorage([{ at: daysAgo(500), lastSeenAt: daysAgo(500), size: 700 }], 0, now);
  assert.equal(s.keepsForever, true);
  assert.equal(s.expiredCount, 0);
  assert.equal(s.count, 1);
  assert.equal(s.bytes, 700);
});

test("空目录和坏数据都不炸", () => {
  const s = summarizeStorage([], 30, now);
  assert.equal(s.count, 0);
  assert.equal(s.bytes, 0);
  assert.equal(s.oldestAt, null);
  assert.equal(s.expiredCount, 0);
  assert.equal(s.orphanCount, 0);
  assert.equal(s.keepsForever, false);
  assert.equal(summarizeStorage([null, undefined, "x", 3], 30, now).count, 0);
});

test("没有人认领的图算孤儿：它不等到期，但也不算在过期里", () => {
  // 聊天账每本两千条，老消息被挤出去之后图还在盘上，再没有任何一条消息认它。
  const metas = [
    { id: "kept", at: daysAgo(2), lastSeenAt: daysAgo(2), size: 100 },
    { id: "gone", at: daysAgo(2), lastSeenAt: daysAgo(2), size: 900 },
  ];
  const refs = new Set(["kept"]);
  const s = summarizeStorage(metas, 30, now, refs);
  assert.equal(s.count, 2);
  assert.equal(s.bytes, 1000);
  assert.equal(s.orphanCount, 1, "没人认的那张算孤儿");
  assert.equal(s.orphanBytes, 900);
  assert.equal(s.expiredCount, 0, "它没过期，别混进过期那一栏");
  assert.equal(s.cleanupCount, 1, "但按钮上要能看到它");
  assert.equal(s.cleanupBytes, 900);
});

test("给了引用名单之后，孤儿和过期各算各的，不重复计", () => {
  const metas = [
    { id: "old-kept", at: daysAgo(40), lastSeenAt: daysAgo(40), size: 10 },
    { id: "old-gone", at: daysAgo(40), lastSeenAt: daysAgo(40), size: 20 },
    { id: "new-gone", at: daysAgo(1), lastSeenAt: daysAgo(1), size: 30 },
  ];
  const s = summarizeStorage(metas, 30, now, new Set(["old-kept"]));
  assert.equal(s.expiredCount, 1, "过了期的只算还在聊天记录里那张");
  assert.equal(s.expiredBytes, 10);
  assert.equal(s.orphanCount, 2);
  assert.equal(s.orphanBytes, 50);
  assert.equal(s.cleanupCount, 3);
});

test("永久模式下孤儿也不清：那是她明确说过不删的意思", () => {
  const s = summarizeStorage([{ id: "gone", at: daysAgo(999), lastSeenAt: daysAgo(999), size: 500 }], 0, now, new Set());
  assert.equal(s.orphanCount, 1, "占用还是照实报");
  assert.equal(s.cleanupCount, 0, "但一个都不清");
  assert.equal(s.keepsForever, true);
});

test("planCleanup 收的正好是过期加孤儿，而且不碰清过的", () => {
  const metas = [
    { id: "plain", at: daysAgo(1), lastSeenAt: daysAgo(1), size: 1 },
    { id: "old", at: daysAgo(50), lastSeenAt: daysAgo(50), size: 2 },
    { id: "orphan", at: daysAgo(1), lastSeenAt: daysAgo(1), size: 4 },
    { id: "done", at: daysAgo(50), lastSeenAt: daysAgo(50), size: 8, purgedAt: daysAgo(2) },
  ];
  const plan = planCleanup(metas, { days: 30, referencedIds: new Set(["plain", "old"]) }, now);
  assert.deepEqual(plan.rows.map((row) => row.id).sort(), ["old", "orphan"]);
  assert.equal(plan.orphanCount, 1);
  assert.equal(plan.expiredBytes, 2);
  assert.equal(plan.orphanBytes, 4);
});

test("永久模式：planCleanup 一张都不给", () => {
  const plan = planCleanup([{ id: "x", at: daysAgo(999), lastSeenAt: daysAgo(999) }], { days: 0, referencedIds: new Set() }, now);
  assert.deepEqual(plan.rows, []);
});

test("没给引用名单时只按期限算，不把每张都当孤儿", () => {
  // 老调用方（不传名单）不能因为拿不到名单就把所有东西都判成孤儿清掉。
  const metas = [{ id: "a", at: daysAgo(1), lastSeenAt: daysAgo(1), size: 1 }];
  const s = summarizeStorage(metas, 30, now);
  assert.equal(s.orphanCount, 0);
  assert.equal(s.cleanupCount, 0);
});
