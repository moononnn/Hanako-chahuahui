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
  hasUnseenUserMessage,
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
  inFarewellWindow,
  shouldSendFarewell,
  stirredUp,
  morningOpening,
  FAREWELL_LEAD_MINUTES,
  ANCHOR_USER_RECENT_MS,
  proactiveAnchor,
  lastUserVoiceAt,
  askBudgetSpent,
} from "../lib/proactive.js";

const at = (h, m = 0) => new Date(2026, 8, 12, h, m);

test("锚点门：她完全没动静时，内容型开口先压住", () => {
  const now = at(16).getTime();
  // 没有待办、没有刚聊过的一轮、她几小时没说话、电脑那边也静着
  assert.deepEqual(proactiveAnchor({ now }), { ok: false, kind: null });
  assert.equal(proactiveAnchor({ todoNudge: "三点给薄荷浇水", now }).kind, "todo");
  assert.equal(proactiveAnchor({ wakeEcho: { sourceText: "我再眯一会" }, now }).kind, "wake");
  assert.equal(proactiveAnchor({ sceneEcho: { userText: "在的", assistantText: "嗯" }, now }).kind, "scene");
  assert.equal(proactiveAnchor({ workActive: true, now }).kind, "workfeed");
  const fresh = now - ANCHOR_USER_RECENT_MS + 60 * 1000;
  assert.equal(proactiveAnchor({ lastUserAt: fresh, now }).kind, "recent-user");
  const stale = now - ANCHOR_USER_RECENT_MS - 60 * 1000;
  assert.equal(proactiveAnchor({ lastUserAt: stale, now }).ok, false);
  // 她刚发的消息优先于电脑那边的动静：来处越近越先说
  assert.equal(proactiveAnchor({ lastUserAt: fresh, workActive: true, now }).kind, "recent-user");
});

test("她最后一句真话的时间：号令行和摸一摸不算", () => {
  const now = at(16).getTime();
  const rows = [
    { role: "user", text: "浇完啦", at: at(15).toISOString() },
    { role: "assistant", text: "要得", at: at(15, 5).toISOString() },
    { role: "user", text: "小林戳了戳你的键盘", kind: "action", at: at(15, 30).toISOString() },
    { role: "assistant", text: "小花戳了戳你的肚皮", at: at(15, 40).toISOString() },
  ];
  assert.equal(lastUserVoiceAt(rows), at(15).getTime());
  assert.equal(lastUserVoiceAt([{ role: "assistant", text: "嗯", at: at(15).toISOString() }]), null);
  assert.equal(lastUserVoiceAt([]), null);
  // 撤回的那句不算说过话
  assert.equal(lastUserVoiceAt([{ role: "user", text: "算了", recalled: true, at: at(14).toISOString() }]), null);
  void now;
});

test("问句额度：连着问了几条，下一条就别再问", () => {
  const ask = (text) => /[?？]/u.test(text);
  assert.equal(askBudgetSpent(["问一个？", "又问？", "还说"], { isAsk: ask }), true);
  assert.equal(askBudgetSpent(["问一个？", "这句没问", "还说"], { isAsk: ask }), false);
  assert.equal(askBudgetSpent(["只有一条？"], { isAsk: ask }), false);
  assert.equal(askBudgetSpent([], { isAsk: ask }), false);
});

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
  assert.equal(wakeEchoFor([
    { id: "m_opening", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "assistant", kind: "tavern-opening", text: "我好困，再睡会" },
  ], { now }), null);
  assert.equal(wakeEchoFor([
    ...messages,
    { id: "m_opening", at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), role: "assistant", kind: "tavern-opening", text: "我好困，再睡会" },
  ], { now }), null, "初见问候形成场景边界，不能反向捡更早的回声素材");
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
  assert.equal(recentSceneFor([
    { id: "m_old_user", at: new Date(now - 30 * 60 * 1000).toISOString(), role: "user", text: "真实旧话题" },
    { id: "m_old_reply", at: new Date(now - 29 * 60 * 1000).toISOString(), role: "assistant", text: "真实旧回复" },
    { id: "m_opening", at: new Date(now - 20 * 60 * 1000).toISOString(), role: "assistant", kind: "tavern-opening", text: "伪装的场景提示" },
  ], { now }), null, "酒馆初见问候不能充当场景回复，也不能让选材越过它回捡旧对话");
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

test("全局总闸关着时，谁都发不出来，排在自家开关之后之外也拦得住", () => {
  const closed = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: true },
    globalSettings: { rhythmProactiveEnabled: false, quiet: DEFAULT_QUIET },
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "global-off");

  const opened = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: true },
    globalSettings: { rhythmProactiveEnabled: true, quiet: DEFAULT_QUIET },
  });
  assert.equal(opened.ok, true);

  // 单关一位伙伴仍然照旧生效，不被全局闸改写
  const oneOff = gateCheck({
    now: at(15),
    settings: { tier: "clingy", proactiveEnabled: false },
    globalSettings: { rhythmProactiveEnabled: true },
  });
  assert.equal(oneOff.reason, "turned-off");
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

test("她的话还没被看到时，主动开场要让路", () => {
  assert.equal(hasUnseenUserMessage([
    { role: "assistant", text: "在呢" },
    { role: "user", text: "我去泡个面" },
  ]), true, "末尾挂着她没被看到的话");
  assert.equal(hasUnseenUserMessage([
    { role: "assistant", repliedTo: "u1" },
    { role: "user", id: "u1", text: "来了主人~", readAt: null, unreadResetAt: "2026-10-01T01:29:17.174Z" },
    { role: "assistant", kind: "poke" },
  ]), true, "删掉回复退回未读后，夹着一条戳也算");
});

test("看过了、或者这轮已经接过了，就不挡主动开场", () => {
  assert.equal(hasUnseenUserMessage([
    { role: "user", text: "在吗", readAt: "2026-10-01T00:00:00.000Z" },
  ]), false, "她的话已经被看到过");
  assert.equal(hasUnseenUserMessage([
    { role: "user", text: "在吗" },
    { role: "assistant", text: "在" },
  ]), false, "ta 已经接过了");
  assert.equal(hasUnseenUserMessage([{ role: "user", text: "在吗", kind: "poke" }]), false, "只有动作不算说过话");
  assert.equal(hasUnseenUserMessage([{ role: "user", text: "在吗", recalled: true }]), false, "撤回的话不再等回音");
  assert.equal(hasUnseenUserMessage([]), false);
  assert.equal(hasUnseenUserMessage(null), false);
});

// ── 睡前收尾与「晚安之后又被薅起来」（2026-10-05）────────────────

test("睡前收尾只落在睡点前那一小段，同一晚只算一次", () => {
  const sleep = [{ kind: "main", start: "23:30" }];
  assert.equal(FAREWELL_LEAD_MINUTES, 20);
  assert.equal(inFarewellWindow(at(22, 40), sleep).due, false, "离睡点还早，不是收尾的时候");
  const due = inFarewellWindow(at(23, 15), sleep);
  assert.equal(due.due, true);
  assert.equal(due.start, "23:30");
  assert.equal(due.reason, "sleep");
  const night = due.night;
  assert.equal(shouldSendFarewell({}, night), true);
  assert.equal(shouldSendFarewell({ farewellNight: night }, night), false, "今晚已经说过了");
  assert.equal(shouldSendFarewell({ farewellFailNight: night, farewellFailCount: 2 }, night), true, "生成失败还能再试一次");
  assert.equal(shouldSendFarewell({ farewellFailNight: night, farewellFailCount: 3 }, night), false, "试够就别整晚反复叫模型");
  assert.equal(inFarewellWindow(at(23, 15), null).due, false, "没定过作息就不强行收尾");
});

test("安静时段比睡点更早时，收尾要赶在门关之前", () => {
  const sleep = [{ kind: "main", start: "02:00" }];
  const plan = inFarewellWindow(at(22, 50), sleep, { extraAnchor: "23:00" });
  assert.equal(plan.due, true, "睡点在凌晨两点，但安静时间二十三时就关门了");
  assert.equal(plan.reason, "quiet");
  assert.equal(plan.start, "23:00");
  assert.equal(inFarewellWindow(at(21, 30), sleep, { extraAnchor: "23:00" }).due, false);
});

test("晚安之后她又在电脑那边开干，才算把人薅起来", () => {
  const now = at(23, 50);
  const said = at(23, 20).toISOString();
  const base = { farewellNight: "2026-09-12", farewellAt: said };
  const after = at(23, 45).toISOString();
  assert.equal(stirredUp({ state: base, night: "2026-09-12", workAt: after, farewellAt: said, now }), true);
  assert.equal(stirredUp({ state: base, night: "2026-09-12", workAt: at(23, 10).toISOString(), farewellAt: said, now }), false, "说晚安之前就在忙的不算");
  assert.equal(stirredUp({ state: { ...base, stirNight: "2026-09-12", stirCount: 1 }, night: "2026-09-12", workAt: after, farewellAt: said, now }), false, "一晚最多闹一次");
  assert.equal(stirredUp({ state: base, night: "2026-09-11", workAt: after, farewellAt: said, now }), true, "新的夜重新算");
  assert.equal(stirredUp({ state: base, night: null, workAt: after, farewellAt: said, now }), false, "没说过晚安就无从谈起");
  assert.equal(stirredUp({ state: {}, night: "2026-09-12", workAt: after, farewellAt: null, now }), false);
});

test("晨间第一句给的是把握，不是打卡", () => {
  assert.equal(morningOpening({ tier: "clingy", rnd: () => 0.1 }), true);
  assert.equal(morningOpening({ tier: "rare", rnd: () => 0.99 }), false);
  assert.equal(morningOpening({ tier: "rare", workActive: true, rnd: () => 0.4 }), true, "清早她已经在电脑那边忙，把握更大");
  assert.equal(TIER_PLANS.rare.morningChance < TIER_PLANS.clingy.morningChance, true, "越黏人的越容易先开个口");
});

test("说过晚安又被薅起来：只放睡眠这一道门，其余照管", () => {
  const now = at(23, 50);
  const settings = { tier: "often", sleep: [{ kind: "main", start: "23:00" }] };
  const globalSettings = { rhythmProactiveEnabled: true, quiet: DEFAULT_QUIET, globalGate: DEFAULT_GLOBAL_GATE };
  const state = { sentToday: { day: dailyKey(now), count: 2 } };
  const blocked = gateCheck({ now, settings, globalSettings, state, globalState: {} });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "quiet", "平常时候睡着就是睡着");
  assert.equal(gateCheck({ now, settings, globalSettings, state, globalState: {}, ignoreSleep: true }).ok, true, "那一条本来就在睡着之后");
  const maxed = { sentToday: { day: dailyKey(now), count: TIER_PLANS.often.dailyMax } };
  assert.equal(gateCheck({ now, settings, globalSettings, state: maxed, globalState: {}, ignoreSleep: true }).reason, "tier-daily-max", "日上限还是拦得住");
});
