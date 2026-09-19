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

test("排期中的最后一条用户消息撤回后可以取消回复", () => {
  assert.equal(shouldCancelScheduledReply([{ role: "assistant" }, { role: "user", recalled: true }]), true);
  assert.equal(shouldCancelScheduledReply([{ role: "assistant" }, { role: "user" }]), false);
  assert.equal(shouldCancelScheduledReply([{ role: "user", recalled: true }, { role: "user" }]), false);
});
