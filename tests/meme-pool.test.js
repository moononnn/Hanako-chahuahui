import test from "node:test";
import assert from "node:assert/strict";

import {
  MEME_MAX_CHARS,
  MEME_TTL_DAYS,
  addMeme,
  addUserMeme,
  buildMemeJudgePrompt,
  decayMemes,
  formatMemePrompt,
  isMemeWorthy,
  markMemeUsed,
  normalizePool,
  parseMemeJudgeReply,
  pickMemeCandidates,
  selectMemesForAgent,
  trimPool,
} from "../lib/meme-pool.js";

// 2026-11-14 实测：热门 6 个视频、约 9500 条弹幕，用真实热门弹幕当夹具。
//
// 关键教训有两条：
//   1. 高频噪声占大头。「合影」1091 次、「来了」129 次、「哈哈哈哈哈」7 次，
//      全是最多的，但一句都不是梗。粗筛不刮掉这些，池子第一周就废。
//   2. 跨视频复读**不能**当门槛。6 个视频的热门弹幕零重合——热门视频的弹幕
//      是这个视频的现场反应，不是全网流通的梗。所以跨批次累积靠池子续命，不靠一次比对。

const REAL_ROWS = [
  { text: "合影", count: 1091 },
  { text: "来了", count: 129 },
  { text: "吹茶仙子", count: 404 },
  { text: "念头通达", count: 301 },
  { text: "盖亚", count: 88 },
  { text: "哈哈哈哈哈", count: 7 },
  { text: "意林", count: 4 },
  { text: "夺少？！", count: 12 },
  { text: "今夕是何年？", count: 12 },
  { text: "1小时前", count: 6 },
  { text: "@南宫婉", count: 23 },
  { text: "紧跟时事", count: 16 },
];

test("粗筛刮掉笑声、报到、呼唤，留下能脱离视频单独成立的说法", () => {
  assert.equal(isMemeWorthy("哈哈哈哈哈"), false, "纯笑");
  assert.equal(isMemeWorthy("草"), false, "太短且是笑声");
  assert.equal(isMemeWorthy("合影"), false, "到达播报");
  assert.equal(isMemeWorthy("来了"), false, "到达播报");
  assert.equal(isMemeWorthy("1小时前"), false, "时间播报");
  assert.equal(isMemeWorthy("@南宫婉"), false, "称呼角色");
  assert.equal(isMemeWorthy("12345"), false, "纯数字");
  assert.equal(isMemeWorthy("念头通达"), true);
  assert.equal(isMemeWorthy("盖亚"), true, "两字也能是梗，噪声由报到词单独挡");
});

test("粗筛按归一化文本判定：标点已被抹掉，长度算的是实字", () => {
  // normalizeDanmaku 会抹掉 ？！，所以真实入口传进来的是「夺少」
  assert.equal(isMemeWorthy("夺少"), true, "两字放行，语义交给后面的模型判");
  assert.equal(isMemeWorthy("今夕是何年"), true);
  assert.equal(isMemeWorthy("紧跟时事"), true);
});

test("候选按次数排序，噪声一条都不进来", () => {
  const picked = pickMemeCandidates(REAL_ROWS, { minRepeat: 5 });
  const texts = picked.map((row) => row.text);
  assert.deepEqual(texts.slice(0, 3), ["吹茶仙子", "念头通达", "盖亚"]);
  assert.equal(texts.includes("合影"), false);
  assert.equal(texts.includes("来了"), false);
  assert.equal(texts.includes("哈哈哈哈哈"), false);
});
test("次数不够的不进候选，阈值可调", () => {
  assert.equal(pickMemeCandidates([{ text: "念头通达", count: 4 }], { minRepeat: 5 }).length, 0);
  assert.equal(pickMemeCandidates([{ text: "念头通达", count: 4 }], { minRepeat: 3 }).length, 1);
});

test("同一句再被刷到只累加，不新建条目", () => {
  const t0 = 1_700_000_000_000;
  const first = addMeme([], { text: "念头通达", count: 301, source: "bili", originId: "BV1", at: t0 });
  assert.equal(first.added, true);
  const second = addMeme(first.pool, { text: "念头通达", count: 40, source: "bili", originId: "BV2", at: t0 + 86_400_000 });
  assert.equal(second.added, false);
  assert.equal(second.pool.length, 1);
  const row = second.pool[0];
  assert.equal(row.count, 341);
  assert.equal(row.sightings, 2);
  assert.deepEqual(row.origins, ["BV1", "BV2"]);
  assert.equal(row.lastSeenAt, t0 + 86_400_000, "再被刷到就等于续命");
});

test("她确认过的梗不会被后来的候选降级", () => {
  const t0 = 1_700_000_000_000;
  const { pool } = addUserMeme([], { text: "老吴", meaning: "模仿猫咪生气叫声", at: t0 });
  assert.equal(pool[0].status, "confirmed");
  assert.equal(pool[0].meaning, "模仿猫咪生气叫声");
  const next = addMeme(pool, { text: "老吴", count: 3, at: t0 + 1000 });
  assert.equal(next.pool[0].status, "confirmed");
});

test("沉淀：太久没再出现的候选退场，她确认过的不过期", () => {
  const t0 = 1_700_000_000_000;
  const old = t0 - (MEME_TTL_DAYS + 1) * 86_400_000;
  const pool = [
    { id: "a", text: "旧梗", status: "candidate", firstSeenAt: old, lastSeenAt: old, usedBy: [] },
    { id: "b", text: "老吴", status: "confirmed", firstSeenAt: old, lastSeenAt: old, usedBy: [] },
  ];
  const kept = decayMemes(pool, { now: t0 }).map((row) => row.text);
  assert.deepEqual(kept, ["老吴"]);
});

test("选给伙伴：确认过的排前面，三天内用过的这次不给", () => {
  const now = 1_700_000_000_000;
  const pool = normalizePool([
    { id: "a", text: "候选甲", status: "candidate", count: 900, firstSeenAt: now, lastSeenAt: now, usedBy: [] },
    { id: "b", text: "老吴", status: "confirmed", count: 1, firstSeenAt: now, lastSeenAt: now, usedBy: [] },
    {
      id: "c",
      text: "刚玩过",
      status: "candidate",
      count: 900,
      firstSeenAt: now,
      lastSeenAt: now,
      usedBy: [{ agentId: "hanako", at: now - 86_400_000 }],
    },
  ]);
  const picked = selectMemesForAgent(pool, { agentId: "hanako", now, limit: 5 });
  const texts = picked.map((row) => row.text);
  assert.equal(texts[0], "老吴", "她自己说过的排最前");
  assert.equal(texts.includes("刚玩过"), false, "一天前刚用过，这次不推");
  // 换个伙伴不受影响：同一句话对不同人是新的
  const other = selectMemesForAgent(pool, { agentId: "other", now, limit: 5 }).map((row) => row.text);
  assert.equal(other.includes("刚玩过"), true);
});

test("三天后用过的可以再推：梗是可以翻回来重玩的", () => {
  const now = 1_700_000_000_000;
  const pool = normalizePool([{
    id: "c",
    text: "翻旧梗",
    status: "candidate",
    count: 10,
    firstSeenAt: now,
    lastSeenAt: now,
    usedBy: [{ agentId: "hanako", at: now - 4 * 86_400_000 }],
  }]);
  assert.equal(selectMemesForAgent(pool, { agentId: "hanako", now }).length, 1);
});

test("数量上限：默认只给三条，多了模型挑花眼", () => {
  const now = Date.now();
  const pool = normalizePool(Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`,
    text: `说法${i}`,
    count: 10 + i,
    firstSeenAt: now,
    lastSeenAt: now,
    usedBy: [],
  })));
  assert.equal(selectMemesForAgent(pool, { agentId: "hanako", now }).length, 3);
  assert.equal(selectMemesForAgent(pool, { agentId: "hanako", now, limit: 8 }).length, 8);
});

test("标记用过：只记人与时间，不删条目", () => {
  const now = 1_700_000_000_000;
  const pool = normalizePool([{ id: "a", text: "念头通达", firstSeenAt: now, lastSeenAt: now, usedBy: [] }]);
  markMemeUsed(pool, { id: "a", agentId: "hanako", at: now });
  assert.equal(pool[0].usedBy.length, 1);
  assert.equal(pool[0].usedBy[0].agentId, "hanako");
});

test("池子上限：先丢最老的候选，确认过的和用过的留着", () => {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 402; i += 1) {
    rows.push({
      id: `m${i}`,
      text: `说法${i}`,
      status: i === 0 ? "confirmed" : "candidate",
      firstSeenAt: now - 10_000 + i,
      lastSeenAt: now - 10_000 + i,
      usedBy: i === 1 ? [{ agentId: "hanako", at: now }] : [],
    });
  }
  const trimmed = trimPool(rows, now);
  assert.equal(trimmed.length, 400);
  const texts = trimmed.map((row) => row.text);
  assert.equal(texts.includes("说法0"), true, "确认过的留下");
  assert.equal(texts.includes("说法1"), true, "用过的留下");
});

test("出站文本：给玩法不给台词，必须写死“活用不是重复”", () => {
  const text = formatMemePrompt([
    { text: "哎呀…手滑不小心发了张自拍，我单身，哈哈哈哈", status: "confirmed", meaning: "在演中年油腻男" },
    { text: "念头通达", status: "confirmed" },
  ], { userName: "测试用户" });
  assert.match(text, /你们之前玩过的/);
  assert.match(text, /在演中年油腻男/);
  assert.match(text, /不是给你背的台词/);
  assert.match(text, /换个场景重演/);
  assert.match(text, /别把原句搬过来/);
  assert.match(text, /测试用户/);
  assert.equal(formatMemePrompt([]), "", "空池什么都不加");
});

test("归一化：坏行丢掉，默认值补齐", () => {
  const pool = normalizePool([null, { text: "  " }, { text: " 念头通达 ", count: "5" }]);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].text, "念头通达");
  assert.equal(pool[0].count, 5);
  assert.equal(pool[0].status, "candidate");
  assert.ok(pool[0].id);
});

test("超长文本不进池：那是台词不是说法", () => {
  assert.equal(isMemeWorthy("啊".repeat(MEME_MAX_CHARS + 1)), false);
  assert.equal(isMemeWorthy("这是一句特别特别长的完整台词根本不像大家在玩的说法呀对不对"), false);
});

test("裁定提示词：给三条判据、只看语境不照着写、宁可少挑", () => {
  const text = buildMemeJudgePrompt(
    [{ text: "吹茶仙子", count: 395 }, { text: "今夕是何年", count: 12 }],
    { videoTitle: "凡人修仙传第200集" },
  );
  assert.match(text, /搬走还成立吗/);
  assert.match(text, /是说法还是名词/);
  assert.match(text, /带不带玩的成分/);
  assert.match(text, /宁可少挑/);
  assert.match(text, /凡人修仙传第200集/);
  assert.match(text, /今夕是何年（刷了 12 次）/);
  assert.equal(buildMemeJudgePrompt([]), "", "没候选就不发请求");
});

test("裁定回包：只收原句，改写的不收，最多三条", () => {
  const cand = [{ text: "今夕是何年", count: 12 }, { text: "吹茶仙子", count: 395 }];
  const ok = parseMemeJudgeReply('好的{"keep":[{"text":"今夕是何年","why":"套话能搬走"}]}', cand);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].text, "今夕是何年");
  assert.equal(ok[0].count, 12);

  assert.deepEqual(parseMemeJudgeReply('{"keep":[{"text":"今夕是何年啊","why":"自己改了"}]}', cand), [], "改写的不收");
  assert.deepEqual(parseMemeJudgeReply('{"keep":[{"text":"今夕是何年"},{"text":"今夕是何年"}]}', cand).length, 1, "重复只算一条");
  assert.deepEqual(parseMemeJudgeReply("没有 JSON", cand), []);
  assert.deepEqual(parseMemeJudgeReply('{"keep":[]}', cand), [], "空就是空，不兜底");
});
