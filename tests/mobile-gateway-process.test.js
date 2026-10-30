/**
 * 宿主侧网关管理：用假 spawn 测进程生命周期，不拉起真的 mobile 子进程。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMobileGateway } from "../lib/mobile-gateway.js";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSpawner() {
  const children = [];

  function spawn(execPath, args, options) {
    const child = new EventEmitter();
    child.spawnedWith = { execPath, args, options };
    child.pid = 2000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;

    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.writable = true;
    stdin.written = [];
    stdin.write = (text) => {
      stdin.written.push(String(text));
      return true;
    };
    stdin.end = () => {
      stdin.writable = false;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;

    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      child.killedWith = signal;
      setImmediate(() => {
        child.exitCode = 0;
        child.signalCode = signal;
        child.emit("exit", 0, signal);
      });
      return true;
    };
    // 测试里手动制造协议行
    child.say = (row) => stdout.emit("data", `${JSON.stringify(row)}\n`);
    child.ready = (data = { listening: true, port: 18090 }) => child.say({ id: 0, ok: true, data });
    child.die = (code = 1) => {
      child.exitCode = code;
      child.emit("exit", code, null);
    };

    children.push(child);
    return child;
  }

  return { spawn, children };
}

function build(overrides = {}) {
  const { spawn, children } = makeSpawner();
  const states = [];
  const gateway = createMobileGateway({
    execPath: "node",
    handler: async () => ({ ok: true }),
    port: 18090,
    password: "pw",
    spawn,
    restartDelayMs: 5,
    stableMs: 200,
    readyTimeoutMs: 200,
    onState: (state) => states.push(state),
    ...overrides,
  });
  return { gateway, children, states };
}

test("start 幂等：连着叫三次也只拉一个进程", async (t) => {
  const { gateway, children } = build();
  t.after(() => gateway.dispose());
  assert.equal(gateway.start(), true);
  gateway.start();
  gateway.start();
  assert.equal(children.length, 1);
});

test("没密码不启动", async (t) => {
  const { gateway, children, states } = build({ password: "" });
  t.after(() => gateway.dispose());
  assert.equal(gateway.start(), false);
  assert.equal(children.length, 0);
  assert.equal(states.at(-1).reason, "no-password");
});

test("就绪只认 id 0 且明确说了 listening 或 pong", async (t) => {
  const { gateway, children, states } = build();
  t.after(() => gateway.dispose());
  gateway.start();
  const child = children[0];

  child.say({ id: 0, ok: true, data: { port: 18090 } });
  await tick();
  assert.equal(gateway.state.running, false, "id 0 但没 listening/pong，不算就绪");
  assert.equal(states.filter((row) => row.running).length, 0);

  child.say({ id: 3, ok: true, data: { listening: true } });
  await tick();
  assert.equal(gateway.state.running, false, "别的 id 报 listening 也不算");

  // 心跳的 pong 会带 listening:false（还没开听），不能当就绪信号
  child.ready({ pong: true, listening: false, port: 18090 });
  await tick();
  assert.equal(gateway.state.running, false, "pong 但 listening:false，不该报就绪");

  child.ready({ listening: true, port: 18090, pid: 4321 });
  await tick();
  assert.equal(gateway.state.running, true);
  assert.equal(states.at(-1).pid, 4321);
});

test("父子心跳：定期 PING，dispose 之后停", async (t) => {
  const { gateway, children } = build({ heartbeatMs: 20 });
  gateway.start();
  const child = children[0];
  await tick(70);
  const pings = child.stdin.written.filter((line) => line.trim() === "PING").length;
  assert.ok(pings >= 2, `该定期发 PING，实际 ${pings} 次`);
  await gateway.dispose();
  const atDispose = child.stdin.written.filter((line) => line.trim() === "PING").length;
  await tick(80);
  const after = child.stdin.written.filter((line) => line.trim() === "PING").length;
  assert.equal(after, atDispose, "dispose 之后心跳定时器该停了");
});

test("一直不报就绪：当它没起来，杀掉重来", async (t) => {
  const { gateway, children } = build({ readyTimeoutMs: 20 });
  t.after(() => gateway.dispose());
  gateway.start();
  await tick(80);
  assert.equal(children[0].killed, true, "超时该把它收掉");
  assert.ok(children.length >= 2, "收掉之后要重启");
  assert.equal(gateway.state.running, false);
});

test("连续崩：重启次数有上限，不会无限重试", async (t) => {
  const { gateway, children } = build({ maxAttempts: 2, restartDelayMs: 2 });
  t.after(() => gateway.dispose());
  gateway.start();
  for (let i = 0; i < 6; i += 1) {
    children.at(-1)?.die(1);
    await tick(20);
  }
  assert.equal(children.length, 3, "1 次首发 + 2 次重试，然后放弃");
  await tick(40);
  assert.equal(children.length, 3, "放弃之后不许再拉");
});

test("稳定跑过一阵才重置重启预算，监听刚就绪就崩不算稳定", async (t) => {
  const { gateway, children } = build({ maxAttempts: 1, stableMs: 30, restartDelayMs: 2 });
  t.after(() => gateway.dispose());
  gateway.start();

  // 第一轮：就绪 → 稳定 → 崩 → 还能再来（预算已重置）
  children[0].ready();
  await tick(60);
  children[0].die(1);
  await tick(30);
  assert.equal(children.length, 2, "稳定过一阵之后崩溃，预算该重置");

  children[1].ready();
  await tick(60);
  children[1].die(1);
  await tick(30);
  assert.equal(children.length, 3, "第二轮稳定过之后还能再拉一个");
});

test("旧进程退出不清掉新进程的引用", async (t) => {
  const { gateway, children } = build({ restartDelayMs: 2 });
  t.after(() => gateway.dispose());
  gateway.start();
  const first = children[0];
  first.ready();
  await tick();

  first.die(1);
  await tick(30);
  assert.equal(children.length, 2);
  children[1].ready();
  await tick();
  assert.equal(gateway.state.running, true);

  // 旧进程再补一条 exit（进程迟到的收尾），不能把新的抹掉
  first.emit("exit", 0, "SIGTERM");
  await tick();
  assert.equal(gateway.state.running, true);
  assert.equal(gateway.state.pid, children[1].pid);
});

test("dispose 停定时器、收子进程，之后不再重启", async (t) => {
  const { gateway, children } = build({ restartDelayMs: 100 });
  gateway.start();
  const child = children[0];
  child.die(1); // 进入重启等待
  assert.equal(children.length, 1);

  await gateway.dispose();
  assert.equal(gateway.state.running, false);

  await tick(200);
  assert.equal(children.length, 1, "dispose 之后重启定时器不许再拉进程");
  assert.equal(gateway.start(), false, "dispose 过的实例不再启动");
});

test("dispose 时子进程不理会普通 kill 就强杀", async (t) => {
  const { gateway, children } = build();
  gateway.start();
  const child = children[0];
  child.ready();
  await tick();
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.killedWith = signal;
    if (signal === "SIGKILL") {
      setImmediate(() => {
        child.exitCode = 0;
        child.signalCode = "SIGKILL";
        child.emit("exit", 0, "SIGKILL");
      });
    }
    return true;
  };
  await gateway.dispose({ timeoutMs: 20 });
  assert.equal(child.killed, true);
  assert.equal(child.killedWith, "SIGKILL");
  assert.equal(gateway.state.running, false);
});

test("环境整份继承，不偷偷删 NODE_OPTIONS", async (t) => {  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--max-old-space-size=2048";
  t.after(() => {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
  });
  const { gateway, children } = build();
  t.after(() => gateway.dispose());
  gateway.start();
  assert.equal(children[0].spawnedWith.options.env.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.equal(children[0].spawnedWith.options.env.CH_MOBILE_PASSWORD, "pw");
  assert.equal(children[0].spawnedWith.options.env.CH_MOBILE_PORT, "18090");
});

test("默认沿用宿主参数 --allow-net，可由 args 覆盖成普通 node 能跑的形态", async (t) => {
  const { gateway, children } = build();
  t.after(() => gateway.dispose());
  gateway.start();
  const args = children[0].spawnedWith.args;
  assert.equal(args[0], "--allow-net", "hana-server 靠这个松网络权限，不能擅自删");
  assert.match(args[1], /mobile-gateway\.mjs$/);
});

test("显式传 args 时按传入的来", async (t) => {
  const { gateway, children } = build({ args: ["--no-warnings", "entry.mjs"] });
  t.after(() => gateway.dispose());
  gateway.start();
  assert.deepEqual(children[0].spawnedWith.args, ["--no-warnings", "entry.mjs"]);
});

test("宿主请求会被转发给 handler，答复写回 stdin", async (t) => {
  const seen = [];
  const { gateway, children } = build({
    handler: async (op, payload) => {
      seen.push({ op, payload });
      return { messages: [] };
    },
  });
  t.after(() => gateway.dispose());
  gateway.start();
  const child = children[0];
  child.ready();
  await tick();

  assert.equal(gateway.push({ type: "threads" }), true);
  child.say({ id: 7, op: "mobile.thread.get", payload: { agentId: "nova" } });
  await tick(20);

  assert.deepEqual(seen, [{ op: "mobile.thread.get", payload: { agentId: "nova" } }]);
  const reply = JSON.parse(child.stdin.written.at(-1));
  assert.deepEqual(reply, { id: 7, ok: true, data: { messages: [] } });
  assert.ok(child.stdin.written.some((line) => line.includes('"type":"push"')));
});

test("就绪之前 push 不发出去", async (t) => {
  const { gateway, children } = build();
  t.after(() => gateway.dispose());
  gateway.start();
  assert.equal(gateway.push({ type: "threads" }), false);
  children[0].ready();
  await tick();
  assert.equal(gateway.push({ type: "threads" }), true);
});
