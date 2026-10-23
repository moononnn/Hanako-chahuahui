import test from "node:test";
import assert from "node:assert/strict";
import { withModelDeadline, generateReply } from "../lib/model.js";
import { createInterruptibleComposer } from "../lib/turn-window.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("插话请求等取消确认后才重开，旧流无需返回正文", async () => {
  const composer = createInterruptibleComposer({ settleMs: 0 });
  let cancelled;
  const cancelStarted = new Promise((resolve) => { cancelled = resolve; });
  let acknowledge;
  const confirmation = new Promise((resolve) => { acknowledge = resolve; });
  const controller = new AbortController();
  const reason = { name: "AbortError", code: "REPLY_SUPERSEDED", waitForRelease: true };
  let finished = false;
  const result = withModelDeadline({ models: { cancel: async () => { cancelled(); await confirmation; } } }, {
    requestId: "old", timeoutMs: 2000, signal: controller.signal, run: () => new Promise(() => {}),
  }).finally(() => { finished = true; });
  await tick();
  controller.abort(reason);
  await cancelStarted;
  assert.equal(finished, false);
  acknowledge();
  await assert.rejects(result, (error) => error === reason);
  assert.equal(await composer.run("nova", async () => ({ ok: true } )).then((value) => value.ok), true);
});

test("取消失败必须停住，不把它吞成插话重试或切模型", async () => {
  const composer = createInterruptibleComposer({ settleMs: 0 });
  let calls = 0;
  let utilities = 0;
  const ctx = { models: {
    list: async () => ({ models: [{ provider: "test", model: "same" }] }),
    stream: async () => { calls++; composer.interrupt("nova", "new"); return new Promise(() => {}); },
    cancel: async () => { throw new Error("取消没有确认"); },
    utility: async () => { utilities++; },
  } };
  await assert.rejects(composer.run("nova", ({ signal }) => generateReply(ctx, {
    systemPrompt: "聊天", messages: [{ role: "user", content: "你好" }], signal,
  })), { code: "MODEL_CANCEL_UNCONFIRMED" });
  assert.equal(calls, 1);
  assert.equal(utilities, 0);
});

test("收到插话后碰巧发生真实错误，也不能冒充取消吞掉", async () => {
  const composer = createInterruptibleComposer({ settleMs: 0 });
  const failure = new Error("实际解析失败");
  await assert.rejects(composer.run("nova", async () => {
    composer.interrupt("nova", "new");
    throw failure;
  }), (error) => error === failure);
});
