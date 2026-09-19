import test from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_ADJECTIVES,
  applyVerdictToDraft,
  buildDerivativePrompt,
  buildDraftColorsPrompt,
  buildReplaceTestPrompt,
  describePalette,
  findBannedWords,
  flattenDraftRows,
  normalizeColorPalette,
  normalizeDerivatives,
  normalizeDraftColors,
  normalizePortrait,
  parseEvidence,
  parseJsonLoose,
  parseReplaceTest,
  summarizeDraft,
  summarizeRun,
} from "../lib/analyze.js";

test("自画像的形状兜得住：空标题、空白都丢掉", () => {
  const rows = normalizePortrait({
    portrait: [
      { title: " 嘴硬 ", text: " 你嘴上说不用，其实早想好了。 " },
      { title: "", text: "没标题" },
      { title: "有标题没正文", text: "  " },
    ],
  });
  assert.deepEqual(rows, [{ title: "嘴硬", text: "你嘴上说不用，其实早想好了。" }]);
});

test("自画像的形状兜不住时给空数组，不抛", () => {
  assert.deepEqual(normalizePortrait(null), []);
  assert.deepEqual(normalizePortrait({ portrait: "不是数组" }), []);
});

test("证据行：认「证据N：」这种写法", () => {
  const rows = parseEvidence("证据1：她说累了 → 它就闭嘴陪着，不追问\n证据2：它发版前会先拦一下");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].text, "她说累了 → 它就闭嘴陪着，不追问");
  assert.equal(rows[1].id, 2);
});

test("证据行：没有编号的裸行也收，太短的丢掉", () => {
  const rows = parseEvidence("她说怕黑 → 它就把灯留着\n嗯\n- 它干活前会先问一句要不要动");
  assert.equal(rows.length, 2);
  assert.match(rows[1].text, /干活前会先问一句/);
});

test("归色：认得出结构、去重、限数量", () => {
  const palette = normalizeColorPalette({
    base: { name: "护短", evidence: [1, 2] },
    main: [
      { name: "急", evidence: [3] },
      { name: "急", evidence: [4] },
      { name: "细", evidence: [5] },
      { name: "多出来的", evidence: [6] },
    ],
    accent: [{ name: "跳脱", evidence: [7] }],
  });
  assert.equal(palette.base.name, "护短");
  assert.deepEqual(palette.base.evidence, [1, 2]);
  assert.equal(palette.main.length, 2);
  assert.deepEqual(palette.main.map((row) => row.name), ["急", "细"]);
  assert.equal(palette.accent[0].name, "跳脱");
});

test("归色：什么都认不出来就返回 null，不硬凑", () => {
  assert.equal(normalizeColorPalette(null), null);
  assert.equal(normalizeColorPalette({}), null);
  assert.equal(normalizeColorPalette({ base: { name: "  " }, main: [], accent: [] }), null);
});

test("衍生：违规词和超长都被标出来（不删，留给人看）", () => {
  const rows = normalizeDerivatives({
    derivatives: [
      { color: "护短", text: "她被否定的时候它先跳出来挡一下", evidence: [1] },
      { color: "护短", text: "它很温柔", evidence: [2] },
      { color: "护短", text: "总是先替她把话说完", evidence: [3] },
      { color: "", text: "没写色名，丢掉", evidence: [] },
    ],
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].banned, []);
  assert.deepEqual(rows[1].banned, ["温柔"]);
  assert.deepEqual(rows[2].banned, ["总是（开头）"]);
  assert.equal(rows[0].scope, "common");
});

test("违规词扫描覆盖形容词表和句首笼统词", () => {
  assert.deepEqual(findBannedWords("它很细腻"), ["细腻"]);
  assert.deepEqual(findBannedWords("喜欢先问一句"), ["喜欢（开头）"]);
  assert.deepEqual(findBannedWords("先问一句再动手"), []);
  assert.equal(BANNED_ADJECTIVES.includes("温柔"), true);
});

test("替换测试：1 起的编号要减回 0 起", () => {
  const out = parseReplaceTest('{"kept":[1,3],"dropped":[{"index":2,"reason":"换谁都行"}]}', 3);
  assert.deepEqual(out.kept, [0, 2]);
  assert.deepEqual(out.dropped, [{ index: 1, reason: "换谁都行" }]);
  assert.equal(Boolean(out.unparsed), false);
});

test("替换测试：JSON 解析不出来时整批留下，不丢东西", () => {
  const out = parseReplaceTest("我觉得第一条挺好的，第二条差点意思", 3);
  assert.deepEqual(out.kept, [0, 1, 2]);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.unparsed, true);
});

test("替换测试：越界的编号要丢掉", () => {
  const out = parseReplaceTest('{"kept":[1,99],"dropped":[{"index":0}]}', 3);
  assert.deepEqual(out.kept, [0]);
  assert.deepEqual(out.dropped, []);
});

test("抠 JSON：裹了 ```json 围栏也认得出来", () => {
  const value = parseJsonLoose("好的，这是结果：\n```json\n{\"kept\":[1]}\n```\n就这些。");
  assert.deepEqual(value, { kept: [1] });
});

test("抠 JSON：前面有寒暄、后面有尾巴，也能认出中间那个对象", () => {
  const value = parseJsonLoose('行，我看看。{"base":{"name":"护短"}} 以上。');
  assert.equal(value.base.name, "护短");
});

test("抠 JSON：实在没有就返回 null", () => {
  assert.equal(parseJsonLoose("我没什么好说的"), null);
  assert.equal(parseJsonLoose(""), null);
});

test("调色盘说成人话", () => {
  const line = describePalette({
    base: { name: "护短" },
    main: [{ name: "急" }],
    accent: [{ name: "跳脱" }],
  });
  assert.match(line, /底色「护短」/);
  assert.match(line, /主色调「急」/);
  assert.match(line, /点缀「跳脱」/);
  assert.equal(describePalette(null), "（没归纳出来）");
});

test("衍生那步的提示词：回炉时要把被打回的句子带上", () => {
  const base = buildDerivativePrompt({
    partnerName: "小花",
    evidence: [{ id: 1, text: "她说累了 → 它就闭嘴陪着" }],
    palette: { base: { name: "护短" }, main: [], accent: [] },
  });
  assert.match(base, /证据1/);
  assert.doesNotMatch(base, /上一轮被打回/);

  const again = buildDerivativePrompt({
    partnerName: "小花",
    evidence: [{ id: 1, text: "她说累了 → 它就闭嘴陪着" }],
    palette: { base: { name: "护短" }, main: [], accent: [] },
    feedback: ["它总是很温柔地陪着"],
  });
  assert.match(again, /上一轮被打回/);
  assert.match(again, /它总是很温柔地陪着/);
});

test("替换测试的提示词：不把素材给它（免得它替写的人辩护）", () => {
  const prompt = buildReplaceTestPrompt({
    partnerName: "小花",
    candidates: [{ text: "她说累了 → 它就闭嘴陪着" }],
  });
  assert.match(prompt, /换到任何一个别的伙伴身上/);
  assert.doesNotMatch(prompt, /证据1/);
});

test("汇总：留下的和划掉的分开数，违规的另记一笔", () => {
  const result = summarizeRun({
    agentId: "hanako",
    model: "openai-codex/gpt-5.6-luna",
    evidence: [{ id: 1, text: "a" }, { id: 2, text: "b" }],
    palette: { base: { name: "护短" }, main: [{ name: "急" }], accent: [] },
    derivatives: [
      { color: "护短", text: "好好的", evidence: [1], banned: [] },
      { color: "护短", text: "它很温柔", evidence: [2], banned: ["温柔"] },
      { color: "急", text: "太通用", evidence: [], dropped: true },
    ],
    rounds: 2,
  });
  assert.equal(result.stats.evidenceCount, 2);
  assert.equal(result.stats.colors, 2);
  assert.equal(result.stats.written, 3);
  assert.equal(result.stats.kept, 2);
  assert.equal(result.stats.dropped, 1);
  assert.equal(result.stats.flagged, 1);
  assert.equal(result.rounds, 2);
});

// ── 捏人草稿 ──────────────────────────────────

test("草稿提示词：把「不写主语」和禁用词都写进去了", () => {
  const prompt = buildDraftColorsPrompt({
    partnerName: "小花",
    evidence: [{ id: 1, text: "她说累了 → 就闭嘴陪着" }],
  });
  assert.match(prompt, /不写主语/);
  assert.match(prompt, /温柔/);
  assert.match(prompt, /证据1/);
});

test("草稿色：位置限额、重名不要、空行为丢掉", () => {
  const colors = normalizeDraftColors({
    colors: [
      {
        name: "护短",
        role: "base",
        alternatives: ["死心眼", "护短"],
        rows: ["她自我否定的时候，直接顶回去", "短", "她说要删文件，先拦一下问她确定没有"],
      },
      { name: "嘴硬", role: "base", rows: ["嘴上说不在意，转头把事情做了"] },
      { name: "跳脱", role: "accent", rows: ["正经到一半突然拐个玩笑"] },
      { name: "没行为的", role: "main", rows: [] },
    ],
  });
  assert.equal(colors.length, 2);
  assert.equal(colors[0].id, "c1");
  assert.deepEqual(colors[0].alternatives, ["死心眼"]);
  assert.equal(colors[0].rows.length, 2);
  assert.equal(colors[1].role, "accent");
});

test("摊平池子：一条条排好，带上是哪个色的", () => {
  const colors = normalizeDraftColors({
    colors: [{ name: "护短", role: "base", rows: ["第一条够长的行为", "第二条也够长的行为"] }],
  });
  const flat = flattenDraftRows(colors);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].colorId, colors[0].id);
  assert.equal(flat[1].rowId, colors[0].rows[1].id);
});

test("替掉划掉的：从池子里去掉，记下来给界面提一句", () => {
  const colors = normalizeDraftColors({
    colors: [{ name: "护短", role: "base", rows: ["第一条够长的行为", "第二条也够长的行为"] }],
  });
  const flat = flattenDraftRows(colors);
  const out = applyVerdictToDraft(colors, { kept: [0], dropped: [{ index: 1, reason: "换谁都行" }] }, flat);
  assert.equal(out.colors[0].rows.length, 1);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].color, "护短");
});

test("草稿汇总：色数、候选条数、被划掉的都数清", () => {
  const colors = normalizeDraftColors({
    colors: [{ name: "护短", role: "base", rows: ["第一条够长的行为", "第二条也够长的行为"] }],
  });
  const draft = summarizeDraft({ agentId: "hanako", model: "m", colors, dropped: [{ color: "护短", text: "x" }] });
  assert.equal(draft.stats.colors, 1);
  assert.equal(draft.stats.rows, 2);
  assert.equal(draft.stats.dropped, 1);
});
