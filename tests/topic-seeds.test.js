import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SEEDS,
  SEED_MOTIF_COOLDOWN_MS,
  SEED_MOTIF_EXHAUST_LIMIT,
  addSeeds,
  cooldownMotifIds,
  emptySeedBook,
  exhaustedMotifIds,
  isSameSeedSpot,
  isSameStance,
  isSeedKindVoiceMismatch,
  markSeedUsed,
  normalizeSeedKind,
  parseSeedReply,
  pickMotifForSeeds,
  pickSeed,
  readSeedBook,
  seedHistoryFor,
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
  assert.match(spec.systemPrompt, /不靠猜前提/);
  assert.match(spec.systemPrompt, /允许一句轻分享/);
  assert.match(spec.systemPrompt, /不要编造现实里发生过的人、地点或经历/);
  assert.match(spec.systemPrompt, /态度要有区别/);
});

test("每种位置都有开口说明，认不出的落回好奇", () => {
  assert.match(seedKindHint("stand"), /立场摆出来/);
  assert.match(seedKindHint("exchange"), /换习惯/);
  assert.match(seedKindHint("self"), /别编现实里发生过的经历/);
  assert.match(seedKindHint("ask"), /征求意见/);
  // 2026-10-30 放松：好奇不再要求装「我还没想明白」，说好奇、新发现、偏好都成立
  assert.match(seedKindHint("乱写的"), /说好奇、说新发现/);
  assert.match(seedKindHint("curio"), /不必非带问句/);
  assert.doesNotMatch(seedKindHint("curio"), /还没想明白的事/);
  // 求解只在真拿不准时用；已经聊出偏好就接着那个说，不重问一遍
  assert.match(seedKindHint("ask"), /不重新问她一遍/);
});

const sentRow = (seedId, text, at, extra = {}) => ({
  role: "assistant", proactive: true, seedId, text, at: at.toISOString(), ...extra,
});

test("同方向以前真说过的正文能捞回来：只认同一个母题、只认发出去的", () => {
  const book = grown([
    { kind: "stand", hook: "清油和牛油差在哪", angle: "我认死牛油" },
    { kind: "exchange", hook: "蘸料台先舀什么", angle: "我永远是蒜泥打底" },
  ]);
  const mixed = addSeeds(book, [{ kind: "curio", hook: "老小区要不要装个猫眼", angle: "" }], {
    motif: { id: "h_laoxiaoqu", name: "老小区" },
    now: NOW,
  }).book;
  assert.deepEqual(seedHistoryFor(mixed, { motifId: MOTIF.id }, { now: NOW, messages: [] }), [], "没发过的库存不算经历");

  const used = markSeedUsed(mixed, book.seeds[0].id, "我先说：牛油清油我都吃，但牛油更香", NOW);
  const messages = [
    { role: "user", text: "牛油清油你都吃？", at: NOW.toISOString() },
    sentRow(book.seeds[0].id, "我先说：牛油清油我都吃，但牛油更香", NOW),
  ];
  assert.deepEqual(seedHistoryFor(used, { motifId: MOTIF.id }, { now: NOW, messages }), [
    { at: NOW.toISOString(), text: "我先说：牛油清油我都吃，但牛油更香" },
  ]);
  assert.deepEqual(seedHistoryFor(used, { motifId: "h_laoxiaoqu" }, { now: NOW, messages }), [], "别的方向的话不能串过来");
  assert.deepEqual(seedHistoryFor(used, {}, { now: NOW, messages }), [], "种子没母题就不猜");
  assert.deepEqual(seedHistoryFor(used, null, { now: NOW, messages }), []);
  assert.deepEqual(seedHistoryFor(used, { motifId: MOTIF.id }, { now: NOW }), [], "没给线程就宁可空着");
});

test("历史只认线程里真在的那一行：撤回、Ctrl+Z、换个人说的都不算", () => {
  const book = grown([{ kind: "stand", hook: "清油和牛油差在哪", angle: "我认死牛油" }]);
  const seedId = book.seeds[0].id;
  const used = markSeedUsed(book, seedId, "旧影子：只认牛油", NOW);
  const motif = { motifId: MOTIF.id };

  // 撤回：账上 usedText 还在，但线程里那行已标 recalled
  const recalled = [sentRow(seedId, "旧影子：只认牛油", NOW, { recalled: true })];
  assert.deepEqual(seedHistoryFor(used, motif, { now: NOW, messages: recalled }), [], "删掉的话不能借账本复活");

  // 按范围删掉：线程里根本没有这行
  assert.deepEqual(seedHistoryFor(used, motif, { now: NOW, messages: [{ role: "user", text: "嗯", at: NOW.toISOString() }] }), [], "没出处就不算历史");

  // 消息还在，但 seedId 不是这颗种子（别的来源、别家的账）
  const otherSeed = [sentRow("seed_另一个", "旧影子：只认牛油", NOW)];
  assert.deepEqual(seedHistoryFor(used, motif, { now: NOW, messages: otherSeed }), []);

  // 不是话的行、不是她说的行、空正文都不算
  for (const row of [
    sentRow(seedId, "旧影子：只认牛油", NOW, { kind: "action" }),
    { role: "user", seedId, text: "旧影子：只认牛油", at: NOW.toISOString() },
    sentRow(seedId, "   ", NOW),
  ]) {
    assert.deepEqual(seedHistoryFor(used, motif, { now: NOW, messages: [row] }), []);
  }
});

test("她后来改过那句话：历史用线程里的新正文，不拿旧 usedText 顶上", () => {
  const book = grown([{ kind: "stand", hook: "清油和牛油差在哪", angle: "我认死牛油" }]);
  const seedId = book.seeds[0].id;
  const used = markSeedUsed(book, seedId, "旧影子：只认牛油", NOW);
  const messages = [sentRow(seedId, "改过之后：清油也行，图个不腻", NOW)];
  const history = seedHistoryFor(used, { motifId: MOTIF.id }, { now: NOW, messages });
  assert.deepEqual(history, [{ at: NOW.toISOString(), text: "改过之后：清油也行，图个不腻" }]);
  assert.doesNotMatch(history[0].text, /旧影子/, "编辑后的旧 usedText 不得泄漏");
});

test("母题用掉的种子攒到上限就算聊透，不再挑去发", () => {
  const rows = Array.from({ length: SEED_MOTIF_EXHAUST_LIMIT + 1 }, (_, i) => ({ kind: "curio", hook: `第${i}个面`, angle: "" }));
  let book = grown(rows);
  for (let i = 0; i < SEED_MOTIF_EXHAUST_LIMIT; i += 1) {
    book = markSeedUsed(book, book.seeds[i].id, "文本", NOW);
  }
  assert.deepEqual([...exhaustedMotifIds(book, { now: NOW })], [MOTIF.id]);
  assert.equal(usableSeeds(book, { now: NOW }).length, 1, "还剩一条没用，但母题已经聊透");
  const later = new Date(NOW.getTime() + SEED_MOTIF_COOLDOWN_MS + 60 * 1000);
  assert.equal(pickSeed(book, { now: later }), null, "聊透的母题过了冷却也不再挑");
});

test("历史只看过去：未来时间不算，过期的不算，六条为限且按时间正序", () => {
  const future = {
    id: "s_future", motifId: MOTIF.id, motifName: MOTIF.name, kind: "curio",
    hook: "未来的面", angle: "", createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(),
    usedAt: new Date(NOW.getTime() + 3600 * 1000).toISOString(), usedText: "明天才会说的话",
  };
  assert.deepEqual(seedHistoryFor({ seeds: [future] }, { motifId: MOTIF.id }, { now: NOW, messages: [sentRow(future.id, "明天才会说的话", new Date(NOW.getTime() + 3600 * 1000))] }), [], "时间在未来的那行不算历史");

  // 二十五小时前说过的那条：已经出了母题冷却窗，但还在种子的三十天保质期里、线程里也还在，照样回读
  const oldBook = addSeeds(emptySeedBook(), [{ kind: "stand", hook: "蘸料台先舀什么", angle: "蒜泥打底" }], {
    motif: MOTIF, now: new Date(NOW.getTime() - 26 * 3600 * 1000),
  }).book;
  const longAgo = new Date(NOW.getTime() - 25 * 3600 * 1000);
  const usedOld = markSeedUsed(oldBook, oldBook.seeds[0].id, "昨天那句：只认蒜泥打底", longAgo);
  const oldMessages = [sentRow(oldBook.seeds[0].id, "昨天那句：只认蒜泥打底", longAgo)];
  assert.deepEqual(seedHistoryFor(usedOld, { motifId: MOTIF.id }, { now: NOW, messages: oldMessages }), [
    { at: longAgo.toISOString(), text: "昨天那句：只认蒜泥打底" },
  ]);
  const expired = new Date(NOW.getTime() + 31 * 24 * 3600 * 1000);
  assert.deepEqual(seedHistoryFor(usedOld, { motifId: MOTIF.id }, { now: expired, messages: oldMessages }), [], "过期的种子读回来就清了");

  const many = addSeeds(emptySeedBook(), Array.from({ length: 8 }, (_, i) => ({ kind: "curio", hook: `第${i}个面`, angle: "" })), { motif: MOTIF, now: NOW }).book;
  let book = many;
  const manyMessages = [];
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(NOW.getTime() - (8 - i) * 3600 * 1000);
    book = markSeedUsed(book, many.seeds[i].id, `第${i}条说过的`, at);
    manyMessages.push(sentRow(many.seeds[i].id, `第${i}条说过的`, at));
  }
  assert.deepEqual(
    seedHistoryFor(book, { motifId: MOTIF.id }, { now: NOW, messages: manyMessages }).map((row) => row.text),
    Array.from({ length: 6 }, (_, i) => `第${i + 2}条说过的`),
    "只取最近六条，早的让位，顺序按时间正着排",
  );
  // 线程里已经自然裁掉的那几条（例如更早的旧消息）不回读
  const trimmed = manyMessages.slice(-3);
  assert.deepEqual(
    seedHistoryFor(book, { motifId: MOTIF.id }, { now: NOW, messages: trimmed }).map((row) => row.text),
    ["第5条说过的", "第6条说过的", "第7条说过的"],
    "线程里不在了就不冒充说过",
  );
  assert.equal(seedHistoryFor(book, { motifId: MOTIF.id }, { now: NOW, messages: manyMessages, limit: 0 }).length, 0);
  assert.equal(seedHistoryFor(book, { motifId: MOTIF.id }, { now: NOW, messages: manyMessages, limit: 2 }).length, 2);
});

test("聊透的母题不再被挑去长新种子", () => {
  const rows = Array.from({ length: SEED_MOTIF_EXHAUST_LIMIT }, (_, i) => ({ kind: "curio", hook: `第${i}个面`, angle: "" }));
  let book = grown(rows);
  for (let i = 0; i < SEED_MOTIF_EXHAUST_LIMIT; i += 1) {
    book = markSeedUsed(book, book.seeds[i].id, "文本", NOW);
  }
  const picked = pickMotifForSeeds([MOTIF, { id: "h_qita", name: "别的方向" }], book, {});
  assert.equal(picked.id, "h_qita", "聊透的母题让位给别的方向");
});
