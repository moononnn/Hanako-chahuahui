import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AFFECTION_FLOOR,
  CONTEXT_REQUIRED_KINDS,
  FAMILIARITY_FLOOR,
  REASON_KINDS,
  buildReasonContext,
  enrichReasonContext,
  introducedTextFrom,
  normalizeReason,
  pickReason,
  reasonPersonality,
  reasonWeights,
  relationBasis,
  substantiveContext,
} from "../lib/proactive-reasons.js";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";

// 这组端到端用例靠手动催一次巡检（/proactive/tick）驱动，那是发布前会剥掉的内测路由。
// 公开仓库的 index.js 里开关是关的，所以那里只跑纯函数部分，这里自动跳过。
const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(
  fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"),
);
const SKIP_DEV = HAS_DEV_ROUTE ? false : "公开发布版不含内测巡检路由";

/** 关系账的两轨：turns/activeDays 是熟悉度，score 是亲密度。 */
const rel = (turns, activeDays, score) => ({
  familiarity: { turns, activeDays },
  intimacy: { score },
});

const STRANGER = rel(1, 1, 0);
const FAMILIAR = rel(30, 10, 3);
const CLOSE = rel(90, 40, 20);
const INTIMATE = rel(140, 60, 24);

const weightOf = (rows, kind) => rows.find((row) => row.kind === kind)?.weight ?? 0;
const withTags = (...tags) => ({ surface: { tags }, inner: { tags: [] } });

test("由头就这五种，且只有共同经历和吐槽必须有真凭据", () => {
  assert.deepEqual([...REASON_KINDS], ["interest", "shared", "tease", "contact", "affection"]);
  assert.deepEqual([...CONTEXT_REQUIRED_KINDS], ["shared", "tease"]);
});

test("两轨从已有关系账读出来，不另立一个好感分", () => {
  const basis = relationBasis(CLOSE);
  assert.ok(basis.familiarity > 0.8, `熟到底了：${basis.familiarity}`);
  assert.ok(basis.intimacy > 0.5 && basis.intimacy <= 1, `亲密折算：${basis.intimacy}`);
  const stranger = relationBasis(STRANGER);
  assert.ok(stranger.familiarity < FAMILIARITY_FLOOR, `刚照面时熟度远不到门槛：${stranger.familiarity}`);
  assert.equal(stranger.intimacy, 0);
});

test("刚认识：搭话和想念都起不来，共同经历照样能回味", () => {
  const rows = reasonWeights({ relationship: STRANGER, hasContext: true });
  assert.equal(weightOf(rows, "contact"), 0, "生疏时没话找话这条路是关着的");
  assert.equal(weightOf(rows, "affection"), 0);
  assert.ok(weightOf(rows, "shared") > 0, "一起做过的事不需要先熟起来");
  assert.equal(reasonWeights({ relationship: STRANGER, hasContext: false }).length, 0, "没凭据就什么都不给");
});

test("熟但还不亲：可以搭话，不许想念", () => {
  const rows = reasonWeights({ relationship: FAMILIAR, hasContext: true });
  assert.ok(weightOf(rows, "contact") > 0, "熟了就有话可搭");
  assert.equal(weightOf(rows, "affection"), 0, "亲密度没过门槛之前不给想念");
  assert.ok(relationBasis(FAMILIAR).intimacy < AFFECTION_FLOOR);
});

test("想念要熟悉度和亲密度一起顶，两道门槛都得过", () => {
  const close = reasonWeights({ relationship: CLOSE, hasContext: true });
  const intimate = reasonWeights({ relationship: INTIMATE, hasContext: true });
  assert.ok(weightOf(close, "affection") > 0, "熟且亲起来之后才有想念这一路");
  assert.ok(weightOf(intimate, "affection") > weightOf(close, "affection"), "亲密度继续涨，想念跟着涨");
  // 同一份熟悉度下只动亲密度：搭话那一路不该跟着变。
  const sameFamLow = reasonWeights({ relationship: rel(90, 40, 3) });
  const sameFamHigh = reasonWeights({ relationship: rel(90, 40, 24) });
  assert.equal(weightOf(sameFamHigh, "contact"), weightOf(sameFamLow, "contact"), "搭话只看熟悉度");
  assert.ok(weightOf(sameFamHigh, "affection") > weightOf(sameFamLow, "affection"));
});

test("共同经历和吐槽的真凭据：只有实质来源算数，旧消息不算", () => {
  assert.equal(substantiveContext({ sentTexts: ["旧消息"] }).length > 0, false, "去重段不是凭据");
  assert.ok(substantiveContext({ sceneEcho: { userText: "那个摊子" } }).length > 0, "最近聊过就算");
  assert.ok(substantiveContext({ workfeedText: "下午改了个配色" }).includes("下午改了个配色"));
  assert.equal(substantiveContext({ sceneEcho: { userText: " " } }).length > 0, false, "空白对象不能冒充最近确实聊过");
  assert.equal(substantiveContext({ sceneEcho: {} }), "", "空对象同样不是凭据");
  assert.equal(substantiveContext({ sceneEcho: null, sentTexts: ["x"] }), "");

  const onlyOld = enrichReasonContext({ kind: "shared" }, { sentTexts: ["昨天说过的那句"] });
  assert.equal(onlyOld.reason, null, "拿旧消息冒充共同经历不行");
  assert.equal(onlyOld.dropped, true);
  const real = enrichReasonContext({ kind: "shared" }, { workfeedText: "下午改了个配色" });
  assert.equal(real.reason.kind, "shared");
  assert.match(real.reason.contextText, /下午改了个配色/);
  assert.equal(real.dropped, false);
});

// 同一个场景走真实链路（由头那边先把凭据拼好，再交给拼装层）：
// 只盖住「电脑那边」那一段不够，凭据正文会原样写进提示词，搭话和想念照样看得见整段开发对话。
test("搭话和想念不接工作台账：凭据正文里也不许出现电脑那边", () => {
  const feed = "【电脑那边最近发生的事 · 工作对话背景】\n小林：把这版风铃改好\n小花：改完了";
  for (const kind of ["contact", "affection"]) {
    const { reason } = enrichReasonContext({ kind }, { workfeedText: feed });
    assert.equal(reason.kind, kind);
    assert.doesNotMatch(reason.contextText, /工作对话背景/, `${kind} 不该接台账`);
    assert.doesNotMatch(reason.contextText, /风铃/, `${kind} 不该带开发原文`);
  }
  // 共同经历和吐槽的凭据本来就取自这段，甩了就当场作废。
  for (const kind of ["shared", "tease"]) {
    const { reason } = enrichReasonContext({ kind }, { workfeedText: feed });
    assert.match(reason.contextText, /风铃/, `${kind} 仍然要拿得到凭据`);
  }
});

test("吐槽不因为一个标签就整条关掉：混合标签保留俏皮那一面", () => {
  const mixed = withTags("安静", "俏皮");
  const quiet = withTags("安静", "有分寸");
  const teasing = withTags("俏皮", "爱损");
  const neutral = withTags("慢条斯理");

  assert.ok(reasonPersonality(mixed).teaseFactor > 0, "混合标签不归零");
  assert.ok(reasonPersonality(quiet).teaseFactor > 0, "憋着也只是压分量，不是一刀切");
  assert.ok(reasonPersonality(mixed).teaseFactor > reasonPersonality(quiet).teaseFactor, "有俏皮那面就比纯憋着高");
  assert.ok(reasonPersonality(mixed).teaseFactor >= reasonPersonality(neutral).teaseFactor, "混合标签不被压到中性以下");
  assert.equal(reasonPersonality(mixed).temperament, "outgoing", "混合标签以会贫嘴为主");
  assert.equal(reasonPersonality(quiet).temperament, "reserved");
  assert.equal(reasonPersonality(null).temperament, "neutral", "没配过性格就按中性算");

  const teaseOf = (personality) => weightOf(reasonWeights({ relationship: CLOSE, hasContext: true, personality }), "tease");
  assert.ok(teaseOf(mixed) > teaseOf(quiet));
  assert.ok(teaseOf(quiet) > 0 && teaseOf(quiet) < teaseOf(withTags("慢条斯理")));
  assert.ok(teaseOf(teasing) > teaseOf(mixed), "会贫嘴的抬得最高");
});

test("性格分开影响搭话和想念：憋着的人搭话少，想念只是憋着", () => {
  const quiet = withTags("安静", "有分寸");
  const teasing = withTags("俏皮", "爱损");
  const ratioOf = (personality) => {
    const rows = reasonWeights({ relationship: INTIMATE, personality });
    const affection = weightOf(rows, "affection");
    return weightOf(rows, "contact") / affection;
  };
  assert.ok(ratioOf(quiet) < ratioOf(teasing), "同一份关系账下，憋着的人搭话占比更低");
  assert.ok(ratioOf(quiet) > 0 && ratioOf(teasing) > 0, "两边都不归零");
  assert.ok(reasonPersonality(quiet).affectionFactor < 1, "想念压一点，不压没");
  assert.ok(reasonPersonality(quiet).contactFactor < reasonPersonality(quiet).affectionFactor, "搭话压得比想念狠");
});

test("没有真凭据，共同经历和吐槽不进候选", () => {
  const rows = reasonWeights({ relationship: INTIMATE, hasContext: false, personality: withTags("俏皮") });
  assert.equal(weightOf(rows, "shared"), 0);
  assert.equal(weightOf(rows, "tease"), 0);
  assert.ok(weightOf(rows, "contact") > 0, "搭话不需要凭据");
  assert.ok(weightOf(rows, "affection") > 0);
});

test("兴趣那一份不因这层被放宽：没有过锚点门的素材就是没有", () => {
  assert.equal(weightOf(reasonWeights({ relationship: CLOSE, interestAvailable: false }), "interest"), 0);
  assert.equal(weightOf(reasonWeights({ relationship: CLOSE, interestAvailable: true }), "interest"), 1);
});

test("抽签可注入：落点固定时挑的就是那一条", () => {
  const picked = pickReason({ relationship: CLOSE, hasContext: true, rnd: () => 0 });
  assert.ok(picked.reason);
  assert.equal(picked.candidates[0].kind, picked.reason.kind, "rnd=0 落在第一条候选上");
  assert.equal(picked.basis.familiarity, relationBasis(CLOSE).familiarity);
  assert.equal(picked.temperament, "neutral");
});

test("没有候选时不硬造一条", () => {
  const picked = pickReason({ relationship: STRANGER, hasContext: true, rnd: () => 0.99 });
  assert.ok(picked.candidates.some((row) => row.kind === "shared"));
  const empty = pickReason({ relationship: STRANGER, hasContext: false, rnd: () => 0 });
  assert.equal(empty.reason, null);
  assert.deepEqual(empty.candidates, []);
});

test("理由归一：认不出来的 kind 和缺凭据的共同经历都当没有", () => {
  assert.equal(normalizeReason({ kind: "whatever" }), null);
  assert.equal(normalizeReason(null), null);
  assert.equal(normalizeReason({ kind: "shared" }), null, "共同经历没有凭据就不算由头");
  assert.equal(normalizeReason({ kind: "tease", contextText: "   " }), null);
  assert.equal(normalizeReason({ kind: "shared" }, { requireContext: false }).kind, "shared");
  const contact = normalizeReason({ kind: "contact", familiarity: 0.6, intimacy: 2 });
  assert.equal(contact.contextText, "");
  assert.equal(contact.familiarity, 0.6);
  assert.equal(contact.intimacy, 1, "越界的折算回 1");
});

test("凭据每一样都标清出处，去重段单独标", () => {
  const text = buildReasonContext({
    sceneEcho: { userText: "你那个花盆到底挪哪了", assistantText: "挪到窗台了" },
    workfeedText: "14:02 讨论了落点",
    sentTexts: ["昨天说过那盆土换过"],
  });
  assert.match(text, /【你们最近确实在这条对话里聊过/);
  assert.doesNotMatch(text, /你那个花盆到底挪哪了/, "不再摘上一轮原话");
  assert.doesNotMatch(text, /挪到窗台了/, "不再摘上一轮原话");
  assert.match(text, /【电脑那边这位伙伴确实有过的动静/);
  assert.match(text, /【你已经实际说过的话/);
  assert.equal(buildReasonContext({}), "");
  assert.equal(buildReasonContext({ sceneEcho: null, sentTexts: ["  "] }), "", "空的近况不占位");
});

test("想念和搭话没有凭据要求", () => {
  const affection = enrichReasonContext({ kind: "affection" }, {});
  assert.equal(affection.reason.kind, "affection");
  assert.equal(affection.reason.contextText, "");
  assert.equal(affection.dropped, false);
});

test("已经介绍过什么：普通回复也算送出过的正文", () => {
  const messages = [
    { role: "user", text: "她说的那句" },
    { role: "assistant", text: "这条是当面回她的正文" },
    { role: "assistant", proactive: true, text: "这条是主动说的正文" },
  ];
  assert.equal(introducedTextFrom(messages), "这条是当面回她的正文\n这条是主动说的正文");
});

test("已经介绍过什么：逐条完整，总长封顶时换行也算钱", () => {
  const rows = [
    { role: "assistant", proactive: true, text: "A".repeat(10) },
    { role: "assistant", proactive: true, text: "B".repeat(10) },
  ];
  assert.equal(introducedTextFrom(rows, { budget: 21 }).length, 21, "两条加换行刚好 21");
  assert.equal(introducedTextFrom(rows, { budget: 20 }), "B".repeat(10), "差一个换行位就只留最后一条");
});

test("已经介绍过什么：单条就超预算就跳过，不硬塞第一条", () => {
  const rows = [
    { role: "assistant", proactive: true, text: "X".repeat(500) },
    { role: "assistant", proactive: true, text: "后面这条短" },
  ];
  assert.equal(introducedTextFrom(rows, { budget: 100 }), "后面这条短");
  assert.equal(introducedTextFrom([{ role: "assistant", text: "X".repeat(500) }], { budget: 100 }), "");
});

test("已经介绍过什么：撤掉的、动作戳和酒馆开场都不算正文", () => {
  const messages = [
    { role: "assistant", text: "撤掉的这条", recalled: true },
    { role: "assistant", kind: "action", text: "[戳]" },
    { role: "assistant", kind: "poke", text: "戳一下" },
    { role: "assistant", kind: "tavern-opening", text: "初次见面的问候" },
    { role: "assistant", proactive: true, text: " " },
    { role: "assistant", proactive: true, text: "真的送出去了" },
  ];
  assert.equal(introducedTextFrom(messages), "真的送出去了");
});

test("已经介绍过什么：最多十二条，且不替她补全后台的种子", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ role: "assistant", proactive: true, text: `第${i}条` }));
  const text = introducedTextFrom(many);
  assert.equal(text.split("\n").length, 12);
  assert.equal(text.split("\n")[0], "第8条");
  assert.equal(introducedTextFrom([]), "", "没有证据就当首次介绍");
});

// ── 走真路由的行为验证：/proactive/tick ──────────────────────────

const AGENT = "nova";
const HOUR = 3600_000;

const clockAt = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/** 工作对话那本账用的是生活日，口径跟 dayKey 一样（本地时区）。 */
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 把静默窗和作息窗都推到离现在很远的地方，避免测试跑在半夜或凌晨时误判。 */
function farWindows(now) {
  const base = new Date(now.getTime() + 7 * HOUR);
  const start = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
  const end = `${pad((base.getHours() + 1) % 24)}:${pad(base.getMinutes())}`;
  return {
    quiet: { start, end },
    sleep: { shape: 2, start, hours: 7, nap: { start: end, minutes: 20 } },
  };
}

function seedWorld(store, now = new Date()) {
  const windows = farWindows(now);
  store.setGlobalSettings({ rhythmProactiveEnabled: true, quiet: windows.quiet });
  store.setPartnerSettings(AGENT, {
    proactiveEnabled: true,
    tier: "often",
    // 指定模型：这样主动开口走聊天通道（模型桩可控），而不是拿不到正文的后台通道
    model: { provider: "test-provider", model: "test-model" },
    hobbySeedTryAt: clockAt(0),
    sleep: windows.sleep,
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
        id: "seed_test_1", motifId: "m1", motifName: "旧物", kind: "curio",
        hook: "那盏旧台灯", angle: "还没想明白它到底该放哪",
        createdAt: clockAt(-HOUR), expiresAt: clockAt(3 * 24 * HOUR), usedAt: null,
      }],
    },
  });
  return windows;
}

const seed = (store) => seedWorld(store);

/**
 * 主动开口走后台 utility 通道。把这一路换成可控正文。
 * 语义核查那一次固定回 send：那是拿模型桩顶替的判定，只保证这条消息能发出去，
 * 不证明它真的清楚——真判语义是另一回事。
 */
const CLARITY_MARKER = "检查一条准备发出的普通私聊主动消息";
function stubUtility(app, text) {
  const calls = [];
  app.ctx.models.utility = async (request = {}) => {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const prompt = messages.map((row) => String(row?.content ?? "")).join("\n");
    const systemPrompt = String(request.systemPrompt ?? "");
    const clarity = systemPrompt.includes(CLARITY_MARKER);
    calls.push({ clarity, prompt });
    return { requestId: "utility_test", text: clarity ? '{"decision":"send"}' : text };
  };
  return calls;
}

const lastProactive = (messages) => [...messages].reverse().find((row) => row.proactive === true) ?? null;

/** 抽签落在哪一条：按候选权重算出对应的随机值。 */
function rndForKind(relationship, personality, kind, { interestAvailable, hasContext }) {
  const rows = reasonWeights({ relationship, personality, interestAvailable, hasContext });
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  const index = rows.findIndex((row) => row.kind === kind);
  assert.notEqual(index, -1, `${kind} 这一轮不在候选里`);
  const before = rows.slice(0, index).reduce((sum, row) => sum + row.weight, 0);
  return (before + rows[index].weight / 2) / total;
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

/** 临时数据目录是这一轮自己建的，测完只删自己那一份。 */
function cleanupOn(t, app) {
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
}

/** 应用自己那份 store 是内存态；要看真的落盘结果就重开一份。 */
function diskState(app) {
  return createStore(app.dataDir).getProactiveState(AGENT);
}

test("行为：拿关系式由头开口时，不注入兴趣素材也不消耗种子", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: clockAt(0), at: clockAt(-0.4 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", text: "亮着呢", at: clockAt(-0.3 * HOUR) });
  const calls = stubUtility(app, "路过那家旧书摊，忽然想起你那盏台灯放窗台挺好");

  const knowing = store.getKnowing(AGENT);
  const rnd = rndForKind(knowing.relationship, knowing.personality, "contact", { interestAvailable: true, hasContext: true });
  const response = await withRandom(rnd, () => app.request("POST", "/proactive/tick", { json: {} }));
  assert.equal(response.status, 200);

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "这一轮真的发出去一条主动消息");
  assert.equal(sent.proactiveContext.kind, "reason");
  assert.equal(sent.proactiveContext.reason.kind, "contact");
  assert.equal(sent.seedId, null, "关系式由头这条不挂任何种子");
  assert.equal(diskState(app).topicSeeds.seeds[0].usedAt, null, "种子没被消耗，下一轮还能用");
  assert.equal(reopenThread(app.dataDir, AGENT).at(-1).proactiveContext.reason.kind, "contact", "真的落到账本上了");
  assert.ok(calls.some((row) => !row.clarity && row.prompt.length > 0), "确实调了一次生成");
});

test("行为：上一条还没被接住时，关系式由头不绕过去", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: clockAt(0), at: clockAt(-0.5 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", text: "亮着呢", at: clockAt(-0.4 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", text: "我改天拍给你看", proactive: true, at: clockAt(-0.2 * HOUR) });
  stubUtility(app, "顺手把窗台擦了一遍");

  const knowing = store.getKnowing(AGENT);
  const rnd = rndForKind(knowing.relationship, knowing.personality, "contact", { interestAvailable: true, hasContext: true });
  await withRandom(rnd, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent && sent.text === "顺手把窗台擦了一遍", "又发了一条");
  assert.equal(sent.proactiveContext.kind, "unread-followup", "走的还是已读未回那条护栏");
  assert.equal(sent.proactiveContext.reason, undefined, "没被接住的时候不给关系式由头开口");
});

test("行为：老路没坏——抽到兴趣那一条时照旧注入并消耗种子", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: clockAt(0), at: clockAt(-0.4 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", text: "亮着呢", at: clockAt(-0.3 * HOUR) });
  stubUtility(app, "那盏台灯我到现在也没想明白该搁哪儿，先放窗台了");

  await withRandom(0, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent);
  assert.equal(sent.seedId, "seed_test_1", "兴趣那一条照旧带着种子");
  assert.equal(sent.proactiveContext, null, "兴趣那一条不带关系式由头");
  assert.ok(diskState(app).topicSeeds.seeds[0].usedAt, "发出去才算用过");
});

test("行为：有真凭据的共同经历能发出去，凭据直接进到生成里", { skip: SKIP_DEV }, async (t) => {
  const app = await bootChahuahui({ seed });
  cleanupOn(t, app);
  const store = app.store;
  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: clockAt(0), at: clockAt(-0.4 * HOUR) });
  store.appendMessage(AGENT, { role: "assistant", text: "亮着呢", at: clockAt(-0.3 * HOUR) });
  store.appendWorkEvent({
    id: "wf_1", agentId: AGENT, at: clockAt(-60_000), role: "user", lifeDay: todayKey(),
    text: "刚顺手改了个配色", sourceKind: "computer-conversation", conversationId: "c1",
  });
  const calls = stubUtility(app, "刚看你那边改了配色，这个看着挺利索");

  const knowing = store.getKnowing(AGENT);
  const rnd = rndForKind(knowing.relationship, knowing.personality, "shared", { interestAvailable: true, hasContext: true });
  await withRandom(rnd, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "凭据齐的时候能发出去");
  assert.equal(sent.proactiveContext.reason.kind, "shared");
  // 2026-10-20：后台还会顺手养护一次世界领域（同一路 utility 通道），
  // 所以不能按“第一条非核查调用”取生成，按凭据原文认那一条。
  const generation = calls.find((row) => !row.clarity && /刚顺手改了个配色/.test(row.prompt));
  assert.ok(generation, "凭据直接进到生成里");
  assert.equal(diskState(app).topicSeeds.seeds[0].usedAt, null, "这一轮也不消耗兴趣种子");
});

test("行为：观察式今天已经用满，新闻照样轮得到", { skip: SKIP_DEV }, async (t) => {
  // 世界领域和新闻池得在装载前写：应用开机时把账本读进内存，
  // 开机后再用另一个 store 实例改盘不会同步过去（这一点在数据层测试里也踩过）。
  const app = await bootChahuahui({
    seed: (store) => {
      seedWorld(store);
      const nowIso = new Date().toISOString();
      store.saveKnowing(AGENT, {
        ...store.getKnowing(AGENT),
        worldInterests: [
          { id: "wi_shuma", name: "数码更新", domains: ["新手机 评测"], createdAt: nowIso },
          { id: "wi_yule", name: "娱乐圈吃瓜", domains: ["内娱 热搜"], createdAt: nowIso },
        ],
      });
      // 新闻池里有一条现成的，且刚到过货：这一轮不会再出去搜。
      store.setProactiveState(AGENT, {
        ...store.getProactiveState(AGENT),
        newsBook: {
          lastFetchAt: nowIso,
          lastDomainId: "wi_shuma",
          items: [{
            id: "news_test_1", domainId: "wi_shuma", domainName: "数码更新",
            title: "某家手机把耳机孔又塞回来了", snippet: "新款把 3.5mm 接口装回去了，评论区在吵。",
            createdAt: nowIso, expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
          }],
          history: [],
        },
      });
    },
  });
  cleanupOn(t, app);
  const store = app.store;
  const nowIso = new Date().toISOString();

  store.appendMessage(AGENT, { role: "user", text: "你那个台灯还亮着吗", readAt: nowIso, at: nowIso });
  // 今天已经发过两条带种子的观察式：剩下的一天里观察这类就不能再占位。
  // 2026-10-28 配比实验把上限从 1 抬到 2，所以这里凑两条才算「用满」；
  // 回滚之后上限回到 1，两条同样算用满，这条用例两边都成立。
  store.appendMessage(AGENT, {
    role: "assistant", text: "我总觉得那盏灯搁窗台才顺眼", proactive: true,
    seedId: "seed_test_1", at: nowIso,
  });
  store.appendMessage(AGENT, {
    role: "assistant", text: "台灯挪来挪去，最后还是老位置最顺", proactive: true,
    seedId: "seed_test_2", at: nowIso,
  });

  const calls = stubUtility(app, "刚看到某家手机把耳机孔塞回来了，评论区已经在怀旧");
  const next = store.getKnowing(AGENT);
  const rnd = rndForKind(next.relationship, next.personality, "interest", { interestAvailable: true, hasContext: false });
  await withRandom(rnd, () => app.request("POST", "/proactive/tick", { json: {} }));

  const sent = lastProactive(store.getThread(AGENT).messages);
  assert.ok(sent, "观察式名额用满并不影响这一条发出去");
  assert.equal(sent.newsId, "news_test_1", "这一条带的是新闻，不是第二条观察式");
  assert.ok(calls.some((row) => !row.clarity), "真的调了一次生成");
});