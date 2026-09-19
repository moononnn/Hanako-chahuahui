import test from "node:test";
import assert from "node:assert/strict";

import { logDurationMs, planTurn, DEFAULT_RHYTHM } from "../lib/rhythm.js";

const zero = () => 0;

test("字数越多，对数时长越大", () => {
  const short = logDurationMs(2, zero);
  const mid = logDurationMs(10, zero);
  const long = logDurationMs(60, zero);
  assert.ok(short < mid);
  assert.ok(mid < long);
});

test("增长是递减的（对数而非线性）", () => {
  const a = logDurationMs(10, zero) - logDurationMs(5, zero);
  const b = logDurationMs(50, zero) - logDurationMs(10, zero);
  assert.ok(a > 0 && b > 0);
  // 40 字 vs 5 字的增量，不应达到 8 倍
  assert.ok(b < a * 8);
});

test("planTurn 的 showAfterMs 严格递增，且第一条不短于打字下限", () => {
  const plan = planTurn(["在呢", "刚洗完澡", "你说"], { rand: zero, rhythm: DEFAULT_RHYTHM });
  assert.equal(plan.items.length, 3);
  let prev = 0;
  for (const item of plan.items) {
    assert.ok(item.showAfterMs > prev, "showAfterMs 必须递增");
    prev = item.showAfterMs;
  }
  assert.ok(plan.items[0].showAfterMs >= DEFAULT_RHYTHM.typingMinMs);
  assert.ok(plan.typingMs === plan.items[0].showAfterMs);
});

test("未读时长落在配置区间内", () => {
  const min = planTurn(["嗯"], { rand: zero }).readAfterMs;
  const max = planTurn(["嗯"], { rand: () => 1 }).readAfterMs;
  assert.ok(min >= DEFAULT_RHYTHM.readMinMs);
  assert.ok(max <= DEFAULT_RHYTHM.readMaxMs);
  assert.ok(max > min);
});

test("忙的时候未读明显更久", () => {
  const idle = planTurn(["嗯"], { rand: zero }).readAfterMs;
  const busy = planTurn(["嗯"], { rand: zero, busy: true }).readAfterMs;
  assert.ok(busy > idle);
});

test("speed 缩放整体节奏", () => {
  const slow = planTurn(["在呢"], { rand: zero, rhythm: { speed: 2 } });
  const fast = planTurn(["在呢"], { rand: zero, rhythm: { speed: 0.5 } });
  assert.ok(slow.readAfterMs > fast.readAfterMs);
  assert.ok(slow.items[0].showAfterMs > fast.items[0].showAfterMs);
});

test("空气泡列表只回未读时长", () => {
  const plan = planTurn([], { rand: zero });
  assert.deepEqual(plan.items, []);
  assert.ok(plan.readAfterMs > 0);
});
