// 茶话会 · 拾光记待办到点「由谁来说」的纯逻辑回归
// 只覆盖选人、指纹、文案这几件不碰宿主的事；真发消息那条路要实机看。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dueTodosFromSnapshot,
  nudgeKey,
  nudgeSeen,
  pickTodoNudger,
  todoNudgeText,
} from "../lib/todo-nudge.js";

const SNAPSHOT = {
  schemaVersion: 1,
  today: {
    date: "2026-10-05",
    todos: ["给薄荷浇水", "晚上买纸"],
    todosDue: [{ title: "给薄荷浇水", at: "16:00", soon: 0 }],
  },
};

test("从快照里只取到点那一份，soon 缺省当已经过点", () => {
  assert.deepEqual(dueTodosFromSnapshot(SNAPSHOT), [{ title: "给薄荷浇水", at: "16:00", soon: 0 }]);
  assert.deepEqual(
    dueTodosFromSnapshot({ today: { todosDue: [{ title: "提前量", at: "16:00", soon: 4 }] } }),
    [{ title: "提前量", at: "16:00", soon: 4 }],
    "拾光记提前摊出来的那几条要带着 soon 过来",
  );
});

test("快照缺失、字段缺失、坏数据都当没有，不抛错", () => {
  assert.deepEqual(dueTodosFromSnapshot(null), []);
  assert.deepEqual(dueTodosFromSnapshot({}), []);
  assert.deepEqual(dueTodosFromSnapshot({ today: {} }), []);
  assert.deepEqual(dueTodosFromSnapshot({ today: { todosDue: "坏" } }), []);
  assert.deepEqual(
    dueTodosFromSnapshot({ today: { todosDue: [{ at: "16:00" }, { title: "有标题", at: "17:00" }] } }),
    [{ title: "有标题", at: "17:00", soon: 0 }],
    "没标题的那条不算一条事",
  );
});

test("指纹：同一批待办认一个，内容变了就换", () => {
  const a = [{ title: "给薄荷浇水" }, { title: "晚上买纸" }];
  const b = [{ title: "晚上买纸" }, { title: "给薄荷浇水" }];
  assert.equal(nudgeKey(a, "2026-10-05"), nudgeKey(b, "2026-10-05"), "顺序不影响");
  assert.notEqual(nudgeKey(a, "2026-10-05"), nudgeKey(a, "2026-10-06"), "换天就换指纹");
  assert.notEqual(nudgeKey(a, "2026-10-05"), nudgeKey([{ title: "给薄荷浇水" }], "2026-10-05"));
  assert.equal(nudgeKey([], "2026-10-05"), "");
});

test("选人：关系走得最远的优先，一样远看谁最近说话", () => {
  assert.equal(pickTodoNudger([
    { agentId: "a", depth: 0.2, lastAt: 900 },
    { agentId: "b", depth: 0.8, lastAt: 100 },
    { agentId: "c", depth: 0.5, lastAt: 999 },
  ]), "b");
  assert.equal(pickTodoNudger([
    { agentId: "a", depth: 0.5, lastAt: 100 },
    { agentId: "c", depth: 0.5, lastAt: 999 },
  ]), "c");
});

test("选人：一个都没有、或者全是坏数据就是 null", () => {
  assert.equal(pickTodoNudger([]), null);
  assert.equal(pickTodoNudger(null), null);
  assert.equal(pickTodoNudger([{ depth: 1 }]), null, "没 id 的不算候选人");
});

test("由头文案：带上钟点和标题，定成这一轮开口的原因，不是可捎带的附注", () => {
  const text = todoNudgeText([{ title: "给薄荷浇水", at: "16:00" }], { userName: "她" });
  assert.match(text, /16:00 给薄荷浇水/);
  assert.match(text, /你现在来找 ta 的原因/);
  assert.match(text, /另找一个话题/);
  assert.match(text, /用你自己的语气/);
  assert.match(text, /可以就是一句提醒/);
  assert.match(text, /别摆清单、别催/);
  // “顺口带一句”会把它变成尾巴：模型就先去聊本来那件事、末尾补一句提醒
  assert.ok(!text.includes("顺口带一句"), text);
  // "勾"是记事本的动作，不能进伙伴嘴里
  assert.ok(!text.includes("勾"), text);
  assert.equal(todoNudgeText([], { userName: "她" }), "");
});

test("由头文案：快到点和已经过点分开讲，别说成已经拖了", () => {
  const text = todoNudgeText([
    { title: "吃维生素d", at: "08:00", soon: 3 },
    { title: "给薄荷浇水", at: "16:00", soon: 0 },
  ], { userName: "她" });
  assert.match(text, /快到点了：08:00 吃维生素d/);
  assert.match(text, /到了时间还没做：16:00 给薄荷浇水/);
  assert.match(text, /别当成已经拖了/);
  // 钟点还没到的绝不能说成「已经到了没做」，那是假话
  const soonOnly = todoNudgeText([{ title: "吃维生素d", at: "08:00", soon: 3 }], { userName: "她" });
  assert.ok(!soonOnly.includes("到了时间还没做："), soonOnly);
});

test("nudgeSeen：指纹对上算说过，换了就当没说，没指纹当说过", () => {  const runtime = { todoNudge: { key: "2026-10-05|给薄荷浇水", at: "x" } };
  assert.equal(nudgeSeen(runtime, "2026-10-05|给薄荷浇水"), true);
  assert.equal(nudgeSeen(runtime, "2026-10-05|给薄荷浇水|晚上买纸"), false);
  assert.equal(nudgeSeen({}, ""), true);
  assert.equal(nudgeSeen(runtime, ""), true);
});
