import test from "node:test";
import assert from "node:assert/strict";

import {
  HOLDING_MAX_MS,
  HOLDING_MIN_MS,
  OFF_MAX_MS,
  OFF_MIN_MS,
  advancePhone,
  isHolding,
  msUntilPickUp,
  rollSpan,
} from "../lib/phone.js";

const T0 = Date.parse("2026-09-12T14:00:00.000Z");
const MIN = 60 * 1000;
const fixed = (value) => () => value;

test("头一回见ta：ta正拿着手机过自己的日子，不是被她叫出来的", () => {
  const p = advancePhone(null, T0, fixed(0));
  assert.equal(p.holding, true);
  assert.equal(p.untilMs, T0 + HOLDING_MIN_MS);
  assert.ok(p.untilMs > T0, "状态要落在将来");
});

test("拿着待一阵就放下，放下过一阵再拿起来", () => {
  const holding = advancePhone(null, T0, fixed(0));
  const put = advancePhone(holding, T0 + HOLDING_MIN_MS, fixed(0));
  assert.equal(put.holding, false);
  assert.equal(put.untilMs, T0 + HOLDING_MIN_MS + OFF_MIN_MS, "放下的那阵到点就摸起来");

  const again = advancePhone(put, put.untilMs, fixed(0));
  assert.equal(again.holding, true);
  assert.equal(again.untilMs, put.untilMs + HOLDING_MIN_MS);
});

test("隔很久才问一次，中间翻的那些次照样补得上，不会卡在旧状态", () => {
  const p = advancePhone(null, T0, fixed(0.5));
  const muchLater = T0 + 40 * 60 * MIN;
  const later = advancePhone(p, muchLater, fixed(0.5));
  assert.ok(later.untilMs > muchLater, "隔一天半再看，状态要推到现在之后");
  assert.equal(typeof later.holding, "boolean");
});

test("没到翻面的时候，状态原样不动", () => {
  const holding = advancePhone(null, T0, fixed(0));
  const same = advancePhone(holding, T0 + MIN, fixed(0.9));
  assert.deepEqual(same, holding, "还没到点就别乱翻");
});

test("每段多长都在区间里，放下的那阵可以很久", () => {
  assert.equal(rollSpan({ minMs: HOLDING_MIN_MS, maxMs: HOLDING_MAX_MS }, fixed(0)), HOLDING_MIN_MS);
  assert.equal(rollSpan({ minMs: OFF_MIN_MS, maxMs: OFF_MAX_MS }, fixed(1)), OFF_MAX_MS);
  assert.ok(OFF_MAX_MS <= 20 * MIN, "放下手机最多二十分钟：一两小时不看手机是例外，不是常态");
});

test("现在拿没拿着、还有多久拿起来", () => {
  const holding = advancePhone(null, T0, fixed(0));
  assert.equal(isHolding(holding, T0 + MIN, fixed(0)), true);
  assert.equal(msUntilPickUp(holding, T0 + MIN, fixed(0)), 0);

  const off = advancePhone(holding, T0 + HOLDING_MIN_MS, fixed(0));
  assert.equal(isHolding(off, T0 + HOLDING_MIN_MS, fixed(0)), false);
  assert.equal(msUntilPickUp(off, T0 + HOLDING_MIN_MS, fixed(0)), OFF_MIN_MS);
  assert.equal(msUntilPickUp(off, off.untilMs, fixed(0)), 0, "到点就算拿起来了");
});
