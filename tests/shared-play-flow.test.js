import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { DAILY_SYSTEM, PROFILE_SYSTEM, SEGMENT_SYSTEM } from "../lib/summarize.js";

/**
 * 共享小玩法的端到端隔离测试（2026-11-16）。
 *
 * 走真的 apply(ctx)、真的 /turns 与 /proactive/tick、真的记忆落盘；
 * 只有模型与宿主接口是假的（harness 那套桩），不碰任何外部真实请求。
 *
 * 这里只测应用这一层的接线：隐藏协议怎么被剥、证据怎么被核、玩法怎么落进
 * 这位伙伴自己的记忆、旧图怎么被重新甩出来。纯模块那部分由另一份单测管。
 *
 * 两件要说清的：
 * · 下面的 PNG 是 1 像素占位，猫猫／纸袋／云朵只存在于文字描述里。
 *   这些用例验的是结构与发送链（协议、证据、落盘、原图复用），不是真实视觉识别。
 * · 模型是 mock：它按协议吐标记，不证明“模型自己能认出这是梗”。
 *   语义由正式那套提示词引导，这一层只验协议本身。
 *
 * 约定：id 一律从真实数据里读（线程里的消息 id、附件编号、记忆里的条目 id），
 * 不猜、不硬编；引语必须是本轮她原话里的逐字片段。
 */

const MEMORY_SYSTEMS = new Set([SEGMENT_SYSTEM, DAILY_SYSTEM, PROFILE_SYSTEM]);
const AGENT = "nova";
const OTHER = "other";
const HOUR = 3600000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
/** 三份素材：1 像素占位图 + 文字描述，不是酒杯、也不是配对那套，就是猫猫、纸袋、云朵贴纸。 */
const CAT = "img_cat_a";
const BAG = "img_bag_b";
const CLOUD = "img_cloud_c";
const bytes = new Map([
  [CAT, PNG],
  [BAG, Buffer.concat([PNG, Buffer.from([0])])],
  [CLOUD, Buffer.concat([PNG, Buffer.from([0, 0])])],
]);
const titles = { [CAT]: "橘猫纸袋", [BAG]: "折角纸袋", [CLOUD]: "云朵贴纸" };
const descriptions = {
  [CAT]: "一只橘猫从纸袋里探出头的插画",
  [BAG]: "牛皮纸袋，袋口折起一角",
  [CLOUD]: "一朵圆滚滚的云，下面掉着小雨点",
};

async function boot(t) {
  const media = [];
  const tools = new Map();
  const app = await bootChahuahui({ seed(store, ctx) {
    ctx.tools.register = (tool) => tools.set(tool.name, tool);
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = (hour) => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({ rhythmProactiveEnabled: true, imageTier: "off", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) }, weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    for (const id of [AGENT, OTHER]) {
      store.setPartnerSettings(id, {
        proactiveEnabled: true, tier: "often", imageTier: "off",
        model: { provider: "test-provider", model: "test-model" },
        hobbySeedTryAt: new Date().toISOString(),
        sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } },
        // 手机那头拿在手里、节奏调到最快：不然回复按默认节奏慢慢来，用例会等超时。
        phone: { holding: true, untilMs: Date.now() + HOUR },
        rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 },
        voice: { enabled: false },
      });
      const knowing = store.getKnowing(id);
      store.saveKnowing(id, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } } });
    }
    store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() - HOUR).toISOString(), lastSentAt: new Date(Date.now() - HOUR).toISOString(), interestLearning: { curiosity: { startedAt: new Date().toISOString(), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: new Date().toISOString(), seeds: [] }, newsBook: { lastFetchAt: new Date().toISOString(), lastDomainId: "", items: [], history: [] } });
    // 素材落进这位伙伴的附件库：真字节、真元数据，描述也写上。
    const dir = path.join(ctx.dataDir, "v2", "attachments");
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, data] of bytes) {
      fs.writeFileSync(path.join(dir, `${id}.bin`), data);
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        id, agentId: AGENT, name: `${id}.png`, mimeType: "image/png", size: data.length,
        hash: createHash("sha256").update(data).digest("hex"),
        at: new Date(Date.now() - 2 * HOUR).toISOString(), lastSeenAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        title: titles[id], description: descriptions[id],
      }));
    }
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { media.push(payload); throw new Error("这条路上不该生图"); }
      if (type === "agent:list") return { agents: [{ id: AGENT, name: "测试伙伴", description: "测试用伙伴", personality: "嘴上不饶人，但心里有数" }, { id: OTHER, name: "第二伙伴", description: "第二位伙伴", personality: "安静" }] };
      return request(type, payload, ...rest);
    };
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.setCatalog([{ provider: "test-provider", model: "test-model", supportsImage: true }]);

  // 模型出口：这一轮说什么由测试说了算；返回 null 就是让模型一直挂着（做旧稿作废那一条）。
  const originalStream = app.models.stream;
  let nextReply = () => "嗯，我在。";
  const latestUser = (agentId = AGENT) => {
    const rows = app.store.getThread(agentId).messages;
    return rows.findLast((row) => row.role === "user" && !row.recalled) ?? null;
  };
  const api = {
    ...app, media, tools, latestUser,
    reply(fn) { nextReply = fn; },
    replyText(text) { nextReply = () => text; },
  };
  app.models.stream = (request) => {
    const promise = originalStream(request);
    const entry = app.models.calls.at(-1);
    if (MEMORY_SYSTEMS.has(String(request?.systemPrompt ?? ""))) { entry.resolve({ ndjson: "" }); return promise; }
    const text = nextReply(request, api);
    if (typeof text === "string") entry.resolve({ ndjson: text });
    return promise;
  };

  const promptWith = (needle) => app.models.calls
    .map((call) => String(call.request?.systemPrompt ?? ""))
    .findLast((prompt) => prompt.includes(needle)) ?? "";
  const memory = (agentId = AGENT) => app.store.readMemory(agentId).sharedPlay ?? [];
  const attachmentMeta = (id) => JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${id}.json`), "utf8"));
  const binCount = () => fs.readdirSync(path.join(app.dataDir, "v2", "attachments")).filter((name) => name.endsWith(".bin")).length;
  return { ...api, promptWith, memory, attachmentMeta, binCount };
}

/** 隐藏协议本体：正文末尾追加、只追加一个。 */
function playTag(updates) {
  return `<shared-play>${JSON.stringify({ updates })}</shared-play>`;
}
function learnUpdate({ sourceId, quote, title, meaning, imageIds = [] }) {
  return { op: "learn", title, meaning, imageIds, evidence: [{ sourceId, quote }] };
}
/** 直接把一条玩法写进这位伙伴的记忆（主动那轮用：那一轮前面没有回复，回合闸还占着）。 */
function seedPlay(app, entry) {
  const memory = app.store.readMemory(AGENT);
  app.store.writeMemory(AGENT, { ...memory, sharedPlay: [entry] });
}

async function waitRow(app, predicate, timeout = 8000, agentId = AGENT) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const row = reopenThread(app.dataDir, agentId).find(predicate);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等不到要的消息 :: " + JSON.stringify(reopenThread(app.dataDir, agentId).slice(-4).map((row) => ({ role: row.role, text: row.text, recalled: row.recalled }))));
}
async function waitAssistant(app, timeout = 8000) {
  return waitRow(app, (row) => row.role === "assistant", timeout);
}
/** 等到伙伴那边一共回了这么多条（回复是异步落的，别急着读线程）。 */
async function waitAssistantCount(app, count, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const rows = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant");
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等不到要的消息 :: " + JSON.stringify(reopenThread(app.dataDir, AGENT).slice(-4).map((row) => ({ role: row.role, text: row.text }))));
}
const assistantCount = (app) => reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length;
/** 把一份数据目录整个搬过去（重启同一份账，用来释放只在内存里的运行时闸）。 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

/** 发一轮：带图就带图，回调里能拿到本轮真实的消息 id 与附件编号。 */
async function turn(app, { text, image, clientMessageId, reply }) {
  if (reply) app.reply(reply);
  const json = { agentId: AGENT, text, watching: true, clientMessageId };
  if (image) json.image = { data: bytes.get(image).toString("base64"), mimeType: "image/png" };
  return app.request("POST", "/turns", { json });
}

test("空记忆时提示词照样给自动学习协议、材料附件号与图描述", async (t) => {
  const app = await boot(t);
  app.replyText("这张我先收着。");
  const result = await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_empty_1" });
  assert.equal(result.status, 200);
  await waitAssistant(app);
  const prompt = app.promptWith("<shared-play>");
  assert.ok(prompt, "聊天这轮的提示词里得有共享小玩法那一节");
  assert.match(prompt, /你可以自己判断着学/);
  assert.match(prompt, /<shared-play>/);
  assert.match(prompt, /每项都得有至少一条来自她最新那条消息的证据/);
  // 材料那一节带得上附件编号与它原本的描述
  assert.ok(prompt.includes(CAT), `提示词里该有附件编号 ${CAT}`);
  assert.ok(prompt.includes(descriptions[CAT]), "提示词里该有这张图的描述");
  assert.deepEqual(app.memory(), [], "还没学到东西时记忆是空的");
});

test("首次 learn 与同轮甩旧图一起成功：收藏标成 inferred-shared-play，不生图不复制字节", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `这张我收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}[旧图:{"id":"${CAT}","as":"sticker"}]`;
  });
  const result = await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_learn_1" });
  assert.equal(result.status, 200);
  const row = await waitAssistant(app);
  // 隐藏协议不许漏进聊天
  assert.equal(row.text.includes("shared-play"), false, `正文漏了协议：${row.text}`);
  assert.equal(row.text.includes("updates"), false, `正文漏了内部 JSON：${row.text}`);
  // 同轮把那张原图甩出来了
  assert.equal(row.imageReuse?.attachmentId, CAT);
  assert.ok(row.bubbles.includes(`stk:${CAT}`));
  // 记忆里真的多了一条
  const book = app.memory();
  assert.equal(book.length, 1);
  assert.equal(book[0].title, "纸袋暗号");
  assert.equal(book[0].meaning, "她管橘猫纸袋叫暗号");
  assert.deepEqual(book[0].imageIds, [CAT]);
  assert.equal(book[0].state, "guess");
  assert.equal(book[0].revision, 0);
  assert.equal(book[0].sourceIds.length, 1);
  // 收藏是“推断出来的共享玩法”，不是她自己收的
  const meta = app.attachmentMeta(CAT);
  assert.equal(meta.collection?.origin, "inferred-shared-play");
  assert.equal(meta.collection?.sticker, true);
  // 不生图、不复制字节
  assert.equal(app.media.length, 0);
  assert.equal(app.binCount(), 3, "原图还是那三份，不能多出副本");
});

test("纯文字的梗也学得会（0 图），照样落进这位伙伴的记忆", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `记住了。${playTag([learnUpdate({ sourceId: user.id, quote: "窗帘", title: "窗帘暗号", meaning: "拉窗帘就是想说晚安", imageIds: [] })])}`;
  });
  const result = await turn(app, { text: "以后我说窗帘就是晚安啦", clientMessageId: "sp_text_1" });
  assert.equal(result.status, 200);
  const row = await waitAssistant(app);
  assert.equal(row.text.includes("shared-play"), false);
  const book = app.memory();
  assert.equal(book.length, 1);
  assert.equal(book[0].title, "窗帘暗号");
  assert.deepEqual(book[0].imageIds, []);
});

test("三张图一组学得下，不靠成对图片那套（旧公共梗池也不被带脏）", async (t) => {
  const app = await boot(t);
  const memesBefore = JSON.stringify(app.store.getMemes());
  app.reply((request, a) => {
    const user = a.latestUser();
    return `这一组我收着。${playTag([learnUpdate({ sourceId: user.id, quote: "三张", title: "三件套", meaning: "猫猫、纸袋、云朵是一套", imageIds: [CAT, BAG, CLOUD] })])}`;
  });
  const result = await turn(app, { text: "这三张是一套", image: CAT, clientMessageId: "sp_three_1" });
  assert.equal(result.status, 200);
  await waitAssistant(app);
  const book = app.memory();
  assert.equal(book.length, 1);
  assert.deepEqual(book[0].imageIds, [CAT, BAG, CLOUD]);
  // 没有绑过任何成对暗号
  assert.equal(JSON.stringify(app.store.getMemes()), memesBefore, "旧的公共梗池不能被私有学习污染");
});

test("学会之后，后续普通回复能从共享玩法里把原图再甩出来", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_reuse_1" });
  await waitAssistant(app);
  // 下一轮：她提起暗号，伙伴把原图甩出来
  app.replyText(`记得呀。[旧图:{"id":"${CAT}","as":"sticker"}]`);
  await turn(app, { text: "纸袋还记得吧", clientMessageId: "sp_reuse_2" });
  const row = await waitRow(app, (item) => item.role === "assistant" && item.imageReuse?.attachmentId === CAT);
  assert.equal(row.imageReuse.attachmentId, CAT);
  assert.ok(row.bubbles.includes(`stk:${CAT}`));
  // 提示词里带着这条玩法
  const prompt = app.promptWith("【你们之间的共享小玩法】");
  assert.ok(prompt.includes("纸袋暗号"));
  assert.equal(app.media.length, 0);
});

test("主动那一轮也能从共享玩法里拿图，不另造联系动机", async (t) => {
  const app = await boot(t);
  // 这一轮前面没有回复（主动闸还占着），所以玩法是直接写进记忆的。
  seedPlay(app, {
    id: "play_seed_1", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号",
    imageIds: [CAT], sourceIds: [], state: "familiar", revision: 1, corrected: false,
    updatedAt: new Date().toISOString(), seenSourceIds: [], resultMessageIds: [],
  });
  app.replyText(`想起那个了。[旧图:{"id":"${CAT}","as":"sticker"}]`);
  const random = Math.random;
  Math.random = () => 0.99;
  try { assert.equal((await app.request("POST", "/proactive/tick", { json: {} })).status, 200); }
  finally { Math.random = random; }
  const row = await waitRow(app, (item) => item.proactive && item.imageReuse);
  assert.equal(row.imageReuse.attachmentId, CAT);
  const prompt = app.promptWith("【你们之间的共享小玩法】");
  assert.ok(prompt.includes("纸袋暗号"), "主动那轮的提示词里也带着这条玩法");
  assert.equal(app.media.length, 0);
});

test("真学到的那条玩法，能在之后的主动那一轮被取用", async (t) => {
  const first = await boot(t);
  // 真学：走一轮正常聊天，让它把这条玩法记下来
  first.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(first, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_proactive_1" });
  await waitAssistant(first);
  const learned = first.memory();
  assert.equal(learned.length, 1, "这一轮得真的学到一条");
  assert.deepEqual(learned[0].imageIds, [CAT]);
  assert.equal(first.attachmentMeta(CAT).collection?.origin, "inferred-shared-play");
  // 同一份数据再起一个实例：上一轮的回合闸只在内存里（10 分钟租约），新实例里是空的。
  const second = await boot(t);
  copyDir(first.dataDir, second.dataDir);
  assert.equal(second.memory().length, 1, "重启后学到的玩法还在");
  // 把刚才那轮对话挪到两小时前：主动那轮有“刚聊完先别贴着开口”的缓冲（30 分钟）。
  for (const row of second.store.getThread(AGENT).messages) {
    second.store.patchMessage(AGENT, row.id, { at: new Date(Date.parse(row.at) - 2 * HOUR).toISOString() });
  }
  second.replyText(`想起那个了。[旧图:{"id":"${CAT}","as":"sticker"}]`);
  const random = Math.random;
  Math.random = () => 0.99;
  let tickBody = null;
  try {
    const tick = await second.request("POST", "/proactive/tick", { json: {} });
    tickBody = tick.body;
    assert.equal(tick.status, 200);
  }
  finally { Math.random = random; }
  const row = await waitRow(second, (item) => item.proactive && item.imageReuse).catch((error) => {
    throw new Error(`${error.message} :: tick=${JSON.stringify(tickBody)}`);
  });
  assert.equal(row.imageReuse.attachmentId, CAT, "主动那一轮用的是刚学到的那张原图");
  assert.ok(second.promptWith("【你们之间的共享小玩法】").includes("纸袋暗号"));
  assert.equal(second.media.length, 0, "不重新生图");
  assert.equal(second.binCount(), 3, "原图还是那三份");
});

test("跨伙伴隔离：别家的玩法不进别人的记忆与提示词", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_iso_1" });
  await waitAssistant(app);
  assert.equal(app.memory(AGENT).length, 1);
  assert.deepEqual(app.memory(OTHER), [], "别家的记忆里不能有这条");
  // 换个人聊：那位伙伴的提示词里不该出现这一条
  app.replyText("我在呢，你说。");
  const other = await app.request("POST", "/turns", { json: { agentId: OTHER, text: "在吗", watching: true, clientMessageId: "sp_iso_2" } });
  assert.equal(other.status, 200);
  await waitRow(app, (item) => item.role === "assistant", 8000, OTHER);
  const otherPrompts = app.models.calls.map((call) => String(call.request?.systemPrompt ?? "")).filter((prompt) => prompt.includes("纸袋暗号"));
  assert.equal(otherPrompts.length, 0, "别家的提示词里不该出现这一条");
  assert.deepEqual(app.memory(OTHER), []);
});

test("纠正之后新意思持久，后面的提示词只给新理解", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_rev_1" });
  await waitAssistant(app);
  const learned = app.memory()[0];
  assert.ok(learned?.id, "先得学到一条，id 从记忆里读");
  // 她改口了：这一轮纠正
  app.reply((request, a) => {
    const user = a.latestUser();
    return `哦，是这么个意思啊。${playTag([{ op: "revise", id: learned.id, revision: learned.revision, title: "纸袋暗号", meaning: "不是暗号，是她想要抱抱", imageIds: [CAT], evidence: [{ sourceId: user.id, quote: "不是暗号" }] }])}`;
  });
  await turn(app, { text: "不是暗号，是想要抱抱", clientMessageId: "sp_rev_2" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("哦，是这么个意思啊"));
  const fixed = app.memory()[0];
  assert.equal(fixed.id, learned.id);
  assert.equal(fixed.meaning, "不是暗号，是她想要抱抱");
  assert.equal(fixed.revision, learned.revision + 1);
  assert.equal(fixed.corrected, true);
  // 下一轮提示词里只认新理解
  app.replyText("我在呢，你说。");
  const said = assistantCount(app);
  await turn(app, { text: "再说一次", clientMessageId: "sp_rev_3" });
  await waitAssistantCount(app, said + 1);
  const prompt = app.promptWith("【你们之间的共享小玩法】");
  assert.ok(prompt.includes("不是暗号，是她想要抱抱"));
  assert.equal(prompt.includes("她管橘猫纸袋叫暗号"), false, "旧理解不该再出现在提示词里");
});

test("停掉保留墓碑：不再当表情用，旧 learn 回放也活不回来", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_stop_1" });
  await waitAssistant(app);
  const learned = app.memory()[0];
  // 她说别玩了
  app.reply((request, a) => {
    const user = a.latestUser();
    return `好，不玩了。${playTag([{ op: "stop", id: learned.id, revision: learned.revision, evidence: [{ sourceId: user.id, quote: "别玩了" }] }])}`;
  });
  await turn(app, { text: "这个别玩了", clientMessageId: "sp_stop_2" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("不玩了"));
  const stopped = app.memory()[0];
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.title, "纸袋暗号", "停掉是留墓碑，不是抹掉");
  assert.equal(stopped.revision, learned.revision + 1);
  // 墓碑在提示词里明写：别再主动提
  app.replyText("我在呢，你说。");
  await turn(app, { text: "随便聊聊", clientMessageId: "sp_stop_3" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("我在呢"));
  const prompt = app.promptWith("【你们之间的共享小玩法】");
  assert.ok(prompt.includes("这条已经停了"));
  // 停掉之后那张图不再能当表情甩出去
  const before = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length;
  app.replyText(`[旧图:{"id":"${CAT}","as":"sticker"}]`);
  await turn(app, { text: "再来一次那张", clientMessageId: "sp_stop_4" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length;
  assert.equal(after, before, "停掉的那张图不该再当表情发出去");
  // 旧的 learn 回放不能把它复活
  app.reply((request, a) => {
    const user = a.latestUser();
    return `再记一次。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "纸袋纸袋", clientMessageId: "sp_stop_5" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("再记一次"));
  const revived = app.memory();
  assert.equal(revived.length, 1, "同一条不该被重新学一遍");
  assert.equal(revived[0].state, "stopped", "更不该复活");
});

test("停掉之后强行当普通图也不发；她点名要原图时仍能取回来", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_img_1" });
  await waitAssistant(app);
  const learned = app.memory()[0];
  app.reply((request, a) => {
    const user = a.latestUser();
    return `好，不玩了。${playTag([{ op: "stop", id: learned.id, revision: learned.revision, evidence: [{ sourceId: user.id, quote: "别玩了" }] }])}`;
  });
  await turn(app, { text: "这个别玩了", clientMessageId: "sp_img_2" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("不玩了"));
  assert.equal(app.memory()[0].state, "stopped");
  // 一、模型硬把那张图当普通图甩出来：停掉的梗两个通道都不给
  const before = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length;
  app.replyText(`[旧图:{"id":"${CAT}","as":"image"}]`);
  await turn(app, { text: "那个纸袋啊", clientMessageId: "sp_img_3" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length, before, "停掉的那张图不该被当普通图发出去");
  // 二、“别再发”不算索取
  app.replyText(`[旧图:{"id":"${CAT}","as":"image"}]`);
  await turn(app, { text: "别再发这张图了", clientMessageId: "sp_img_4" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").length, before, "别再发不是索取，不给");
  // 三、她明确点名要原图：这时还能把原件取回来（不复制字节）
  app.replyText(`给你。[旧图:{"id":"${CAT}","as":"image"}]`);
  await turn(app, { text: "把那张原图给我", clientMessageId: "sp_img_5" });
  const row = await waitRow(app, (item) => item.role === "assistant" && item.imageReuse?.attachmentId === CAT);
  assert.equal(row.imageReuse.attachmentId, CAT);
  assert.equal(row.imageReuse.as, "image");
  assert.equal(row.attachment?.id, CAT, "取的是原件，不是新生成的一张");
  assert.equal(row.attachment?.reused, true);
  assert.equal(app.binCount(), 3, "取原件不复制字节");
  assert.equal(app.media.length, 0);
});

test("来源被撤回：那条玩法跟着停，摆成墓碑，再读一次也不涨版本", async (t) => {
  const app = await boot(t);
  app.reply((request, a) => {
    const user = a.latestUser();
    return `收着啦。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋暗号", meaning: "她管橘猫纸袋叫暗号", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_recall_1" });
  await waitAssistant(app);
  const learned = app.memory()[0];
  assert.equal(learned.state, "guess");
  const sourceId = learned.sourceIds[0];
  assert.ok(sourceId, "得记下这条玩法挂在哪句话上");
  // 她把那句话撤回了
  app.store.patchMessage(AGENT, sourceId, { recalled: true });
  app.replyText("我在呢，你说。");
  const said = assistantCount(app);
  await turn(app, { text: "随便说点什么", clientMessageId: "sp_recall_2" });
  await waitAssistantCount(app, said + 1);
  const tomb = app.memory()[0];
  assert.equal(tomb.state, "stopped");
  assert.equal(tomb.corrected, true);
  assert.equal(tomb.title, "", "撤回的来源不该再留着原话");
  assert.equal(tomb.revision, learned.revision + 1);
  // 再读一次上下文：版本不能再涨
  app.replyText("我在呢，你说。");
  const saidAgain = assistantCount(app);
  await turn(app, { text: "再说一句", clientMessageId: "sp_recall_3" });
  await waitAssistantCount(app, saidAgain + 1);
  assert.equal(app.memory()[0].revision, tomb.revision, "同一条撤回不该反复涨版本");
});

test("坏协议与假引语不写记忆，也不把内部 JSON 漏进聊天", async (t) => {
  const app = await boot(t);
  // 一、坏标签：JSON 写坏了
  app.replyText(`我记着呢。<shared-play>{"updates":[{"op":"learn","title":"半截","meaning":"半截","evidence":`);
  await turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_bad_1" });
  const row = await waitAssistant(app);
  assert.equal(row.text.includes("shared-play"), false, "坏标签不许漏");
  assert.equal(row.text.includes("updates"), false, "坏标签里的 JSON 不许漏");
  assert.deepEqual(app.memory(), [], "坏标签不写记忆");
  // 二、假引语：她原话里没有这句
  app.reply((request, a) => {
    const user = a.latestUser();
    return `记下啦。${playTag([learnUpdate({ sourceId: user.id, quote: "她根本没说过的原话", title: "假梗", meaning: "编的", imageIds: [CAT] })])}`;
  });
  await turn(app, { text: "这是一句真话", clientMessageId: "sp_bad_2" });
  await waitRow(app, (item) => item.role === "assistant" && item.text.includes("记下啦"));
  assert.deepEqual(app.memory(), [], "假引语不写记忆");
  // 三、来源 id 不存在
  app.reply((request, a) => {
    const user = a.latestUser();
    return `记下啦。${playTag([learnUpdate({ sourceId: "m_根本不存在的消息", quote: "这是一句真话", title: "假梗", meaning: "编的", imageIds: [] })])}`;
  });
  await turn(app, { text: "这还是一句真话", clientMessageId: "sp_bad_3" });
  await waitRow(app, (item) => item.role === "assistant" && item.text.includes("记下啦"));
  assert.deepEqual(app.memory(), [], "不存在的来源不写记忆");
});

test("她补话让旧稿作废：旧稿不许落学习，也不许落收藏", async (t) => {
  const app = await boot(t);
  // 这一轮模型一直挂着
  app.reply(() => null);
  const pending = turn(app, { text: "这张纸袋猫猫你留着", image: CAT, clientMessageId: "sp_stale_1" });
  // 等模型真的被叫到，再补一句新话
  const until = Date.now() + 8000;
  let call = null;
  while (Date.now() < until && !call) {
    call = app.models.calls.find((entry) => !entry.settled && !MEMORY_SYSTEMS.has(String(entry.request?.systemPrompt ?? "")));
    if (!call) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(call, "模型该被挂起了");
  app.store.appendMessage(AGENT, { role: "user", text: "等等，我还没说完", at: new Date().toISOString() });
  // 现在让那份旧稿回来：它带着一条 learn
  const user = app.latestUser();
  call.resolve({ ndjson: `好的。${playTag([learnUpdate({ sourceId: user.id, quote: "等等", title: "旧稿的梗", meaning: "这份稿子已经过期", imageIds: [CAT] })])}` });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(app.memory(), [], "过期稿子不许落学习");
  const meta = app.attachmentMeta(CAT);
  assert.notEqual(meta.collection?.origin, "inferred-shared-play", "过期稿子不许落收藏");
  const texts = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant").map((row) => row.text);
  assert.equal(texts.some((text) => text.includes("旧稿的梗")), false, "过期稿子不该被发出去");
});

test("旧式成对暗号也能被停掉：第一次落盘就把墓碑写上", async (t) => {
  const app = await boot(t);
  const tool = app.tools.get("chahuahui_image_pair");
  assert.ok(tool, "正式apply确实注册工具");
  const bound = JSON.parse((await tool.execute({
    action: "bind", agentId: AGENT, userImageId: CAT, partnerImageId: BAG,
    name: "纸袋碰杯", meaning: "同构图的两个OC，互相接图碰杯，也可以故意逗对方。", confirm: true,
  })).content[0].text);
  assert.equal(bound.verified, true);
  // 提示词里能认出这条成对暗号的 id（不猜）
  app.replyText("我看看。");
  await turn(app, { text: "随便聊聊纸袋", clientMessageId: "sp_legacy_1" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("我看看"));
  const prompt = app.promptWith("【你们之间的共享小玩法】");
  const pairId = (prompt.match(/\[(pair_[0-9a-f]+)\]/) ?? [])[1];
  assert.ok(pairId, `提示词里该有成对暗号的 id：${prompt.slice(0, 400)}`);
  // 她说这条别玩了
  app.reply((request, a) => {
    const user = a.latestUser();
    return `不玩了。${playTag([{ op: "stop", id: pairId, revision: 0, evidence: [{ sourceId: user.id, quote: "别玩了" }] }])}`;
  });
  await turn(app, { text: "这条别玩了", clientMessageId: "sp_legacy_2" });
  await waitRow(app, (row) => row.role === "assistant" && row.text.includes("不玩了"));
  const book = app.memory();
  assert.equal(book.length, 1, "旧式条目第一次落盘");
  assert.equal(book[0].id, pairId);
  assert.equal(book[0].state, "stopped");
  assert.equal(book[0].legacy, true);
});

async function learnForPreference(app, key) {
  app.reply((request, a) => {
    const user = a.latestUser();
    return `这个纸袋表情有意思。${playTag([learnUpdate({ sourceId: user.id, quote: "纸袋", title: "纸袋版本", meaning: "用纸袋猫表示一起摸鱼", imageIds: [CAT] })])}`;
  });
  const result = await turn(app, { text: "纸袋猫来了", image: CAT, clientMessageId: `${key}_learn` });
  await waitAssistant(app);
  return { entry: app.memory()[0], sourceId: result.body.messageId };
}

function preferenceUpdate(app, imageId) {
  const user = app.latestUser(), entry = app.memory()[0];
  return { op: "prefer", id: entry.id, revision: entry.revision, imageIds: [BAG], preferredImageIds: imageId ? [imageId] : [],
    preferenceNote: imageId === CAT ? "新版纸袋猫也画的是我，但旧版那个呆劲更对我的味" : imageId === BAG ? "这次新版的神态更像我，换它" : "两张都没达到我的味道，继续画一个更得意的",
    evidence: [{ sourceId: user.id, quote: "旧图太丑了" }] };
}

for (const [name, chosen] of [["坚持旧版", CAT], ["喜欢新版", BAG], ["两版都不满意", null]]) {
  test(`用户催换图时伙伴可以${name}，新旧都保留且含义不被审美改写`, async (t) => {
    const app = await boot(t);
    const { entry: original } = await learnForPreference(app, `preference_${chosen ?? "none"}`);
    app.reply(() => {
      const update = preferenceUpdate(app, chosen);
      return `我有自己的口味。${playTag([update])}${chosen ? `[旧图:{"id":"${chosen}","as":"sticker"}]` : ""}`;
    });
    const result = await turn(app, { text: "旧图太丑了，别再用那张，换这张新版。", image: BAG, clientMessageId: `preference_${chosen ?? "none"}_new` });
    const row = await waitRow(app, (item) => item.role === "assistant" && item.repliedTo === result.body.messageId);
    const [entry] = app.memory();
    assert.deepEqual(entry.imageIds, [CAT, BAG]);
    assert.deepEqual(entry.preferredImageIds, chosen ? [chosen] : []);
    assert.equal(entry.meaning, original.meaning);
    assert.equal(entry.state, original.state, "审美分歧不变成对共同玩法的确认或否定");
    assert.equal(entry.corrected, false);
    assert.equal(app.attachmentMeta(CAT).collection.sticker, true, "嫌旧图丑不会取消旧收藏");
    assert.equal(app.attachmentMeta(BAG).collection.sticker, true, "新版也是备选原件");
    if (chosen) assert.equal(row.imageReuse?.attachmentId, chosen);
    else assert.equal(row.imageReuse, undefined);
    assert.equal(row.text.includes("shared-play"), false);
    app.replyText("口味这回事，我自己有数。");
    await turn(app, { text: "你还记得自己偏爱哪张不", clientMessageId: `preference_${chosen ?? "none"}_later` });
    await waitAssistantCount(app, 3);
    assert.ok(app.promptWith(entry.preferenceNote).includes(entry.preferenceNote));
    assert.deepEqual(app.memory()[0].preferredImageIds, chosen ? [chosen] : []);
    assert.equal(app.media.length, 0);
    assert.equal(app.binCount(), 3);
  });
}

test("与用户意见相反的偏爱可跨重启延续到主动原图投递", async (t) => {
  const first = await boot(t);
  await learnForPreference(first, "preference_proactive");
  first.reply(() => `新图我也收，但我偏爱旧版。${playTag([preferenceUpdate(first, CAT)])}`);
  await turn(first, { text: "旧图太丑了，别再用那张，换这张新版。", image: BAG, clientMessageId: "preference_proactive_new" });
  await waitAssistantCount(first, 2);
  assert.deepEqual(first.memory()[0].preferredImageIds, [CAT]);
  const second = await boot(t);
  copyDir(first.dataDir, second.dataDir);
  for (const row of second.store.getThread(AGENT).messages) second.store.patchMessage(AGENT, row.id, { at: new Date(Date.parse(row.at) - 2 * HOUR).toISOString() });
  second.replyText(`旧猫这个呆劲，我还是喜欢。[旧图:{"id":"${CAT}","as":"sticker"}]`);
  const random = Math.random; Math.random = () => 0.99;
  try { assert.equal((await second.request("POST", "/proactive/tick", { json: {} })).status, 200); }
  finally { Math.random = random; }
  const row = await waitRow(second, (item) => item.proactive && item.imageReuse);
  assert.equal(row.imageReuse.attachmentId, CAT);
  assert.ok(second.promptWith("旧版那个呆劲").includes("旧版那个呆劲"));
  assert.deepEqual(second.memory()[0].imageIds, [CAT, BAG]);
  assert.equal(second.media.length, 0);
});

test("伙伴偏爱不能把明确取消收藏的素材加回使用许可", async (t) => {
  const app = await boot(t);
  const { sourceId } = await learnForPreference(app, "preference_cancel");
  app.reply(() => {
    const user = app.latestUser(), entry = app.memory()[0];
    return `我还是喜欢旧版。${playTag([{ op: "prefer", id: entry.id, revision: entry.revision, imageIds: [], preferredImageIds: [CAT], preferenceNote: "我喜欢旧版", evidence: [{ sourceId: user.id, quote: "取消这张的收藏" }] }])}[旧图:{"id":"${CAT}","as":"sticker"}]`;
  });
  const before = assistantCount(app);
  await app.request("POST", "/turns", { json: { agentId: AGENT, text: "取消这张的收藏", quote: { messageId: sourceId, text: "纸袋猫来了" }, watching: true, clientMessageId: "preference_cancel_now" } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(app.attachmentMeta(CAT).collection.sticker, false);
  assert.equal(app.memory()[0].state, "stopped");
  assert.equal(assistantCount(app), before);
});
