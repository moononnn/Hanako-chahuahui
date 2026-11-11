import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";
import { proactiveSpec, isStickerOnlyReply } from "../lib/compose.js";
import { threadToMessages } from "../lib/prompt.js";
import {
  CONVERSATION_BUFFER_MINUTES,
  TIER_PLANS,
  conversationBuffer,
  lastConversationEndAt,
  planFor,
  proactiveContextFor,
  proactiveSilenceContext,
} from "../lib/proactive.js";
import { readStickerUsage } from "../lib/sticker-usage.js";
import { __clearCatalogCache } from "../lib/stickers.js";

// 有一批用例靠内测路由 /proactive/tick 驱动主动联系；发布副本剥掉哨兵后那条路由不存在。
const SKIP_DEV = /const DEV_TOOLS = true;/.test(
  fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"),
) ? false : "公开发布版不含内测巡检路由";

const INDEX_SOURCE = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const AGENT = "nova";
const HOUR = 3600_000;
const MINUTE = 60_000;

const clockAt = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const pad = (n) => String(n).padStart(2, "0");

/** 把静默窗和作息窗都推到离现在很远的地方，避免用例跑在半夜或凌晨时误判。 */
function farWindows(now) {
  const base = new Date(now.getTime() + 7 * HOUR);
  const start = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
  const end = `${pad((base.getHours() + 1) % 24)}:${pad(base.getMinutes())}`;
  return {
    quiet: { start, end },
    sleep: { shape: 2, start, hours: 7, nap: { start: end, minutes: 20 } },
  };
}

/**
 * 默认世界：熟悉、开着主动、有种子（出站那一步才走「word」而不是戳一下/跳过），
 * 公共事件关掉——它本来就抢在普通主动前面开口，与这一组要验的东西无关。
 */
function seedWorld(store, { tier = "often" } = {}) {
  const windows = farWindows(new Date());
  store.setGlobalSettings({ rhythmProactiveEnabled: true, quiet: windows.quiet, publicEventsEnabled: false });
  store.setPartnerSettings(AGENT, {
    proactiveEnabled: true,
    tier,
    model: { provider: "test-provider", model: "test-model" },
    hobbySeedTryAt: clockAt(0),
    sleep: windows.sleep,
    voice: { enabled: false },
  });
  const knowing = store.getKnowing(AGENT);
  store.saveKnowing(AGENT, {
    ...knowing,
    relationship: {
      ...knowing.relationship,
      familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 },
      intimacy: { ...knowing.relationship.intimacy, score: 18 },
    },
    personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } },
  });
  store.setProactiveState(AGENT, {
    nextDueAt: clockAt(-HOUR),
    lastSentAt: clockAt(-0.2 * HOUR),
    interestLearning: { curiosity: { startedAt: clockAt(0), thresholdMs: 7 * 24 * HOUR } },
    topicSeeds: {
      lastGrowAt: clockAt(0),
      seeds: [{
        id: "seed_chain_1", motifId: "m1", motifName: "旧物", kind: "curio",
        hook: "那盏旧台灯", angle: "还没想明白它到底该放哪",
        createdAt: clockAt(-HOUR), expiresAt: clockAt(3 * 24 * HOUR), usedAt: null,
      }],
    },
    newsBook: { lastFetchAt: clockAt(0), lastDomainId: "", items: [], history: [] },
  });
  return windows;
}

const CLARITY_MARKER = "检查一条准备发出的普通私聊主动消息";

/** 主动生成走后台 utility 通道，换成一个可控正文。语义核查固定回 send。 */
function stubUtility(app, text) {
  const calls = [];
  app.ctx.models.utility = async (request = {}) => {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const prompt = messages.map((row) => String(row?.content ?? "")).join("\n");
    const clarity = String(request.systemPrompt ?? "").includes(CLARITY_MARKER);
    calls.push({ clarity, prompt });
    return { requestId: "utility_chain", text: clarity ? '{"decision":"send"}' : text };
  };
  return calls;
}

/** 整轮跑完才恢复 Math.random：后台活也在这一轮里，跑一半换回去会串样本。 */
async function withRandom(value, run) {
  const real = Math.random;
  Math.random = () => value;
  try {
    return await run();
  } finally {
    Math.random = real;
  }
}

const lastProactive = (messages) => [...messages].reverse().find((row) => row.proactive === true) ?? null;
const cleanupOn = (t, app) => t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
/** 同一条 utility 通道还跑着养护类的后台活，用主动开口那句话认出真正那一次生成。 */
const isProactiveGeneration = (row) => !row.clarity && /你要主动去找/.test(String(row.prompt ?? ""));

/** 表情包快照：读得到才有图可发，读不到就是「这次没有表情包」。 */
function stickerIndex() {
  return {
    schemaVersion: 1,
    stickers: [{
      id: "stk_wuyu", file: "stickers/wuyu.png",
      emotion: ["无语"], scene: ["聊天"], keywords: ["无语"], description: "一张无语的脸",
    }],
    partners: {},
  };
}

function stickerResources(index = stickerIndex()) {
  return {
    read: async (target) => {
      const file = String(target?.path ?? "").replace(/\\/g, "/");
      if (file.endsWith("app-data/biaoqingbao-app/public-index.json")) return { content: JSON.stringify(index) };
      return null;
    },
    list: async () => [],
  };
}

// ── 纯函数：整串未回应成为语境 ──────────────────────────────────

test("未回应的一条链整串都进语境，按时间顺序，最多留四条", () => {
  const messages = [
    { role: "user", text: "我去忙啦", at: clockAt(-5 * HOUR) },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`, role: "assistant", proactive: true, text: `第${i + 1}条`, at: clockAt((-4 + i * 0.2) * HOUR),
    })),
  ];
  const context = proactiveSilenceContext(messages);
  assert.equal(context.count, 6);
  assert.deepEqual(context.previousTexts, ["第3条", "第4条", "第5条", "第6条"], "整串按时间顺序，只留最近四条");
  assert.equal(context.previousText, "第6条", "「上一条原文」照旧是最后那条");
});

test("只发了表情包的那条在语境里写成一张图，不摆成「[表情]」字面量", () => {
  const context = proactiveSilenceContext([
    { role: "user", text: "今天好困", at: clockAt(-3 * HOUR) },
    { id: "a1", role: "assistant", proactive: true, text: "那你去眯一会儿", at: clockAt(-2 * HOUR) },
    {
      id: "a2", role: "assistant", proactive: true, text: "[表情]",
      bubbles: ["\u0001stk:stk_wuyu"], at: clockAt(-1 * HOUR),
    },
  ]);
  assert.deepEqual(context.previousTexts, ["那你去眯一会儿", "（只发了一张表情包）"]);
});

test("整串原文单条压到限长，不把一整段小作文塞进语境", () => {
  const context = proactiveSilenceContext([
    { id: "a1", role: "assistant", proactive: true, text: "甲".repeat(500), at: clockAt(-HOUR) },
  ]);
  assert.equal(context.previousTexts.length, 1);
  assert.ok(context.previousTexts[0].length <= 160);
});

test("落账的跟进来由带上整串原文，老的 previousText 照旧保留", () => {
  const context = proactiveContextFor({
    kind: "proactive",
    followup: { read: false, previousText: "搬完了，手上全是土", previousTexts: ["今晚得把窗台那盆搬进来", "搬完了，手上全是土"] },
  });
  assert.equal(context.kind, "unread-followup");
  assert.equal(context.previousText, "搬完了，手上全是土");
  assert.deepEqual(context.previousTexts, ["今晚得把窗台那盆搬进来", "搬完了，手上全是土"]);

  const single = proactiveContextFor({ kind: "proactive", followup: { read: false, previousText: "只有一条" } });
  assert.equal(single.previousTexts, undefined, "没有整串就不凭空造一份");
});

test("历史里的主动消息说明「这几条是一串」，只发图的那条标明是图", () => {
  const rows = threadToMessages([
    {
      role: "assistant", proactive: true, text: "搬完了，手上全是土",
      proactiveContext: {
        kind: "unread-followup", previousText: "今晚得把窗台那盆搬进来",
        previousTexts: ["今晚得把窗台那盆搬进来", "搬完了，手上全是土"],
      },
    },
    {
      role: "assistant", proactive: true, text: "[表情]",
      bubbles: ["\u0001stk:stk_wuyu"],
      proactiveContext: { kind: "unread-followup", previousText: "搬完了，手上全是土" },
    },
  ]);
  assert.match(rows[0].content[0].text, /前面连着 2 条主动消息她都没接/, "整串被标成一段话");
  assert.match(rows[0].content[0].text, /同一段话往下说的/);
  assert.match(rows[1].content[0].text, /只有一张表情包，没有文字/);
  assert.doesNotMatch(rows[1].content[0].text, /\[表情\]/, "字面量不留给模型当话读");
});

test("未回应时提示词给的是整串语境：可以接着往下说、偶尔柔和催、也能只发一张图", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    currentTimeText: "2026年11月2日，晚上 8 点",
    followup: {
      count: 2,
      read: false,
      previousText: "搬完了，手上全是土",
      previousTexts: ["今晚得把窗台那盆搬进来", "搬完了，手上全是土"],
    },
  });
  assert.match(spec.userText, /今晚得把窗台那盆搬进来/, "第一条原文也在");
  assert.match(spec.userText, /搬完了，手上全是土/, "最后一条原文也在");
  assert.match(spec.userText, /这一串是同一段话往下说的/);
  assert.match(spec.userText, /接着你自己最后停下的地方往下说/);
  assert.match(spec.userText, /柔和一点的催只能落在你自己身上/, "允许柔和催，但不往她身上放");
  assert.match(spec.userText, /你怎么还不回|是不是不想理我/, "红线写明不许说的话");
  assert.match(spec.userText, /一张合适的表情本身就是一句完整的接话/);
  assert.match(spec.userText, /别为了显得有进展临时造一个新话题/, "不硬造话题");
});

test("到点待办在场时，不把整串语境摆进来抢位置", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    todoNudge: "她今天这件到了时间还没做：给薄荷浇水。",
    followup: { count: 2, read: false, previousText: "搬完了", previousTexts: ["搬完了", "手上全是土"] },
  });
  assert.match(spec.userText, /给薄荷浇水/);
  assert.doesNotMatch(spec.userText, /这一串是同一段话往下说的/);
  assert.doesNotMatch(spec.userText, /你这串主动消息的原文/);
});

test("表情比文字轻这一层进提示词，但同时写明共用同一份打扰配额", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    stickerText: "【表情包】\n你手机上有一堆自己的表情包。",
  });
  assert.match(spec.userText, /一张图比一段话轻/);
  assert.match(spec.userText, /单独一张合适的图就能当一条消息/);
  assert.match(spec.userText, /同一份打扰配额/);
});

test("没有图库时不谈表情包，也就没有这层放行", () => {
  const spec = proactiveSpec({ partnerName: "小花", userName: "阿舟", stickerText: "" });
  assert.doesNotMatch(spec.userText, /一张图比一段话轻/);
});

// ── 纯表情的豁免边界（2026-11-02 审查）────────────────────────
//
// 反例就在眼前：只要模型带了一个标记，空洞搭话和抽象总结就都能绕过去。
// 豁免只给「真的没有正文」的那一种。

test("纯表情才免检：有正文就得照旧过内容关", () => {
  assert.equal(isStickerOnlyReply({ keyword: "无语", text: "" }), true);
  assert.equal(isStickerOnlyReply({ keyword: "无语", text: "   " }), true);
  assert.equal(isStickerOnlyReply({ keyword: "无语", text: "在吗" }), false, "写了字就不算纯表情");
  assert.equal(isStickerOnlyReply({ keyword: "", text: "无语" }), false, "没有标记也不算");
  assert.equal(isStickerOnlyReply({}), false);
});

test("正文内容关只允许纯表情或有效纯照片绕过，有正文的配图不免检", () => {
  const start = INDEX_SOURCE.indexOf("isLowSignalProactive(text, { reason: sendReason })");
  assert.notEqual(start, -1, "低信号那一关还在");
  const abstractAt = INDEX_SOURCE.indexOf("if (!stickerOnlyReply && !imageOnlyReply && isAbstractOnlyProactive", start);
  assert.ok(abstractAt > start, "抽象总结那一关也得走同一个豁免");
  const window = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("const stickerOnlyReply"), abstractAt + 80);
  assert.match(INDEX_SOURCE, /const imageOnlyReply = Boolean\(chatPhoto\.request\) && !text && !marker\.keyword/);
  assert.match(window, /const stickerOnlyReply = isStickerOnlyReply\(\{ keyword: marker\.keyword, text \}\)/);
  assert.match(window, /if \(!stickerOnlyReply && !imageOnlyReply && isLowSignalProactive\(/);
  assert.match(window, /if \(!stickerOnlyReply && !imageOnlyReply && isAbstractOnlyProactive\(/);
  assert.doesNotMatch(INDEX_SOURCE, /!marker\.keyword && is(?:LowSignal|AbstractOnly)Proactive/, "不再拿标记当通行证");
});

// ── 纯函数：自然对话刚结束的缓冲 ────────────────────────────────

test("缓冲按档位排开：关系越轻，聊完等得越久", () => {
  const ladder = ["clingy", "often", "sometimes", "rare"].map((tier) => CONVERSATION_BUFFER_MINUTES[tier]);
  assert.deepEqual(ladder, [15, 30, 60, 90]);
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ladder[i] > ladder[i - 1]);
});

test("缓冲用的就是真正的档位字段：键与档位表一致，认不出来的跟排点回同一档", () => {
  assert.deepEqual(Object.keys(CONVERSATION_BUFFER_MINUTES).sort(), Object.keys(TIER_PLANS).sort(), "两处档位键必须一份");
  const fallback = planFor("tier-那条不存在的");
  assert.equal(fallback, TIER_PLANS.sometimes);
  const rows = [{ role: "assistant", text: "好", at: clockAt(-5 * MINUTE) }];
  assert.equal(conversationBuffer({ tier: "tier-那条不存在的", messages: rows, now: Date.now() }).minutes, CONVERSATION_BUFFER_MINUTES.sometimes, "不认识的档位跟排点一样落回 sometimes");
  assert.equal(conversationBuffer({ tier: undefined, messages: rows, now: Date.now() }).minutes, CONVERSATION_BUFFER_MINUTES.sometimes);
});

test("刚聊完就在缓冲里，到点就放行", () => {
  const endedAt = Date.parse(clockAt(-10 * MINUTE));
  const rows = [
    { role: "user", text: "我先去吃饭啦", at: new Date(endedAt - MINUTE).toISOString() },
    { role: "assistant", text: "去吧去吧", at: new Date(endedAt).toISOString() },
  ];
  const inside = conversationBuffer({ tier: "often", messages: rows, now: Date.now() });
  assert.equal(inside.active, true);
  assert.equal(inside.minutes, 30);
  assert.equal(inside.untilAt, new Date(endedAt + 30 * MINUTE).toISOString(), "缓冲从对话结束那一刻起算");

  const passed = conversationBuffer({ tier: "often", messages: rows, now: endedAt + 31 * MINUTE });
  assert.equal(passed.active, false);
});

test("动作、戳、酒馆开场都不是对话结尾；太早结束的对话也不算刚聊完", () => {
  const rows = [
    { role: "assistant", text: "知道了", at: clockAt(-20 * MINUTE) },
    { role: "assistant", kind: "action", text: "[戳]", at: clockAt(-MINUTE) },
    { role: "assistant", kind: "poke", text: "戳一下", at: clockAt(-MINUTE) },
    { role: "assistant", kind: "tavern-opening", text: "初次见面的问候", at: clockAt(-MINUTE) },
  ];
  assert.equal(conversationBuffer({ tier: "often", messages: rows, now: Date.now() }).active, true, "只看到那句真话");

  const old = [{ role: "assistant", text: "知道了", at: clockAt(-7 * HOUR) }];
  assert.equal(conversationBuffer({ tier: "often", messages: old, now: Date.now() }).active, false, "七小时前的对话不挡");
});

test("末尾已经是主动那串时不排队：那是没被接住，不是刚聊完", () => {
  const rows = [
    { role: "user", text: "忙完啦", at: clockAt(-30 * MINUTE) },
    { role: "assistant", text: "我在", at: clockAt(-20 * MINUTE) },
    { role: "assistant", proactive: true, text: "窗台那盆搬进来了", at: clockAt(-10 * MINUTE) },
  ];
  assert.equal(lastConversationEndAt(rows), null);
  assert.equal(conversationBuffer({ tier: "often", messages: rows, now: Date.now() }).active, false);
});

// ── 走真路由的行为验证 ──────────────────────────────────────────

test("行为：连着两条没被接住，这一条拿到整串语境并把它落进账本", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed: (store) => seedWorld(store) });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: clockAt(0), at: clockAt(-4 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", proactive: true, text: "今晚得把窗台那盆搬进来", at: clockAt(-3 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", proactive: true, text: "搬完了，手上全是土", at: clockAt(-2 * HOUR) });
  const calls = stubUtility(app, "土还没洗干净，等会儿跟你说");

  await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "这一轮真的发出去一条");
  const generation = calls.find(isProactiveGeneration);
  assert.ok(generation, "确实调了一次生成");
  assert.match(generation.prompt, /今晚得把窗台那盆搬进来/, "整串第一条进了生成语境");
  assert.match(generation.prompt, /搬完了，手上全是土/, "整串最后一条也进了生成语境");
  assert.match(generation.prompt, /接着你自己最后停下的地方往下说/);

  const stored = reopenThread(app.dataDir, AGENT).at(-1);
  assert.equal(stored.proactiveContext.kind, "unread-followup");
  assert.deepEqual(stored.proactiveContext.previousTexts, ["今晚得把窗台那盆搬进来", "搬完了，手上全是土"], "整串真的落到账本上");
});

test("行为：自然对话刚结束，普通主动先等着，落点挪到缓冲结束", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed: (store) => seedWorld(store) });
  cleanupOn(t, app);
  const store = app.store;
  const endedAt = Date.now() - 8 * MINUTE;
  store.appendMessage(AGENT, { role: "user", text: "我刚吃完", readAt: clockAt(0), at: new Date(endedAt - MINUTE).toISOString() });
  store.appendMessage(AGENT, { role: "assistant", text: "吃啥了", at: new Date(endedAt).toISOString() });
  const calls = stubUtility(app, "顺手把窗台擦了一遍");

  const response = await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));
  assert.equal(response.status, 200);

  assert.equal(lastProactive(store.getThread(AGENT).messages), null, "刚聊完不贴着再开口");
  assert.equal(calls.filter(isProactiveGeneration).length, 0, "连生成都没叫");
  const state = createStore(app.dataDir).getProactiveState(AGENT);
  assert.equal(state.nextDueAt, new Date(endedAt + 30 * MINUTE).toISOString(), "落点挪到缓冲结束那一刻");
  assert.ok(Array.isArray(response.body.result?.report), "巡检回报里有这一轮的动作");
  assert.ok(response.body.result.report.some((row) => row.action === "buffered"), "回报写明被缓冲，不是静默跳过");
});

test("行为：档位轻的那位等得更久，黏人的回来得快", { skip: SKIP_DEV }, async (t) => {
  for (const [tier, minutes] of [["rare", 90], ["clingy", 15]]) {
    const app = await bootChahuahui({ seed: (store) => seedWorld(store, { tier }) });
    cleanupOn(t, app);
    const endedAt = Date.now() - 10 * MINUTE;
    app.store.appendMessage(AGENT, { role: "user", text: "我先忙会儿", readAt: clockAt(0), at: new Date(endedAt - MINUTE).toISOString() });
    app.store.appendMessage(AGENT, { role: "assistant", text: "好", at: new Date(endedAt).toISOString() });
    stubUtility(app, "顺手把窗台擦了一遍");

    await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

    assert.equal(lastProactive(app.store.getThread(AGENT).messages), null, `${tier}：还在缓冲里`);
    const state = createStore(app.dataDir).getProactiveState(AGENT);
    assert.equal(state.nextDueAt, new Date(endedAt + minutes * MINUTE).toISOString(), `${tier} 的缓冲是 ${minutes} 分钟`);
  }
});

test("缓冲的门口就把有时效的几类排除了：待办、节日天气、睡前收尾、醒来回声、登录提醒、未回应那串", () => {
  const start = INDEX_SOURCE.indexOf("const chatBuffer =");
  assert.notEqual(start, -1, "index.js 里能找到缓冲这一道");
  const end = INDEX_SOURCE.indexOf('action: "buffered"', start);
  assert.ok(end > start, "能找到缓冲那一段的回报");
  const guard = INDEX_SOURCE.slice(start, end);
  for (const marker of ["todoHere", "publicEvent", "farewellSend", "followup", "wakeEcho", "videoLoginNotice"]) {
    assert.match(guard, new RegExp(marker), `${marker} 不该被缓冲挡住`);
  }
  assert.match(guard, /conversationBuffer\(\{ tier: settings\.tier/);
  // 缓冲只挪落点，不动已排好的频率：落点写的是缓冲结束那一刻。
  assert.match(guard, /nextDueAt: chatBuffer\.untilAt/);
});

test("行为：只发一张表情也是真发出去——图进气泡、进表情使用账、算一条主动额", { skip: SKIP_DEV }, async (t) => {
  __clearCatalogCache();
  const app = await bootChahuahui({
    seed: (store) => {
      seedWorld(store);
      store.setProactiveState(AGENT, { ...store.getProactiveState(AGENT), lastSentAt: clockAt(-2 * HOUR) });
    },
    resources: stickerResources(),
  });
  cleanupOn(t, app);
  t.after(() => __clearCatalogCache());
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "今天顺得离谱", readAt: clockAt(0), at: clockAt(-HOUR - 10 * MINUTE) });
  store.appendMessage(AGENT, { role: "assistant", text: "那挺好", at: clockAt(-HOUR) });
  const calls = stubUtility(app, "[表情:无语]");

  await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "整条只有一张图也算发出去了");
  assert.equal(sent.text, "[表情]", "落库正文只留记号");
  assert.equal(sent.bubbles.length, 1);
  assert.match(String(sent.bubbles[0]), /^\u0001stk:stk_wuyu$/, "气泡里是那张图的 id");
  assert.equal(calls.filter(isProactiveGeneration).length, 1, "只叫了一次生成，没有为了图再问一遍");

  const usage = readStickerUsage(app.dataDir);
  assert.deepEqual(usage.events.map((row) => row.stickerId), ["stk_wuyu"], "表情使用账里真记了一笔");
  const state = createStore(app.dataDir).getProactiveState(AGENT);
  assert.equal(state.sentToday?.count, 1, "跟文字消息共用同一份打扰配额");
});

test("行为：图里那句话还在时，正文不能被图吞掉", { skip: SKIP_DEV }, async (t) => {
  __clearCatalogCache();
  const app = await bootChahuahui({
    seed: (store) => {
      seedWorld(store);
      store.setProactiveState(AGENT, { ...store.getProactiveState(AGENT), lastSentAt: clockAt(-2 * HOUR) });
    },
    resources: stickerResources(),
  });
  cleanupOn(t, app);
  t.after(() => __clearCatalogCache());
  app.store.appendMessage(AGENT, { role: "user", text: "今天顺得离谱", readAt: clockAt(0), at: clockAt(-HOUR - 10 * MINUTE) });
  app.store.appendMessage(AGENT, { role: "assistant", text: "那挺好", at: clockAt(-HOUR) });
  stubUtility(app, "窗台那盆又抽了一片新叶\n[表情:无语]");

  await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(app.store.getThread(AGENT).messages);
  assert.ok(sent, "有正文有图也照旧发");
  assert.match(sent.text, /窗台那盆又抽了一片新叶/, "正文留着");
  assert.equal(sent.bubbles.length, 2, "文字一格、图一格");
  assert.match(String(sent.bubbles[1]), /^\u0001stk:/, "图在后面");
});

test("行为：图库里没有这张图时整条不发，不生成假文案也不记额度", { skip: SKIP_DEV }, async (t) => {
  __clearCatalogCache();
  const app = await bootChahuahui({ seed: (store) => seedWorld(store) });
  cleanupOn(t, app);
  t.after(() => __clearCatalogCache());
  app.store.appendMessage(AGENT, { role: "user", text: "今天顺得离谱", readAt: clockAt(0), at: clockAt(-HOUR - 10 * MINUTE) });
  app.store.appendMessage(AGENT, { role: "assistant", text: "那挺好", at: clockAt(-HOUR) });
  stubUtility(app, "[表情:无语]");

  await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

  const rows = createStore(app.dataDir).getThread(AGENT).messages;
  assert.equal(lastProactive(rows), null, "没有图就不发，也不把标记当正文发出去");
  assert.ok(!rows.some((row) => /表情/.test(String(row.text ?? ""))), "账本里也不该长出以标记充数的正文");
  assert.equal(readStickerUsage(app.dataDir).events.length, 0);
  assert.equal(createStore(app.dataDir).getProactiveState(AGENT).sentToday?.count, undefined, "没发出去就不记主动额");
});

test("行为：安静时段里连表情都不发（同一道门）", { skip: SKIP_DEV }, async (t) => {
  __clearCatalogCache();
  const app = await bootChahuahui({
    seed: (store) => {
      seedWorld(store);
      // 静默窗正好罩住现在：睡着的时候一个都不发。
      const nowHour = new Date().getHours();
      const start = `${pad(nowHour)}:00`;
      const end = `${pad((nowHour + 1) % 24)}:00`;
      store.setGlobalSettings({ quiet: { start, end } });
    },
    resources: stickerResources(),
  });
  cleanupOn(t, app);
  t.after(() => __clearCatalogCache());
  app.store.appendMessage(AGENT, { role: "user", text: "今天顺得离谱", readAt: clockAt(0), at: clockAt(-HOUR - 10 * MINUTE) });
  app.store.appendMessage(AGENT, { role: "assistant", text: "那挺好", at: clockAt(-HOUR) });
  stubUtility(app, "[表情:无语]");

  await withRandom(0.4, () => app.request("POST", "/proactive/tick", { json: {} }));

  assert.equal(lastProactive(app.store.getThread(AGENT).messages), null, "睡着不发");
  assert.equal(readStickerUsage(app.dataDir).events.length, 0);
});
