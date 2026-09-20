import test from "node:test";
import assert from "node:assert/strict";

import {
  agentIdFromSession,
  appendWorkEvent,
  buildWorkfeedText,
  isTeaHouseSession,
  normalizeWorkEvent,
  recentWorkEvents,
  textFromSessionMessage,
  workLifeDay,
} from "../lib/workfeed.js";

const localEarly = new Date(2026, 8, 17, 3, 30);
const at = localEarly.toISOString();

test("从字符串和文本块提取会话正文", () => {
  assert.equal(textFromSessionMessage({ content: "  修一下窗口  " }), "修一下窗口");
  assert.equal(textFromSessionMessage({ content: [{ type: "text", text: "看下" }, { type: "image", data: "x" }, { type: "text", text: "图片" }] }), "看下 图片");
  assert.equal(textFromSessionMessage({ content: [{ type: "tool", text: "不要进来" }] }), "");
});

test("从 agents 会话路径映射伙伴", () => {
  assert.equal(agentIdFromSession("C:/hana/agents/hanako/sessions/a.jsonl"), "hanako");
  assert.equal(agentIdFromSession("C:/unknown/session.jsonl", { agentId: "carol" }), "carol");
});

test("茶话会来源会被过滤，避免工作经历回流", () => {
  assert.equal(isTeaHouseSession("C:/hana/app-data/chahuahui/v2/threads/hanako.json"), true);
  assert.equal(isTeaHouseSession("C:/hana/agents/hanako/sessions/a.jsonl"), false);
  assert.equal(isTeaHouseSession("C:/hana/agents/hanako/sessions/a.jsonl", { source: "app:chahuahui" }), true);
});

test("只接收 message_end 的用户或伙伴正文", () => {
  const base = {
    type: "message_end",
    message: { role: "user", content: "今天继续修茶话会", entryId: "entry-1" },
  };
  const row = normalizeWorkEvent(base, "C:/hana/agents/hanako/sessions/a.jsonl", { now: localEarly });
  assert.deepEqual(row, {
    id: "entry-1",
    agentId: "hanako",
    lifeDay: "2026-09-16",
    at,
    role: "user",
    text: "今天继续修茶话会",
  });
  assert.equal(row.sessionPath, undefined, "新事件不应持久化主对话路径");
  assert.equal(normalizeWorkEvent({ type: "turn_end", message: base.message }, "C:/hana/agents/hanako/sessions/a.jsonl"), null);
  assert.equal(normalizeWorkEvent({ ...base, message: { role: "system", content: "内部" } }, "C:/hana/agents/hanako/sessions/a.jsonl"), null);
});

test("生活日凌晨四点切换，和茶话会口径一致", () => {
  assert.equal(workLifeDay(new Date("2026-09-17T03:59:59")), "2026-09-16");
  assert.equal(workLifeDay(new Date("2026-09-17T04:00:00")), "2026-09-17");
});

test("工作事件去重、限量并按伙伴和生活日取最近几条", () => {
  let feed = { events: [] };
  const first = normalizeWorkEvent({ type: "message_end", message: { role: "user", content: "先看边界", entryId: "a" } }, "C:/hana/agents/hanako/sessions/a.jsonl", { now: new Date("2026-09-17T10:00:00") });
  const second = normalizeWorkEvent({ type: "message_end", message: { role: "assistant", content: "我来排查", entryId: "b" } }, "C:/hana/agents/hanako/sessions/a.jsonl", { now: new Date("2026-09-17T10:01:00") });
  feed = appendWorkEvent(feed, first);
  feed = appendWorkEvent(feed, first);
  feed = appendWorkEvent(feed, second);
  assert.equal(feed.events.length, 2);
  assert.equal(recentWorkEvents(feed, "hanako", { lifeDay: "2026-09-17" }).length, 2);
  assert.equal(recentWorkEvents(feed, "carol", { lifeDay: "2026-09-17" }).length, 0);
});

test("给伙伴的工作背景有明确边界，不变成任务清单", () => {
  const feed = {
    events: [
      { id: "a", agentId: "hanako", lifeDay: "2026-09-17", at, role: "user", text: "讨论电脑和手机的边界" },
    ],
  };
  const text = buildWorkfeedText(feed, "hanako", { lifeDay: "2026-09-17" });
  assert.match(text, /电脑那边最近发生的事/);
  assert.match(text, /讨论电脑和手机的边界/);
  assert.match(text, /不要汇报/);
  assert.equal(buildWorkfeedText(feed, "carol", { lifeDay: "2026-09-17" }), "");
});

test("工作背景里的用户名标签跟着运行时走，不写死", () => {
  const feed = {
    events: [
      { id: "a", agentId: "hanako", lifeDay: "2026-09-17", at, role: "user", text: "讨论电脑和手机的边界" },
      { id: "b", agentId: "hanako", lifeDay: "2026-09-17", at: at + 1, role: "assistant", text: "嗯" },
    ],
  };
  const text = buildWorkfeedText(feed, "hanako", { lifeDay: "2026-09-17", userName: "阿舟" });
  assert.match(text, /阿舟：讨论电脑和手机的边界/);
  assert.match(text, /伙伴：嗯/);
  const fallback = buildWorkfeedText(feed, "hanako", { lifeDay: "2026-09-17" });
  assert.match(fallback, /你：讨论电脑和手机的边界/, "没给名字时退回中性称呼");
  assert.ok(!fallback.includes("阿舟"), "没给名字时不能沿用别人的名字");
});

test("电脑端生活联动：默认开，关得上，清得掉", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createStore } = await import("../lib/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-workfeed-"));
  const store = createStore(dir);
  assert.equal(store.getGlobalSettings().workfeedEnabled, true, "默认是开的（这是茶话会的一半）");
  store.setGlobalSettings({ workfeedEnabled: false });
  assert.equal(store.getGlobalSettings().workfeedEnabled, false, "她能自己关掉");
  store.appendWorkEvent({ id: "e1", agentId: "hanako", lifeDay: "2026-09-19", at: Date.now(), role: "user", text: "一起去排查那个 bug" });
  assert.equal(store.readWorkfeed().events.length, 1);
  store.clearWorkfeed();
  assert.equal(store.readWorkfeed().events.length, 0, "清空要真的空");
});
