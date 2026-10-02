import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function threadRoute({ messages = [], listPartners = async () => [] } = {}) {
  let handler;
  vm.runInNewContext(source.slice(source.indexOf('      app.get("/thread/:agentId"'), source.indexOf('      app.post("/thread/:agentId/read"')), {
    app: { get(_path, callback) { handler = callback; } },
    store: { getThread: () => ({ messages }), setLastPartner() {}, getPref: () => ({}) },
    getPersona: async () => ({ readAt: null, errors: {} }), listPartners,
    turns: new Map(), deliveringReplies: new Set(),
    recallEligibility: () => ({ allowed: true }), describeError: (error) => ({ message: error.message }),
  });
  return handler({ req: { param: () => "nova" }, json: (value) => value });
}

test("聊天路由：普通记录不为撤回占位去问一次宿主伙伴清单", async () => {
  let lists = 0;
  const result = await threadRoute({
    messages: [{ id: "m1", role: "assistant", text: "正常回复" }],
    listPartners: async () => { lists += 1; return [{ id: "nova", name: "阿岚" }]; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages[0].text, "正常回复");
  assert.equal(lists, 0);
});

test("聊天路由：实际有伙伴硬撤回时才取称呼，宿主失败仍有中性占位", async () => {
  const messages = [{ id: "m1", role: "assistant", recalled: true, recallMode: "hard", text: "不能再展示的原话" }];
  const named = await threadRoute({ messages, listPartners: async () => [{ id: "nova", name: "阿岚" }] });
  assert.equal(named.messages[0].text, "阿岚撤回了一条消息");
  assert.equal(named.messages[0].kind, "recalled");
  const fallback = await threadRoute({ messages, listPartners: async () => { throw new Error("offline"); } });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.messages[0].text, "对方撤回了一条消息");
});

test("伙伴列表路由：未读、忙碌和背景共用已读快照，不再读第二三次聊天账", async () => {
  let handler;
  let threadReads = 0;
  const thread = { messages: [{ role: "assistant", text: "最近一句", at: "2026-10-02T00:00:00Z" }], pendingReply: { due: 1 } };
  const settings = { sleep: {}, awaiting: {}, phone: {}, vision: {}, background: { file: "room.png" } };
  vm.runInNewContext(source.slice(source.indexOf('      app.get("/partners"'), source.indexOf('      app.get("/adaptation/:agentId"')), {
    app: { get(_path, callback) { handler = callback; } }, listPartners: async () => [{ id: "nova" }],
    store: {
      getThread() { threadReads += 1; return thread; },
      getPartnerSettings: () => settings,
      unreadCount(_id, snapshot) { assert.equal(snapshot, thread); return 1; },
      getPendingReply() { throw new Error("不该再读取一次聊天账"); },
      getGlobalSettings: () => ({}), getLastPartner: () => null, getCorruptNotice: () => null,
    },
    dozingNow: () => ({ dozing: false }), advancePhone: () => ({ holding: true }),
    normalizeBadge: () => null, fallbackBadge: (value) => { assert.equal(value.busy, true); return "busy"; },
    isAwaitingThread: () => false, badgeText: () => "忙着", effectiveVisionConfig: () => ({}),
    ACTION_STYLES: [], describeError: (error) => ({ message: error.message }),
  });
  const result = await handler({ json: (value) => value });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(threadReads, 1);
  assert.equal(result.partners[0].unread, 1);
  assert.equal(result.partners[0].lastMessage.text, "最近一句");
  assert.equal(result.partners[0].background, settings.background);
});
