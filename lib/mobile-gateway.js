/**
 * 手机网关的宿主侧管理：拉起独立进程、转发调用、必要时重启。
 *
 * 网关进程干 HTTP，茶话会本体干业务（读 store、调模型）。两边只通过
 * stdin/stdout 的 JSON 行说话，谁也不用给谁开端口。
 *
 * 方向约定：
 *   网关 → 宿主：{ id, op, payload }   一句请求（id 从 1 起）
 *   宿主 → 网关：{ id, ok, data|error } 那句请求的答复
 *   网关 → 宿主：{ id: 0, ok: true, data: { listening|pong, port, pid } } 就绪
 *   宿主 → 网关：{ type: "shutdown" } / { type: "push", event }
 *
 * 几条容易踩的线（都吃过亏）：
 *   - start 幂等：已经在跑/在等就绪就不再拉第二个。
 *   - 就绪必须是 id 0 且明确说了 listening 或 pong，别的 id 0 不算。
 *   - 重启预算只在「稳定跑过一阵」之后才重置，刚 listening 就崩不重置，
 *     否则监听一成功就无限重启，外面看着像正常启动。
 *   - 旧进程的 exit 不能清新进程的引用（每次 spawn 带 generation）。
 *   - 环境原样继承，不再删 NODE_OPTIONS（那是宿主的权限策略，不该绕过）。
 */

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.join(here, "..", "runtime", "mobile-gateway.mjs");
// 手机页要复用的桌面样式目录
const DEFAULT_ASSET_DIR = path.join(here, "..", "ui", "assets");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RESTART_DELAY_MS = 3000;
const DEFAULT_STABLE_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
// 给子进程发 PING 的间隔；子进程那边连着这么多个窗口收不到就会自退
const DEFAULT_HEARTBEAT_MS = 30000;

function waitExit(proc, ms) {
  if (proc?.exitCode !== null && proc?.exitCode !== undefined) return Promise.resolve(true);
  if (proc?.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.removeListener("exit", onExit); } catch { /* 进程对象已经不在了 */ }
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    timer.unref?.();
    proc.once("exit", onExit);
  });
}

/**
 * @param {object} options
 * @param {string} options.execPath 跑网关的 node 可执行文件
 * @param {(op: string, payload: object) => Promise<any>} options.handler 宿主侧业务
 * @param {number} options.port
 * @param {string} options.password 空字符串＝网关不肯启动（运行时也会拒绝服务）
 * @param {import("node:child_process").spawn} [options.spawn] 可注入，单测用假的
 * @param {string} [options.entry] 网关入口，默认 runtime/mobile-gateway.mjs
 * @param {string[]} [options.args] 启动参数，默认 ["--allow-net", entry]：Hana 的宿主进程（hana-server）
 *                                 靠这个松网络权限；换成普通 node 运行时请从这里显式传 [entry]
 * @param {object} [options.env] 追加/覆盖的环境变量
 * @param {number} [options.maxAttempts] 连续失败几次后放弃
 * @param {number} [options.restartDelayMs]
 * @param {number} [options.stableMs] 跑满这么久才算「稳定启动」，之后清零预算
 * @param {number} [options.readyTimeoutMs] 多久没报就绪就当没起来
 * @param {number} [options.heartbeatMs] 给子进程发 PING 的间隔（0/负数则不发）
 */
export function createMobileGateway({
  execPath,
  handler,
  port,
  password,
  log = () => {},
  onState = () => {},
  spawn = nodeSpawn,
  entry = DEFAULT_ENTRY,
  assetDir = DEFAULT_ASSET_DIR,
  args = null,
  env = {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
  stableMs = DEFAULT_STABLE_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  let child = null;
  let generation = 0;
  let disposed = false;
  let attempts = 0;
  let restartTimer = null;
  let stableTimer = null;
  let readyTimer = null;
  let heartbeatTimer = null;
  let ready = false;
  let lastState = { running: false, reason: "idle" };

  function report(state) {
    lastState = state;
    try {
      onState(state);
    } catch (error) {
      log(`onState 回调出错 ${error?.message ?? error}`);
    }
  }

  function clearRestart() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function clearStable() {
    if (!stableTimer) return;
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  function clearReadyTimer() {
    if (!readyTimer) return;
    clearTimeout(readyTimer);
    readyTimer = null;
  }

  function clearHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  /** 父子心跳：宿主活着就定期 PING，子进程那边收不到会自退，不留占端口的孤儿。 */
  function armHeartbeat(proc) {
    clearHeartbeat();
    if (!(heartbeatMs > 0)) return;
    const beat = () => {
      if (child !== proc || !proc.stdin?.writable) return;
      try {
        proc.stdin.write("PING\n");
      } catch {
        // 进程刚好没了，重启逻辑会兜住
      }
    };
    beat();
    heartbeatTimer = setInterval(beat, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function launchArgs() {
    // 默认沿用宿主的显式参数：hana-server 用原子命令的 --allow-net 松网络权限，
    // 去掉它网关就听不了端口（ERR_ACCESS_DENIED）。换成普通 node 时从 options.args 传 [entry]。
    return Array.isArray(args) ? args : ["--allow-net", entry];
  }

  function start() {
    if (disposed) return false;
    // 幂等：手上已经有一个进程（死的会被 settle 清掉）就别再拉一个
    if (child) return false;
    if (!password) {
      log("没有密码，网关不启动");
      report({ running: false, reason: "no-password" });
      return false;
    }
    if (!execPath) {
      log("找不到可用的 node 运行时，网关不启动");
      report({ running: false, reason: "no-runtime" });
      return false;
    }
    clearRestart();

    const gen = ++generation;
    let proc;
    try {
      // 环境整份继承：宿主设的 NODE_OPTIONS 之类是它的策略，这里不擅自删。
      proc = spawn(execPath, launchArgs(), {
        env: {
          ...process.env,
          ...env,
          CH_MOBILE_PORT: String(port),
          CH_MOBILE_PASSWORD: String(password || ""),
          CH_MOBILE_ASSETS: assetDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      log(`spawn 抛错 ${error?.code ?? error?.message}`);
      attempts += 1;
      report({ running: false, reason: String(error?.code ?? error?.message) });
      if (attempts <= maxAttempts) scheduleRestart();
      return false;
    }

    child = proc;
    ready = false;
    log(`启动网关（第 ${gen} 个进程）：${execPath} ${launchArgs().join(" ")}`);
    armHeartbeat(proc);

    clearReadyTimer();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (child !== proc || ready) return;
      log(`网关 ${readyTimeoutMs}ms 没报就绪，当它没起来`);
      try { proc.kill(); } catch { /* 已经没了 */ }
    }, readyTimeoutMs);
    readyTimer.unref?.();

    let buffer = "";
    proc.stdout?.on("data", (chunk) => {
      if (child !== proc) return; // 旧进程的残余输出不再处理
      buffer += String(chunk);
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          log("网关输出了非协议内容，忽略");
          continue;
        }

        if (msg?.id === 0) {
          const data = msg.data && typeof msg.data === "object" ? msg.data : {};
          // 只有明确说 listening / pong 才算就绪；pong 带上 listening:false 的（还没开听）不算
          const saysReady = data.listening === true || (data.pong === true && data.listening !== false);
          if (msg.ok === false || !saysReady) {
            log(`网关回了 id 0 却没报 listening/pong，继续等：${line.slice(0, 160)}`);
            continue;
          }
          if (!ready) {
            ready = true;
            clearReadyTimer();
            log(`网关就绪 ${JSON.stringify(data)}`);
            report({ running: true, port: data.port ?? port, pid: data.pid ?? proc.pid });
          }
          armStable(proc);
          continue;
        }

        if (typeof msg?.op !== "string") continue;
        void respond(proc, msg);
      }
    });

    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log(text);
    });

    // 子进程没了以后 stdin 会 EPIPE，别让这个错误把宿主带下水
    proc.stdin?.on?.("error", () => {});
    proc.stdin?.on?.("close", () => {});

    proc.on("error", (error) => {
      if (child !== proc) return;
      log(`网关进程错误 ${error?.code ?? error?.message}`);
      settle(proc, `error ${error?.code ?? error?.message}`);
    });

    proc.on("exit", (code, signal) => {
      settle(proc, `exit ${code ?? signal}`);
    });

    return true;
  }

  function armStable(proc) {
    if (stableTimer) return;
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (child !== proc) return;
      if (attempts !== 0) log("网关稳定运行过一阵，重启预算重置");
      attempts = 0;
    }, stableMs);
    stableTimer.unref?.();
  }

  function scheduleRestart() {
    if (disposed || restartTimer) return;
    log(`第 ${attempts} 次重启网关（${restartDelayMs}ms 后）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed) return;
      start();
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function settle(proc, reason) {
    if (child !== proc) {
      // 旧进程收尾：绝不能用它来清新进程的引用
      log(`旧网关进程收尾（${reason}），不动当前实例`);
      return;
    }
    child = null;
    ready = false;
    clearReadyTimer();
    clearStable();
    clearHeartbeat();
    log(`网关进程退出 ${reason}`);
    if (disposed) {
      report({ running: false, reason: "disposed" });
      return;
    }
    attempts += 1;
    if (attempts > maxAttempts) {
      log(`网关连续退出 ${attempts} 次，不再重启`);
      report({ running: false, reason: `gave-up ${reason}` });
      return;
    }
    report({ running: false, reason });
    scheduleRestart();
  }

  async function respond(proc, msg) {
    let reply;
    try {
      if (typeof handler !== "function") throw new Error("no_handler");
      const data = await handler(msg.op, msg.payload ?? {});
      reply = { id: msg.id, ok: true, data: data ?? null };
    } catch (error) {
      reply = { id: msg.id, ok: false, error: String(error?.message ?? error) };
    }
    if (!proc.stdin?.writable) return;
    try {
      proc.stdin.write(`${JSON.stringify(reply)}\n`);
    } catch {
      // 进程刚好没了，丢掉即可，重启逻辑会兜住
    }
  }

  return {
    start,
    // 宿主主动往客户端推：网关会把它广播给所有连着 SSE 的页面。
    push(event) {
      if (!child || !ready || !child.stdin?.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify({ type: "push", event })}\n`);
        return true;
      } catch {
        return false;
      }
    },
    /** 可靠收尾：停掉所有定时器、关掉子进程。管理层要重启就先 dispose 再 create。 */
    async dispose({ timeoutMs = 2000 } = {}) {
      disposed = true;
      clearRestart();
      clearStable();
      clearReadyTimer();
      clearHeartbeat();
      const proc = child;
      child = null;
      ready = false;
      if (!proc) {
        report({ running: false, reason: "disposed" });
        return;
      }
      const exited = waitExit(proc, timeoutMs);
      try { proc.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch { /* 已经关了 */ }
      try { proc.stdin?.end?.(); } catch { /* 已经关了 */ }
      try { proc.kill(); } catch { /* 已经没了 */ }
      if (!(await exited)) {
        log("网关没在宽限期内退出，强杀");
        try { proc.kill("SIGKILL"); } catch { /* 已经没了 */ }
        await waitExit(proc, 1000);
      }
      report({ running: false, reason: "disposed" });
    },
    get state() {
      return { running: Boolean(child) && ready, pid: child?.pid ?? null, port, attempts };
    },
    get last() {
      return lastState;
    },
  };
}
