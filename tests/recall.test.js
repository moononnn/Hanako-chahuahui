import test from "node:test";
import assert from "node:assert/strict";
import { recallEligibility, recallWindow, shouldCancelScheduledReply } from "../lib/recall.js";

test("撤回窗口默认是两分钟，超过后关闭", () => {
  const at = "2026-09-15T10:00:00.000Z";
  assert.equal(recallWindow(Date.parse(at) + 119999, at).ok, true);
  assert.equal(recallWindow(Date.parse(at) + 120001, at).reason, "expired");
});

test("只有用户消息能撤回，处理中和已回复阶段拒绝", () => {
  const message = { role: "user", at: new Date().toISOString() };
  assert.equal(recallEligibility({ role: "assistant", at: message.at }).reason, "not-user");
  assert.equal(recallEligibility(message, { processing: true }).reason, "processing");
  assert.equal(recallEligibility(message, { delivering: true }).reason, "replying");
  assert.equal(recallEligibility(message).ok, true);
});

test("已读状态只决定撤回后留占位还是直接移除", () => {
  const now = Date.now();
  assert.equal(recallEligibility({ role: "user", at: new Date(now).toISOString() }, { now }).read, false);
  assert.equal(recallEligibility({ role: "user", at: new Date(now).toISOString(), readAt: new Date(now).toISOString() }, { now }).read, true);
});

test("没被看过的消息不受两分钟窗口约束：删完回复退回未读后随时能撤", () => {
  const at = "2026-09-15T10:00:00.000Z";
  const verdict = recallEligibility({ role: "user", at, readAt: null }, { now: Date.parse(at) + 3 * 60 * 60 * 1000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.read, false);
  assert.equal(verdict.expiresAt, null, "没被看过的撤回不挂倒计时");
});

test("看过的消息过了两分钟还是不能撤", () => {
  const at = "2026-09-15T10:00:00.000Z";
  const read = { role: "user", at, readAt: "2026-09-15T10:00:30.000Z" };
  assert.equal(recallEligibility(read, { now: Date.parse(at) + 119999 }).ok, true);
  assert.equal(recallEligibility(read, { now: Date.parse(at) + 120001 }).reason, "expired");
});

test("没被看过的消息时间戳坏了也能收回", () => {
  const verdict = recallEligibility({ role: "user", at: "not-a-date" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.read, false);
});

test("排期中的最后一条用户消息撤回后可以取消回复", () => {
  assert.equal(shouldCancelScheduledReply([{ role: "assistant" }, { role: "user", recalled: true }]), true);
  assert.equal(shouldCancelScheduledReply([{ role: "assistant" }, { role: "user" }]), false);
  assert.equal(shouldCancelScheduledReply([{ role: "user", recalled: true }, { role: "user" }]), false);
});
