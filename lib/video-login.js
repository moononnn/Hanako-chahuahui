/**
 * B站登录。fetcher 必须由宿主传入 ctx.network.fetch，不使用全局网络能力。
 * 只有 getCookie() 可向内部调用方返回 Cookie；不得把它的结果转发给 UI/模型。
 * loadCredential 可包裹 readVideoCredential；最多调用一次，不在此读写磁盘。
 * 凭据落盘分两种锁：encrypted（系统锁）、local（本机锁）；拿不到锁时只在内存里。
 */
import { randomUUID } from "node:crypto";
import QRCode from "./vendor/video-qrcode/index.cjs";

const PASSPORT = "https://passport.bilibili.com";
const GENERATE = `${PASSPORT}/x/passport-login/web/qrcode/generate`;
const POLL = `${PASSPORT}/x/passport-login/web/qrcode/poll`;
const NAV = "https://api.bilibili.com/x/web-interface/nav";
const CROSS_HOST = "passport.biligame.com";
const CROSS_PATH = "/x/passport-login/web/crossDomain";
const CACHE_MS = 5 * 60 * 1000;
const QR_TTL_MS = 180 * 1000;
const POLL_GAP_MS = 2000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LEGACY_HOSTS = new Set(["passport.bilibili.com", CROSS_HOST, "www.bilibili.com"]);

const failure = (reason) => ({ ok: false, reason });
const expiredQr = () => ({ ok: true, status: "expired" });

function officialUrl(raw, hosts) {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

// 保留标准百分号编码，拒绝 Cookie/请求头注入。只提取 SESSDATA，绝不附带 UID 等。
function sessionCookie(value) {
  if (typeof value !== "string" || !value || value.length > 4096) return "";
  try {
    const decoded = decodeURIComponent(value);
    // 星号属于合法Cookie值字符，不能将含星号的SESSDATA误判为注入。
    if (!/^[A-Za-z0-9._~,+/*=-]+$/u.test(decoded)) return "";
    return `SESSDATA=${encodeURIComponent(decoded)}`;
  } catch {
    return "";
  }
}

function loadedCookie(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || /[\r\n]/u.test(raw)) return "";
  const entries = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith("SESSDATA="));
  return entries.length === 1 ? sessionCookie(entries[0].slice(9)) : "";
}

function responseCookie(headers, probe = null) {
  let values = [];
  try {
    const separate = headers?.getSetCookie?.();
    if (Array.isArray(separate)) values = separate.filter((value) => typeof value === "string");
  } catch { /* 宿主可能只有 get()。 */ }
  if (!values.length) {
    try {
      const joined = headers?.get?.("set-cookie");
      if (typeof joined === "string") values = [joined];
    } catch { /* 不回显原始 headers 或异常。 */ }
  }
  let cookie = "";
  for (const value of values) {
    if (value.length > 32768 || /[\r\n]/u.test(value)) continue;
    // 只识别 Cookie 名后的等号作为边界，Expires 的日期逗号不构成边界。
    const re = /(?:^|,\s*)SESSDATA=([^;\r\n]*?)(;[^\r\n]*?)?(?=,\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=|$)/gu;
    for (const match of value.matchAll(re)) {
      if (probe) probe.sessionCookieFieldPresent = true;
      const attributes = match[2] || "";
      const age = attributes.match(/;\s*max-age\s*=\s*(-?\d+)\s*(?:;|$)/iu);
      const expires = attributes.match(/;\s*expires\s*=\s*([^;]+)/iu);
      const deleted = age ? Number(age[1]) <= 0 : Boolean(expires && Date.parse(expires[1]) <= Date.now());
      cookie = deleted ? "" : sessionCookie(match[1]);
    }
  }
  return cookie;
}

function loginUrlShape(raw) {
  try {
    const url = new URL(raw);
    return { loginUrlHost: [...LEGACY_HOSTS, "account.bilibili.com"].includes(url.hostname) ? url.hostname : "other",
      https: url.protocol === "https:", crossDomainPath: url.pathname === CROSS_PATH,
      hasSessionParameter: url.searchParams.has("SESSDATA"), hasTicketParameter: url.searchParams.has("ticket") };
  } catch { return { loginUrlParseFailed: true, urlType: typeof raw }; }
}

function qrSvg(url) {
  // URL.href 为 ASCII；上游编码器以 byte 模式编码，不引入外链、脚本或原始 URL 文本。
  const qr = new QRCode(0, 0); // 自动版本，纠错 M。
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + 8; // 四模块静区。
  let pixels = "";
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (!qr.isDark(y, x)) continue;
      const start = x;
      while (x + 1 < count && qr.isDark(y, x + 1)) x += 1;
      const width = x - start + 1;
      pixels += `M${start + 4} ${y + 4}h${width}v1h-${width}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 4}" height="${size * 4}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${pixels}" fill="#000"/></svg>`;
}

export function createVideoLogin({ fetcher, loadCredential, saveCredential, clearCredential, onDiagnostic } = {}) {
  let cookie = "";
  let credentialStorage = "none";
  let credentialQueue = Promise.resolve();
  let current = "none";
  let episodeId = null;
  let checkedAt = -Infinity;
  let generation = 0;
  let tokenAttempt = 0;
  let qrRevision = 0;
  let loadPromise = null;
  let statusFlight = null;
  let activeQr = null;
  let generateProbe = {};
  let ticketProbe = {};
  const reportPoll = (stage, details = {}) => {
    try { onDiagnostic?.({ event: "video.login.confirm", stage, ...details }); } catch { /* 不影响登录。 */ }
  };
  const reportGenerate = (stage, details = {}) => {
    try { onDiagnostic?.({ event: "video.login.qrcode", stage, ...generateProbe, ...details }); } catch { /* 诊断失败不改变登录流程。 */ }
  };
  const queueCredentialWork = (operation) => {
    const work = credentialQueue.then(operation, operation);
    credentialQueue = work.catch(() => {});
    return work;
  };

  const snapshot = () => ({
    status: current,
    hasLogin: current === "loggedIn",
    storage: cookie ? credentialStorage : "none",
    ...(episodeId ? { episodeId } : {}),
  });

  function savedStorage(saved) {
    if (saved?.ok !== true) return "";
    if (saved.storage === "local") return "local";
    return saved.encrypted === true || saved.storage === "encrypted" ? "encrypted" : "";
  }

  function ensureLoaded() {
    // 扫码可能先于任何 status/getCookie 成功；不能随后再用旧磁盘凭据覆盖它。
    if (cookie) return Promise.resolve();
    if (!loadPromise) {
      const before = generation;
      loadPromise = Promise.resolve().then(async () => {
        if (typeof loadCredential !== "function") return;
        try {
          const saved = await loadCredential();
          const found = saved?.ok === true ? loadedCookie(saved.cookie) : "";
          const storage = savedStorage(saved);
          if (found && generation === before) {
            cookie = found;
            credentialStorage = storage || "memory";
            current = "unknown";
          }
        } catch { /* 缺失、解密失败均不返回异常/凭据；仍可重新扫码。 */ }
      });
    }
    return loadPromise;
  }

  async function persistCredential(candidate, expectedGeneration) {
    if (typeof saveCredential !== "function") return false;
    let saved = null;
    try {
      saved = await queueCredentialWork(async () => {
        if (generation !== expectedGeneration || cookie !== candidate) return null;
        try { return await saveCredential(candidate); } catch { return null; }
      });
    } catch { /* 持久化失败不撤销已验证的本次登录。 */ }
    if (generation !== expectedGeneration || cookie !== candidate) return false;
    const storage = savedStorage(saved) || "memory";
    credentialStorage = storage;
    reportPoll(storage === "memory" ? "credential-save-failed" : "credential-saved", { storage });
    return storage !== "memory";
  }

  async function clearPersistedCredential(expectedGeneration) {
    if (typeof clearCredential !== "function") return false;
    try {
      const result = await queueCredentialWork(async () => {
        if (generation !== expectedGeneration) return null;
        try { return await clearCredential(); } catch { return null; }
      });
      return result?.ok === true;
    } catch { return false; }
  }

  async function request(url, credential = "", allowRedirectResponse = false) {
    if (typeof fetcher !== "function") return null;
    try {
      const headers = { "User-Agent": UA, Referer: url === NAV ? "https://www.bilibili.com/" : `${PASSPORT}/login` };
      if (credential) headers.Cookie = credential; // 仅 checkNav 调用时传入。
      const response = await fetcher(url, { method: "GET", headers, timeoutMs: 8000, maxResponseBytes: 262144 });
      if (url === GENERATE) generateProbe = { httpStatus: Number.isInteger(response?.status) ? response.status : null };
      if (url.startsWith(`https://${CROSS_HOST}${CROSS_PATH}?`)) ticketProbe = { httpStatus: Number.isInteger(response?.status) ? response.status : null };
      // 当前宿主不支持 manual redirect，且不提供 Response.url；不虚构阻止重定向。
      // 若将来暴露落地 URL，则拒绝与精确请求 origin/path 不同的回包。
      if (response?.url) {
        const landed = new URL(response.url);
        const initial = new URL(url);
        if (landed.origin !== initial.origin || landed.pathname !== initial.pathname || landed.username || landed.password) return null;
      }
      if (response?.ok === true || (allowRedirectResponse && response?.status >= 300 && response.status < 400)) return response;
    } catch (error) {
      // 只记固定错误码，绝不记录可能含key/票据/凭据的异常文本或URL。
      if (url === GENERATE) generateProbe = { transportError: true,
        errorCode: ["ERR_ACCESS_DENIED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].includes(error?.code) ? error.code : null };
    }
    return null;
  }

  async function jsonRequest(url, credential = "") {
    const response = await request(url, credential);
    try { return response ? await response.json() : null; } catch {
      if (url === GENERATE) generateProbe = { ...generateProbe, parseFailed: true };
      return null;
    }
  }

  async function checkNav(candidate) {
    const result = await jsonRequest(NAV, candidate);
    if (result?.code === -101 || result?.data?.isLogin === false) return "expired";
    if (result?.code === 0 && result?.data?.isLogin === true) return "loggedIn";
    return "unknown";
  }

  async function status({ force = false } = {}) {
    await ensureLoaded();
    if (!cookie) return snapshot();
    // 强制检查也合并当前在途请求，不打出并行 nav。
    if (statusFlight) return statusFlight;
    if (!force && Date.now() - checkedAt < CACHE_MS) return snapshot();
    const before = generation;
    const candidate = cookie;
    const work = (async () => {
      const next = await checkNav(candidate);
      if (generation === before) {
        current = next;
        checkedAt = Date.now();
        if (next === "expired") {
          episodeId ||= randomUUID();
          // 任何真的落过盘的凭据都要跟着失效一起清，本机锁的也算。
          const clearSaved = credentialStorage === "encrypted" || credentialStorage === "local";
          cookie = "";
          credentialStorage = "none";
          if (clearSaved) await clearPersistedCredential(before);
        }
        if (next === "loggedIn") episodeId = null;
      }
      return snapshot();
    })();
    statusFlight = work;
    try { return await work; } finally { if (statusFlight === work) statusFlight = null; }
  }

  async function getCookie() {
    await ensureLoaded();
    return cookie;
  }

  // 只有验证成功才能提交；成功后立即废弃旧 nav、旧 token 和旧二维码异步回包。
  function commit(candidate, qr = null) {
    if (activeQr) activeQr.pendingCookie = "";
    cookie = candidate;
    credentialStorage = "memory";
    current = "loggedIn";
    episodeId = null;
    checkedAt = Date.now();
    generation += 1;
    tokenAttempt += 1;
    qrRevision += 1;
    statusFlight = null;
    activeQr = qr ? { id: qr.id, terminal: null } : null;
    return generation;
  }

  async function loginToken(token) {
    await ensureLoaded();
    const attempt = ++tokenAttempt;
    const before = generation;
    const candidate = sessionCookie(typeof token === "string" ? token.replace(/^SESSDATA=/u, "") : "");
    if (!candidate) return failure("登录凭据格式不正确");
    const next = await checkNav(candidate);
    if (generation !== before || tokenAttempt !== attempt) return failure("登录操作已更新，请查看当前状态");
    if (next !== "loggedIn") return failure(next === "expired" ? "登录凭据无效，请重新登录" : "暂时无法验证登录，请稍后重试");
    commit(candidate);
    return { ok: true, ...snapshot() };
  }

  async function start() {
    const revision = ++qrRevision;
    if (activeQr) activeQr.pendingCookie = "";
    activeQr = null; // 刷新立即废弃旧会话，包括正在等待回包的 poll。
    const startedAt = Date.now();
    generateProbe = {};
    const result = await jsonRequest(GENERATE);
    if (revision !== qrRevision) return failure("二维码已更新，请使用最新二维码");
    if (!result) {
      const rejected = Number.isInteger(generateProbe.httpStatus) && generateProbe.httpStatus >= 400;
      reportGenerate(generateProbe.parseFailed ? "response-format" : rejected ? "http-rejected" : "request-failed");
      return failure(generateProbe.parseFailed ? "B站返回的二维码格式暂不兼容。" : rejected
        ? "B站二维码接口拒绝了请求，请稍后重试。" : "连接B站二维码接口失败，请检查网络权限或连接。");
    }
    if (result.code !== 0) {
      reportGenerate("business-rejected", { businessCode: Number.isFinite(result.code) ? result.code : null });
      return failure("B站二维码接口拒绝了请求，请稍后重试。");
    }
    const data = result.data;
    // 官方生成接口当前也返回account域；只编码二维码，不向此地址发起后台请求。
    const url = officialUrl(data?.url, new Set(["passport.bilibili.com", "account.bilibili.com"]));
    const key = data?.qrcode_key;
    if (!url || url.href.length > 2048 || typeof key !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(key)
      || url.searchParams.getAll("qrcode_key").length !== 1 || url.searchParams.get("qrcode_key") !== key) {
      reportGenerate("response-format", { urlType: typeof data?.url, keyType: typeof key,
        officialUrl: Boolean(url), keyCount: url?.searchParams.getAll("qrcode_key").length ?? 0,
        keyMatches: Boolean(url && url.searchParams.get("qrcode_key") === key) });
      return failure("B站返回的二维码格式暂不兼容。");
    }
    const expiresAt = startedAt + QR_TTL_MS;
    if (Date.now() >= expiresAt) return failure("二维码已过期，请重新生成");
    let svg;
    try { svg = qrSvg(url.href); } catch (error) {
      reportGenerate("local-encoding", { errorType: ["TypeError", "RangeError", "Error"].includes(error?.name) ? error.name : "unknown" });
      return failure("本地二维码编码失败。");
    }
    reportGenerate("ready");
    const id = randomUUID();
    activeQr = { id, key, expiresAt, pendingCookie: "", lastPollAt: -Infinity, lastResult: { ok: true, status: "waiting" }, flight: null, terminal: null };
    return { ok: true, id, svg, expiresAt };
  }

  function live(qr) {
    return activeQr === qr && !qr.terminal && Date.now() < qr.expiresAt;
  }

  function expire(qr) {
    qr.pendingCookie = "";
    qr.key = "";
    qr.terminal = expiredQr();
    return { ...qr.terminal };
  }

  async function cookieFromLoginUrl(raw) {
    const url = officialUrl(raw, LEGACY_HOSTS);
    if (!url) {
      reportPoll("login-url-rejected", loginUrlShape(raw));
      return "";
    }
    const sessdata = url.searchParams.getAll("SESSDATA");
    if (sessdata.length) return sessdata.length === 1 ? sessionCookie(sessdata[0]) : "";
    // ticket 只用于官方跨域接口，不得当作 SESSDATA，也不访问任意回包地址。
    if (url.hostname !== CROSS_HOST || url.pathname !== CROSS_PATH) {
      reportPoll("ticket-url-unrecognized", loginUrlShape(raw));
      return "";
    }
    const tickets = url.searchParams.getAll("ticket");
    if (tickets.length !== 1 || !tickets[0] || tickets[0].length > 4096 || /[\s\x00-\x1f\x7f]/u.test(tickets[0])) return "";
    const endpoint = new URL(`https://${CROSS_HOST}${CROSS_PATH}`);
    endpoint.searchParams.set("ticket", tickets[0]); // 不转发 gourl、UID 或其他回包参数。
    ticketProbe = {};
    const response = await request(endpoint.href, "", true);
    const cookieProbe = { sessionCookieFieldPresent: false };
    const candidate = responseCookie(response?.headers, cookieProbe);
    let hasCookieHeader = false;
    try { hasCookieHeader = Boolean(response?.headers?.get?.("set-cookie") || response?.headers?.getSetCookie?.()?.length); } catch { /* 不回显headers。 */ }
    reportPoll("ticket-response", { ...ticketProbe, responseAccepted: Boolean(response), cookieHeaderPresent: hasCookieHeader, ...cookieProbe, sessionCookiePresent: Boolean(candidate) });
    // 宿主跟随 302 后看不到中间 Set-Cookie 时，空结果安全失败；不改走原生网络或其他接口。
    return candidate;
  }

  async function performPoll(qr) {
    const before = generation;
    const endpoint = new URL(POLL);
    endpoint.searchParams.set("qrcode_key", qr.key);
    const response = await request(endpoint.href);
    let result = null;
    try { result = response ? await response.json() : null; } catch { /* 只报告阶段，不回显原文。 */ }
    if (!live(qr) || generation !== before) return expiredQr();
    if (result?.code !== 0) {
      reportPoll("poll-rejected", { httpStatus: Number.isInteger(response?.status) ? response.status : null,
        businessCode: Number.isFinite(result?.code) ? result.code : null });
      return failure("扫码状态读取失败，请稍后重试");
    }
    const pollCode = result?.data?.code;
    const headerProbe = { sessionCookieFieldPresent: false };
    const headerCookie = responseCookie(response?.headers, headerProbe);
    // 对齐已实测成功的轮询收集方式；只暂存同一二维码的SESSDATA，不重送其他Cookie。
    // 明确空值或无效值会清除旧候选，不能复活已撤销的凭据。
    if ([86101, 86090, 0].includes(pollCode) && headerProbe.sessionCookieFieldPresent) qr.pendingCookie = headerCookie;
    switch (pollCode) {
      case 86101: return { ok: true, status: "waiting" };
      case 86090: return { ok: true, status: "scanned" };
      case 86038: return expire(qr);
      case 0: break;
      default: return failure("扫码状态暂时无法确认，请稍后重试");
    }
    // 最终确认后才可验证并提交；此前收到的凭据从不进入登录状态或公开回包。
    const collected = qr.pendingCookie;
    qr.pendingCookie = "";
    reportPoll("confirmed", { ...loginUrlShape(result.data.url), ...headerProbe, sessionCookieInResponse: Boolean(headerCookie),
      sessionCookieFromEarlierPoll: Boolean(collected && !headerCookie) });
    const candidate = collected || await cookieFromLoginUrl(result.data.url);
    if (!live(qr) || generation !== before) return expiredQr();
    if (!candidate) {
      reportPoll("credential-unavailable");
      qr.key = "";
      qr.terminal = failure("未能取得有效登录凭据，请重新扫码");
      return { ...qr.terminal };
    }
    const next = await checkNav(candidate);
    if (!live(qr) || generation !== before) return expiredQr();
    if (next !== "loggedIn") {
      reportPoll("nav-rejected", { loginStatus: next });
      qr.key = "";
      qr.terminal = failure(next === "expired" ? "登录凭据无效，请重新扫码" : "暂时无法验证登录，请重新扫码");
      return { ...qr.terminal };
    }
    const committedGeneration = commit(candidate, qr);
    await persistCredential(candidate, committedGeneration);
    const resultSnapshot = snapshot();
    const loginResult = { ok: true, ...resultSnapshot };
    if (generation === committedGeneration && cookie === candidate && activeQr?.id === qr.id) activeQr.terminal = loginResult;
    reportPoll("logged-in", { storage: loginResult.storage });
    return loginResult;
  }

  async function poll(id) {
    const qr = activeQr;
    if (!qr || typeof id !== "string" || id !== qr.id) return expiredQr();
    if (qr.terminal) return { ...qr.terminal };
    if (Date.now() >= qr.expiresAt) return expire(qr);
    if (qr.flight) return { ...await qr.flight };
    if (Date.now() - qr.lastPollAt < POLL_GAP_MS) return { ...qr.lastResult };
    qr.lastPollAt = Date.now();
    const work = performPoll(qr);
    qr.flight = work;
    try {
      const result = await work;
      qr.lastResult = result;
      return { ...result };
    } finally { if (qr.flight === work) qr.flight = null; }
  }

  return { status, getCookie, start, poll, loginToken };
}
