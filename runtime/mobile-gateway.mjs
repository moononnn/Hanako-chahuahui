/**
 * 茶话会 · 手机网关（独立进程）
 *
 * 为什么单独起进程：Hana 的应用子进程跑在 Node 权限模型里，监听端口会被
 * ERR_ACCESS_DENIED(Net) 直接挡掉。这个进程由茶话会 spawn，不受那层限制，
 * 自己占一个局域网端口，手机浏览器直接连进来。
 *
 * 协议：stdin 收 { id, op, payload }，stdout 回 { id, ok, data|error }。
 * 日志一律走 stderr，stdout 只留给协议，别污染。
 *
 * 几条定死的规矩（手机连的是局域网，别当它是自家页面）：
 *   - 读走 GET，写只走 POST；GET 到写操作直接 405，连宿主都不问。
 *   - op 只认 MOBILE_OPS 这张表，不做任意转发。
 *   - 写操作只认 Authorization: Bearer；cookie 只给 img/media/SSE 用。
 *   - Origin 存在就得跟 Host 同源，Sec-Fetch-Site: cross-site 一律拒。
 *   - 没设密码就根本不开门（不启动、不解锁），不存在「免密放行」。
 *   - token 有 TTL、会话有上限；解锁失败按 IP 节流，且有全局上限。
 *
 * 这个文件既能当 CLI 跑，也能被测试 import 成只监听 127.0.0.1:0 的隔离实例：
 * 只有「直接执行」时才读 env、开 stdio、监听端口。
 */

import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
  // token：默认 8 小时，最多同时留 8 条会话（多了踢最旧的）
  tokenTtlMs: 8 * 60 * 60 * 1000,
  maxTokens: 8,
  // body：普通 JSON 半兆，带图的那条按附件上限放宽；解锁只要一个小口令
  jsonBytes: 512 * 1024,
  uploadBytes: 16 * 1024 * 1024,
  unlockBytes: 4 * 1024,
  // 附件本体（base64 解码后）的上限：与手机页、宿主那一套对齐
  attachmentBytes: 10 * 1024 * 1024,
  // 并发
  maxConcurrent: 64,
  maxSse: 12,
  maxSsePerIp: 3,
  sseHeartbeatMs: 20000,
  // 二进制缓存
  cacheTtlMs: 60 * 60 * 1000,
  cacheMaxEntries: 64,
  cacheMaxBytes: 16 * 1024 * 1024,
  // 解锁节流：一个 IP 十分钟内错 8 次就歇着；全局十分钟最多 200 次失败
  unlockWindowMs: 10 * 60 * 1000,
  unlockMaxFails: 8,
  unlockGlobalMaxFails: 200,
  unlockMapMax: 1000,
  callTimeoutMs: 20000,
  // 宿主没了就别自己吊着：收不到 PING 超过这个时长就退
  pingTimeoutMs: 60000,
});

// 手机页能用的全部 op。这张表是唯一边界：不在这里的路径一律 404。
// 读：名单/一页记录/图库清单/回合状态/收藏/待办。
// 写（只限鉴权后的 POST）：发一条、标记已读、语音已听、投喂、收藏开关、
// 撤回/改稿/重生成/删除、取消收藏、拇一下、待办确认/先不用。
// 图库管理（来源/分组/导入/移除）、管理面（开关、密码、配置）、设置页、任意文件访问都不在这张表里。
export const MOBILE_OPS = Object.freeze({
  "partners.list": "read",
  "thread.get": "read",
  "stickers.list": "read",
  "turn.get": "read",
  "favorites.list": "read",
  "todos.list": "read",
  "turn.send": "write",
  "thread.read": "write",
  "voice.played": "write",
  "message.feed": "write",
  "message.favorite": "write",
  "message.retract": "write",
  "message.edit": "write",
  "message.regenerate": "write",
  "message.delete": "write",
  "favorite.remove": "write",
  "action.send": "write",
  "todos.confirm": "write",
  "todos.dismiss": "write",
});

// 只有这条会带图（base64），按附件上限收；别的都按普通 JSON 卡。
const UPLOAD_OPS = new Set(["turn.send"]);

// 有几条本来就要等模型/重建，按 op 单独给预算：不为了它们把全局超时放宽，
// 免得其他小请求出事也磨着不走。
const OP_TIMEOUT_MS = Object.freeze({
  "message.regenerate": 180_000,
  "message.delete": 120_000,
});

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const ASSET_EXT = new Set(Object.keys(MIME));

/** base64 解码后的字节数：只算长度，不真解码（16MiB 正文没必要多拓一份内存）。 */
function base64DecodedBytes(text) {
  const value = String(text || "").replace(/\s+/g, "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

const PLACEHOLDER = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>茶话会</title></head><body style="font-family:system-ui;padding:24px">网页还没备好，网关这边已经通了。</body></html>`;

// ─────────────────────────── 小工具 ───────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function json(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) {
    try { res.end(); } catch { /* 已经发完了 */ }
    return;
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function fail(status, code, message, headers) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.headers = headers || {};
  return error;
}

/** 带条目数/字节数上限的极简缓存，够放头像表情包和附件缩略图。 */
function createByteCache({ ttlMs, maxEntries, maxBytes, now }) {
  const rows = new Map();
  let bytes = 0;
  return {
    get(key) {
      const hit = rows.get(key);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        rows.delete(key);
        bytes -= hit.buf.length;
        return null;
      }
      // 摸一下就算用过：挪到队尾，LRU 淘汰时先扔最久没碰的
      rows.delete(key);
      rows.set(key, hit);
      return hit;
    },
    set(key, buf, type) {
      const old = rows.get(key);
      if (old) {
        rows.delete(key);
        bytes -= old.buf.length;
      }
      rows.set(key, { buf, type, at: now() });
      bytes += buf.length;
      while (rows.size > maxEntries || bytes > maxBytes) {
        const first = rows.keys().next();
        if (first.done) break;
        const victim = rows.get(first.value);
        rows.delete(first.value);
        bytes -= victim?.buf?.length ?? 0;
      }
    },
    clear() {
      rows.clear();
      bytes = 0;
    },
    get size() {
      return rows.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

// ─────────────────────────── 工厂 ───────────────────────────

/**
 * @param {object} options
 * @param {string} options.password 手机会话的密码；空字符串＝不开门
 * @param {number} [options.port] 默认端口（listen 时可覆盖）
 * @param {string} [options.host] 默认监听地址
 * @param {(op: string, payload: object, timeoutMs?: number) => Promise<any>} options.callApp 转给宿主
 * @param {() => number} [options.now] 可注入的时钟（测试用）
 * @param {object} [options.limits] 覆盖 DEFAULT_LIMITS
 * @param {string} [options.assetDir] 静态资源目录（仅日志/文档用）
 * @param {(...args: any[]) => void} [options.log]
 */
export function createMobileGateway(options = {}) {
  const password = String(options.password ?? "");
  const defaultPort = Number.isFinite(Number(options.port)) ? Number(options.port) : 18090;
  const defaultHost = String(options.host || "0.0.0.0");
  const assetDir = String(options.assetDir || "");
  const callApp = typeof options.callApp === "function" ? options.callApp : async () => { throw new Error("no_app"); };
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };

  const tokens = new Map();
  const sseClients = new Set();
  const unlockFails = new Map();
  let unlockGlobal = { at: now(), count: 0 };
  let inflight = 0;
  let sweepTimer = null;
  let closed = false;
  let listening = false;

  const avatarCache = createByteCache({ ttlMs: limits.cacheTtlMs, maxEntries: limits.cacheMaxEntries, maxBytes: limits.cacheMaxBytes, now });
  const stickerCache = createByteCache({ ttlMs: limits.cacheTtlMs, maxEntries: limits.cacheMaxEntries, maxBytes: limits.cacheMaxBytes, now });
  // 附件故意不缓存：撤回/删除只在宿主管，网关存一份就成了绕过那边校验的后门。

  // ── token ──

  function pruneTokens() {
    const stamp = now();
    for (const [token, row] of tokens) if (row.expiresAt <= stamp) tokens.delete(token);
  }

  function issueToken() {
    const stamp = now();
    const token = randomUUID();
    tokens.set(token, { at: stamp, expiresAt: stamp + limits.tokenTtlMs });
    while (tokens.size > limits.maxTokens) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, row] of tokens) {
        if (row.at < oldestAt) {
          oldestAt = row.at;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      tokens.delete(oldestKey);
    }
    return token;
  }

  function tokenValid(token) {
    // 没密码就是没开门：不给任何 token 开后门（哪怕它是我们自己发的）
    if (!password) return false;
    const value = String(token || "");
    if (!value) return false;
    const row = tokens.get(value);
    if (!row) return false;
    if (row.expiresAt <= now()) {
      tokens.delete(value);
      return false;
    }
    return true;
  }

  // ── 鉴权取值：写操作只认 Bearer；cookie 是给 <img>/media/SSE 的 ──

  function bearerToken(req) {
    const auth = String(req.headers?.authorization || "");
    const match = auth.match(/^Bearer[ ]+(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function cookieToken(req) {
    const raw = String(req.headers?.cookie || "");
    for (const part of raw.split(";")) {
      const text = part.trim();
      if (!text.startsWith("ch_mobile=")) continue;
      try {
        return decodeURIComponent(text.slice("ch_mobile=".length)).trim();
      } catch {
        return "";
      }
    }
    return "";
  }

  const authedByBearer = (req) => tokenValid(bearerToken(req));
  const authedForMedia = (req) => authedByBearer(req) || tokenValid(cookieToken(req));

  /**
   * 改东西的请求得是自家页面发起的：Origin 有就必须跟 Host 同源，
   * 带上 Sec-Fetch-Site: cross-site 的直接拒（两个都考，别指望浏览器一定给 Origin）。
   */
  function sameOriginOk(req) {
    const site = String(req.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
    if (site === "cross-site") return false;
    const origin = String(req.headers?.origin || "").trim();
    if (!origin) return true;
    if (origin === "null") return false;
    const hostHeader = String(req.headers?.host || "").trim().toLowerCase();
    if (!hostHeader) return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    // 这个网关只有 http：协议也得对上（https:// 同 host 不算同源），
    // 不看 X-Forwarded-Proto 之类可被伪造的头。
    if (parsed.protocol !== "http:") return false;
    return parsed.origin.toLowerCase() === `http://${hostHeader}`;
  }

  function clientIp(req) {
    // 不用 X-Forwarded-For：局域网直连，谁写的头都不算数
    return String(req.socket?.remoteAddress || "").trim();
  }

  // ── 解锁节流 ──

  function unlockWaitSeconds(ip) {
    const stamp = now();
    const row = unlockFails.get(ip);
    if (row && stamp - row.at >= limits.unlockWindowMs) unlockFails.delete(ip);
    else if (row && row.count >= limits.unlockMaxFails) {
      return Math.max(1, Math.ceil((row.at + limits.unlockWindowMs - stamp) / 1000));
    }
    if (stamp - unlockGlobal.at >= limits.unlockWindowMs) unlockGlobal = { at: stamp, count: 0 };
    if (unlockGlobal.count >= limits.unlockGlobalMaxFails) {
      return Math.max(1, Math.ceil((unlockGlobal.at + limits.unlockWindowMs - stamp) / 1000));
    }
    return 0;
  }

  function pruneUnlockFails() {
    const stamp = now();
    for (const [ip, row] of unlockFails) {
      if (stamp - row.at >= limits.unlockWindowMs) unlockFails.delete(ip);
    }
    // 还是太多就按时间从旧到新扔，绝不让这张表无界长
    if (unlockFails.size > limits.unlockMapMax) {
      const ordered = [...unlockFails.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [ip] of ordered) {
        if (unlockFails.size <= limits.unlockMapMax) break;
        unlockFails.delete(ip);
      }
    }
  }

  function noteUnlockFailure(ip) {
    const stamp = now();
    const row = unlockFails.get(ip);
    if (!row || stamp - row.at >= limits.unlockWindowMs) unlockFails.set(ip, { at: stamp, count: 1 });
    else row.count += 1;
    if (stamp - unlockGlobal.at >= limits.unlockWindowMs) unlockGlobal = { at: stamp, count: 1 };
    else unlockGlobal.count += 1;
    pruneUnlockFails();
  }

  // ── body ──

  async function readBody(req, limit) {
    // 声明值明显离谱（超过四倍）就没必要再收了，直接关连接回 413；
    // 只是超一点点的还是读完再拒，别让客户端还在发的时候被掐断看不到回复。
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit * 4) {
      throw fail(413, "body_too_large", "发的东西太大了", { connection: "close" });
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (overflow) {
        // 已经超了：不再攒，但也别把连接直接掐了，先把剩下的读完再回 413。
        if (size > limit * 4) throw fail(413, "body_too_large", "发的东西太大了", { connection: "close" });
        continue;
      }
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (overflow) throw fail(413, "body_too_large", "发的东西太大了");
    return Buffer.concat(chunks);
  }

  async function readJsonBody(req, limit) {
    const type = String(req.headers?.["content-type"] || "").toLowerCase();
    if (!type.startsWith("application/json")) {
      throw fail(415, "unsupported_media_type", "只收 application/json");
    }
    const buf = await readBody(req, limit);
    const text = buf.toString("utf8").trim();
    if (!text) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail(400, "invalid_json", "JSON 不合法");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw fail(400, "invalid_json", "JSON 不合法");
    }
    return parsed;
  }

  // ── SSE 广播 ──

  function broadcast(event) {
    if (!sseClients.size) return 0;
    const payload = `data: ${JSON.stringify(event ?? {})}\n\n`;
    let sent = 0;
    for (const client of [...sseClients]) {
      try {
        client.res.write(payload);
        sent += 1;
      } catch {
        clearInterval(client.beat);
        sseClients.delete(client);
        try { client.res.end(); } catch { /* 已经断了 */ }
      }
    }
    return sent;
  }

  // ── 处理器 ──

  async function servePage(res) {
    let html = "";
    try {
      html = await callApp("mobile.page.index", {}, limits.callTimeoutMs);
    } catch {
      html = "";
    }
    const text = typeof html === "string" && html ? html : PLACEHOLDER;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  }

  async function serveAsset(res, name) {
    // 资源名只放行「字母数字开头 + 允许的扩展名」，别的一律当不存在
    const ext = path.posix.extname(name).toLowerCase();
    if (!ASSET_EXT.has(ext) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
      return json(res, 404, { ok: false, error: { message: "没有这个资源" } });
    }
    try {
      // 网关进程要读的静态文件交给茶话会那边读（它有 app/resources.read），再当二进制吐出来。
      const data = await callApp("mobile.asset", { name }, limits.callTimeoutMs);
      const buf = Buffer.from(String(data?.base64 || ""), "base64");
      if (!buf.length) throw new Error("empty");
      res.writeHead(200, {
        "content-type": MIME[ext] || data?.type || "application/octet-stream",
        // 不缓存：手机页会跟着应用升级，别让手机拿着上一版脚本跑
        "cache-control": "no-store",
        "content-length": buf.length,
        "x-content-type-options": "nosniff",
      });
      res.end(buf);
    } catch {
      json(res, 404, { ok: false, error: { message: "没有这个资源" } });
    }
  }

  async function serveBytes(res, { op, payload, cache, cacheKey, fallbackType, cacheControl, missMessage, status = 404 }) {
    try {
      let hit = cache && cacheKey ? cache.get(cacheKey) : null;
      if (!hit) {
        const data = await callApp(op, payload, limits.callTimeoutMs);
        const buf = Buffer.from(String(data?.base64 || ""), "base64");
        if (!buf.length) throw new Error("empty");
        hit = { buf, type: data?.type || fallbackType, at: now() };
        if (cache && cacheKey) cache.set(cacheKey, buf, hit.type);
      }
      res.writeHead(200, {
        "content-type": hit.type || fallbackType,
        "cache-control": cacheControl,
        "content-length": hit.buf.length,
        "x-content-type-options": "nosniff",
      });
      res.end(hit.buf);
    } catch (error) {
      if (error?.code === "app_timeout") {
        return json(res, 504, { ok: false, error: { code: "app_timeout", message: "宿主没回信" } });
      }
      json(res, status, { ok: false, error: { message: missMessage } });
    }
  }

  async function handleApi(req, res, url, op) {
    const kind = MOBILE_OPS[op];
    if (!kind) return json(res, 404, { ok: false, error: { code: "unknown_op", message: "没有这个门" } });
    const method = String(req.method || "GET").toUpperCase();
    if (kind === "write" && method !== "POST") {
      return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "这条得 POST" } }, { allow: "POST" });
    }
    if (kind === "read" && method !== "GET") {
      return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "这条得 GET" } }, { allow: "GET" });
    }
    // 读也认 Bearer：cookie 只服务图片和长连接，做不了 API 的门票
    if (!authedByBearer(req)) {
      return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
    }
    if (kind === "write" && !sameOriginOk(req)) {
      return json(res, 403, { ok: false, error: { code: "cross_origin", message: "跨站的改不了" } });
    }
    const payload = kind === "read"
      ? Object.fromEntries(url.searchParams)
      : await readJsonBody(req, UPLOAD_OPS.has(op) ? limits.uploadBytes : limits.jsonBytes);
    if (op === "turn.send") {
      // 图片本体按解码后的尺寸卡（base64 只算长度），别让一张 20MiB 的图混进来
      const image = payload?.image && typeof payload.image === "object" ? payload.image : null;
      if (base64DecodedBytes(image?.data) > limits.attachmentBytes) {
        return json(res, 413, { ok: false, error: { code: "attachment_too_large", message: "图片太大了" } });
      }
    }
    let data;
    try {
      // 长活单独给预算：全链路就这一层超时，宿主那边不另设一道
      const budget = OP_TIMEOUT_MS[op] ?? limits.callTimeoutMs;
      data = await callApp(`mobile.${op}`, payload, budget);
    } catch (error) {
      const message = String(error?.message || error);
      log(`宿主调用失败 ${op}: ${message}`);
      const status = message === "app_timeout" ? 504 : 502;
      return json(res, status, { ok: false, error: { code: "app_error", message } });
    }
    return json(res, 200, { ok: true, data: data ?? null });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = String(req.method || "GET").toUpperCase();

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return servePage(res);
    }

    if (method === "GET" && pathname === "/healthz") {
      return json(res, 200, { ok: true, ready: true, auth: Boolean(password) });
    }

    if (pathname.startsWith("/assets/")) {
      if (method !== "GET") {
        return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "资源只给 GET" } }, { allow: "GET" });
      }
      return serveAsset(res, pathname.slice("/assets/".length));
    }

    if (pathname === "/api/unlock") {
      if (method !== "POST") {
        return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "解锁得 POST" } }, { allow: "POST" });
      }
      // 没设密码就不存在「输对了」这回事，门都不该开
      if (!password) {
        return json(res, 503, { ok: false, error: { code: "no_password", message: "这台没设密码，门打不开" } });
      }
      if (!sameOriginOk(req)) {
        return json(res, 403, { ok: false, error: { code: "cross_origin", message: "跨站的解不了锁" } });
      }
      const ip = clientIp(req);
      const wait = unlockWaitSeconds(ip);
      if (wait > 0) {
        return json(res, 429, { ok: false, error: { code: "too_many_attempts", message: "试太多次了，过会儿再来" } }, { "retry-after": String(wait) });
      }
      const payload = await readJsonBody(req, limits.unlockBytes);
      const submitted = typeof payload.password === "string" ? payload.password : "";
      if (!safeEqual(submitted, password)) {
        noteUnlockFailure(ip);
        return json(res, 401, { ok: false, error: { code: "bad_password", message: "密码不对" } });
      }
      unlockFails.delete(ip);
      const token = issueToken();
      // cookie 只为了 <link>/<img>/EventSource 这种带不了头的地方：
      // HttpOnly 让脚本拿不到，SameSite=Strict 让它不跟着跨站请求出去。
      res.setHeader("set-cookie", `ch_mobile=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(limits.tokenTtlMs / 1000))}`);
      return json(res, 200, { ok: true, token, expiresIn: Math.max(1, Math.floor(limits.tokenTtlMs / 1000)) });
    }

    const apiMatch = pathname.match(/^\/api\/(.+)$/);
    if (apiMatch) {
      let op = "";
      try {
        op = decodeURIComponent(apiMatch[1]).replace(/\//g, ".");
      } catch {
        return json(res, 400, { ok: false, error: { code: "bad_path", message: "路径看不懂" } });
      }
      return handleApi(req, res, url, op);
    }

    if (pathname === "/events") {
      if (method !== "GET") {
        return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "长连接只给 GET" } }, { allow: "GET" });
      }
      const bearer = bearerToken(req);
      const viaBearer = tokenValid(bearer);
      const cookie = viaBearer ? "" : cookieToken(req);
      if (!viaBearer && !tokenValid(cookie)) {
        return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      }
      const ip = clientIp(req);
      let sameIp = 0;
      for (const client of sseClients) if (client.ip === ip) sameIp += 1;
      if (sseClients.size >= limits.maxSse || sameIp >= limits.maxSsePerIp) {
        return json(res, 429, { ok: false, error: { code: "too_many_streams", message: "长连接开太多了" } }, { "retry-after": "30" });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      res.write(`data: ${JSON.stringify({ type: "hello", at: now() })}\n\n`);
      const client = { res, ip, token: viaBearer ? bearer : cookie, beat: null };
      sseClients.add(client);
      const drop = () => {
        clearInterval(client.beat);
        sseClients.delete(client);
      };
      // 心跳顺便当 token 的看门狗：token 过期了就把这条长连接收掉
      client.beat = setInterval(() => {
        if (!tokenValid(client.token)) {
          try { res.write(`event: expired\ndata: ${JSON.stringify({ type: "expired" })}\n\n`); } catch { /* 已经断了 */ }
          try { res.end(); } catch { /* 已经断了 */ }
          drop();
          return;
        }
        try {
          res.write(": ping\n\n");
        } catch {
          drop();
        }
      }, limits.sseHeartbeatMs);
      client.beat.unref?.();
      res.on("close", drop);
      log(`SSE 接入 ${ip}，当前 ${sseClients.size} 条`);
      return;
    }

    if (pathname === "/avatar") {
      if (method !== "GET") return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "图只给 GET" } }, { allow: "GET" });
      if (!authedForMedia(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      const agentId = String(url.searchParams.get("agentId") || "").trim();
      if (!agentId) return json(res, 400, { ok: false, error: { message: "没说是谁" } });
      return serveBytes(res, {
        op: "mobile.avatar",
        payload: { agentId },
        cache: avatarCache,
        cacheKey: agentId,
        fallbackType: "image/png",
        cacheControl: "private, max-age=300",
        missMessage: "没头像",
      });
    }

    if (pathname === "/bg") {
      if (method !== "GET") return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "图只给 GET" } }, { allow: "GET" });
      if (!authedForMedia(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      const agentId = String(url.searchParams.get("agentId") || "").trim();
      if (!agentId) return json(res, 400, { ok: false, error: { message: "没说是谁" } });
      return serveBytes(res, {
        op: "mobile.background.bytes",
        payload: { agentId },
        cache: null,
        cacheKey: "",
        fallbackType: "image/png",
        cacheControl: "no-store",
        missMessage: "这间房没背景",
      });
    }

    if (pathname === "/voice") {
      if (method !== "GET") return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "语音只给 GET" } }, { allow: "GET" });
      if (!authedForMedia(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      const agentId = String(url.searchParams.get("agentId") || "").trim();
      const messageId = String(url.searchParams.get("messageId") || "").trim();
      if (!agentId || !messageId) return json(res, 400, { ok: false, error: { message: "参数不对" } });
      return serveBytes(res, {
        op: "mobile.voice",
        payload: { agentId, messageId },
        cache: null,
        cacheKey: "",
        fallbackType: "audio/mpeg",
        // 撤回/删掉之后不该还能从缓存里翻出来放
        cacheControl: "no-store",
        missMessage: "这条语音还没准备好",
      });
    }

    if (pathname === "/sticker") {
      if (method !== "GET") return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "图只给 GET" } }, { allow: "GET" });
      if (!authedForMedia(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      const agentId = String(url.searchParams.get("agentId") || "").trim();
      const id = String(url.searchParams.get("id") || "").trim();
      if (!agentId || !id) return json(res, 400, { ok: false, error: { message: "参数不对" } });
      return serveBytes(res, {
        op: "mobile.sticker",
        payload: { agentId, id },
        cache: stickerCache,
        cacheKey: `${agentId}:${id}`,
        fallbackType: "image/png",
        cacheControl: "private, max-age=3600",
        missMessage: "没这张图",
      });
    }

    if (pathname === "/attachment") {
      if (method !== "GET") return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "图只给 GET" } }, { allow: "GET" });
      if (!authedForMedia(req)) return json(res, 401, { ok: false, error: { code: "unauthorized", message: "先解锁" } });
      const agentId = String(url.searchParams.get("agentId") || "").trim();
      const attachmentId = String(url.searchParams.get("attachmentId") || url.searchParams.get("id") || "").trim();
      if (!agentId || !attachmentId) return json(res, 400, { ok: false, error: { message: "参数不对" } });
      return serveBytes(res, {
        op: "mobile.attachment",
        payload: { agentId, attachmentId },
        // 不做网关缓存：图能不能给是宿主说了算（撤回/删除后必须立刻拿不到）
        cache: null,
        cacheKey: "",
        fallbackType: "image/jpeg",
        cacheControl: "no-store",
        missMessage: "这张图不在了",
      });
    }

    return json(res, 404, { ok: false, error: { code: "not_found", message: "没有这个门" } });
  }

  const server = http.createServer((req, res) => {
    if (inflight >= limits.maxConcurrent) {
      return json(res, 429, { ok: false, error: { code: "busy", message: "太挤了，等一下" } }, { "retry-after": "5" });
    }
    inflight += 1;
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      inflight = Math.max(0, inflight - 1);
    };
    res.on("close", release);
    void handle(req, res).catch((error) => {
      const status = Number(error?.status) || 500;
      if (status === 500) log(`处理请求出错: ${error?.message ?? error}`);
      try {
        json(res, status, { ok: false, error: { code: error?.code || "internal", message: error?.message || "网关内部出错" } }, error?.headers || {});
      } catch {
        try { res.end(); } catch { /* 连接已经没了 */ }
      }
    });
  });

  // 定期清过期 token / 节流记录，别让它们慢慢长成垃圾堆
  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      pruneTokens();
      pruneUnlockFails();
    }, 60 * 1000);
    sweepTimer.unref?.();
  }

  return {
    server,
    limits,
    get password() {
      return password;
    },
    get assetDir() {
      return assetDir;
    },
    listen({ host = defaultHost, port = defaultPort } = {}) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          listening = false;
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          listening = true;
          startSweep();
          const address = server.address();
          resolve({ host, port: typeof address === "object" && address ? address.port : port });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    broadcast,
    async close() {
      closed = true;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const client of [...sseClients]) {
        clearInterval(client.beat);
        try { client.res.end(); } catch { /* 已经断了 */ }
      }
      sseClients.clear();
      avatarCache.clear();
      stickerCache.clear();
      tokens.clear();
      unlockFails.clear();
      if (!listening) return;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      listening = false;
    },
    get closed() {
      return closed;
    },
    state() {
      return {
        listening,
        sse: sseClients.size,
        tokens: tokens.size,
        inflight,
        caches: { avatar: avatarCache.size, sticker: stickerCache.size },
      };
    },
  };
}

// ─────────────────────────── CLI ───────────────────────────

/** stdin/stdout 那条 JSON 行协议，只有 CLI 模式用得上。 */
function createStdioBridge({ port }) {
  const pending = new Map();
  let seq = 0;
  const write = (row) => {
    try {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    } catch {
      // stdout 没了，进程也该走了
    }
  };
  const callApp = (op, payload, timeoutMs = 20000) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("app_timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ id, op, payload });
    });
  };
  return { callApp, pending, write, get seq() { return seq; } };
}

function runCli() {
  const log = (...args) => process.stderr.write(`[mobile-gateway] ${args.join(" ")}\n`);
  const password = String(process.env.CH_MOBILE_PASSWORD || "");
  // 允许 0（随机端口）：调试和冒烟用，正式配置里还是固定端口
  const portRaw = Number(process.env.CH_MOBILE_PORT ?? 18090);
  const port = Number.isFinite(portRaw) && portRaw >= 0 ? portRaw : 18090;
  const host = String(process.env.CH_MOBILE_HOST || "0.0.0.0");
  const assetDir = String(process.env.CH_MOBILE_ASSETS || "");

  // 没密码就不启动：宁可手机连不上，也不要给局域网开一扇裸门。
  if (!password) {
    log("没有密码，拒绝启动");
    process.exit(2);
  }

  const bridge = createStdioBridge({ port });
  const gateway = createMobileGateway({
    password,
    port,
    host,
    assetDir,
    callApp: bridge.callApp,
    log,
  });

  let listenPort = null;
  let lastPingAt = 0;
  const pingTimeoutRaw = Number(process.env.CH_MOBILE_PING_TIMEOUT_MS);
  const pingTimeoutMs = Number.isFinite(pingTimeoutRaw) && pingTimeoutRaw > 0 ? pingTimeoutRaw : DEFAULT_LIMITS.pingTimeoutMs;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    if (text === "PING") {
      // 宿主还活着。没监听完之前不谎报 listening，免得那边当成就绪了。
      lastPingAt = Date.now();
      bridge.write({ id: 0, ok: true, data: { pong: true, listening: listenPort !== null, port: listenPort ?? port } });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log("收到无法解析的行，丢掉");
      return;
    }
    if (msg?.type === "shutdown") {
      log("收到 shutdown，退出");
      void gateway.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
      return;
    }
    // 宿主往这里推东西：茶话会那头有变化了，广播给所有页面。
    if (msg?.type === "push") {
      gateway.broadcast(msg.event ?? {});
      return;
    }
    const slot = bridge.pending.get(msg?.id);
    if (!slot) return;
    bridge.pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.ok) slot.resolve(msg.data);
    else slot.reject(new Error(msg.error || "app_error"));
  });

  rl.on("close", () => {
    log("stdin 关闭，宿主没了，退出");
    void gateway.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });

  gateway.listen({ host, port }).then(({ port: actual }) => {
    listenPort = actual;
    log(`listening ${host}:${actual} pid=${process.pid}`);
    bridge.write({ id: 0, ok: true, data: { listening: true, port: actual, pid: process.pid } });
    // 宿主心跳看门狗：宿主正常会定期 PING；断了就自己退，不留个占端口的孤儿。
    const watchdog = setInterval(() => {
      // 宿主一次都没 PING 过就不拿它当判据（手工起 CLI 调试用）
      if (!lastPingAt) return;
      if (Date.now() - lastPingAt <= pingTimeoutMs) return;
      log(`宿主 ${pingTimeoutMs}ms 没来心跳，退出`);
      clearInterval(watchdog);
      void gateway.close().finally(() => process.exit(4));
      setTimeout(() => process.exit(4), 500).unref();
    }, Math.max(1000, Math.floor(pingTimeoutMs / 4)));
    watchdog.unref?.();
  }).catch((error) => {
    log(`监听失败 ${error?.code ?? error?.message}`);
    process.exit(3);
  });
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(path.resolve(arg)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) runCli();
