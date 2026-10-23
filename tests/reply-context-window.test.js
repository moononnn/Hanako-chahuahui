import test from "node:test";
import assert from "node:assert/strict";
import { selectReplyContext } from "../lib/memory.js";
import { threadToMessages } from "../lib/prompt.js";
import { bootChahuahui } from "./helpers/app-harness.js";

const history = (turns) => Array.from({ length: turns }, (_, i) => [
  { id: `u${i}`, role: "user", text: `第${i}轮的话` },
  { id: `a${i}`, role: "assistant", text: `第${i}轮的回应` },
]).flat();

test("近期按完整往来保留，连续用户补充算一组，不只围着最后一句", () => {
  const rows = history(15);
  rows.push({ role: "user", text: "我不玩！" }, { role: "user", text: "我打错字了" });
  const selected = selectReplyContext(rows);
  assert.equal(selected[0].id, "u4");
  assert.equal(selected.at(-2).text, "我不玩！");
  const messages = threadToMessages(selected, selected.length, { mergeConsecutiveUser: true });
  assert.equal(messages.at(-1).content, "我不玩！\n我打错字了");
  assert.equal(rows.at(-2).text, "我不玩！", "聊天原件不改");
});

test("一条长文只压副本首尾，不挤掉近12轮与最新纠正", () => {
  const rows = history(12);
  rows[18].text = "开头" + "长".repeat(20000) + "结尾";
  const selected = selectReplyContext(rows);
  assert.equal(selected.length, 24);
  assert.equal(selected[0].id, "u0");
  assert.ok(selected[18].text.startsWith("开头"));
  assert.ok(selected[18].text.endsWith("结尾"));
  assert.ok(selected.reduce((n, row) => n + row.text.length, 0) <= 12000);
  assert.ok(rows[18].text.length > 20000);
});

test("动作及硬撤回不消耗窗口，突发输入仍有行数与字数上限", () => {
  const rows = history(60);
  rows.push({ role: "user", text: "硬撤回", recalled: true, recallMode: "hard" });
  rows.push({ role: "user", text: "戳一戳", kind: "action" });
  const selected = selectReplyContext(rows);
  assert.equal(selected.at(-1).id, "a59");
  assert.ok(selected.length <= 48);
  const burst = selectReplyContext(Array.from({ length: 100 }, () => ({ role: "user", text: "字".repeat(1000) })));
  assert.equal(burst.length, 48);
  assert.ok(burst.reduce((n, row) => n + row.text.length, 0) <= 12000);
});

test("真实路由从完整线程读取：摘要水位推进也不把最近往来遮掉，补充合并送模型", async () => {
  const app = await bootChahuahui({ seed(store) {
    store.setPartnerSettings("nova", { phone: { holding: true, untilMs: Date.now() + 3600000 }, voice: { enabled: false } });
    const old = store.appendMessage("nova", { role: "user", text: "我平时不玩这个游戏" });
    store.appendMessage("nova", { role: "assistant", text: "好，那我讲讲背景" });
    store.markRolledThrough("nova", old.id);
  } });
  const first = await app.request("POST", "/turns", { json: { agentId: "nova", watching: true, text: "我不玩！" } });
  await app.request("POST", "/turns", { json: { agentId: "nova", watching: true, text: "我打错字了" } });
  const call = await app.models.waitForCall(0);
  const all = call.request.messages.map((row) => typeof row.content === "string" ? row.content : row.content.map((part) => part.text).join("\n")).join("\n");
  assert.ok(all.includes("我平时不玩这个游戏"));
  assert.equal(call.request.messages.at(-1).content, "我不玩！\n我打错字了");
  assert.ok(first.body.turnId);
  app.models.release(0, "晓得了，刚那句少打了个不字");
});

test("装载后一秒的恢复轮不能把仍在生成的实时凭证再启动一次", async () => {
  const app = await bootChahuahui({ seed(store) {
    store.setPartnerSettings("nova", { phone: { holding: true, untilMs: Date.now() + 3600000 }, voice: { enabled: false } });
  } });
  await app.request("POST", "/turns", { json: { agentId: "nova", watching: true, text: "这份回复慢一点" } });
  await app.models.waitForCall(0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(app.models.calls.length, 1, "恢复不能产生第二份并发请求");
  app.models.release(0, "只有这一份回复");
});
