import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SEEDS,
  SEED_MOTIF_COOLDOWN_MS,
  addSeeds,
  cooldownMotifIds,
  emptySeedBook,
  isSameSeedSpot,
  isSameStance,
  isSeedKindVoiceMismatch,
  markSeedUsed,
  normalizeSeedKind,
  parseSeedReply,
  pickSeed,
  readSeedBook,
  seedKindHint,
  seedSpec,
  usableSeeds,
} from "../lib/topic-seeds.js";

const NOW = new Date("2026-10-04T18:00:00Z");
const MOTIF = { id: "h_huoguo", name: "火锅流派", object: "几种汤底与蘸料之争", preference: "认死牛油" };

function grown(rows, motif = MOTIF) {
  return addSeeds(emptySeedBook(), rows, { motif, now: NOW }).book;
}

test("种子行能解析出类型、面和角度", () => {
  const rows = parseSeedReply([
    "站队|清油锅和牛油锅到底差在哪|我认死牛油，但说不过清油派",
    "交换|蘸料台先舀什么后舀什么|我永远是蒜泥打底",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "stand");
  assert.equal(rows[0].hook, "清油锅和牛油锅到底差在哪");
  assert.equal(rows[0].angle, "我认死牛油，但说不过清油派");
  assert.equal(rows[1].kind, "exchange");
  assert.equal(parseSeedReply("无").length, 0);
});

test("类型认不出来就按好奇放，面缺了才丢", () => {
  assert.equal(normalizeSeedKind("吵架"), "curio");
  assert.equal(normalizeSeedKind("stand"), "stand");
  const rows = parseSeedReply(["搞事情|一个人涮火锅尴不尴尬|我总觉得别人在看我", "没有字段"].join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "curio");
});

test("同一个面只收一条，换几个字重说也算重复", () => {
  assert.equal(isSameSeedSpot("鸳鸯锅在外面是不是原罪", "鸳鸯锅在外面是不是原罪？"), true);
  assert.equal(isSameSeedSpot("清油锅和牛油锅的差别", "蘸料台先舀什么"), false);
  const book = grown([
    { kind: "stand", hook: "清油锅和牛油锅到底差在哪", angle: "" },
    { kind: "ask", hook: "清油锅和牛油锅差在哪", angle: "" },
    { kind: "exchange", hook: "蘸料台先舀什么后舀什么", angle: "" },
  ]);
  assert.equal(book.seeds.length, 2);
});

test("过期种子读回来就被清掉", () => {
  const book = grown([{ kind: "curio", hook: "一个人涮火锅尴不尴尬", angle: "" }]);
  assert.equal(usableSeeds(book, { now: NOW }).length, 1);
  const later = new Date(NOW.getTime() + 31 * 24 * 3600 * 1000);
  assert.equal(readSeedBook(book, later).seeds.length, 0);
  assert.equal(pickSeed(book, { now: later }), null);
});

test("刚聊过的母题先让开，只剩它一条时才不让", () => {
  const a = addSeeds(emptySeedBook(), [{ kind: "stand", hook: "清油和牛油差在哪", angle: "" }], { motif: { id: "m1", name: "火锅" }, now: NOW }).book;
  const both = addSeeds(a, [{ kind: "ask", hook: "要不要装个猫眼", angle: "" }], { motif: { id: "m2", name: "老小区" }, now: NOW }).book;
  const picked = pickSeed(both, { now: NOW, recentMotifIds: ["m1"], rnd: () => 0 });
  assert.equal(picked.motifId, "m2");
  const onlyCoffee = pickSeed(a, { now: NOW, recentMotifIds: ["m1"], rnd: () => 0 });
  assert.equal(onlyCoffee?.motifId, "m1", "别的都没有时宁可连着聊，也不空手");
});

test("用过的种子就不再出，用了几条都记得住", () => {
  const book = grown([
    { kind: "stand", hook: "清油和牛油差在哪", angle: "" },
    { kind: "exchange", hook: "蘸料台先舀什么", angle: "" },
  ]);
  const first = pickSeed(book, { now: NOW, rnd: () => 0 });
  const after = markSeedUsed(book, first.id, "我先说我那份蘸料", NOW);
  assert.equal(usableSeeds(after, { now: NOW }).length, 1);
  // 同一个母题刚聊过要歇一天，当天就不再出；过了冷却才轮得到下一条
  assert.equal(pickSeed(after, { now: NOW }), null);
  const tomorrow = new Date(NOW.getTime() + SEED_MOTIF_COOLDOWN_MS + 60 * 1000);
  const second = pickSeed(after, { now: tomorrow });
  assert.equal(second.id !== first.id, true);
  const drained = markSeedUsed(after, second.id, "", tomorrow);
  assert.equal(pickSeed(drained, { now: tomorrow }), null);
});

test("同一个母题聊过之后要歇一天，全在冷却里就空手", () => {
  const book = grown([
    { kind: "stand", hook: "清油和牛油差在哪", angle: "我认死牛油" },
    { kind: "exchange", hook: "蘸料台先舀什么", angle: "我永远是蒜泥打底" },
  ]);
  const used = markSeedUsed(book, book.seeds[0].id, "文本", NOW);
  assert.deepEqual([...cooldownMotifIds(used, { now: NOW })], [MOTIF.id]);
  assert.equal(pickSeed(used, { now: NOW }), null, "只剩冷却中的母题时宁可不发");
  const later = new Date(NOW.getTime() + SEED_MOTIF_COOLDOWN_MS + 60 * 1000);
  assert.equal(pickSeed(used, { now: later })?.motifId, MOTIF.id, "过了冷却就回来");
});

test("同一个态度换个场景也算重说，先放着", () => {
  const stance = "更偏向前者，随时截短也不必硬走完，不为成环增加绕行";
  const base = grown([{ kind: "stand", hook: "半日路线做成折返还是闭环", angle: stance }]);
  // 换个母题、换个面，但态度还是那一句
  const mixed = addSeeds(base, [{ kind: "stand", hook: "正午是先保树荫还是保短距离", angle: stance }], {
    motif: { id: "h_other", name: "别的方向" },
    now: NOW,
  }).book;
  const used = markSeedUsed(mixed, base.seeds[0].id, "文本", NOW);
  assert.equal(isSameStance(stance, stance), true);
  assert.equal(pickSeed(used, { now: NOW }), null, "态度撞车就不换场景重说");
});

test("求解和好奇写成结论就算跑调，别的不拦", () => {
  assert.equal(isSeedKindVoiceMismatch("我一个人走半日路线，越想越觉得不该给某段定死规矩", "curio"), true);
  assert.equal(isSeedKindVoiceMismatch("我还没想明白一个人走窄巷该咋个收脚", "curio"), false);
  assert.equal(isSeedKindVoiceMismatch("你会先看亮处近不近，还是直接按掉头线走？", "curio"), false);
  assert.equal(isSeedKindVoiceMismatch("这条我拿不准，你平时怎么弄", "ask"), false);
  assert.equal(isSeedKindVoiceMismatch("我认死牛油，说不过清油派", "stand"), false);
  // 实机那条的真形状：带着问句也照样是「我想通了，你选 A 还是 B」
  assert.equal(
    isSeedKindVoiceMismatch(
      "越想越觉得不该给某一段定死规矩，只把能退回来的亮处记下来\n你会看下一个亮处近不近，还是直接按掉头线走？",
      "curio",
    ),
    true,
  );
  // 既没未定、也没问、也没决断词的平铺直叙，当成结论压住
  assert.equal(isSeedKindVoiceMismatch("窄巷那段我以后都走外圈大路", "curio"), true);
});

test("库存有上限，攒太多就把最早的挤掉", () => {
  const rows = Array.from({ length: MAX_SEEDS + 5 }, (_, i) => ({ kind: "curio", hook: `第${i}个面`, angle: "" }));
  const book = grown(rows);
  assert.equal(book.seeds.length, MAX_SEEDS);
  assert.equal(book.seeds.at(-1).hook, `第${MAX_SEEDS + 4}个面`);
});

test("长种子时把已经铺过的面递过去，挡住重复", () => {
  const book = grown([{ kind: "stand", hook: "清油和牛油差在哪", angle: "我认死牛油" }]);
  const spec = seedSpec({ motif: MOTIF, existing: book, now: NOW });
  assert.match(spec.userText, /长期方向：火锅流派/);
  assert.match(spec.userText, /清油和牛油差在哪/);
  assert.match(spec.userText, /当时的想法：我认死牛油/, "连态度一起递过去，才好避开同一个立场换场景重说");
  assert.match(spec.systemPrompt, /对方有位置站/);
  assert.match(spec.systemPrompt, /不要编造现实里发生过的人、地点或经历/);
  assert.match(spec.systemPrompt, /态度要有区别/);
});

test("每种位置都有开口说明，认不出的落回好奇", () => {
  assert.match(seedKindHint("stand"), /立场摆出来/);
  assert.match(seedKindHint("exchange"), /换习惯/);
  assert.match(seedKindHint("self"), /别编现实里发生过的经历/);
  assert.match(seedKindHint("ask"), /征求意见/);
  assert.match(seedKindHint("乱写的"), /还没想明白/);
  assert.match(seedKindHint("curio"), /别写成结论/, "好奇类不许写成想通了");
});
