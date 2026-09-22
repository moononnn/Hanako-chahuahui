import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GLOBAL_GATE,
  DEFAULT_QUIET,
  GATE_MAX_CHOICES,
  INTENT_TTL_MS,
  TIER_PLANS,
  decideForm,
  dueNow,
  gateCheck,
  inWindow,
  dailyKey,
  applyProactiveInterval,
  normalizeGateMax,
  noteSent,
  planFor,
  proactiveDelayFactor,
  proactiveSilenceContext,
  quietNow,
  rollIntervalMs,
  scheduleNext,
  stageIntent,
  takeIntent,
  windowStartDate,
  isDirectReplyToProactive,
  isRepeatedPhrasing,
  normalizePhrasing,
  textSimilarity,
  wakeEchoFor,
  recentSceneFor,
  resolveProactivePolicy,
} from "../lib/proactive.js";

const at = (h, m = 0) => new Date(2026, 8, 12, h, m);

test("困着之后醒来只产生一次生活状态回声", () => {
  const now = at(16).getTime();
  const messages = [
    { id: "m_sleep", at: new Date(now - 3 * 60 * 60 * 1000).toISOString(), role: "assistant", text: "我好困，再睡会" },
  ];
  const echo = wakeEchoFor(messages, { now });
  assert.equal(echo.sourceId, "m_sleep");
  assert.equal(wakeEchoFor(messages, { now, consumedId: "m_sleep" }), null);
  assert.equal(wakeEchoFor(messages, { now, maxAgeMs: 60 * 1000 }), null);
  assert.equal(wakeEchoFor([
    ...messages,
    { id: "m_other", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "assistant", text: "我想到一个新话题" },
  ], { now }), null);
  assert.equal(wakeEchoFor([
    ...messages,
    { id: "m_user", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "user", text: "好，你睡吧" },
  ], { now }), null);
  assert.equal(wakeEchoFor([
    ...messages,
    { id: "m_proactive", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "assistant", proactive: true, text: "我来找你了" },
  ], { now }), null);
  assert.equal(wakeEchoFor([
    ...messages,
    { id: "m_action", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "assistant", kind: "action", text: "戳了戳你" },
  ], { now }), null);
});

test("最近场景回声只取主动消息之后完整结束的最后一轮对话", () => {
  const now = at(16).getTime();
  const scene = recentSceneFor([
    { id: "m_old_user", at: new Date(now - 5 * 60 * 60 * 1000).toISOString(), role: "user", text: "旧话题" },
    { id: "m_old_reply", at: new Date(now - 5 * 60 * 60 * 1000 + 1000).toISOString(), role: "assistant", text: "旧回复" },
    { id: "m_proactive", at: new Date(now - 4 * 60 * 60 * 1000).toISOString(), role: "assistant", proactive: true, text: "主动来找你" },
    { id: "m_user", at: new Date(now - 30 * 60 * 1000).toISOString(), role: "user", text: "我刚忙完，脑壳还有点昏" },
    { id: "m_reply", at: new Date(now - 29 * 60 * 1000).toISOString(), role: "assistant", text: "那你先缓一哈，别马上接着忙" },
  ], { now });
  assert.deepEqual(scene, {
    userText: "我刚忙完，脑壳还有点昏",
    assistantText: "那你先缓一哈，别马上接着忙",
    at: new Date(now - 29 * 60 * 1000).toISOString(),
  });
  assert.equal(recentSceneFor([
    { id: "m_user", at: new Date(now - 30 * 60 * 1000).toISOString(), role: "user", text: "我刚忙完" },
    { id: "m_reply", at: new Date(now - 29 * 60 * 1000).toISOString(), role: "assistant", proactive: true, text: "我来找你了" },
  ], { now }), null);
});

test("档位间隔：低的比高的稀", () => {
  assert.ok(TIER_PLANS.rare.minMs > TIER_PLANS.clingy.maxMs);
  assert.equal(planFor("clingy").label, "很黏人");
  assert.equal(planFor("不存在的档位").label, "偶尔聊聊就好");
});

test("关系主动策略：none 阻断，more / baseline / less 只单调调整软间隔", () => {
  const guide = (value, extra = {}) => ({
    id: `g-${value}`,
    meaning: value,
    kind: value === "none" ? "boundary" : "preference",
    scope: "relationship",
    duration: "persistent",
    origin: "explicit",
    status: "active",
    sourceMessageIds: [`m-${value}`],
    claims: [{ target: "proactive.frequency", effect: value === "none" ? "deny" : "prefer", value }],
    createdAt: "2026-09-22T08:00:00.000Z",
    ...extra,
  });
  const more = resolveProactivePolicy({ guides: [guide("more")] });
  const baseline = resolveProactivePolicy();
  const less = resolveProactivePolicy({ guides: [guide("less")] });
  const none = resolveProactivePolicy({ guides: [guide("none")] });
  assert.equal(none.allowed, false);
  assert.ok(applyProactiveInterval(1000, more) < applyProactiveInterval(1000, baseline));
  assert.ok(applyProactiveInterval(1000, baseline) < applyProactiveInterval(1000, less));
});

test("关系 more 不能突破全局日上限和静默时段", () => {
  const policy = { allowed: true, intervalFactor: 0.75 };
  assert.equal(gateCheck({ now: at(12), settings: {}, globalSettings: { globalGate: { maxPerDay: 1 }, quiet: DEFAULT_QUIET }, globalState: { sentToday: { day: dailyKey(at(12)), count: 1 } }, relationalPolicy: policy }).reason, "global-daily-max");
  assert.equal(gateCheck({ now: at(23, 30), settings: {}, globalSettings: { quiet: DEFAULT_QUIET }, relationalPolicy: policy }).reason, "quiet");
});

test("落点在区间内随机，不是固定周期", () => {
  const plan = planFor("clingy");
  assert.equal(rollIntervalMs("clingy", () => 0), plan.minMs);
  assert.equal(rollIntervalMs("clingy", () => 1), plan.maxMs);
  const mid = rollIntervalMs("clingy", () => 0.5);
  assert.ok(mid > plan.minMs && mid < plan.maxMs);
});

test("下一次落点在将来，且带得动", () => {
  const now = at(10);
  const next = scheduleNext(now, "often", () => 0);
  assert.equal(Date.parse(next) - now.getTime(), planFor("often").minMs);
});

test("窗口判断支持跨零点", () => {
  const night = { start: "23:00", end: "08:00" };
  assert.equal(inWindow(at(23, 30), night), true);
  assert.equal(inWindow(at(2), night), true);
  assert.equal(inWindow(at(7, 59), night), true);
  assert.equal(inWindow(at(8), night), false);
  assert.equal(inWindow(at(12), night), false);
  const day = { start: "09:00", end: "18:00" };
  assert.equal(inWindow(at(9), day), true);
  assert.equal(inWindow(at(20), day), false);
  assert.equal(inWindow(at(10), { start: "乱写", end: "08:00" }), false);
});

test("跨零点的静默之夜算作前一天开始的", () => {
  const night = { start: "23:00", end: "08:00" };
  assert.equal(windowStartDate(at(23, 30), night), "2026-09-12");
  assert.equal(windowStartDate(at(3), night), "2026-09-11");
});

test("全局静默和自己的作息，任一生效就算在睡", () => {
  const mine = { start: "01:00", end: "09:00" };
  assert.equal(quietNow(at(2), DEFAULT_QUIET, null).sleeping, true);
  assert.equal(quietNow(at(2), DEFAULT_QUIET, mine).sleeping, true);
  assert.equal(quietNow(at(9, 30), DEFAULT_QUIET, null).sleeping, false);
  // 自己的作息能把ta拖到白天还在睡
  assert.equal(quietNow(at(9, 30), DEFAULT_QUIET, mine).sleeping, false);
  assert.equal(quietNow(at(0, 30), DEFAULT_QUIET, mine).sleeping, true);
});

test("醒着的时候门是开的", () => {
  const result = gateCheck({
    now: at(15),
    settings: { tier: "sometimes", proactiveEnabled: true },
    globalSettings: { quiet: DEFAULT_QUIET, globalGate: DEFAULT_GLOBAL_GATE },
  });
  assert.equal(result.ok, true);
  assert.equal(result.exception, false);
});

test("关掉主动就什么都不发", () => {
  const result = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: false },
    globalSettings: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "turned-off");
});

test("自家日上限到了就停", () => {
  const day = dailyKey(at(15));
  const result = gateCheck({
    now: at(15),
    settings: { tier: "rare", proactiveEnabled: true },
    globalSettings: {},
    state: { sentToday: { day, count: 2 } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tier-daily-max");
});

test("全局日上限到了，所有伙伴都停", () => {
  const day = dailyKey(at(15));
  const result = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: true },
    globalSettings: { globalGate: { minGapMinutes: 1, maxPerDay: 3 } },
    globalState: { sentToday: { day, count: 3 } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-daily-max");
});

test("默认总闸已用 12 条时还能继续，不把旧上限带进来", () => {
  const day = dailyKey(at(15));
  const result = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: true },
    globalSettings: { quiet: { start: "23:00", end: "08:00" }, globalGate: DEFAULT_GLOBAL_GATE },
    globalState: { sentToday: { day, count: 12 } },
  });
  assert.equal(result.ok, true);
});

test("相邻两条至少隔一会儿，别一起扑上来", () => {
  const result = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: true },
    globalSettings: { globalGate: { minGapMinutes: 20, maxPerDay: 99 } },
    globalState: { lastAnySentAt: at(15).toISOString() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-gap");
});

test("睡觉时不主动发消息，醒来才打开主动联系的门", () => {
  const result = gateCheck({
    now: at(2),
    settings: { tier: "sometimes", proactiveEnabled: true },
    globalSettings: { quiet: DEFAULT_QUIET, globalGate: DEFAULT_GLOBAL_GATE },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exception, undefined);
  assert.equal(result.reason, "quiet");
});

test("主动消息后的直接回复沿用醒着的场景", () => {
  assert.equal(isDirectReplyToProactive([
    { role: "user", text: "我去忙啦" },
    { role: "assistant", text: "我想到一个", proactive: true },
  ]), true);
  assert.equal(isDirectReplyToProactive([
    { role: "assistant", text: "我想到一个", proactive: true },
    { role: "user", text: "我回来啦" },
  ]), false);
  assert.equal(isDirectReplyToProactive([
    { role: "assistant", text: "普通回复", proactive: false },
  ]), false);
});

test("由头优先：有话题就带话，没话题才看档位允不允许戳", () => {
  const topic = { id: "t1", title: "化妆苦手" };
  assert.equal(decideForm({ topic, tier: "rare", rnd: () => 0 }).form, "word");
  // 低档不给戳
  assert.equal(decideForm({ topic: null, tier: "rare", rnd: () => 0 }).form, "none");
  assert.equal(decideForm({ topic: null, tier: "sometimes", rnd: () => 0 }).form, "none");
  // 高档才开始允许戳
  assert.equal(decideForm({ topic: null, tier: "clingy", rnd: () => 0 }).form, "poke");
  assert.equal(decideForm({ topic: null, tier: "often", rnd: () => 0.9 }).form, "none");
  assert.equal(decideForm({ topic: null, selfSource: true, tier: "rare", rnd: () => 0 }).form, "word");
  assert.equal(decideForm({ topic: null, selfSource: false, tier: "rare", rnd: () => 0 }).form, "none");
});

test("连续沉默退避倍率逐步增加并封顶", () => {
  assert.equal(proactiveDelayFactor(0), 1);
  assert.equal(proactiveDelayFactor(1), 2);
  assert.equal(proactiveDelayFactor(2), 3);
  assert.equal(proactiveDelayFactor(3), 4);
  assert.equal(proactiveDelayFactor(8), 4);
  assert.equal(proactiveDelayFactor("坏数据"), 1);
});

test("上一条主动消息没被接住时，识别为连续沉默上下文", () => {
  const messages = [
    { role: "user", text: "我去忙啦" },
    { id: "a1", role: "assistant", text: "好嘛", proactive: true, topicId: "topic-1" },
    { id: "a2", role: "assistant", text: "我又想到一个", proactive: true, topicId: "topic-2" },
  ];
  const context = proactiveSilenceContext(messages);
  assert.equal(context.count, 2);
  assert.equal(context.read, false);
  assert.equal(context.previousText, "我又想到一个");
  assert.equal(context.previousTopicId, "topic-2");
});

test("已读未回会被识别出来，供主动层切换成关系反应", () => {
  const messages = [
    { id: "a1", role: "assistant", text: "我来找你玩", proactive: true },
    { id: "a2", role: "assistant", text: "你咋不理我嘛", proactive: true },
  ];
  const context = proactiveSilenceContext(messages, { readThroughId: "a2" });
  assert.equal(context.count, 2);
  assert.equal(context.read, true);
});

test("已读带上「看了多久」：未读没有这个时长，时间读不出来也不编", () => {
  const messages = [
    { id: "a1", role: "assistant", text: "我来找你玩", proactive: true },
    { id: "a2", role: "assistant", text: "你咋不理我嘛", proactive: true },
  ];
  const now = Date.parse("2026-09-19T06:00:00.000Z");
  const seen = proactiveSilenceContext(messages, {
    readThroughId: "a2",
    readThroughAt: "2026-09-19T05:30:00.000Z",
    now,
  });
  assert.equal(seen.read, true);
  assert.equal(seen.readAgeMs, 30 * 60 * 1000, "看了半小时");

  const unseen = proactiveSilenceContext(messages, { readThroughId: null, now });
  assert.equal(unseen.read, false);
  assert.equal(unseen.readAgeMs, null, "没读过的没有时长这回事");

  const brokenClock = proactiveSilenceContext(messages, { readThroughId: "a2", readThroughAt: "坏数据", now });
  assert.equal(brokenClock.read, true);
  assert.equal(brokenClock.readAgeMs, null, "时间读不出来就老实给空");
});

test("用户接话后，主动联系不再误判成沉默追问", () => {
  const messages = [
    { role: "assistant", text: "你忙你的哈", proactive: true },
    { role: "user", text: "我回来啦" },
  ];
  assert.equal(proactiveSilenceContext(messages), null);
});

test("用户点了动作也算接住，不继续判成沉默", () => {
  const messages = [
    { role: "assistant", text: "我来戳你一下", proactive: true },
    { role: "user", kind: "action", text: "戳一戳" },
  ];
  assert.equal(proactiveSilenceContext(messages), null);
});

test("到点才动手", () => {
  assert.equal(dueNow({}, at(10)), true);
  assert.equal(dueNow({ nextDueAt: at(11).toISOString() }, at(10)), false);
  assert.equal(dueNow({ nextDueAt: at(9).toISOString() }, at(10)), true);
});

test("暂存最多留两条，丢最老的", () => {
  let state = { staged: [] };
  for (let i = 0; i < 4; i += 1) {
    state = { staged: stageIntent(state, { topicId: String(i), at: new Date(at(10).getTime() + i).toISOString() }, at(10)) };
  }
  assert.equal(state.staged.length, 2);
  assert.equal(state.staged[0].topicId, "2");
});

test("过期的暂存自动作废", () => {
  const old = { staged: [{ topicId: "x", at: new Date(at(10).getTime() - INTENT_TTL_MS - 1000).toISOString() }] };
  const { intent } = takeIntent(old, at(10));
  assert.equal(intent, null);
});

test("暂存里最老的那个先兑现", () => {
  const state = {
    staged: [
      { topicId: "旧", at: at(9).toISOString() },
      { topicId: "新", at: at(10).toISOString() },
    ],
  };
  const { intent, rest } = takeIntent(state, at(11));
  assert.equal(intent.topicId, "旧");
  assert.equal(rest.length, 1);
});

test("送出后两边都记一笔，破例也记", () => {
  const r = noteSent(
    { state: { sentToday: { day: "2026-09-11", count: 5 } }, globalState: {}, now: at(2) },
    { exception: true },
  );
  assert.equal(r.state.sentToday.day, "2026-09-12");
  assert.equal(r.state.sentToday.count, 1);
  assert.equal(r.state.exceptionCount, 1);
  assert.equal(r.globalState.lastAnySentAt, at(2).toISOString());
});

test("同一天第二次送出是累加", () => {
  const day = dailyKey(at(15));
  const r = noteSent({ state: { sentToday: { day, count: 2 } }, globalState: {}, now: at(15) });
  assert.equal(r.state.sentToday.count, 3);
});

test("日上限放宽为三档，默认不飘在档位外", () => {
  assert.deepEqual(GATE_MAX_CHOICES, [12, 24, 30]);
  assert.ok(GATE_MAX_CHOICES.includes(DEFAULT_GLOBAL_GATE.maxPerDay));
});

test("老档位归一到最近的档", () => {
  assert.equal(normalizeGateMax(12), 12);
  assert.equal(normalizeGateMax(24), 24);
  assert.equal(normalizeGateMax(30), 30);
  // 20 是上一版「热闹一点」的值，迁到新的 24 条档
  assert.equal(normalizeGateMax(20), 24);
  assert.equal(normalizeGateMax(2), 12);
  assert.equal(normalizeGateMax(undefined), DEFAULT_GLOBAL_GATE.maxPerDay);
  assert.equal(normalizeGateMax(null), DEFAULT_GLOBAL_GATE.maxPerDay);
  assert.equal(normalizeGateMax("不是数"), DEFAULT_GLOBAL_GATE.maxPerDay);
});

test("放宽后的总量不再低于很黏伙伴的一小时节奏上限", () => {
  // 醒着按 08:00~23:00 算 15 小时，一小时一条最多 15 条；
  // 新默认总量不应比这个基础节奏还低。
  const max = normalizeGateMax(20);
  assert.ok(max >= 15);
});

// ── 说法去重（车轱辘话兑底，2026-09-15）──

test("归一：标点空白和大小写不算差别", () => {
  assert.equal(normalizePhrasing(" 在忙吗？ "), "在忙吗");
  assert.equal(normalizePhrasing("A，B。C！"), "abc");
});

test("相似度：一样的是 1，不相干的是 0，改几个字介于中间", () => {
  assert.equal(textSimilarity("在忙什么呢", "在忙什么呢"), 1);
  assert.equal(textSimilarity("在忙什么呢", ""), 0);
  assert.ok(textSimilarity("今天天气真好", "我昨天吃了拉面") < 0.2);
  const near = textSimilarity("在忙什么呢，吃饭了没", "在忙什么呢，吃了饭没");
  assert.ok(near > 0.6 && near < 1);
});

test("车轱辘话：同一句换个说法也算重复", () => {
  const history = [{ at: Date.now() - 60 * 1000, text: "在忙什么呢，记得吃点东西" }];
  assert.equal(isRepeatedPhrasing(history, "在忙什么呢，记得吃东西").repeated, true);
  // 新的一件事就放行
  assert.equal(isRepeatedPhrasing(history, "我突然想到你那个插件的图标可以换换").repeated, false);
});

test("车轱辘话：过了窗口的老话不再算", () => {
  const now = Date.now();
  const history = [{ at: now - 7 * 3600 * 1000, text: "在忙什么呢，记得吃点东西" }];
  assert.equal(isRepeatedPhrasing(history, "在忙什么呢，记得吃点东西", { now }).repeated, false);
  // 时间戳认不了的不参与比对，不回退成“刚开始聊天就叫重复”
  assert.equal(isRepeatedPhrasing([{ at: "不是时间", text: "在忙什么呢" }], "在忙什么呢").repeated, false);
});

test("车轱辘话：空话不比、没有历史不拦", () => {
  assert.equal(isRepeatedPhrasing([], "在忙吗").repeated, false);
  assert.equal(isRepeatedPhrasing([{ at: Date.now(), text: "在忙吗" }], "   ").repeated, false);
  assert.equal(isRepeatedPhrasing(null, "在忙吗").repeated, false);
  assert.equal(isRepeatedPhrasing([{ at: Date.now(), text: "在忙吗" }], "在忙吗").score, 1);
});
