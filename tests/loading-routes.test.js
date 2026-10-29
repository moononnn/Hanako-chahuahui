import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function threadRoute({ messages = [], listPartners = async () => [], query = {}, partnerSkin = null } = {}) {
  let handler;
  vm.runInNewContext(source.slice(source.indexOf('      app.get("/thread/:agentId"'), source.indexOf('      app.post("/thread/:agentId/read"')), {
    app: { get(_path, callback) { handler = callback; } },
    store: { getThread: () => ({ messages }), setLastPartner() {}, getPref: () => ({}) },
    getPersona: async () => ({ readAt: null, errors: {} }), listPartners,
    // 伙伴那侧的气泡：这张测试只关心路由自己的行为，这里给个不落盘的桩
    partnerSkinFor: () => partnerSkin,
    turns: new Map(), deliveringReplies: new Set(),
    recallEligibility: () => ({ allowed: true }), describeError: (error) => ({ message: error.message }),
  });
  return handler({ req: { param: () => "nova", query: (name) => query[name] }, json: (value) => value });
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

test("聊天路由分页：最近一页带总数，往前翻用 seq 当游标", async () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i + 1}`, role: i % 2 ? "assistant" : "user", text: String(i + 1), seq: i + 1,
  }));
  const latest = await threadRoute({ messages, query: { limit: "4" } });
  assert.deepEqual(latest.messages.map((m) => m.seq), [7, 8, 9, 10]);
  assert.equal(latest.total, 10);
  assert.equal(latest.hasMore, true);

  const older = await threadRoute({ messages, query: { before: "7", limit: "4" } });
  assert.deepEqual(older.messages.map((m) => m.seq), [3, 4, 5, 6]);
  assert.equal(older.hasMore, true);

  const head = await threadRoute({ messages, query: { before: "3", limit: "4" } });
  assert.deepEqual(head.messages.map((m) => m.seq), [1, 2]);
  assert.equal(head.hasMore, false);
});

test("聊天路由分页：硬撤回先过滤再分页，不占一页的名额", async () => {
  const messages = [
    { id: "m1", role: "user", text: "撤回的", seq: 1, recalled: true, recallMode: "hard" },
    { id: "m2", role: "user", text: "还在", seq: 2 },
    { id: "m3", role: "assistant", text: "回复", seq: 3 },
  ];
  const result = await threadRoute({ messages, query: { limit: "2" } });
  assert.deepEqual(result.messages.map((m) => m.id), ["m2", "m3"]);
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, false);
});

test("伙伴列表路由：未读、忙碌和背景共用已读快照，不再读第二三次聊天账", async () => {
  let handler;
  let threadReads = 0;
  const thread = { messages: [{ role: "assistant", text: "最近一句", at: "2026-10-02T00:00:00Z" }], pendingReply: { due: 1 } };
  const settings = { sleep: {}, awaiting: {}, phone: {}, vision: {}, background: { file: "room.png" } };
  vm.runInNewContext(source.slice(source.indexOf('      app.get("/partners"'), source.indexOf('      app.get("/adaptation/:agentId"')), {
    app: { get(_path, callback) { handler = callback; } }, listPartners: async () => [{ id: "nova" }],
    // 伙伴那侧的皮肤清单与映射：这张测试只数聊天账读了几次，给个静态值就够
    PARTNER_SKIN_IDS: [], partnerSkinFor: () => null,
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
