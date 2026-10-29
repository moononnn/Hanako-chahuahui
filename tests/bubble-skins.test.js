import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.js";
import {
  BUBBLE_SKINS,
  BUBBLE_SKIN_GROUPS,
  PARTNER_SKIN_IDS,
  bubbleSkinById,
  normalizeBubbleSkin,
  skinsForMood,
} from "../lib/bubble-skins.js";

const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const skinsCss = fs.readFileSync(new URL("../ui/assets/bubble-skins.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-skin-"));
  return { store: createStore(dir), dir };
}

test("气泡装扮只认白名单里那几套，认不出的一律回原味", () => {
  assert.deepEqual(BUBBLE_SKINS.map((skin) => skin.id), [
    "plain", "celadon", "outline",
    "jelly", "sakura", "bear", "marshmallow",
    "rainbow", "polka", "holo", "star", "neon", "rain", "pixel",
  ]);
  assert.equal(normalizeBubbleSkin("sakura"), "sakura");
  // 老数据里手改过的、已经下架的（删掉的磨砂、抑或这轮删的十二套），都回原味，不凭空造一个样式
  assert.equal(normalizeBubbleSkin("glass"), "plain");
  assert.equal(normalizeBubbleSkin("cream"), "plain");
  assert.equal(normalizeBubbleSkin("ribbon"), "plain");
  assert.equal(normalizeBubbleSkin("unknown-skin"), "plain");
  assert.equal(normalizeBubbleSkin(""), "plain");
  assert.equal(normalizeBubbleSkin(undefined), "plain");
  assert.equal(normalizeBubbleSkin(null), "plain");
});

test("分组只给设置页分段用，每套都得落在已有的那个组里", () => {
  const ids = new Set(BUBBLE_SKIN_GROUPS.map((group) => group.id));
  for (const skin of BUBBLE_SKINS) {
    assert.ok(ids.has(skin.group), `${skin.id} 的分组 ${skin.group} 不在清单里`);
    assert.ok(skin.label && skin.hint, `${skin.id} 缺名字或说明`);
  }
  // 三个组都得有人，空组在设置页上就是一行多余的小标题
  for (const group of BUBBLE_SKIN_GROUPS) {
    assert.ok(BUBBLE_SKINS.some((skin) => skin.group === group.id), `${group.id} 组是空的`);
  }
});

test("装扮存进全局设置，读出来还是认得的那套", () => {
  const { store } = freshStore();
  assert.equal(store.getGlobalSettings().bubbleSkin, "plain");
  store.setGlobalSettings({ bubbleSkin: "star" });
  assert.equal(store.getGlobalSettings().bubbleSkin, "star");
  // 手改的坏值：读的时候归一回原味，不让它带着走进界面
  store.setGlobalSettings({ bubbleSkin: "nope" });
  assert.equal(store.getGlobalSettings().bubbleSkin, "plain");
});

test("设置页写装扮时先把关卡过一遍，不认得的当场说清楚", () => {
  assert.match(app, /"bubbleSkin",/);
  assert.match(app, /if \(!BUBBLE_SKINS\.some\(\(row\) => row\.id === skin\)\) throw new Error\("气泡装扮没有这一套"\);/);
  assert.match(app, /patch\.bubbleSkin = normalizeBubbleSkin\(skin\);/);
});

test("清单由后端发给设置页，前端不自己拄一份", () => {
  assert.match(app, /bubbleSkins: BUBBLE_SKINS,/);
  assert.match(app, /bubbleSkinGroups: BUBBLE_SKIN_GROUPS,/);
  assert.match(settings, /bubbleSkinCatalog = data\.bubbleSkins \?\? \[\];/);
  assert.match(settings, /bubbleSkinGroups = data\.bubbleSkinGroups \?\? \[\];/);
  assert.match(settings, /saveGlobal\(\{ bubbleSkin: skin\.id \}/);
  // 十几套平铺太长，按分组起小标题
  assert.match(settings, /title\.className = "skin-group-title";/);
});

test("设置页只让自己挑：预览只画「我」那一枚，不画 ta 的", () => {
  // 画两枚会让人以为 ta 那侧也能在这里设，那正是这一版要改掉的旧行为
  assert.doesNotMatch(settings, /skin-sample-bubble ta/);
  assert.match(settings, /me\.dataset\.meSkin = skin\.id;/);
  // 伙伴那侧只写一句「ta 现在戴着 xx」，不给按钮、不给点选
  assert.match(settings, /function paintPartnerSkinNote\(\)/);
  assert.match(settings, /ta 那边按当天心情自己换，你挑不到/);
});

test("下架的皮肤不再在样式表里留一组没人用的变量", () => {
  // 变量留着但清单里没了：设置页画不出来，样式表白变一大截。
  for (const gone of ["paper", "rice", "linen", "ribbon", "candy", "cream", "paw", "cloud", "chrome", "planet", "aurora", "flame"]) {
    assert.doesNotMatch(skinsCss, new RegExp(`\\[data-(?:me|ta)-skin="${gone}"\\]`), `样式表里还留着 ${gone}`);
  }
});

test("两侧各挂各的：内容页给两枚属性，缺哪枚哪侧就回原样", () => {
  // 属性名换了：以前一枚 data-bubble-skin 管两个人，现在分 me / ta
  assert.doesNotMatch(skinsCss, /\[data-bubble-skin="/, "旧的单枚属性不该再出现在样式表里");
  assert.match(panel, /el\.chat\.dataset\.meSkin = me;/);
  assert.match(panel, /el\.chat\.dataset\.taSkin = ta;/);
  assert.match(panel, /delete el\.chat\.dataset\.meSkin;/);
  assert.match(panel, /delete el\.chat\.dataset\.taSkin;/);
  // 原味等于没打扮：摘属性，不靠一份空皮肤块假装
  assert.match(panel, /if \(me && me !== "plain"\) el\.chat\.dataset\.meSkin = me;/);
  assert.match(panel, /if \(ta && ta !== "plain"\) el\.chat\.dataset\.taSkin = ta;/);
});

test("伙伴那侧由后端给，跟人走，不跟好友轮询走", () => {
  // 好友轮询只知道自己那侧，拿它去覆盖会把 ta 的壳冲掉
  assert.match(panel, /applyBubbleSkin\(data\.bubbleSkin, lastPartnerSkin\);/);
  assert.match(panel, /let lastPartnerSkin = null;/);
  // 拉线程那一页带着 partnerSkin，合并时跟着换
  assert.match(panel, /if \(data && Object\.prototype\.hasOwnProperty\.call\(data, "partnerSkin"\)\)/);
  assert.match(app, /partnerSkin: partnerSkinFor\(agentId\),/);
});

test("换人时先摘掉上一位的壳，新人的头几条不顶着别人的颜色", () => {
  assert.match(panel, /换人时先把上一位那侧的壳摘掉/);
  assert.match(panel, /lastPartnerSkin = null;\n\s*applyPartnerSkin\(null\);/);
});

test("聊天页不再拄第二份皮肤白名单，名单只留在后端那一份", () => {
  // 两份名单一定会跑偏：加了一套皮肤忘了往前端补，那套就静默变成原味。
  assert.doesNotMatch(panel, /const BUBBLE_SKIN_IDS = \[/);
  for (const skin of BUBBLE_SKINS.filter((row) => row.id !== "plain")) {
    assert.doesNotMatch(panel, new RegExp(`"${skin.id}"`), `panel.html 不该出现皮肤 id ${skin.id}`);
  }
});

test("每套皮肤两侧都自带完整配色，各在自己的属性块里", () => {
  for (const skin of BUBBLE_SKINS.filter((row) => row.id !== "plain")) {
    const meBlock = skinsCss.match(new RegExp(`\\[data-me-skin="${skin.id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    const taBlock = skinsCss.match(new RegExp(`\\[data-ta-skin="${skin.id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    assert.ok(meBlock, `${skin.id} 得有一组「我」这侧的变量`);
    assert.ok(taBlock, `${skin.id} 得有一组伙伴那侧的变量`);
    for (const key of ["--skin-me-bg", "--skin-me-border-color", "--skin-me-fg"]) {
      assert.match(meBlock, new RegExp(`${key}:`), `${skin.id} 的我侧少 ${key}`);
      assert.doesNotMatch(meBlock, /--skin-ta-/, `${skin.id} 的我侧块里不该有 ta 的变量`);
    }
    for (const key of ["--skin-ta-bg", "--skin-ta-border-color", "--skin-ta-fg"]) {
      assert.match(taBlock, new RegExp(`${key}:`), `${skin.id} 的 ta 侧少 ${key}`);
      assert.doesNotMatch(taBlock, /--skin-me-/, `${skin.id} 的 ta 侧块里不该有我的变量`);
    }
  }
});

test("皮肤没给的那一项回落到原来的取色逻辑，原味等于什么都没改", () => {
  assert.match(skinsCss, /background: var\(--skin-me-bg, var\(--bubble-me-bg, #dff0e8\)\);/);
  assert.match(skinsCss, /background: var\(--skin-ta-bg, var\(--bubble-ta-bg, #fff\)\);/);
  assert.match(skinsCss, /border-color: var\(--skin-me-border-color, var\(--bubble-me-border, #c5e4d6\)\);/);
  // 原味那一套不定义任何变量：挂着它等于没挂
  assert.doesNotMatch(skinsCss, /\[data-me-skin="plain"\] \{/);
  assert.doesNotMatch(skinsCss, /\[data-ta-skin="plain"\] \{/);
});

test("小熊的耳朵长在气泡上沿，短气泡也不飞出去", () => {
  // 耳朵是这套唯一的重活：一个换了形状的房子，不能只靠颜色认。
  const block = skinsCss.match(/\[data-me-skin="bear"\] \.row\.me \.bubble::before,[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(block, "bear 得有一段画耳朵的伪元素规则（我这一侧）");
  const taBlock = skinsCss.match(/\[data-ta-skin="bear"\] \.row\.ta \.bubble::before,[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(taBlock, "bear 得有一段画耳朵的伪元素规则（伙伴那侧）");
  // 半椭圆：底边落在气泡顶边，底部那 1px 描边与气泡的边框线重合，所以看着是一体的
  assert.match(block, /aspect-ratio: 10 \/ 5\.5;/);
  assert.match(block, /border-radius: 50% 50% 0 0 \/ 100% 100% 0 0;/);
  assert.match(block, /inset 0 0 0 1px rgba\(198, 152, 96, \.5\)/);
  assert.match(block, /transform: translateY\(-100%\);/);
  // 尺寸跟气泡宽度走，并且让过 16px 的圆角：「嗯」那种短气泡里自己缩一圈，不会溢出去
  assert.match(block, /--ear-w: min\(36px, max\(0px, calc\(\(100% - 32px\) \/ 2\)\)\);/);
  assert.match(block, /width: var\(--ear-w\);/);
  assert.match(block, /right: calc\(16px \+ var\(--ear-w\)\);/);
});

test("小熊的耳朵会动，而且根部钉死、只动形状", () => {
  // 耳朵的位置是 transform: translateY(-100%) 定住的。动画里要是写了 transform，
  // 位置会被扯掉，所以只能碰不改元素框底边的属性：aspect-ratio / translate / border-radius。
  const shove = skinsCss.match(/@keyframes bear-ear-shove \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const idle = skinsCss.match(/@keyframes bear-ear-idle \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(shove && idle, "两个耳朵动画都得在");
  for (const [name, body] of [["shove", shove], ["idle", idle]]) {
    assert.doesNotMatch(body, /transform:/, `${name} 不能写 transform，会把耳朵从位置上扯下来`);
    assert.doesNotMatch(body, /[^-](scale|rotate):/, `${name} 不能靠 scale/rotate 变形：绕原点转会把底边两端一抬一压，根部就露到气泡框外了`);
    assert.match(body, /aspect-ratio: 10 \//, `${name} 得用 aspect-ratio 做高度变化`);
    assert.match(body, /translate: calc\(var\(--ear-dir, 1\)/, `${name} 的水平惯性得分左右方向`);
    assert.match(body, /border-radius: calc\(50% [-+] var\(--ear-dir, 1\)/, `${name} 的歪也得跟方向走`);
  }
  // 动画的触发条件得两侧都能命中：属性现在挂在 row 上，写成 .chat[data-me-skin] 就只认我这边了
  assert.match(skinsCss, /:is\(\.chat\[data-me-skin="bear"\], \.chat\[data-ta-skin="bear"\]\)/);
  // 左右两只耳朵分居两侧，方向变量反了会往外倒变成往里夹
  assert.match(skinsCss, /\.row\.me \.bubble::after \{ --ear-dir: 1; \}/);
  assert.match(skinsCss, /\.row\.ta \.bubble::after \{ --ear-dir: -1; \}/);
  // 被顶的那一下只给最后几条挂，上面几十条跟着动就成扇子了
  assert.match(skinsCss, /\.stream\.is-shoving \.row:nth-last-child\(-n\+4\) \.bubble::before/);
  // 减动效的人不该被动画追着跑
  assert.match(skinsCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?bear[\s\S]*?animation: none;/);
});

test("样式表挂在聊天页和设置页两边，预览跟实况同一份", () => {
  assert.match(panel, /"assets\/panel\.css", "assets\/bubble-skins\.css"/);
  assert.match(settings, /"assets\/bubble-skins\.css"/);
});

// ── 伙伴自己那侧（2026-10-28 晚）──────────────────────────

test("伙伴只能挑写了心情的那几套，原味不在池子里", () => {
  // 原味不是一种打扮，是「没打扮」；让它进池子等于「ta 今天决定不换」
  assert.ok(!PARTNER_SKIN_IDS.includes("plain"));
  assert.ok(PARTNER_SKIN_IDS.length > 0);
  for (const id of PARTNER_SKIN_IDS) {
    const skin = bubbleSkinById(id);
    assert.ok(skin, `${id} 得在清单里`);
    assert.ok(Array.isArray(skin.moods) && skin.moods.length, `${id} 得写清楚什么心情下成立`);
  }
});

test("心情查得到对应的皮肤，查不到就回空——不硬塞", () => {
  assert.ok(skinsForMood("happy").includes("jelly"));
  assert.ok(skinsForMood("calm").includes("celadon"));
  // 「委屈」「生气」还没人认领：返回空数组，调用方保住上一套
  assert.deepEqual(skinsForMood("hurt"), []);
  assert.deepEqual(skinsForMood("angry"), []);
  assert.deepEqual(skinsForMood(""), []);
  assert.deepEqual(skinsForMood(undefined), []);
});

test("moods 里写的都得是心情日盘里真有的格子", async () => {
  const { MOOD_GRID } = await import("../lib/mood-daily.js");
  const known = new Set(MOOD_GRID.map((m) => m.id));
  for (const skin of BUBBLE_SKINS) {
    for (const mood of skin.moods ?? []) {
      assert.ok(known.has(mood), `${skin.id} 写了不存在的心情 ${mood}`);
    }
  }
});

test("伙伴的皮肤账单独存一本，不混进心情账", () => {
  const { store } = freshStore();
  assert.equal(store.getPartnerSkinBook("agent-a").skin, null);
  store.savePartnerSkinBook("agent-a", { skin: "star", moodId: "calm", dayKey: "2026-10-28", pickedAt: "2026-10-28T12:00:00.000Z" });
  assert.equal(store.getPartnerSkinBook("agent-a").skin, "star");
  // 坏值读的时候归一，不带着走进界面
  store.savePartnerSkinBook("agent-a", { skin: "nope", moodId: "calm", dayKey: "2026-10-28" });
  assert.equal(store.getPartnerSkinBook("agent-a").skin, null);
  // 别的伙伴不受影响
  assert.equal(store.getPartnerSkinBook("agent-b").skin, null);
});
