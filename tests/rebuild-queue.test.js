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

const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

test("持久化 pending/running/succeeded 状态，undefined 仍视为成功", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const writes = [];
  const runs = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 1000,
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => {
      writes.push(state && { ...state, days: [...state.days] });
      states.set(id, state);
    },
    run: (id, days) => runs.push([id, days]),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "2026-10-01" });
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 0);
  assert.deepEqual(states.get("nova").days, ["2026-10-01"]);
  timers.fireAll();
  await settle();

  assert.deepEqual(runs, [["nova", ["2026-10-01"]]]);
  assert.deepEqual(writes.map((state) => state.status), ["pending", "running", "succeeded"]);
  assert.equal(states.get("nova").attempt, 1);
  assert.equal(scheduler.pending("nova"), null);
});

test("失败按有限退避重试，终态失败停住，新排期合并日期并重置预算", async () => {
  const timers = fakeTimers();
  const states = new Map();
  let attempts = 0;
  const scheduler = createThreadRebuildScheduler({
    delayMs: 100,
    retryDelaysMs: [10],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => (++attempts < 3 ? { ok: false, error: `fail-${attempts}` } : { ok: true }),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "day-1" });
  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 1);
  assert.equal(states.get("nova").error, "fail-1");
  assert.deepEqual(timers.waits, [10]);

  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "failed");
  assert.equal(states.get("nova").attempt, 2);
  assert.equal(states.get("nova").error, "fail-2");
  const reloadTimers = fakeTimers();
  const reloaded = createThreadRebuildScheduler({
    readState: (id) => states.get(id) ?? null,
    run: () => { throw new Error("failed 状态不应自动运行"); },
    ...reloadTimers,
  });
  assert.equal(reloaded.resume("nova"), null);
  assert.equal(reloadTimers.count, 0, "重载后 failed 状态也不会自动恢复重试");
  assert.equal(timers.count, 0, "failed 状态不会自动恢复重试");

  scheduler.schedule("nova", { ledgerDay: "day-2" });
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 0);
  assert.deepEqual(states.get("nova").days, ["day-1", "day-2"]);
  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "succeeded");
  assert.equal(states.get("nova").attempt, 1);
});

test("resume 恢复持久 pending 且不重置 attempt", async () => {
  const timers = fakeTimers();
  const states = new Map([["nova", {
    status: "pending", days: ["day-1"], attempt: 1, generation: 7,
    updatedAt: 123, error: "先前失败",
  }]]);
  const scheduler = createThreadRebuildScheduler({
    delayMs: 45000,
    retryDelaysMs: [10, 20, 30],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => ({ ok: false, error: "again" }),
    ...timers,
  });

  assert.deepEqual(scheduler.resume("nova"), {
    agentId: "nova", delayMs: 45000, days: ["day-1"],
  });
  assert.equal(states.get("nova").attempt, 1);
  assert.equal(states.get("nova").generation, 7);
  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 2);
  assert.equal(states.get("nova").error, "again");
  assert.deepEqual(timers.waits, [20], "退避从恢复前的 attempt 继续") ;
});

test("resume 从持久 running 状态接续，保留 attempt 并继续递增", async () => {
  const timers = fakeTimers();
  const states = new Map([["nova", {
    status: "running", days: ["day-1"], attempt: 2, generation: 4,
    updatedAt: 123, error: null,
  }]]);
  let runs = 0;
  const scheduler = createThreadRebuildScheduler({
    delayMs: 50,
    retryDelaysMs: [10, 20],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => { runs += 1; },
    ...timers,
  });

  scheduler.resume("nova");
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 2);
  timers.fireAll();
  await settle();
  assert.equal(runs, 1);
  assert.equal(states.get("nova").status, "succeeded");
  assert.equal(states.get("nova").attempt, 3);
});

test("resume 的 running attempt 已耗尽总预算时转 failed 且不再调用 run", async () => {
  const timers = fakeTimers();
  const states = new Map([["nova", {
    status: "running", days: ["day-1"], attempt: 2, generation: 4,
    updatedAt: 123, error: null,
  }]]);
  let runs = 0;
  const scheduler = createThreadRebuildScheduler({
    retryDelaysMs: [10],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => { runs += 1; return { ok: true }; },
    ...timers,
  });

  scheduler.resume("nova");
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").attempt, 2);
  timers.fireAll();
  await settle();
  assert.equal(runs, 0, "attempt 已达 1 + retries，不得再启动 run");
  assert.equal(states.get("nova").status, "failed");
  assert.equal(states.get("nova").attempt, 2);
  assert.equal(timers.count, 0);
});

test("终态保存失败时落 failed 错误状态，不留下虚假的 succeeded", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const scheduler = createThreadRebuildScheduler({
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => {
      if (state?.status === "succeeded") throw new Error("terminal write failed");
      states.set(id, state);
    },
    run: () => undefined,
    ...timers,
  });

  scheduler.schedule("nova");
  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "failed");
  assert.match(states.get("nova").error, /保存succeeded状态失败: terminal write failed/);
  assert.equal(states.get("nova").attempt, 1);
});

test("cancel 持久清除失败时返回 false，推进 generation 并尽力保存 failed", () => {
  const timers = fakeTimers();
  const states = new Map();
  let runs = 0;
  const scheduler = createThreadRebuildScheduler({
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => {
      if (state === null) throw new Error("clear failed");
      states.set(id, state);
    },
    run: () => { runs += 1; },
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "day-1" });
  const oldGeneration = states.get("nova").generation;
  assert.equal(scheduler.cancel("nova"), false);
  assert.equal(timers.count, 0);
  assert.equal(states.get("nova").status, "failed");
  assert.ok(states.get("nova").generation > oldGeneration);
  assert.match(states.get("nova").error, /清除排程状态失败: clear failed/);
  assert.equal(scheduler.resume("nova"), null);
  timers.fireAll();
  assert.equal(runs, 0);
});

test("pending 或 running 持久化失败时绝不调用 run", async () => {
  const pendingTimers = fakeTimers();
  let pendingRuns = 0;
  const pendingScheduler = createThreadRebuildScheduler({
    writeState: (_id, state) => { if (state?.status === "pending") throw new Error("disk full"); },
    run: () => { pendingRuns += 1; },
    ...pendingTimers,
  });
  assert.equal(pendingScheduler.schedule("nova"), null);
  assert.equal(pendingTimers.count, 0);
  assert.equal(pendingRuns, 0);

  const runningTimers = fakeTimers();
  const runningStates = new Map();
  let runningRuns = 0;
  const runningScheduler = createThreadRebuildScheduler({
    writeState: (id, state) => {
      if (state?.status === "running") throw new Error("disk full");
      runningStates.set(id, state);
    },
    run: () => { runningRuns += 1; },
    ...runningTimers,
  });
  runningScheduler.schedule("nova");
  runningTimers.fireAll();
  await settle();
  assert.equal(runningRuns, 0);
  assert.equal(runningStates.get("nova").status, "failed");
  assert.equal(runningStates.get("nova").attempt, 0, "没调用 run 不算一次尝试");
});

test("取消使正在运行的旧 generation 失效并清除持久状态", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const started = deferred();
  const finish = deferred();
  const writes = [];
  const scheduler = createThreadRebuildScheduler({
    delayMs: 100,
    retryDelaysMs: [10],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => {
      writes.push(state);
      states.set(id, state);
    },
    run: () => { started.resolve(); return finish.promise; },
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "day-1" });
  timers.fireAll();
  await started.promise;
  assert.equal(states.get("nova").status, "running");
  assert.equal(scheduler.cancel("nova"), true);
  const writeCountAfterCancel = writes.length;
  assert.equal(states.get("nova"), null);

  finish.resolve({ ok: false, error: "late failure" });
  await settle();
  assert.equal(writes.length, writeCountAfterCancel, "过期 run 不得回写或重排 retry");
  assert.equal(timers.count, 0);
  assert.equal(states.get("nova"), null);
});

test("新排期推进 generation，旧 run 不能覆盖新状态或安排 retry", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const firstRun = deferred();
  let runs = 0;
  const scheduler = createThreadRebuildScheduler({
    delayMs: 100,
    retryDelaysMs: [10],
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => (++runs === 1 ? firstRun.promise : { ok: true }),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "day-1" });
  timers.fireAll();
  assert.equal(states.get("nova").status, "running");
  scheduler.schedule("nova", { ledgerDay: "day-2" });
  const newGeneration = states.get("nova").generation;
  assert.equal(newGeneration, 2);
  assert.deepEqual(states.get("nova").days, ["day-1", "day-2"]);

  firstRun.resolve({ ok: false, error: "stale failure" });
  await settle();
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").generation, newGeneration);
  assert.deepEqual(timers.waits, [100], "旧失败不应插入 retry 定时器");

  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "succeeded");
  assert.equal(states.get("nova").generation, newGeneration);
  assert.equal(runs, 2);
});

test("旧 generation 的成功结果也不能覆盖新排期", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const firstRun = deferred();
  let runs = 0;
  const scheduler = createThreadRebuildScheduler({
    delayMs: 100,
    readState: (id) => states.get(id) ?? null,
    writeState: (id, state) => states.set(id, state),
    run: () => (++runs === 1 ? firstRun.promise : { ok: true }),
    ...timers,
  });

  scheduler.schedule("nova", { ledgerDay: "day-1" });
  timers.fireAll();
  scheduler.schedule("nova", { ledgerDay: "day-2" });
  const generation = states.get("nova").generation;
  firstRun.resolve({ ok: true });
  await settle();
  assert.equal(states.get("nova").status, "pending");
  assert.equal(states.get("nova").generation, generation);
  assert.equal(timers.count, 1);

  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "succeeded");
  assert.equal(states.get("nova").generation, generation);
});

test("run 的异步拒绝被转换为状态，不产生未处理 rejection", async () => {
  const timers = fakeTimers();
  const states = new Map();
  const scheduler = createThreadRebuildScheduler({
    retryDelaysMs: [],
    writeState: (id, state) => states.set(id, state),
    run: async () => { throw new Error("model failed"); },
    ...timers,
  });

  scheduler.schedule("nova");
  timers.fireAll();
  await settle();
  assert.equal(states.get("nova").status, "failed");
  assert.equal(states.get("nova").error, "model failed");
});
