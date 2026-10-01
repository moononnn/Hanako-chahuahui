import test from "node:test";
import assert from "node:assert/strict";
import { createThreadRebuildScheduler } from "../lib/rebuild-queue.js";

/** 手写一个定时器：记下回调，显式 fire，方便断言“排了几次、跑了没有”。 */
function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutFn(fn, wait) {
      const id = ++seq;
      timers.set(id, { fn, wait });
      return { id, unref() {} };
    },
    clearTimeoutFn(handle) {
      if (handle?.id) timers.delete(handle.id);
    },
    fireAll() {
      const rows = [...timers.values()];
      timers.clear();
      for (const row of rows) row.fn();
      return rows;
    },
    get count() { return timers.size; },
    get waits() { return [...timers.values()].map((row) => row.wait); },
  };
}

test("同一个伙伴连着排几次，只留一个定时器，跑的时候带上合并后的日子", () => {
  const timers = fakeTimers();
  const runs = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 1000,
    run: (agentId, days) => runs.push([agentId, days]),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "2026-10-01" });
  scheduler.schedule("nova", { ledgerDay: "2026-09-30" });
  scheduler.schedule("nova", {});

  assert.equal(timers.count, 1, "连续删除只留一个排期");
  assert.equal(runs.length, 0, "到点之前不跑");

  timers.fireAll();
  assert.deepEqual(runs, [["nova", ["2026-10-01", "2026-09-30"]]]);
  assert.equal(scheduler.pending("nova"), null, "跑完就清干净");
});

test("不同伙伴各排各的，互不合并", () => {
  const timers = fakeTimers();
  const runs = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 1000,
    run: (agentId, days) => runs.push([agentId, days]),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "2026-10-01" });
  scheduler.schedule("ta-other", { ledgerDay: "2026-09-29" });
  assert.equal(timers.count, 2);

  timers.fireAll();
  assert.deepEqual(runs.sort(), [["nova", ["2026-10-01"]], ["ta-other", ["2026-09-29"]]].sort());
});

test("取消之后不再跑；空 agentId 与没给 run 时不排", () => {
  const timers = fakeTimers();
  const runs = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 1000,
    run: (agentId) => runs.push(agentId),
    ...timers,
  });

  scheduler.schedule("nova");
  assert.equal(scheduler.cancel("nova"), true);
  timers.fireAll();
  assert.deepEqual(runs, []);
  assert.equal(scheduler.cancel("nova"), false);

  assert.equal(scheduler.schedule(""), null);
  const noRun = createThreadRebuildScheduler({ delayMs: 1000, ...timers });
  assert.equal(noRun.schedule("nova"), null, "没有 run 就不该排");
});

test("排期时把等待时长和日子报出来（诊断用），并接受自定义延迟", () => {
  const timers = fakeTimers();
  const notes = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 45_000,
    run: () => {},
    onSchedule: (row) => notes.push(row),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "2026-10-01", delay: 5000 });
  assert.deepEqual(notes, [{ agentId: "nova", delayMs: 5000, days: ["2026-10-01"] }]);
  assert.deepEqual(timers.waits, [5000]);
});
