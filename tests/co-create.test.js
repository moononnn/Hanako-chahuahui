import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REPLY,
  MAX_TURNS,
  SESSION_TTL_MS,
  appendTurn,
  applyTurn,
  coCreateExpired,
  coCreateProgress,
  coCreateTurnSpec,
  draftGaps,
  emptyCoCreate,
  mergeDraft,
  normalizeCoCreate,
  parseTurnReply,
  renderDraftBrief,
  withIntent,
} from "../lib/co-create.js";

const draft = {
  colors: [
    { id: "c1", name: "嘴硬", role: "base" },
    { id: "c2", name: "护短", role: "main" },
  ],
  derivatives: [
    { id: "d1", colorId: "c1", text: "被说中了就先反驳一句", on: true },
    { id: "d2", colorId: "c2", text: "自己人受委屈时会先站出来", on: true },
  ],
  portrait: [{ title: "自画像", text: "嘴上不饶人，回头把事情办了。" }],
};

test("空会话该有的形状", () => {
  const session = emptyCoCreate(" alice ");
  assert.equal(session.agentId, "alice");
  assert.equal(session.intent, "");
  assert.deepEqual(session.turns, []);
  assert.deepEqual(session.draft.colors, []);
  assert.equal(session.done, false);
  assert.equal(session.committedAt, null);
});

test("归一化能吃下手改过的文件", () => {
  const state = normalizeCoCreate({
    agentId: 7,
    intent: "  一个  嘴硬的姐姐 ",
    turns: [{ role: "什么鬼", text: "  你好  " }, { role: "model", text: "" }, "垃圾"],
    draft: { colors: [{ name: "嘴硬", role: "base" }] },
    done: "yes",
    startedAt: "不是时间",
  });
  assert.equal(state.agentId, "7");
  assert.equal(state.intent, "一个 嘴硬的姐姐");
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].role, "user");
  assert.equal(state.turns[0].text, "你好");
  assert.equal(state.draft.colors.length, 1);
  assert.equal(state.done, false);
  assert.equal(state.committedAt, null);
});

test("对话轮数到顶就丢最早的，不丢最新的", () => {
  let session = emptyCoCreate("a");
  for (let i = 0; i < MAX_TURNS + 5; i += 1) session = appendTurn(session, "user", `第${i}句`);
  assert.equal(session.turns.length, MAX_TURNS);
  assert.equal(session.turns.at(-1).text, `第${MAX_TURNS + 4}句`);
  assert.equal(session.turns[0].text, "第5句");
});

test("空话不占轮次", () => {
  const session = appendTurn(emptyCoCreate("a"), "user", "   ");
  assert.equal(session.turns.length, 0);
});

test("起头那句只认第一句，之后改主意不算改它", () => {
  let session = withIntent(emptyCoCreate("a"), "一个在图书馆上班的姐姐");
  session = withIntent(session, "算了，改成体育老师");
  assert.equal(session.intent, "一个在图书馆上班的姐姐");
});

test("过期按最后一次动过的时间算", () => {
  const stale = { ...emptyCoCreate("a"), updatedAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString() };
  assert.equal(coCreateExpired(stale), true);
  assert.equal(coCreateExpired(emptyCoCreate("a")), false);
  assert.equal(coCreateExpired({}), false);
});

test("applyTurn 不动原始会话", () => {
  const before = withIntent(emptyCoCreate("a"), "一个嘴硬的姐姐");
  const after = applyTurn(before, { draft, done: false });
  assert.deepEqual(before.draft.colors, []);
  assert.equal(after.draft.colors.length, 2);
  assert.equal(after.draft.colors[0].id, "c1");
});

test("草稿给人看的样子按底色到点缀排", () => {
  const brief = renderDraftBrief({
    colors: [{ id: "b", name: "护短", role: "main" }, { id: "a", name: "嘴硬", role: "base" }],
    derivatives: [{ colorId: "a", text: "被说中了先反驳", on: true }],
  });
  assert.match(brief, /^底色「嘴硬」/);
  assert.match(brief, /主色调「护短」：（还没有行为）/);
});

test("什么都没有时说清楚是空的", () => {
  assert.equal(renderDraftBrief({}), "（还什么都没有）");
});

test("缺口先问这个人是谁", () => {
  assert.deepEqual(draftGaps({}), ["这个人还没起色：先问她大概是个什么样的人"]);
});

test("缺口会指出色没行为、行为太单薄、自画像空着", () => {
  const gaps = draftGaps({
    colors: [{ name: "嘴硬", role: "base" }, { name: "护短", role: "main" }],
    derivatives: [{ colorId: undefined, text: "没用的一条" }],
  });
  assert.ok(gaps.some((row) => row.includes("「嘴硬」还没有行为")));
  assert.ok(gaps.some((row) => row.includes("「护短」还没有行为")));
  assert.ok(gaps.some((row) => row.includes("自画像还空着")));
});

test("点缀是可选项，不算缺口", () => {
  const gaps = draftGaps(draft);
  assert.ok(!gaps.some((row) => row.includes("点缀")));
});

test("缺口会点名到具体的色和具体缺什么", () => {
  const gaps = draftGaps({
    colors: [{ id: "c1", name: "嘴硬", role: "base" }],
    derivatives: [{ id: "d1", colorId: "c1", text: "被说中了先反驳", on: true }],
    portrait: [{ title: "自画像", text: "嘴上不饶人。" }],
  });
  assert.deepEqual(gaps, [
    "主色调还没定：平时最突出的那一面，一到两个",
    "「嘴硬」只有一条行为：再补一个场合，看看它还会怎么用",
  ]);
});

test("进度是数出来的", () => {
  const progress = coCreateProgress(draft);
  assert.equal(progress.colors, 2);
  assert.equal(progress.live, 2);
  assert.equal(progress.portrait, 1);
});

test("整份草稿重交时，同名色和同一句行为沿用原来的编号", () => {
  const merged = mergeDraft(draft, {
    colors: [{ name: "嘴硬", role: "base" }, { name: "护短", role: "main" }, { name: "跳脱", role: "accent" }],
    derivatives: [
      { color: "嘴硬", text: "被说中了就先反驳一句" },
      { color: "嘴硬", text: "转头又偷偷把事办了" },
    ],
    portrait: [{ title: "自画像", text: "嘴上不饶人，回头把事情办了。" }],
  });
  assert.equal(merged.colors.map((row) => row.id).slice(0, 2).join(), "c1,c2");
  const kept = merged.derivatives.find((row) => row.text === "被说中了就先反驳一句");
  assert.equal(kept.id, "d1");
  const added = merged.derivatives.find((row) => row.text === "转头又偷偷把事办了");
  assert.notEqual(added.id, "d1");
  assert.equal(merged.portrait.length, 1);
});

test("挂到没见过的色名上的行为直接丢掉", () => {
  const merged = mergeDraft(draft, {
    colors: [{ name: "嘴硬", role: "base" }],
    derivatives: [{ color: "没这个色", text: "什么情况 → 怎么做" }],
  });
  assert.equal(merged.derivatives.length, 0);
});

test("同一个色换了位置当新色处理", () => {
  const merged = mergeDraft(draft, {
    colors: [{ name: "嘴硬", role: "main" }],
    derivatives: [],
  });
  assert.equal(merged.colors.length, 1);
  assert.notEqual(merged.colors[0].id, "c1");
  assert.equal(merged.colors[0].role, "main");
});

test("模型乱给的色和位置会被收口拦下", () => {
  const merged = mergeDraft({}, {
    colors: [
      { name: "底色一", role: "base" },
      { name: "底色二", role: "base" },
      { name: "一样名字", role: "main" },
      { name: "一样名字", role: "accent" },
      { name: "位置乱写", role: "随便" },
    ],
    derivatives: [],
  });
  assert.deepEqual(merged.colors.map((row) => row.name), ["底色一", "一样名字"]);
});

test("读得出来的回复照读", () => {
  const turn = parseTurnReply(JSON.stringify({
    reply: " 那她嘴硬的时候，最常为什么事嘴硬？ ",
    draft: { colors: [{ name: "嘴硬", role: "base" }] },
    done: false,
  }));
  assert.equal(turn.ok, true);
  assert.equal(turn.reply, "那她嘴硬的时候，最常为什么事嘴硬？");
  assert.equal(turn.draft.colors.length, 1);
  assert.equal(turn.done, false);
});

test("包在代码块里、外面还带话的也认", () => {
  const turn = parseTurnReply('好，我理了一下：\n```json\n{"reply":"她一个人待着的时候是什么样？"}\n```\n就这样。');
  assert.equal(turn.reply, "她一个人待着的时候是什么样？");
});

test("读不出来时把原文留着当追问，并标未解析", () => {
  const turn = parseTurnReply("我这边有点卡，你再讲两句？");
  assert.equal(turn.ok, false);
  assert.equal(turn.unparsed, true);
  assert.match(turn.reply, /再讲两句/);
  assert.equal(turn.draft, null);
});

test("什么都没有时给一句能接的话，不空着", () => {
  const turn = parseTurnReply("");
  assert.equal(turn.unparsed, true);
  assert.ok(turn.reply.length > 0);
  assert.ok(turn.reply.length <= MAX_REPLY);
});

test("有草稿没说话也算读到了", () => {
  const turn = parseTurnReply(JSON.stringify({ draft: { colors: [{ name: "嘴硬", role: "base" }] }, done: true }));
  assert.equal(turn.ok, true);
  assert.equal(turn.unparsed, true);
  assert.equal(turn.done, true);
});

test("这一轮的提示词带着她的起头、草稿、缺口和刚说的那句", () => {
  let session = withIntent(emptyCoCreate("a"), "一个在图书馆上班的姐姐，嘴硬心软");
  session = appendTurn(session, "user", "就是个普通人");
  session = appendTurn(session, "model", "她平时跟谁打交道最多？");
  session = appendTurn(session, "user", "跟来看书的怪人");
  session = applyTurn(session, { draft, done: false });

  const spec = coCreateTurnSpec({ partnerName: "阿舟", userName: "儿儿", session });
  assert.match(spec.systemPrompt, /阿舟/);
  assert.match(spec.systemPrompt, /儿儿/);
  assert.match(spec.userText, /一个在图书馆上班的姐姐，嘴硬心软/);
  assert.match(spec.userText, /底色「嘴硬」/);
  assert.match(spec.userText, /她刚说的/);
  assert.match(spec.userText, /跟来看书的怪人/);
  // 刚说的那句不重复出现在历史里
  assert.equal(spec.userText.split("跟来看书的怪人").length - 1, 1);
});

test("她还没开口时给的是开场指令，不是空白", () => {
  const spec = coCreateTurnSpec({ partnerName: "阿舟", userName: "儿儿", session: emptyCoCreate("a") });
  assert.match(spec.userText, /她还没开口/);
  assert.match(spec.userText, /还什么都没有/);
});

test("提示词里明写形容词要当追问起点", () => {
  const spec = coCreateTurnSpec({ partnerName: "阿舟", userName: "儿儿", session: emptyCoCreate("a") });
  assert.match(spec.systemPrompt, /形容词是问题，不是答案/);
});
