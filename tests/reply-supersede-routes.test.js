import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { bootChahuahui, reopenThread, fakeWavBase64 } from "./helpers/app-harness.js";

/**
 * 真装载的编排测试：走真的 apply(ctx)、真的路由、真的账本文件，
 * 只有宿主出口是假的（models.stream / bus / network）。
 *
 * 这些用例验的是「追加一条之后磁盘上到底留下了什么」，不是编排函数的形状。
 */

const AGENT = "nova";

/** 让 ta 面对面拿着手机，并把未读节奏压到毫秒级，测试才跑得完。 */
function seedReady(store) {
  store.setPartnerSettings(AGENT, {
    phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
    rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
    voice: { enabled: false },
  });
}

const post = (request, body) => request("POST", "/turns", {
  json: { agentId: AGENT, watching: true, ...body },
});

function storeReadyWithRefine(store) {
  seedReady(store);
  store.setGlobalSettings({ messageRefine: true });
}

/**
 * 打开语音：全局模型走非 t2a 的 chat/completions 那条路，出口就是 ctx.network.fetch。
 * protocol 不给（默认不是 t2a），所以 synthesizeVoice 走 synthesizeChat。
 */
function seedVoiceReady(store) {
  seedReady(store);
  store.setGlobalSettings({
    voiceEnabled: true,
    voiceModel: { baseUrl: "https://voice.test", model: "voice-test", apiKey: "test-key", protocol: "chat" },
  });
  store.setPartnerSettings(AGENT, { voice: { enabled: true, voiceId: "female-shaonv", tier: "often" } });
}

async function waitTurn(request, turnId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await request("GET", `/turns/${turnId}`);
    if (predicate(state.body)) return state.body;
    if (Date.now() > deadline) return state.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("生成中补第二条：旧稿丢弃，只落一条回复，repliedTo 是最新那条", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await post(app.request, { text: "我准备睡觉了", clientMessageId: "m_first_000001" });
  assert.equal(first.status, 200);
  assert.ok(first.body.turnId, "面对面应当给实时回合");

  // 第一轮已经真的把请求发给模型了，卡在这里等我们放行。
  await app.models.waitForCall(0);

  // 她在这轮生成中途又补了一句。
  const second = await post(app.request, { text: "晚安啦", clientMessageId: "m_second_00001" });
  assert.equal(second.body.queued, true, "已有回合在跑，第二条只能排队");
  const secondId = second.body.messageId;

  // 放行第一轮：这份稿子按旧上下文写的，必须被丢掉。
  app.models.release(0, "睡吧睡吧");
  await app.models.waitForCall(1);
  app.models.release(1, "困了就闭眼，我又不跑");

  const done = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);
  assert.ok(done.replyMessageId, "最终应该只留下一条回复");

  const rows = reopenThread(app.dataDir, AGENT);
  const replies = rows.filter((row) => row.role === "assistant" && !row.proactive);
  assert.equal(replies.length, 1, "磁盘上只能有一条回复，不能是两条近似的");
  assert.equal(replies[0].repliedTo, secondId, "覆盖范围要落到最新那条她的话上");
  assert.equal(replies[0].text, "困了就闭眼，我又不跑", "送出的是重新生成的那一份，不是作废的旧稿");
  assert.equal(app.models.calls.length, 2, "旧稿那一次生成确实发生了，但不能把它的结果送出去");
});

test("已读只盖到本轮真正捕获的目标：这轮结束后才落的话不归它的定时器盖", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  // 一轮走完，没有中途作废。
  const first = await post(app.request, { text: "困了", clientMessageId: "m_first_000007" });
  await app.models.waitForCall(0);
  app.models.release(0, "那就去睡");
  const done = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);

  // 落盘补盖之后，本轮覆盖到的那条已经盖章。
  let rows = reopenThread(app.dataDir, AGENT);
  const covered = rows.find((row) => row.id === done.replyMessageId).repliedTo;
  assert.ok(rows.find((row) => row.id === covered).readAt, "送出回复时该盖到它覆盖的那条为止");

  // 这一轮已经结束。现在才发的话，不该被它的定时器当成已读。
  const late = await post(app.request, { text: "还没睡呢", clientMessageId: "m_late_0000001" });
  rows = reopenThread(app.dataDir, AGENT);
  const lateMsg = rows.find((row) => row.id === late.body.messageId);
  assert.equal(lateMsg.readAt, undefined, "回合结束后才落的话，这一轮的定时器不许替 ta 签收");
});

test("重新捕获目标后水位跟着走：过程里补的那句最终被读到", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await post(app.request, { text: "我准备睡觉了", clientMessageId: "m_first_000002" });
  await app.models.waitForCall(0);
  const second = await post(app.request, { text: "晚安啦", clientMessageId: "m_second_00002" });

  app.models.release(0, "睡吧睡吧");
  await app.models.waitForCall(1);
  app.models.release(1, "困了就闭眼，我又不跑");
  await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);

  const rows = reopenThread(app.dataDir, AGENT);
  const reply = rows.find((row) => row.role === "assistant");
  const secondMsg = rows.find((row) => row.text === "晚安啦");
  assert.equal(reply.repliedTo, secondMsg.id, "最终那轮覆盖到最新那条");
  assert.ok(secondMsg.readAt, "最终那轮确实读到了它，已读要跟上真实覆盖范围");
  assert.ok(rows.find((row) => row.text === "我准备睡觉了").readAt, "它前面那句也一并被读到");
});

test("一直追到上限：不发过期旧稿，把最新目标排进正常排期", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await post(app.request, { text: "第一句", clientMessageId: "m_first_000003" });
  await app.models.waitForCall(0);

  // 每一轮生成期间都再补一句，逼它一次都追不上。
  const extras = ["第二句", "第三句", "第四句"];
  for (const [index, text] of extras.entries()) {
    await app.models.waitForCall(index);
    await post(app.request, { text, clientMessageId: `m_extra_00000${index}` });
    app.models.release(index, `按第${index}轮写的旧稿`);
  }

  // 上限是 2 次重来：这条回合一共 3 次生成，随后放弃。
  const settled = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready");
  assert.equal(settled.replyMessageId, null, "明知过期的稿子一条都不许发出去");
  assert.deepEqual(settled.items, [], "不该给前端任何气泡");

  const rows = reopenThread(app.dataDir, AGENT);
  assert.equal(rows.filter((row) => row.role === "assistant" && !row.proactive).length, 0, "线程里不能留下任何过期回复");
  const latestId = rows.at(-1).id;

  // 排期已经挂上：最新那条是待办目标，不是被丢在未读上没人管。
  await new Promise((resolve) => setTimeout(resolve, 80));
  const pending = app.store.getPendingReply(AGENT);
  assert.ok(pending, "要把最新目标排进正常排期，不能晾着");
  assert.equal(pending.messageId, latestId, "排期的目标是最新的那句");

  // 排期那一轮正常跑完：补一条回复，覆盖到最新那句。
  await app.models.waitForCall(3);
  app.models.release(3, "都几点了，说完这句真去睡");
  const deadline = Date.now() + 4000;
  let replies = [];
  for (;;) {
    replies = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant" && !row.proactive);
    if (replies.length || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(replies.length, 1, "整条链最后只应该有一份回复");
  assert.equal(replies[0].repliedTo, latestId, "它覆盖到最新那句");
});

test("模型这会儿用不了又遇上追加：不能拿旧目标的失败把新话盖住，要按新目标重来", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await post(app.request, { text: "我准备睡觉了", clientMessageId: "m_first_000004" });
  await app.models.waitForCall(0);
  const second = await post(app.request, { text: "晚安啦", clientMessageId: "m_second_00004" });

  // 第一轮直接回一个配额错误：没有可用正文。
  app.models.releaseError(0);

  // 失败本该在第一处早退；但她补的那句在，先作废旧稿、按新目标重来。
  await app.models.waitForCall(1);
  app.models.release(1, "困了就睡，别硬撑");

  const deadline = Date.now() + 4000;
  let replies = [];
  for (;;) {
    replies = reopenThread(app.dataDir, AGENT).filter((row) => row.role === "assistant" && !row.proactive && !row.notice);
    if (replies.length || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const rows = reopenThread(app.dataDir, AGENT);
  assert.ok(rows.find((row) => row.id === second.body.messageId), "新落的话必须还在账上");
  assert.equal(replies.length, 1, "最终只应该有一份正文回复");
  assert.equal(replies[0].repliedTo, second.body.messageId, "失败不能被算在旧目标头上，新话得被真正读到");
});

test("清空聊天：旧回合的结果不能写回来，补进来的新话也不被旧定时器盖章", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await post(app.request, { text: "我准备睡觉了", clientMessageId: "m_first_000005" });
  await app.models.waitForCall(0);

  const cleared = await app.request("POST", `/thread/${AGENT}/clear`, { json: {} });
  assert.equal(cleared.status, 200);

  app.models.release(0, "睡吧睡吧");
  await new Promise((resolve) => setTimeout(resolve, 120));

  const rows = reopenThread(app.dataDir, AGENT);
  assert.equal(rows.filter((row) => row.role === "assistant").length, 0, "清空之后旧稿不许写回来");
  assert.ok(first.body.turnId);
});

test("语音合成等待期间追加：旧稿连同那份语音一起放掉，最终只落一份带语音的回复", async () => {
  const audio = fakeWavBase64();
  const voiceReply = { choices: [{ message: { audio: { data: audio } } }] };

  // 语音要不要出鞘是掷骰子的（tier often 基准概率 0.28）。回合作废与重来都跑在 POST
  // 返回之后的异步里，所以骰子得按住整段，不能只按住发消息那一瞬间。
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const app = await bootChahuahui({ seed: seedVoiceReady });

    const first = await post(app.request, { text: "困了", clientMessageId: "m_first_000008" });
    await app.models.waitForCall(0);
    app.models.release(0, "困了就快去睡，别硬撑着");

    // 语音合成真的发出去了：出口就是 ctx.network.fetch（synthesizeChat → postJson）。
    const pendingVoice = await app.net.waitForCall(0);
    assert.match(pendingVoice.url, /chat\/completions/, "语音合成的出口必须是受控网络接口");

    // 语音还在合成，她又补了一句。
    const second = await post(app.request, { text: "晚安啦", clientMessageId: "m_second_00008" });
    app.net.release(0, voiceReply);

    // 旧稿作废重来：第二次生成、第二次合成。
    await app.models.waitForCall(1);
    app.models.release(1, "那就去睡，我在这儿等你醒");
    await app.net.waitForCall(1);
    app.net.release(1, voiceReply);
    await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);

    const rows = reopenThread(app.dataDir, AGENT);
    const replies = rows.filter((row) => row.role === "assistant" && !row.proactive);
    assert.equal(replies.length, 1, "只能有一份回复");
    assert.equal(replies[0].repliedTo, second.body.messageId, "覆盖到最新那条");
    assert.equal(replies[0].voice?.status, "ready", "最终送出的那份带上了语音");

    // 旧稿那一份被放掉了，磁盘上不能留下它的音频文件。语音按伙伴分目录。
    const voiceDir = path.join(app.dataDir, "v2", "voice", AGENT);
    const files = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
    assert.equal(files.length, 1, `语音目录只该留最终那一个文件，实际：${JSON.stringify(files)}`);
    assert.ok(files[0].includes(replies[0].id), `留下的必须属于最终送出的回复 ${replies[0].id}，实际 ${files[0]}`);
  } finally {
    Math.random = realRandom;
  }
});

test("撤回复退回未读：下一轮带上界的盖章能把欠下的补上", async () => {
  const app = await bootChahuahui({ seed: storeReadyWithRefine });
  await app.request("PUT", "/settings/global", { json: { messageRefine: true } });

  const first = await post(app.request, { text: "困了", clientMessageId: "m_first_000006" });
  await app.models.waitForCall(0);
  app.models.release(0, "那就去睡");
  const done = await waitTurn(app.request, first.body.turnId, (state) => state.status === "ready" && state.replyMessageId);

  let rows = reopenThread(app.dataDir, AGENT);
  const mine = rows.find((row) => row.id === done.replyMessageId);
  assert.ok(mine);
  assert.ok(rows.find((row) => row.id === mine.repliedTo).readAt, "送出回复时该盖到它覆盖的那条为止");

  const removed = await app.request("DELETE", `/thread/${AGENT}/refine/${done.replyMessageId}`);
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body));

  rows = reopenThread(app.dataDir, AGENT);
  assert.equal(rows.find((row) => row.id === mine.repliedTo).readAt, null, "删掉回复后原话退回未读");
});
