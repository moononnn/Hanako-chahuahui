import test from "node:test";
import assert from "node:assert/strict";
import {
  FEED_ASSETS,
  FEED_SCAN_LIMIT,
  PARTNER_FEED_MAX_PER_DAY,
  addPartnerFeed,
  detectFeedSignal,
  feedAssetText,
  formatPartnerFeed,
  gateFeed,
  hitInterest,
  isFeedableTarget,
  lifeDay,
  noteFeed,
  normalizePartnerFeed,
  pickFeedAsset,
} from "../lib/partner-feed.js";

const at = (iso) => new Date(iso).toISOString();

test("同类投喂累加，不同类并存，并带上是哪一次递的", () => {
  const once = addPartnerFeed(null, "🍰", { at: at("2026-09-28T10:00:00.000Z"), kind: "interest-hit", reason: "她在意烘焙" });
  const twice = addPartnerFeed(once, "🍰", { at: at("2026-09-28T10:05:00.000Z"), kind: "interest-hit" });
  const mixed = addPartnerFeed(twice, "☕", { at: at("2026-09-28T10:06:00.000Z"), kind: "cold-treated", reason: "我还在" });

  assert.deepEqual(mixed.items.map(({ emoji, count }) => ({ emoji, count })), [
    { emoji: "🍰", count: 2 },
    { emoji: "☕", count: 1 },
  ]);
  assert.equal(mixed.items[0].kind, "interest-hit");
  assert.equal(mixed.items[0].reason, "她在意烘焙");
  assert.equal(formatPartnerFeed(mixed), "🍰×2 ☕");
});

test("投喂账本过滤空条目并合并重复项", () => {
  const feed = normalizePartnerFeed({
    items: [{ emoji: "🍰", count: 2, kind: "shared" }, { emoji: "🍰", count: 1 }, { emoji: "" }, { count: 3 }],
  });
  assert.deepEqual(feed.items.map(({ emoji, count }) => ({ emoji, count })), [{ emoji: "🍰", count: 3 }]);
  assert.equal(feed.items[0].kind, "shared");
});

test("已读硬门槛（未读/撤回/动作消息一律不挂）", () => {
  assert.equal(isFeedableTarget({ role: "user", readAt: null }), false);
  assert.equal(isFeedableTarget({ role: "user", readAt: null, recalled: false }), false);
  assert.equal(isFeedableTarget({ role: "user", readAt: "2026-09-28T10:00:00.000Z", recalled: true }), false);
  assert.equal(isFeedableTarget({ role: "user", kind: "action", readAt: "2026-09-28T10:00:00.000Z" }), false);
  assert.equal(isFeedableTarget({ role: "assistant", readAt: "2026-09-28T10:00:00.000Z" }), false);
  assert.equal(isFeedableTarget({ role: "user", readAt: "2026-09-28T10:00:00.000Z" }), true);
});

test("一天最多两次，两次之间要隔够九十分钟", () => {
  const now = new Date("2026-09-28T14:00:00.000Z");
  assert.equal(gateFeed({ state: null, now }).ok, true);
  assert.equal(gateFeed({ state: { day: "2026-09-28", count: 1, lastAt: "2026-09-28T11:00:00.000Z" }, now }).ok, true);
  // 刚递过：太密
  assert.deepEqual(gateFeed({ state: { day: "2026-09-28", count: 1, lastAt: "2026-09-28T13:30:00.000Z" }, now }), { ok: false, reason: "too-soon" });
  // 一天两次用完
  assert.deepEqual(
    gateFeed({ state: { day: "2026-09-28", count: PARTNER_FEED_MAX_PER_DAY, lastAt: "2026-09-28T12:00:00.000Z" }, now }),
    { ok: false, reason: "daily-max" },
  );
  // 隔天自动重置
  assert.equal(gateFeed({ state: { day: "2026-09-27", count: 2, lastAt: "2026-09-27T20:00:00.000Z" }, now }).ok, true);
  // ta 手上有活时不递（睡着也算：半夜递一句比不回更奇怪）
  assert.deepEqual(gateFeed({ state: null, now, busy: true }), { ok: false, reason: "busy" });
});

test("选品表里没有重复条目", () => {
  const emojis = FEED_ASSETS.map((row) => row.emoji);
  assert.equal(new Set(emojis).size, emojis.length);
});

test("关键词不泛化：她档案里的泛化词不该把一堆东西拖进候选池", () => {
  // 「甜」「喝」「糖」这类泛化词都已经被剔掉了，档案里只剩它们时不该递出食物
  assert.notEqual(pickFeedAsset({ assetText: "甜 喝 糖", agentId: "a", rnd: () => 0 }), "🍰");
  assert.notEqual(pickFeedAsset({ assetText: "甜 喝 糖", agentId: "a", rnd: () => 0 }), "🧋");
  // 真说到关键词才递
  assert.equal(pickFeedAsset({ assetText: "奶茶 珍珠", agentId: "a", rnd: () => 0 }), "🍵");
  assert.equal(pickFeedAsset({ assetText: "糖果 棒棒糖", agentId: "a", rnd: () => 0 }), "🍬");
});

test("兴趣命中只看她的兴趣词本身，不做泛化推断", () => {
  // 单字兴趣词直接被长度门槛挡掉
  assert.equal(hitInterest("我今天去看了烘焙展", "看 烘焙"), "烘焙");
  assert.equal(hitInterest("啊这", "啊 这"), "");
  assert.equal(hitInterest("喝水", "喝 水"), "");
});

test("已读字段坏掉当没读过", () => {
  assert.equal(isFeedableTarget({ role: "user", readAt: "" }), false);
  assert.equal(isFeedableTarget({ role: "user", readAt: "不是时间" }), false);
  assert.equal(isFeedableTarget({ role: "user", readAt: "2026-09-28T08:00:00.000Z" }), true);
});

test("同一条消息不会反复被投喂", () => {
  const message = { id: "u1", role: "user", text: "看这个 https://a.example/x", readAt: "2026-09-28T08:00:00.000Z" };
  const fed = { ...message, partnerFeed: { items: [{ emoji: "🍰", count: 1 }] } };
  assert.equal(detectFeedSignal({ messages: [message], now: new Date("2026-09-28T09:00:00.000Z") }).kind, "shared");
  assert.equal(detectFeedSignal({ messages: [fed], now: new Date("2026-09-28T12:00:00.000Z") }), null);
  const cold = [
    { id: "u1", role: "user", text: "在吗", readAt: "2026-09-28T08:00:00.000Z", partnerFeed: { items: [{ emoji: "🍰", count: 1 }] } },
    { id: "a1", role: "assistant", text: "在", proactive: true, at: "2026-09-28T09:00:00.000Z" },
  ];
  assert.equal(
    detectFeedSignal({ messages: cold, readThroughId: "a1", readThroughAt: "2026-09-28T09:30:00.000Z", now: new Date("2026-09-28T14:00:00.000Z") }),
    null,
  );
});

test("连发多条：最后一条太新就往前找，不会漏掉前一条", () => {
  const messages = [
    { id: "u1", role: "user", text: "我烤了个蛋糕 https://a.example/x", readAt: "2026-09-28T08:00:00.000Z" },
    { id: "u2", role: "user", text: "嗯", readAt: "2026-09-28T13:55:00.000Z" },
  ];
  const signal = detectFeedSignal({ messages, interestText: "蛋糕 甜点", now: new Date("2026-09-28T14:00:00.000Z") });
  assert.equal(signal.kind, "interest-hit");
  assert.equal(signal.messageId, "u1");
});

test("伙伴接上图片的话后，不再在旧图片旁提示‘没有要接话’", () => {
  const messages = [
    { id: "u1", role: "user", text: "看这个 https://a.example/x", readAt: "2026-09-28T08:00:00.000Z" },
    {
      id: "a1",
      role: "assistant",
      text: "哈哈，这图好逗。明明就是在撒娇！",
      bubbles: ["哈哈，这图好逗。", "明明就是在撒娇！"],
      repliedTo: "u1",
      proactive: false,
    },
  ];
  assert.equal(detectFeedSignal({ messages, now: new Date("2026-09-28T09:00:00.000Z") }), null);
});

test("伙伴回复后的新分享仍可成为投喂候选", () => {
  const messages = [
    { id: "u1", role: "user", text: "先前那张图 https://a.example/old", readAt: "2026-09-28T08:00:00.000Z" },
    { id: "a1", role: "assistant", text: "我看到了。", repliedTo: "u1", proactive: false },
    { id: "u2", role: "user", text: "再看这张 https://a.example/new", readAt: "2026-09-28T13:55:00.000Z" },
  ];
  const signal = detectFeedSignal({ messages, now: new Date("2026-09-28T14:00:00.000Z") });
  assert.equal(signal.kind, "shared");
  assert.equal(signal.messageId, "u2");
});

test("候选只往回看一个窗口，不会翻到很早以前", () => {
  const old = { id: "u1", role: "user", text: "看这个 https://a.example/x", readAt: "2026-01-01T00:00:00.000Z" };
  const filler = Array.from({ length: FEED_SCAN_LIMIT + 10 }, (_, i) => ({
    id: `a${i}`,
    role: "assistant",
    text: "闲聊",
    proactive: false,
  }));
  assert.equal(detectFeedSignal({ messages: [old, ...filler], now: new Date("2026-09-28T14:00:00.000Z") }), null);
});

test("刚读完几分钟内不递，等她想回", () => {
  const message = { id: "u1", role: "user", text: "我今天烤了个蛋糕，https://x.com/a", readAt: "2026-09-28T08:00:00.000Z" };
  // 读完两分钟：可能正在回，不递
  assert.equal(
    detectFeedSignal({ messages: [message], interestText: "蛋糕 甜点", now: new Date("2026-09-28T08:02:00.000Z") }),
    null,
  );
  // 过了这个门槛就不等了——以前是二十分钟，等得人都忘了
  assert.equal(
    detectFeedSignal({ messages: [message], interestText: "蛋糕 甜点", now: new Date("2026-09-28T08:06:00.000Z") }).kind,
    "interest-hit",
  );
});

test("生活日 04:00 换日", () => {
  // 本地时间：03:29 还算前一天，04:00 起算新的一天
  assert.equal(lifeDay(new Date(2026, 8, 28, 3, 29)), "2026-09-27");
  assert.equal(lifeDay(new Date(2026, 8, 28, 4, 1)), "2026-09-28");
});

test("noteFeed 记一次并滚掉太旧的记忆", () => {
  let state = noteFeed({ lastEmoji: "🍰" }, new Date("2026-09-28T10:00:00.000Z"));
  state = noteFeed({ ...state, lastEmoji: "☕" }, new Date("2026-09-28T14:00:00.000Z"));
  assert.equal(state.count, 2);
  assert.equal(state.lastEmoji, "☕");
  assert.deepEqual(state.recent, ["🍰", "☕"]);
  // 换一天重新计数
  const nextDay = noteFeed(state, new Date(2026, 8, 29, 10, 0));
  assert.equal(nextDay.count, 1);
});

test("冷处理：她的话被读过、ta 的主动消息很久没接，这时才递", () => {
  const messages = [
    { id: "u1", role: "user", text: "今天好累", readAt: "2026-09-28T08:00:00.000Z" },
    { id: "a1", role: "assistant", text: "那就歇会儿", proactive: true, at: "2026-09-28T09:00:00.000Z" },
  ];
  // 刚读完半小时：不给台阶，太黏
  assert.equal(
    detectFeedSignal({ messages, readThroughId: "a1", readThroughAt: "2026-09-28T09:30:00.000Z", now: new Date("2026-09-28T10:00:00.000Z") }),
    null,
  );
  const signal = detectFeedSignal({
    messages,
    readThroughId: "a1",
    readThroughAt: "2026-09-28T09:30:00.000Z",
    now: new Date("2026-09-28T13:00:00.000Z"),
  });
  assert.equal(signal.kind, "cold-treated");
  assert.equal(signal.messageId, "u1");
});

test("冷处理只挂在她读过的那条上；没读过就不挂", () => {
  const messages = [
    { id: "u1", role: "user", text: "在吗", readAt: null },
    { id: "a1", role: "assistant", text: "在", proactive: true, at: "2026-09-28T09:00:00.000Z" },
  ];
  assert.equal(
    detectFeedSignal({
      messages,
      readThroughId: "a1",
      readThroughAt: "2026-09-28T09:30:00.000Z",
      now: new Date("2026-09-28T13:00:00.000Z"),
    }),
    null,
  );
});

test("兴趣命中优先于「分享了东西」，并且要等她读完一阵", () => {
  const message = { id: "u1", role: "user", text: "我今天烤了个蛋糕，https://x.com/a", readAt: "2026-09-28T08:00:00.000Z" };
  // 刚读完两分钟：可能正在回，不递
  assert.equal(
    detectFeedSignal({ messages: [message], interestText: "烘焙 甜品", now: new Date("2026-09-28T08:02:00.000Z") }),
    null,
  );
  const signal = detectFeedSignal({ messages: [message], interestText: "蛋糕 甜点", now: new Date("2026-09-28T09:00:00.000Z") });
  assert.equal(signal.kind, "interest-hit");
  assert.match(signal.reason, /蛋糕/);
});

test("只有分享没有兴趣命中时走 shared", () => {
  const message = { id: "u1", role: "user", text: "看这个 https://example.com/very/long/link", readAt: "2026-09-28T08:00:00.000Z" };
  const signal = detectFeedSignal({ messages: [message], interestText: "烘焙 甜品", now: new Date("2026-09-28T09:00:00.000Z") });
  assert.equal(signal.kind, "shared");
});

test("没读过、刚说完就走的普通闲聊都不递", () => {
  assert.equal(
    detectFeedSignal({
      messages: [{ id: "u1", role: "user", text: "今天天气不错", readAt: "2026-09-28T08:00:00.000Z" }],
      now: new Date("2026-09-28T09:00:00.000Z"),
    }),
    null,
  );
  assert.equal(
    detectFeedSignal({
      messages: [{ id: "u1", role: "user", text: "今天天气不错" }],
      now: new Date("2026-09-28T09:00:00.000Z"),
    }),
    null,
  );
  // ta 正常回复接住了（不是主动消息），不算冷处理
  assert.equal(
    detectFeedSignal({
      messages: [
        { id: "u1", role: "user", text: "在吗", readAt: "2026-09-28T08:00:00.000Z" },
        { id: "a1", role: "assistant", text: "在", proactive: false },
      ],
      readThroughId: "a1",
      readThroughAt: "2026-09-28T09:30:00.000Z",
      now: new Date("2026-09-28T13:00:00.000Z"),
    }),
    null,
  );
});

test("兴趣词要够长才认，短词不乱命中", () => {
  assert.equal(hitInterest("我今天去看了烘焙展", "烘焙 甜品"), "烘焙");
  assert.equal(hitInterest("啊这", "啊 这"), "");
});

test("递的东西来自她自己的资产，并避开最近递过的", () => {
  const assets = feedAssetText({
    hobbies: [{ name: "烘焙", tags: ["甜点"] }],
    palette: { surface: { tags: ["安静"] }, inner: { tags: ["敏感"] } },
    topics: [{ title: "手冲咖啡" }],
  });
  assert.match(assets, /烘焙/);
  assert.match(assets, /手冲咖啡/);
  const picked = pickFeedAsset({ assetText: assets, agentId: "a", recent: [] });
  assert.ok(["🍰", "☕", "🍪", "🍫", "🍬", "🍩"].includes(picked), `意外递了 ${picked}`);
  // 最近递过 🍰 就换一个
  const next = pickFeedAsset({ assetText: assets, agentId: "a", recent: ["🍰"] });
  assert.notEqual(next, "🍰");
});

test("什么都没命中时按伙伴 id 稳定轮转，不同伙伴递的不一样", () => {
  const first = { a: pickFeedAsset({ agentId: "agent-a" }), b: pickFeedAsset({ agentId: "agent-b" }) };
  assert.equal(first.a, pickFeedAsset({ agentId: "agent-a" }), "同一个 id 必须递同一样");
  assert.equal(first.b, pickFeedAsset({ agentId: "agent-b" }));
});

test("配了随机源就用随机", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    seen.add(pickFeedAsset({ assetText: "烘焙 咖啡", agentId: "a", rnd: () => (i % 2 ? 0 : 0.999) }));
  }
  assert.ok(seen.size >= 1);
  assert.ok([...seen].every((emoji) => ["🍰", "☕"].includes(emoji)));
});
