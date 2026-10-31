import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { bootChahuahui } from "./helpers/app-harness.js";
import { proactiveSpec, hasOpenHook } from "../lib/compose.js";
import { askBudgetSpent, isRepeatedPhrasing } from "../lib/proactive.js";
import { isSpeechMessage } from "../lib/turn-window.js";
import { enrichReasonContext } from "../lib/proactive-reasons.js";
import { reasonWeights } from "../lib/proactive-reasons.js";
import { makeVideoCandidate, addVideoCandidate } from "../lib/video-sharing.js";
import { importStickerBytes } from "../lib/sticker-library.js";

// 这组端到端用例靠手动催一次巡检（/proactive/tick）驱动，那是发布前会剥掉的内测路由。
// 公开仓库的 index.js 里开关是关的，所以那里只跑纯函数部分，这里自动跳过。
const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(
  fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"),
);
const SKIP_DEV = HAS_DEV_ROUTE ? false : "公开发布版不含内测巡检路由";

const AGENT = "nova";
const OTHER = "lumen"; // 另一位伙伴：主动上下文绝不能把她的账带进来
const HOUR = 3600_000;
const VIDEO_LINK = "https://www.bilibili.com/video/BV1bXt9z9ESP?p=2";

const clockAt = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const pad = (n) => String(n).padStart(2, "0");

/** 把静默窗和作息窗都推到离基准时刻很远的地方，避免测试跑在半夜或凌晨时误判。 */
function farWindows(base) {
  const start = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
  const end = `${pad((base.getHours() + 1) % 24)}:${pad(base.getMinutes())}`;
  return {
    quiet: { start, end },
    sleep: { shape: 2, start, hours: 7, nap: { start: end, minutes: 20 } },
  };
}

/** 默认世界：这位伙伴足够熟、开着主动、有真聊天可接、但手上没有兴趣素材。 */
function seedWorld(store, { base = new Date(), video = false } = {}) {
  const windows = farWindows(new Date(base.getTime() + 7 * HOUR));
  store.setGlobalSettings({
    rhythmProactiveEnabled: true,
    quiet: windows.quiet,
    ...(video ? { videoShareMaxPerDay: 1 } : {}),
  });
  store.setPartnerSettings(AGENT, {
    proactiveEnabled: true,
    tier: "often",
    model: { provider: "test-provider", model: "test-model" },
    hobbySeedTryAt: clockAt(0),
    sleep: windows.sleep,
    rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
    voice: { enabled: false },
    ...(video ? { videoSharingEnabled: true } : {}),
  });
  const knowing = store.getKnowing(AGENT);
  store.saveKnowing(AGENT, {
    ...knowing,
    // 世界领域已经长出来了（2026-10-20）：测试里的伙伴不该在 tick 里再去生成一批，
    // 否则多出来的那次后台调用会打乱这些用例对模型调用次数的计数。
    worldInterests: [
      {
        id: "wi_手作与旧物",
        name: "手作与旧物",
        domains: ["旧物修复与手作"],
        sources: ["B站"],
        note: "",
        muted: false,
        createdAt: clockAt(0),
        updatedAt: clockAt(0),
      },
      {
        id: "wi_数码更新",
        name: "数码更新",
        domains: ["数码与模型更新"],
        sources: ["科技媒体"],
        note: "",
        muted: false,
        createdAt: clockAt(0),
        updatedAt: clockAt(0),
      },
    ],
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
    topicSeeds: { lastGrowAt: clockAt(0), seeds: [] },
    // 新闻刚取过料：这一轮不去搜，池子也是空的，省得用例里多出一次网络动作。
    newsBook: { lastFetchAt: clockAt(0), lastDomainId: "", items: [], history: [] },
  });
  if (video) {
    store.saveVideoBook(AGENT, addVideoCandidate(store.getVideoBook(AGENT), makeVideoCandidate({
      readKind: "subtitle",
      video: {
        bvid: "BV1bXt9z9ESP", aid: 123, cid: 456, page: 2, duration: 100,
        title: "半岛铁盒制作", author: "手作频道", desc: "石膏制作教程", link: VIDEO_LINK,
      },
      subtitle: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "半岛铁盒用石膏浇筑，泡沫板做模具。" })),
    }, { interest: { id: "craft", name: "手作" }, plan: { focus: "半岛铁盒制作", searchQuery: "石膏手作" } })));
  }
  return windows;
}

/** 语义核查那一次固定回 send：那是拿模型桩顶替的判定，只保证这条消息能发出去。 */
const CLARITY_MARKER = "检查一条准备发出的普通私聊主动消息";

/** 主动生成走后台 utility 通道；每次都记下完整请求，好检查历史是不是真的进了模型。 */
function captureUtility(app, replies) {
  const calls = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fallback = queue ? null : String(replies ?? "");
  app.ctx.models.utility = async (request = {}) => {
    calls.push(request);
    if (String(request.systemPrompt ?? "").includes(CLARITY_MARKER)) {
      return { requestId: "utility_clarity", text: '{"decision":"send"}' };
    }
    const text = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : fallback;
    return { requestId: "utility_capture", text };
  };
  return calls;
}

const joinedMessages = (request) => (Array.isArray(request?.messages) ? request.messages : []).map(contentOf).join("\n");

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

/** 把「现在」挪到指定时刻，用来稳定地跑晨间那条；其余 Date 行为原样代理。 */
async function withFakeNow(iso, run) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  globalThis.Date = ShiftedDate;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

const lastProactive = (messages) => [...messages].reverse().find((row) => row.proactive === true) ?? null;
const contentOf = (row) => String(Array.isArray(row?.content) ? (row.content[0]?.text ?? "") : (row?.content ?? ""));
const isUser = (row) => row?.role === "user";

/** 抽签落在哪一条：按候选权重算出对应的随机值。 */
function rndForKind(relationship, personality, kind, { interestAvailable, hasContext }) {
  const rows = reasonWeights({ relationship, personality, interestAvailable, hasContext });
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  const index = rows.findIndex((row) => row.kind === kind);
  assert.notEqual(index, -1, `${kind} 这一轮不在候选里`);
  const before = rows.slice(0, index).reduce((sum, row) => sum + row.weight, 0);
  return (before + rows[index].weight / 2) / total;
}

/** 让这一轮落在「无主题搭话」上：它不带兴趣素材，历史照样该进请求。 */
function contactRnd(store) {
  const knowing = store.getKnowing(AGENT);
  return rndForKind(knowing.relationship, knowing.personality, "contact", { interestAvailable: false, hasContext: true });
}

function cleanupOn(t, app) {
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
}

// ── 纯函数这一层 ────────────────────────────────────────────────

test("场景回声不再把上一轮那两行当材料：它只作「最近确实聊过」的凭据", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    currentTimeText: "2026年10月19日，上午 9 点",
    sceneEcho: { userText: "我刚忙完脑壳还有点昏", assistantText: "那你先缓一哈" },
  });
  assert.doesNotMatch(spec.userText, /我刚忙完脑壳还有点昏/, "她上一轮原话不再成文");
  assert.doesNotMatch(spec.userText, /那你先缓一哈/, "ta 上一轮原话也不再成文");
  assert.match(spec.userText, /最近确实/, "近期真聊天这一层还在");
  assert.match(spec.userText, /独立历史/, "指向独立历史，而不是摘两行塞进提示词");
});

test("共同经历/吐槽的凭据不再注入那两行，但说明真实聊天在独立历史里", () => {
  for (const kind of ["shared", "tease"]) {
    const { reason, dropped } = enrichReasonContext({ kind }, {
      sceneEcho: { userText: "那个摊子的位置", assistantText: "改天一起去" },
    });
    assert.equal(dropped, false, `${kind} 仍然算有凭据`);
    assert.equal(reason.kind, kind);
    assert.doesNotMatch(reason.contextText, /那个摊子的位置/, `${kind} 不注入她上一轮原话`);
    assert.doesNotMatch(reason.contextText, /改天一起去/, `${kind} 不注入 ta 上一轮原话`);
    assert.match(reason.contextText, /历史/, `${kind} 得说明近期真聊天在独立历史中`);
  }
});

test("共同经历只提供背景，不替伙伴预设回味的动机", () => {
  const spec = proactiveSpec({
    partnerName: "阿岚", userName: "阿舟",
    reason: { kind: "shared", contextText: "近期聊天已在独立历史中" },
  });
  assert.doesNotMatch(spec.userText, /你想回味/);
  assert.match(spec.userText, /没有.*新.*\[不回\]/);
});

test("空的场景对象不能充当共同经历的实质凭据", () => {
  const result = enrichReasonContext({ kind: "shared" }, { sceneEcho: {} });
  assert.equal(result.dropped, true);
  assert.equal(result.reason, null);
});

test("晨间首次联系是独立场景：种子、发现、跟进、由头在场都不让它消失", () => {
  const seed = { id: "s1", motifId: "h1", motifName: "旧物", kind: "curio", hook: "那盏旧台灯", angle: "还没想明白该放哪" };
  const base = { partnerName: "小花", userName: "阿舟", currentTimeText: "2026年10月19日，上午 8 点", greetingOnly: false };
  const marker = /第一次主动联系/;

  const withSeed = proactiveSpec({ ...base, morningFirst: true, seed });
  assert.match(withSeed.userText, marker, "有种子时晨间这层还在");
  assert.match(withSeed.userText, /那盏旧台灯/, "种子照旧注入，不被晨间场景挤掉");

  const withDiscovery = proactiveSpec({ ...base, morningFirst: true, discovery: { id: "d1", interestId: "h1", interestName: "旧物", focus: "某个角度" } });
  assert.match(withDiscovery.userText, marker);

  const withFollowup = proactiveSpec({ ...base, morningFirst: true, followup: { count: 1, read: true, readAgeMs: 2 * HOUR, previousText: "昨天那句" } });
  assert.match(withFollowup.userText, marker, "已读跟进在场时晨间这层也还在");

  const withReason = proactiveSpec({ ...base, morningFirst: true, reason: { kind: "contact", contextText: "" } });
  assert.match(withReason.userText, marker, "关系式由头在场时晨间这层也还在");

  assert.doesNotMatch(proactiveSpec({ ...base, morningFirst: false, seed }).userText, marker, "不是晨间就不加这层");
});

test("晨间普通开口有素材也不被强制变成兴趣分享或回味", () => {
  for (const source of [
    { seed: { hook: "一盏旧台灯", kind: "curio" } },
    { discovery: { interestName: "旧物", focus: "旧台灯" } },
    { reason: { kind: "shared", contextText: "昨天约好今天接着聊" } },
  ]) {
    const spec = proactiveSpec({ partnerName: "阿岚", userName: "阿舟", morningFirst: true, ...source });
    assert.doesNotMatch(spec.systemPrompt, /主动消息必须落到至少一个/);
    assert.doesNotMatch(spec.userText, /这条分享必须沿着|才只沿上面的联系由头/);
    assert.match(spec.userText, /可以只招呼一句/);
    assert.match(spec.userText, /旧台灯|昨天约好今天接着聊/);
  }
});

test("已读未回只给读过多久的轻重姿态，不再拿上一条原文当内容来源", () => {
  const previousText = "昨天那家摊子你到底去没去";
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    currentTimeText: "2026年10月19日，下午 3 点",
    followup: { count: 1, read: true, readAgeMs: 2 * HOUR, previousText },
  });
  assert.doesNotMatch(spec.userText, new RegExp(previousText), "上一条原文不再进提示词");
  assert.doesNotMatch(spec.userText, /拿自己开涮/);
  assert.doesNotMatch(spec.userText, /嘴硬收场/);
  assert.doesNotMatch(spec.userText, /打趣找人/);
  assert.doesNotMatch(spec.userText, /认一句自己确实在等/);
  assert.doesNotMatch(spec.userText, /先把「她看了还没回」这件事接住/);
  assert.doesNotMatch(spec.userText, /不要继续展开共同话题或兴趣/);
  assert.match(spec.userText, /\[戳\]/, "戳一下还在");
  assert.match(spec.userText, /\[表情:/, "甩图还在");
  assert.match(spec.userText, /安静/, "安静收场还在");
});

// ── 防重清单认不认普通回复（2026-10-30）───────────────────────
//
// 这组用例不自己再写一遍 filter：直接从 index.js 源码里抠出那三条选择语句，
// 放进 vm 里跑。选择逻辑全仓只有一份，测试跟着源码走，源码改了回去就红。
// 不走真 apply：当前工作区带着手机网关，apply 会拉起一个独立 Node 进程守端口，
// 而测试收尾并不会关掉它。

const INDEX_SOURCE = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

/** 按锚点抠一条 `const … = …;` 语句原文（这几条里的箭头函数不带分号，第一个分号就是句尾）。 */
function grabStatement(anchor) {
  const start = INDEX_SOURCE.indexOf(anchor);
  assert.notEqual(start, -1, `index.js 里找不到「${anchor}」`);
  const end = INDEX_SOURCE.indexOf(";", start);
  assert.ok(end > start, `「${anchor}」这条语句没找到句尾`);
  return INDEX_SOURCE.slice(start, end + 1);
}

/** 把源码语句包成一个普通函数：形参由调用方给，判定函数按源码里用的那个名字交进去。 */
function compileStatement(statement, varName, params) {
  return vm.runInNewContext(
    `(function (${params.join(", ")}) {\n${statement}\nreturn ${varName};\n})`,
    { isSpeechMessage },
  );
}

/** 每次调用都从源码重抠一遍：源码里删了这条就当场红，不会拖到导入阶段。 */
function selectorFor(anchor, varName, params) {
  return (...args) => compileStatement(grabStatement(anchor), varName, params)(...args);
}

const selectRecentAsks = selectorFor("const recentAsks = threadRows", "recentAsks", ["threadRows"]);
const selectRecentSentTexts = selectorFor("const recentSentTexts = threadRows", "recentSentTexts", ["threadRows"]);
const selectSaidRecently = selectorFor("const saidRecently = store.getThread(agentId).messages", "saidRecently", ["store", "agentId"]);

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const speech = (text, minutes, extra = {}) => ({ role: "assistant", text, at: minutesAgo(minutes), ...extra });
const threadOf = (rows) => ({ getThread: () => ({ messages: rows }) });

/** 七条真话夹在一堆杂音里：她的话、撤回、动作、戳、酒馆开场、空白。 */
function noisyThread() {
  return [
    speech("甲：窗台那盆挪到阳台了", 70),
    speech("丙：我下午把旧台灯修好了", 45),
    speech("丁：明早记得带伞", 35),
    speech("戊：米粉店老板换人了", 30),
    speech("己：阳台那盆抽了新芽", 25),
    speech("庚：楼下那家面馆开门了", 20),
    speech("辛：我把旧相片按年份排了一遍", 15),
    // 杂音放在末尾，确保仅靠 slice 截断无法假装通过过滤测试。
    { role: "user", text: "她说的那句不算", at: minutesAgo(14) },
    speech("乙：撤回掉的那句", 13, { recalled: true }),
    speech("动作不该算话", 12, { kind: "action" }),
    speech("戳一下不该算话", 11, { kind: "poke" }),
    speech("酒馆开场不该算话", 10, { kind: "tavern-opening" }),
    { role: "assistant", text: "   ", at: minutesAgo(9) },
  ];
}

const NOISE = ["她说的那句不算", "乙：撤回掉的那句", "动作不该算话", "戳一下不该算话", "酒馆开场不该算话", "   "];

test("出站防重认普通回复：四十分钟前刚说过的话，主动消息别再念一遍", () => {
  const rows = [
    { role: "user", text: "窗台那盆你到底挪哪儿了", at: minutesAgo(50) },
    speech("挪到阳台了，那儿晒得着", 42),
  ];
  const said = selectSaidRecently(threadOf(rows), AGENT);
  assert.deepEqual(said.map((row) => row.text), ["挪到阳台了，那儿晒得着"], "普通回复进了防重清单");

  assert.equal(isRepeatedPhrasing(said, "挪到阳台了，那儿晒得着。", { now: Date.now() }).repeated, true, "同一句话照样拦");
  assert.equal(isRepeatedPhrasing(said, "我刚翻到一张旧照片，边角都卷了", { now: Date.now() }).repeated, false, "新话仍然能发出去");
});

test("出站防重：撤回的不算、动作/戳/酒馆开场不算，最多取六条", () => {
  const said = selectSaidRecently(threadOf(noisyThread()), AGENT);
  const texts = said.map((row) => String(row.text));
  assert.deepEqual(texts, ["丙：我下午把旧台灯修好了", "丁：明早记得带伞", "戊：米粉店老板换人了", "己：阳台那盆抽了新芽", "庚：楼下那家面馆开门了", "辛：我把旧相片按年份排了一遍"], "最近六条真话，按原顺序");
  for (const noise of NOISE) assert.ok(!texts.includes(noise), `${noise} 不该进防重清单`);
});

test("防重窗口还是六小时：更早说过的话不再挡", () => {
  const said = selectSaidRecently(threadOf([speech("挪到阳台了，那儿晒得着", 7 * 60)]), AGENT);
  assert.equal(said.length, 1, "七小时前那条照样被选进来");
  assert.equal(isRepeatedPhrasing(said, "挪到阳台了，那儿晒得着", { now: Date.now() }).repeated, false, "六小时以外不算重念");
});

test("提示词里的防重清单带上普通回复，撤回和杂音不混进来，最多三条", () => {
  const sent = selectRecentSentTexts(noisyThread());
  assert.deepEqual(sent, ["己：阳台那盆抽了新芽", "庚：楼下那家面馆开门了", "辛：我把旧相片按年份排了一遍"], "最近三条真话");

  const { reason } = enrichReasonContext({ kind: "contact" }, { sentTexts: sent });
  assert.ok(reason, "搭话这类由头不要凭据，不会被冲掉");
  assert.match(reason.contextText, /你已经实际说过的话/);
  for (const line of sent) assert.ok(reason.contextText.includes(line), "普通回复也进了提示词防重段");
  for (const noise of NOISE) assert.ok(!reason.contextText.includes(noise), `${noise} 不该进提示词`);
  assert.doesNotMatch(reason.contextText, /甲：窗台那盆挪到阳台了/, "只取最近三条，更早的让位");
});

test("普通回复里的问句不占主动问句额度：recentAsks 仍只挑主动消息", () => {
  const rows = [
    { role: "assistant", text: "你那边现在是不是也降温了", at: minutesAgo(42) },
    { role: "assistant", text: "我把窗台那盆挪到阳台了", at: minutesAgo(200), proactive: true },
  ];
  const asks = selectRecentAsks(rows);
  assert.deepEqual(asks, ["我把窗台那盆挪到阳台了"], "普通回复不进问句额度");
  assert.equal(askBudgetSpent(asks, { isAsk: hasOpenHook }), false, "一条主动不算用尽");

  const twoAsks = selectRecentAsks([
    { role: "assistant", text: "你那边降温了要不要加件衣服", at: minutesAgo(300), proactive: true },
    { role: "assistant", text: "阳台那盆是不是该换个大点的盆了", at: minutesAgo(200), proactive: true },
  ]);
  assert.equal(askBudgetSpent(twoAsks, { isAsk: hasOpenHook }), true, "连着两条主动问句才算用尽");
});

test("防重挡在合成语音和落消息之前：拦下的那条既不进账也不发声", () => {
  const start = INDEX_SOURCE.indexOf("async function deliverProactive(");
  const end = INDEX_SOURCE.indexOf("async function deliverStirred(");
  assert.ok(start > 0 && end > start, "能找到 deliverProactive 这一段");
  const body = INDEX_SOURCE.slice(start, end);
  const guard = body.indexOf('reason: "repeat-phrasing"');
  assert.ok(guard > 0, "repeat 这一关还在");
  assert.ok(body.indexOf("prepareVoice(agentId, text") > guard, "防重先于语音合成");
  assert.ok(body.indexOf("appendPartnerMessage(agentId, {") > guard, "防重先于落消息");
});

// ── 走真路由，把模型请求抓下来看 ────────────────────────────────

test("行为：普通主动把最近这段真聊天直接送进模型请求", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed: (store) => seedWorld(store) });
  cleanupOn(t, app);
  const store = app.store;

  // 26 条正常对话 + 4 条不该进上下文的杂音（都排在窗口之内，必须靠过滤挡掉）
  for (let i = 1; i <= 26; i += 1) {
    store.appendMessage(AGENT, {
      role: i % 2 === 1 ? "user" : "assistant",
      text: `第${i}轮真聊天`,
      at: clockAt(-(30 - i) * 5 * 60_000),
    });
  }
  store.appendMessage(AGENT, { role: "assistant", text: "动作杂音不该进来", kind: "action", at: clockAt(-60_000) });
  store.appendMessage(AGENT, { role: "assistant", text: "戳一下杂音", kind: "poke", at: clockAt(-50_000) });
  store.appendMessage(AGENT, { role: "assistant", text: "酒馆初见杂音", kind: "tavern-opening", at: clockAt(-40_000) });
  store.appendMessage(AGENT, { role: "user", text: "硬撤回杂音", recalled: true, recallMode: "hard", at: clockAt(-30_000) });
  const { sticker } = importStickerBytes(app.dataDir,
    { id: "fixture", description: "一只点头的纸鸟", emotion: ["开心"], contentType: "image/png" },
    Buffer.from("synthetic-sticker-label-fixture"));
  store.appendMessage(AGENT, { role: "user", kind: "sticker", text: "[表情]", bubbles: [`\u0001stk:${sticker.id}`], at: clockAt(-25_000) });
  store.appendMessage(AGENT, { role: "user", text: "第27轮真聊天", readAt: clockAt(0), at: clockAt(-20_000) });
  store.appendMessage(AGENT, { role: "assistant", text: "第28轮真聊天", at: clockAt(-10_000) });
  store.appendMessage(OTHER, { role: "user", text: "别家伙伴的私话", at: clockAt(-5_000) });

  const calls = captureUtility(app, "顺手把窗台擦了一遍");
  await withRandom(contactRnd(store), () => app.request("POST", "/proactive/tick", { json: {} }));

  assert.ok(lastProactive(store.getThread(AGENT).messages), "这一轮真的发出去一条主动消息");
  // 这一轮跑完还会带别的后台调用（热身之类），只有生成这一次带历史
  const generation = calls.find((row) => Array.isArray(row.messages) && row.messages.length > 1);
  assert.ok(generation, "抓到了生成那一次请求");
  const history = generation.messages.slice(0, -1);
  const joined = history.map(contentOf).join("\n");

  assert.equal(history.length, 24, "按常规 24 条预算取，不多带");
  assert.equal(generation.messages.at(-1).role, "user", "最后一条才是这次要写的提示词");
  assert.ok(history.filter(isUser).length > 0 && history.filter((row) => row.role === "assistant").length > 0, "角色是交替着给的");
  assert.match(joined, /第\d+轮真聊天/, "历史正文真的进了请求");
  assert.match(contentOf(history[0]), /【\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}】/, "带上真实时间");
  assert.doesNotMatch(joined, /动作杂音/);
  assert.doesNotMatch(joined, /戳一下杂音/);
  assert.doesNotMatch(joined, /酒馆初见杂音/);
  assert.doesNotMatch(joined, /硬撤回杂音/);
  assert.doesNotMatch(joined, /别家伙伴的私话/, "不跨伙伴");
  assert.match(joined, /第28轮真聊天/, "最新那轮在窗口内");
  assert.match(joined, /发来一张表情包，是「开心」的意思/, "自己图库的情绪标签确实进入生成请求");
  assert.doesNotMatch(joined, /第1轮真聊天/, "最老的那几条按预算让位");
});

test("行为：正文里混入的无关字符重试时，同一段历史照样带着", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed: (store) => seedWorld(store) });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "第1轮真聊天", readAt: clockAt(0), at: clockAt(-20 * 60_000) });
  store.appendMessage(AGENT, { role: "assistant", text: "第2轮真聊天", at: clockAt(-10 * 60_000) });

  const calls = captureUtility(app, ["我把窗台擦了一遍asdf", "我把窗台擦了一遍"]);
  await withRandom(contactRnd(store), () => app.request("POST", "/proactive/tick", { json: {} }));

  // 这一轮跑完还会带别的后台调用（热身之类），只认真正带历史的那两次生成
  const generations = calls.filter((row) => Array.isArray(row.messages) && row.messages.length > 1);
  assert.equal(generations.length, 2, "生成这一路确实因字符污染重试了一次");
  assert.match(String(generations[1].systemPrompt ?? ""), /混入了无关字符/, "第二次是字符污染那次重试");
  for (const call of generations) {
    assert.match(joinedMessages(call), /第2轮真聊天/, "重试请求里历史没丢");
  }
  assert.ok(lastProactive(store.getThread(AGENT).messages), "重试后照旧把消息发出去");
});

test("行为：视频分享那一路（generateReply 流式）也带着同一段历史", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed: (store) => seedWorld(store, { video: true }) });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "第1轮真聊天", readAt: clockAt(0), at: clockAt(-20 * 60_000) });
  store.appendMessage(AGENT, { role: "assistant", text: "第2轮真聊天", at: clockAt(-10 * 60_000) });

  const pending = withRandom(0, () => app.request("POST", "/proactive/tick", { json: {} }));
  await app.models.waitForCall(0);
  app.models.release(0, "刚看到一个石膏浇的半岛铁盒，手痒了");
  await pending;

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "视频那条真的发出去");
  const stream = app.models.calls[0].request;
  const joined = stream.messages.map(contentOf).join("\n");
  assert.match(joined, /第1轮真聊天/);
  assert.match(joined, /第2轮真聊天/);
  assert.ok(stream.messages.length > 1, "历史是作为对话消息给的，不是拼在提示词里");
  assert.ok(stream.messages.some((row) => row.role === "assistant"), "历史里她自己的回话也在");
  assert.equal(stream.messages.at(-1).role, "user", "最后一条是这次要写的提示词");
  assert.doesNotMatch(joined, /她上一轮说的话：/, "不再靠摘两行塞进提示词冒充历史");
});

/** 造一个「某个早上八点半、这位伙伴手上有一条种子」的世界。 */
function bootMorningWorld(t, { lastSentOffsetMs }) {
  // 日期钉在既没节日也没节气的日子：注入层碰到节日会改用节日意象，
  // 这两条用例断的是种子素材在不在，不能跟着真实「今天」漂。
  const morning = new Date(2026, 2, 4, 8, 30, 0, 0);
  const app = bootChahuahui({
    seed: (store) => {
      seedWorld(store, { base: morning });
      store.setProactiveState(AGENT, {
        ...store.getProactiveState(AGENT),
        lastSentAt: new Date(morning.getTime() + lastSentOffsetMs).toISOString(),
        nextDueAt: new Date(morning.getTime() - HOUR).toISOString(),
        topicSeeds: {
          lastGrowAt: new Date(morning.getTime() - HOUR).toISOString(),
          seeds: [{
            id: "seed_morning_1", motifId: "m1", motifName: "旧物", kind: "curio",
            hook: "那盏旧台灯", angle: "还没想明白它到底该放哪",
            createdAt: new Date(morning.getTime() - HOUR).toISOString(),
            expiresAt: new Date(morning.getTime() + 3 * 24 * HOUR).toISOString(),
            usedAt: null,
          }],
        },
      });
      store.appendMessage(AGENT, {
        role: "user",
        text: "第1轮真聊天",
        readAt: morning.toISOString(),
        at: new Date(morning.getTime() - 30 * 60_000).toISOString(),
      });
    },
  });
  return app.then((booted) => {
    cleanupOn(t, booted);
    return { app: booted, morning };
  });
}

test("行为：晨间有种子时，晨间首次联系这层不会丢", { skip: SKIP_DEV }, async (t) => {
  // 昨天夜里已经开过口，所以今天这个生活日还没联系过她 → 确实是晨间首次
  const { app, morning } = await bootMorningWorld(t, { lastSentOffsetMs: -12 * HOUR });
  const calls = captureUtility(app, "早上好呀");

  await withFakeNow(morning.toISOString(), () => withRandom(0, () => app.request("POST", "/proactive/tick", { json: {} })));

  assert.match(lastProactive(app.store.getThread(AGENT).messages)?.text ?? "", /早上好呀/, "有种子也允许只招呼一句");
  const generation = calls.find((row) => Array.isArray(row.messages) && row.messages.length > 1);
  assert.ok(generation, "抓到了生成那一次请求");
  const prompt = generation.messages.map(contentOf).join("\n");
  assert.match(prompt, /第一次主动联系/, "晨间首次联系这层在有素材时仍然在场");
  assert.match(prompt, /那盏旧台灯/, "种子没被晨间场景挤掉");
});

test("行为：这个生活日已经发出去过，就不再自称晨间首次", { skip: SKIP_DEV }, async (t) => {
  // 十分钟前刚发过，同一个生活日；此用例不模拟调度与出站之间的并发更新。
  const { app, morning } = await bootMorningWorld(t, { lastSentOffsetMs: -10 * 60_000 });
  const calls = captureUtility(app, "那盏台灯我到现在也没想明白该搁哪儿");

  await withFakeNow(morning.toISOString(), () => withRandom(0, () => app.request("POST", "/proactive/tick", { json: {} })));

  assert.ok(lastProactive(app.store.getThread(AGENT).messages), "这一轮还是照发");
  const generation = calls.find((row) => Array.isArray(row.messages) && row.messages.length > 1);
  assert.ok(generation, "抓到了生成那一次请求");
  const prompt = generation.messages.map(contentOf).join("\n");
  assert.doesNotMatch(prompt, /第一次主动联系/, "已经发过就不许再当晨间首次");
  assert.match(prompt, /那盏旧台灯/, "素材照旧在");
});
