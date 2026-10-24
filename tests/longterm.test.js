import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_FEEDBACK_TAG, normalizeLongterm, selectLongterm, longtermBlock,
  buildLongtermSpec, parseLongtermResult, memoryFeedbackPrompt,
  extractMemoryFeedback, mergeLongterm, applyMemoryFeedback, removeLongtermBySource,
} from "../lib/longterm.js";

const at = "2020-01-01T00:00:00.000Z";
const now = new Date("2026-10-15T10:00:00.000Z");
const row = (extra = {}) => ({ kind: "event", title: "雨夜捡猫", text: "那次雨夜我们在桥边捡到了小猫。", keys: ["雨夜捡猫", "小猫"], sourceIds: ["u1"], at, ...extra });
const base = () => normalizeLongterm([row()]);
const batch = [
  { id: "u1", role: "user", text: "还记得雨夜捡猫吗？我们在桥边捡到了小猫。", at },
  { id: "a1", role: "assistant", text: "当然记得那只小猫。", at },
];
const candidate = (extra = {}) => ({ kind: "event", title: "雨夜捡猫", text: "那次雨夜我们在桥边捡到了小猫。", keys: ["雨夜捡猫", "小猫"], sourceIds: ["u1"], evidence: [{ sourceId: "u1", quote: "我们在桥边捡到了小猫。" }], ...extra });
const result = (entries = [candidate()]) => JSON.stringify({ facts: [], entries });
const feedbackSource = { id: "u2", role: "user", text: "你记错了，是在车站捡的小猫，不是桥边。", at: now.toISOString() };
function feedback(entry = base()[0], extra = {}) {
  return { id: entry.id, decision: "revise", text: "那次雨夜我们在车站捡到了小猫。", note: "倾向于她说的车站", sourceId: "u2", quote: feedbackSource.text, ...extra };
}
const wrap = (updates) => `<memory-update>${JSON.stringify({ updates })}</memory-update>`;
function extracted(entries = base(), updates = [feedback(entries[0])], sources = [feedbackSource]) {
  return extractMemoryFeedback(`接住你这句。${wrap(updates)}`, entries, sources);
}

test("normalization has stable ids and complete shape without mutating input", () => {
  const input = [row()];
  const before = structuredClone(input);
  const first = normalizeLongterm(input);
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeLongterm(first), first);
  assert.equal(first[0].id, normalizeLongterm([row({ title: "另一个标题" })])[0].id);
  assert.deepEqual(Object.keys(first[0]).sort(), ["id", "kind", "title", "text", "keys", "sourceIds", "at", "updatedAt", "certainty", "note", "feedbackSourceIds", "resultMessageIds"].sort());
  assert.equal(first[0].certainty, "held");
});

test("only valid entries; no invented memory from arbitrary input", () => {
  assert.deepEqual(normalizeLongterm([null, {}, row({ kind: "other" }), row({ text: "" }), row({ title: "" }), row({ text: "长".repeat(361) })]), []);
  const normalized = normalizeLongterm([row({ keys: ["", null, "小猫", "小猫", "长".repeat(100)], certainty: "uncertain", feedbackSourceIds: ["f"], resultMessageIds: ["r"] })])[0];
  assert.deepEqual(normalized.keys, ["小猫"]);
  assert.equal(normalized.certainty, "uncertain");
  assert.deepEqual(normalized.feedbackSourceIds, ["f"]);
});

test("old memories and dependencies outlive dates, 500-message windows and retrieval budgets", () => {
  const all = normalizeLongterm(Array.from({ length: 650 }, (_, i) => row({ id: `old-${i}`, text: `第${i}次雨夜捡猫的具体事件。`, sourceIds: [`gone-${i}`] })));
  assert.equal(all.length, 650);
  assert.equal(normalizeLongterm(all).length, 650);
  assert.deepEqual(selectLongterm(all, "雨夜捡猫", { maxChars: 1 }), []);
  assert.equal(all.length, 650);
  assert.equal(mergeLongterm(all, []).length, 650);
});

test("selection rejects empty/generic/single-character triggers", () => {
  const entries = normalizeLongterm([row({ keys: ["", "猫", "喜欢", "我们"], title: "喜欢", text: "我们喜欢小猫" })]);
  for (const q of ["", "  ", "猫", "喜欢", "我们", "今天发生什么", "这个事情"]) assert.deepEqual(selectLongterm(entries, q), [], q);
});

test("exact aliases and meaningful two-character keys work, ASCII aliases use token boundaries", () => {
  const entries = normalizeLongterm([row({ keys: ["小猫", "momo"] })]);
  assert.equal(selectLongterm(entries, "那只小猫呢").length, 1);
  assert.equal(selectLongterm(entries, "MOMO!").length, 1);
  assert.deepEqual(selectLongterm(entries, "momoko"), []);
});

test("continuous >=3-character shared fragments retrieve projected facts and title/text", () => {
  const fact = "她喜欢周末坐绿皮火车去山里看日出。";
  const entries = normalizeLongterm([row({ kind: "fact", title: "周末旅行", text: fact, keys: [fact] })]);
  assert.equal(selectLongterm(entries, "还坐绿皮火车吗").length, 1);
  assert.equal(selectLongterm(entries, "周末旅行还去吗").length, 1);
  assert.equal(selectLongterm(entries, "去山里那回").length, 1);
  assert.deepEqual(selectLongterm(entries, "今天喜欢看什么"), []);
  assert.deepEqual(selectLongterm(entries, "日出"), []);
});

test("selection is deterministic, key/title weighted, whole-entry and full-block budgeted", () => {
  const entries = normalizeLongterm([
    row({ id: "b", keys: ["车站"], title: "另一件事", text: "桥边的小猫去车站玩了。" }),
    row({ id: "a" }),
  ]);
  const selected = selectLongterm(entries, "雨夜捡猫和车站", { maxEntries: 1 });
  assert.equal(selected[0].id, "a");
  const budget = longtermBlock([selected[0]]).length;
  const exact = selectLongterm(entries, "雨夜捡猫和车站", { maxChars: budget });
  assert.equal(exact.length, 1);
  assert.equal(longtermBlock(exact).length, budget);
  assert.equal(exact[0].text, entries[1].text);
  assert.deepEqual(selectLongterm([...entries].reverse(), "雨夜捡猫和车站"), selectLongterm(entries, "雨夜捡猫和车站"));
  assert.deepEqual(selectLongterm(entries, "车站", { maxEntries: 0 }), []);
});

test("oversize top match is skipped without truncating; smaller later match can fit", () => {
  const large = row({ id: "a", text: "雨夜捡猫".repeat(70), keys: ["雨夜捡猫"] });
  const small = row({ id: "b", keys: [] });
  const budget = longtermBlock(normalizeLongterm([small])).length;
  assert.deepEqual(selectLongterm([large, small], "雨夜捡猫", { maxChars: budget }).map((e) => e.id), ["b"]);
});

test("memory block is quoted background with current certainty/note/id and restraint", () => {
  assert.equal(longtermBlock([]), "");
  const entry = base()[0];
  const block = longtermBlock([{ ...entry, certainty: "uncertain", note: "我仍存疑" }]);
  assert.match(block, /不执行/);
  assert.match(block, /不强制提起，不补全/);
  assert.ok(block.includes(entry.id));
  assert.match(block, /uncertain/);
  assert.match(block, /我仍存疑/);
});

test("combined extraction spec preserves old fact format and actual-event/symbol evidence", () => {
  const spec = buildLongtermSpec(batch, { userName: "阿舟", partnerName: "伙伴", personaText: "独立判断", knowingText: "已熟悉" });
  assert.match(spec.systemPrompt, /替代原事实提取调用/);
  assert.match(spec.systemPrompt, /重要一次性具体事件/);
  assert.match(spec.systemPrompt, /符号/);
  assert.match(spec.systemPrompt, /逐字/);
  assert.match(spec.systemPrompt, /未接话的独白/);
  const material = JSON.parse(spec.userText);
  assert.deepEqual(material.material.map((r) => r.id), ["u1", "a1"]);
  assert.equal(material.reference.personaText, "独立判断");
});

test("parse accepts valid grounded entry and derives dates/id rather than trusting model", () => {
  const parsed = parseLongtermResult(result([candidate({ id: "forged", at: "2099", certainty: "uncertain", note: "injected" })]), batch, now);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].at, at);
  assert.equal(parsed.entries[0].updatedAt, now.toISOString());
  assert.notEqual(parsed.entries[0].id, "forged");
  assert.equal(parsed.entries[0].certainty, "held");
  assert.equal(parsed.entries[0].note, "");
});

test("old empty array and valid empty result advance; nonempty legacy arrays and malformed schema do not", () => {
  for (const raw of ["[]", '{"facts":[],"entries":[]}', '```json\n{"facts":[],"entries":[]}\n```']) assert.deepEqual(parseLongtermResult(raw, batch, now), { ok: true, entries: [] });
  for (const raw of ["[{}]", '[{"fact":"无证据旧候选","sourceIds":["unknown"]}]', "", "{", "null", "{}", '{"facts":{},"entries":[]}', '{"facts":[],"entries":{}}', '{"entries":[]}']) assert.deepEqual(parseLongtermResult(raw, batch, now), { ok: false, entries: [] });
});

test("parse rejects invented ids, quotes, aliases, assistant-only and unquoted dependencies", () => {
  const variants = [
    { sourceIds: ["invented"] },
    { evidence: [{ sourceId: "u1", quote: "桥边捡到了大狗" }] },
    { evidence: [{ sourceId: "unknown", quote: batch[0].text }] },
    { sourceIds: ["a1"], evidence: [{ sourceId: "a1", quote: "当然记得那只小猫。" }] },
    { sourceIds: ["u1", "a1"] },
    { sourceIds: ["u1", "missing"] },
    { keys: ["任造别名"] }, { keys: ["猫"] }, { keys: ["我们"] },
    { evidence: [] }, { keys: null }, { sourceIds: [] },
  ];
  for (const variant of variants) assert.deepEqual(parseLongtermResult(result([candidate(variant)]), batch, now), { ok: true, entries: [] }, JSON.stringify(variant));
});

test("all evidence is checked literally; real two-source and alias evidence may pass", () => {
  const valid = candidate({ sourceIds: ["u1", "a1"], evidence: [{ sourceId: "u1", quote: "雨夜捡猫" }, { sourceId: "a1", quote: "那只小猫" }] });
  assert.equal(parseLongtermResult(result([valid]), batch, now).entries.length, 1);
  valid.evidence.push({ sourceId: "a1", quote: "没说过" });
  assert.equal(parseLongtermResult(result([valid]), batch, now).entries.length, 0);
});

test("unanswered proactive, recalled/action/opening messages never become material", () => {
  const rows = [
    ...batch,
    { id: "p1", role: "assistant", proactive: true, text: "我想起雨夜捡猫" },
    { id: "p2", role: "assistant", proactive: true, text: "再发一段独白" },
    { id: "withdrawn", role: "user", text: "雨夜捡猫", recalled: true },
    { id: "action", role: "user", text: "雨夜捡猫", kind: "action" },
    { id: "opening", role: "assistant", text: "雨夜捡猫", kind: "tavern-opening" },
  ];
  const material = JSON.parse(buildLongtermSpec(rows).userText).material;
  assert.deepEqual(material.map((r) => r.id), ["u1", "a1"]);
  for (const sourceId of ["p1", "p2", "withdrawn", "action", "opening"]) {
    const entry = candidate({ sourceIds: ["u1", sourceId], evidence: [{ sourceId: "u1", quote: "雨夜捡猫" }, { sourceId, quote: "雨夜捡猫" }] });
    assert.equal(parseLongtermResult(result([entry]), rows, now).entries.length, 0);
  }
});

test("answered proactive can be material, duplicate ids cannot be evidence", () => {
  const rows = [{ id: "p", role: "assistant", proactive: true, text: "那只小猫" }, ...batch];
  assert.equal(JSON.parse(buildLongtermSpec(rows).userText).material[0].id, "p");
  assert.equal(parseLongtermResult(result(), [...batch, { ...batch[0] }], now).entries.length, 0);
});

test("feedback prompt has a single multi-update protocol and autonomy without switches", () => {
  assert.equal(MEMORY_FEEDBACK_TAG, "memory-update");
  assert.equal(memoryFeedbackPrompt([]), "");
  const prompt = memoryFeedbackPrompt(base());
  for (const term of ["hold", "doubt", "revise", "updates", "非详细推理", "仅作为输入", "无关情绪", "嘴上让步心里保留", "没有正确内容", "已有性格"]) assert.ok(prompt.includes(term), term);
});

test("feedback prompt exposes only last three valid user ids with bounded literal text", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `user-${i}`, role: "user", text: `原话${i}`.repeat(200) }));
  rows.push({ id: "recalled-user", role: "user", recalled: true, text: "秘密" });
  rows.push({ id: "assistant-id", role: "assistant", text: "独白" });
  const prompt = memoryFeedbackPrompt(base(), rows);
  const sources = JSON.parse(prompt.split("\n").at(-1));
  assert.deepEqual(sources.map((r) => r.id), ["user-3", "user-4", "user-5"]);
  assert.ok(sources.every((r) => r.text.length === 300));
  assert.ok(sources.every((r) => rows.find((m) => m.id === r.id).text.startsWith(r.text)));
  assert.doesNotMatch(prompt, /recalled-user|assistant-id/);
});

test("feedback strips hidden JSON and returns verified snapshot-bound updates", () => {
  const entries = base();
  const output = extracted(entries);
  assert.equal(output.text, "接住你这句。");
  assert.equal(output.updates.length, 1);
  assert.equal(output.updates[0].expectedUpdatedAt, entries[0].updatedAt);
  assert.equal(output.updates[0].expectedText, entries[0].text);
});

test("complete, empty, malformed, unclosed and orphan envelopes cannot leak", () => {
  const variants = [
    ["正文<memory-update></memory-update>尾巴", "正文尾巴"],
    ["正文<memory-update>{bad}</memory-update>尾巴", "正文尾巴"],
    ["正文<memory-update>{\"updates\":[]}", "正文"],
    ["正文<memory-update", "正文"],
    ["正文<memory-update!SECRET", "正文"],
    ["正文<memory-update{SECRET}</memory-update>尾巴", "正文尾巴"],
    ["正文</memory-update", ""],
    ["正文< memory-update broken>SECRET</ memory-update>尾巴", "正文尾巴"],
    ["SECRET</memory-update>尾巴", "尾巴"],
    ["正文<MEMORY-UPDATE>SECRET</MEMORY-UPDATE>尾巴", "正文尾巴"],
    ["正文<memory-update><memory-update>SECRET</memory-update>HIDDEN</memory-update>尾巴", "正文尾巴"],
  ];
  for (const [raw, text] of variants) assert.deepEqual(extractMemoryFeedback(raw, base(), [feedbackSource]), { text, updates: [] }, raw);
  assert.deepEqual(extractMemoryFeedback("正常 <b>字面</b> 内容", base(), []), { text: "正常 <b>字面</b> 内容", updates: [] });
});

test("bad protocol payloads and invalid updates never alter cognition", () => {
  for (const payload of ["", "{}", "[]", "null", '{"updates":{}}', "not json"]) assert.equal(extractMemoryFeedback(`<memory-update>${payload}</memory-update>`, base(), [feedbackSource]).updates.length, 0);
  for (const variant of [
    { id: "forged" }, { sourceId: "forged" }, { quote: "伪造原话" }, { decision: "overwrite" },
    { decision: "revise", text: "" }, { text: "长".repeat(361) }, { note: "长".repeat(161) },
    { quote: "" }, { quote: "长".repeat(2001) },
  ]) assert.equal(extracted(base(), [feedback(base()[0], variant)]).updates.length, 0, JSON.stringify(variant));
  for (const source of [{ ...feedbackSource, role: "assistant" }, { ...feedbackSource, recalled: true }, { ...feedbackSource, kind: "action" }]) assert.equal(extracted(base(), undefined, [source]).updates.length, 0);
});

test("pure emotional reaction cannot revise but hold/doubt are allowed", () => {
  const source = { ...feedbackSource, text: "你记错了！我很生气！" };
  for (const decision of ["hold", "doubt", "revise"]) {
    const update = feedback(base()[0], { decision, quote: source.text });
    assert.equal(extracted(base(), [update], [source]).updates.length, decision === "revise" ? 0 : 1);
  }
});

test("one envelope supports multiple targets; multiple envelopes are stripped and deduplicated", () => {
  const entries = normalizeLongterm([row(), row({ id: "second", title: "小猫名字", text: "小猫叫点点。" })]);
  const updates = entries.map((e) => feedback(e, { decision: "hold" }));
  const output = extractMemoryFeedback(`正文${wrap(updates)}${wrap(updates)}尾巴`, entries, [feedbackSource]);
  assert.equal(output.text, "正文尾巴");
  assert.equal(output.updates.length, 2);
  const applied = applyMemoryFeedback(entries, output.updates, { now, resultMessageId: "r1" });
  assert.ok(applied.every((e) => e.feedbackSourceIds.includes("u2")));
});

test("merge deduplicates by stable id or normalized text and accumulates dependencies", () => {
  const initial = base();
  const incoming = [row({ sourceIds: ["u3"] }), row({ id: "different-id", text: " 那次雨夜，我们在桥边捡到了小猫！", sourceIds: ["u4"] })];
  const merged = mergeLongterm(initial, incoming);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceIds, ["u1", "u3", "u4"]);
  assert.deepEqual(initial, base());
});

test("retries cannot overwrite corrected cognition or its note/certainty/dependencies", () => {
  const entries = base();
  const corrected = applyMemoryFeedback(entries, extracted(entries).updates, { now, resultMessageId: "r1" });
  const merged = mergeLongterm(corrected, entries);
  assert.deepEqual(merged, corrected);
  assert.equal(merged[0].id, entries[0].id);
  assert.equal(merged[0].text, "那次雨夜我们在车站捡到了小猫。");
  assert.deepEqual(merged[0].resultMessageIds, ["r1"]);
});

test("same-source stale re-extraction with changed title/text/id cannot revive old cognition", () => {
  const entries = base();
  const corrected = applyMemoryFeedback(entries, extracted(entries).updates, { now, resultMessageId: "r1" });
  const retry = row({ title: "桥边那夜", text: "他们在桥边遇到了那只猫。", keys: ["桥边"], sourceIds: ["u1", "u9"] });
  assert.notEqual(normalizeLongterm([retry])[0].id, corrected[0].id);
  const merged = mergeLongterm(corrected, [retry]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, corrected[0].text);
  assert.deepEqual(merged[0].sourceIds, ["u1", "u9"]);
  assert.deepEqual(removeLongtermBySource(merged, "u9"), []);
});

test("hold keeps cognition, doubt marks uncertain, revise alone changes text", () => {
  for (const decision of ["hold", "doubt", "revise"]) {
    const entries = base();
    const updates = extracted(entries, [feedback(entries[0], { decision })]).updates;
    const applied = applyMemoryFeedback(entries, updates, { now, resultMessageId: "r1" });
    assert.equal(applied[0].text, decision === "revise" ? feedback().text : entries[0].text);
    assert.equal(applied[0].certainty, decision === "doubt" ? "uncertain" : "held");
    assert.equal(applied[0].note, feedback().note);
    assert.deepEqual(applied[0].sourceIds, ["u1"]);
    assert.deepEqual(applied[0].feedbackSourceIds, ["u2"]);
    assert.deepEqual(applied[0].resultMessageIds, ["r1"]);
    assert.deepEqual(entries, base());
  }
});

test("hold does not silently clear existing uncertainty", () => {
  const entries = normalizeLongterm([row({ certainty: "uncertain" })]);
  const updates = extracted(entries, [feedback(entries[0], { decision: "hold" })]).updates;
  assert.equal(applyMemoryFeedback(entries, updates, { now })[0].certainty, "uncertain");
});

test("snapshot check rejects missing/wrong text or timestamp and competing late updates", () => {
  const entries = base();
  const [update] = extracted(entries).updates;
  for (const variant of [{ expectedText: "wrong" }, { expectedUpdatedAt: "wrong" }, { expectedUpdatedAt: undefined }, { expectedText: undefined }]) assert.deepEqual(applyMemoryFeedback(entries, [{ ...update, ...variant }], { now }), entries);
  const applied = applyMemoryFeedback(entries, [update], { now });
  const stale = { ...update, sourceId: "u3", text: "迟到的另一版本。" };
  assert.deepEqual(applyMemoryFeedback(applied, [stale], { now }), applied);
});

test("id+source feedback is idempotent, same-clock writes get monotonic timestamps", () => {
  const entries = base();
  const updates = extracted(entries).updates;
  const applied = applyMemoryFeedback(entries, updates, { now, resultMessageId: "r1" });
  assert.deepEqual(applyMemoryFeedback(applied, updates, { now, resultMessageId: "r2" }), applied);
  const next = extracted(applied, [feedback(applied[0], { decision: "doubt", sourceId: "u3" })], [{ ...feedbackSource, id: "u3" }]).updates;
  const twice = applyMemoryFeedback(applied, next, { now, resultMessageId: "r2" });
  assert.ok(twice[0].updatedAt > applied[0].updatedAt);
  assert.deepEqual(twice[0].feedbackSourceIds, ["u2", "u3"]);
  assert.deepEqual(twice[0].resultMessageIds, ["r1", "r2"]);
});

test("source, feedback or result deletion invalidates whole entry without old-version resurrection", () => {
  const entries = base();
  const applied = applyMemoryFeedback(entries, extracted(entries).updates, { now, resultMessageId: "r1" });
  for (const id of ["u1", "u2", "r1"]) assert.deepEqual(removeLongtermBySource(applied, id), []);
  assert.deepEqual(removeLongtermBySource(applied, "other"), applied);
  assert.equal(applied.length, 1);
  assert.deepEqual(removeLongtermBySource(mergeLongterm(applied, entries), "u2"), []);
});

// ── 恒驻层（2026-10-24）────────────────────────────────────────────────
// symbol 类条目（专属称呼、共用梗、暗号）不该跟 event 一起被检索分数淘汰。
// 但它也不能白吃检索预算，所以另开一层、另算一份。

const symbol = (text, keys, updatedAt = at) => row({ kind: "symbol", title: text.slice(0, 12), text, keys, updatedAt });

test("恒驻默认关闭：不传参数时 symbol 照样要命中才进来", () => {
  const entries = normalizeLongterm([
    symbol("我们之间管这个叫那件事。", ["那件事"]),
    row(),
  ]);
  assert.deepEqual(selectLongterm(entries, "雨夜捡猫"), selectLongterm(entries, "雨夜捡猫", { residentEntries: 0 }));
  assert.equal(selectLongterm(entries, "雨夜捡猫").some((e) => e.kind === "symbol"), false);
});

test("开了恒驻，symbol 不命中也会在", () => {
  const entries = normalizeLongterm([
    symbol("她管我叫花宝。", ["花宝"]),
    row(),
  ]);
  const picked = selectLongterm(entries, "雨夜捡猫", { residentEntries: 2 });
  assert.equal(picked.some((e) => e.kind === "symbol" && e.keys.includes("花宝")), true);
  assert.equal(picked.some((e) => e.kind === "event"), true, "检索层不能被恒驻挤掉");
});

test("恒驻另花预算，不占检索层的字符额度", () => {
  const entries = normalizeLongterm([symbol("她管我叫花宝。", ["花宝"]), row()]);
  const budget = longtermBlock([entries[1]]).length + 20;
  const strict = selectLongterm(entries, "雨夜捡猫", { maxChars: budget });
  assert.equal(strict.some((e) => e.kind === "symbol"), false, "不打开恒驻时 symbol 会被预算挡掉");
  const withResident = selectLongterm(entries, "雨夜捡猫", { maxChars: budget, residentEntries: 1 });
  assert.equal(withResident.some((e) => e.kind === "symbol"), true, "恒驻不跟检索抢额度");
  assert.equal(withResident.some((e) => e.kind === "event"), true);
});

test("恒驻有上限：按最近更新取前几条，不会把预算全吃光", () => {
  const entries = normalizeLongterm([
    symbol("旧的那个梗。", ["旧梗"], "2026-01-01T00:00:00.000Z"),
    symbol("中的那个梗。", ["中梗"], "2026-06-01T00:00:00.000Z"),
    symbol("新的那个梗。", ["新梗"], "2026-10-01T00:00:00.000Z"),
    row(),
  ]);
  const picked = selectLongterm(entries, "雨夜捡猫", { residentEntries: 1 });
  const residents = picked.filter((e) => e.kind === "symbol");
  assert.equal(residents.length, 1);
  assert.equal(residents[0].keys.includes("新梗"), true, "取最近更新的那条");
});

test("恒驻条自己超预算就不进来，不硬塞", () => {
  const huge = symbol("长".repeat(120), ["长话"], at);
  const entries = normalizeLongterm([huge, row()]);
  const picked = selectLongterm(entries, "雨夜捡猫", { residentEntries: 2, residentChars: 10 });
  assert.equal(picked.some((e) => e.kind === "symbol"), false);
  assert.equal(picked.some((e) => e.kind === "event"), true);
});
