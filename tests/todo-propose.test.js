// 覆盖「只提议、不落笔」这一层：判定、提议记录的生死、以及给 ta 看的那句问话。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findProposal, hasProposal, makeProposal, normalizeProposals, proposalAskText, proposalExpiry,
  proposalKey, proposeFromMessage, PROPOSE_MAX,
} from "../lib/todo-propose.js";

const SNAPSHOT = {
  today: {
    todosPending: [
      { id: "t1", title: "吃维生素d", date: "2026-10-06", at: "08:00" },
      { id: "t2", title: "给薄荷浇水", date: "2026-10-06", at: "15:00" },
    ],
  },
};

const AT = new Date("2026-10-06T15:12:23+08:00");

test("提议：她说完了、认得出是哪条，就提议", () => {
  const hit = proposeFromMessage({ text: "浇完啦", snapshot: SNAPSHOT });
  assert.equal(hit.proposed, true);
  assert.equal(hit.todo.id, "t2");
  assert.equal(proposeFromMessage({ text: "维生素d吃了", snapshot: SNAPSHOT }).todo.id, "t1");
});

test("提议：拿不准的一律不弹窗，也不动账", () => {
  for (const text of ["今天有点累", "浇完了吗", "哎妈我吃完了", "我待会儿吃维生素d"]) {
    assert.equal(proposeFromMessage({ text, snapshot: SNAPSHOT }).proposed, false, text);
  }
  assert.equal(proposeFromMessage({ text: "浇完啦", snapshot: null }).proposed, false);
});

test("提议这一步压根没有落笔的口子：入参里压根没有 ctx", () => {
  // 传一个会炸的 bus 进去也不该被碰——这一层只判，跨 App 调用在确认之后才发生。
  const exploding = new Proxy({}, { get() { throw new Error("这一层不该碰 bus"); } });
  const hit = proposeFromMessage({ text: "浇完啦", snapshot: SNAPSHOT, ctx: exploding, bus: exploding });
  assert.equal(hit.proposed, true);
});

test("提议记录：同一条待办永远是同一个键", () => {
  assert.equal(proposalKey("t2"), "todo:t2");
  assert.equal(proposalKey(""), "");
  const a = makeProposal({ todo: { id: "t2", title: "给薄荷浇水", at: "15:00", date: "2026-10-06" }, now: AT });
  const b = makeProposal({ todo: { id: "t2", title: "给薄荷浇水" }, now: new Date("2026-10-06T20:00:00+08:00") });
  assert.equal(a.key, b.key);
  assert.equal(a.title, "给薄荷浇水");
  assert.equal(a.at, "15:00");
});

test("提议记录：过了当天 24 点自己收走，账本一个字不动", () => {
  const made = makeProposal({ todo: { id: "t2", title: "给薄荷浇水" }, now: AT });
  assert.equal(made.expiresAt, proposalExpiry(AT));
  assert.equal(normalizeProposals([made], AT).length, 1);
  // 次日零点一过：没了。它不会变成"已确认"，也不会偷偷去改账。
  assert.equal(normalizeProposals([made], new Date("2026-10-07T00:00:01+08:00")).length, 0);
  assert.equal(findProposal(normalizeProposals([made], new Date("2026-10-07T00:00:01+08:00")), made.key), null);
});

test("提议记录：同一条只挂一个，挂太多个不是确认是账单", () => {
  const rows = [
    makeProposal({ todo: { id: "t2", title: "给薄荷浇水" }, now: AT }),
    makeProposal({ todo: { id: "t2", title: "给薄荷浇水" }, now: new Date("2026-10-06T15:20:00+08:00") }),
    makeProposal({ todo: { id: "t1", title: "吃维生素d" }, now: AT }),
  ];
  const list = normalizeProposals(rows, AT);
  assert.equal(list.length, 2);
  assert.equal(list.filter((r) => r.key === "todo:t2").length, 1);
  assert.equal(hasProposal(list, "t2"), true);
  assert.equal(hasProposal(list, "t9"), false);

  const many = ["a", "b", "c", "d", "e"].map((id) => makeProposal({ todo: { id, title: `待办${id}` }, now: AT }));
  assert.equal(normalizeProposals(many, AT).length, PROPOSE_MAX);
});

test("提议记录：认得出与认不出", () => {
  const made = makeProposal({ todo: { id: "t2", title: "给薄荷浇水" }, now: AT });
  assert.equal(findProposal([made], "todo:t2")?.title, "给薄荷浇水");
  assert.equal(findProposal([made], "todo:zz"), null);
  assert.equal(findProposal([made], ""), null);
  assert.equal(findProposal(null, "todo:t2"), null);
  assert.equal(makeProposal({ todo: { id: "", title: "给薄荷浇水" } }), null);
  assert.equal(makeProposal({ todo: { id: "t2", title: "" } }), null);
});

test("给 ta 看的那句：只能是问句，反向断言那几个记账话不许出现", () => {
  const text = proposalAskText({ title: "给薄荷浇水" }, { userName: "小林" });
  assert.match(text, /给薄荷浇水/);
  assert.match(text, /问句/);
  // 账本一个字没动，这几句说出口就是假的：ta 很容易顺口说，提示词里必须禁死。
  for (const word of ["记上了", "已经划掉了", "账对上了"]) {
    assert.ok(text.includes(word), `提示里要显式禁掉「${word}」`);
  }
  // 禁令行本身是"别这么说"，所以只在禁止清单里出现一次，位置也不能是陈述口气。
  assert.equal((text.match(/严禁/g) ?? []).length, 1);
  assert.equal(proposalAskText({ title: "" }), "");
});
