/**
 * 插画气泡（2026-11-12 新增四款）的验收。
 *
 * 这四款的气泡壳是一张画：原壳做底，角色那一角单独用原生动画图补回去。
 * 这里盯三件事：
 *   一、清单与账：四款在白名单里、能存能读、伙伴能按心情挑中；
 *   二、素材：十二件文件都在，签名、尺寸、动画帧都是真的；
 *   三、样式：me / ta 两套变量都在，新角只给新款，带图的气泡不吃这一套，
 *      减动态和历史行走静态角。
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
  // 气泡本身、最小宽度与六条图层规则都要排除媒体。
  const guarded = illustratedSection.match(/:not\(\.voice-bubble, \.voice-transcript, \.is-recalled, \.ch-media, :has\(\.message-image, \.ch-media, \.ch-img, \.sticker, video, audio\)\)/g) ?? [];
  assert.equal(guarded.length, 8, "插画气泡的规则少了带图护栏");
  assert.match(illustratedSection, /\.voice-bubble/);
  assert.match(illustratedSection, /\.voice-transcript/);
  assert.match(illustratedSection, /\.is-recalled/);
  assert.match(illustratedSection, /padding: calc\(var\(--ill-top\) \* var\(--ill-unit\) \* 1px \+ 6px\) 20px 20px;/);
});

test("减动态、老消息：角换静态；样张不吃历史那条", () => {
  // 默认走动态
  assert.match(illustratedSection, /--ill-frame-image: var\(--ill-motion\);/);
  assert.match(illustratedSection, /background-image: var\(--ill-frame-image\);/);
  // 开了减少动态：换静态角
  const reduced = illustratedSection.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(reduced, "少了减少动态那一段");
  assert.match(reduced, /--ill-frame-image: var\(--ill-still\);/);
  assert.match(reduced, /系统已减少动态，当前静态显示/);
  assert.match(reduced, /\.skin-sample-bubble:is\(\[data-me-skin\^="ill-"\], \[data-ta-skin\^="ill-"\]\)::after/);
  // 老消息：只让末尾三条动
  assert.match(illustratedSection, /:is\(\.stream, \.ch-stream\) \.row:nth-last-child\(n\+4\) \.bubble::after \{ --ill-frame-image: var\(--ill-still\); \}/);
  // 桌面和手机历史行都静态，设置页样张不在这两个流里。
  const history = illustratedSection.match(/:is\(\.stream, \.ch-stream\) \.row:nth-last-child\(n\+4\)[\s\S]*?\}/)?.[0] ?? "";
  assert.doesNotMatch(history, /skin-sample-bubble/);
});
