import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { BUBBLE_SKINS, BUBBLE_SKIN_GROUPS, PARTNER_SKIN_IDS, bubbleSkinById, skinsForMood } from "../lib/bubble-skins.js";

const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const mobile = fs.readFileSync(new URL("../ui/mobile.html", import.meta.url), "utf8");
const mobileClient = fs.readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
const galleryUrl = new URL("../ui/assets/bubble-gallery.css", import.meta.url);
const galleryCss = fs.readFileSync(galleryUrl, "utf8");

/** 新画廊那八款：id 与另一实例约定的一致，变量表另走一份样式文件。 */
export const ART_SKIN_IDS = [
  "art-rabbit", "art-capybara", "art-jellyfish", "art-chick",
  "art-cloud", "art-letter", "art-pixel", "art-aquarium",
];

test("水母月牙的金色轮廓完全留在固定右下角，两侧镜像都不会把它切进延展条", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("./illustrated-bubbles/art-manifest.json", galleryUrl), "utf8"));
  const { size: [width, height], slices: [top, right, bottom, left] } = manifest.find(row => row.id === "art-jellyfish");
  // 源图的月牙在右下（自己一侧翻到左下），亮色轮廓约 x=606–737、y=300–400。
  assert.ok(height - bottom < 300 && width - right < 606);
  assert.ok(top + bottom < height && left + right < width);
  assert.equal(galleryCss.match(new RegExp(`--art-slices: ${top} ${right} ${bottom} ${left};`, "gu"))?.length, 2);
});

test("新画廊八款都在清单里，分组落在已有的三个组上", () => {
  const ids = new Set(BUBBLE_SKIN_GROUPS.map((group) => group.id));
  for (const id of ART_SKIN_IDS) {
    const skin = bubbleSkinById(id);
    assert.ok(skin, `${id} 没登记进清单`);
    assert.ok(ids.has(skin.group), `${id} 的分组 ${skin.group} 不在已有分组里`);
    assert.ok(skin.label && skin.hint, `${id} 缺名字或说明`);
  }
  // 三个组都还留着旧款，不许把某一组掏空
  for (const group of BUBBLE_SKIN_GROUPS) {
    assert.ok(BUBBLE_SKINS.some((skin) => skin.group === group.id), `${group.id} 组空了`);
  }
});

test("新画廊八款写的心情都在心情日盘那十三格里，也都进得了伙伴自选池", async () => {
  const { MOOD_GRID } = await import("../lib/mood-daily.js");
  const known = new Set(MOOD_GRID.map((mood) => mood.id));
  for (const id of ART_SKIN_IDS) {
    const skin = bubbleSkinById(id);
    assert.ok(Array.isArray(skin.moods) && skin.moods.length, `${id} 得写清楚什么心情下成立`);
    for (const mood of skin.moods) assert.ok(known.has(mood), `${id} 写了不存在的心情 ${mood}`);
    assert.ok(PARTNER_SKIN_IDS.includes(id), `${id} 该能进伙伴自选池`);
  }
  // 委屈、生气这两格现在有人认领了
  assert.ok(skinsForMood("hurt").length > 0);
  assert.ok(skinsForMood("angry").length > 0);
});

test("新画廊的样式表在聊天页、设置页、手机页三处都挂上", () => {
  assert.match(panel, /"assets\/bubble-gallery\.css"/);
  assert.match(settings, /"assets\/bubble-gallery\.css"/);
  assert.match(mobile, /href="\/assets\/bubble-gallery\.css"/);
  // 旧那一份样式表照旧挂着，别被新文件顶掉
  assert.match(panel, /"assets\/bubble-skins\.css"/);
  assert.match(settings, /"assets\/bubble-skins\.css"/);
  assert.match(mobile, /href="\/assets\/bubble-skins\.css"/);
});

test("短句收窄的判定同时认旧插画皮肤和新画廊", () => {
  for (const source of [panel, mobileClient]) {
    assert.match(source, /\[data-me-skin\^="art-"\], \[data-ta-skin\^="art-"\]/, "新画廊的壳也得能收窄");
    assert.match(source, /--ill-unit/, "旧插画皮肤那套判定要留着");
  }
});

test("新画廊的样式表：两侧变量、样张与减动效护栏都要齐", () => {
  for (const id of ART_SKIN_IDS) {
    const meBlock = galleryCss.match(new RegExp(`\\[data-me-skin="${id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    const taBlock = galleryCss.match(new RegExp(`\\[data-ta-skin="${id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    assert.ok(meBlock, `${id} 少了我这一侧的变量块`);
    assert.ok(taBlock, `${id} 少了伙伴那一侧的变量块`);
    for (const key of ["--skin-me-bg", "--skin-me-border-color", "--skin-me-fg"]) {
      assert.match(meBlock, new RegExp(`${key}:`), `${id} 我侧少 ${key}`);
    }
    for (const key of ["--skin-ta-bg", "--skin-ta-border-color", "--skin-ta-fg"]) {
      assert.match(taBlock, new RegExp(`${key}:`), `${id} ta 侧少 ${key}`);
    }
    // 设置页样张跟实况同一份：样张也得能认出这一套
    assert.match(galleryCss, new RegExp(`skin-sample-bubble\\[data-me-skin="${id}"\\]`), `${id} 少了我侧样张规则`);
    assert.match(galleryCss, new RegExp(`skin-sample-bubble\\[data-ta-skin="${id}"\\]`), `${id} 少了 ta 侧样张规则`);
  }
  // 减动效的人不该被动画追着跑
  assert.match(galleryCss, /@media \(prefers-reduced-motion: reduce\)/);
  // 短句收窄：JS 挂的是 ill-tight 这个 class，新样式表得认它
  assert.match(galleryCss, /\.bubble\.ill-tight/);
});

test("八款原画、底壳、静态角和动态角齐全，短句尺度也确实有局部变化", () => {
  const folder = new URL("../ui/assets/illustrated-bubbles/", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("art-manifest.json", folder), "utf8"));
  assert.equal(manifest.length, ART_SKIN_IDS.length);
  for (const item of manifest) {
    assert.ok(ART_SKIN_IDS.includes(item.id));
    assert.ok(item.frames >= 20, `${item.id}: 动画帧太少`);
    assert.ok(item.changedByUnit["0.11"] >= 8, `${item.id}: 短句里看不见动态`);
    assert.ok(item.changedByUnit["0.15"] >= 8, `${item.id}: 正常尺寸里看不见动态`);
    for (const suffix of [".png", "-base.png", "-still.png", "-motion.webp"]) {
      const bytes = fs.readFileSync(new URL(item.id + suffix, folder));
      assert.ok(bytes.length > 100);
      if (suffix.endsWith(".png")) {
        assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      } else {
        assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
        assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
        assert.ok(bytes.includes(Buffer.from("ANIM")));
      }
    }
  }
});

test("局部插画排除撤回、语音转写与贴图影音，不让壳压到照片", () => {
  assert.ok(galleryCss.includes(":not(.voice-transcript, .is-recalled, :has(.sticker, video, audio))"));
  assert.ok(galleryCss.includes(":has(.message-image, .ch-img)"));
  assert.ok(galleryCss.includes("padding-right: max(16px, calc(var(--art-photo-right)"));
  assert.ok(galleryCss.includes("padding-left: max(16px, calc(var(--art-photo-left)"));
  assert.ok(galleryCss.includes("--skin-ta-bg: var(--bubble-ta-bg"), "语音转写保留不透明底色");
  assert.ok(galleryCss.includes("min-inline-size: min(84px, 100%)"), "设置样张不撑破窄卡");
  assert.ok(mobile.includes('#chat[data-me-skin^="art-"] .row.me .bubble.ch-media'));
  assert.ok(mobile.includes('#chat[data-ta-skin^="art-"] .row.ta .bubble.ch-media'));
});
