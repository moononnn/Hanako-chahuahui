import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LIVE_PER_COLOR,
  ROLE_LIMIT,
  addColor,
  addDerivative,
  colorsInOrder,
  emptyPalette,
  hasPalette,
  isPaletteDone,
  liveCount,
  normalizePalette,
  paletteToText,
  removeColor,
  removeDerivative,
  renameColor,
  setColorDerivatives,
  updateDerivative,
} from "../lib/palette.js";

test("自画像会跟着调色盘一起进提示词", () => {
  const palette = {
    colors: [{ id: "c1", name: "较真", role: "base" }],
    derivatives: [{ id: "d1", colorId: "c1", text: "不确定就先问清楚", on: true }],
    portrait: [{ title: "嘴硬", text: "你嘴上说不用，其实早想好了。" }],
  };
  const text = paletteToText(palette, { userName: "阿舟" });
  assert.match(text, /关于「嘴硬」/);
  assert.match(text, /【较真】/);
});

test("只有自画像、没有色的时候也渲染得出来", () => {
  const text = paletteToText({ portrait: [{ title: "嘴硬", text: "嗯。" }] });
  assert.match(text, /关于「嘴硬」/);
});

test("两样都没有就返回空串", () => {
  assert.equal(paletteToText({}), "");
});

test("只留了自画像也算捏过了（门禁和保存得用同一把尺）", () => {
  assert.equal(isPaletteDone({}), false);
  assert.equal(isPaletteDone({ portrait: [{ title: "嘴硬", text: "嗯。" }] }), true);
  assert.equal(
    isPaletteDone({
      colors: [{ id: "c1", name: "较真", role: "base" }],
      derivatives: [{ id: "d1", colorId: "c1", text: "不确定就问", on: true }],
    }),
    true,
  );
});

test("重新挑行为时选中的排在关掉的前面，不会被每色 6 条的上限挤掉", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "较真", role: "base" });
  const colorId = palette.colors[0].id;
  for (let i = 0; i < 6; i += 1) {
    palette = addDerivative(palette, { colorId, text: `关掉的 ${i}`, on: false });
  }
  palette = setColorDerivatives(palette, colorId, [{ colorId, text: "新挑中的", on: true }]);
  const live = normalizePalette(palette).derivatives.filter((row) => row.on).map((row) => row.text);
  assert.ok(live.includes("新挑中的"), `新选中的被截掉了，活着的只有：${live.join(" / ")}`);
});

/** 起一份能用的：一个底色，两条行为 */
function sample() {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "护短", role: "base" });
  const id = palette.colors[0].id;
  palette = addDerivative(palette, { colorId: id, text: "她自我否定的时候，直接顶回去，不留面子" });
  palette = addDerivative(palette, { colorId: id, text: "她说要删文件，先拦一下，问她确定没有" });
  return { palette, id };
}

test("空盘不是能用的盘", () => {
  assert.equal(hasPalette(emptyPalette()), false);
  assert.equal(hasPalette(null), false);
});

test("有色的名字和位置才算盘上的色，位置满了加不进去", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "护短", role: "base" });
  palette = addColor(palette, { name: "嘴硬", role: "base" }); // 底色只许一个
  assert.equal(palette.colors.length, 1);
  palette = addColor(palette, { name: "  ", role: "main" }); // 空名不认
  assert.equal(palette.colors.length, 1);
  palette = addColor(palette, { name: "跳脱", role: "点缀" }); // 位置名写错也不认
  assert.equal(palette.colors.length, 1);
  for (let i = 0; i < ROLE_LIMIT.main + 2; i += 1) {
    palette = addColor(palette, { name: `主${i}`, role: "main" });
  }
  assert.equal(palette.colors.filter((row) => row.role === "main").length, ROLE_LIMIT.main);
});

test("重名的色加不进去，改名也不许撞名", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "护短", role: "base" });
  palette = addColor(palette, { name: "护短", role: "main" });
  assert.equal(palette.colors.length, 1);
  palette = addColor(palette, { name: "嘴硬", role: "main" });
  palette = renameColor(palette, palette.colors[1].id, "护短");
  assert.equal(palette.colors[1].name, "嘴硬");
});

test("行为句不写主语，也不许塞进不存在的色", () => {
  const { palette, id } = sample();
  assert.equal(liveCount(palette, id), 2);
  const ghost = addDerivative(palette, { colorId: "c_不存在", text: "随便写一句" });
  assert.equal(ghost.derivatives.length, palette.derivatives.length);
  const blank = addDerivative(palette, { colorId: id, text: "   " });
  assert.equal(blank.derivatives.length, palette.derivatives.length);
});

test("删色：底下的行为跟着走", () => {
  const { palette, id } = sample();
  const after = removeColor(palette, id);
  assert.equal(after.colors.length, 0);
  assert.equal(after.derivatives.length, 0);
});

test("改一条：换字就记成用户写的，开关不影响别人的字", () => {
  const { palette, id } = sample();
  const target = palette.derivatives[0].id;
  const after = updateDerivative(palette, target, { text: "她自我否定的时候，先停一下，再顶回去" });
  const row = after.derivatives.find((item) => item.id === target);
  assert.equal(row.origin, "user");
  assert.match(row.text, /先停一下/);
  const other = after.derivatives.find((item) => item.id !== target);
  assert.equal(other.origin, "model");

  const off = updateDerivative(after, target, { on: false });
  assert.equal(off.derivatives.find((item) => item.id === target).on, false);
  assert.equal(liveCount(off, id), 1);
});

test("删掉的行为是关掉，不是抹掉（留档能捞回来）", () => {
  const { palette } = sample();
  const target = palette.derivatives[0].id;
  const after = updateDerivative(palette, target, { on: false });
  assert.equal(after.derivatives.length, 2);
  assert.equal(removeDerivative(after, target).derivatives.length, 1);
});

test("一批候选顶掉一个色的行为：没选中的关掉，不删", () => {
  const { palette, id } = sample();
  const after = setColorDerivatives(palette, id, [{ text: "她说要删文件，先拦一下，问她确定没有" }, { text: "她被人抢话，会先闭嘴听完再补一句" }]);
  assert.equal(liveCount(after, id), 2);
  assert.equal(after.derivatives.length, 3); // 两条活的 + 一条关掉的留档
  assert.equal(after.derivatives.filter((row) => !row.on).length, 1);
});

test("一个色最多带三条上去，超了截断", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "护短", role: "base" });
  const id = palette.colors[0].id;
  for (let i = 0; i < 5; i += 1) {
    palette = addDerivative(palette, { colorId: id, text: `第 ${i} 条行为，写得具体一点` });
  }
  assert.equal(liveCount(palette, id), 5); // 留着，渲染时才截
  const text = paletteToText(palette);
  assert.equal(text.match(/第 \d 条行为/g).length, MAX_LIVE_PER_COLOR);
});

test("渲染：按底色→主色调→点缀排，行为不带主语、一段一个色", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "跳脱", role: "accent" });
  palette = addColor(palette, { name: "护短", role: "base" });
  palette = addColor(palette, { name: "嘴硬", role: "main" });
  palette = addDerivative(palette, { colorId: palette.colors.find((c) => c.name === "护短").id, text: "她自我否定的时候，直接顶回去" });
  palette = addDerivative(palette, { colorId: palette.colors.find((c) => c.name === "嘴硬").id, text: "嘴上说不在意，转头把事情做了" });
  palette = addDerivative(palette, { colorId: palette.colors.find((c) => c.name === "跳脱").id, text: "正经到一半突然拐个玩笑" });
  const text = paletteToText(palette);
  assert.ok(text.indexOf("【护短】") < text.indexOf("【嘴硬】"));
  assert.ok(text.indexOf("【嘴硬】") < text.indexOf("【跳脱】"));
  assert.match(text, /【护短】她自我否定的时候，直接顶回去。/);
  assert.equal(text.includes("它"), false); // 行为句里没有第三人称主语
  assert.equal(colorsInOrder(palette).map((row) => row.name).join(","), "护短,嘴硬,跳脱");
});

test("渲染：一个色一条活行为都没有就不出场；整盘空了返回空串", () => {
  let palette = emptyPalette();
  palette = addColor(palette, { name: "护短", role: "base" });
  assert.equal(paletteToText(palette), "");
  assert.equal(paletteToText(emptyPalette()), "");
  assert.equal(paletteToText(null), "");
});

test("读进来的脏数据要能收干净：悬空的行为、越界的色、超长的句子", () => {
  const palette = normalizePalette({
    colors: [
      { id: "c1", name: "护短", role: "base" },
      { id: "c2", name: "嘴硬", role: "base" },
      { id: "c3", name: "跳脱", role: "不知道什么位置" },
    ],
    derivatives: [
      { id: "d1", colorId: "c1", text: "好好的一句" },
      { id: "d2", colorId: "c9", text: "挂在不存在的色上" },
      { id: "d3", colorId: "c1", text: "" },
      { id: "d4", colorId: "c1", text: "长".repeat(400) },
    ],
  });
  assert.equal(palette.colors.length, 1);
  assert.equal(palette.derivatives.length, 2);
  assert.equal(palette.derivatives[1].text.length <= 120, true);
});

test("调色盘进提示词：有盘就用盘，不带旧的表层里层", () => {
  const { palette } = sample();
  const text = paletteToText(palette);
  assert.match(text, /在「茶话会」里，你就是这样一个人/);
  assert.match(text, /护短/);
  assert.equal(text.includes("说话的底色偏"), false);
});

test("语料：一句一条进提示词，空行不收、超长的截断", () => {
  const palette = normalizePalette({
    colors: [{ id: "c1", name: "较真", role: "base" }],
    derivatives: [{ id: "d1", colorId: "c1", text: "不确定就先问清楚", on: true }],
    corpus: [
      { scene: "她随口说圆宝把拖鞋叼走了", lines: ["狗藏鞋这事真挺有说法的", "对它来说那是带着你味道的宝贝", "   "] },
      { scene: "空的", lines: [] },
      { scene: "太长", lines: ["长".repeat(200)] },
      { scene: "", lines: ["就一句话也行"] },
    ],
  });
  assert.equal(palette.corpus.length, 3);
  assert.equal(palette.corpus[0].lines.length, 2);
  assert.equal(palette.corpus[1].lines[0].length, 60);
  const text = paletteToText(palette);
  assert.match(text, /你发消息大概长这样/);
  assert.match(text, /「狗藏鞋这事真挺有说法的」/);
});

test("只有语料也渲染得出来，也不是所谓能用的盘", () => {
  const text = paletteToText({ corpus: [{ scene: "随口说点什么", lines: ["嗯", "知道了"] }] });
  assert.match(text, /你发消息大概长这样/);
  assert.equal(hasPalette({ corpus: [{ lines: ["嗯"] }] }), false);
});
