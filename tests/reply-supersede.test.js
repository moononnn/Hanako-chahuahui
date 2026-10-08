import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/store.js";
import { hasNewerUserMessage, composeWithSupersedeRetry } from "../lib/turn-window.js";

const appSource = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-supersede-"));
  return { store: createStore(dir), dir };
}

// ── 一、这轮捕获之后有没有落进新话 ──────────────────────────────

test("生成中补第二条：旧稿作废，并指出是哪一条顶掉了它", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });
  const rows = store.getThread("nova").messages;
  assert.deepEqual(hasNewerUserMessage(rows, one.id), { superseded: true, newerMessageId: two.id });
});

test("连续补第三条：照样作废，报的还是最早那条新话", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });
  store.appendMessage("nova", { role: "user", text: "别回了我真睡了" });
  const rows = store.getThread("nova").messages;
  assert.deepEqual(hasNewerUserMessage(rows, one.id), { superseded: true, newerMessageId: two.id });
});

test("这轮的目标就是最新那条：后面没有新话了，不该作废", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });
  const rows = store.getThread("nova").messages;
  assert.deepEqual(hasNewerUserMessage(rows, two.id), { superseded: false, newerMessageId: null });
});

test("回复已经落盘之后来的新话不作废旧稿：那是下一轮的事", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  store.appendMessage("nova", { role: "assistant", text: "睡吧", repliedTo: one.id });
  store.appendMessage("nova", { role: "user", text: "还没睡" });
  assert.equal(hasNewerUserMessage(store.getThread("nova").messages, one.id).superseded, false);
});

test("撤回掉的和戳一戳都不算新话：别为这些重开一轮生成", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const gone = store.appendMessage("nova", { role: "user", text: "说错了" });
  store.patchMessage("nova", gone.id, { recalled: true });
  store.appendMessage("nova", { role: "user", text: "戳一下", kind: "poke" });
  store.appendMessage("nova", { role: "user", text: "[动作]", kind: "action" });
  assert.equal(hasNewerUserMessage(store.getThread("nova").messages, one.id).superseded, false);
});

test("目标自己没了（撤回、清空、旧档缺行）：不判作废，交给 stale 那条路", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  store.appendMessage("nova", { role: "user", text: "晚安" });
  store.removeMessage("nova", one.id);
  assert.deepEqual(hasNewerUserMessage(store.getThread("nova").messages, one.id), { superseded: false, newerMessageId: null });
  assert.equal(hasNewerUserMessage([], one.id).superseded, false);
  assert.equal(hasNewerUserMessage(store.getThread("nova").messages, null).superseded, false);
});

// ── 二、作废后怎么顺序重来（同一伙伴同时只有一个生成） ───────────

test("第一次就成：只生成一次，不多花一次", async () => {
  let count = 0;
  const made = await composeWithSupersedeRetry(async () => {
    count += 1;
    return { ok: true, bubbles: ["晚安"] };
  });
  assert.equal(count, 1);
  assert.equal(made.ok, true);
});

test("生成中补第二条：旧稿丢掉，同一条回合里按新上下文顺序重来一次", async () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const seen = [];
  const superseded = [];
  const made = await composeWithSupersedeRetry(
    async (attempt) => {
      const target = attempt === 0 ? one.id : store.getThread("nova").messages.at(-1).id;
      seen.push(target);
      if (attempt === 0) {
        // 第一轮生成期间她补了第二句：这轮上下文里没有，旧稿不能送。
        store.appendMessage("nova", { role: "user", text: "晚安" });
        const check = hasNewerUserMessage(store.getThread("nova").messages, target);
        assert.equal(check.superseded, true);
        return { ok: false, reason: "superseded", supersededBy: check.newerMessageId };
      }
      assert.equal(hasNewerUserMessage(store.getThread("nova").messages, target).superseded, false);
      return { ok: true, bubbles: ["（把两句一起接住的回复）"], repliedTo: target };
    },
    { onSupersede: (attempt, result) => superseded.push([attempt, result.supersededBy]) },
  );
  assert.equal(made.ok, true);
  assert.deepEqual(made.repliedTo, store.getThread("nova").messages.at(-1).id, "重生成时目标要换成最新那条");
  assert.equal(seen.length, 2, "只重来了这一次");
  assert.equal(superseded.length, 1);
});

test("追到上限：不放行过期旧稿，把最新目标交回调用方排期", async () => {
  const attempts = [];
  const superseded = [];
  const made = await composeWithSupersedeRetry(
    async (attempt) => {
      attempts.push(attempt);
      // 她一直在补：每次都作废，直到上限用完。
      return { ok: false, reason: "superseded", supersededBy: `m_${attempt}` };
    },
    { onSupersede: (attempt) => superseded.push(attempt) },
  );
  assert.deepEqual(superseded, [0, 1, 2], "每次作废都要留一笔，别悄悄吞掉一次生成");
  assert.deepEqual(attempts, [0, 1, 2], "生成次数有上限，不能无限追");
  assert.equal(made.ok, false);
  assert.equal(made.reason, "superseded", "上限用完也不许把旧稿放出去");
  assert.equal(made.exhausted, true);
  assert.equal(made.supersededBy, "m_2", "把最后一次作废的目标带上去，调用方拿它排期");
});

test("重来的过程必须串行：不能同时开两个模型请求", async () => {
  let inFlight = 0;
  let peak = 0;
  const exhausted = await composeWithSupersedeRetry(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return { ok: false, reason: "superseded" };
  });
  assert.equal(peak, 1, "同一伙伴同一时刻只能有一个生成");
  assert.equal(exhausted.exhausted, true);
});

test("安静收口时也要先看有没有新话：拿上一轮的句号收尾会把她补的那句晾在未读上", async () => {
  const { store } = freshStore();
  const closing = store.appendMessage("nova", { role: "user", text: "哈哈哈哈" });
  const superseded = [];
  // shouldQuietClose 会为 true（纯笑声、前面没有夹着别的话），但她在这期间补了话。
  const made = await composeWithSupersedeRetry(
    async (attempt) => {
      const target = attempt === 0 ? closing.id : store.getThread("nova").messages.at(-1).id;
      // 她在这轮判定期间补了话（真实路径是在那些 await 期间落盘的）。
      if (attempt === 0) store.appendMessage("nova", { role: "user", text: "等一下我还有话说" });
      const check = hasNewerUserMessage(store.getThread("nova").messages, target);
      if (check.superseded) return { ok: false, reason: "superseded", supersededBy: check.newerMessageId };
      return { ok: true, bubbles: ["（按新上下文接住）"] };
    },
    { onSupersede: (attempt) => superseded.push(attempt) },
  );
  assert.equal(made.ok, true, "有新的她的话在等，不能拿句号安静收尾");
  assert.deepEqual(superseded, [0]);
});

test("非作废的结局原样返回，不因为重试逻辑被改写", async () => {
  for (const made of [{ ok: false, reason: "unavailable" }, { ok: false, reason: "silent" }, { ok: false, reason: "empty" }]) {
    let count = 0;
    const got = await composeWithSupersedeRetry(async () => {
      count += 1;
      return made;
    });
    assert.deepEqual(got, made);
    assert.equal(count, 1, `${made.reason} 不是作废，不该重试`);
  }
});

// ── 三、已读只盖本轮真正捕获到的上界 ────────────────────────────

test("已读只盖到本轮目标：后面新落的话留在未读，不发假收据", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  store.appendMessage("nova", { role: "assistant", text: "在呢" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });

  const at = "2026-10-07T15:22:23.382Z";
  assert.deepEqual(store.markUserMessagesRead("nova", at, { throughId: one.id }), [one.id]);
  const rows = store.getThread("nova").messages;
  assert.equal(rows.find((row) => row.id === one.id).readAt, at);
  assert.equal(rows.find((row) => row.id === two.id).readAt, undefined, "这轮压根没读到它，不能先盖已读");
});

test("第二轮按新的目标盖章：上一轮欠下的那条这时才补上", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });
  const at1 = "2026-10-07T15:22:23.382Z";
  const at2 = "2026-10-07T15:25:03.000Z";
  store.markUserMessagesRead("nova", at1, { throughId: one.id });
  assert.deepEqual(store.markUserMessagesRead("nova", at2, { throughId: two.id }), [two.id]);
  const rows = store.getThread("nova").messages;
  assert.equal(rows.find((row) => row.id === one.id).readAt, at1, "先盖的不能被改写");
  assert.equal(rows.find((row) => row.id === two.id).readAt, at2);
});

test("不给上界时行为跟以前一样：全盖（旧调用方不受影响）", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "user", text: "在吗" });
  store.appendMessage("nova", { role: "assistant", text: "在呢" });
  store.appendMessage("nova", { role: "user", text: "刚才那事" });
  store.appendMessage("nova", { role: "user", text: "还在吗" });
  const at = "2026-10-07T15:22:23.382Z";
  assert.equal(store.markUserMessagesRead("nova", at).length, 3);
  assert.equal(store.markUserMessagesRead("nova", at, {}).length, 0, "再盖一遍不重复计");
});

test("上界那条自己没了：一律不盖，宁可漏盖也不发假收据", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const two = store.appendMessage("nova", { role: "user", text: "晚安" });
  store.removeMessage("nova", one.id);
  assert.deepEqual(store.markUserMessagesRead("nova", "2026-10-07T15:22:23.382Z", { throughId: one.id }), []);
  assert.equal(store.getThread("nova").messages.find((row) => row.id === two.id).readAt, undefined);
});

test("模型不可用那条仍然不盖：作废逻辑不能把这条规矩顶掉", () => {
  const { store } = freshStore();
  const bad = store.appendMessage("nova", { role: "user", text: "看这个", notice: { code: "MODEL_UNAVAILABLE", kind: "quota", text: "接不上话" } });
  const ok = store.appendMessage("nova", { role: "user", text: "还在吗" });
  const touched = store.markUserMessagesRead("nova", "2026-10-07T15:22:23.382Z", { throughId: ok.id });
  assert.deepEqual(touched, [ok.id]);
  assert.equal(store.getThread("nova").messages.find((row) => row.id === bad.id).readAt, undefined);
});

test("撤回复把原话退回未读之后，下一次带上界的盖章能补上", () => {
  const { store, dir } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  const reply = store.appendMessage("nova", { role: "assistant", text: "睡吧", repliedTo: one.id });
  store.appendMessage("nova", { role: "user", text: "晚安" });
  store.markUserMessagesRead("nova", "2026-10-07T15:25:03.000Z", { throughId: one.id });

  const removed = store.removeAssistantReply("nova", reply.id, { at: "2026-10-07T15:26:00.000Z" });
  assert.equal(removed.restoredUnread, true);
  assert.equal(store.getThread("nova").messages.find((row) => row.id === one.id).readAt, null);

  const two = store.getThread("nova").messages.find((row) => row.text === "晚安");
  const at2 = "2026-10-07T15:27:00.000Z";
  // 退回未读的那条正好也在上界之内，这回一起补上。
  assert.deepEqual(store.markUserMessagesRead("nova", at2, { throughId: two.id }), [one.id, two.id]);
  const reopened = createStore(dir).getThread("nova").messages;
  assert.equal(reopened.find((row) => row.id === one.id).readAt, "2026-10-07T15:27:00.000Z", "重开还在");
});

test("清空聊天后旧定时器不能给新消息盖章：上界查无此人时只盖零条", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "我准备睡了" });
  store.clearThread("nova");
  const after = store.appendMessage("nova", { role: "user", text: "清空之后重新开的头一句" });
  assert.deepEqual(store.markUserMessagesRead("nova", "2026-10-07T15:30:00.000Z", { throughId: one.id }), []);
  assert.equal(store.getThread("nova").messages.find((row) => row.id === after.id).readAt, undefined);
});

// ── 四、接线：后台检查点与两个顺序重来的调用点 ──────────────────
// 说明：真实编排行为由 tests/reply-supersede-routes.test.js 走真 apply(ctx)、
// 真路由、真账本文件验证；这里只守接线形状，不冒充行为验证。

test("后台在各阶段各查一次有没有新话顶掉旧稿", () => {
  assert.match(appSource, /composeWithSupersedeRetry/);
  assert.match(appSource, /hasNewerUserMessage/);
  // 安静收口：拿上一轮的句号收尾之前先查，别把她刚补的那句晾在未读上。
  assert.match(appSource, /const staleClosing = supersededResult\("quiet-close"\);/);
  // 检索之前：省掉 chatSearch 那次 utility 请求和兴趣「已拿出手」的记账。
  assert.match(appSource, /const stalePreSearch = supersededResult\("before-search"\);/);
  // 发模型之前：省掉一整次生成。
  assert.match(appSource, /const staleBefore = supersededResult\("before-model"\);[\s\S]{0,120}?generated = await callModel\(\);/);
  // 模型一回来就查，必须在 unavailable / 空正文那些早退之前。
  const afterModel = appSource.slice(appSource.indexOf('const staleAfterModel = supersededResult("after-model");'));
  assert.match(afterModel.slice(0, 400), /if \(staleAfterModel\) return staleAfterModel;[\s\S]{0,200}?if \(generated\.unavailable\)/, "配额/失败早退之前要先查，不能拿旧目标的失败盖住新话");
  assert.match(appSource, /const staleAfter = supersededResult\("after-retry"\);/);
  assert.match(appSource, /const staleSilent = supersededResult\("silent"\);/);
  assert.match(appSource, /const staleEmpty = supersededResult\("empty"\);/);
  // 语音合成期间她又说了：语音不能跟着旧稿外显，落盘前那一查要把语音放掉。
  assert.match(appSource, /const staleBeforeSave = superseded\(\);\s*\r?\n\s*if \(staleBeforeSave\?\.superseded\) \{\s*\r?\n\s*releaseVoiceGeneration\(preparedVoice\);/);
  assert.match(appSource, /const stored = appendPartnerMessage\(agentId, reply, preparedVoice, replaceMessageId\);/);
  // 已废弃的「关掉作废检查发旧稿」不能再出现。
  assert.doesNotMatch(appSource, /ignoreSupersede/);
});

test("追到上限：两个调用点都把最新目标交回排期，不放行旧稿", () => {
  const turnBlock = appSource.slice(appSource.indexOf("async function runTurn(turn)"));
  assert.match(turnBlock, /if \(made\.reason === "superseded"\) \{[\s\S]{0,700}?scheduleQueuedReply\(turn\.agentId, turn\.userMessageId\)/, "实时回合要把本回合那条之后所有没覆盖的话排成一批");
  assert.match(turnBlock, /turn\.superseded = true;/, "对外如实标出这轮是作废收场，不假装回过了");
  const deliverBlock = appSource.slice(appSource.indexOf("async function deliverScheduledReply("));
  assert.match(deliverBlock, /if \(made\.reason === "superseded"\) \{[\s\S]{0,600}?scheduleReplyAt\(agentId, Date\.now\(\), "queued", latest\)/, "排期轮直接排最新目标：deliveringReplies 还没放开，不能走 scheduleQueuedReply");
  const deliverSuperseded = deliverBlock.slice(deliverBlock.indexOf('if (made.reason === "superseded")'));
  assert.doesNotMatch(deliverSuperseded.slice(0, 500), /clearPendingReply\(/, "不能顺手清掉待办，否则新话就丢了");
});

test("重新捕获的目标要报给外面：已读水位跟着实际覆盖范围走", () => {
  assert.match(appSource, /if \(replyTargetId\) onCapture\?\.\(replyTargetId\);/);
  assert.match(appSource, /onCapture: \(targetId\) => \{ turn\.readTargetId = targetId; \}/);
  assert.match(appSource, /const readThroughId = turn\.readTargetId \?\? turn\.userMessageId;/);
  assert.match(appSource, /event: "turn\.read\.catchup"/, "定时器先开火、目标后推的情况要在落盘后补齐");
  assert.match(appSource, /event: "reply\.read\.catchup"/);
});

test("实时回合和排期轮都走顺序重来，修整那条路不动", () => {
  const turnBlock = appSource.slice(appSource.indexOf("async function runTurn(turn)"));
  assert.match(turnBlock, /composeWithSupersedeRetry\(/, "实时回合要在同一条回合里重来，不能新开一个生成");
  const deliverBlock = appSource.slice(appSource.indexOf("async function deliverScheduledReply("));
  assert.match(deliverBlock, /composeWithSupersedeRetry\(/, "排期轮同样要接住连续追加");
  const refineBlock = appSource.slice(appSource.indexOf("/thread/:agentId/refine/:messageId\""));
  assert.doesNotMatch(refineBlock.slice(0, 3000), /composeWithSupersedeRetry\(/, "修整是替换指定那条回复，不走这条路");
});

test("已读盖章带上界，并且定时器要拦清空聊天后的旧回包", () => {
  const timer = appSource.slice(appSource.indexOf("const readTimer = setTimeout"), appSource.indexOf("const readTimer = setTimeout") + 900);
  assert.match(timer, /if \(threadGeneration\(agentId\) !== turn\.threadGeneration\) \{[\s\S]{0,200}?return;/);
  assert.match(timer, /const readThroughId = turn\.readTargetId \?\? turn\.userMessageId;\s*\r?\n\s*const touched = store\.markUserMessagesRead\(agentId, new Date\(\)\.toISOString\(\), \{ throughId: readThroughId \}\);/);
  assert.match(appSource, /event: "turn\.read\.skipped"/);
  assert.match(appSource, /markUserMessagesRead\(agentId, new Date\(\)\.toISOString\(\), \{ throughId: pending\?\.messageId \?\? null \}\)/);
  assert.match(appSource, /event: "reply\.read"/);
  // 重启恢复那条路也只确认目标那一条，不整条线程盖。
  assert.match(appSource, /markUserMessagesRead\(partner\.id, new Date\(\)\.toISOString\(\), \{ throughId: target\?\.id \?\? null \}\)/);
  // 回复的两条路（定时器、排期轮）不许再出现无上界的盖章。
  assert.doesNotMatch(timer, /markUserMessagesRead\(agentId\)/);
  const deliverStart = appSource.indexOf("async function deliverScheduledReply(");
  assert.doesNotMatch(appSource.slice(deliverStart, deliverStart + 3000), /markUserMessagesRead\(agentId\)/);
});

test("作废的旧稿不许提前外显：模型流回调不接，回包只在落盘后才给前端", () => {
  const call = appSource.slice(appSource.indexOf("const callModel = async"), appSource.indexOf("generated = await callModel();"));
  assert.doesNotMatch(call, /onRaw/, "没有流回调就没有边生成边外显的路径");
  assert.doesNotMatch(appSource.slice(appSource.indexOf("async function composeReply("), appSource.indexOf("generated = await callModel();")), /onRaw/);
});
