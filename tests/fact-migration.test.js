import test from "node:test";
import assert from "node:assert/strict";

import { migrateLegacyFacts } from "../lib/fact-migration.js";

const now = new Date("2026-09-22T12:00:00.000Z");
const messages = [
  { id: "m-voice", role: "user", text: "以后多给我发一点语音嘛", at: "2026-09-18T08:00:00.000Z" },
  { id: "m-sleep", role: "user", text: "我睡着了就别吵醒我", at: "2026-09-19T08:00:00.000Z" },
  { id: "m-sticker", role: "user", text: "这张可以用，source:stk_7", at: "2026-09-20T08:00:00.000Z" },
  { id: "m-vague-sticker", role: "user", text: "那张表情包可以用", at: "2026-09-20T09:00:00.000Z" },
  { id: "m-interest", role: "user", text: "我喜欢像素艺术，也喜欢分析电影", at: "2026-09-20T10:00:00.000Z" },
  { id: "m-recalled", role: "user", text: "以后主动多来找我", recalled: true, at: "2026-09-20T11:00:00.000Z" },
  { id: "m-assistant", role: "assistant", text: "她喜欢我多发语音", at: "2026-09-20T12:00:00.000Z" },
];

const facts = [
  { fact: "用户喜欢伙伴多发一点语音", kind: "preference", source: "m-voice", at: now.toISOString() },
  { fact: "用户睡着时不要叫醒或吵醒", kind: "boundary", source: "m-sleep", at: messages[1].at },
  { fact: "用户允许使用表情包 source:stk_7", kind: "preference", source: "m-sticker", at: messages[2].at },
  { fact: "用户允许使用那张表情包", kind: "preference", source: "m-vague-sticker", at: messages[3].at },
  { fact: "用户喜欢分析电影", kind: "preference", source: "m-interest", at: messages[4].at },
  { fact: "用户希望伙伴以后更主动来找", kind: "preference", source: "m-recalled", at: messages[5].at },
  { fact: "用户喜欢伙伴多发语音", kind: "preference", source: "m-assistant", at: messages[6].at },
  { fact: "没有来源的偏好不能迁移", kind: "preference", source: "missing", at: now.toISOString() },
];

test("旧 facts 只迁移可追溯的明确互动偏好，并生成确定 claim", () => {
  const result = migrateLegacyFacts({ facts, messages, book: { guides: [] }, existingGuides: [], now });
  assert.equal(result.added.length, 3);
  const claims = result.added.flatMap((guide) => guide.claims);
  assert.ok(claims.some((claim) => claim.target === "voice.frequency" && claim.value === "more"));
  assert.ok(claims.some((claim) => claim.target === "sleep.reply" && claim.value === "none"));
  assert.ok(claims.some((claim) => claim.target === "sticker.permission" && claim.subject === "source:stk_7"));
  assert.equal(result.added.find((guide) => guide.claims[0]?.target === "sticker.permission")?.kind, "permission");
  assert.equal(result.added.find((guide) => guide.sourceMessageIds.includes("m-voice"))?.updatedAt, messages[0].at, "迁移时刻不能伪装成用户刚改口");
  assert.equal(result.book.migration.sourceIds.includes("m-interest"), true, "明确处理过但不属于互动适应的事实也要有幂等水位");
});

test("模糊表情许可、撤回消息、伙伴推测与无来源事实都不迁移", () => {
  const result = migrateLegacyFacts({ facts, messages, book: { guides: [] }, existingGuides: [], now });
  const sources = new Set(result.added.flatMap((guide) => guide.sourceMessageIds));
  for (const id of ["m-vague-sticker", "m-interest", "m-recalled", "m-assistant", "missing"]) assert.equal(sources.has(id), false, id);
  assert.ok(result.skipped.some((row) => row.sourceId === "m-vague-sticker" && row.reason === "unstable-sticker-subject"));
});

test("旧 fact 本身是 permission 时，只在稳定表情身份可解析时迁移", () => {
  const source = { id: "m-permission", role: "user", text: "这张表情可以继续用，source:sticker-9", at: "2026-09-18T09:00:00.000Z" };
  const result = migrateLegacyFacts({
    facts: [{ fact: "用户允许使用表情包 source:sticker-9", kind: "permission", source: source.id, at: source.at }],
    messages: [source],
    book: { guides: [] },
    now,
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].kind, "permission");
  assert.equal(result.added[0].claims[0].subject, "source:sticker-9");
});

test("同源已有 guide 与完成标记都保证重复启动不重复导入", () => {
  const existing = [{ id: "g-existing", sourceMessageIds: ["m-voice"] }];
  const first = migrateLegacyFacts({ facts: facts.slice(0, 3), messages, book: { guides: [] }, existingGuides: existing, now });
  assert.equal(first.added.some((guide) => guide.sourceMessageIds.includes("m-voice")), false);
  const second = migrateLegacyFacts({ facts, messages, book: first.book, existingGuides: [...existing, ...first.book.guides], now: new Date(now.getTime() + 1000) });
  assert.equal(second.alreadyCompleted, true);
  assert.equal(second.book.guides.length, first.book.guides.length);
});
