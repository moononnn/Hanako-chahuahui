import test from "node:test";
import assert from "node:assert/strict";

import {
  createInterruptibleComposer,
  REPLY_BUSY,
  REPLY_STALE,
  REPLY_SUPERSEDED,
} from "../lib/turn-window.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 一、插话无限次：这轮一直按最新上下文重开 ────────────────────

test("连着插话七次：照样收敛，不受两次上限", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let attempts = 0;
  const made = await composer.run("a", async ({ attempt }) => {
    attempts = attempt + 1;
    if (attempt < 7) {
      composer.interrupt("a", `m_${attempt}`);
      return { ok: false, reason: "superseded" };
    }
    return { ok: true, text: "接住了" };
  });
  assert.equal(made.ok, true);
  assert.equal(made.text, "接住了");
  assert.equal(attempts, 8, "插话七次就重开七次，不是两次就收手");
});

test("作废用的 signal 是我们自己 abort 的那一种", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let reason = null;
  const made = await composer.run("b", async ({ signal, attempt }) => {
    if (attempt === 0) {
      composer.interrupt("b", "m_0");
      reason = signal.reason;
      return { ok: false, reason: "superseded" };
    }
    return { ok: true };
  });
  assert.equal(made.ok, true);
  assert.equal(reason?.name, "AbortError");
  assert.equal(reason?.code, REPLY_SUPERSEDED);
});

// ── 二、一串插话合并成一次重开 ─────────────────────────────────

test("一串插话合并成一次重开：安静期内不再生成", async () => {
  const composer = createInterruptibleComposer({ settleMs: 60 });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = Date.now();
  const run = composer.run("c", async ({ attempt }) => {
    calls += 1;
    if (attempt === 0) {
      await gate;
      return { ok: false, reason: "superseded" };
    }
    return { ok: true, text: "好了" };
  });
  // 等第一轮真的跑起来，再来一串插话。
  await wait(120);
  composer.interrupt("c", "m_1");
  composer.interrupt("c", "m_2");
  composer.interrupt("c", "m_3");
  release();
  const made = await run;
  assert.equal(made.ok, true);
  assert.equal(calls, 2, "三句插话只重开一次");
  assert.ok(Date.now() - started >= 60, "重开要等最近一次插话之后的安静期");
});

// ── 三、同一时刻只有一个生成 ──────────────────────────────────

test("同一伙伴同一时刻最多一个生成在跑", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let inFlight = 0;
  let peak = 0;
  const made = await composer.run("d", async ({ attempt }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await wait(20);
    inFlight -= 1;
    if (attempt === 0) {
      composer.interrupt("d", "m_0");
      return { ok: false, reason: "superseded" };
    }
    return { ok: true };
  });
  assert.equal(made.ok, true);
  assert.equal(peak, 1);
});

// ── 四、取消 ──────────────────────────────────────────────────

test("取消：这一轮停掉，run 回 stale", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  const run = composer.run("e", async ({ signal }) => {
    await wait(50);
    if (signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      error.code = signal.reason?.code;
      throw error;
    }
    return { ok: true };
  });
  await wait(30);
  assert.equal(composer.cancel("e"), true);
  const made = await run;
  assert.equal(made.ok, false);
  assert.equal(made.reason, "stale");
  assert.equal(composer.has("e"), false, "取消完这条车道就清了");
});

test("取消时给的 signal 是 REPLY_STALE 那一种", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let reason = null;
  const run = composer.run("f", async ({ signal }) => {
    await wait(40);
    reason = signal.reason;
    return { ok: false, reason: "stale" };
  });
  await wait(20);
  composer.cancel("f");
  const made = await run;
  assert.equal(made.reason, "stale");
  assert.equal(reason?.code, REPLY_STALE);
});

// ── 五、真实错误不重试 ────────────────────────────────────────

test("真实错误照实抛出去，不重试也不吞", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let calls = 0;
  await assert.rejects(
    composer.run("g", async () => {
      calls += 1;
      throw new Error("渠道炸了");
    }),
    /渠道炸了/,
  );
  assert.equal(calls, 1, "不是我们自己 abort 的错，不该重试");
});

test("不是我们那两种取消的 AbortError 也照实抛出去", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let calls = 0;
  await assert.rejects(
    composer.run("h", async () => {
      calls += 1;
      const error = new Error("别家 abort");
      error.name = "AbortError";
      error.code = "SOMETHING_ELSE";
      throw error;
    }),
    /别家 abort/,
  );
  assert.equal(calls, 1);
});

// ── 六、同一伙伴再来一轮：拒掉，不另开生成 ────────────────────

test("同一伙伴再来一轮：拒掉，不另开生成", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = composer.run("i", async () => {
    await gate;
    return { ok: true, text: "第一轮" };
  });
  await wait(20);
  assert.equal(composer.has("i"), true);
  await assert.rejects(
    composer.run("i", async () => ({ ok: true, text: "第二轮" })),
    (error) => error.code === REPLY_BUSY && error instanceof Error,
  );
  release();
  const made = await first;
  assert.equal(made.text, "第一轮");
});

// ── 七、伙伴之间不串 ──────────────────────────────────────────

test("伙伴之间不串：一个被插话，另一个照跑", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  let aCalls = 0;
  let bCalls = 0;
  const a = composer.run("p1", async ({ attempt }) => {
    aCalls += 1;
    if (attempt === 0) {
      composer.interrupt("p1", "m_0");
      return { ok: false, reason: "superseded" };
    }
    return { ok: true, who: "p1" };
  });
  const b = composer.run("p2", async () => {
    bCalls += 1;
    return { ok: true, who: "p2" };
  });
  const [madeA, madeB] = await Promise.all([a, b]);
  assert.equal(madeA.who, "p1");
  assert.equal(madeB.who, "p2");
  assert.equal(aCalls, 2);
  assert.equal(bCalls, 1, "p1 的插话不该把 p2 也重开");
  assert.equal(composer.interrupt("p2", "m_x"), false, "p2 那轮已经结束了");
});

// ── 八、迟到的旧稿不冒充新稿 ──────────────────────────────────

test("迟到的旧稿不冒充新稿：作废过的那份不算数", async () => {
  const composer = createInterruptibleComposer({ settleMs: 20 });
  let calls = 0;
  const timer = setTimeout(() => composer.interrupt("h1", "m_0"), 30);
  const made = await composer.run("h1", async ({ attempt }) => {
    calls += 1;
    if (attempt === 0) {
      // 不理会 abort，硬扛到很晚才回：这份稿子按旧上下文写的。
      await wait(60);
      return { ok: false, reason: "superseded", text: "旧稿" };
    }
    return { ok: true, text: "新稿" };
  });
  clearTimeout(timer);
  assert.equal(made.text, "新稿", "迟到的那份不能顶上来");
  assert.equal(calls, 2);
});

// ── 九、一轮结束之后，新消息正常开下一轮 ──────────────────────

test("一轮结束后：新消息正常开下一轮", async () => {
  const composer = createInterruptibleComposer({ settleMs: 5 });
  const first = await composer.run("j", async () => ({ ok: true, text: "第一轮" }));
  assert.equal(first.text, "第一轮");
  assert.equal(composer.has("j"), false, "这一轮跑完，车道就清了");
  assert.equal(composer.interrupt("j", "m_0"), false, "没有在跑的轮次，插话不认");
  assert.equal(composer.cancel("j"), false);
  const second = await composer.run("j", async () => ({ ok: true, text: "第二轮" }));
  assert.equal(second.text, "第二轮");
});
