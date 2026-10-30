/**
 * 手机页 · 隔离浏览器夹具（只给主代理做真实 DOM/视觉检查用）
 *
 * 边界：只起一个 127.0.0.1 临时 http 服务，把现有 ui/mobile.html + ui/assets 发出去；
 * 数据全是写死的假消息，不读 app-data、不连 gateway、不调模型、不落盘。
 * 接口只保证「页面装得起来、点得动」，不是后端权限/校验的证明。
 *
 * 用法：
 *   node tests/mobile-browser-fixture.mjs        → stdout 打印 ready <url>
 *   import { createFixtureServer } from "./tests/mobile-browser-fixture.mjs"
 *   const fx = await createFixtureServer(); … fx.url … await fx.close()
 *
 * 页面一打开就是登录态：发 mobile.html 时插一段脚本预置假 token（真文件不动）。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(here, "..", "ui");
const TOKEN = "fixture-token-not-a-real-credential";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const at = (minute) => new Date(Date.UTC(2026, 9, 30, 4, minute)).toISOString();
// 原生 <img src> / EventSource 带不了 Authorization，真网关靠 cookie；夹具同样只给媒体用一枚
const FIXTURE_COOKIE = `ch_mobile=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`;
const cookieToken = (req) => {
  const raw = String(req.headers.cookie ?? "");
  const hit = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith("ch_mobile="));
  if (!hit) return "";
  try { return decodeURIComponent(hit.slice("ch_mobile=".length)); } catch { return ""; }
};

// ── 假数据：多气泡 / 自己图文 / 语音 / https 链接 / 引用 / 撤回 / 戳 / 未读 ──
const seedThreads = () => ({
  nova: [
    { id: "n1", seq: 1, role: "user", text: "我回来啦，今天累死", at: at(1) },
    { id: "n2", seq: 2, role: "assistant", bubbles: ["先坐下歇会儿。", "桌上那杯还温着，喝完再说别的。"], text: "先坐下歇会儿。\n桌上那杯还温着，喝完再说别的。", at: at(2) },
    { id: "n3", seq: 3, role: "assistant", text: "顺手给你留了个链接：https://example.com/hanako-fixture 周末可以去看看。", at: at(3) },
    { id: "n4", seq: 4, role: "user", text: "看这个", attachment: { id: "att-fixture", name: "fixture-photo.svg", mimeType: "image/svg+xml", size: 640 }, at: at(4) },
    { id: "n5", seq: 5, role: "assistant", text: "", voice: { status: "ready", durationMs: 5000, text: "这条是夹具语音，五秒静音，专门用来看播放会不会被已播时间刷新掐断。", playedAt: null }, at: at(5) },
    { id: "n6", seq: 6, role: "assistant", text: "图收到了，窗边的光挺好看的。", quote: { messageId: "n4", text: "看这个" }, at: at(6) },
    { id: "n7", seq: 7, role: "user", recalled: true, recallMode: "hard", text: "（撤回）", at: at(7) },
    { id: "n8", seq: 8, role: "assistant", kind: "poke", text: "戳了戳你", at: at(8) },
  ],
  xiaoman: [
    { id: "x1", seq: 1, role: "user", text: "小满，在吗", at: at(11) },
    { id: "x2", seq: 2, role: "assistant", text: "在。今天这边没铺背景，正好跟 nova 那间对照着看。", at: at(12) },
    { id: "x3", seq: 3, role: "assistant", text: "还没读的一条，列表上应该有个红点。", at: at(13) },
  ],
});

const seedState = () => ({
  threads: seedThreads(),
  read: new Map(),
  stickers: [
    { id: "stk-fixture-1", groupIds: ["grp-1"], emotion: ["开心"], description: "夹具表情一", source: "own" },
    { id: "stk-fixture-2", groupIds: [], emotion: ["困"], description: "夹具表情二", source: "own" },
  ],
  groups: [{ id: "grp-1", name: "夹具分组" }],
});

// ── 媒体：极小 SVG + 五秒静音 WAV ──
const svgBytes = (label, from, to, width = 320, height = 320) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`
  + `<rect width="${width}" height="${height}" fill="url(#g)"/>`
  + `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="system-ui" font-size="20" fill="#fffdf8">${label}</text></svg>`,
);

function silentWav(seconds = 5, rate = 8000) {
  const frames = seconds * rate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(frames * 2, 40);
  return buf; // 全 0 = 静音
}

const VOICE_WAV = silentWav(5);
const AVATARS = { nova: svgBytes("nova", "#8fbfa8", "#4f8a70"), xiaoman: svgBytes("满", "#e6c9a8", "#b98a5e") };
// 夹具用的徽章样本：一个是“在线”、一个“睡着了”，形状跟宿主投影一致（没有内部字段）
const FIXTURE_BADGES = {
  nova: { type: "common", id: "online", label: "在线", description: "正在这里，手边有手机。" },
  xiaoman: { type: "common", id: "sleeping", label: "睡着了", description: "正在睡觉，回复会慢一些。" },
};
const STICKER_SVG = svgBytes("fixture", "#f3d9b1", "#c98f5a");
const ATTACHMENT_SVG = svgBytes("fixture photo", "#cfe3f5", "#6f9dc0", 480, 320);
const BACKGROUND_SVG = svgBytes("fixture background", "#f6d9c3", "#8fb3a1", 720, 1280);

// ── 假 API ──
const threadPage = (state, agentId, limit, before) => {
  const all = state.threads[agentId] ?? [];
  const scoped = Number(before) > 0 ? all.filter((row) => row.seq < Number(before)) : all;
  const size = Number(limit) > 0 ? Math.min(Number(limit), 200) : scoped.length;
  const page = scoped.slice(-size);
  // 跟宿主 mobileMessage 对齐的最小字段：撤回的不能撤，自己能撤的给 canRecall
  const project = (row) => {
    const base = { ...row, canRecall: row.role === "user" && !row.recalled };
    if (!base.voice) return base;
    return { ...base, voice: { ...base.voice, playedAt: state.read.get(row.id) ?? base.voice.playedAt ?? null } };
  };
  return {
    agentId,
    meSkin: null,
    taSkin: null,
    showAvatars: true,
    background: agentId === "nova" ? { file: "fixture-bg.svg", type: "image/svg+xml", at: "2026-10-30T04:00:00.000Z", opacity: 52, tone: "medium" } : null,
    messageRefine: true,
    needsOnboarding: false,
    badge: FIXTURE_BADGES[agentId] ?? null,
    latestAssistantId: [...all].reverse().find((row) => row.role === "assistant" && !row.recalled)?.id ?? null,
    messages: page.map(project),
    total: all.length,
    hasMore: scoped.length > page.length,
  };
};

function partners(state) {
  const last = (agentId) => {
    const rows = state.threads[agentId] ?? [];
    const row = rows[rows.length - 1];
    if (!row) return null;
    return { id: row.id, role: row.role, at: row.at, preview: row.recalled ? "撤回了一条消息" : String(row.text ?? "").slice(0, 30), kind: row.recalled ? "recalled" : row.kind ?? null };
  };
  return [{ id: "nova", name: "阿岚", hidden: false, badge: FIXTURE_BADGES.nova, last: last("nova") }, { id: "xiaoman", name: "小满", hidden: false, badge: FIXTURE_BADGES.xiaoman, last: last("xiaoman") }];
}

const READS = {
  "partners.list": (state) => partners(state),
  "thread.get": (state, query) => threadPage(state, String(query.get("agentId") ?? ""), query.get("limit"), query.get("before")),
  "stickers.list": (state) => ({ groups: state.groups, stickers: state.stickers }),
  "turn.get": (state, query) => ({
    turnId: String(query.get("turnId") ?? "fixture-turn"),
    status: "ready",
    readAfterMs: null,
    // items 的形状就是 { text, gapMs }，跟后端那条一致
    items: [{ text: "夹具：这一轮已经备好", gapMs: 0 }, { text: "第二段气泡", gapMs: 600 }],
    replyMessageId: null,
    message: null,
    error: null,
  }),
  "favorites.list": () => ({ items: [] }),
  "todos.list": () => ({ items: [{ key: "todo-fixture", title: "夹具待办：看一眼就够", at: at(9), date: "2026-10-31", said: "记得明天带伞" }] }),
};

const WRITES = {
  "thread.read": (state, query, body) => {
    for (const row of state.threads[String(body?.agentId ?? "")] ?? []) state.read.set(row.id, row.at);
    return { changed: true, throughId: body?.throughId ?? null };
  },
  "voice.played": (state, query, body) => {
    const playedAt = new Date().toISOString();
    state.read.set(String(body?.messageId ?? ""), playedAt);
    return { playedAt };
  },
  "turn.send": (state, query, body) => {
    const agentId = String(body?.agentId ?? "nova");
    const rows = state.threads[agentId] ?? (state.threads[agentId] = []);
    const id = `sent-${rows.length + 1}`;
    rows.push({ id, seq: rows.length + 1, role: "user", kind: null, clientMessageId: body?.clientMessageId ?? null, text: body?.stickerId ? `\u0001stk:${body.stickerId}` : String(body?.text ?? ""), at: new Date().toISOString() });
    return { messageId: id, mode: "live" };
  },
  // 下面这些只为「按钮点得动」，不模拟真实业务
  "message.favorite": () => ({ favorite: true }),
  "message.feed": (state, query, body) => ({ feed: [{ emoji: String(body?.emoji ?? "🌸"), count: 1, at: new Date().toISOString() }] }),
};

// 剩下的装配类写操作（message.* / favorite.* / action.* / todos.*）统一回 ok，只为「按钮点得动」。
// 图库管理（stickers.*）故意不放行：手机端已经不再有这些接口，夹具不能假装能成功。
const ASSEMBLY_ONLY = /^(message\.|favorite\.|action\.|todos\.)/;

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return resolve({});
    try { resolve(JSON.parse(text)); } catch { resolve({}); }
  });
  req.on("error", () => resolve({}));
});

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const bytes = (res, type, buf) => {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": buf.length });
  res.end(buf);
};

/** 静态只认 ui 根下的 mobile.html 与 assets/*，其余一律 404（不做穿越）。 */
function staticAsset(pathname) {
  const rel = pathname === "/" || pathname === "/index.html" || pathname === "/mobile.html" ? "mobile.html" : pathname.startsWith("/assets/") ? pathname.slice(1) : "";
  if (!rel) return null;
  if (rel !== "mobile.html" && !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rel)) return null;
  const full = path.resolve(UI_ROOT, rel);
  if (full !== path.join(UI_ROOT, "mobile.html") && !full.startsWith(UI_ROOT + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return { full, type: MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream" };
}

function seedPage() {
  const page = fs.readFileSync(path.join(UI_ROOT, "mobile.html"), "utf8");
  const seed = `<script>try{localStorage.setItem("ch_mobile_auth",JSON.stringify({token:${JSON.stringify(TOKEN)},at:Date.now()}))}catch(e){}</script>\n`;
  // 只在合成夹具里暴露控制器，便于浏览器主动补拉验证；生产 HTML 不变。
  return page.replace('startMobileClient(document);', 'window.__mobileFixtureClient = startMobileClient(document);')
    .replace('<script type="module">', `${seed}<script type="module">`);
}

export async function createFixtureServer({ host = "127.0.0.1", port = 0 } = {}) {
  const state = seedState();
  const streams = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;
    const authed = /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/mobile.html")) {
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store", "set-cookie": FIXTURE_COOKIE });
      return res.end(seedPage());
    }
    if (req.method === "GET" && pathname.startsWith("/assets/")) {
      const found = staticAsset(pathname);
      if (!found) return json(res, 404, { ok: false, error: { message: "没有这个资源" } });
      return bytes(res, found.type, fs.readFileSync(found.full));
    }

    const media = {
      "/avatar": () => ["image/svg+xml", AVATARS[String(url.searchParams.get("agentId")) === "xiaoman" ? "xiaoman" : "nova"]],
      "/sticker": () => ["image/svg+xml", STICKER_SVG],
      "/attachment": () => ["image/svg+xml", ATTACHMENT_SVG],
      "/bg": () => ["image/svg+xml", BACKGROUND_SVG],
      "/voice": () => ["audio/wav", VOICE_WAV],
    }[pathname];
    if (media) {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: { message: "只给 GET" } });
      // 媒体/长连接可以用 cookie（img/EventSource 带不了头）；JSON API 仍然只认 Bearer
      if (!authed && cookieToken(req) !== TOKEN) return json(res, 401, { ok: false, error: { message: "先解锁" } });
      const [type, payload] = media();
      return bytes(res, type, payload);
    }

    if (pathname === "/events") {
      if (!authed && cookieToken(req) !== TOKEN) return json(res, 401, { ok: false, error: { message: "先解锁" } });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      res.write(`data: ${JSON.stringify({ type: "hello", at: Date.now() })}\n\n`);
      streams.add(res);
      const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(beat); streams.delete(res); } }, 20000);
      beat.unref?.();
      req.on("close", () => { clearInterval(beat); streams.delete(res); });
      return;
    }

    // 夹具专用：手动推一条新助手消息，方便看「别处来了新消息」
    if (req.method === "POST" && pathname === "/fixture/push") {
      const body = await readBody(req);
      const agentId = String(body?.agentId ?? "nova");
      const rows = state.threads[agentId] ?? (state.threads[agentId] = []);
      rows.push({ id: `push-${rows.length + 1}`, seq: rows.length + 1, role: "assistant", kind: null, text: `夹具：新推进来的一条（${new Date().toLocaleTimeString("zh-CN")}）`, at: new Date().toISOString() });
      return json(res, 200, { ok: true, data: { count: rows.length } });
    }

    if (pathname === "/api/unlock") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: { message: "解锁得 POST" } });
      return json(res, 200, { ok: true, token: TOKEN, expiresIn: 28800 });
    }

    const match = pathname.match(/^\/api\/(.+)$/);
    if (match) {
      const op = match[1].replace(/\//g, ".");
      const read = READS[op];
      const write = WRITES[op];
      if (!authed) return json(res, 401, { ok: false, error: { message: "先解锁" } });
      if (read && req.method === "GET") return json(res, 200, { ok: true, data: read(state, url.searchParams) });
      if (write && req.method === "POST") return json(res, 200, { ok: true, data: write(state, url.searchParams, await readBody(req)) });
      if (!read && !write && ASSEMBLY_ONLY.test(op) && req.method === "POST") return json(res, 200, { ok: true, data: { ok: true } });
      if (!read && !write) return json(res, 404, { ok: false, error: { code: "unknown_op", message: `夹具没实现 ${op}` } });
      return json(res, 405, { ok: false, error: { message: "方法不对" } });
    }

    return json(res, 404, { ok: false, error: { code: "not_found", message: "夹具没有这个门" } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    async close() {
      for (const res of streams) {
        try { res.end(); } catch { /* 已经断了 */ }
      }
      streams.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const fixture = await createFixtureServer();
  process.stdout.write(`ready ${fixture.url}\n`);
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
