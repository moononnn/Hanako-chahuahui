import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { bootChahuahui as bootHarness, reopenThread, fakeWavBase64 } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";

/**
 * 长期记忆的端到端接线：真的 apply(ctx)、真的路由、真的 memory.json，
 * 只有宿主出口是假的（models.stream / models.utility / bus / network）。
 *
 * 这里验的是「请求里带了什么、账本上留下了什么」，不是纯函数的形状；
 * 纯函数那一层在 tests/longterm.test.js。
 *
 * 契约（与 lib/longterm.js 对齐）：
 *   memory.longterm[] = { id, kind:'event|symbol|fact', title, text, keys[],
 *     sourceIds[], at, updatedAt, certainty:'held|uncertain', note,
 *     feedbackSourceIds[], resultMessageIds[] }
 *   回复尾部协议 <memory-update>{"updates":[{id,decision:'hold|doubt|revise',
 *     text?,note,sourceId,quote}]}</memory-update>
 */

const AGENT = "nova";

/** 条目块与反馈块在提示词里的固定标题，用它判断「这一轮到底带没带」。 */
const ENTRY_HEADER = "【长期记忆：伙伴当前认知】";
const FEEDBACK_HEADER = "【仅本轮的记忆反馈】";

const KEY = "柠檬蛋糕";
const QUOTE = "不是排队那家，是巷子里那家";

/** 让 ta 面对面拿着手机，并把未读节奏压到毫秒级，测试才跑得完。 */
function seedReady(store) {
  store.setPartnerSettings(AGENT, {
    phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
    rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
    voice: { enabled: false },
  });
}

/** 删回复入口要显式打开，撤回复不要求。 */
function seedRefineReady(store) {
  seedReady(store);
  store.setGlobalSettings({ messageRefine: true });
}

/** 打开语音：全局模型走非 t2a 的 chat/completions，出口是 ctx.network.fetch。 */
function seedVoiceReady(store) {
  seedReady(store);
  store.setGlobalSettings({
    voiceEnabled: true,
    voiceModel: { baseUrl: "https://voice.test", model: "voice-test", apiKey: "test-key", protocol: "chat" },
  });
  store.setPartnerSettings(AGENT, { voice: { enabled: true, voiceId: "female-shaonv", tier: "often" } });
}

const post = (request, body) => request("POST", "/turns", {
  json: { agentId: AGENT, watching: true, ...body },
});

/**
 * 直接往 memory.json 里放条目，绕过 rollup。
 * rollup 那条路要驱动足量消息并等记忆 stream，测的是另一件事（素材与批量整理）。
 * 这里要固定的是「账上已经有条目时，生成路径怎么用它」。
 */
function seedEntries(store, rows) {
  const memory = store.readMemory(AGENT);
  store.writeMemory(AGENT, { ...memory, facts: [], longterm: rows });
  return store.readMemory(AGENT).longterm;
}

/** 从磁盘重新读一遍：证明留下的是文件里的东西，不是内存里的残留。 */
function rereadMemory(dataDir) {
  return createStore(dataDir).readMemory(AGENT);
}

const lemonEntry = () => ({
  kind: "event",
  title: KEY,
  text: "她第一次说想吃柠檬蛋糕，是在那家排队的店门口。",
  keys: [KEY],
  sourceIds: ["m_seed_lemon"],
  certainty: "held",
  note: "",
});

/** 噪音条目：词汇与查询互不重叠，也不含「那个事」这类会和查询撞上的三字串。 */
const NOISE_WORDS = [
  "旧唱机", "阳台薄荷", "巷口面馆", "冬眠仓鼠", "旧胶片", "楼道灯",
  "木柄伞", "晒台花盆", "铜制门牌", "折页日历", "铁皮青蛙", "缺角瓷碗",
  "后院葡萄", "手摇咖啡", "竹编提篮", "褪色围巾", "木梯滑梯", "玻璃罐头",
  "纸箱风筝", "青石台阶", "藤编躺椅", "搪瓷缸子", "樟木箱子", "缝纫篮子",
];

function noiseEntries() {
  //  noises 用 event，不用 symbol：symbol（专属称呼、共用栗、暗号）从 2026-10-24 起有恒驻特权，
  // 不管这轮聊什么都占上两格。拿它当「不该出现的无关条目」，测的就不再是相关度而是恒驻层了。
  return NOISE_WORDS.map((word) => ({
    kind: "event",
    title: word,
    text: `关于${word}的一件旧事，细节已经记不清了。`,
    keys: [word],
    sourceIds: [`m_seed_noise_${word}`],
    certainty: "held",
    note: "",
  }));
}

const wrap = (updates) => `<memory-update>${JSON.stringify({ updates })}</memory-update>`;

async function waitTurn(request, turnId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await request("GET", `/turns/${turnId}`);
    if (predicate(state.body)) return state.body;
    if (Date.now() > deadline) return state.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 记下后台 utility 出口：反馈不许自己再发一次后台模型调用。 */
function watchUtility(app) {
  const seen = [];
  const original = app.ctx.models.utility;
  app.ctx.models.utility = async (request) => {
    seen.push(request);
    return original(request);
  };
  return {
    seen,
    dump: () => seen.map((row) => { try { return JSON.stringify(row); } catch { return ""; } }),
  };
}

const systemPromptOf = (app, index = 0) => String(app.models.calls[index]?.request?.systemPrompt ?? "");

// ── 整理（maybeRollup）：直达 /memory/:agentId/tidy，不用等后台 ─────

/** 把 keepMessages / rollupMinMessages 压小，几条消息就能凑出一批溢出。 */
const ROLLUP_CONTEXT = {
  keepMessages: 2,
  keepChars: 400,
  rollupMinMessages: 3,
  keepTurns: 1,
  rollupEveryTurns: 1,
  rollupBatchMax: 80,
  maxArchive: 3,
  maxLedger: 7,
  maxFacts: 12,
};

const ROLLUP_TOPIC = "烤红薯";
const ROLLUP_SECOND_USER_TEXT = "上回其实是在巷口那家买的";
const SEGMENT_TEXT = "她们聊到了烤红薯在哪家买。";
const PROFILE_TEXT = "她对吃的摊子挺上心。";

function seedRollupReady(store) {
  seedReady(store);
  store.setPref(AGENT, { context: ROLLUP_CONTEXT });
}

/**
 * 落一段近期对话，返回真实消息 id。
 * id 是 store 自己生成的，测试不手写，一律从这里取。
 */
function seedThread(store, rows) {
  const now = Date.now();
  return rows.map((row, index) => store.appendMessage(AGENT, {
    at: new Date(now - (rows.length - index) * 60_000).toISOString(),
    ...row,
  }).id);
}

/** keepMessages=2 时，批次就是除最后两条之外的全部。 */
const rollupRows = () => [
  { role: "user", text: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
  { role: "assistant", text: "桥头那个还在，不过六点就收了" },
  { role: "user", text: ROLLUP_SECOND_USER_TEXT },
  { role: "assistant", text: "巷口那家啊，那天风挺大" },
  { role: "user", text: `${ROLLUP_TOPIC}我下次自己去买` },
  { role: "assistant", text: "行，记得给我留一块" },
];

/** 按 systemPrompt 区分记忆整理的各类后台调用。 */
function utilityKind(systemPrompt) {
  const s = String(systemPrompt ?? "");
  if (s.includes("还没聊透的话题")) return "topics";
  if (s.includes("长期条目")) return "longterm";
  if (s.includes("我认识的她")) return "profile";
  if (s.includes("滚出最近的上下文")) return "segment";
  if (s.includes("记一天的账")) return "daily";
  return "unknown";
}

const utilityTextOf = (entry) => String(entry?.request?.messages?.[0]?.content ?? "");

/**
 * 记忆整理已从 utility 改走 stream；保留原 helper 名，调用用例不挪动。
 * hold 里的那类会挂住，由测试决定什么时候放，保留撤回期间的在途窗口。
 * 普通聊天转交原 harness；utility 只观测，不能冒充记忆整理响应。
 */
function stubUtility(app, { hold = [], answers = {} } = {}) {
  const held = new Set(hold);
  const calls = [];
  const otherStreams = [];
  const utility = watchUtility(app);
  const originalStream = app.ctx.models.stream;
  app.ctx.models.stream = async (request) => {
    const kind = utilityKind(request?.systemPrompt);
    if (kind === "unknown") {
      otherStreams.push({ kind, request });
      return originalStream(request);
    }
    const entry = { kind, request, answer: answers[kind] ?? "", pending: held.has(kind), resolve: null };
    calls.push(entry);
    const response = () => ({
      text: async () => [
        { type: "text-delta", requestId: request.requestId, delta: entry.answer },
        { type: "done", requestId: request.requestId, stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text: entry.answer }] } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    });
    if (!entry.pending) return response();
    return new Promise((resolve) => {
      entry.resolve = () => resolve(response());
    });
  };
  const ofKind = (kind) => (kind === "unknown" ? otherStreams : calls.filter((row) => row.kind === kind));
  return {
    calls,
    otherStreams,
    utility,
    of: ofKind,
    /** 等这一类里第 from 次（从0起）调用挂住，返回那一条。 */
    async waitFor(kind, from = 0, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = ofKind(kind)[from];
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`等待记忆 stream 的 ${kind}#${from} 超时（实际：${calls.map((row) => row.kind).join(",") || "无"}）`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release(entry, text) {
      entry.answer = text;
      entry.pending = false;
      entry.resolve?.();
    },
  };
}

/** 普通聊天也会排后台记忆任务，不能让它们占用聊天 harness 的调用编号。 */
async function bootChahuahui(options) {
  const app = await bootHarness(options);
  app.memoryStream = stubUtility(app, { answers: {
    ...defaultAnswers, segment: SEGMENT_TEXT, longterm: '{"facts":[],"entries":[]}',
  } });
  return app;
}

const tidy = (request) => request("POST", `/memory/${AGENT}/tidy`, { json: {} });
const watermark = (app) => app.store.getThread(AGENT).rolledThroughId ?? null;

/** 有效的 {facts:[],entries:[…]}：来源、逐字证据、keys 都对得上材料。 */
function entryPayload(ids) {
  return {
    facts: [],
    entries: [{
      kind: "event",
      title: `${ROLLUP_TOPIC}是哪家`,
      text: `她买${ROLLUP_TOPIC}是在巷口那家，不是桥头那个摊子。`,
      keys: [ROLLUP_TOPIC],
      sourceIds: [ids[0], ids[2]],
      evidence: [
        { sourceId: ids[0], quote: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
        { sourceId: ids[2], quote: ROLLUP_SECOND_USER_TEXT },
      ],
    }],
  };
}

const defaultAnswers = { profile: PROFILE_TEXT, topics: "[]", daily: "这一天没什么特别。" };

/** 整理这两步必须挂住：既要核对请求内容，也要在它们在途时做撤回。 */
const HELD = ["segment", "longterm"];

// ── 旧稿作废①：回复目标在落盘前没了 → stale，正文与反馈都不落盘 ────

test("回复目标在落盘前被撤回：这一轮按 stale 收场，正文与记忆反馈都不落盘", async () => {
  const audio = fakeWavBase64();
  const voiceReply = { choices: [{ message: { audio: { data: audio } } }] };

  // 语音要不要出鞘是掷骰子的；正文得够长（超过最短字数）才真的会发。
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const app = await bootChahuahui({ seed: seedVoiceReady });
    const [target] = seedEntries(app.store, [lemonEntry()]);

    const turn = await post(app.request, { text: `${KEY}那家我记错了，${QUOTE}`, clientMessageId: "m_lt_stale_001" });
    await app.models.waitForCall(0);
    // 反馈是合法的：条目被选中、quote 逐字对得上、decision 合法。
    // 语音合成在途，恰好是「已解析反馈、尚未落盘」那个窗口。
    app.models.release(0, "那就巷子里那家，我记住了"
      + wrap([{ id: target.id, decision: "revise", text: `${KEY}是巷子里那家。`, note: "听她的", sourceId: turn.body.messageId, quote: QUOTE }]));
    await app.net.waitForCall(0);

    // 撤回路由在生成期间会因 processing 挡下来（这是对的），所以这里不走路由，
    // 直接用 store 复现它会写下的那个状态：把本轮目标标成已撤回。
    app.store.patchMessage(AGENT, turn.body.messageId, {
      kind: "recalled", text: "你撤回了一条消息", recalled: true, recallMode: "hard",
    });
    app.net.release(0, voiceReply);

    const done = await waitTurn(app.request, turn.body.turnId, (state) => state.status === "ready");
    assert.equal(done.replyMessageId, null, `目标没了就不该再落回复：${JSON.stringify(done)}`);

    const rows = reopenThread(app.dataDir, AGENT);
    assert.equal(rows.filter((row) => row.role === "assistant" && !row.recalled).length, 0, "线程里不该多出任何伙伴回复");
    assert.equal(rows.some((row) => row.id === turn.body.messageId && row.recalled), true, "前置：目标确实已被撤回");

    // 没落盘的那条回复，也不该留下音频文件。
    const voiceDir = path.join(app.dataDir, "v2", "voice", AGENT);
    const files = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
    assert.deepEqual(files, [], `没落盘的回复不该留下语音文件：${JSON.stringify(files)}`);

    const after = rereadMemory(app.dataDir).longterm.find((row) => row.id === target.id);
    assert.ok(after, "条目本身不该被这次作废牵连");
    assert.equal(after.text, "她第一次说想吃柠檬蛋糕，是在那家排队的店门口。", "作废的 revise 不许改掉条目内容");
    assert.equal(after.note, "", "作废的稿子连记忆判断都不许落");
    assert.deepEqual(after.feedbackSourceIds, [], "不许留下反馈来源");
    assert.deepEqual(after.resultMessageIds, [], "不许留下结果消息编号");
  } finally {
    Math.random = realRandom;
  }
});

// ── 资格边界回归：批末已接住的主动消息，两边材料都得在 ───────────

test("整理：批末主动消息的回应落在未整理窗口里，两边材料都保留它并能当证据写成条目", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const MONOLOGUE_A = "我在盘算明天要不要把那台旧刻机搬回来";
  const MONOLOGUE_B = "顺口提一句今天的光线很好";
  const MONOLOGUE_C = "要不要把那盆绿萝也搬过来";

  // proC 是批次的最后一条，而接它的那句（绿萝我搬过来了）落在未整理的窗口里。
  // 按完整线程算，proC 确实被接住；旧写法会在截断后的批次里把它当成尾部没人接的
  // 独白再删一次，于是它进不了 longterm 材料，也没法当证据。
  const ids = seedThread(app.store, [
    { role: "user", text: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
    { role: "assistant", text: "桥头那个还在，不过六点就收了" },
    { role: "user", text: ROLLUP_SECOND_USER_TEXT },
    { role: "assistant", text: "巷口那家啊，那天风挺大" },
    { role: "assistant", text: MONOLOGUE_A, proactive: true },
    { role: "assistant", text: MONOLOGUE_B, proactive: true },
    { role: "assistant", text: MONOLOGUE_C, proactive: true },
    { role: "user", text: "绿萝我搬过来了" },
    { role: "assistant", text: "那挺好" },
  ]);

  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });
  const pending = tidy(app.request);
  const segment = await util.waitFor("segment");
  util.release(segment, SEGMENT_TEXT);
  const longterm = await util.waitFor("longterm");

  // 两边材料都在场，且只有真正没人接的那两条不在。
  const segmentText = utilityTextOf(util.of("segment")[0]);
  const material = utilityTextOf(util.of("longterm")[0]);
  assert.ok(segmentText.includes(MONOLOGUE_C), "摘要材料里要有批末那条");
  assert.ok(material.includes(MONOLOGUE_C), `longterm 抽取材料里也必须有批末那条（${MONOLOGUE_C}）`);
  assert.ok(material.includes(ids[6]), "longterm 材料里要有它的消息 id");
  assert.equal(material.includes(MONOLOGUE_A), false, "真的没人接的独白仍不得进材料");
  assert.equal(material.includes(MONOLOGUE_B), false, "真的没人接的独白仍不得进材料");

  // 模型以「它 + 一条有效用户原话」为来源写条目，双方各带逐字 quote。
  util.release(longterm, JSON.stringify({
    facts: [],
    entries: [{
      kind: "event",
      title: "绿萝要搬过来",
      text: "ta问要不要把那盆绿萝也搬过来。",
      keys: ["绿萝"],
      sourceIds: [ids[0], ids[6]],
      evidence: [
        { sourceId: ids[0], quote: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
        { sourceId: ids[6], quote: MONOLOGUE_C },
      ],
    }],
  }));

  const res = await pending;
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.rolled.rolled, true, JSON.stringify(res.body.rolled));

  const memory = rereadMemory(app.dataDir);
  assert.equal(memory.longterm.length, 1, `这条以批末主动消息为来源的条目应当写进来：${JSON.stringify(memory.longterm)}`);
  assert.deepEqual(memory.longterm[0].sourceIds, [ids[0], ids[6]], "两个来源都要在");
  assert.equal(memory.longterm[0].text, "ta问要不要把那盆绿萝也搬过来。");
  assert.deepEqual(memory.longterm[0].keys, ["绿萝"]);
  assert.equal(memory.archive.length, 1);
  assert.equal(watermark(app), ids[6], "水位落到批末那条");
});

// ── 旧稿作废②：批次里那条主动消息的资格中途变了 → 整批作废 ──────

test("整理：批次里主动消息的接话资格中途变了，整批不写也不推进水位", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const MONOLOGUE_A = "我在盘算明天要不要把那台旧刻机搬回来";
  const MONOLOGUE_B = "顺口提一句今天的光线很好";
  const MONOLOGUE_C = "要不要把那盆绿萝也搬过来";

  // proA/proB 后面紧跟另一条主动消息，没被接；proC 后面有她真人的话，算接过。
  // keepMessages=2，所以 proC 是批次的最后一条，而接它的那句落在窗口里、不在批次里。
  const ids = seedThread(app.store, [
    { role: "user", text: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
    { role: "assistant", text: "桥头那个还在，不过六点就收了" },
    { role: "user", text: ROLLUP_SECOND_USER_TEXT },
    { role: "assistant", text: "巷口那家啊，那天风挺大" },
    { role: "assistant", text: MONOLOGUE_A, proactive: true },
    { role: "assistant", text: MONOLOGUE_B, proactive: true },
    { role: "assistant", text: MONOLOGUE_C, proactive: true },
    { role: "user", text: "绿萝我搬过来了" },
    { role: "assistant", text: "那挺好" },
  ]);
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  const pending = tidy(app.request);
  const segment = await util.waitFor("segment");
  util.release(segment, SEGMENT_TEXT);
  const longterm = await util.waitFor("longterm");

  // 前置核对：计划时 proC 确实算被接住——segment 与 longterm 两边材料都该有它；
  // proA/proB 确实没被接，两边都不进。
  const segmentText = utilityTextOf(util.of("segment")[0]);
  const material = utilityTextOf(util.of("longterm")[0]);
  assert.ok(segmentText.includes(MONOLOGUE_C), `前置：proC 在计划时算被接住，应当在材料里（${MONOLOGUE_C}）`);
  assert.ok(material.includes(MONOLOGUE_C), "前置：proC 在 longterm 材料里也该在");
  assert.equal(segmentText.includes(MONOLOGUE_A), false, "前置：proA 不该在材料里");
  assert.equal(segmentText.includes(MONOLOGUE_B), false, "前置：proB 不该在材料里");

  // 把接住 proC 的那句原话撤回（未被看过，无痕那种）。
  // 那个位置一变，proC 就从「被接住」变成「没人接」，资格翻转。
  const recalled = await app.request("POST", `/thread/${AGENT}/retract/${ids[7]}`);
  assert.equal(recalled.body.ok, true, JSON.stringify(recalled.body));
  assert.equal(recalled.body.mode, "removed");

  util.release(longterm, JSON.stringify(entryPayload(ids)));
  const res = await pending;
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.rolled.rolled, false, JSON.stringify(res.body.rolled));
  assert.equal(res.body.rolled.reason, "source-changed", "资格变了就得整批作废，哪怕条目自己的来源都还在");

  const memory = rereadMemory(app.dataDir);
  assert.deepEqual(memory.longterm, [], "不写条目");
  assert.deepEqual(memory.archive, [], "也不写摘要");
  assert.equal(watermark(app), null, "水位不推进");
});

// ── 旧稿作废③：新提取 facts 固定 []，非空即挡 ────────────────────

test("整理：结果里带了非空 facts（无逐字证据）就被挡，稳定事实只走 entries", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const ids = seedThread(app.store, rollupRows());
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  const factEntry = {
    kind: "fact",
    title: `${ROLLUP_TOPIC}她爱吃`,
    text: `她说过想吃${ROLLUP_TOPIC}。`,
    keys: [ROLLUP_TOPIC],
    sourceIds: [ids[0]],
    evidence: [{ sourceId: ids[0], quote: `${ROLLUP_TOPIC}的摊子还在桥头对吧` }],
  };

  // 第一次：模型同时给了旧事实字段和条目。
  const firstRun = tidy(app.request);
  const seg1 = await util.waitFor("segment", 0);
  util.release(seg1, SEGMENT_TEXT);
  const lt1 = await util.waitFor("longterm", 0);
  util.release(lt1, JSON.stringify({
    facts: [{ fact: `她喜欢${ROLLUP_TOPIC}`, kind: "preference", sourceIds: [ids[0]], time: "" }],
    entries: [factEntry],
  }));

  const blocked = await firstRun;
  assert.equal(blocked.body.rolled.rolled, false, JSON.stringify(blocked.body.rolled));
  assert.equal(blocked.body.rolled.reason, "facts-failed", "新提取的事实字段必须固定为空，非空即整批作废");
  assert.deepEqual(rereadMemory(app.dataDir).longterm, [], "挡下时连条目也不能写");
  assert.deepEqual(rereadMemory(app.dataDir).archive, [], "挡下时摘要也不能写");
  assert.equal(watermark(app), null, "挡下时水位不推进");

  // 第二次：同一场景，facts 固定 []，稳定事实只走 entries 的 fact。
  const secondRun = tidy(app.request);
  const seg2 = await util.waitFor("segment", 1);
  util.release(seg2, SEGMENT_TEXT);
  const lt2 = await util.waitFor("longterm", 1);
  util.release(lt2, JSON.stringify({ facts: [], entries: [factEntry] }));

  const ok = await secondRun;
  assert.equal(ok.body.rolled.rolled, true, JSON.stringify(ok.body.rolled));

  const memory = rereadMemory(app.dataDir);
  assert.equal(memory.longterm.length, 1, "只该有一条条目");
  assert.equal(memory.longterm[0].kind, "fact", "稳定事实走 entries 的 fact 类型");
  assert.equal(memory.longterm[0].text, `她说过想吃${ROLLUP_TOPIC}。`);
  assert.deepEqual(memory.facts, [], "新提取一律不写旧事实账");
  assert.equal(memory.archive.length, 1, "摘要只留一段");
  assert.equal(watermark(app), ids[3], "成功这一次才推进水位");
});


// ── 整理①：有效输出 → 条目 + 摘要 + 水位，且不多跑一次提取 ──────────

test("整理：有效结果写入长期条目与摘要、整理水位推进，全程只有两次后台调用", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const ids = seedThread(app.store, rollupRows());
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  assert.equal(watermark(app), null, "前置条件：还没整理过");

  const pending = tidy(app.request);
  const segment = await util.waitFor("segment");
  util.release(segment, SEGMENT_TEXT);
  const longterm = await util.waitFor("longterm");
  util.release(longterm, JSON.stringify(entryPayload(ids)));

  const res = await pending;
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.rolled.rolled, true, JSON.stringify(res.body.rolled));

  // 整理这一段就是两次后台调用：压一段摘要 + 抽一次事实/条目，没有第三次提取。
  assert.equal(util.of("segment").length, 1, "只压了一次摘要");
  assert.equal(util.of("longterm").length, 1, "事实与条目复用同一次调用，没有再抽一轮");
  assert.equal(util.of("unknown").length, 0, "不该有认不出来的后台调用");
  assert.equal(util.utility.seen.length, 0, "记忆整理不应调用 utility 或借 utility 兜底");
  assert.equal(app.models.calls.length, 0, "记忆整理不应混入普通聊天的调用队列");

  // 材料里确实是这一批消息。
  const material = utilityTextOf(util.of("longterm")[0]);
  for (const id of [ids[0], ids[2]]) {
    assert.ok(material.includes(id), `批次材料里应有这条消息：${id}`);
  }

  const memory = rereadMemory(app.dataDir);
  assert.equal(memory.longterm.length, 1, `应当只写进一条长期条目，实际：${JSON.stringify(memory.longterm)}`);
  const entry = memory.longterm[0];
  assert.equal(entry.title, `${ROLLUP_TOPIC}是哪家`);
  assert.equal(entry.text, `她买${ROLLUP_TOPIC}是在巷口那家，不是桥头那个摊子。`);
  assert.deepEqual(entry.keys, [ROLLUP_TOPIC]);
  assert.deepEqual(entry.sourceIds, [ids[0], ids[2]]);
  assert.equal(entry.certainty, "held");
  assert.equal(entry.note, "", "刚生成的条目还没有任何判断");

  assert.equal(memory.archive.length, 1, "同一批次只留一段摘要");
  assert.equal(memory.archive[0].text, SEGMENT_TEXT);
  assert.equal(memory.facts.length, 0, "条目已覆盖的内容不该再留一份旧事实");

  assert.equal(watermark(app), ids[3], "水位要落到这一批的最后一条");
});

// ── 整理②：后台等待期间撤回源话 → 条目、摘要、水位都不写回 ────────

test("整理：后台等待期间撤回源话，条目与摘要都不写回、水位不推进", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const ids = seedThread(app.store, rollupRows());
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  const pending = tidy(app.request);
  const segment = await util.waitFor("segment");
  util.release(segment, SEGMENT_TEXT);
  const longterm = await util.waitFor("longterm");

  // 第二次后台调用在途：把她引用的那句原话撤掉（没被看过，走无痕那种）。
  const recalled = await app.request("POST", `/thread/${AGENT}/retract/${ids[2]}`);
  assert.equal(recalled.body.ok, true, JSON.stringify(recalled.body));
  assert.equal(recalled.body.mode, "removed");

  util.release(longterm, JSON.stringify(entryPayload(ids)));
  const res = await pending;
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.rolled.rolled, false, JSON.stringify(res.body.rolled));
  assert.equal(res.body.rolled.reason, "source-changed", "源话变了就得整批作废");

  const memory = rereadMemory(app.dataDir);
  assert.deepEqual(memory.longterm, [], "撤回过的内容不许变成长期条目");
  assert.deepEqual(memory.archive, [], "摘要里也不许留着撤回过的原话");
  assert.equal(watermark(app), null, "这批不算整理完，水位不许推进");
});

// ── 整理③：结果坏了不推进水位，同场景重试成功且不重复 ──────────────

test("整理：结果格式坏了不推进水位，同场景重试成功且没有重复", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const ids = seedThread(app.store, rollupRows());
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  const firstRun = tidy(app.request);
  const seg1 = await util.waitFor("segment", 0);
  util.release(seg1, SEGMENT_TEXT);
  const lt1 = await util.waitFor("longterm", 0);
  util.release(lt1, "{这可不是 JSON");

  const failed = await firstRun;
  assert.equal(failed.body.rolled.rolled, false, JSON.stringify(failed.body.rolled));
  assert.equal(failed.body.rolled.reason, "facts-failed");
  assert.deepEqual(rereadMemory(app.dataDir).longterm, [], "坏结果不许留下半个条目");
  assert.deepEqual(rereadMemory(app.dataDir).archive, [], "坏结果不许留下摘要");
  assert.equal(watermark(app), null, "这批没整理成，水位不许推进");

  // 同一场景重来一次，这次给对的。
  const secondRun = tidy(app.request);
  const seg2 = await util.waitFor("segment", 1);
  util.release(seg2, SEGMENT_TEXT);
  const lt2 = await util.waitFor("longterm", 1);
  util.release(lt2, JSON.stringify(entryPayload(ids)));

  const ok = await secondRun;
  assert.equal(ok.body.rolled.rolled, true, JSON.stringify(ok.body.rolled));

  const memory = rereadMemory(app.dataDir);
  assert.equal(memory.longterm.length, 1, "重试只该有一条，不该把坏那次留下的东西叠加进来");
  assert.equal(memory.archive.length, 1, "摘要同样只该有一段");
  assert.equal(memory.archive[0].text, SEGMENT_TEXT);
  assert.equal(watermark(app), ids[3]);
});

// ── 整理④：没人接的主动独白不进两次后台调用的材料 ─────────────────

test("整理：没人接的主动独白不进两次后台调用的材料", async () => {
  const app = await bootChahuahui({ seed: seedRollupReady });
  const MONOLOGUE = "我在盘算明天要不要把那台旧刻机搬回来";
  const ANSWERED = "顺口提一句今天的光线很好";

  // proA 后面紧跟另一条主动消息，没人接；proB 后面有她真人的话，算接过。
  seedThread(app.store, [
    { role: "user", text: `${ROLLUP_TOPIC}的摊子还在桥头对吧` },
    { role: "assistant", text: "桥头那个还在，不过六点就收了" },
    { role: "user", text: ROLLUP_SECOND_USER_TEXT },
    { role: "assistant", text: "巷口那家啊，那天风挺大" },
    { role: "assistant", text: MONOLOGUE, proactive: true },
    { role: "assistant", text: ANSWERED, proactive: true },
    { role: "user", text: `${ROLLUP_TOPIC}我下次自己去买` },
    { role: "assistant", text: "行，记得给我留一块" },
    { role: "user", text: "今天就这样" },
    { role: "assistant", text: "好，回头见" },
  ]);
  const util = stubUtility(app, { hold: HELD, answers: defaultAnswers });

  const pending = tidy(app.request);
  const segment = await util.waitFor("segment");
  util.release(segment, SEGMENT_TEXT);
  const longterm = await util.waitFor("longterm");
  util.release(longterm, JSON.stringify({ facts: [], entries: [] }));

  const res = await pending;
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.rolled.rolled, true, JSON.stringify(res.body.rolled));
  assert.equal(util.of("segment").length, 1, "同批还有真实内容，所以两次后台调用都发了");
  assert.equal(util.of("longterm").length, 1);

  const segmentText = utilityTextOf(util.of("segment")[0]);
  const material = utilityTextOf(util.of("longterm")[0]);
  assert.equal(segmentText.includes(MONOLOGUE), false, "摘要材料里不许有没人接的主动独白");
  assert.equal(material.includes(MONOLOGUE), false, "条目抽取材料里同样不许有");
  assert.ok(segmentText.includes(ANSWERED), "被接住过的主动消息仍要进材料");
  assert.ok(material.includes(ANSWERED), "被接住过的主动消息仍要进条目抽取材料");
  assert.ok(material.includes(ROLLUP_SECOND_USER_TEXT), "真实对话内容必须在场，否则这轮测不到东西");
});

// ── ① 旧事件滚出上下文后仍按需唤起；没有关联就不进 ──────────────────

test("旧条目滚出上下文后仍按需进请求", async () => {
  const app = await bootChahuahui({ seed: seedReady });
  const [target] = seedEntries(app.store, [lemonEntry(), ...noiseEntries()]);

  const hit = await post(app.request, { text: `${KEY}那家店后来还开着吗`, clientMessageId: "m_lt_hit_00001" });
  assert.equal(hit.status, 200);
  await app.models.waitForCall(0);

  const prompt = systemPromptOf(app, 0);
  assert.ok(prompt.includes(ENTRY_HEADER), `关联上的这一轮必须带条目块：${prompt.slice(0, 400)}`);
  assert.ok(prompt.includes(FEEDBACK_HEADER), "有关联条目时才附反馈块");
  assert.ok(prompt.includes(target.id), `被唤起的条目 id 要真的在请求里：${target.id}`);
  assert.ok(prompt.includes(target.text.slice(0, 20)), "条目正文要真的在请求里");
  // 提示词里当然会出现标签名本身——那是给伙伴的格式说明。这里不断言它不在，
  // 真正的泄漏防线在「落盘的那条回复里没有协议」，下面各例管那个。
  assert.equal(prompt.includes("<memory-update>"), true, "带反馈块时要把输出格式说清楚");

  for (const word of NOISE_WORDS.slice(0, 6)) {
    assert.equal(prompt.includes(word), false, `无关条目不该被带进来：${word}`);
  }
  assert.equal(app.models.calls[0].request.maxTokens, 1800, "带反馈块时输出预算才放宽");

  app.models.release(0, "开着呢，就是排队久");
  await waitTurn(app.request, hit.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
});

test("这一轮没有关联条目：条目块、反馈块与放宽预算都不出现", async () => {
  // 另起一个干净实例：召回窗口是最近几条消息，上一轮提过什么会一直算进来，
  // 所以「没关联」这一例不能接在别的用例后面。
  const app = await bootChahuahui({ seed: seedReady });
  seedEntries(app.store, [lemonEntry(), ...noiseEntries()]);

  const miss = await post(app.request, { text: "今天天气不错", clientMessageId: "m_lt_miss_0001" });
  await app.models.waitForCall(0);

  const prompt = systemPromptOf(app, 0);
  assert.equal(prompt.includes(ENTRY_HEADER), false, "没有关联条目就不该有条目块");
  assert.equal(prompt.includes(FEEDBACK_HEADER), false, "没有关联条目就不该有反馈块");
  assert.equal(prompt.includes(KEY), false, "没被唤起的条目连正文都不该出现");
  assert.equal(app.models.calls[0].request.maxTokens, 900, "没带反馈块时输出预算回到常规");

  app.models.release(0, "嗯，还行");
  await waitTurn(app.request, miss.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
});

// ── ② revise：协议不外露，认知延续，且不额外发后台调用 ──────────────

test("revise：协议不进正文与气泡，下一轮延续新认知，每轮只有一次生成", async () => {
  const app = await bootChahuahui({ seed: seedReady });
  const utility = watchUtility(app);
  const [target] = seedEntries(app.store, [lemonEntry(), ...noiseEntries()]);

  const first = await post(app.request, { text: `${KEY}的事我说错了，${QUOTE}`, clientMessageId: "m_lt_rev_00001" });
  await app.models.waitForCall(0);
  app.models.release(0, "好，那我记巷子里那家"
    + wrap([{ id: target.id, decision: "revise", text: `${KEY}是巷子里那家买的。`, note: "以这回纠正为准", sourceId: first.body.messageId, quote: QUOTE }]));

  const done = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
  assert.ok(done.replyMessageId, `回复应该照常落盘：${JSON.stringify(done)}`);

  // 协议一点都不能外露：账本正文、每一条气泡、诊断摘要都不许带。
  const rows = reopenThread(app.dataDir, AGENT);
  const reply = rows.find((row) => row.id === done.replyMessageId);
  assert.equal(reply.text, "好，那我记巷子里那家", `落盘正文必须只有可见正文，实际：${reply.text}`);
  for (const [i, bubble] of (reply.bubbles ?? []).entries()) {
    assert.equal(String(bubble).includes("memory-update"), false, `第 ${i} 条气泡漏了协议：${bubble}`);
  }
  assert.equal(JSON.stringify(reply).includes("memory-update"), false, "整条回复对象里不该再有协议字样");
  assert.equal(JSON.stringify(reply).includes(target.id), false, "条目 id 是后台认知，不该出现在发给她的消息里");

  // 账上：角度改了、存疑清掉、判断留下了。
  const saved = rereadMemory(app.dataDir).longterm.find((row) => row.id === target.id);
  assert.ok(saved, "revise 之后条目还在（改的是角度，不是删条目）");
  assert.equal(saved.text, `${KEY}是巷子里那家买的。`);
  assert.equal(saved.certainty, "held", "revise 之后不再是存疑");
  assert.equal(saved.note, "以这回纠正为准", "伙伴当时的想法要存下来");
  assert.deepEqual(saved.feedbackSourceIds, [first.body.messageId]);
  assert.deepEqual(saved.resultMessageIds, [done.replyMessageId]);
  assert.equal(app.models.calls.length, 1, "这一轮只发了一次生成，反馈不许自己再叫模型");

  // 第二轮：唤起时看到的是新认知，不是旧文本。
  const second = await post(app.request, { text: `${KEY}是哪家来着`, clientMessageId: "m_lt_rev_00002" });
  await app.models.waitForCall(1);
  const prompt = systemPromptOf(app, 1);
  assert.ok(prompt.includes(`${KEY}是巷子里那家买的。`), "改过的角度要延续到下一轮");
  assert.equal(prompt.includes("那家排队的店门口"), false, "旧版本不该再作为当前认知出现");
  app.models.release(1, "巷子里那家");
  await waitTurn(app.request, second.body.turnId, (state) => state.status === "ready" && state.replyMessageId);

  assert.equal(app.models.calls.length, 2, "两轮就是两次生成，没有多出来的调用");
  const feedbackish = utility.dump().filter((row) => row.includes("记忆反馈") || row.includes("memory-update"));
  assert.deepEqual(feedbackish, [], `反馈不许另发后台模型调用：${JSON.stringify(feedbackish)}`);
});

// ── ③ hold / doubt：嘴上让步但条目不动，判断要留痕 ──────────────────

test("hold 只留判断不改条目，doubt 记成存疑", async () => {
  const app = await bootChahuahui({ seed: seedReady });
  const entries = seedEntries(app.store, [
    lemonEntry(),
    { kind: "symbol", title: "旧唱机", text: "她说过想听那台旧唱机放完一整面。", keys: ["旧唱机"], sourceIds: ["m_seed_radio"], certainty: "held", note: "" },
  ]);
  const [lemon, radio] = entries;

  const turn = await post(app.request, { text: `${KEY}的事我可能记错了；旧唱机那面也先放着`, clientMessageId: "m_lt_hold_00001" });
  await app.models.waitForCall(0);
  app.models.release(0, "行吧那就先这样，我记着"
    + wrap([
      { id: lemon.id, decision: "hold", note: "嘴上认了，心里还是我这版", sourceId: turn.body.messageId, quote: `${KEY}的事我可能记错了` },
      { id: radio.id, decision: "doubt", note: "这版本没准是我自己添的", sourceId: turn.body.messageId, quote: "旧唱机那面也先放着" },
    ]));

  const done = await waitTurn(app.request, turn.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
  const reply = reopenThread(app.dataDir, AGENT).find((row) => row.id === done.replyMessageId);
  assert.equal(reply.text, "行吧那就先这样，我记着", "嘴上让不让步是正文的事，与后台判断分开");

  const after = rereadMemory(app.dataDir).longterm;
  const held = after.find((row) => row.id === lemon.id);
  assert.equal(held.text, "她第一次说想吃柠檬蛋糕，是在那家排队的店门口。", "hold 不许改条目内容");
  assert.equal(held.certainty, "held", "hold 不许变成存疑");
  assert.equal(held.note, "嘴上认了，心里还是我这版", "hold 的判断要存下来");
  assert.deepEqual(held.feedbackSourceIds, [turn.body.messageId]);
  assert.deepEqual(held.resultMessageIds, [done.replyMessageId]);

  const doubted = after.find((row) => row.id === radio.id);
  assert.equal(doubted.text, "她说过想听那台旧唱机放完一整面。", "doubt 只改存疑，不动内容");
  assert.equal(doubted.certainty, "uncertain", "doubt 要落成存疑");
  assert.equal(doubted.note, "这版本没准是我自己添的");
});

// ── ④ 旧稿作废：superseded 的那一轮反馈不提交 ──────────────────────

test("生成中补新消息：被作废的旧稿不提交记忆反馈", async () => {
  const app = await bootChahuahui({ seed: seedReady });
  const [target] = seedEntries(app.store, [lemonEntry()]);

  const first = await post(app.request, { text: `${KEY}是不是那家`, clientMessageId: "m_lt_sup_00001" });
  await app.models.waitForCall(0);

  // 第一轮还在生成，她补了一句：这一稿按旧上下文写的，必须作废。
  const second = await post(app.request, { text: `不对，${QUOTE}`, clientMessageId: "m_lt_sup_00002" });
  assert.equal(second.body.queued, true, "已有回合在跑，第二条只能排队");

  app.models.release(0, "应该是吧"
    + wrap([{ id: target.id, decision: "hold", note: "作废稿的判断", sourceId: first.body.messageId, quote: `${KEY}是不是那家` }]));
  await app.models.waitForCall(1);
  app.models.release(1, "巷子里那家，我记错了");

  const done = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
  const rows = reopenThread(app.dataDir, AGENT);
  const replies = rows.filter((row) => row.role === "assistant" && !row.proactive);
  assert.equal(replies.length, 1, "磁盘上只能有一份回复");
  assert.equal(replies[0].repliedTo, second.body.messageId, "送出的是重跑的那一份");
  assert.equal(replies[0].text, "巷子里那家，我记错了");

  const after = rereadMemory(app.dataDir).longterm.find((row) => row.id === target.id);
  assert.equal(after.note, "", "作废稿的判断不许提交");
  assert.deepEqual(after.feedbackSourceIds, [], "作废稿不许在条目上留反馈来源");
  assert.deepEqual(after.resultMessageIds, [], "作废稿不许留下结果消息编号");
});

// ── ⑤ 畸形 / 未闭合 / 孤立闭合标签：只剥，不写 ──────────────────────

test("畸形与未闭合的协议只被剥掉，不落任何判断", async () => {
  const app = await bootChahuahui({ seed: seedReady });
  const [target] = seedEntries(app.store, [lemonEntry()]);

  const cases = [
    // 开标签没有闭合：连同后面的载荷一起吃掉，正文不受污染。
    { text: "先这样", tail: `<memory-update>{"updates":[{"id":"${target.id}","decision":"hold","note":"不该写","sourceId":"%SRC%","quote":"%Q%"}]}`, expect: "先这样" },
    // 闭合了但载荷为空：正文照常，账不动。
    { text: "那就这样", tail: `<memory-update>{"updates":[]}</memory-update>`, expect: "那就这样" },
    // 孤立的闭合标签：未知边界，前后两段一起压制。
    { text: "开头", tail: `</memory-update>尾巴`, expect: "尾巴" },
    // 载荷不是 JSON：剥掉，不写。
    { text: "就这句", tail: `<memory-update>{bad}</memory-update>`, expect: "就这句" },
  ];

  for (const [index, item] of cases.entries()) {
    const turn = await post(app.request, { text: `${KEY}的事`, clientMessageId: `m_lt_bad_0000${index}` });
    await app.models.waitForCall(index);
    app.models.release(index, `${item.text}${item.tail.replaceAll("%SRC%", turn.body.messageId).replaceAll("%Q%", `${KEY}的事`)}`);
    const done = await waitTurn(app.request, turn.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
    assert.ok(done.replyMessageId, `第 ${index} 例回复应当照常落盘：${JSON.stringify(done)}`);

    const reply = reopenThread(app.dataDir, AGENT).find((row) => row.id === done.replyMessageId);
    assert.equal(reply.text, item.expect, `第 ${index} 例剥离结果不对：${reply.text}`);
    assert.equal(JSON.stringify(reply).includes("memory-update"), false, `第 ${index} 例漏了协议字样`);
    assert.equal(JSON.stringify(reply).includes(target.id), false, `第 ${index} 例把条目 id 带进了正文`);

    const after = rereadMemory(app.dataDir).longterm.find((row) => row.id === target.id);
    assert.equal(after.note, "", `第 ${index} 例不该写入判断`);
    assert.deepEqual(after.feedbackSourceIds, [], `第 ${index} 例不该留下反馈来源`);
  }
});

// ── ⑥ 删掉那条回复：靠它活着的长期条目不再复活 ────────────────────

test("删除那条回复后，依赖它的长期条目不会复活", async () => {
  const app = await bootChahuahui({ seed: seedRefineReady });

  const turn = await post(app.request, { text: `${KEY}那家还在吗`, clientMessageId: "m_lt_del_00001" });
  await app.models.waitForCall(0);
  app.models.release(0, "还在，牌子都没换");
  const done = await waitTurn(app.request, turn.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
  const replyId = done.replyMessageId;

  // 这条记忆是由那次回复「说出来」才成立的。
  seedEntries(app.store, [{
    kind: "symbol",
    title: "店还开着",
    text: `${KEY}那家店还开着，牌子都没换。`,
    keys: [KEY],
    sourceIds: [turn.body.messageId],
    resultMessageIds: [replyId],
    certainty: "held",
    note: "说完就记着了",
  }]);

  const removed = await app.request("DELETE", `/thread/${AGENT}/refine/${replyId}`);
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body));

  const after = rereadMemory(app.dataDir).longterm;
  assert.equal(after.some((row) => row.resultMessageIds.includes(replyId)), false, "回复被删后，靠它活着的条目必须一起走");
  assert.equal(after.some((row) => row.title === "店还开着"), false, "这条记忆不该被重新投影回来");

  // 再读一次磁盘，确认不是内存残留造成的假象。
  assert.deepEqual(rereadMemory(app.dataDir).longterm.map((row) => row.id), after.map((row) => row.id));
});

// ── ⑦ 撤回来源原话：靠它立起来的长期条目不再复活 ───────────────────

test("撤回来源消息后，依赖它的长期条目不会复活", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  // 直接落一条她没看到过的原话：撤回走无痕那条，才会连带清来源记忆。
  const source = app.store.appendMessage(AGENT, { role: "user", text: "下个月想去老黄历提到的那个展" });
  seedEntries(app.store, [{
    kind: "event",
    title: "想去看展",
    text: "她提过下个月想去那个展。",
    keys: ["老黄历"],
    sourceIds: [source.id],
    certainty: "held",
    note: "",
  }]);
  assert.ok(rereadMemory(app.dataDir).longterm.some((row) => row.sourceIds.includes(source.id)), "前置条件：条目确实挂在来源上");

  const recalled = await app.request("POST", `/thread/${AGENT}/retract/${source.id}`);
  assert.equal(recalled.status, 200, JSON.stringify(recalled.body));
  assert.equal(recalled.body.mode, "removed", "没被看过的原话是无痕撤回，不留占位");

  const after = rereadMemory(app.dataDir).longterm;
  assert.equal(after.some((row) => row.sourceIds.includes(source.id)), false, "来源撤回后，靠它立起来的条目必须一起走");
  assert.equal(after.some((row) => row.title === "想去看展"), false, "这条记忆不该被重新投影回来");
});

// ── ⑧ 语音：协议不会跟着进合成 ─────────────────────────────────────

test("语音合成请求里没有协议", async () => {
  const audio = fakeWavBase64();
  const voiceReply = { choices: [{ message: { audio: { data: audio } } }] };

  // 语音要不要出鞘是掷骰子的；回合作废与落盘都在 POST 返回之后的异步里，
  // 所以骰子得按住整段，不能只按住发消息那一瞬间。
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const app = await bootChahuahui({ seed: seedVoiceReady });
    const [target] = seedEntries(app.store, [lemonEntry()]);

    const turn = await post(app.request, { text: `${KEY}我记错了，${QUOTE}`, clientMessageId: "m_lt_voice_0001" });
    await app.models.waitForCall(0);
    // 语音有最短字数门槛，正文得够长才真的会去合成。
    app.models.release(0, "那就巷子里那家，我记住了"
      + wrap([{ id: target.id, decision: "revise", text: `${KEY}是巷子里那家。`, note: "听她的", sourceId: turn.body.messageId, quote: QUOTE }]));

    const pendingVoice = await app.net.waitForCall(0);
    assert.match(pendingVoice.url, /chat\/completions/, "语音合成的出口必须是受控网络接口");
    const body = JSON.stringify(pendingVoice.options ?? {});
    assert.equal(body.includes("memory-update"), false, "合成请求里不该带协议标签");
    assert.equal(body.includes(target.id), false, "合成请求里不该带条目 id");
    assert.ok(body.includes("那就巷子里那家，我记住了"), "合成的是可见正文");

    app.net.release(0, voiceReply);
    const done = await waitTurn(app.request, turn.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
    const reply = reopenThread(app.dataDir, AGENT).find((row) => row.id === done.replyMessageId);
    assert.equal(reply.text, "那就巷子里那家，我记住了");
    assert.equal(reply.voice?.status, "ready", "语音应当照常挂上");
    assert.equal(JSON.stringify(reply.voice).includes("memory-update"), false, "语音记录里也不该带协议");
  } finally {
    Math.random = realRandom;
  }
});
