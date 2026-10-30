/**
 * 手机接入的管理层：配置、密码、启停、变更探测。
 *
 * 为什么单独一层：index.js 已经很大，而「什么时候该起网关、什么算一次变化」
 * 这类事情和聊天业务无关。这里只认外面给的三样东西——业务 handler、伙伴名单、
 * 每家一份的线程快照——别的一概不猜，也不自己去读 store。
 *
 * 几条硬约束（都是踩过的）：
 *   - 默认关：老版本留下的 mobile-gateway.json 里没有 enabled，也当关着。
 *   - 配置损坏绝不覆盖：读不出来就禁用并报上去，等人显式保存再恢复原样。
 *   - 存不下去就不拿这份配置去起进程：宁可不启动，也不让界面和实际不一致。
 *   - 只管自己起的那个网关：不 kill 任何不认识的进程，也不猜宿主有没有卸载钩子。
 *   - 换密码必须 dispose 再起：网关的 token 表在子进程内存里，只改文件旧会话不会失效。
 *   - 探测不比「最后一条的 id」：改稿、撤回、语音状态、删除都换 id 以外的东西。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMobileGateway } from "./mobile-gateway.js";

export const DEFAULT_MOBILE_PORT = 18090;
export const MOBILE_CONFIG_FILE = "mobile-gateway.json";
/** 密码至少这么长：旧的六位数字太容易被同一间屋里的人试出来 */
export const MIN_PASSWORD_LENGTH = 12;

// 去掉了容易认错的 0/O/1/l：念给手机那头的人听也不会抄错
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function generateMobilePassword(length = 16) {
  const size = Math.max(MIN_PASSWORD_LENGTH, Math.floor(Number(length) || 0));
  let out = "";
  while (out.length < size) {
    const byte = crypto.randomBytes(1)[0];
    const limit = 256 - (256 % PASSWORD_ALPHABET.length);
    if (byte >= limit) continue; // 拒绝采样，别让取模把字母分布压歪
    out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  }
  return out;
}

export function isValidMobilePort(value) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function mobileConfigPath(dataDir) {
  return path.join(String(dataDir ?? ""), MOBILE_CONFIG_FILE);
}

/**
 * 读配置。三种结果分开报，不把「没有」和「坏了」混成一件事：
 *   missing → 第一次用，默认关着；
 *   ok      → 用这份；
 *   corrupt → 禁用 + 报错，原文件一个字都不动。
 */
export function readMobileConfig(dataDir) {
  const file = mobileConfigPath(dataDir);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", file, config: null, error: "" };
    return { status: "corrupt", file, config: null, error: `读不出配置文件：${error?.message ?? error}` };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "corrupt", file, config: null, error: "配置文件不是一份 JSON 对象" };
  }
  if (raw.port !== undefined && raw.port !== null && !isValidMobilePort(raw.port)) {
    return { status: "corrupt", file, config: null, error: `配置里的端口不对：${String(raw.port).slice(0, 24)}` };
  }
  return {
    status: "ok",
    file,
    config: {
      // 只有明确写了 true 才算开：老文件没有这个字段，一律当关着
      enabled: raw.enabled === true,
      port: raw.port === undefined || raw.port === null ? DEFAULT_MOBILE_PORT : Math.floor(Number(raw.port)),
      password: typeof raw.password === "string" ? raw.password : "",
    },
    error: "",
  };
}

/** 写配置：先写临时文件再改名，写到一半断电也不会留下半截 JSON。失败一律抛出。 */
export function writeMobileConfig(dataDir, config) {
  const file = mobileConfigPath(dataDir);
  const body = JSON.stringify({
    enabled: config?.enabled === true,
    port: Math.floor(Number(config?.port)),
    password: String(config?.password ?? ""),
  }, null, 2);
  const temp = `${file}.tmp_${process.pid}_${Date.now()}`;
  fs.writeFileSync(temp, body, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 临时文件清不掉也不改原错误 */ }
    throw error;
  }
  return file;
}

/** 这台机器在局域网里能被手机连到的地址。只列 IPv4、跳过回环。 */
export function localAddresses(port, interfaces = null) {
  let table = interfaces;
  if (!table) {
    try {
      table = os.networkInterfaces();
    } catch {
      table = {};
    }
  }
  const rows = [];
  for (const [name, list] of Object.entries(table ?? {})) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || row.family !== "IPv4" || row.internal) continue;
      const address = String(row.address ?? "");
      if (!address) continue;
      rows.push({ name: String(name ?? ""), address, url: `http://${address}:${port}` });
    }
  }
  return rows;
}

/** 一份快照的指纹：内容变了指纹就变，跟「谁最后一条」无关。 */
export function snapshotSignature(snapshot) {
  try {
    return crypto.createHash("sha1").update(JSON.stringify(snapshot ?? null)).digest("hex").slice(0, 20);
  } catch {
    return "";
  }
}

// 同一个 dataDir 只留一个控制器：宿主重新 apply 时先把这个旧实例收干净。
const registry = new Map();

export function getMobileAccess(dataDir) {
  return registry.get(path.resolve(String(dataDir ?? ""))) ?? null;
}

export function createMobileAccess({
  dataDir,
  execPath = process.execPath,
  handler = null,
  listPartnerIds = null,
  threadSnapshot = null,
  log = () => {},
  onDiagnostics = () => {},
  createGateway = createMobileGateway,
  probeIntervalMs = 3000,
  watchRefreshMs = 60 * 1000,
} = {}) {
  if (!dataDir) throw new Error("手机接入需要 dataDir");
  const key = path.resolve(String(dataDir));

  let config = { enabled: false, port: DEFAULT_MOBILE_PORT, password: "" };
  let fileStatus = "missing";
  let fileError = "";
  let gateway = null;
  let gatewayState = { running: false, reason: "idle", pid: null };
  let probeTimer = null;
  let watchTimer = null;
  let watchedIds = [];
  let lastSignature = "";
  let notice = "";
  let disposed = false;
  /**
   * 同一个 dataDir 的上一个实例交下来的「它真退干净了」的凭证。
   * 网关的 dispose 现在是 async（先发 shutdown、再 kill，最多等 3 秒）；
   * 不 await 就建新实例，两边会抢同一个端口，新的那个直接 EADDRINUSE 退出。
   */
  let handover = null;

  // ── 状态 ───────────────────────────────────────────────
  // 已保存（enabled/port）和真的在跑（running）分两栏报：存下去不等于起来了。
  function status() {
    const running = Boolean(gatewayState.running);
    return {
      enabled: config.enabled,
      port: config.port,
      running,
      reason: running ? "running" : (gatewayState.reason || (config.enabled ? "starting" : "disabled")),
      addresses: localAddresses(config.port),
      hasPassword: Boolean(config.password),
      passwordLength: config.password ? config.password.length : 0,
      passwordNeedsUpgrade: !config.password || config.password.length < MIN_PASSWORD_LENGTH,
      pid: running ? gatewayState.pid ?? null : null,
      configFile: { status: fileStatus, error: fileError },
      notice,
    };
  }

  function load() {
    const found = readMobileConfig(dataDir);
    fileStatus = found.status;
    fileError = found.error;
    config = found.config
      ? { enabled: found.config.enabled, port: found.config.port, password: found.config.password }
      : { enabled: false, port: DEFAULT_MOBILE_PORT, password: "" };
    return status();
  }

  // ── 网关实例 ───────────────────────────────────────────

  /**
   * 收掉当前网关。**必须 await**：dispose 会等子进程真退出（最多 3 秒），
   * 不 await 就建新的，两边会抢同一个端口。
   */
  async function stopGateway(reason = "stopped") {
    stopProbe();
    const instance = gateway;
    gateway = null;
    gatewayState = { running: false, reason, pid: null };
    if (!instance) return;
    try {
      await instance.dispose?.();
    } catch (error) {
      log(`网关收尾出错：${error?.message ?? error}`);
    }
  }

  /** 同一个 dataDir 的上一个实例交了凭证：等它退干净，只等一次。 */
  async function waitHandover() {
    if (!handover) return;
    const waiting = handover;
    try {
      await waiting;
    } catch { /* 旧实例收尾出错也不能把新实例挡死 */ }
    if (handover === waiting) handover = null;
  }

  function startGateway() {
    if (disposed) return false;
    // 幂等：手上已经有一个实例就不再拉第二个（起不来/崩溃由网关自己重试）
    if (gateway) return false;
    if (!isValidMobilePort(config.port)) {
      gatewayState = { running: false, reason: "bad-port", pid: null };
      log("端口不对，网关不启动");
      return false;
    }
    if (!config.password || config.password.length < MIN_PASSWORD_LENGTH) {
      gatewayState = { running: false, reason: "no-password", pid: null };
      log("密码还没落实，网关不启动");
      return false;
    }
    let instance = null;
    // 被 dispose 掉的旧实例晚到的回报不能改新实例的状态：谁晚到都按 `gateway !== instance` 认。
    const handleState = (state) => {
      if (disposed || gateway !== instance) return;
      gatewayState = {
        running: Boolean(state?.running),
        reason: state?.reason ? String(state.reason) : "",
        pid: state?.pid ?? null,
      };
      onDiagnostics({ event: "mobile.gateway.state", ...state });
    };
    try {
      instance = createGateway({
        execPath,
        port: config.port,
        password: config.password,
        handler: dispatch,
        log: (line) => log(line),
        onState: handleState,
      });
    } catch (error) {
      gatewayState = { running: false, reason: `create-failed:${error?.message ?? error}`, pid: null };
      log(`网关建不起来：${error?.message ?? error}`);
      return false;
    }
    gateway = instance;
    gatewayState = { running: false, reason: "starting", pid: null };
    try {
      instance.start();
    } catch (error) {
      // spawn 抛错时网关自己会再试；真到这儿说明连实例都不成立，别拿着它装正常
      log(`网关起不来：${error?.message ?? error}`);
      gatewayState = { running: false, reason: String(error?.code ?? error?.message ?? error), pid: null };
      void Promise.resolve(instance.dispose?.()).catch(() => {});
      gateway = null;
      return false;
    }
    startProbe();
    return true;
  }

  /**
   * 把「存下来的配置」落实到运行时。启动幂等；enabled 为假时收干净。
   * 密码不达标（老六位、空的）在这里补一次：这是显式保存/启动的路径，
   * 升级要落盘，落不下去就不启动。
   *
   * 起之前一定先把旧的两类东西等干净：同 dataDir 上一实例交下来的 handover、
   * 以及自己手上那个已经停掉的网关。两者都关系到「端口会不会被抢」。
   */
  async function apply() {
    if (disposed) return status();
    if (!config.enabled) {
      await stopGateway("disabled");
      return status();
    }
    if (fileStatus === "corrupt") {
      await stopGateway("config-corrupt");
      return status();
    }
    const ensured = ensurePassword();
    if (!ensured.ok) {
      await stopGateway(`config-unsaved:${ensured.error}`);
      return status();
    }
    // 有 handover（同 dataDir 重新 apply）才需要等；平常这条路不发异步，启动时序不变
    if (handover) await waitHandover();
    if (disposed) return status();
    startGateway();
    return status();
  }

  function ensurePassword() {
    if (config.password && config.password.length >= MIN_PASSWORD_LENGTH) return { ok: true, upgraded: false };
    const next = { ...config, password: generateMobilePassword() };
    try {
      writeMobileConfig(dataDir, next);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    config = next;
    fileStatus = "ok";
    fileError = "";
    notice = "旧密码太短，已经换成新的；之前解锁过的手机要重新输入一次。";
    onDiagnostics({ event: "mobile.password.upgraded", port: config.port });
    return { ok: true, upgraded: true };
  }

  // ── 变更探测 ───────────────────────────────────────────
  // 只比内容指纹：改稿、撤回、语音从「在说」变「能听」、图片换了、删了、设置动了，
  // 都会让指纹变；而「最后一条 id」那种比法对这些一个都看不见。

  function startProbe() {
    if (disposed || probeTimer || !gateway) return;
    void refreshWatched();
    probeTimer = setInterval(() => { probeOnce(); }, probeIntervalMs);
    probeTimer.unref?.();
    watchTimer = setInterval(() => {
      // 网关没在跑的时候不去读伙伴名单：手机上一个人都没有，白扫一遍没意义
      if (gateway && gatewayState.running) void refreshWatched();
    }, watchRefreshMs);
    watchTimer.unref?.();
  }

  function stopProbe() {
    if (probeTimer) clearInterval(probeTimer);
    if (watchTimer) clearInterval(watchTimer);
    probeTimer = null;
    watchTimer = null;
    lastSignature = "";
    watchedIds = [];
  }

  async function refreshWatched() {
    if (typeof listPartnerIds !== "function") return watchedIds;
    try {
      const ids = await listPartnerIds();
      watchedIds = (Array.isArray(ids) ? ids : []).map((id) => String(id ?? "").trim()).filter(Boolean);
    } catch { /* 名单读不到就留着上一份 */ }
    return watchedIds;
  }

  function signatureNow() {
    const parts = [];
    for (const id of watchedIds) {
      let snapshot = null;
      try {
        snapshot = typeof threadSnapshot === "function" ? threadSnapshot(id) : null;
      } catch {
        snapshot = null;
      }
      parts.push(`${id}:${snapshotSignature(snapshot)}`);
    }
    return parts.join("|");
  }

  /** 一次探测。没有网关在跑就什么都不做：手机上没人都还去扫账本纯属白花力气。 */
  function probeOnce() {
    if (disposed || !gateway || !gatewayState.running) return { pushed: false, reason: "not-running" };
    if (!watchedIds.length) {
      void refreshWatched();
      return { pushed: false, reason: "warming" };
    }
    const signature = signatureNow();
    if (!lastSignature) {
      lastSignature = signature;
      return { pushed: false, reason: "baseline" };
    }
    if (signature === lastSignature) return { pushed: false, reason: "same" };
    lastSignature = signature;
    let pushed = false;
    try {
      pushed = Boolean(gateway.push({ type: "threads", at: Date.now() }));
    } catch (error) {
      log(`推变更出错：${error?.message ?? error}`);
    }
    onDiagnostics({ event: "mobile.push", pushed });
    return { pushed, reason: pushed ? "changed" : "push-failed" };
  }

  // ── 手机那条路进来（网关回调用） ────────────────────────
  // 管理面的三条（status/config/password）不在这里：它们只挂在桌面本机路由上。
  async function dispatch(op, payload) {
    if (typeof handler !== "function") throw new Error("no_handler");
    if (disposed) throw new Error("mobile_disposed");
    const name = String(op ?? "");
    if (!name) throw new Error("no_op");
    return handler(name, payload && typeof payload === "object" ? payload : {});
  }

  // ── 配置与密码（桌面本机用） ────────────────────────────
  //
  // 这几个写操作都会 await 旧实例的 dispose（最多 3 秒），中间有一个真实的空窗。
  // 两个写操作同时进来时，后来的那个会在前一个还等着的时候就把新实例建出来，
  // 于是旧进程没退完、新进程又去抢同一个端口，或者后一份密/端口被前一份回头盖掉。
  // 所以只把「改东西」这几件事串成一条链：status 这种读不排。
  let mutationChain = Promise.resolve();
  function enqueueMutation(task) {
    const run = mutationChain.then(task, task);
    mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function setConfigNow(patch = {}) {
    if (disposed) return { ok: false, error: "手机接入已经停用了" };
    if (patch?.enabled !== undefined && typeof patch.enabled !== "boolean") {
      return { ok: false, error: "开关只认开或关" };
    }
    const enabled = patch?.enabled === undefined ? config.enabled : patch.enabled;
    let port = config.port;
    if (patch?.port !== undefined && patch?.port !== null && String(patch.port).trim() !== "") {
      if (!isValidMobilePort(patch.port)) return { ok: false, error: "端口得是 1-65535 之间的整数" };
      port = Math.floor(Number(patch.port));
    }
    const next = { enabled, port, password: config.password };
    let upgradeNotice = "";
    if (enabled && (!next.password || next.password.length < MIN_PASSWORD_LENGTH)) {
      next.password = generateMobilePassword();
      upgradeNotice = "旧密码太短，已经换成新的；之前解锁过的手机要重新输入一次。";
    }
    const changed = fileStatus === "corrupt"
      || next.enabled !== config.enabled
      || next.port !== config.port
      || next.password !== config.password;
    if (!changed) {
      // 没改东西也照样对齐一次运行时：开关点两下不该变成两个进程
      await apply();
      return { ok: true, changed: false, notice, ...status() };
    }
    try {
      writeMobileConfig(dataDir, next);
    } catch (error) {
      // 没存下去就不改内存里那份：界面显示的必须和文件里的一致
      return { ok: false, error: `配置没写成，这次改动没有生效：${error?.message ?? error}` };
    }
    const portChanged = next.port !== config.port;
    const passwordChanged = next.password !== config.password;
    config = next;
    fileStatus = "ok";
    fileError = "";
    notice = upgradeNotice;
    // 端口/密码变了就得换实例：先把旧的等到真退出，否则新的会抢同一个端口
    if (portChanged || passwordChanged) await stopGateway(portChanged ? "port-changed" : "password-changed");
    await apply();
    onDiagnostics({
      event: "mobile.config",
      enabled: config.enabled,
      port: config.port,
      passwordUpgraded: Boolean(passwordChanged && upgradeNotice),
    });
    return { ok: true, changed: true, notice, ...status() };
  }

  async function passwordNow(action = "show") {
    if (disposed) return { ok: false, error: "手机接入已经停用了" };
    const kind = String(action ?? "").trim() || "show";
    if (kind === "show") {
      if (!config.password) return { ok: false, error: "还没有设置密码" };
      return { ok: true, action: "show", password: config.password, restarted: false, ...status() };
    }
    if (kind === "reset") {
      // 配置本身坏着的时候不能重置：那一写会把损坏的原文换成一份看起来正常的默认值，
      // 错误提示也跟着被清掉，等于拿一次重置把她的配置抹了。修的路只有一条：显式保存。
      if (fileStatus === "corrupt") {
        return {
          ok: false,
          error: "配置文件现在是坏的，先在上面把端口保存一次把它修好，再来重置密码。",
        };
      }
      const next = { ...config, password: generateMobilePassword() };
      try {
        writeMobileConfig(dataDir, next);
      } catch (error) {
        return { ok: false, error: `新密码没存下来，旧的还在用：${error?.message ?? error}` };
      }
      config = next;
      fileStatus = "ok";
      fileError = "";
      notice = "密码已经换了，之前解锁过的手机要重新输入。";
      // token 表在网关进程里：不重起的话旧会话还能用。
      // 重起要等旧的真退出——同一个端口，不能两边一起占。
      if (config.enabled) {
        await stopGateway("password-reset");
        await apply();
      }
      onDiagnostics({ event: "mobile.password.reset", enabled: config.enabled });
      return { ok: true, action: "reset", password: config.password, restarted: config.enabled, ...status() };
    }
    return { ok: false, error: "不认识这个动作" };
  }

  /** 宿主要把手机接入收掉：标记先落，具体收尾排进写链里（在途的保存不会被抢断）。 */
  function dispose() {
    disposed = true;
    return enqueueMutation(async () => {
      if (registry.get(key) === api) registry.delete(key);
      await stopGateway("disposed");
    });
  }

  // 对外只暴露排过队的那几个：写操作串行，status/load 这些读不排。
  function setConfig(patch = {}) {
    return enqueueMutation(() => setConfigNow(patch));
  }
  function password(action = "show") {
    return enqueueMutation(() => passwordNow(action));
  }

  const api = {
    load,
    apply,
    status,
    setConfig,
    password,
    dispatch,
    dispose,
    probeOnce,
    refreshWatched,
    // 测试和排查用：不改运行时，只把当前看到的指纹算出来
    signatureNow: () => signatureNow(),
    get watched() {
      return [...watchedIds];
    },
  };

  // 同一个 dataDir 又建了一次（宿主重新 apply）：先把上一个交下来的 dispose 凭证存好，
  // 等新实例真要启动时 await 它——旧进程还没退出就 spawn 会抢同一个端口。
  const previous = registry.get(key);
  if (previous && previous !== api) {
    try {
      handover = Promise.resolve(previous.dispose()).catch((error) => {
        log(`上一个手机接入实例收尾出错：${error?.message ?? error}`);
      });
    } catch (error) {
      handover = Promise.resolve();
      log(`上一个手机接入实例收尾出错：${error?.message ?? error}`);
    }
  }
  registry.set(key, api);

  return api;
}
