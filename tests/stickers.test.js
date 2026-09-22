import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalGuide } from "./helpers/adaptation.js";

import {
  buildCatalog,
  applyStickerPolicy,
  buildStickerHint,
  encodeStickerBubble,
  hasUsableTags,
  isStickerBubble,
  lastStickerAt,
  looseMatchStickers,
  matchStickers,
  parseStickerMarker,
  pickSticker,
  readCatalogWithReason,
  recentStickerIds,
  referenceWords,
  resolveStickerPolicy,
  sourceRowById,
  stickerAbsolutePath,
  stickerIdFromBubble,
  stickerLabelMap,
  stickerLabelText,
  stripStickerMarkup,
  __clearCatalogCache,
} from "../lib/stickers.js";

const INDEX = {
  schemaVersion: 1,
  stickers: [
    { id: "stk_1", file: "stickers/1.jpg", emotion: ["无语"], scene: ["翻白眼"], keywords: ["猫"], description: "一只猫翻白眼" },
    { id: "stk_2", file: "stickers/2.jpg", emotion: ["无语"], scene: [], keywords: [], description: "无语到扶额" },
    { id: "stk_3", file: "stickers/3.jpg", emotion: ["委屈"], scene: [], keywords: ["撒娇"], description: "委屈巴巴" },
    { id: "stk_4", file: "stickers/4.jpg", emotion: ["开心"], scene: [], keywords: [], description: "笑得很灿烂" },
  ],
  partners: {
    hanako: { configured: true, allowed: ["stk_1", "stk_2", "stk_3", "stk_4"], preferred: ["stk_2"], vetoed: ["stk_3"], recent: ["stk_4"] },
    mio: { configured: true, allowed: ["stk_1", "stk_4"], preferred: [], vetoed: [], recent: [] },
  },
};

test("表情标记：自己占一行才认，摘掉之后前后分开", () => {
  const parsed = parseStickerMarker("好困啊\n[表情:无语]\n我先去眯会儿");
  assert.equal(parsed.keyword, "无语");
  assert.equal(parsed.before, "好困啊");
  assert.equal(parsed.after, "我先去眯会儿");
});

test("表情标记：接在句子里也认；多出来的那几个直接吃掉", () => {
  const inline = parseStickerMarker("这有什么好[表情:无语]说的");
  assert.equal(inline.keyword, "无语");
  assert.equal(inline.before, "这有什么好");
  assert.equal(inline.after, "说的");

  const twice = parseStickerMarker("[表情:无语]\n中间一句\n[表情:开心]");
  assert.equal(twice.keyword, "无语");
  assert.equal(twice.before, "");
  assert.equal(twice.after, "中间一句", "多出来的标记要吃掉，不能当文本漏到聊天里");
});

test("标记在行首带空格也认；没有标记时原文不动", () => {
  assert.equal(parseStickerMarker("   [表情：委屈]  ").keyword, "委屈");
  const none = parseStickerMarker("就是普通一句话");
  assert.equal(none.keyword, "");
  assert.equal(none.before, "就是普通一句话");
  assert.equal(none.after, "");
});

test("标记的变体写法也认：全角括号、写作「表情包」、全角冒号", () => {
  // 实机撞上过：模型写成 【表情包：呆萌】，一个都没吃上，那串标记原样漏进了聊天
  const a = parseStickerMarker("又来\n【表情包：呆萌】");
  assert.equal(a.keyword, "呆萌");
  assert.equal(a.before, "又来");
  assert.equal(a.after, "");
  assert.equal(parseStickerMarker("［表情包:得意］").keyword, "得意");
  assert.equal(parseStickerMarker("【表情：委屈】").keyword, "委屈");
});

test("残留标记整体拿掉：宁可这张图不发，也不能把标记字面发给对方", () => {
  assert.equal(stripStickerMarkup("又在改了【表情包：呆萌】"), "又在改了");
  assert.equal(stripStickerMarkup("[表情:无语]\n[表情:开心]"), "\n");
  assert.equal(stripStickerMarkup("就是普通一句话"), "就是普通一句话");
  assert.equal(stripStickerMarkup(""), "");
  // 残缺标记（模型漏写关键词，只剩光杆 [表情]）：也得吃掉，不能发给对方
  assert.equal(stripStickerMarkup("我在这儿陪你摆烂哈\n[表情]"), "我在这儿陪你摆烂哈\n");
  assert.equal(stripStickerMarkup("[表情：]"), "");
  assert.equal(stripStickerMarkup("抱一下嘛 【表情包】"), "抱一下嘛 ");
});

test("气泡哨兵：编解码往返，普通文本不会被误认", () => {
  const bubble = encodeStickerBubble("stk_9");
  assert.equal(isStickerBubble(bubble), true);
  assert.equal(stickerIdFromBubble(bubble), "stk_9");
  assert.equal(isStickerBubble("stk_9"), false);
  assert.equal(isStickerBubble(""), false);
  assert.equal(stickerIdFromBubble("普通文本"), "");
});

test("候选集：白名单之外与被她否掉的都进不来", () => {
  const catalog = buildCatalog(INDEX, "hanako");
  assert.deepEqual(catalog.stickers.map((row) => row.id), ["stk_1", "stk_2", "stk_4"]);
  assert.equal(catalog.preferred.has("stk_2"), true);
});

test("候选集：不在快照里的伙伴按全集处理", () => {
  const catalog = buildCatalog(INDEX, "someone-else");
  assert.deepEqual(catalog.stickers.map((row) => row.id), ["stk_1", "stk_2", "stk_3", "stk_4"]);
});

test("打分：命中情绪标签高于命中场景，未命中返回空", () => {
  const catalog = buildCatalog(INDEX, "hanako");
  const byEmotion = matchStickers(catalog.stickers, "无语");
  assert.deepEqual(byEmotion.map((row) => row.sticker.id).sort(), ["stk_1", "stk_2"]);
  const byScene = matchStickers(catalog.stickers, "翻白眼");
  assert.deepEqual(byScene.map((row) => row.sticker.id), ["stk_1"]);
  assert.equal(byEmotion[0].score > byScene[0].score, true);
  assert.deepEqual(matchStickers(catalog.stickers, "完全不存在的词"), []);
  assert.deepEqual(matchStickers(catalog.stickers, ""), []);
});

test("canonical specific allow 经归一后只影响对应稳定 subject，不改原图库", () => {
  const catalog = buildCatalog(INDEX, "someone-else");
  const policy = resolveStickerPolicy({
    guides: [canonicalGuide({
      id: "allow-stk-3",
      meaning: "这张可以用",
      kind: "permission",
      claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:stk_3" }],
    })],
  });
  const filtered = applyStickerPolicy(catalog, policy);
  assert.deepEqual(filtered.stickers.map((row) => row.id), ["stk_3"]);
  assert.deepEqual(catalog.stickers.map((row) => row.id), ["stk_1", "stk_2", "stk_3", "stk_4"]);
});

test("canonical specific deny 只排除对应图，且本地 veto 仍优先", () => {
  const catalog = buildCatalog(INDEX, "someone-else");
  const policy = resolveStickerPolicy({
    guides: [canonicalGuide({
      id: "deny-stk-1",
      meaning: "别用这张",
      kind: "boundary",
      claims: [{ target: "sticker.permission", effect: "deny", value: "specific", subject: "source:stk_1" }],
    })],
  });
  const filtered = applyStickerPolicy(catalog, policy);
  assert.deepEqual(filtered.stickers.map((row) => row.id), ["stk_2", "stk_3", "stk_4"]);
  assert.equal(pickSticker(filtered, { keyword: "无语" })?.id, "stk_2");
});

test("具体表情的负反馈立即撤掉关系许可并封住同一张，不误伤图库其他图", () => {
  const catalog = buildCatalog(INDEX, "someone-else");
  const policy = resolveStickerPolicy({
    guides: [canonicalGuide({ claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:stk_3" }] })],
    runtime: { negativeStickerSubjects: ["source:stk_3"] },
  });
  assert.deepEqual(applyStickerPolicy(catalog, policy).stickers.map((row) => row.id), ["stk_1", "stk_2", "stk_4"]);
});

test("specific allow 缺稳定 subject 时安全关闭，不退化成整库放行", () => {
  const catalog = buildCatalog(INDEX, "someone-else");
  const policy = resolveStickerPolicy({
    guides: [canonicalGuide({
      kind: "permission",
      claims: [{ target: "sticker.permission", effect: "allow", value: "specific" }],
    })],
  });
  assert.deepEqual(applyStickerPolicy(catalog, policy).stickers, []);
});

test("挑图：同一档里随机，且优先避开最近发过的", () => {
  const catalog = buildCatalog(INDEX, "hanako");
  const picked = pickSticker(catalog, { keyword: "无语", recentIds: ["stk_1"], rnd: () => 0 });
  assert.equal(picked.id, "stk_2");
  // 全部都在最近发过时，退回整档随机，而不是不发
  const fallback = pickSticker(catalog, { keyword: "无语", recentIds: ["stk_1", "stk_2"], rnd: () => 0 });
  assert.ok(["stk_1", "stk_2"].includes(fallback.id));
});

test("挑图：命中不了就不发（返回 null）", () => {
  const catalog = buildCatalog(INDEX, "mio");
  assert.equal(pickSticker(catalog, { keyword: "委屈" }), null);
});

test("不掐时间也不拦连发了：甩不甩ta自己看情绪，代码只管一条最多一张", () => {
  const src = fs.readFileSync(new URL("../lib/stickers.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /canSendSticker|minGapMs/, "间隔、连着两条不都甩那套已经拿掉");
  assert.match(src, /一条回复最多一张/, "规矩改成写在提示词里，不下硬判");
});

test("最近用过的表情：新的在前、去重、按上限截断", () => {
  const history = [
    { role: "assistant", bubbles: [encodeStickerBubble("stk_1"), "话"] },
    { role: "user", text: "嗯" },
    { role: "assistant", bubbles: [encodeStickerBubble("stk_2")] },
    { role: "assistant", bubbles: [encodeStickerBubble("stk_1")] },
  ];
  assert.deepEqual(recentStickerIds(history, 5), ["stk_1", "stk_2"]);
  assert.deepEqual(recentStickerIds(history, 1), ["stk_1"]);
  assert.equal(lastStickerAt([{ role: "assistant", bubbles: [encodeStickerBubble("stk_1")], at: 42 }]), 42);
  assert.equal(lastStickerAt([{ role: "assistant", text: "没有图" }]), 0);
});

test("参考词：按出现次数排，取前 N 个", () => {
  const catalog = buildCatalog(INDEX, "hanako");
  assert.deepEqual(referenceWords(catalog, 2), ["无语", "开心"]);
});

test("提示词：图库为空就不提这回事；有图时说清词从哪来、最多几张", () => {
  assert.equal(buildStickerHint(null), "");
  assert.equal(buildStickerHint({ stickers: [] }), "");
  const hint = buildStickerHint(buildCatalog(INDEX, "hanako"));
  assert.match(hint, /\[表情:关键词\]/);
  assert.match(hint, /无语/);
  assert.match(hint, /你自己这句话的语气/, "图说的是ta自己的态度，不是送她的安慰");
  assert.match(hint, /一条回复最多一张/);
  assert.doesNotMatch(hint, /连着两条|点缀|送一个表情/, "旧那套攒规矩的写法已经换掉");
});

test("路径拼接：快照里的相对路径落在表情包数据目录下，且不允许穿越", () => {
  const home = "C:\\Users\\x\\.hanako";
  assert.equal(
    stickerAbsolutePath(home, "stickers/1.jpg"),
    `${home}\\plugin-data\\biaoqingbao\\stickers\\1.jpg`,
  );
  assert.equal(stickerAbsolutePath(home, "../../secrets.txt"), `${home}\\plugin-data\\biaoqingbao\\secrets.txt`);
  assert.equal(stickerAbsolutePath(home, ""), "");
});

const LOOSE_INDEX = {
  schemaVersion: 1,
  stickers: [
    { id: "stk_11", file: "s/11.jpg", emotion: ["忧郁"], scene: [], keywords: [], description: "有点丧" },
    { id: "stk_12", file: "s/12.jpg", emotion: ["开心"], scene: [], keywords: [], description: "笑得很灿烂" },
  ],
  partners: {
    hanako: { configured: true, allowed: ["stk_11", "stk_12"], preferred: [], vetoed: [], recent: [] },
  },
};

test("兜底挑图：图库里没这个词，也能靠共用汉字捡一张（宁可发错，也别空手）", () => {
  const catalog = buildCatalog(LOOSE_INDEX, "hanako");
  assert.equal(matchStickers(catalog.stickers, "郁闷").length, 0, "精确/包含匹配本来就不中");
  const picked = pickSticker(catalog, { keyword: "郁闷", rnd: () => 0 });
  assert.equal(picked?.id, "stk_11", "共用一个「郁」字，兜到「忧郁」那张");
});

test("兜底挑图：连一个字都不沾，那才是真没图，这次不发", () => {
  const catalog = buildCatalog(LOOSE_INDEX, "hanako");
  assert.equal(looseMatchStickers(catalog.stickers, "flying").length, 0);
  assert.equal(pickSticker(catalog, { keyword: "flying" }), null);
});

test("提示词：摆了会想甩图的几个劲儿，还给一组照着拄的示范", () => {
  const hint = buildStickerHint(buildCatalog(INDEX, "hanako"));
  assert.match(hint, /被气笑/, "具体到场景，模型才好对号");
  assert.match(hint, /她说/, "带一组能照着模仿的短示范");
  assert.match(hint, /不用解释这张图是什么/);
  assert.match(hint, /想到更贴的照写/, "词表从 60 放到全量，不再逼着模型只能从少数词里挑");
});

test("参考词：带标点或长得不像词的情绪标签不进词表", () => {
  const messy = {
    schemaVersion: 1,
    stickers: [
      { id: "a", file: "a.jpg", emotion: ["无语", "疑惑，怀疑"], keywords: [], scene: [] },
      { id: "b", file: "b.jpg", emotion: ["无语", "开心"], keywords: [], scene: [] },
    ],
    partners: {},
  };
  const words = referenceWords(buildCatalog(messy, "anyone"), 20);
  assert.deepEqual(words, ["无语", "开心"]);
});

// 她定的规矩：没标签的图在茶话会这边就不显示也不能导。
// 理由是伙伴那边只能看到"[表情]"两个字，发出去是添乱。
test("标签：情绪/场景/关键词有一个就算有标签，全空就不让进图库", () => {
  assert.equal(hasUsableTags({ emotion: ["委屈"], scene: [], keywords: [] }), true);
  assert.equal(hasUsableTags({ emotion: [], scene: ["操场"], keywords: [] }), true);
  assert.equal(hasUsableTags({ emotion: [], scene: [], keywords: ["猫"] }), true);
  assert.equal(hasUsableTags({ emotion: [], scene: [], keywords: [] }), false);
  assert.equal(hasUsableTags({ emotion: ["  "], scene: [""], keywords: [null] }), false, "空白不算标签");
  assert.equal(hasUsableTags({ description: "一只猫" }), false, "只有画面描述不算——那份描述不进标签链");
  assert.equal(hasUsableTags(null), false);
});

test("标签翻人话：先情绪再场景；一个标签都没才退回画面描述", () => {
  assert.equal(stickerLabelText({ emotion: ["委屈"], scene: ["墙角"], keywords: ["蹲着"], description: "蹲在墙角" }), "委屈、墙角");
  assert.equal(stickerLabelText({ emotion: [], scene: [], keywords: ["猫"], description: "一只猫翻白眼" }), "一只猫翻白眼");
  assert.equal(stickerLabelText({ emotion: [], scene: [], keywords: [], description: "" }), "");
});

test("标签表：本地图库盖过快照，老消息里残留的外部 id 也查得到", () => {
  const map = stickerLabelMap({
    catalog: { stickers: [{ id: "stk_1", emotion: ["无语"], description: "睁眼瞎看的猫" }] },
    library: { stickers: [{ id: "stk_1", emotion: ["无语"], scene: ["翻白眼"] }] },
  });
  assert.equal(map.get("stk_1"), "无语、翻白眼", "同一张图以茶话会自己存的那份为准");
  assert.equal(map.get("stk_missing"), undefined);
});

test("取源图：导入页要全库，不能按伙伴白名单筛", () => {
  assert.equal(sourceRowById(INDEX, "stk_3")?.file, "stickers/3.jpg", "stk_3 在 mio 的白名单里，也拿得到");
  assert.equal(sourceRowById(INDEX, "stk_nope"), null);
  assert.equal(sourceRowById(null, "stk_1"), null);
});

// 界面要讲人话，所以读取那层得把「为什么没读到」带出来。
const fakeCtx = (read) => ({ dataDir: "C:\\hana\\app-data\\chahuahui", resources: { read } });

test("读快照：成了就说 ok，没成得说清楚是哪一步没成", async () => {
  __clearCatalogCache();
  const ok = await readCatalogWithReason(fakeCtx(async () => ({ content: JSON.stringify(INDEX) })), { now: 0 });
  assert.equal(ok.reason, "ok");
  assert.equal(ok.index.stickers.length, 4);

  __clearCatalogCache();
  const missing = await readCatalogWithReason(fakeCtx(async () => ({ content: "" })), { now: 1 });
  assert.deepEqual({ index: missing.index, reason: missing.reason }, { index: null, reason: "not-found" });

  __clearCatalogCache();
  const broken = await readCatalogWithReason(fakeCtx(async () => ({ content: "{ nope" })), { now: 2 });
  assert.equal(broken.reason, "bad-json");

  __clearCatalogCache();
  const old = await readCatalogWithReason(fakeCtx(async () => ({ content: JSON.stringify({ ...INDEX, schemaVersion: 99 }) })), { now: 3 });
  assert.equal(old.reason, "schema-mismatch");

  __clearCatalogCache();
  const empty = await readCatalogWithReason(fakeCtx(async () => ({ content: JSON.stringify({ schemaVersion: 1, stickers: [] }) })), { now: 4 });
  assert.equal(empty.reason, "empty");

  __clearCatalogCache();
  const denied = await readCatalogWithReason(fakeCtx(async () => { throw new Error("ERR_ACCESS_DENIED"); }), { now: 5 });
  assert.equal(denied.reason, "read-failed");

  __clearCatalogCache();
  const noDir = await readCatalogWithReason({ resources: { read: async () => ({ content: "{}" }) } });
  assert.equal(noDir.reason, "no-data-dir");
  __clearCatalogCache();
});

test("读快照：读成功会进缓存，失败不顶掉好缓存", async () => {
  __clearCatalogCache();
  let calls = 0;
  const ctx = fakeCtx(async () => { calls += 1; return { content: JSON.stringify(INDEX) }; });
  assert.equal((await readCatalogWithReason(ctx, { now: 1000, ttlMs: 60000 })).reason, "ok");
  assert.equal((await readCatalogWithReason(ctx, { now: 2000, ttlMs: 60000 })).reason, "ok");
  assert.equal(calls, 1, "一分钟之内不用反复敲盘");

  // 过了有效期，这回敲盘失败：原因要如实说，而且不拿上次那份好缓存顶包
  const failing = fakeCtx(async () => { throw new Error("boom"); });
  const bad = await readCatalogWithReason(failing, { now: 100000, ttlMs: 60000 });
  assert.equal(bad.reason, "read-failed");
  assert.equal(bad.index, null);

  // 换回能读到的那个：缓存已过期，重新读一次，拿到的还是好数据
  const again = await readCatalogWithReason(ctx, { now: 100001, ttlMs: 60000 });
  assert.equal(again.reason, "ok");
  assert.equal(calls, 2);
  __clearCatalogCache();
});
