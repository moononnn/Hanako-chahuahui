import test from "node:test";
import assert from "node:assert/strict";

import {
  MEME_POOL_MAX,
  addMeme,
  addUserMeme,
  formatMemePrompt,
  markMemeUsed,
  normalizePool,
  selectMemesForAgent,
  trimPool,
} from "../lib/meme-pool.js";

// 2026-11-14 的结论留在这里当护栏：B 站弹幕和热评都不产梗（高频七成是「合影」「来了」
// 这类现场语言），从她话里用正则抠梗名也抠不准（387 条命中 22 条、只有 2 条真的）。
// 所以这个模块只剩「记她玩过的那几手 + 挑给伙伴」两件事，采集与裁定那套没接上线的
// 都已经删掉，别再照着旧设计往回加。

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
  assert.equal(row.lastSeenAt, t0 + 86_400_000, "再被看到就等于续命");
});

test("她确认过的梗不会被后来的候选降级", () => {
  const t0 = 1_700_000_000_000;
  const { pool } = addUserMeme([], { text: "老吴", meaning: "模仿猫咪生气叫声", at: t0 });
  assert.equal(pool[0].status, "confirmed");
  assert.equal(pool[0].meaning, "模仿猫咪生气叫声");
  const next = addMeme(pool, { text: "老吴", count: 3, at: t0 + 1000 });
  assert.equal(next.pool[0].status, "confirmed");
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
  for (let i = 0; i < MEME_POOL_MAX + 2; i += 1) {
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
  assert.equal(trimmed.length, MEME_POOL_MAX);
  const texts = trimmed.map((row) => row.text);
  assert.equal(texts.includes("说法0"), true, "确认过的留下");
  assert.equal(texts.includes("说法1"), true, "用过的留下");
});

test("池子有硬上限：确认过的条目也不是只进不出", () => {
  // 2026-11-15：原来只裁候选，而每说破一次就塞一条永不过期的确认条目，
  // 池子只涨不落。现在候选丢完了也会往确认过的动，只是放在第二档。
  const now = Date.now();
  const rows = Array.from({ length: MEME_POOL_MAX + 10 }, (_, i) => ({
    id: `c${i}`,
    text: `确认过${i}`,
    status: "confirmed",
    firstSeenAt: now - 10_000 + i,
    lastSeenAt: now - 10_000 + i,
    usedBy: [],
  }));
  const trimmed = trimPool(rows, now);
  assert.equal(trimmed.length, MEME_POOL_MAX, "全都确认过也要压回上限");
  assert.equal(trimmed.some((row) => row.text === "确认过0"), false, "最久没出现的先走");
});

test("让路顺序：候选先走，其次确认的，用过的最后才动", () => {
  const now = Date.now();
  const rows = [
    { id: "u1", text: "用过的", status: "confirmed", lastSeenAt: now - 900_000, usedBy: [{ agentId: "a", at: now }] },
    { id: "k1", text: "确认的", status: "confirmed", lastSeenAt: now - 800_000, usedBy: [] },
    { id: "c1", text: "候选一", status: "candidate", lastSeenAt: now - 700_000, usedBy: [] },
    { id: "c2", text: "候选二", status: "candidate", lastSeenAt: now - 600_000, usedBy: [] },
  ];
  const trimmed = trimPool(rows, now, { max: 2 }).map((row) => row.text);
  assert.deepEqual(trimmed, ["用过的", "确认的"], "只剩两个位置：两个候选先走，确认的和用过的留下");
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
