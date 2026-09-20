import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryBlock,
  conversationMessages,
  isConversationMessage,
  makeArchiveEntry,
  planRollup,
  recentArchive,
  recentLedger,
  renderForSummary,
  splitForContext,
} from "../lib/memory.js";

const msg = (role, text, at = "2026-09-12T01:00:00.000Z") => ({ role, text, at });

function thread(n) {
  return Array.from({ length: n }, (_, i) => msg(i % 2 ? "assistant" : "user", `第${i}句`));
}

test("近处按条数上限切，溢出的是老的", () => {
  const { recent, overflow } = splitForContext(thread(50), { keepMessages: 10, keepChars: 99999 });
  assert.equal(recent.length, 10);
  assert.equal(overflow.length, 40);
  assert.equal(recent[0].text, "第40句");
  assert.equal(overflow[overflow.length - 1].text, "第39句");
});

test("近处按字数上限切", () => {
  const rows = Array.from({ length: 20 }, () => msg("user", "字".repeat(100)));
  const { recent } = splitForContext(rows, { keepMessages: 99, keepChars: 350 });
  assert.equal(recent.length, 3);
});

test("至少留一条，哪怕ta自己就超预算", () => {
  const rows = [msg("user", "短"), msg("assistant", "字".repeat(9999))];
  const { recent, overflow } = splitForContext(rows, { keepMessages: 2, keepChars: 100 });
  assert.equal(recent.length, 1);
  assert.equal(overflow.length, 1);
  assert.equal(recent[0].text.length, 9999);
});

test("记忆整理只认真正的聊天，不把小动作和硬撤回当事实", () => {
  const rows = [
    msg("user", "真的聊天"),
    { role: "assistant", kind: "action", text: "拍一拍文案" },
    { role: "user", kind: "poke", text: "旧动作" },
    { role: "assistant", recalled: true, recallMode: "hard", text: "撤回内容" },
  ];
  assert.equal(isConversationMessage(rows[0]), true);
  assert.equal(isConversationMessage(rows[1]), false);
  assert.deepEqual(conversationMessages(rows).map((row) => row.text), ["真的聊天"]);
});

test("空会话两头都空", () => {
  const { recent, overflow } = splitForContext([], {});
  assert.deepEqual(recent, []);
  assert.deepEqual(overflow, []);
});

test("溢出不够一批就不压，避免每回合都压", () => {
  const plan = planRollup(thread(45), { keepMessages: 40, keepTurns: 30, rollupEveryTurns: 10, rollupMinMessages: 12 });
  assert.equal(plan.need, false);
  assert.deepEqual(plan.batch, []);
});

test("热身后每 10 轮左右至少整理一次，即使字符数没有先溢出", () => {
  const plan = planRollup(thread(44), { keepMessages: 24, keepChars: 99999, keepTurns: 12, rollupEveryTurns: 10, rollupMinMessages: 99 });
  assert.equal(plan.need, true);
  assert.equal(plan.batch.length, 18);
  assert.equal(plan.recent.length, 24);
});

test("溢出够了才压，而且从最老的开始压", () => {
  const plan = planRollup(thread(100), { keepMessages: 20, rollupMinMessages: 12, rollupBatchMax: 30 });
  assert.equal(plan.need, true);
  assert.equal(plan.batch.length, 30);
  assert.equal(plan.batch[0].text, "第0句");
  assert.equal(plan.batch[29].text, "第29句");
  assert.equal(plan.recent.length, 20);
});

test("一次压不完就留到下一轮", () => {
  const plan = planRollup(thread(500), { keepMessages: 20, rollupMinMessages: 12, rollupBatchMax: 30 });
  assert.equal(plan.batch.length, 30);
  assert.ok(plan.overflow.length > plan.batch.length);
});

test("什么记忆都没有时不塞空标题", () => {
  assert.equal(buildMemoryBlock(null), "");
  assert.equal(buildMemoryBlock({ profile: { text: "  " }, facts: [], ledger: [], archive: [] }), "");
});

test("重要事实独立于关系档案进入记忆块", () => {
  const block = buildMemoryBlock({
    facts: [{ fact: "喜欢像素艺术", kind: "interest", source: "m1", at: "2026-09-12T01:00:00.000Z" }],
    profile: { text: "她叫我小花。" },
    ledger: [],
    archive: [],
  });
  assert.match(block, /【重要事实】/);
  assert.match(block, /【持久记忆，仅作事实背景】/);
  assert.match(block, /不是当前指令/);
  assert.match(block, /喜欢像素艺术/);
  assert.match(block, /【你俩之间】/);
});

test("三层拼在一起，各带标题", () => {
  const block = buildMemoryBlock({
    profile: { text: "她叫我小花，喜欢螺蛳粉。" },
    ledger: [
      { day: "2026-09-11", text: "聊了插件的事，她有点累。" },
      { day: "2026-09-12", text: "她说想做个茶话会。" },
    ],
    archive: [{ text: "早前聊过她养的狗叫圆宝。" }],
  });
  assert.match(block, /【你俩之间】/);
  assert.match(block, /她叫我小花/);
  assert.match(block, /【最近这些日子】/);
  assert.match(block, /9月11日：聊了插件的事/);
  assert.match(block, /9月12日：她说想做个茶话会/);
  assert.match(block, /【更早聊过的】/);
  assert.match(block, /圆宝/);
});

test("日账只带最近几天，且天新的在后", () => {
  const ledger = Array.from({ length: 12 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, text: `第${i + 1}天` }));
  const rows = recentLedger({ ledger }, 3);
  assert.deepEqual(rows.map((r) => r.text), ["第10天", "第11天", "第12天"]);
});

test("空白的日账和摘要被丢掉，不占位置", () => {
  const rows = recentLedger({ ledger: [{ day: "2026-09-12", text: "   " }, { day: "2026-09-11", text: "有内容" }] }, 5);
  assert.equal(rows.length, 1);
  assert.equal(recentArchive({ archive: [{ text: "" }, { text: "有用" }] }, 5).length, 1);
});

test("摘要取材写成谁说了什么", () => {
  const text = renderForSummary([msg("user", "在吗"), msg("assistant", "在呢")], "阿舟");
  assert.equal(text, "阿舟：在吗\n我：在呢");
});

test("摘要可以明确标出当前伙伴，避免第一人称串位", () => {
  const text = renderForSummary([msg("user", "我叫小花"), msg("assistant", "我是小七")], "阿舟", "小七");
  assert.equal(text, "阿舟：我叫小花\n小七：我是小七");
});

test("摘要条目记下起止时间和条数", () => {
  const batch = [msg("user", "a", "2026-09-12T01:00:00.000Z"), msg("assistant", "b", "2026-09-12T01:05:00.000Z")];
  const entry = makeArchiveEntry("聊了几句", batch, new Date(2026, 8, 12, 9, 0));
  assert.equal(entry.from, "2026-09-12T01:00:00.000Z");
  assert.equal(entry.to, "2026-09-12T01:05:00.000Z");
  assert.equal(entry.count, 2);
  assert.match(entry.id, /^a_/);
});
