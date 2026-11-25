/**
 * 过期临时相处理解的日常清理（2026-11-25）。
 *
 * 她同意删掉已经过期的临时附加记录。这一轮钉住：
 * 1. 只清已经确定过期的 life-day / until / current-turn；长期（含建议复核）一条不动。
 * 2. 字段缺失、时间解不开、落地当天的 current-turn：当作“还不能确定”，不删。
 * 3. 撤回/被取代的历史、仍有效的临时、聊天与其他记忆、反馈账都保留。
 * 4. 只写有变化的账本，revision 只加一次；重复执行安全（第二次不写）。
 * 5. 清理在 app 启动时自己跑，走的是 app 自己的真账本，不叫模型。
 */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";
import { dayKey } from "../lib/days.js";
import { expiredTemporaryGuideReason, pruneExpiredTemporaryGuides } from "../lib/adaptation.js";

const NOW = new Date("2026-11-25T10:00:00+08:00");
const TODAY = dayKey(NOW);
const YESTERDAY = dayKey(new Date("2026-11-24T10:00:00+08:00"));

const guide = (extra = {}) => ({
  id: "guide:relationship:m-1",
  meaning: "先陪我一会儿",
  kind: "preference",
  scope: "relationship",
  duration: "persistent",
  status: "active",
  origin: "explicit",
  sourceMessageIds: ["m-1"],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...extra,
});

/* ── 纯逻辑：什么算“已经确定过期” ── */

test("until：过期才算，没到点、缺时间都不动", () => {
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "until", expiresAt: "2026-11-25T01:00:00+08:00" }), { now: NOW, lifeDay: TODAY }), "until-passed");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "until", expiresAt: "2026-11-26T01:00:00+08:00" }), { now: NOW, lifeDay: TODAY }), "");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "until", expiresAt: "" }), { now: NOW, lifeDay: TODAY }), "", "缺时间不猜");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "until", expiresAt: "乱写" }), { now: NOW, lifeDay: TODAY }), "");
});

test("life-day：过了那天才清，缺 lifeDay 留着", () => {
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "life-day", lifeDay: YESTERDAY }), { now: NOW, lifeDay: TODAY }), "life-day-passed");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "life-day", lifeDay: TODAY }), { now: NOW, lifeDay: TODAY }), "", "当天还在生效");
  for (const day of ["", "tomorrow", "2026-02-30", "2026-11-26"]) {
    assert.equal(expiredTemporaryGuideReason(guide({ duration: "life-day", lifeDay: day }), { now: NOW, lifeDay: TODAY }), "", "缺失、无效或未来日期不删");
  }
});

test("current-turn：只看“落地那天已经过去”，不拿空 currentTurnId 去推", () => {
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "current-turn", createdAt: NOW.toISOString() }), { now: NOW, lifeDay: TODAY }), "", "当天的回合可能还在进行");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "current-turn", createdAt: new Date("2026-11-24T21:00:00+08:00").toISOString() }), { now: NOW, lifeDay: TODAY }), "turn-ended");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "current-turn", createdAt: "" }), { now: NOW, lifeDay: TODAY }), "", "缺 createdAt 不猜");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "current-turn", createdAt: "2026-11-27T12:00:00Z" }), { now: NOW, lifeDay: TODAY }), "", "未来回合不删");
});

test("长期、被撤回、被取代的都不动", () => {
  assert.equal(expiredTemporaryGuideReason(guide(), { now: NOW, lifeDay: TODAY }), "", "长期不清");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "life-day", lifeDay: YESTERDAY, status: "revoked" }), { now: NOW, lifeDay: TODAY }), "", "撤回是历史");
  assert.equal(expiredTemporaryGuideReason(guide({ duration: "until", expiresAt: "2026-11-25T01:00:00+08:00", status: "superseded" }), { now: NOW, lifeDay: TODAY }), "");
});

test("清理只动 guides：引用它的 exception/habit 做个标记，反馈一条不删", () => {
  const book = {
    revision: 7,
    guides: [
      guide({ id: "g-old-day", duration: "life-day", lifeDay: YESTERDAY }),
      guide({ id: "g-keep", duration: "persistent" }),
      guide({ id: "g-keep-turn", duration: "current-turn", createdAt: NOW.toISOString() }),
    ],
    exceptions: [
      { id: "ex-1", guideIds: ["g-old-day"], outcome: "committed" },
      { id: "ex-2", guideIds: ["g-keep"], outcome: "committed" },
    ],
    feedbackEvents: [{ id: "fb-1", exceptionId: "ex-1", sourceMessageId: "m-1" }],
    habitChanges: [{ key: "voice.frequency", guideIds: ["g-old-day"], state: "settled" }],
  };
  const pruned = pruneExpiredTemporaryGuides(book, { now: NOW, lifeDay: TODAY });
  assert.deepEqual(pruned.removed, [{ id: "g-old-day", reason: "life-day-passed" }]);
  assert.deepEqual(pruned.book.guides.map((row) => row.id), ["g-keep", "g-keep-turn"]);
  assert.equal(pruned.book.exceptions[0].sourceGuideRevoked, true, "引用了被清那条的破例要标一下");
  assert.equal(pruned.book.exceptions[1].sourceGuideRevoked, undefined, "无关的破例原样");
  assert.equal(pruned.book.habitChanges[0].state, "reverted");
  assert.deepEqual(pruned.book.feedbackEvents, book.feedbackEvents, "反馈账一条不删");
  assert.equal(pruned.book.revision, 7, "纯函数不动 revision，落盘由 store 管");
});

test("没东西可清就原样返回，不制造写入", () => {
  const book = { revision: 3, guides: [guide()] };
  const pruned = pruneExpiredTemporaryGuides(book, { now: NOW, lifeDay: TODAY });
  assert.equal(pruned.removed.length, 0);
  assert.equal(pruned.book, book, "同一个对象，调用方据此判断不写盘");
});

/* ── 真的落盘：走 app 自己的启动清理 ── */

const PARTNERS = [{ id: "alpha", name: "甲" }, { id: "beta", name: "乙" }];

/** 集成那几条走 app 自己的真时钟：日期都相对“现在”算，不写死到某一天。 */
const realNow = () => new Date();
const realToday = () => dayKey(realNow());
const realYesterday = () => dayKey(new Date(Date.now() - 24 * 3600_000));

function seedBooks(store) {
  // 伙伴甲：过期的 life-day/until（清）、长期（留）、当天 current-turn（留）、过期的撤回历史（留）。
  store.savePartnerAdaptation("alpha", {
    guides: [
      guide({ id: "a-day-old", duration: "life-day", lifeDay: realYesterday() }),
      guide({ id: "a-until-old", duration: "until", expiresAt: new Date(Date.now() - 3600_000).toISOString() }),
      guide({ id: "a-keep", meaning: "晚上十点后别发消息" }),
      guide({ id: "a-turn-today", duration: "current-turn", createdAt: realNow().toISOString() }),
      guide({ id: "a-revoked", duration: "life-day", lifeDay: realYesterday(), status: "revoked" }),
    ],
    exceptions: [{ id: "ex-keep", guideIds: ["a-keep"], outcome: "committed" }],
    feedbackEvents: [{ id: "fb-keep", exceptionId: "ex-keep", sourceMessageId: "m-keep" }],
    habitChanges: [{ key: "voice.frequency", guideIds: ["a-day-old"], state: "settled" }],
  });
  // 伙伴乙：一件都不该动。
  store.savePartnerAdaptation("beta", { guides: [guide({ id: "b-keep", scope: "relationship" })] });
  // 全局那一本：过期 life-day（清）、长期（留）。
  store.saveUserAdaptation({
    guides: [
      guide({ id: "w-day-old", scope: "user-wide", duration: "life-day", lifeDay: realYesterday() }),
      guide({ id: "w-keep", scope: "user-wide" }),
    ],
  });
  // 别的记忆照旧在。
  store.appendMessage("alpha", { role: "user", text: "今天想喝热咖啡", at: realNow().toISOString() });
}

test("启动清理：只删已过期的临时条目，别的都留着，账本只写一次", async t => {
  const dir = fs.mkdtempSync(`${process.env.TEMP ?? "."}/chahuahui-prune-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await bootChahuahui({ dataDir: dir, partners: PARTNERS, seed(store) {
    // 先把时间固定在“现在”：清理用的 life-day 就是这个时刻算出来的那天。
    seedBooks(store);
  } });
  void first;
  const disk = createStore(dir);

  const alpha = disk.getPartnerAdaptation("alpha");
  assert.deepEqual(alpha.guides.map((row) => row.id), ["a-keep", "a-turn-today", "a-revoked"],
    "过期 life-day/until 清了；长期、当天回合、撤回历史都在");
  assert.equal(alpha.exceptions.length, 1, "破例账不删");
  assert.equal(alpha.feedbackEvents.length, 1, "反馈账不删");
  assert.equal(alpha.habitChanges[0].state, "reverted", "引用被清那条的习惯退回");
  assert.equal(alpha.revision, 2, "伙伴账只写了一次（seed 一次 + 清理一次）");

  assert.deepEqual(disk.getPartnerAdaptation("beta").guides.map((row) => row.id), ["b-keep"], "没东西可清的伙伴一个字不写");
  assert.equal(disk.getPartnerAdaptation("beta").revision, 1, "beta 的 revision 没被碰");

  const wide = disk.getUserAdaptation();
  assert.deepEqual(wide.guides.map((row) => row.id), ["w-keep"]);
  assert.ok(wide.revision >= 1);
  assert.equal(disk.getThread("alpha").messages.filter((row) => row.role === "user").length, 1, "聊天一条不少");
});

test("重复执行安全：第二次启动不写账本，也不多删", async t => {
  const dir = fs.mkdtempSync(`${process.env.TEMP ?? "."}/chahuahui-prune-again-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await bootChahuahui({ dataDir: dir, partners: PARTNERS, seed(store) { seedBooks(store); } });
  const after1 = createStore(dir);
  const revision1 = after1.getPartnerAdaptation("alpha").revision;
  const wideRevision1 = after1.getUserAdaptation().revision;

  await bootChahuahui({ dataDir: dir, partners: PARTNERS });
  const after2 = createStore(dir);
  assert.equal(after2.getPartnerAdaptation("alpha").revision, revision1, "没有变化就不落盘");
  assert.equal(after2.getUserAdaptation().revision, wideRevision1, "全局那一本同样不写");
  assert.deepEqual(after2.getPartnerAdaptation("alpha").guides.map((row) => row.id),
    ["a-keep", "a-turn-today", "a-revoked"], "第二次不多删");
});

test("越过生活日之后再来一次：当天的 current-turn 就清了", async t => {
  const dir = fs.mkdtempSync(`${process.env.TEMP ?? "."}/chahuahui-prune-turn-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await bootChahuahui({ dataDir: dir, partners: PARTNERS, seed(store) {
    store.savePartnerAdaptation("alpha", {
      guides: [guide({ id: "a-turn", duration: "current-turn", createdAt: new Date(Date.now() - 24 * 3600_000).toISOString() })],
    });
  } });
  const book = createStore(dir).getPartnerAdaptation("alpha");
  assert.deepEqual(book.guides, [], "落地那天已经过去的回合，算确定过期");
});
