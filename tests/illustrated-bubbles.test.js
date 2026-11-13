/**
 * 插画气泡（2026-11-12 新增四款）的验收。
 *
 * 这四款的气泡壳是一张画：原壳做底，角色那一角单独用原生动画图补回去。
 * 这里盯三件事：
 *   一、清单与账：四款在白名单里、能存能读、伙伴能按心情挑中；
 *   二、素材：十二件文件都在，签名、尺寸、动画帧都是真的；
 *   三、样式：me / ta 两套变量都在，新角只给新款，带图的气泡不吃这一套，
 *      减动态用静态角，历史行不再被排名规则强制静态。
 *
 * 素材是原图像素：九切片 [上 右 下 左]、角宽角高（右上角取右切片，左上角取左切片）。
 * 角图是半分辨率编码：像素尺寸 = （角宽 + 48）/ 2 × （角高 + 48）/ 2。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.js";
import {
  BUBBLE_SKINS,
  PARTNER_SKIN_IDS,
  bubbleSkinById,
  normalizeBubbleSkin,
  skinsForMood,
} from "../lib/bubble-skins.js";

const skinsCss = fs.readFileSync(new URL("../ui/assets/bubble-skins.css", import.meta.url), "utf8");
const assetsDir = new URL("../ui/assets/illustrated-bubbles/", import.meta.url);

/** 四款的原始数据：壳的原生尺寸、九切片、角色角在哪一边。 */
const ILL = [
  { id: "ill-croc", label: "团团小鳄", stem: "croc", shell: [755, 451], slice: [248, 340, 158, 189], corner: "tr" },
  { id: "ill-fox", label: "杏桃小狐", stem: "fox", shell: [768, 476], slice: [262, 346, 167, 154], corner: "tr" },
  { id: "ill-berry", label: "草莓奶霜", stem: "berry", shell: [768, 435], slice: [191, 261, 152, 161], corner: "tr" },
  { id: "ill-whale", label: "奶蓝云鲸", stem: "whale", shell: [760, 453], slice: [217, 205, 154, 334], corner: "tl" },
];

const OLD_IDS = ["plain", "celadon", "outline", "jelly", "sakura", "bear", "marshmallow",
  "rainbow", "polka", "holo", "star", "neon", "rain", "pixel"];

/** 角色角那一块的宽高：角在右上取右切片，在左上取左切片；高都是上切片。 */
function cornerBox(skin) {
  const [top, right, bottom, left] = skin.slice;
  return skin.corner === "tr" ? [right, top] : [left, top];
}

/** 样式表里「插画气泡」那一节。 */
const illustratedSection = skinsCss.slice(skinsCss.indexOf("插画气泡：四款带角色角的气泡"));

function pngSize(buf, name) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${name} 不是 PNG（签名不对）`);
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR", `${name} 缺 IHDR`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** WebP：RIFF/WEBP 头、动画块 ANIM、逐帧块 ANMF，还有画布尺寸。 */
function webpInfo(buf, name) {
  assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF", `${name} 不是 RIFF`);
  assert.equal(buf.subarray(8, 12).toString("ascii"), "WEBP", `${name} 不是 WebP`);
  let hasAnim = false;
  let frames = 0;
  let size = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (fourcc === "ANIM") hasAnim = true;
    if (fourcc === "ANMF") frames += 1;
    if (fourcc === "VP8X") {
      size = [buf.readUIntLE(offset + 12, 3) + 1, buf.readUIntLE(offset + 15, 3) + 1];
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { hasAnim, frames, size };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-ill-"));
  return { store: createStore(dir), dir };
}

// ── 清单与账 ──────────────────────────────────────────────

test("四款插画气泡在白名单里：分组、名字、说明都在", () => {
  assert.ok(illustratedSection.length, "样式表里找不到插画气泡那一节");
  for (const row of ILL) {
    const skin = bubbleSkinById(row.id);
    assert.ok(skin, `${row.id} 不在清单里`);
    assert.equal(skin.group, "cute", `${row.id} 该归在可爱那一组`);
    assert.equal(skin.label, row.label);
    // 说明得说清动作是什么、而且动一阵歇一阵
    assert.match(skin.hint, /动/, `${row.id} 的说明没写动作`);
    assert.match(skin.hint, /歇|停/, `${row.id} 的说明没写动作是间歇的`);
    assert.ok(Array.isArray(skin.moods) && skin.moods.length, `${row.id} 没写心情，伙伴挑不到它`);
  }
  // 清单里仍然是「原来那十四套 + 新四套」，顺序别乱
  assert.equal(BUBBLE_SKINS.length, OLD_IDS.length + ILL.length);
});

test("四款能存进设置、读出来还是它；不认得的照旧回原味", () => {
  const { store } = freshStore();
  for (const row of ILL) {
    store.setGlobalSettings({ bubbleSkin: row.id });
    assert.equal(store.getGlobalSettings().bubbleSkin, row.id, `${row.id} 存进去读出来变了`);
    assert.equal(normalizeBubbleSkin(row.id), row.id);
  }
  store.setGlobalSettings({ bubbleSkin: "ill-nope" });
  assert.equal(store.getGlobalSettings().bubbleSkin, "plain");
});

test("伙伴能挑到这四款：写了心情的都在池子里", () => {
  for (const row of ILL) {
    assert.ok(PARTNER_SKIN_IDS.includes(row.id), `${row.id} 不在伙伴的池子里`);
  }
  assert.ok(skinsForMood("calm").includes("ill-croc"));
  assert.ok(skinsForMood("calm").includes("ill-fox"));
  assert.ok(skinsForMood("calm").includes("ill-whale"));
  assert.ok(skinsForMood("bliss").includes("ill-berry"));
  assert.ok(skinsForMood("happy").includes("ill-croc"));
  assert.ok(skinsForMood("happy").includes("ill-berry"));
});

// ── 素材 ──────────────────────────────────────────────────

test("十二件素材都在：PNG 签名对、尺寸对", () => {
  for (const row of ILL) {
    const shell = fs.readFileSync(new URL(`${row.stem}.png`, assetsDir));
    assert.deepEqual(pngSize(shell, `${row.stem}.png`), row.shell, `${row.stem}.png 的尺寸不对`);

    const [cw, ch] = cornerBox(row);
    const still = fs.readFileSync(new URL(`${row.stem}-still.png`, assetsDir));
    assert.deepEqual(
      pngSize(still, `${row.stem}-still.png`),
      [Math.round((cw + 48) / 2), Math.round((ch + 48) / 2)],
      `${row.stem}-still.png 的尺寸跟角图对不上`,
    );
  }
});

test("动图是真的动画：WebP 头、ANIM 块、ANMF 逐帧都在", () => {
  for (const row of ILL) {
    const buf = fs.readFileSync(new URL(`${row.stem}-motion.webp`, assetsDir));
    const info = webpInfo(buf, `${row.stem}-motion.webp`);
    assert.ok(info.hasAnim, `${row.stem}-motion.webp 没有 ANIM 动画块`);
    assert.ok(info.frames >= 2, `${row.stem}-motion.webp 只有 ${info.frames} 帧，不是动画`);
    const [cw, ch] = cornerBox(row);
    assert.deepEqual(
      info.size,
      [Math.round((cw + 48) / 2), Math.round((ch + 48) / 2)],
      `${row.stem}-motion.webp 的画布尺寸跟静态角不一致`,
    );
  }
});

test("闭眼鲸鱼不再挤眼线，构建时逐帧保护真实眼部像素", () => {
  const builder = fs.readFileSync(new URL('../scripts/build-illustrated-bubbles.py', import.meta.url), 'utf8');
  const field = builder.slice(builder.indexOf('def whale_displacement'), builder.indexOf('def build_whale_bubbles'));
  assert.doesNotMatch(field, /blink|eye\s*=|gently squeezes/);
  assert.match(builder, /Closed eye must remain static in every encoded frame/);
  assert.doesNotMatch(bubbleSkinById('ill-whale').hint, /眯眼|眨眼/);
});

test("鲸鱼细节层有独立静态和动态资源，尺寸与 CSS 原生画布一致", () => {
  const still = fs.readFileSync(new URL('whale-bubbles-still.png', assetsDir));
  assert.deepEqual(pngSize(still, 'whale-bubbles-still.png'), [64, 104]);
  const motion = webpInfo(fs.readFileSync(new URL('whale-bubbles-motion.webp', assetsDir)), 'whale-bubbles-motion.webp');
  assert.deepEqual(motion.size, [64, 104]);
  assert.ok(motion.hasAnim && motion.frames > 2);
});

// ── 样式 ──────────────────────────────────────────────────

test("每套都有 me / ta 两份变量，指向自己的素材", () => {
  for (const row of ILL) {
    const meBlock = skinsCss.match(new RegExp(`\\[data-me-skin="${row.id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    const taBlock = skinsCss.match(new RegExp(`\\[data-ta-skin="${row.id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    assert.ok(meBlock, `${row.id} 少了我这一侧的变量`);
    assert.ok(taBlock, `${row.id} 少了 ta 那侧的变量`);
    assert.doesNotMatch(meBlock, /--skin-ta-/, `${row.id} 我这侧混进了 ta 的变量`);
    assert.doesNotMatch(taBlock, /--skin-me-/, `${row.id} ta 那侧混进了我的变量`);
    for (const [block, side] of [[meBlock, "me"], [taBlock, "ta"]]) {
      assert.match(block, new RegExp(`--skin-${side}-bg:`), `${row.id} ${side} 侧少了底色`);
      assert.match(block, new RegExp(`--skin-${side}-border-color:`), `${row.id} ${side} 侧少了描边色`);
      assert.match(block, new RegExp(`--skin-${side}-fg:`), `${row.id} ${side} 侧少了字色`);
      assert.match(block, new RegExp(`--skin-${side}-ill-art:\\s*url\\("illustrated-bubbles/${row.stem}\\.png"\\);`));
      assert.match(block, new RegExp(`--skin-${side}-ill-motion:\\s*url\\("illustrated-bubbles/${row.stem}-motion\\.webp"\\);`));
      assert.match(block, new RegExp(`--skin-${side}-ill-still:\\s*url\\("illustrated-bubbles/${row.stem}-still\\.png"\\);`));
      // 九切片四个整数得跟素材对得上
      const [top, right, bottom, left] = row.slice;
      assert.match(block, new RegExp(`--skin-${side}-ill-top:\\s*${top};`));
      assert.match(block, new RegExp(`--skin-${side}-ill-right:\\s*${right};`));
      assert.match(block, new RegExp(`--skin-${side}-ill-bottom:\\s*${bottom};`));
      assert.match(block, new RegExp(`--skin-${side}-ill-left:\\s*${left};`));
      const [cw, ch] = cornerBox(row);
      assert.match(block, new RegExp(`--skin-${side}-ill-corner-w:\\s*${cw};`));
      assert.match(block, new RegExp(`--skin-${side}-ill-corner-h:\\s*${ch};`));
    }
    // 资源路径是相对样式表的，写错了浏览器找不到
    for (const file of [`${row.stem}.png`, `${row.stem}-motion.webp`, `${row.stem}-still.png`]) {
      assert.ok(fs.existsSync(new URL(`illustrated-bubbles/${file}`, new URL("../ui/assets/", import.meta.url))), `${file} 不在样式表旁边`);
    }
  }
});

test("新角那套规则只给新款：原来十四套一点没碰", () => {
  for (const id of OLD_IDS) {
    assert.doesNotMatch(illustratedSection, new RegExp(`data-(?:me|ta)-skin="${id}"`), `${id} 混进了插画气泡那一节`);
  }
  // 底：原壳九切片；角：动图补回去
  assert.match(illustratedSection, /border-image-slice: var\(--ill-top\) var\(--ill-right\) var\(--ill-bottom\) var\(--ill-left\) fill;/);
  assert.match(illustratedSection, /border-image-source: var\(--ill-art\);/);
  assert.match(illustratedSection, /background-image: var\(--ill-frame-image\);/);
  assert.match(illustratedSection, /background-size: 100% 100%;/);
  assert.match(illustratedSection, /background-repeat: no-repeat;/);
  // 角色角那一块先挖掉再补上，不在原角色上叠动图
  assert.match(illustratedSection, /clip-path: polygon\(/);
  // 泡泡自己：透明、无描边、无影、不裁切、造一层叠放上下文
  assert.match(illustratedSection, /background: transparent;/);
  assert.match(illustratedSection, /box-shadow: none;/);
  assert.match(illustratedSection, /overflow: visible;/);
  assert.match(illustratedSection, /isolation: isolate;/);
  assert.match(illustratedSection, /z-index: -2;/);
  assert.match(illustratedSection, /z-index: -1;/);
  assert.equal((illustratedSection.match(/animation: none !important;/g) ?? []).length, 2,
    "另一侧的小熊动效不得带动插画壳图层");
  // 不把整只泡泡转起来，也不镜像
  assert.doesNotMatch(illustratedSection, /rotate\(/);
  assert.doesNotMatch(illustratedSection, /scaleX\(-1\)|scale\(-1/);
  // 文字还是泡泡自己的内容
  assert.doesNotMatch(illustratedSection, /font-size:\s*0/);
  assert.doesNotMatch(illustratedSection, /[\s;]color:\s*transparent/);
});

test("带图、带语音、带表情的气泡不吃这一套", () => {
  // 气泡本身、最小宽度与六条图层规则都要排除媒体，再加云鲸收紧与云鲸小泡那两条。
  const guarded = illustratedSection.match(/:not\(\.voice-bubble, \.voice-transcript, \.is-recalled, \.ch-media, :has\(\.message-image, \.ch-media, \.ch-img, \.sticker, video, audio\)\)/g) ?? [];
  assert.equal(guarded.length, 11, "插画气泡的规则少了带图护栏");
  assert.match(illustratedSection, /\.voice-bubble/);
  assert.match(illustratedSection, /\.voice-transcript/);
  assert.match(illustratedSection, /\.is-recalled/);
  assert.match(illustratedSection, /padding: var\(--ill-text-top, calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px \+ 6px\)\) 20px 20px;/);
  assert.match(illustratedSection, /padding: var\(--ill-text-top, calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px \+ 3px\)\) 12px 14px;/);
});

test("云鲸正文顶部单独收紧：只有它变，别的款和角的几何都不动", () => {
  const rule = illustratedSection.match(/[^{}]*\{[^}]*--ill-text-top:[^}]*\}/)?.[0] ?? "";
  assert.ok(rule, "样式表里没有给云鲸收紧顶部的那条规则");
  // 值：普通 217*.18-12 = 27.06px，样张 217*.12-12 = 14.04px，下限 14px
  assert.match(rule, /--ill-text-top: max\(14px, calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px - 12px\)\);/);
  assert.equal(Math.round((217 * 0.18 - 12) * 100) / 100, 27.06);
  assert.equal(Math.round((217 * 0.12 - 12) * 100) / 100, 14.04);
  assert.ok(Math.max(14, 217 * 0.12 - 12) >= 14, "样张那档也得守住 14px 下限");
  // 只给云鲸：别的三款一个都不许出现在这条规则里
  for (const id of ["ill-croc", "ill-fox", "ill-berry"]) {
    assert.doesNotMatch(rule, new RegExp(id), `${id} 混进了云鲸的收紧规则`);
  }
  // 两侧各一条、样张各一条：变量挂在气泡自己身上
  assert.match(rule, /\[data-me-skin="ill-whale"\]\) \.row\.me \.bubble/);
  assert.match(rule, /\[data-ta-skin="ill-whale"\]\) \.row\.ta \.bubble/);
  assert.match(rule, /\.skin-sample-bubble:is\(\[data-me-skin="ill-whale"\]\)\.me/);
  assert.match(rule, /\.skin-sample-bubble:is\(\[data-ta-skin="ill-whale"\]\)\.ta/);
  // 共享容器上不许挂这个变量：挂在上面会串到另一侧
  assert.doesNotMatch(illustratedSection, /(?:^|\})\s*\[data-me-skin="ill-whale"\]\s*\{[^}]*--ill-text-top/);
  assert.doesNotMatch(illustratedSection, /(?:^|\})\s*\[data-ta-skin="ill-whale"\]\s*\{[^}]*--ill-text-top/);
  // 这个变量只被两处内边距读、只被声明一次：角和尾巴的几何不碰它
  // （数的是真声明，注释里提到它不算）
  const code = illustratedSection.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((code.match(/--ill-text-top/g) ?? []).length, 3,
    "--ill-text-top 只能声明一次、只被两条内边距规则读");
  // 非鲸鱼默认不变：回退算式原样留在两条内边距里
  assert.match(illustratedSection, /var\(--ill-text-top, calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px \+ 6px\)\)/);
  assert.match(illustratedSection, /var\(--ill-text-top, calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px \+ 3px\)\)/);
});

test("云鲸右下角的小泡：专属第二层背景，别的款不碰", () => {
  // 复合背景那条规则（选择器 + 声明）
  const rule = illustratedSection.match(/[^{}]*\{[^{}]*background-image: var\(--ill-frame-image\), var\(--ill-bubbles-image[^{}]*\}/)?.[0] ?? "";
  assert.ok(rule, "样式表里没有云鲸小泡那一条复合背景");
  // 只给云鲸：其余三款一个都不许出现
  for (const id of ["ill-croc", "ill-fox", "ill-berry"]) {
    assert.doesNotMatch(rule, new RegExp(id), `${id} 混进了云鲸小泡的规则`);
  }
  // 两侧各一条、样张各一条
  assert.match(rule, /\[data-me-skin="ill-whale"\]\) \.row\.me \.bubble/);
  assert.match(rule, /\[data-ta-skin="ill-whale"\]\) \.row\.ta \.bubble/);
  assert.match(rule, /\.skin-sample-bubble:is\(\[data-me-skin="ill-whale"\]\)\.me/);
  assert.match(rule, /\.skin-sample-bubble:is\(\[data-ta-skin="ill-whale"\]\)\.ta/);
  // 两层背景：头动图 + 小泡图（带静态版回退）
  assert.match(rule, /background-image: var\(--ill-frame-image\), var\(--ill-bubbles-image, url\("illustrated-bubbles\/whale-bubbles-motion\.webp"\)\);/);
  // 两层尺寸：头角还是角宽角高 + 48，小泡图按原画布 128×208
  assert.match(rule, /background-size:\s*calc\(\(var\(--ill-corner-w\) \+ 48\) \* var\(--ill-unit\) \* 1px\) calc\(\(var\(--ill-corner-h\) \+ 48\) \* var\(--ill-unit\) \* 1px\),\s*calc\(128 \* var\(--ill-unit\) \* 1px\) calc\(208 \* var\(--ill-unit\) \* 1px\);/);
  assert.match(rule, /background-position: left top, right bottom;/);
  assert.match(rule, /background-repeat: no-repeat;/);
  // 盒子：整个泡泡 + 两边各 24 格；位置（left/top -24 格）沿用原规则，这里没重写
  assert.match(rule, /width: calc\(100% \+ 48 \* var\(--ill-unit\) \* 1px\);/);
  assert.match(rule, /height: calc\(100% \+ 48 \* var\(--ill-unit\) \* 1px\);/);
  // 只这一条把盒子撑大：其余三款还是原来那个角的大小
  assert.equal((illustratedSection.match(/calc\(100% \+ 48 \* var\(--ill-unit\) \* 1px\)/g) ?? []).length, 2,
    "撑大的盒子只许出现在云鲸那条规则里（宽高各一次）");
  assert.match(illustratedSection, /width: calc\(\(var\(--ill-corner-w\) \+ 48\) \* var\(--ill-unit\) \* 1px\);/);
  assert.match(illustratedSection, /height: calc\(\(var\(--ill-corner-h\) \+ 48\) \* var\(--ill-unit\) \* 1px\);/);
  // 底图与 clip 没动，泡泡也不转
  assert.doesNotMatch(rule, /border-image|clip-path|rotate\(/);
});

test("系统减少动态时，云鲸的小泡换静态版（透明，不冒泡）", () => {
  const reduced = illustratedSection.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(reduced, "少了减少动态那一段");
  assert.match(reduced, /--ill-bubbles-image: url\("illustrated-bubbles\/whale-bubbles-still\.png"\);/);
  // 只给云鲸
  const whaleRule = reduced.match(/[^{}]*\{[^{}]*--ill-bubbles-image[^{}]*\}/)?.[0] ?? "";
  assert.ok(whaleRule, "减少动态里少了云鲸小泡那条");
  for (const id of ["ill-croc", "ill-fox", "ill-berry"]) {
    assert.doesNotMatch(whaleRule, new RegExp(id), `${id} 混进了云鲸小泡的减少动态规则`);
  }
  assert.match(whaleRule, /\[data-me-skin="ill-whale"\]\) \.row\.me \.bubble/);
  assert.match(whaleRule, /\[data-ta-skin="ill-whale"\]\) \.row\.ta \.bubble/);
  assert.match(whaleRule, /\.skin-sample-bubble:is\(\[data-me-skin="ill-whale"\]\)\.me/);
  assert.match(whaleRule, /\.skin-sample-bubble:is\(\[data-ta-skin="ill-whale"\]\)\.ta/);
  // 护栏保持
  assert.match(whaleRule, /:not\(\.voice-bubble, \.voice-transcript, \.is-recalled, \.ch-media, :has\(\.message-image, \.ch-media, \.ch-img, \.sticker, video, audio\)\)/);
  // 小熊跨侧的动效仍被挡着
  assert.equal((illustratedSection.match(/animation: none !important;/g) ?? []).length, 2,
    "animation: none !important 必须留两处（::before 与 ::after）");
});

test("只在系统减少动态时换静态角，历史消息保留动画", () => {
  // 默认走动态
  assert.match(illustratedSection, /--ill-frame-image: var\(--ill-motion\);/);
  assert.match(illustratedSection, /background-image: var\(--ill-frame-image\);/);
  // 开了减少动态：换静态角
  const reduced = illustratedSection.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(reduced, "少了减少动态那一段");
  assert.match(reduced, /--ill-frame-image: var\(--ill-still\);/);
  assert.match(reduced, /系统已减少动态，当前静态显示/);
  assert.match(reduced, /\.skin-sample-bubble:is\(\[data-me-skin\^="ill-"\], \[data-ta-skin\^="ill-"\]\)::after/);
  // 消息在历史中的排名不能让动态款悄悄变成静态。
  assert.doesNotMatch(illustratedSection, /nth-last-child/);
  const beforeReduced = illustratedSection.slice(0, illustratedSection.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.doesNotMatch(beforeReduced, /--ill-frame-image: var\(--ill-still\)/);
});
