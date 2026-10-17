import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { buildMemoryBlock, recallMemoryEntries } from "../lib/memory.js";
import { extractMemoryFeedback, parseLongtermResult } from "../lib/longterm.js";

test("新生成事实必须走证据条目，空触发词条目不会入账", () => {
  const source = { id: "u1", role: "user", text: "纸鹤是我们的纪念物", at: new Date().toISOString() };
  assert.equal(parseLongtermResult(JSON.stringify({ facts: [{ fact: "凭空生成的旧格式事实" }], entries: [] }), [source]).ok, false);
  const parsed = parseLongtermResult(JSON.stringify({ facts: [], entries: [{ kind: "symbol", title: "纸鹤", text: source.text, sourceIds: [source.id], evidence: [{ sourceId: source.id, quote: source.text }], keys: [] }] }), [source]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries, []);
});

test("Store排除的无效旧事实不能在召回层重新投影", (t) => {
  const { store } = setup(t);
  const monologue = store.appendMessage("nova", { role: "assistant", text: "纸鹤是我们共同造过的纪念物" });
  const recalled = store.appendMessage("nova", { role: "user", text: "蓝风筝的约定" });
  store.patchMessage("nova", recalled.id, { recalled: true, recallMode: "hard" });
  store.writeMemory("nova", { facts: [
    { fact: monologue.text, kind: "relationship", source: monologue.id, at: monologue.at },
    { fact: recalled.text, kind: "relationship", source: recalled.id, at: recalled.at },
  ] });
  const memory = store.readMemory("nova");
  assert.equal(memory.facts.length, 2); // 不把原始旧资料的隐藏当作已物理删除。
  assert.deepEqual(memory.longterm, []);
  assert.deepEqual(recallMemoryEntries(memory, "纸鹤和蓝风筝"), []);
  assert.doesNotMatch(buildMemoryBlock(memory, { query: "纸鹤和蓝风筝" }), /纪念物|约定/);
});

test("已读软撤回保留既有认知，清聊天后也不发生忽隐忽现", (t) => {
  const { store } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "纸鹤是我们的纪念物", readAt: new Date().toISOString() });
  store.appendFacts("nova", [{ fact: source.text, kind: "relationship", source: source.id, at: source.at }]);
  const before = store.readMemory("nova").longterm;
  store.patchMessage("nova", source.id, { recalled: true, text: "你撤回了一条消息" });
  assert.deepEqual(store.readMemory("nova").longterm, before);
  assert.match(buildMemoryBlock(store.readMemory("nova"), { query: "纸鹤" }), /纪念物/);
  store.clearThread("nova");
  assert.deepEqual(store.readMemory("nova").longterm, before);
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-longterm-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStore(dir) };
}
function entry(source, extra = {}) {
  return { id: "lt-old-event", kind: "event", title: "旧年风筝", text: "那次我们一起讨论过蓝风筝。", keys: ["风筝"], sourceIds: [source.id], at: source.at, updatedAt: source.at, ...extra };
}
function feedback(row, source, decision = "revise") {
  return extractMemoryFeedback(`先记这一笔<memory-update>${JSON.stringify({ updates: [{ id: row.id, decision, text: "那次讨论的是红风筝。", note: "我愿意改成这个版本", sourceId: source.id, quote: source.text }] })}</memory-update>`, [row], [source]).updates;
}

test("长期事件跨重开和清聊天保留，旧条目不受80条或召回预算淘汰", (t) => {
  const { store, dir } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "蓝风筝是很重要的一次约定" });
  store.appendLongterm("nova", [entry(source), ...Array.from({ length: 140 }, (_, i) => entry(source, { id: `noise-${i}`, title: `其他对象${i}`, text: `另外一项具体约定编号${i}。`, keys: [`其他对象${i}`] }))]);
  assert.equal(store.readMemory("nova").longterm.length, 141);
  store.clearThread("nova");
  const memory = createStore(dir).readMemory("nova");
  assert.equal(memory.longterm.length, 141);
  assert.deepEqual(recallMemoryEntries(memory, "还记得风筝吗").map((row) => row.id), ["lt-old-event"]);
  assert.match(buildMemoryBlock(memory, { query: "风筝" }), /蓝风筝/);
  assert.doesNotMatch(buildMemoryBlock(memory, { query: "吃面" }), /蓝风筝|其他对象/);
  assert.equal(createStore(dir).readMemory("nova").longterm.length, 141);
  store.resetPartnerMemory("nova");
  assert.deepEqual(store.readMemory("nova").longterm, []);
});

test("旧事实全库按需投影，早于最后12条的仍可唤起，无锚other不升级", (t) => {
  const { store, dir } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "纸鹤是我们的纪念物" });
  store.writeMemory("nova", { facts: [
    { fact: "纸鹤是我们之间的纪念物", kind: "relationship", source: source.id, at: source.at },
    ...Array.from({ length: 20 }, (_, i) => ({ fact: `喜欢一个编号为${i}的具体物件`, kind: "preference", source: source.id, at: source.at })),
    { fact: "无人接话的虚构旧事不升级", kind: "other", source: source.id, at: source.at },
  ] });
  const memory = createStore(dir).readMemory("nova");
  assert.equal(memory.longterm.length, 21);
  assert.match(buildMemoryBlock(memory, { query: "纸鹤" }), /纪念物/);
  assert.doesNotMatch(buildMemoryBlock(memory, { query: "吃面" }), /纪念物|编号为/);
});

test("反馈随有效回复落盘且重开延续，删除结果后旧事实不能重生", (t) => {
  const { store, dir } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "蓝风筝是我们的纪念物" });
  store.appendFacts("nova", [{ fact: "蓝风筝是我们之间的纪念物", kind: "relationship", source: source.id, at: source.at }]);
  const old = store.readMemory("nova").longterm[0];
  const correction = store.appendMessage("nova", { role: "user", text: "记错了，那回是红风筝" });
  const updates = feedback(old, correction);
  assert.equal(updates.length, 1);
  assert.equal(store.commitMemoryFeedback("nova", updates, "missing-result"), null);
  assert.equal(store.readMemory("nova").longterm[0].text, old.text);
  const reply = store.appendMessage("nova", { role: "assistant", text: "好，红风筝", repliedTo: correction.id });
  store.commitMemoryFeedback("nova", updates, reply.id);
  const changed = createStore(dir).readMemory("nova").longterm[0];
  assert.equal(changed.id, old.id);
  assert.equal(changed.text, "那次讨论的是红风筝。");
  assert.deepEqual(changed.resultMessageIds, [reply.id]);
  store.removeAssistantReply("nova", reply.id);
  assert.deepEqual(createStore(dir).readMemory("nova").longterm, []);
});

test("已撤回来源不能新入账，也不能提交在途反馈", (t) => {
  const { store, dir } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "蓝风筝的约定" });
  store.appendLongterm("nova", [entry(source)]);
  const old = store.readMemory("nova").longterm[0];
  const correction = store.appendMessage("nova", { role: "user", text: "那回是红风筝" });
  const updates = feedback(old, correction);
  const reply = store.appendMessage("nova", { role: "assistant", text: "先听你这版", repliedTo: correction.id });
  store.patchMessage("nova", correction.id, { recalled: true, recallMode: "hard", text: "你撤回了一条消息" });
  store.commitMemoryFeedback("nova", updates, reply.id);
  assert.equal(store.readMemory("nova").longterm[0].text, old.text);
  store.appendLongterm("nova", [entry(correction, { id: "bad-source" })]);
  assert.equal(store.readMemory("nova").longterm.length, 1);
  store.removeFactsBySource("nova", source.id);
  assert.deepEqual(createStore(dir).readMemory("nova").longterm, []);
});

test("并发更新不被迟到反馈覆盖，旧提取不恢复已改认知", (t) => {
  const { store } = setup(t);
  const source = store.appendMessage("nova", { role: "user", text: "蓝风筝的约定" });
  store.appendLongterm("nova", [entry(source)]);
  const old = store.readMemory("nova").longterm[0];
  const correction = store.appendMessage("nova", { role: "user", text: "那回是红风筝" });
  const updates = feedback(old, correction);
  const reply = store.appendMessage("nova", { role: "assistant", text: "先听你这版", repliedTo: correction.id });
  store.commitMemoryFeedback("nova", updates, reply.id);
  const changed = store.readMemory("nova").longterm[0];
  const late = store.appendMessage("nova", { role: "user", text: "那回是黄风筝" });
  store.commitMemoryFeedback("nova", feedback(old, late), reply.id);
  assert.equal(store.readMemory("nova").longterm[0].text, changed.text);
  store.appendLongterm("nova", [entry(source, { id: "regenerated-id", text: "那次商量的是蓝风筝。" })]);
  assert.equal(store.readMemory("nova").longterm.length, 1);
  assert.equal(store.readMemory("nova").longterm[0].text, changed.text);
});
