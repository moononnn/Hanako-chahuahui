import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { bootChahuahui } from "./helpers/app-harness.js";
import { canAnswerPoke } from "../lib/poke.js";

/**
 * 动作（戳一戳/小动作）不生成文字，也不该被当成「还有话没接」。
 *
 * 实机反馈的匿名场景：未读动作触发恢复轮，但 threadToMessages 已把动作剔出上下文，
 * 模型只能对着伙伴自己的旧话开口。动作只配动作回应（answerAction 的原设计），
 * 这组用例守的就是那条原设计；不保存私人原话或真实请求编号。
 */

const AGENT = "nova";

const pokeRow = (from) => ({
  role: from === "user" ? "user" : "assistant",
  kind: "poke",
  actionId: "poke",
  actionLabel: "戳一戳",
  from,
  text: from === "user" ? "对方戳了戳伙伴" : "伙伴戳了戳对方",
});

const wordRow = (role, text) => ({ role, text });

function seedReady(store) {
  store.setPartnerSettings(AGENT, {
    phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
    rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
    voice: { enabled: false },
  });
}

/** 重载恢复在装载后 1 秒才跑（index.js 的 recover 定时器），等它走完一轮。 */
const RECOVER_WAIT_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const kind of ["poke", "action"]) test(`末尾只剩未读的用户动作 ${kind}：重载恢复不生成，也不假盖已读`, async () => {
  let pokeId = null;
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store);
      store.appendMessage(AGENT, { ...wordRow("assistant", "我泡杯茶去"), proactive: true });
      store.appendMessage(AGENT, { ...wordRow("user", "手头还有点事"), readAt: new Date().toISOString() });
      store.appendMessage(AGENT, pokeRow("partner"));
      pokeId = store.appendMessage(AGENT, { ...pokeRow("user"), kind }).id;
    },
  });

  await sleep(RECOVER_WAIT_MS);

  assert.equal(app.models.calls.length, 0, "没有文字要回，不该发这次模型请求");
  const messages = app.store.getThread(AGENT).messages;
  assert.equal(messages.filter((row) => row.role === "assistant" && !row.kind).length, 1, "线程里只有原来那一条主动文字");
  assert.equal(messages.find((row) => row.id === pokeId).readAt, undefined, "戳一戳不是话，盖了已读就是假收据");
});

test("旧 pendingReply 只有动作：清掉待办，不生成也不盖已读", async () => {
  let actionId;
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store);
      store.appendMessage(AGENT, wordRow("assistant", "我先放个书签"));
      actionId = store.appendMessage(AGENT, { ...pokeRow("user"), kind: "action" }).id;
      store.setPendingReply(AGENT, {
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        mode: "scheduled", messageId: actionId, triggerMessageId: actionId,
      });
    },
  });
  await sleep(RECOVER_WAIT_MS);
  assert.equal(app.models.calls.length, 0);
  assert.equal(app.store.getPendingReply(AGENT), null);
  assert.equal(app.store.getThread(AGENT).messages.find((row) => row.id === actionId).readAt, undefined);
});

test("旧 pendingReply 指向动作：清掉旧目标，后面真文字仍能恢复", async () => {
  let pokeId = null;
  let wordId = null;
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store);
      store.appendMessage(AGENT, { ...wordRow("assistant", "有卡的地方喊一声"), proactive: true });
      pokeId = store.appendMessage(AGENT, pokeRow("user")).id;
      wordId = store.appendMessage(AGENT, wordRow("user", "我手头这点活干完了，你说的那个我看看")).id;
      store.setPendingReply(AGENT, {
        dueAt: new Date(Date.now() - 60 * 1000).toISOString(),
        mode: "scheduled",
        messageId: pokeId,
        triggerMessageId: pokeId,
      });
    },
  });

  const call = await app.models.waitForCall(0);
  assert.equal(app.models.calls.length, 1, "只为那句真文字生成一轮");
  app.models.release(0, "活干完了就好，剩下的我来盯");
  await sleep(300);

  const messages = app.store.getThread(AGENT).messages;
  const reply = messages.find((row) => row.role === "assistant" && row.repliedTo);
  assert.equal(reply.repliedTo, wordId, "回复目标是真文字，不是戳一戳");
  assert.equal(app.store.getPendingReply(AGENT), null, "旧待办被清干净，不留悬账");

  const last = call.request.messages[call.request.messages.length - 1];
  assert.equal(last.role, "user", "送进模型的上下文末端是她那句话");
  assert.match(String(last.content), /我手头这点活干完了/);
});

test("真文字后面夹着戳一戳：仍然回复那句真文字", async () => {
  let wordId = null;
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store);
      store.appendMessage(AGENT, { ...wordRow("assistant", "我盯着呢"), proactive: true });
      wordId = store.appendMessage(AGENT, wordRow("user", "这回迁完了没")).id;
      store.appendMessage(AGENT, pokeRow("user"));
      store.appendMessage(AGENT, pokeRow("partner"));
    },
  });

  await app.models.waitForCall(0);
  app.models.release(0, "迁完了就歇着，剩下的明天说");
  await sleep(300);
  const messages = app.store.getThread(AGENT).messages;
  const reply = messages.find((row) => row.role === "assistant" && row.repliedTo);
  assert.equal(reply.repliedTo, wordId, "后尾那个戳一戳不能夺走回复目标");
});

test("生成期间来了一下戳一戳：不排第二轮文字", async () => {
  const app = await bootChahuahui({ seed: seedReady });

  const first = await app.request("POST", "/turns", {
    json: { agentId: AGENT, watching: true, text: "我准备收工了", clientMessageId: "m_action_000001" },
  });
  assert.equal(first.status, 200);
  await app.models.waitForCall(0);

  const poked = await app.request("POST", `/action/${AGENT}`);
  assert.equal(poked.status, 200, "戳一戳这条路照旧能走");
  app.models.release(0, "收工好啊，剩下的明天再说");

  await sleep(600);
  const messages = app.store.getThread(AGENT).messages;
  const texts = messages.filter((row) => row.role === "assistant" && !row.kind);
  assert.equal(texts.length, 1, "戳一戳不生成第二轮文字");
  assert.equal(texts[0].repliedTo, messages.find((row) => row.role === "user" && row.text === "我准备收工了").id);
  assert.ok(
    messages.some((row) => row.from === "user" && ["poke", "action"].includes(row.kind)),
    "动作照样落线程，回戳才有得接",
  );
});

test("手动重新生成不能把伙伴动作变成文字", async () => {
  let actionId;
  const app = await bootChahuahui({
    seed(store) {
      seedReady(store);
      store.setGlobalSettings({ messageRefine: true });
      store.appendMessage(AGENT, { ...wordRow("user", "刚才那个书名叫什么"), readAt: new Date().toISOString() });
      store.appendMessage(AGENT, pokeRow("user"));
      actionId = store.appendMessage(AGENT, pokeRow("partner")).id;
    },
  });
  const request = app.request("POST", `/thread/${AGENT}/refine/${actionId}/regenerate`);
  await sleep(150);
  // 修前请求会误入模型；放行模拟出口，避免失败基线挂住。
  if (app.models.calls.length) app.models.release(0, "这本书我再找找");
  const response = await request;
  assert.equal(response.status, 409, "动作不属于能重新生成的文字回复");
  assert.equal(app.models.calls.length, 0, "拒绝必须发生在模型调用前");
});

test("辅助语义判断只取真正的用户发言，不取尾部动作", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const compose = source.slice(source.indexOf("async function composeReply("), source.indexOf("async function runTurn("));
  assert.match(compose, /const latestUser = .*isSpeechMessage\(row\)/, "待办、搜索与兴趣应使用过滤动作后的最新用户文字");
});

test("回戳的判定没被改：她戳一下，ta 仍然可以戳回去", () => {
  assert.equal(canAnswerPoke([pokeRow("partner"), pokeRow("user")]), true);
  assert.equal(canAnswerPoke([pokeRow("partner"), pokeRow("user"), pokeRow("partner")]), false);
});
