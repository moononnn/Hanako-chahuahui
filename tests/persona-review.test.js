import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIMIT,
  SESSION_TTL_MS,
  applySuggestions,
  chatSpec,
  commitChange,
  describeChange,
  diagnosisSpec,
  emptySession,
  listHistory,
  mergeSuggestions,
  normalizeSession,
  normalizeSuggestion,
  parseChatReply,
  parseDiagnosis,
  pushHistory,
  revertTo,
  touchSession,
} from "../lib/persona-review.js";
import { emptyRecognition, applyRecognitionAnswer } from "../lib/recognition.js";
import { normalizePalette, MAX_ROWS_PER_COLOR } from "../lib/palette.js";

const knowingWith = (patch = {}) => ({
  personality: { surface: { tags: ["温润"], signals: ["待人有温度"] }, inner: { tags: [], signals: [] } },
  palette: normalizePalette({
    colors: [
      { id: "c1", name: "较真", role: "base" },
      { id: "c2", name: "坦率", role: "main" },
    ],
    derivatives: [{ id: "d1", colorId: "c1", text: "缺证据时先指出哪里站不住", on: true }],
  }),
  recognition: applyRecognitionAnswer(emptyRecognition(), "boundaries", {
    selected: ["lecture"],
    scenarios: [{ scene: "她刚说完糗事", reaction: "不要拆成经验总结" }],
  }),
  ...patch,
});

test("建议形状：七种之外的一律丢掉", () => {
  assert.equal(normalizeSuggestion({ label: "x", op: "乱来" }), null);
  assert.equal(normalizeSuggestion({ label: "x", op: "scenario_add", questionId: "不存在", scene: "a", reaction: "b" }), null);
  assert.equal(normalizeSuggestion({ label: "x", op: "derivative_update", derivativeId: "d1", text: "" }), null);
  assert.ok(normalizeSuggestion({ label: "补一条", op: "scenario_add", questionId: "boundaries", scene: "她说今天好累", reaction: "不要追问细节" }));
  assert.ok(normalizeSuggestion({ label: "改行为", op: "derivative_update", derivativeId: "d1", text: "换了句话" }));
  // 材料里只给标题，模型拿标题当 id 填是常事，得能认回来。
  assert.equal(
    normalizeSuggestion({ label: "补一条", op: "scenario_add", questionId: "有什么是 ta 绝对不能做的？", scene: "a", reaction: "b" })?.questionId,
    "boundaries",
  );
  // 加色：名字和位置都得有，缺一样就落不了。
  assert.equal(normalizeSuggestion({ label: "加个色", op: "color_add", name: "温润", role: "base" })?.role, "base");
  assert.equal(normalizeSuggestion({ label: "加个色", op: "color_add", name: "温润" }), null);
  assert.equal(normalizeSuggestion({ label: "加个色", op: "color_add", name: "温润", role: "乱来" }), null);
});

test("模型回包：容错解析三种脏格式", () => {
  const wrapped = parseDiagnosis('```json\n{"opening":"我先看了一遍","keep":[{"title":"有温度","quote":"待人有温度","why":"立得住"}],"grow":[{"title":"禁区太薄","quote":"不要拆成经验总结","why":"只有一条","direction":"补被装熟时怎么办"}]}\n```');
  assert.equal(wrapped.keep.length, 1);
  assert.equal(wrapped.grow[0].direction, "补被装熟时怎么办");
  assert.deepEqual(wrapped.openings, ["我先看了一遍"], "老形状的单句 opening 也要读得出");

  const noisy = parseDiagnosis('好的，这是结论：{"opening":"嗯","keep":[],"grow":[{"title":"缺语料","quote":"","why":"一句原话都没有"}]} 希望有用');
  assert.equal(noisy.grow.length, 1);
  assert.equal(noisy.keep.length, 0);

  assert.equal(parseDiagnosis("没想出什么"), null);

  // 开场是气泡流的第一屏。模型写了就照着来，漏了也得有一句，不能空着。
  const multi = parseDiagnosis('{"openings":["嗯，我看完了","像的地方挺稳","有一处可以再稳点","这是第四句该被裁掉"],"keep":[],"grow":[{"title":"x","quote":"","why":"y"}]}');
  assert.deepEqual(multi.openings, ["嗯，我看完了", "像的地方挺稳", "有一处可以再稳点"], "开场最多三句");
  const silent = parseDiagnosis('{"keep":[{"title":"x","quote":"q","why":"w"}]}');
  assert.equal(silent.openings.length, 1, "模型漏了开场也不能空着");
  assert.ok(!silent.openings[0].includes("{"), "兜底那句要是人话，不是 JSON");

  const chat = parseChatReply('{"reply":"那我先记一条","suggestions":[{"label":"补禁区","op":"scenario_add","questionId":"boundaries","scene":"她只回了一个嗯","reaction":"不要追问细节"}]}');
  assert.equal(chat.suggestions.length, 1);
  assert.equal(chat.suggestions[0].questionId, "boundaries");
});

test("建议应用：调色盘空着时能加色，也能顺便带第一条行为", () => {
  const knowing = { ...knowingWith(), palette: normalizePalette({}) };
  const { knowing: after, applied, skipped } = applySuggestions(knowing, [
    { label: "加个底色", op: "color_add", name: "温润", role: "base", text: "不急着抢话，等气氛出现空隙后补上简短回应" },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(applied.length, 1);
  assert.equal(after.palette.colors.length, 1);
  assert.equal(after.palette.colors[0].name, "温润");
  assert.equal(after.palette.colors[0].role, "base");
  assert.equal(after.palette.derivatives.length, 1, "顺便带的那条行为要挂在新色下面");
  assert.equal(after.palette.derivatives[0].colorId, after.palette.colors[0].id);
  assert.equal(knowing.palette.colors.length, 0, "原档案不该被改到");
});

test("建议应用：色名当 id 填了也能认，不会整条丢掉", () => {
  const { applied, skipped, knowing: after } = applySuggestions(knowingWith(), [
    { label: "给较真加一条", op: "derivative_add", colorId: "较真", text: "拿不准的时候直接说拿不准" },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(applied.length, 1);
  assert.equal(after.palette.derivatives.filter((row) => row.colorId === "c1").length, 2);
});

test("建议应用：其实没动的不算落下", () => {
  // 这个色的记录已经满了，addDerivative 会原样返回；不能被报成「已应用」。
  const knowing = knowingWith();
  const filled = {
    ...knowing,
    palette: normalizePalette({
      colors: knowing.palette.colors,
      derivatives: Array.from({ length: MAX_ROWS_PER_COLOR }, (_, i) => ({ id: `d${i}`, colorId: "c1", text: `第 ${i} 条行为` })),
    }),
  };
  const { applied, skipped } = applySuggestions(filled, [
    { label: "再加一条", op: "derivative_add", colorId: "c1", text: "塞不进去的一条" },
  ]);
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /满了|找不到/, "落不上要说得具体，不能只说「落不上」");
});

test("建议应用：加场景、改反应、改补充、加行为都落得上", () => {
  const knowing = knowingWith();
  const { knowing: after, applied, skipped } = applySuggestions(knowing, [
    { label: "补禁区", op: "scenario_add", questionId: "boundaries", scene: "她只回了一个嗯", reaction: "不要追问细节" },
    { label: "改一下第一条", op: "scenario_update", questionId: "boundaries", index: 0, reaction: "不要拆成经验总结逐条分析" },
    { label: "补原话", op: "answer_text", questionId: "speech", text: "等下等下，改明天吗？" },
    { label: "加行为", op: "derivative_add", colorId: "c2", text: "被指出遗漏时直接说漏了哪一步" },
    { label: "落不上的", op: "derivative_update", derivativeId: "d_not_exist", text: "x" },
  ]);
  assert.equal(applied.length, 4);
  assert.equal(skipped.length, 1);
  assert.equal(after.recognition.answers.boundaries.scenarios.length, 2);
  assert.equal(after.recognition.answers.boundaries.scenarios[0].reaction, "不要拆成经验总结逐条分析");
  assert.equal(after.recognition.answers.speech.text, "等下等下，改明天吗？");
  assert.equal(after.palette.derivatives.filter((row) => row.colorId === "c2").length, 1);
  assert.equal(knowing.palette.derivatives.filter((row) => row.colorId === "c2").length, 0, "原档案不该被改到");
});

test("建议应用：同一目标后来的算数，不会自己跟自己打架", () => {
  const merged = mergeSuggestions(
    [{ label: "旧", op: "answer_note", questionId: "traits", text: "旧的" }],
    [{ label: "新", op: "answer_note", questionId: "traits", text: "新的" }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "新的");
});

test("历史版本：存改前那版，回退能来回切，最多留两版", () => {
  const before = knowingWith();
  const after = applySuggestions(before, [
    { label: "补禁区", op: "scenario_add", questionId: "boundaries", scene: "她只回了一个嗯", reaction: "不要追问细节" },
  ]).knowing;
  const committed = commitChange(before, after, { reason: "和小花聊聊：场景多了 1 条" });
  assert.equal(listHistory(committed).length, 1);
  assert.equal(listHistory(committed)[0].snapshot.recognition.answers.boundaries.scenarios.length, 1, "历史里存的是改前那版");

  const back = revertTo(committed, listHistory(committed)[0].at);
  assert.equal(back.ok, true);
  assert.equal(back.knowing.recognition.answers.boundaries.scenarios.length, 1);
  assert.equal(listHistory(back.knowing).length, 2, "回退也留一条，所以还能再换回来");

  const thrice = pushHistory(pushHistory(back.knowing, { reason: "第二版" }), { reason: "第三版" });
  assert.equal(listHistory(thrice).length, HISTORY_LIMIT);

  assert.equal(revertTo(committed, "2020-01-01T00:00:00.000Z").ok, false);
});

test("会话：过期的会话明说失效，不续成新的", () => {
  const fresh = touchSession(emptySession("hanako"), { stage: "diagnosed" });
  assert.ok(normalizeSession(fresh));
  const stale = { ...fresh, updatedAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString() };
  assert.equal(normalizeSession(stale), null);
  assert.equal(normalizeSession({ agentId: "hanako", stage: "乱来" }).stage, "idle");
});

test("检查提示词：标准、档案原文、机械结果都进得去", () => {
  const spec = diagnosisSpec({
    partnerName: "小花",
    userName: "阿舟",
    dossier: "【两层画像】标签：温润",
    mechanical: { items: [{ id: "corpus", level: "empty", note: "一句原话都没有" }], render: { note: "没有调色盘" } },
  });
  assert.ok(spec.systemPrompt.includes("性格体检") === false);
  assert.ok(spec.systemPrompt.includes("行为可观察"));
  assert.ok(spec.userText.includes("标签：温润"));
  assert.ok(spec.userText.includes("corpus｜empty"));
  assert.ok(spec.userText.includes("没有调色盘"));

  const chat = chatSpec({
    partnerName: "小花",
    userName: "阿舟",
    dossier: "档案",
    messages: [{ role: "user", text: "我想让 ta 别老等我先开口" }],
    suggestions: [{ label: "补禁区" }],
  });
  assert.ok(chat.userText.includes("我想让 ta 别老等我先开口"));
  assert.ok(chat.userText.includes("补禁区"));
});

test("摘要：改了什么都说得出来", () => {
  const before = knowingWith();
  const after = applySuggestions(before, [
    { label: "补禁区", op: "scenario_add", questionId: "boundaries", scene: "她只回了一个嗯", reaction: "不要追问细节" },
  ]).knowing;
  assert.ok(describeChange(before, after).includes("场景多了 1 条"));
  assert.equal(describeChange(before, before), "内容有改动");
});
