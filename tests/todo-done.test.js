// 茶话会 · 「她说我做完了」→ 顺手把拾光记那条待办勾掉
// 覆盖判定规则、认领规则、跨 App 调用与失败时的不打扰。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";

import { completeFromMessage, doneByOwnAction, doneFactText, looksDone, matchPendingTodo, pendingFromSnapshot, TODO_COMPLETE_METHOD } from "../lib/todo-done.js";

const SNAPSHOT = {
  today: {
    todosPending: [
      { id: "t1", title: "吃维生素d", date: "2026-10-06", at: "08:00" },
      { id: "t2", title: "给薄荷浇水", date: "2026-10-06", at: "" },
    ],
  },
};

test("完成语气：她把这事说成已经落地了", () => {
  assert.equal(looksDone("维生素D我吃啦"), true);
  assert.equal(looksDone("稿子写完了"), true);
  assert.equal(looksDone("刚把快递寄了"), true);
  assert.equal(looksDone("今天有点累"), false);
  assert.equal(looksDone(""), false);
});

test("反证：待会儿、要、还没这类一律不算完成，宁可漏也不划错", () => {
  assert.equal(looksDone("我待会儿吃维生素d"), false);
  assert.equal(looksDone("还没吃呢，等会再说"), false);
  assert.equal(looksDone("提醒我八点吃维生素d"), false);
  assert.equal(looksDone("该写稿了"), false);
  assert.equal(looksDone("正在写"), false);
});

test("认领：她提到哪条就是哪条", () => {
  assert.equal(matchPendingTodo("维生素d我吃了", SNAPSHOT.today.todosPending).id, "t1");
  assert.equal(matchPendingTodo("薄荷浇完水了", SNAPSHOT.today.todosPending).id, "t2");
  assert.equal(matchPendingTodo("刚给薄荷浇过水了", SNAPSHOT.today.todosPending).id, "t2");
});

test("认领：手头只挂一条时，她不说标题也对得上", () => {
  assert.equal(matchPendingTodo("搞定啦", [{ id: "t1", title: "吃维生素d" }]).id, "t1");
});

test("认领：好几条都对不上就不动手，不替她挑", () => {
  assert.equal(matchPendingTodo("我吃完饭了", SNAPSHOT.today.todosPending), null);
  assert.equal(matchPendingTodo("", SNAPSHOT.today.todosPending), null);
  assert.equal(matchPendingTodo("搞定啦", []), null);
});

test("快照：坏数据当没有，不抛", () => {
  assert.deepEqual(pendingFromSnapshot(SNAPSHOT).map((r) => r.id), ["t1", "t2"]);
  assert.deepEqual(pendingFromSnapshot(null), []);
  assert.deepEqual(pendingFromSnapshot({ today: { todosPending: "坏" } }), []);
  assert.deepEqual(pendingFromSnapshot({ today: { todosPending: [{ at: "08:00" }] } }), []);
});

// ——— 2026-10-06：「浇完啦」勾不掉的那次 ———
// 旧版本靠「吃了吗」「做完了」这种写死的词表认完成语，「浇」根本不在表里，
// 句子在门口就被判成不是完成汇报；就算进来了，句子里没有「薄荷」「水」，
// 纯字符匹配也对不上「给薄荷浇水」。两头都堵。现在两头都改了，以下是回归钉子。

test("完成语：词表没列到的动作，靠「任意动作+完」的形状也认", () => {
  for (const text of ["浇完啦", "浇完了", "浇完咯", "晾完了", "剪完啦"]) {
    assert.equal(looksDone(text), true, `${text} 应当被认成完成汇报`);
  }
  // 「好」不进句级形状：好看、好喝会把无关的句子拖进来。「好了」留给待办自己的动作去认。
  assert.equal(looksDone("今天天气好看"), false);
  assert.equal(looksDone("那瓶水好喝"), false);
});

test("认领：省掉主语宾语的口语，由待办自己的动作补上", () => {
  // 「浇好啦」这种带「好」的句子连 looksDone 都过不了，它靠的就是下面那条动作路径——
  // 两条路缺一不可。
  for (const text of ["浇完啦", "浇过水了", "刚浇完水", "薄荷也浇好啦", "浇好了"]) {
    assert.equal(matchPendingTodo(text, SNAPSHOT.today.todosPending)?.id, "t2", text);
    assert.equal(doneByOwnAction("给薄荷浇水", text), true, text);
  }
});

test("认领：泛动词光说动作不算数，得连待办里那个东西一起提", () => {
  // 「吃」太泛：一句「哎妈我吃完了」多半在说饭，划掉「吃维生素d」等于让人漏吃一天。
  assert.equal(matchPendingTodo("哎妈我吃完了", SNAPSHOT.today.todosPending), null);
  assert.equal(matchPendingTodo("我吃完了面条", SNAPSHOT.today.todosPending), null);
  // 泛动词连宾语一起说，还是认的。
  assert.equal(matchPendingTodo("维生素d吃了", SNAPSHOT.today.todosPending)?.id, "t1");
});

test("认领：反问与虚拟语气一律不算完成，两条路都得挡", () => {
  for (const text of ["浇完了吗", "浇完了没", "浇完了不", "该不会忘了吧", "我还没浇呢"]) {
    assert.equal(looksDone(text), false, text);
    assert.equal(doneByOwnAction("给薄荷浇水", text), false, `${text} 不得从动作路径绕进来`);
  }
});

test("动作路径自带反证检查，别只靠门口那一道", () => {
  // doneByOwnAction 是直接被 matchPendingTodo 调的，绕开 looksDone；反证词必须在这条路上再拦一次。
  assert.equal(doneByOwnAction("给薄荷浇水", "浇完了吗"), false);
  assert.equal(doneByOwnAction("给薄荷浇水", "我待会儿浇"), false);
  assert.equal(doneByOwnAction("给薄荷浇水", "浇完啦"), true);
  assert.equal(doneByOwnAction("吃维生素d", "哎妈我吃完了"), false);
  assert.equal(doneByOwnAction("吃维生素d", "维生素d吃完了"), true);
});

test("端到端：她那句「浇完啦」走到拾光记那一步", async () => {
  const { ctx, calls } = fakeCtx({ ok: true, alreadyDone: false, todo: { id: "t2", title: "给薄荷浇水" } });
  const done = await completeFromMessage(ctx, { text: "浇完啦", snapshot: SNAPSHOT });
  assert.equal(done.done, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verb, "app:shiguangji-app/todo/complete");
  assert.equal(calls[0].payload.id, "t2");
});

test("端到端：拿不准的照旧不碰，一次都不调", async () => {
  for (const text of ["哎妈我吃完了", "浇完了吗", "今天有点累"]) {
    const { ctx, calls } = fakeCtx({ ok: true });
    const result = await completeFromMessage(ctx, { text, snapshot: SNAPSHOT });
    assert.equal(result.done, false, `${text} 不该勾任何一条`);
    assert.equal(calls.length, 0, `${text} 不该调跨 App 服务`);
  }
});

function fakeCtx(result) {
  const calls = [];
  return {
    calls,
    ctx: {
      bus: {
        async request(verb, payload) {
          calls.push({ verb, payload });
          if (result instanceof Error) throw result;
          return result;
        },
      },
    },
  };
}

test("跨 App：认出来了就去调拾光记，并把那句给 ta 看的话递出来", async () => {
  const { ctx, calls } = fakeCtx({ ok: true, alreadyDone: false, todo: { id: "t1", title: "吃维生素d" } });
  const result = await completeFromMessage(ctx, { text: "维生素d我吃啦", snapshot: SNAPSHOT });
  assert.equal(result.done, true);
  assert.equal(calls[0].verb, "app:shiguangji-app/todo/complete");
  assert.equal(calls[0].verb.endsWith(TODO_COMPLETE_METHOD), true);
  assert.equal(calls[0].payload.id, "t1");
  assert.match(result.factText, /吃维生素d/);
  assert.match(result.factText, /划掉了/);
});

test("跨 App：勾不上不是聊天的理由，这一轮照常聊", async () => {
  const failed = await completeFromMessage(fakeCtx(new Error("没有许可")).ctx, { text: "维生素d我吃啦", snapshot: SNAPSHOT });
  assert.equal(failed.done, false);
  assert.equal(failed.reason, "call-failed");
  const rejected = await completeFromMessage(fakeCtx({ ok: false, reason: "not-found" }).ctx, { text: "维生素d我吃啦", snapshot: SNAPSHOT });
  assert.equal(rejected.done, false);
  assert.equal(rejected.reason, "not-found");
});

test("不是完成语、或没装拾光记时，一次都不调", async () => {
  const { ctx, calls } = fakeCtx({ ok: true });
  assert.equal((await completeFromMessage(ctx, { text: "今天有点累", snapshot: SNAPSHOT })).done, false);
  assert.equal((await completeFromMessage(ctx, { text: "我待会儿吃维生素d", snapshot: SNAPSHOT })).done, false);
  assert.equal((await completeFromMessage(ctx, { text: "维生素d我吃啦", snapshot: null })).done, false);
  assert.equal(calls.length, 0);
});

test("给 ta 看的那句：别把记账话说出来", () => {
  const text = doneFactText({ title: "吃维生素d" }, { userName: "小林" });
  assert.match(text, /小林/);
  assert.match(text, /别记账/);
  assert.equal(doneFactText({}, {}), "");
});
