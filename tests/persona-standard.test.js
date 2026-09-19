import test from "node:test";
import assert from "node:assert/strict";
import {
  LEVEL_LABELS,
  STANDARD_GROUPS,
  STANDARD_JUDGED,
  inspectPersona,
  renderDossier,
  standardToText,
} from "../lib/persona-standard.js";
import { emptyPalette } from "../lib/palette.js";
import { emptyRecognition, applyRecognitionAnswer } from "../lib/recognition.js";

const persona = (tags = ["温润"], signals = ["待人有温度但不失分寸"]) => ({
  surface: { tags, signals },
  inner: { tags: [], signals: [] },
});

const paletteWith = () => ({
  colors: [
    { id: "c1", name: "较真", role: "base" },
    { id: "c2", name: "坦率", role: "main" },
  ],
  derivatives: [
    { id: "d1", colorId: "c1", text: "发现说法缺证据时，先指出哪里站不住", on: true },
    { id: "d2", colorId: "c2", text: "被指出遗漏时，直接说漏了哪一步", on: true },
  ],
  portrait: [],
  corpus: [],
});

test("体检标准：四组都在，机械项和判断题分得开", () => {
  assert.equal(STANDARD_GROUPS.length, 4);
  const ids = STANDARD_GROUPS.flatMap((group) => group.items.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length, "id 不能重");
  const machine = STANDARD_GROUPS.flatMap((group) => group.items).filter((item) => item.machine).map((item) => item.id);
  assert.deepEqual(machine, ["coverage", "colorWiring", "reverseCoverage", "corpus"]);
  assert.equal(STANDARD_JUDGED.length + machine.length, ids.length);
  const text = standardToText();
  for (const item of STANDARD_GROUPS.flatMap((group) => group.items)) {
    assert.ok(text.includes(item.title), `${item.id} 的标题要进标准文本`);
  }
  assert.deepEqual(Object.keys(LEVEL_LABELS), ["ok", "gap", "empty"]);
});

test("体检标准：空档案一律报空着，不猜", () => {
  const result = inspectPersona({});
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every((item) => item.level === "empty"));
  assert.equal(result.render.paletteOverridesPersonality, false);
});

test("体检标准：调色盘挂齐了行为就是过得去", () => {
  const result = inspectPersona({
    personality: persona(),
    palette: paletteWith(),
    recognition: applyRecognitionAnswer(emptyRecognition(), "relationship", { selected: ["old_friend"] }),
  });
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(byId.get("colorWiring").level, "ok");
  assert.equal(byId.get("coverage").level, "gap", "七题没答完算有缺口");
  assert.equal(byId.get("reverseCoverage").level, "empty");
});

test("体检标准：有色没行为、只挂了一半，报缺口", () => {
  const palette = paletteWith();
  palette.derivatives = [{ id: "d1", colorId: "c1", text: "只有底色有行为", on: true }];
  const result = inspectPersona({ palette });
  const row = result.items.find((item) => item.id === "colorWiring");
  assert.equal(row.level, "gap");
  assert.ok(row.note.includes("没有活的行为"));
});

test("体检标准：反向题只选词不算过关，有具体场景才算", () => {
  let recognition = emptyRecognition();
  recognition = applyRecognitionAnswer(recognition, "boundaries", { selected: ["lecture"] });
  recognition = applyRecognitionAnswer(recognition, "misreadings", { selected: ["sweet"] });
  assert.equal(inspectPersona({ recognition }).items.find((item) => item.id === "reverseCoverage").level, "gap");

  recognition = applyRecognitionAnswer(recognition, "boundaries", {
    selected: ["lecture"],
    scenarios: [{ scene: "她刚说完糗事", reaction: "不要拆成经验总结逐条分析" }],
  });
  recognition = applyRecognitionAnswer(recognition, "misreadings", {
    selected: ["sweet"],
    scenarios: [{ scene: "店家的杯子有裂痕", reaction: "不要一味说那就算啦" }],
  });
  assert.equal(inspectPersona({ recognition }).items.find((item) => item.id === "reverseCoverage").level, "ok");
});

test("体检标准：语料只看纯对话，混了神态要点出来", () => {
  const recognition = applyRecognitionAnswer(emptyRecognition(), "speech", { selected: ["short"], text: "等下等下，改明天吗？" });
  const clean = inspectPersona({
    recognition,
    palette: { ...emptyPalette(), corpus: [{ scene: "改约饭时间", lines: ["那我先不出门了"] }] },
  });
  assert.equal(clean.items.find((item) => item.id === "corpus").level, "ok");

  const impure = inspectPersona({
    recognition,
    palette: { ...emptyPalette(), corpus: [{ scene: "改约饭时间", lines: ["（低头看了眼手机）那我先不出门了"] }] },
  });
  assert.equal(impure.items.find((item) => item.id === "corpusPurity").level, "gap");
});

test("体检标准：有调色盘时要提醒它盖掉了两层画像", () => {
  const result = inspectPersona({ palette: paletteWith() });
  assert.equal(result.render.paletteOverridesPersonality, true);
  assert.ok(result.render.note.includes("两层画像"));
});

test("体检标准：档案摊开给模型看，句子不重标点、不丢题", () => {
  const recognition = applyRecognitionAnswer(emptyRecognition(), "boundaries", {
    selected: ["lecture"],
    scenarios: [{ scene: "她刚说完糗事", reaction: "不要拆成经验总结。" }],
  });
  const dossier = renderDossier({
    personality: persona(),
    palette: paletteWith(),
    recognition,
  });
  assert.ok(dossier.includes("底色「较真」"));
  assert.ok(dossier.includes("不要：不要拆成经验总结。"));
  assert.ok(!dossier.includes("。。"), "不该出现双句号");
  assert.ok(dossier.includes("采访进度"));
  // id 必须摊给模型：不摊它只能拿名字/标题去猜，猜出来的落不到档案上。
  assert.match(dossier, /colorId: c\w+/, "色要带 colorId");
  assert.match(dossier, /derivativeId: d\w+/, "行为要带 derivativeId");
  assert.match(dossier, /questionId: boundaries/, "题目要带 questionId");
});
