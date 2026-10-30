/**
 * 茶话会 · 手机页客户端
 *
 * 这一份分成两半，界线要守住：
 *   ① 纯逻辑（本文件上半部）：请求归属/世代、内容签名、分页合并、滚动判定、选图校验、
 *      发送幂等队列、已读回执条件、token 过期。都不碰 DOM，测试直接 import 就能跑。
 *   ② 页面装配（startMobileClient）：只在这里碰 document / fetch / EventSource，
 *      页面用 <script type="module"> 调一次。
 *
 * 为什么逻辑要单独拎出来：这一页最容易坏的地方不是样式，而是「谁的结果算数」——
 * 切伙伴时旧请求回来、同一伙伴两次重叠、失败后重试要不要换 clientMessageId、
 * 后台轮询能不能盖章已读。这些以前全靠顺手写，没有一处可断言；现在都能测。
 *
 * 协议（与网关/宿主约定，勿在各处自行发挥）：
 *   GET  /api/partners.list
 *   GET  /api/thread.get?agentId&limit&before        （返回 messages/total/hasMore + 皮肤头像背景）
 *   GET  /api/stickers.list?agentId
 *   POST /api/turn.send   {agentId,text?,stickerId?,image?,clientMessageId,quote?}
 *   POST /api/thread.read {agentId,throughId}
 *   POST /api/voice.played{agentId,messageId}
 *   GET  /attachment?agentId&attachmentId            （图片走 cookie，不走 Bearer）
 */

// ─────────────────────────── 常量 ───────────────────────────

/**
 * 背景自适应：采样主色、算按钮/气泡配色都用桌面那一套（ui/assets/background-adaptive.js），
 * 手机页不另写一份。这里用相对路径而不是 /assets/…：测试要在 Node 里直接 import 本文件，
 * 绝对路径在 Node 里解析不到。两个函数都只看图片像素，碰 DOM 只在调用时，import 本身无副作用。
 */
import { analyzeBackgroundUrl, buttonThemeFromSample } from "./background-adaptive.js";
/**
 * 手机工具模块（收藏 / 图库 / 戳一戳 / 消息管理）。
 *
 * 静态 import：这一页和它是同一次部署的两块，模块坏了就该当场报错，
 * 不能吞成「工具入口不出现」——那种失效能在线上默默待很久。
 * 测试要换掉它时走 startMobileClient 的 createTools 参数。
 */
import { createMobileTools } from "./mobile-tools.js";

/** 首屏与上翻各取多少条（协议：默认 50 / 上翻 100）。 */
export const MOBILE_PAGE_SIZE = 50;
export const MOBILE_PAGE_MORE = 100;
/** 手机端本地就挡住的图片上限；宿主那边另有最终上限，超了由宿主回错。 */
export const MOBILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** turn.send 这一条的 JSON 上限（只有它放宽到 16MiB，图片本体仍是 10MiB 解码后的）。 */
export const MOBILE_TURN_MAX_JSON_BYTES = 16 * 1024 * 1024;
/** 登录 token 有效期（网关签发 8 小时）。 */
export const MOBILE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
/** 单个接口的超时；超时按「用户取消」处理，不弹错。 */
export const MOBILE_API_TIMEOUT_MS = 20000;
/** 单次 thread.get 的条数上限，与宿主那边对齐（2000 条）。 */
export const MOBILE_PAGE_CAP = 2000;
export const MOBILE_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** 引用正文的上限：跟后端 normalizeQuote / buildTurnPayload 同一个数（4000），不在 UI 里提前砍成 120。 */
export const MOBILE_QUOTE_MAX = 4000;
/** 背景「明暗」档位对应的默认浓度百分比，与桌面同一套（settings 里那三档）。 */
export const MOBILE_BACKGROUND_TONE = Object.freeze({ light: 34, medium: 52, heavy: 76 });
/** 既没有合法浓度、也没有认得的档位时用的默认值。 */
const BACKGROUND_TONE_FALLBACK = 52;
/** 暖白遮罩：跟 panel.css 里那层反光同一个色。 */
const BACKGROUND_VEIL_RGB = "247, 244, 236";
/**
 * 背景主色算出来的主题变量，写在 #chat 上让按钮/气泡顺着继承链自己取。
 * 名字与桌面 panel.html 里那串 setProperty 一一对应，值也是同一份 buttonThemeFromSample。
 */
export const BACKGROUND_THEME_VARS = Object.freeze([
  "--send-bg", "--send-fg", "--send-border",
  "--voice-bg", "--voice-fg", "--voice-border",
  "--status-bg", "--status-fg", "--status-border",
  "--bubble-me-bg", "--bubble-me-border", "--bubble-me-fg",
  "--jump-bg", "--jump-fg", "--jump-border", "--jump-hover-bg",
  "--bubble-ta-bg", "--bubble-ta-border", "--bubble-ta-fg",
]);
const STICKER_PREFIX = "\u0001stk:";
const BOTTOM_TOLERANCE = 48;
const OLDER_THRESHOLD = 120;

// ─────────────────── 伙伴状态徽章（与桌面同一套）───────────────────

/** 与 panel.html 的 BADGE_VISUALS 同表：id/type → 色调与图标。 */
export const BADGE_VISUALS = Object.freeze({
  online: { tone: "online", icon: "online" },
  busy: { tone: "busy", icon: "busy" },
  new: { tone: "new", icon: "new" },
  recent: { tone: "recent", icon: "recent" },
  away: { tone: "away", icon: "away" },
  idle: { tone: "idle", icon: "idle" },
  resting: { tone: "resting", icon: "resting" },
  sleeping: { tone: "sleeping", icon: "sleeping" },
  waking: { tone: "waking", icon: "waking" },
  awaiting: { tone: "awaiting", icon: "awaiting" },
  quiet: { tone: "quiet", icon: "quiet" },
  custom: { tone: "custom", icon: "custom" },
});

/** 与 panel.html 的 BADGE_ICON_PATHS 同一份路径（24×24）。 */
export const BADGE_ICON_PATHS = Object.freeze({
  online: ["M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  busy: ["M4.5 8h15v9h-15z", "M8 8V5.5h8V8", "M4.5 11.5h15"],
  new: ["M4 6.5h16v11H4z", "m4.5 7 7.5 6 7.5-6", "M17.5 4.5v3M16 6h3"],
  recent: ["M12 5a7 7 0 1 0 7 7", "M12 8v4l2.5 1.5", "M16 4.5h3v3"],
  away: ["M18.5 4.5C11 5 6 8.5 5.5 15.5c4.5 1 9.5-1.5 13-7.5", "M5.5 15.5c2-2.5 4.5-4.5 7.5-6"],
  idle: ["M5 7.5h10v5.5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z", "M15 9h1.5a2.5 2.5 0 0 1 0 5H15", "M8 19h8"],
  resting: ["M5 8h10v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z", "M15 10h1.5a2 2 0 0 1 0 4H15", "M8 19h8"],
  sleeping: ["M18.5 14.5A6.5 6.5 0 1 1 10 5.5a5.5 5.5 0 0 0 8.5 9", "M16.5 6.5h2l-2 2h2"],
  waking: ["M6 15a6 6 0 0 1 12 0", "M12 4v3M5.5 7.5l2 2M18.5 7.5l-2 2", "M4 17h16"],
  awaiting: ["M4.5 6.5h15v9h-9l-4 3v-3h-2z", "M9 11h.01M12 11h.01M15 11h.01"],
  quiet: ["M12 19s-7-4.2-7-9a3.5 3.5 0 0 1 6-2.5A3.5 3.5 0 0 1 19 10c0 4.8-7 9-7 9z"],
  custom: ["m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z", "M19 16v4M17 18h4"],
});

/** 未知/自定义一律走 custom，不把没认得的 id 拼进 class 里。 */
export function badgeVisual(badge) {
  const key = badge?.type === "custom" ? "custom" : String(badge?.id ?? "");
  return BADGE_VISUALS[key] || BADGE_VISUALS.custom;
}

/** 徽章文字：title 优先，其次 label；空串 = 没状态，不画。 */
export function badgeLabelOf(badge) {
  return String(badge?.title || badge?.label || "").trim();
}

// ─────────────────────────── 纯逻辑（无 DOM）───────────────────────────

/** 登录态：存的是 {token, at}，8 小时后过期，过期就得回解锁页。 */
export function readTokenState(raw, now = Date.now(), ttlMs = MOBILE_TOKEN_TTL_MS) {
  const text = String(raw ?? "");
  if (!text) return { token: "", valid: false, expired: false };
  let row = null;
  try { row = JSON.parse(text); } catch { row = null; }
  const token = String(row?.token ?? "");
  const at = Number(row?.at ?? 0);
  if (!token) return { token: "", valid: false, expired: false };
  const valid = Number.isFinite(at) && at > 0 && now - at < ttlMs;
  return { token, valid, expired: !valid };
}

export function writeTokenState(token, now = Date.now()) {
  return JSON.stringify({ token: String(token ?? ""), at: now });
}

/**
 * 请求归属与世代。
 *
 * 三条规矩：
 *   · 切伙伴/重新登录 → bump()，在飞的请求全部 abort，回来的结果一律不算数；
 *   · 同一 key（例如 pull:某个伙伴）重叠 → 后者顶掉前者，旧结果不许覆盖新结果；
 *   · 拿到 token 的调用方先 isCurrent() 再落状态。
 */
export function createRequestTracker() {
  let generation = 0;
  let seq = 0;
  const inflight = new Map();
  const abort = (entry) => { try { entry?.controller?.abort("superseded"); } catch { /* 已经结束 */ } };
  return {
    generation: () => generation,
    bump() {
      generation += 1;
      for (const entry of inflight.values()) abort(entry);
      inflight.clear();
      return generation;
    },
    begin(key) {
      const prev = inflight.get(key);
      if (prev) { abort(prev); inflight.delete(key); }
      const controller = new AbortController();
      const token = { key, generation, id: (seq += 1), controller };
      inflight.set(key, token);
      return token;
    },
    isCurrent(token) {
      if (!token) return false;
      if (token.generation !== generation) return false;
      return inflight.get(token.key)?.id === token.id;
    },
    /** 只作废这一个 key（例如“把选中的图移除”），不动别人在飞的请求。 */
    cancel(key) {
      const entry = inflight.get(key);
      if (!entry) return false;
      abort(entry);
      inflight.delete(key);
      return true;
    },
    settle(token) {
      if (!token) return;
      const entry = inflight.get(token.key);
      if (entry && entry.id === token.id) inflight.delete(token.key);
    },
  };
}

/** 线程状态：消息、总数、还能不能往上翻。 */
export function createThreadState() {
  return { agentId: "", messages: [], total: 0, hasMore: false };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    const key = row.id ? `id:${row.id}` : row.seq != null ? `seq:${row.seq}` : `raw:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function bySeq(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = Number(a.row?.seq);
      const sb = Number(b.row?.seq);
      const va = Number.isFinite(sa);
      const vb = Number.isFinite(sb);
      if (va && vb && sa !== sb) return sa - sb;
      if (va !== vb) return va ? -1 : 1;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

/**
 * 一页结果落进状态。replace = 首屏/轮询那一次；prepend = 上翻的老记录。
 * 上翻只在同一个伙伴下才收，别把 A 的旧记录塞进 B。
 */
export function applyThreadPage(state, { agentId, page, mode = "replace" } = {}) {
  const current = state ?? createThreadState();
  const rows = Array.isArray(page?.messages) ? page.messages : [];
  if (mode === "prepend") {
    if (!current.agentId || current.agentId !== agentId) return current;
    return {
      ...current,
      messages: bySeq(dedupeRows([...rows, ...current.messages])),
      total: Number.isFinite(Number(page?.total)) ? Number(page.total) : current.total,
      hasMore: Boolean(page?.hasMore),
    };
  }
  return {
    agentId: String(agentId ?? ""),
    messages: bySeq(dedupeRows(rows)),
    total: Number.isFinite(Number(page?.total)) ? Number(page.total) : rows.length,
    hasMore: Boolean(page?.hasMore),
  };
}

/**
 * 渲染签名：比的是内容，不是 id。
 *
 * 撤回、改稿、语音从 pending 变 ready、图片/引用换了，都要重建；
 * 普通时间戳变化不重建；挂有 repliedTo 的回复除外，它的时间决定投喂是否过期。
 */
export function signatureOf(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message) return "";
      const voice = message.voice
        ? [message.voice.status ?? "", message.voice.durationMs ?? "", message.voice.text ?? "", message.voice.playedAt ?? ""].join("~")
        : "";
      const attachment = message.attachment?.id
        ? [message.attachment.id, message.attachment.name ?? "", message.attachment.mimeType ?? ""].join("~")
        : "";
      const quote = message.quote?.messageId
        ? [message.quote.messageId, message.quote.text ?? ""].join("~")
        : "";
      // 投喂挂件、伙伴递过来的那份、已读章都要进签名：
      // 只改了这几样的那一页，也得让挂件跟着变（否则要等下次整段重画才看得到）。
      const feed = feedSignatureOf(message.feed);
      const partnerFeed = feedSignatureOf(message.partnerFeed);
      return [
        message.id ?? "",
        message.seq ?? "",
        message.role ?? "",
        message.kind ?? "",
        message.recalled ? 1 : 0,
        message.recallMode ?? "",
        message.text ?? "",
        Array.isArray(message.bubbles) ? message.bubbles.join("\u0001") : "",
        voice,
        attachment,
        quote,
        feed,
        partnerFeed,
        message.readAt ?? "",
        message.repliedTo ?? "",
        message.role === "assistant" && message.repliedTo ? message.at ?? "" : "",
      ].join("|");
    })
    .join("\u0002");
}

/**
 * 「气泡本体」签名：决定这一条要不要重建 DOM。
 *
 * 已读章、投喂份数、ta 递来的那份、语音听过没——这几样一直会变，
 * 但它们都不改变气泡里的东西。剔出去之后，轮询回来才能原地补，
 * 而不是因为她听了一条语音就把整段（连正在放的那条）重画掉。
 */
export function coreSignatureOf(message) {
  if (!message) return "";
  const voice = message.voice ? [message.voice.status ?? "", message.voice.durationMs ?? "", message.voice.text ?? ""].join("~") : "";
  const attachment = message.attachment?.id
    ? [message.attachment.id, message.attachment.name ?? "", message.attachment.mimeType ?? ""].join("~")
    : "";
  const quote = message.quote?.messageId ? [message.quote.messageId, message.quote.text ?? ""].join("~") : "";
  return [
    message.id ?? "",
    message.seq ?? "",
    message.role ?? "",
    message.kind ?? "",
    message.recalled ? 1 : 0,
    message.recallMode ?? "",
    message.text ?? "",
    Array.isArray(message.bubbles) ? message.bubbles.join("\u0001") : "",
    voice,
    attachment,
    quote,
  ].join("|");
}

/** 会变、但不改变气泡本身的那几样：已读章、投喂、听过没。 */
export function transientSignatureOf(message) {
  if (!message) return "";
  return [
    message.voice?.playedAt ?? "",
    feedSignatureOf(message.feed),
    feedSignatureOf(message.partnerFeed),
    message.readAt ?? "",
    message.repliedTo ?? "",
    message.role === "assistant" && message.repliedTo ? message.at ?? "" : "",
  ].join("|");
}

/**
 * 时间刻度文案：与桌面 timeDividerText 同一套写法（今天/昨天/M 月 D 日 + 时分）。
 * now 可注入，测试不靠真时钟。
 */
export function timeDividerText(at, now = new Date()) {
  const date = new Date(at ?? "");
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay(date, now)) return `今天 ${clock}`;
  if (sameDay(date, new Date(now.getTime() - 86400000))) return `昨天 ${clock}`;
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()} 年 ${day} ${clock}`;
}

/** 每条自己的时间（触控屏上没有 hover，所以得写出来，不能只挂在 title 上）。 */
export function messageTimeText(at) {
  const date = new Date(at ?? "");
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 语音只念得出能读的那几句。还带着念不出来的气泡（分享链接、补充说明）得照旧摆回去，
 * 否则语音那条会把整条正文一起吞掉。与桌面 voiceLeftoverBubbles 同一套。
 */
export function voiceLeftoverBubbles(message) {
  const spoken = String(message?.voice?.text ?? message?.text ?? "").replace(/\s+/gu, "");
  const pieces = Array.isArray(message?.bubbles) && message.bubbles.length ? message.bubbles : [];
  return pieces
    .map((piece) => String(piece ?? "").trim())
    .filter((piece) => piece && !stickerIdOf(piece))
    .filter((piece) => !spoken.includes(piece.replace(/\s+/gu, "")));
}

/**
 * 只放 http/https 的链接。账上的文本可能带着任意字符串，
 * 一旦拼成 <a href> 就是注入口子，所以白名单式地只认这两种协议。
 */
export function safeLinkHref(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/**
 * 把一段正文切成「文字」与「链接」两类片段。
 * 只认裸 http(s) 链接；不是链接的部分一律原样交给调用方用 textContent 写。
 */
export function splitLinkSegments(text) {
  const source = String(text ?? "");
  const out = [];
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[0];
    // 句末的标点不当成链接的一部分，不然复制出来带个句号打不开
    const trimmed = raw.replace(/[)\]}>,.!?;:，。！？；：）】」』]+$/gu, "");
    if (!trimmed) continue;
    const start = match.index;
    if (start > cursor) out.push({ type: "text", text: source.slice(cursor, start) });
    const href = safeLinkHref(trimmed);
    out.push(href ? { type: "link", text: trimmed, href } : { type: "text", text: trimmed });
    cursor = start + trimmed.length;
    if (trimmed.length < raw.length) {
      out.push({ type: "text", text: raw.slice(trimmed.length) });
      cursor = start + raw.length;
    }
  }
  if (cursor < source.length) out.push({ type: "text", text: source.slice(cursor) });
  return out;
}

/**
 * 一条回复要在气泡里「一点点长出来」时，按什么分段。
 *
 * items 只在和权威正文完全一致时拿来做分段与间隔；对不上（被编辑过、语音、只是概览）
 * 就退回按句读切几段、每段一个短间隔——绝不拿旧 items 当正文。
 */
export function revealSegments(text, items) {
  const full = String(text ?? "");
  if (!full) return [];
  const rows = (Array.isArray(items) ? items : [])
    .map((row) => ({ text: String(row?.text ?? ""), gap: Math.min(1200, Math.max(0, Number(row?.gapMs) || 0)) }))
    .filter((row) => row.text);
  if (rows.length > 1 && rows.map((row) => row.text).join("") === full) return rows;
  return chunkText(full).map((part) => ({ text: part, gap: 140 }));
}

/** 按句读把一段文字切成两到三段（切不动就一段到底，不硬砍）。 */
export function chunkText(text, parts = 3) {
  const full = String(text ?? "");
  if (!full) return [];
  const edges = [];
  const pattern = /[。！？!?…\n]/gu;
  let match;
  while ((match = pattern.exec(full))) edges.push(match.index + 1);
  if (edges.length < 2) return [full];
  const target = Math.ceil(full.length / Math.min(parts, edges.length + 1));
  const cuts = [0];
  for (const edge of edges) {
    if (edge - cuts[cuts.length - 1] >= target && full.length - edge >= target / 2) cuts.push(edge);
  }
  cuts.push(full.length);
  const out = [];
  for (let i = 1; i < cuts.length; i += 1) {
    const piece = full.slice(cuts[i - 1], cuts[i]);
    if (piece) out.push(piece);
  }
  return out.length ? out : [full];
}

/** 两份 core 签名列表是不是真变了（playedAt / readAt 这类不算）。 */
export function coreListChanged(before, after) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  if (a.length !== b.length) return true;
  return a.some((sig, i) => sig !== b[i]);
}

/** 往上翻的游标：当前最早那条的 seq（没有 seq 就退回 null，不瞎猜）。 */
export function earliestSeq(messages) {
  let min = Infinity;
  for (const message of Array.isArray(messages) ? messages : []) {
    const seq = Number(message?.seq);
    if (Number.isFinite(seq) && seq < min) min = seq;
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * 轮询那一下到底拉多少条（2026-10-30 修，上限只跟已加载数）。
 *
 * 以前的毛病：pull 永远 limit=50，而它走的是整体 replace——她往上翻了 100 条老记录，
 * 20 秒后的轮询（或一条 SSE）就把整个窗口抹回最近 50 条，翻过的内容与滚动位置一起没了。
 * 现在按“已加载多少就要多少”去拉（不额外加一屏）：只有她真的往上翻、并且翻到了，
 * 窗口才会变大；静置轮询永远只拿当前这么大，不会 50→100→150 一路自动拉满。
 * 新消息进来时，这扇有界窗口里最早的那几条自然退出屏幕（hasMore 会跟着变 true）。
 */
export function pullLimit(loadedCount, { base = MOBILE_PAGE_SIZE, cap = MOBILE_PAGE_CAP } = {}) {
  const loaded = Number(loadedCount);
  const floor = Math.max(1, Number(base) || MOBILE_PAGE_SIZE);
  const ceiling = Math.max(floor, Number(cap) || MOBILE_PAGE_CAP);
  const want = Number.isFinite(loaded) ? Math.max(0, Math.floor(loaded)) : 0;
  return Math.min(ceiling, Math.max(floor, want));
}

/** 线程里已经落库的 clientMessageId：用来把超时那条 pending/失败标记收掉。 */
export function deliveredClientIds(messages) {
  const out = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = String(message?.clientMessageId ?? "").trim();
    if (id) out.add(id);
  }
  return out;
}

export function isNearBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}, tolerance = BOTTOM_TOLERANCE) {
  return scrollHeight - (scrollTop + clientHeight) <= Math.max(0, tolerance);
}

/** 快贴到顶了才去要更早的记录；正在翻或没更多就别问。 */
export function shouldLoadOlder(
  { scrollTop = 0 } = {},
  { hasMore = false, loading = false, threshold = OLDER_THRESHOLD } = {},
) {
  if (!hasMore || loading) return false;
  return scrollTop <= Math.max(0, threshold);
}

/** 前面插进老记录后，把滚动位置钉在原来那条上，别让眼前的内容跳走。 */
export function anchorAfterPrepend({ prevHeight = 0, prevTop = 0, nextHeight = 0 } = {}) {
  const delta = Number(nextHeight) - Number(prevHeight);
  return Math.max(0, Number(prevTop) + (Number.isFinite(delta) ? delta : 0));
}

/** 选图先在本机挡一道：类型、大小、空文件。宿主那边另有上限，这边挡不住它兜。 */
export function validateImageFile({ type = "", size = 0 } = {}, { maxBytes = MOBILE_IMAGE_MAX_BYTES } = {}) {
  const mime = String(type ?? "").trim().toLowerCase();
  if (!MOBILE_IMAGE_TYPES.includes(mime)) {
    return { ok: false, reason: "只支持 PNG / JPG / WEBP / GIF" };
  }
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, reason: "这张图读不出来" };
  if (bytes > Math.max(1, Number(maxBytes) || MOBILE_IMAGE_MAX_BYTES)) {
    return { ok: false, reason: `图片超过 ${Math.floor((Number(maxBytes) || MOBILE_IMAGE_MAX_BYTES) / 1024 / 1024)}MB` };
  }
  return { ok: true, reason: "" };
}

/**
 * 发送体。agentId 与 clientMessageId 在点发送那一刻就定下来，
 * 之后切伙伴、失焦都不会改它——发出去的就是当时那个伙伴。
 */
export function buildTurnPayload({ agentId, text, stickerId, image, quote, clientMessageId } = {}) {
  const body = { agentId: String(agentId ?? "").trim(), clientMessageId: String(clientMessageId ?? "").trim() };
  const value = String(text ?? "").trim();
  if (value) body.text = value;
  if (stickerId) body.stickerId = String(stickerId);
  if (image?.data) {
    // 字段名与桌面收图那一套对齐：{name, mimeType, data(base64), width?, height?}
    const shot = {
      name: String(image.name ?? "image"),
      mimeType: String(image.mimeType ?? "image/png"),
      data: String(image.data),
    };
    const width = Number(image.width);
    const height = Number(image.height);
    if (Number.isFinite(width) && width > 0) shot.width = Math.round(width);
    if (Number.isFinite(height) && height > 0) shot.height = Math.round(height);
    body.image = shot;
  }
  const quoteText = String(quote?.text ?? "").trim();
  if (quote?.messageId && quoteText) {
    body.quote = { messageId: String(quote.messageId), text: quoteText.slice(0, 4000) };
  }
  return body;
}

/**
 * turn.send 的 JSON 字节数是否还在上限内。
 * 图片本体卡在 10MiB，base64 膨胀后仍然放得下；这条是防止文本+图叠在一起越界。
 */
export function fitsTurnLimit(body, maxBytes = MOBILE_TURN_MAX_JSON_BYTES) {
  if (!body) return false;
  const text = JSON.stringify(body);
  const size = typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
  return size <= Math.max(1, Number(maxBytes) || MOBILE_TURN_MAX_JSON_BYTES);
}

/**
 * 撤回的行该怎么写。桌面那头可能已经把正文换成了占位、也可能只是打了个 recalled 标记，
 * 两种都不能把原文再摆出来——这里统一按“谁撤回的”给一句，招式与桌面一致。
 */
export function recallLabelOf(message, { partnerName = "" } = {}) {
  const own = String(message?.recallLabel ?? "").trim();
  if (own) return own;
  if (message?.role === "user") return "你撤回了一条消息";
  const name = String(partnerName ?? "").trim();
  return name ? `${name}撤回了一条消息` : "对方撤回了一条消息";
}

export function hasSendableContent(body) {
  return Boolean(body) && Boolean(body.text || body.stickerId || body.image?.data);
}

/**
 * 发送队列：一次只允许一条在发（同伙伴再点就挡住），失败后保留原票，
 * 重试时复用同一个 clientMessageId——宿主据此去重，不会发成两条。
 */
export function createSendQueue() {
  let pending = null;
  let retryable = null;
  return {
    current: () => pending,
    begin({ clientMessageId, agentId, payload } = {}) {
      const id = String(clientMessageId ?? "").trim();
      if (!id || !agentId || !payload) return null;
      if (pending) return null;
      pending = { clientMessageId: id, agentId: String(agentId), payload };
      retryable = null;
      return pending;
    },
    done() {
      const row = pending;
      pending = null;
      return row;
    },
    fail() {
      const row = pending;
      pending = null;
      if (row) retryable = row;
      return row;
    },
    retryPlan: () => retryable,
    clearRetry() { retryable = null; },
  };
}

/**
 * 已读回执：聊天确实开着 + 页面可见 + 真的贴在底下，才给 throughId。
 * 最后一条是屏外新消息时盖章 = 替她承认看过，所以 atBottom 默认 false，必须显式给。
 */
export function readReceiptThrough({ messages, chatOpen = false, documentVisible = false, atBottom = false } = {}) {
  if (!chatOpen || !documentVisible || !atBottom) return null;
  const rows = (Array.isArray(messages) ? messages : []).filter((row) => row && row.id);
  if (!rows.length) return null;
  return String(rows[rows.length - 1].id);
}

/** SSE 事件：只认 threads，别的一律当噪声。 */
export function parseThreadEvent(raw) {
  let row = null;
  try { row = JSON.parse(String(raw ?? "")); } catch { return null; }
  if (!row || row.type !== "threads") return null;
  return { type: "threads", at: Number(row.at) || 0 };
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

export function stickerIdOf(text) {
  const value = String(text ?? "");
  return value.startsWith(STICKER_PREFIX) ? value.slice(STICKER_PREFIX.length).trim() : "";
}

// ─────────────────── 消息菜单：投喂 / 复制 / 引用 / 收藏（纯逻辑）───────────────────

/**
 * 投喂菜单里那八枚，与桌面 panel.html 的 FEED_EMOJIS 同一份、顺序也不改。
 * 手机这一份导出给测试直接比，不用去 parse 页面。
 */
export const FEED_EMOJIS = Object.freeze(["☕", "🍵", "🍭", "🧋", "🍪", "🍰", "🍓", "🍫"]);
/** 按住多久算长按。手机上 500ms 已经明显长于一次普通点击。 */
export const LONG_PRESS_MS = 500;
/** 长按开完菜单之后，点图/点语音要多长时间内算“这一下不算”。 */
export const LONG_PRESS_CLICK_SUPPRESS_MS = 700;

/**
 * 投喂记录归一：宿主给 {items:[{emoji,count,at}]}，旧账里也可能只剩 {emoji}。
 * 同一枚合并成一条并累加份数；缺 count 按 1 算——份数是宿主记的账，这里只负责看得懂。
 */
export function messageFeedItems(value) {
  const source = value && typeof value === "object" ? value : {};
  const raw = Array.isArray(source.items)
    ? source.items
    : (String(source.emoji ?? "").trim() ? [{ emoji: source.emoji, count: source.count, at: source.at }] : []);
  const items = [];
  for (const row of raw) {
    const emoji = String(row?.emoji ?? "").trim();
    if (!emoji) continue;
    const count = Math.max(1, Number(row?.count) || 1);
    const existing = items.find((item) => item.emoji === emoji);
    if (existing) {
      existing.count += count;
      if (!existing.at && row?.at) existing.at = row.at;
      continue;
    }
    items.push({ emoji, count, at: row?.at ?? null });
  }
  return items;
}

export function formatMessageFeed(value) {
  return messageFeedItems(value).map((item) => `${item.emoji}${item.count > 1 ? `×${item.count}` : ""}`).join(" ");
}

/** 签名里用的那一句：份数与时间戳都算进去，只调换顺序不动它的不算变。 */
export function feedSignatureOf(value) {
  return messageFeedItems(value).map((item) => `${item.emoji}:${item.count}:${item.at ?? ""}`).join("/");
}

/**
 * 伙伴递过来的那份，哪些还能看。
 *
 * 只认她还没接话之前递的：ta 先递了东西、紧接着又回了话，那份“我看到了”就过期了。
 * 与桌面 panel.html 的 visiblePartnerFeedItems 同一套规矩（旧账里已经挂上去的也照此滤）。
 */
export function visiblePartnerFeedItems(message, messages) {
  const items = messageFeedItems(message?.partnerFeed);
  const replyTimes = (Array.isArray(messages) ? messages : [])
    .filter((row) => row?.role === "assistant" && row?.repliedTo && row.repliedTo === message?.id)
    .map((row) => Date.parse(String(row.at ?? "")))
    .filter((at) => Number.isFinite(at));
  if (!replyTimes.length) return items;
  return items.filter((item) => {
    const fedAt = Date.parse(String(item?.at ?? ""));
    return !Number.isFinite(fedAt) || !replyTimes.some((replyAt) => replyAt <= fedAt);
  });
}

/**
 * 一条消息能当文字用的那部分。
 *
 * 表情包在账上是一个带 \u0001 控制头的占位串，绝不能原样露到引用/剪贴板里——
 * 她复制出去、引用出去的，得是她看得懂的东西。
 */
export function messageTextOf(message) {
  if (!message || message.recalled) return "";
  const text = String(message.text ?? "").trim();
  if (stickerIdOf(text)) return "[表情]";
  if (text) return text;
  if (message.voice) return "[语音]";
  if (message.attachment?.id) return "[图片]";
  return "";
}

/** 伙伴那句能不能投喂/收藏：真 id、没撤回、不是还在路上的那一条。 */
export function feedableMessage(message) {
  if (!message || message.role !== "assistant") return false;
  if (!String(message.id ?? "").trim()) return false;
  if (message.recalled || message.kind === "recalled") return false;
  if (message.pending || message.status === "pending") return false;
  // 语音还在录：还没成形的那条不能喂
  if (message.voice?.status === "pending") return false;
  return true;
}

/** 宿主明确回的「这张贴图不能用了」：这种不能当成网络错去重试同一张。 */
export function stickerUnavailableError(error) {
  const text = String(error?.message ?? error ?? "");
  return /表情包.*不可用|贴图.*不可用|sticker.*unavailable/i.test(text);
}

/** 有没有菜单可开：伙伴那条能投喂/收藏，自己那条只有复制/引用。 */
export function actionableMessage(message) {
  if (!message || message.recalled || message.kind === "recalled") return false;
  if (message.pending || message.status === "pending") return false;
  if (!String(message.id ?? "").trim()) return false;
  return message.role === "assistant" || message.role === "user";
}

/**
 * 菜单摆哪儿：贴着那条消息，再按视口夹回来。
 *
 * 窄屏上贴右边那条的气泡会把整块菜单顶出屏幕，所以 left/top 都夹到 margin 以内；
 * 下方放不下就翻到上方。view 宽高为 0（测试里的假窗口）时不做夹取，只给贴边值。
 */
export function menuPlacement(rect, box, view, { margin = 8, gap = 8 } = {}) {
  const width = Number(view?.width) || 0;
  const height = Number(view?.height) || 0;
  const boxWidth = Number(box?.width) || 0;
  const boxHeight = Number(box?.height) || 0;
  const left = Number(rect?.left) || 0;
  const top = Number(rect?.top) || 0;
  const bottom = Number.isFinite(Number(rect?.bottom)) ? Number(rect.bottom) : top;
  let x = left;
  if (width > 0) x = Math.max(margin, Math.min(left, width - boxWidth - margin));
  let y = bottom + gap;
  let below = true;
  if (height > 0) {
    below = y + boxHeight <= height - margin;
    if (!below) y = top - boxHeight - gap;
    y = Math.max(margin, Math.min(y, height - boxHeight - margin));
  }
  return { left: Math.round(x), top: Math.round(y), below };
}

/**
 * 她按着选中的那段字：只认落在这一条里的选区。
 *
 * 跨行的、或者根本是别处的选区一律不带——引用一句她没指的话，比不给引用更糟。
 */
export function selectedTextOf(doc, row) {
  const selection = doc?.getSelection?.() ?? doc?.defaultView?.getSelection?.() ?? null;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const text = String(selection.toString?.() ?? "").trim();
  if (!text) return "";
  // 相同的字可能在别条消息里也出现，选区端点必须确实属于这一行。
  if (!row?.contains?.(selection.anchorNode) || !row.contains(selection.focusNode)) return "";
  return text;
}

// ─────────────────── 背景浓度与主题（纯逻辑，无 DOM）───────────────────

/**
 * 她调的「背景明暗」是百分数（0–100），不是 0–1 的小数。
 *
 * 旧实现把 52 这种百分数直接 clamp 到 0–1，于是每间房都变成满浓度。规矩改成：
 *   · 数字 0 和字符串 "0" 都是合法的 0%（图完全露出来），100 就是完全遮住；
 *   · 越界往两头夹，不报错；
 *   · null / undefined / 空串 / NaN / 不认得的档位 ⇒ 先按 tone 兜底，再没有就 52。
 *     特别地：null 不许被 Number(null) 变成 0——那是「没设置」，不是「全透明」。
 */
export function backgroundVeil(opacity, tone) {
  const usable = typeof opacity === "number"
    ? Number.isFinite(opacity)
    : typeof opacity === "string" && opacity.trim() !== "" && Number.isFinite(Number(opacity));
  const percent = usable
    ? Math.min(100, Math.max(0, Number(opacity)))
    : (MOBILE_BACKGROUND_TONE[String(tone ?? "").trim()] ?? BACKGROUND_TONE_FALLBACK);
  return percent / 100;
}

/**
 * 同一张图的识别 key：换伙伴、换图、换时间戳才重下重采样。
 * 只改浓度（拖明暗条）不换图的话，在调用方那边就拦住了，只重画遮罩。
 */
export function backgroundImageKey(agentId, background) {
  const file = String(background?.file ?? "").trim();
  if (!file) return "";
  return [String(agentId ?? ""), file, String(background?.at ?? "")].join("|");
}

/** 主题 → CSS 变量。没主题（采样失败 / 没背景）就一个都不给，让共用样式里的默认值兜。 */
export function backgroundThemeVars(theme) {
  if (!theme) return {};
  const vars = {
    "--send-bg": theme.background,
    "--send-fg": theme.foreground,
    "--send-border": theme.border,
    "--voice-bg": theme.background,
    "--voice-fg": theme.foreground,
    "--voice-border": theme.border,
    "--status-bg": theme.noticeBackground,
    "--status-fg": theme.noticeForeground,
    "--status-border": theme.noticeBorder,
    "--bubble-me-bg": theme.bubbleMeBackground,
    "--bubble-me-border": theme.bubbleMeBorder,
    "--bubble-me-fg": theme.bubbleMeForeground,
    "--bubble-ta-bg": theme.bubbleTaBackground,
    "--bubble-ta-border": theme.bubbleTaBorder,
    "--bubble-ta-fg": theme.bubbleTaForeground,
    // 回到底部那颗圆键（以及跟着取色的返回键）
    "--jump-bg": theme.background,
    "--jump-fg": theme.foreground,
    "--jump-border": theme.border,
    "--jump-hover-bg": theme.noticeBackground,
  };
  for (const name of Object.keys(vars)) if (!vars[name]) delete vars[name];
  return vars;
}

/** 铺在聊天窗上的那层：暖白遮罩 + 图，与桌面 paintChatBackground 是同一句。 */
export function backgroundLayer(veil, url) {
  const alpha = Number.isFinite(Number(veil)) ? Number(veil) : 0;
  return `linear-gradient(rgba(${BACKGROUND_VEIL_RGB}, ${alpha}), rgba(${BACKGROUND_VEIL_RGB}, ${alpha})), url("${String(url ?? "")}")`;
}

// ─────────────────────────── 页面装配（只在浏览器里跑）───────────────────────────

const canceled = () => Object.assign(new Error("已取消"), { code: "canceled" });
const isCanceled = (error) => error?.code === "canceled";
const timedOut = () => Object.assign(new Error("请求超时，可重试"), { code: "timeout" });

/**
 * 把 abort 归一成两种：用户取消/切伙伴（静默）、超时（提示可重试）。
 *
 * fetch 被 abort 时 reject 的不一定是 DOMException：我们往 AbortSignal.reason 里塞过
 * "timeout"/"superseded" 这种字符串，实测会直接把字符串抛出来，只认 AbortError.name
 * 就会把 undefined 当错误消息。这里按 abortKind 和 reason 两边归一，不是 abort 就原样交回。
 */
export function normalizeApiError(error, abortKind = "") {
  const kind = abortKind || (typeof error === "string" ? error : "");
  if (kind === "timeout" || error?.code === "timeout") return timedOut();
  const looksAborted = kind === "superseded"
    || error?.name === "AbortError"
    || error?.code === "canceled"
    || error === "superseded";
  return looksAborted ? canceled() : error;
}

/**
 * 提示文字只走 textContent：错误消息可能带着尖括号，绝不能拼进 innerHTML 变成标签。
 * 静态模板（“正在翻账本…”这类）继续用字面量 innerHTML 没问题。
 */
export function showNote(doc, container, className, text) {
  if (!container || typeof doc?.createElement !== "function") return null;
  container.textContent = "";
  const div = doc.createElement("div");
  div.className = className || "ch-empty";
  div.textContent = String(text ?? "");
  container.append(div);
  return div;
}

/**
 * 读一张图，全程只在本地变量里过，不发布。
 *
 * 两个 await（读文件、量尺寸）之后都验一次 stillMine()：切伙伴、移除图片、
 * 连着再选一张把这张顶掉，都返回 { ok:false, stale:true }，已经生成的 blobURL 顺手收回。
 * 调用方只在 ok 时把 image/url 写进 state，所以旧操作晚回也放不进新伙伴的草稿。
 */
export async function pickDraftImage(file, {
  stillMine = () => true,
  readAsDataURL,
  createObjectURL = (value) => URL.createObjectURL(value),
  revokeObjectURL = (value) => URL.revokeObjectURL(value),
  imageSize = async () => ({}),
  validate = () => ({ ok: true }),
} = {}) {
  const check = validate(file);
  if (!check?.ok) return { ok: false, stale: !stillMine(), reason: check?.reason || "这张图不行" };
  let url = "";
  let dataUrl = "";
  try {
    dataUrl = String(await readAsDataURL(file) || "");
  } catch (error) {
    return { ok: false, stale: !stillMine(), reason: String(error?.message || "这张图读不出来") };
  }
  if (!stillMine()) return { ok: false, stale: true, reason: "已取消" };
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!base64) return { ok: false, stale: false, reason: "这张图读不出来" };
  try {
    url = createObjectURL(file) || "";
  } catch {
    url = "";
  }
  let size = {};
  try {
    size = await imageSize(url);
  } catch {
    size = {};
  }
  if (!stillMine()) {
    if (url) revokeObjectURL(url);
    return { ok: false, stale: true, reason: "已取消" };
  }
  const image = { data: base64, mimeType: file?.type || "image/png", name: file?.name || "image" };
  // 尺寸只是锦上添花：拿不到（null/NaN/负数）就不带，绝不因为一个空对象去炸草稿
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (Number.isFinite(width) && width > 0) image.width = Math.round(width);
  if (Number.isFinite(height) && height > 0) image.height = Math.round(height);
  return { ok: true, image, url };
}

/**
 * 取一条语音并按归属决定要不要播。
 *
 * stillMine() 绑的是「原伙伴 + 原 row 还在 + 原世代」，每个 await 之后都过一遍；
 * 过期了就既不播、也不上报 voice.played。上报用的 agentId 是这一个参数，不是届时的 state。
 */
export async function playVoice({
  agentId,
  messageId,
  stillMine = () => true,
  loadBlob,
  createAudio = () => null,
  createObjectURL = (value) => URL.createObjectURL(value),
  revokeObjectURL = (value) => URL.revokeObjectURL(value),
  start = (audio) => audio.play(),
  abort = () => {},
  reportPlayed = () => {},
} = {}) {
  let url = "";
  let audio = null;
  const cleanup = () => {
    try {
      abort(audio);
    } catch {
      // 收尾出错不该盖住真错误
    }
    if (url) {
      try {
        revokeObjectURL(url);
      } catch {
        // 已释放
      }
      url = "";
    }
  };
  try {
    const blob = await loadBlob({ agentId, messageId });
    if (!stillMine()) return { status: "stale" };
    url = createObjectURL(blob) || "";
    audio = createAudio(url);
    if (!audio) {
      cleanup();
      return { status: "failed", reason: "这条语音还没准备好" };
    }
    if (!stillMine()) {
      cleanup();
      return { status: "stale" };
    }
    await start(audio);
    // 响起来了但人已经走了：立刻收掉，也不盖章
    if (!stillMine()) {
      cleanup();
      return { status: "stale" };
    }
    reportPlayed({ agentId, messageId });
    return { status: "played", audio, url };
  } catch (error) {
    const stale = !stillMine();
    cleanup();
    return stale ? { status: "stale" } : { status: "failed", reason: String(error?.message || error) };
  }
}

/**
 * 同一时刻只放一条：开新的先把旧的停掉（并由调用方把旧的样式/图标一起收）。
 * 返回被停掉的那几条，方便调用方断言/收尾。
 */
export function claimSinglePlayback(playing, audio, stop = () => {}) {
  const stopped = [];
  for (const other of [...(playing ?? [])]) {
    if (other === audio) continue;
    try {
      other?.pause?.();
    } catch {
      // 已经停了
    }
    playing?.delete?.(other);
    try {
      stop(other);
    } catch {
      // 收 UI 出错不影响开播
    }
    stopped.push(other);
  }
  return stopped;
}

/**
 * 把这一页接起来。纯逻辑在上面，这里只做 DOM 与网络，一笔状态都不外泄。
 *
 * 第二个参数只给测试用：采样背景主色那一步可以换掉（真实现要在浏览器里解图）。
 * 旧的调用 `startMobileClient(document)` 一字不改照样能用。
 */
export function startMobileClient(doc = document, { analyzeBackground = analyzeBackgroundUrl, createTools = createMobileTools } = {}) {
  const $ = (id) => doc.getElementById(id);
  const gate = $("gate");
  const home = $("home");
  const chat = $("chat");
  const list = $("list");
  const hint = $("hint");
  const errEl = $("err");
  const pw = $("pw");
  const msgs = $("msgs");
  const stateEl = $("state");
  const whoEl = $("who");
  const partnerBadge = $("partnerBadge");
  const input = $("input");
  const sendBtn = $("send");
  const tray = $("tray");
  const trayGrid = $("trayGrid");
  const trayCount = $("trayCount");
  const trayTabs = $("trayTabs");
  const linkDot = $("link");
  const draftBar = $("draft");
  const draftImg = $("draftImg");
  const draftName = $("draftName");
  const draftDrop = $("draftDrop");
  const quoteBar = $("quoteBar");
  const quoteText = $("quoteText");
  const quoteDrop = $("quoteDrop");
  const fileInput = $("pickImage");
  const overlay = $("overlay");
  const overlayImg = $("overlayImg");
  const overlayClose = $("overlayClose");
  const jumpBottom = $("jumpBottom");
  const stickerDraftBar = $("stickerDraft");
  const stickerDraftImg = $("stickerDraftImg");
  const stickerDraftName = $("stickerDraftName");
  const stickerDraftDrop = $("stickerDraftDrop");
  const traySearch = $("traySearch");
  const toolFavorites = $("toolFavorites");

  const imgBtnEl = $("imgBtn");
  const stickerBtnEl = $("stickerBtn");
  const TOKEN_KEY = "ch_mobile_auth";
  const seenKey = (id) => "ch_seen_" + id;

  const state = {
    agent: null,
    thread: createThreadState(),
    chatOpen: false,
    signature: "",
    melody: { meSkin: null, taSkin: null, showAvatars: false },
    quote: null,
    draftImage: null,
    draftUrl: "",
    // 草稿版本：每次她自己改正文/选图/引用都 +1，用来分辨“发出去之后又打了新的”
    draftRev: 0,
    stickerCache: { stickers: [], groups: [], filter: "" },
    // 待发的表情包：选了先进预览，点发送才真的发（与正文/引用一起走）
    draftSticker: null,
    // 这次草稿的幂等票：切回来、失败重试都用同一张
    draftClientId: "",
    // 本次会话内的草稿（按伙伴），只在内存里：明文聊天绝不下 localStorage
    drafts: new Map(),
    // 工具模块的世代：切伙伴/关聊天/登出都要变
    epoch: 0,
    // 展开过转写的消息 id（重画之后还开着）
    openTranscripts: new Set(),
    // 本地刚播过的语音（不靠等轮询才把未听圆点收掉）
    playedNow: new Set(),
    // turn.get 正在看的那一轮回复
    turn: null,
    // thread.get 带来的修整信息（工具模块要）
    messageRefine: null,
    // 还没在茶话会本体走完认识：手机上只提示回去，不开新入口
    needsOnboarding: false,
    // 正在一点点长出来的那一轮回复
    reveal: null,
    loadedAt: 0,
    // 已经画上去的那一页：按 id/内容/非本体三列记着，决定这次是补、只拨、还是重画
    rendered: { ids: [], cores: [], transients: [] },
    playing: new Set(),
    audioUrls: new Set(),
    readFor: "",
    failed: null,
    // 没发出去的那张票：按伙伴留在会话内存，重进还能重试
    failedPayload: null,
    loadingOlder: false,
    sse: null,
    sseTimer: null,
    sseDelay: 3000,
    pollTimer: null,
    link: "idle",
  };
  const tracker = createRequestTracker();
  const sends = createSendQueue();

  // ── 工具模块（收藏 / 图库 / 戳一戳）：只接线，面板由 mobile-tools.js 自己建 ──
  function contextOf() {
    const messages = state.thread.messages;
    let latestAssistantId = "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const row = messages[i];
      if (row?.role === "assistant" && row.id && !row.recalled) { latestAssistantId = String(row.id); break; }
    }
    return {
      agentId: String(state.agent?.id || state.thread.agentId || ""),
      epoch: state.epoch,
      messages,
      messageRefine: state.messageRefine,
      latestAssistantId,
      needsOnboarding: state.needsOnboarding === true,
    };
  }

  let toolsRefreshAt = 0;
  /** 线索变了才问工具那边要不要重算提案：静置轮询不会把它刷爆。 */
  function refreshTools(throttle = true) {
    if (!tools?.refreshProposals) return;
    const now = Date.now();
    if (throttle && now - toolsRefreshAt < 1500) return;
    toolsRefreshAt = now;
    try { void tools.refreshProposals(); } catch { /* 工具那边自己的事 */ }
  }

  const tools = typeof createTools === "function"
    ? createTools({
        doc,
        api,
        getContext: () => contextOf(),
        refreshThread: () => pull(),
        stopPlayback: () => stopPlayback(),
        notify: (text) => setStatus(text),
        closeMessageMenu: () => closeMenu(),
      })
    : null;

  const token = () => readTokenState(localStorage.getItem(TOKEN_KEY)).token;

  // ── 网络：统一带 Bearer，统一超时/取消 ──
  async function api(path, init = {}, { signal, timeoutMs = MOBILE_API_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    // 自己记下为什么 abort：fetch 那边 reject 出来的可能只是个字符串
    let abortKind = "";
    const timer = setTimeout(() => { abortKind = "timeout"; controller.abort("timeout"); }, timeoutMs);
    const forward = () => { abortKind = "superseded"; controller.abort("superseded"); };
    if (signal) {
      if (signal.aborted) { abortKind = "superseded"; controller.abort("superseded"); }
      else signal.addEventListener("abort", forward);
    }
    try {
      const res = await fetch("/api/" + path, {
        ...init,
        signal: controller.signal,
        headers: { authorization: "Bearer " + token(), ...(init.headers || {}) },
      });
      if (res.status === 401) { lockOut("密码过期了，再输一次"); throw canceled(); }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!body || !body.ok) throw new Error(body?.error?.message || "出错了");
      return body.data;
    } catch (error) {
      throw normalizeApiError(error, abortKind);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", forward);
    }
  }

  // ── 登录态 ──
  function lockOut(message) {
    localStorage.removeItem(TOKEN_KEY);
    state.agent = null;
    state.chatOpen = false;
    state.thread = createThreadState();
    state.signature = "";
    state.rendered = { ids: [], cores: [], transients: [] };
    state.epoch += 1;
    stopTurnWatch();
    stopPlayback();
    stopPolling();
    closeEvents();
    tracker.bump();
    clearBackground();
    sends.clearRetry();
    resetComposer();
    // 登出：草稿（含图的 blobURL）全清，明文一句不留
    clearAllDrafts();
    tools?.reset?.();
    // 登出：菜单、按压计时、剪贴板兼底框一起收
    closeMenu();
    clearPressTimer();
    hideCopyBox();
    paintPartnerBadge(null);
    chat.hidden = true;
    home.hidden = true;
    gate.hidden = false;
    setLink("idle");
    if (message) errEl.textContent = message;
  }

  function boot() {
    const saved = readTokenState(localStorage.getItem(TOKEN_KEY));
    if (!saved.valid) {
      if (saved.expired) lockOut("登录过太久了，再输一次密码");
      else { gate.hidden = false; home.hidden = true; chat.hidden = true; }
      return;
    }
    gate.hidden = true;
    home.hidden = false;
    chat.hidden = true;
    connectEvents();
    void loadPartners();
  }

  // ── 名单 ──
  const firstChar = (name) => { const t = String(name || "?").trim(); return t ? [...t][0] : "?"; };
  const previewOf = (row) => {
    const last = row?.last;
    if (!last) return "点开接着聊";
    const body = last.preview || (last.kind === "action" ? "戳了你一下" : last.kind === "sticker" ? "[表情]" : "新消息");
    return (last.role === "user" ? "我：" : "") + body;
  };
  const hasNew = (row) => {
    const last = row?.last;
    if (!last || last.role !== "assistant" || !last.at) return false;
    return String(last.at) > (localStorage.getItem(seenKey(row.id)) || "");
  };

  function avatarNode(className, agentId, fallbackText) {
    const box = doc.createElement("div");
    box.className = className;
    box.textContent = firstChar(fallbackText);
    const img = doc.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = "/avatar?agentId=" + encodeURIComponent(agentId);
    img.onload = () => { box.textContent = ""; box.append(img); };
    // 双击伙伴头像 = 戳一下（工具模块接）
    if (className === "msg-av" && agentId !== "__user") {
      box.addEventListener("dblclick", () => {
        if (!state.chatOpen || state.needsOnboarding === true) return;
        void tools?.poke?.();
      });
    }
    return box;
  }

  async function loadPartners() {
    const tokenRow = tracker.begin("partners");
    list.innerHTML = '<div class="ch-loading">正在翻账本…</div>';
    try {
      const rows = (await api("partners.list", {}, { signal: tokenRow.controller.signal })).filter((row) => !row.hidden);
      if (!tracker.isCurrent(tokenRow)) return;
      hint.textContent = rows.length ? rows.length + " 位" : "";
      list.innerHTML = "";
      if (!rows.length) {
        list.innerHTML = '<div class="ch-empty">还没得朋友，回电脑那边加一个嘛。</div>';
        return;
      }
      for (const row of rows) {
        const el = doc.createElement("div");
        el.className = "ch-friend";
        const meta = doc.createElement("div");
        meta.className = "ch-meta";
        const name = doc.createElement("span");
        name.textContent = row.name;
        const sub = doc.createElement("small");
        sub.textContent = previewOf(row);
        meta.append(name, sub);
        el.append(avatarNode("ch-av", row.id, row.name), meta);
        if (hasNew(row)) {
          const dot = doc.createElement("span");
          dot.className = "ch-dot";
          el.append(dot);
        }
        el.addEventListener("click", () => void openChat(row));
        list.append(el);
      }
    } catch (error) {
      if (isCanceled(error) || !tracker.isCurrent(tokenRow)) return;
      showNote(doc, list, "ch-empty", "没连上：" + String(error.message));
    } finally {
      tracker.settle(tokenRow);
    }
  }

  // ── 线程 ──
  function setLink(status) {
    state.link = status;
    if (!linkDot) return;
    linkDot.classList.toggle("on", status === "online");
    linkDot.classList.toggle("off", status === "offline");
    linkDot.title = status === "online" ? "在线" : status === "offline" ? "连接断了，正在重连" : "未连接";
  }

  function setStatus(text) { stateEl.textContent = String(text || "") || pinnedNote; }

  // ── 伙伴状态徽章：与桌面同一套外观与图标 ──
  function makeBadgeIcon(icon) {
    const svg = typeof doc.createElementNS === "function"
      ? doc.createElementNS("http://www.w3.org/2000/svg", "svg")
      : doc.createElement("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of BADGE_ICON_PATHS[icon] || BADGE_ICON_PATHS.custom) {
      const path = typeof doc.createElementNS === "function"
        ? doc.createElementNS("http://www.w3.org/2000/svg", "path")
        : doc.createElement("path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  /**
   * 画伙伴当前的徽章（在线/忙/睡觉/自定义…）。
   *
   * 全部走 textContent 与属性：账上的字可能是任意字符串，不拼 innerHTML。
   * 空串/没历史 -> 直接藏；未知类型走 custom 兑底。右侧那颗绿点是「连接」不是「状态」，
   * 两边各管各的（setLink 不碰这里）。
   */
  function paintPartnerBadge(badge) {
    if (!partnerBadge) return;
    const label = badgeLabelOf(badge);
    const visual = badgeVisual(badge);
    partnerBadge.hidden = !label;
    partnerBadge.className = `chat-state-badge state-badge--${visual.tone}`;
    partnerBadge.textContent = "";
    if (label) {
      const mark = doc.createElement("span");
      mark.className = "state-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.append(makeBadgeIcon(visual.icon));
      const text = doc.createElement("span");
      text.textContent = label;
      partnerBadge.append(mark, text);
    }
    partnerBadge.title = String(badge?.description || "").trim() || (label ? `当前状态：${label}` : "");
    partnerBadge.setAttribute("aria-label", label ? `当前状态：${label}` : "当前状态未知");
  }

  // ── 还没认识：写入口一律关掉，只提示回本体走完 ──
  let pinnedNote = "";

  function applyOnboardingGate() {
    const pending = state.needsOnboarding === true;
    pinnedNote = pending ? "先在茶话会本体完成认识" : "";
    if (imgBtnEl) imgBtnEl.disabled = pending;
    if (stickerBtnEl) stickerBtnEl.disabled = pending;
    refreshSendButton();
    setStatus("");
  }

  // ── 一轮回复：打字 / 读回执 / 逐条呈现 ──
  //
  // turn.send 回 queued 时不在前台等（宿主那轮可能很长），而是按 turnId 看状态：
  // 先打三个点，完了再拉一次线程（拉回来的是真消息，不为了“逐条蹦”另叫一次模型）。
  let turnTimer = null;
  let readAfterTimer = null;

  function clearTyping() {
    for (const node of [...(msgs.children ?? [])]) {
      if (String(node?.className ?? "").includes("ch-typing")) node.remove();
    }
  }

  function paintTyping(on) {
    clearTyping();
    if (!on || !state.chatOpen) return;
    const typing = doc.createElement("div");
    typing.className = "typing ch-typing";
    typing.setAttribute("aria-label", "ta 正在写");
    for (let i = 0; i < 3; i += 1) typing.append(doc.createElement("i"));
    msgs.append(typing);
    if (isNearBottom(msgs)) scrollBottom();
  }

  function stopTurnWatch() {
    if (turnTimer) clearTimeout(turnTimer);
    if (readAfterTimer) clearTimeout(readAfterTimer);
    turnTimer = null;
    readAfterTimer = null;
    state.turn = null;
    clearTyping();
    clearReveal();
  }

  // ── 回复在气泡里一点点长出来 ──
  // 只在「这一轮刚回完、这条回复确实是新出现的」时候演：分钟级轮询/SSE 看到的旧回复
  // 绝不倒带重播。演的是**那一枚气泡自己的原文**（不是整条 message.text）：
  // 分段与间隔用当前 ready 的 items（只在和这一片完全一致时），否则按句读短间隔；
  // 语音整条呈现，不先演文字。
  let revealTimers = [];

  /** 这枚气泡要演的原文：先认它自己记着的 piece，没有才退到 message.bubbles 末片。 */
  function revealPieceOf(bubble, message) {
    const own = String(bubble?.__pieceText ?? "");
    if (own.trim()) return own;
    const pieces = Array.isArray(message?.bubbles)
      ? message.bubbles.map((piece) => String(piece ?? "")).filter((piece) => piece.trim())
      : [];
    if (pieces.length) return pieces[pieces.length - 1];
    return String(message?.text ?? "");
  }

  /**
   * 撤掉还在飞的定时器。restore=true 时：若这一条还在、没撤回、core 没变、
   * 气泡还挂在屏幕上，就把完整那一片安全地写回去——否则会留一辈子半截文案。
   */
  function clearReveal({ restore = true } = {}) {
    const token = state.reveal;
    for (const timer of revealTimers) clearTimeout(timer);
    revealTimers = [];
    state.reveal = null;
    if (!restore || !token || !token.bubble) return;
    if (!state.chatOpen) return;
    if (msgs?.contains?.(token.bubble) === false) return;
    if (token.bubble.isConnected === false) return;
    const live = state.thread.messages.find((row) => String(row?.id ?? "") === token.messageId);
    // 改过稿、撤回、换人就别把旧原文再塞回去
    if (!live || live.recalled) return;
    if (coreSignatureOf(live) !== token.core) return;
    paintRichText(token.bubble, token.fullText);
    token.bubble.__pieceText = token.fullText;
  }

  /** 一棵子树里的气泡（按文档顺序），用于找「最后那条正文气泡」。 */
  function bubblesIn(node) {
    const out = [];
    const stack = [...(node?.children ?? [])];
    while (stack.length) {
      const child = stack.shift();
      const classes = String(child?.className ?? "").split(/\s+/);
      if (classes.includes("bubble")) { out.push(child); continue; }
      stack.push(...(child?.children ?? []));
    }
    return out;
  }

  function revealInto(messageId, message, items) {
    if (!message || message.voice || message.recalled) return false;
    if (message.role !== "assistant") return false;
    const col = feedCols.get(String(messageId ?? ""));
    if (!col) return false;
    const bubbles = bubblesIn(col);
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble) return false;
    // 只演这一枚气泡自己的原文：多气泡的消息不能把前面那几句再塞进最后一泡
    const text = revealPieceOf(bubble, message);
    if (!text) return false;
    const segments = revealSegments(text, items);
    if (segments.length <= 1) return false;
    clearReveal();
    const token = {
      messageId: String(messageId ?? ""),
      bubble,
      fullText: text,
      core: coreSignatureOf(message),
    };
    state.reveal = token;
    let shown = "";
    const step = (index) => {
      // 每一步都重新核归属：切人/关页/改稿/撤回之后，旧定时器一个字都不许画
      if (state.reveal !== token) return;
      if (!state.chatOpen || msgs?.contains?.(bubble) === false) { clearReveal({ restore: false }); return; }
      const live = state.thread.messages.find((row) => String(row?.id ?? "") === token.messageId);
      if (!live || live.recalled || coreSignatureOf(live) !== token.core) { clearReveal({ restore: false }); return; }
      shown += segments[index].text;
      paintRichText(bubble, shown);
      if (isNearBottom(msgs)) scrollBottom();
      const next = segments[index + 1];
      if (!next) { state.reveal = null; revealTimers = []; return; }
      const timer = setTimeout(() => step(index + 1), next.gap);
      revealTimers.push(timer);
    };
    step(0);
    return true;
  }

  /** 这一轮是不是已经没得看了：服务端说结束/过期都算正常收尾。 */
  function turnEnded(data) {
    const status = String(data?.status ?? "");
    if (["missing", "expired", "gone", "ended", "closed"].includes(status)) return true;
    return Boolean(data?.ended === true);
  }

  function scheduleReadAfter(agentId, generation, ms) {
    if (readAfterTimer) clearTimeout(readAfterTimer);
    readAfterTimer = setTimeout(() => {
      readAfterTimer = null;
      if (!state.chatOpen || state.agent?.id !== agentId || tracker.generation() !== generation) return;
      void pull();
    }, Math.min(Math.max(0, ms), 120000));
  }

  function watchTurn(agentId, turnId, generation) {
    stopTurnWatch();
    state.turn = { agentId, turnId, generation, tries: 0 };
    paintTyping(true);
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => { turnTimer = null; void pollTurn(); }, 1200);
  }

  async function pollTurn() {
    const turn = state.turn;
    if (!turn) return;
    if (!state.chatOpen || state.agent?.id !== turn.agentId || tracker.generation() !== turn.generation) {
      stopTurnWatch();
      return;
    }
    turn.tries += 1;
    try {
      const data = await api(`turn.get?agentId=${encodeURIComponent(turn.agentId)}&turnId=${encodeURIComponent(turn.turnId)}`);
      // 晚回来的：已经换人/换世代/关了，一个字都不动
      if (!state.turn || state.turn.turnId !== turn.turnId) return;
      if (!state.chatOpen || state.agent?.id !== turn.agentId || tracker.generation() !== turn.generation) {
        stopTurnWatch();
        return;
      }
      const status = String(data?.status ?? "");
      // 不存在/已过期：正常停下，不再报错也不重试
      if (turnEnded(data)) {
        stopTurnWatch();
        setStatus("这一轮已经结束了");
        return;
      }
      if (status === "failed" || status === "error") {
        stopTurnWatch();
        setStatus(String(data?.error || "这句没接上"));
        return;
      }
      // 有真消息就以它为准（items 只当节奏，不当正文）：按 replyMessageId 去重
      const current = data?.message && typeof data.message === "object" ? data.message : null;
      const replyId = String(data?.replyMessageId || current?.id || "");
      if (current || replyId) {
        const readAfterMs = Number(data?.readAfterMs) || 0;
        const existing = replyId
          ? state.thread.messages.find((row) => String(row?.id ?? "") === replyId)
          : null;
        // 同 id 但内容变了（改稿/语音转好）不能因为“见过这个 id”就跳过
        const unchanged = Boolean(existing) && Boolean(current) && coreSignatureOf(existing) === coreSignatureOf(current);
        const known = Boolean(existing) && !current;
        stopTurnWatch();
        if (readAfterMs > 0) scheduleReadAfter(turn.agentId, turn.generation, readAfterMs);
        if (!unchanged && !known) {
          await pull();
          // 真新出现的文本回复：在它自己的气泡里按当前正文逐步长出来
          if (current && !existing) revealInto(replyId || current.id, current, Array.isArray(data?.items) ? data.items : undefined);
        }
        refreshTools(true);
        return;
      }
      // 说完了但没跟 message：拉一次线程就收
      if (["done", "ready", "complete", "completed"].includes(status)) {
        stopTurnWatch();
        await pull();
        refreshTools(true);
        return;
      }
      if (turn.tries >= 40) {
        stopTurnWatch();
        setStatus("ta 还在写，过会儿下拉看看");
        return;
      }
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = setTimeout(() => { turnTimer = null; void pollTurn(); }, 1200);
    } catch (error) {
      if (isCanceled(error)) return;
      if (!state.turn || state.turn.turnId !== turn.turnId) return;
      stopTurnWatch();
      if (!state.chatOpen || state.agent?.id !== turn.agentId) return;
      const text = String(error?.message || "");
      // 回合已经结束/查不到：正常收尾，不神经质地报错
      if (/结束|不存在|过期|expired|gone|not.?found/i.test(text)) { setStatus("这一轮已经结束了"); return; }
      setStatus(text || "等不到回话了，下拉看看");
    }
  }

  function teardownMedia() {
    for (const audio of state.playing) {
      try { audio.pause(); } catch { /* 已经停了 */ }
    }
    state.playing.clear();
    // 只在 audioUrls 里统一 revoke：已经 pause/播完、从 playing 里被删掉的 audio
    // 只能靠这个集合才收得到，不再对 audio.src 重复 revoke。
    for (const url of state.audioUrls) {
      try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
    }
    state.audioUrls.clear();
  }

  function stopPlayback() {
    teardownMedia();
    for (const box of msgs.querySelectorAll(".voice-bubble.is-playing")) box.classList.remove("is-playing");
  }

  function attachmentNode(message) {
    const img = doc.createElement("img");
    img.className = "ch-img";
    img.alt = message?.attachment?.name || "图片";
    img.loading = "lazy";
    const src = `/attachment?agentId=${encodeURIComponent(state.thread.agentId)}&attachmentId=${encodeURIComponent(message?.attachment?.id ?? "")}`;
    img.dataset.src = src;
    // 只把快进视口的那几张真的拉下来：一条长聊天里几十张图不至于一起压过来。
    if (typeof IntersectionObserver === "function") {
      const seen = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          seen.disconnect();
          img.src = img.dataset.src;
        }
      }, { root: msgs, rootMargin: "300px 0px" });
      seen.observe(img);
    } else {
      img.src = src;
    }
    img.addEventListener("click", () => {
      // 长按刚开过菜单：这一下不算，不要顺手把大图弹出来
      if (consumeLongPressClick()) return;
      openOverlay(src);
    });
    return img;
  }

  function openOverlay(src) {
    if (!overlay || !overlayImg) return;
    overlayImg.src = src;
    overlay.hidden = false;
  }

  function quoteStrip(quote) {
    const strip = doc.createElement("div");
    strip.className = "ch-quote-strip";
    const label = doc.createElement("span");
    const text = String(quote?.text ?? "");
    // 不在字符串里硬截：CSS 里限三行，点一下（title）能看全文
    label.textContent = "引用：" + text;
    strip.title = text;
    strip.append(label);
    return strip;
  }

  /** 真 DOM 里文字用文本节点，假 DOM（测试）退回一个 span：两边 textContent 一样。 */
  function textNode(text) {
    if (typeof doc.createTextNode === "function") return doc.createTextNode(String(text ?? ""));
    const span = doc.createElement("span");
    span.textContent = String(text ?? "");
    return span;
  }

  /**
   * 写正文：纯文字走 textContent，裸链接做成安全的锚点（只认 http/https）。
   * 全程不用 innerHTML：账上的字可以带尖括号，拼进去就是注入口子。
   */
  function paintRichText(node, text) {
    node.textContent = "";
    for (const segment of splitLinkSegments(text)) {
      if (segment.type === "link") {
        const anchor = doc.createElement("a");
        anchor.className = "ch-text-link";
        anchor.setAttribute("href", segment.href);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.href = segment.href;
        anchor.textContent = segment.text;
        node.append(anchor);
        continue;
      }
      node.append(textNode(segment.text));
    }
  }

  function bubbleEl(text) {
    const stickerId = stickerIdOf(text);
    if (stickerId) {
      const img = doc.createElement("img");
      img.className = "sticker";
      img.alt = "表情";
      img.decoding = "async";
      img.src = `/sticker?agentId=${encodeURIComponent(state.thread.agentId)}&id=${encodeURIComponent(stickerId)}`;
      img.onerror = () => {
        const fallback = doc.createElement("div");
        fallback.className = "bubble";
        fallback.textContent = "[表情]";
        img.replaceWith(fallback);
      };
      return img;
    }
    const b = doc.createElement("div");
    b.className = "bubble";
    paintRichText(b, text);
    return b;
  }

  /** 时间刻度：隔了一阵才落下的那一波。 */
  function timeDividerNode(text) {
    const div = doc.createElement("div");
    div.className = "time-divider";
    div.textContent = text;
    return div;
  }

  function messageTimeNode(at) {
    const text = messageTimeText(at);
    if (!text) return null;
    const node = doc.createElement("div");
    node.className = "ch-msg-time";
    node.textContent = text;
    return node;
  }

  /**
   * 最后一句自己的话下方的「未读」：外形、颜色、小圆点用 panel.css 的 .tick（本体同款）。
   * 手机不另写样式，也不写死粉色。
   */
  function readStateNode() {
    const node = doc.createElement("div");
    node.className = "tick ch-read-state";
    node.textContent = "未读";
    return node;
  }

  function voiceDotNode() {
    const dot = doc.createElement("span");
    dot.className = "voice-unplayed-dot";
    dot.title = "还没听";
    return dot;
  }

  // ── 语音：取、归属、只放一条 ──
  function rowVoiceMarks(row, box, icon) {
    return { row, box, icon };
  }

  function clearVoiceMarks(marks) {
    const { row, box, icon } = marks || {};
    if (box) {
      box.classList.remove("is-playing", "is-loading");
      for (const bar of box.querySelectorAll(".voice-wave i")) bar.classList.remove("done");
    }
    if (icon) icon.textContent = "▶";
    if (row?._audio) {
      try {
        row._audio.pause();
      } catch {
        // 已经停了
      }
      state.playing.delete(row._audio);
    }
  }

  /** 新的一条开播前，把别的先停掉，并把它们的样式/图标/Set 一起收干净。 */
  function pauseOtherVoices(audio) {
    claimSinglePlayback(state.playing, audio, (other) => {
      if (other?._voiceMarks) clearVoiceMarks(other._voiceMarks);
    });
  }

  function wireVoice(audio, marks) {
    const { box, icon } = marks;
    audio._voiceMarks = marks;
    audio.onended = () => {
      box?.classList.remove("is-playing");
      if (icon) icon.textContent = "▶";
      for (const bar of box?.querySelectorAll(".voice-wave i") || []) bar.classList.remove("done");
      state.playing.delete(audio);
    };
    audio.ontimeupdate = () => {
      const bars = box?.querySelectorAll(".voice-wave i") || [];
      const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
      const lit = Math.round(bars.length * Math.max(0, Math.min(1, ratio)));
      bars.forEach((bar, index) => bar.classList.toggle("done", index < lit));
    };
  }

  function markVoicePlaying(marks) {
    const { box, icon } = marks;
    box?.classList.remove("is-loading");
    box?.classList.add("is-playing");
    if (icon) icon.textContent = "❚❚";
  }

  function fetchVoiceBlob(agentId, messageId, signal) {
    return fetch(
      `/voice?agentId=${encodeURIComponent(agentId)}&messageId=${encodeURIComponent(messageId)}`,
      { headers: { authorization: "Bearer " + token() }, signal },
    ).then(async (res) => {
      if (res.status === 401) { lockOut("密码过期了，再输一次"); throw canceled(); }
      if (!res.ok) throw new Error("这条语音还没准备好");
      return res.blob();
    });
  }

  function reportVoicePlayed(agentId, messageId) {
    // 用开播前捕获的 agentId：这时哪怕已经切到别人，也不会把“听过”盖到新伙伴头上
    void api("voice.played", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, messageId }),
    }).catch(() => {});
  }

  /** 本地刚播过：未听圆点当场收掉，不等下一轮轮询。 */
  function markVoiceHeard(message) {
    const id = String(message?.id ?? "");
    if (!id) return false;
    state.playedNow.add(id);
    const dot = voiceDots.get(id);
    if (dot) dot.hidden = true;
    if (message.voice && !message.voice.playedAt) message.voice.playedAt = new Date().toISOString();
    return true;
  }

  async function toggleVoice(message, row, box, icon) {
    if (!box) return;
    const agentId = state.agent?.id || state.thread.agentId;
    const marks = rowVoiceMarks(row, box, icon);

    // 已经在放这一条：暂停，并把样式/图标/Set 一起收（不只是 audio.pause）
    if (row._audio && !row._audio.paused) {
      clearVoiceMarks(marks);
      return;
    }

    // 复播：音频已经有了，仍然要过“原伙伴 + row 还在 + 世代”这三道
    if (row._audio) {
      const audio = row._audio;
      if (state.agent?.id !== agentId || row.isConnected === false || !state.chatOpen) return;
      pauseOtherVoices(audio);
      wireVoice(audio, marks);
      markVoicePlaying(marks);
      state.playing.add(audio);
      try {
        await audio.play();
      } catch {
        clearVoiceMarks(marks);
        return;
      }
      if (state.agent?.id !== agentId || row.isConnected === false || !state.chatOpen) {
        clearVoiceMarks(marks);
        return;
      }
      reportVoicePlayed(agentId, message.id);
      markVoiceHeard(message);
      return;
    }

    const ticket = tracker.begin("voice:" + agentId + ":" + message.id);
    const stillMine = () => tracker.isCurrent(ticket) && state.agent?.id === agentId && state.chatOpen && row.isConnected !== false;
    box.classList.add("is-loading");
    let result;
    try {
      result = await playVoice({
        agentId,
        messageId: message.id,
        stillMine,
        loadBlob: ({ agentId: who, messageId }) => fetchVoiceBlob(who, messageId, ticket.controller.signal),
        createAudio: (url) => new Audio(url),
        // 建出来就记账，收回时同步出账：teardownMedia 只靠这个集合兜底
        createObjectURL: (blob) => {
          const url = URL.createObjectURL(blob);
          state.audioUrls.add(url);
          return url;
        },
        revokeObjectURL: (url) => {
          state.audioUrls.delete(url);
          try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
        },
        start: async (audio) => {
          pauseOtherVoices(audio);
          row._audio = audio;
          wireVoice(audio, marks);
          markVoicePlaying(marks);
          state.playing.add(audio);
          await audio.play();
        },
        abort: (audio) => {
          clearVoiceMarks(marks);
          if (audio && row._audio === audio) row._audio = null;
        },
        reportPlayed: ({ agentId: who, messageId }) => {
          reportVoicePlayed(who, messageId);
          markVoiceHeard(message);
        },
      });
    } finally {
      tracker.settle(ticket);
      box.classList.remove("is-loading");
    }

    if (result.status === "stale") return;
    if (result.status === "failed") {
      setStatus(result.reason || "这条语音还没准备好");
    }
  }

  function voiceRow(message, partnerName) {
    const mine = message.role === "user";
    const row = doc.createElement("div");
    row.className = "row voice-row " + (mine ? "me" : "ta");
    const col = doc.createElement("div");
    col.className = "msg-col voice-col";
    const line = doc.createElement("div");
    line.className = "msg-line voice-controls-line";
    const box = doc.createElement("div");
    box.className = "bubble voice-bubble";
    const main = doc.createElement("div");
    main.className = "voice-main";
    const play = doc.createElement("button");
    play.type = "button";
    play.className = "voice-play";
    play.setAttribute("aria-label", "播放语音");
    const icon = doc.createElement("span");
    icon.className = "voice-play-icon";
    icon.textContent = "▶";
    play.append(icon);
    const wave = doc.createElement("span");
    wave.className = "voice-wave";
    for (let i = 0; i < 11; i += 1) wave.append(doc.createElement("i"));
    const duration = doc.createElement("span");
    duration.className = "voice-duration";
    duration.textContent = formatDuration(message.voice?.durationMs);
    main.append(play, wave, duration);
    // 未听圆点：伙伴发来的语音，听过（账上 playedAt）或刚在本地放过就收起来
    let dot = null;
    if (!mine) {
      dot = voiceDotNode();
      const heard = Boolean(message.voice?.playedAt) || state.playedNow.has(String(message.id ?? ""));
      dot.hidden = heard;
      if (message.id) voiceDots.set(String(message.id), dot);
      main.append(dot);
    }
    if (message.quote?.messageId) box.append(quoteStrip(message.quote));
    box.append(main);
    line.append(box);
    col.append(line);
    const spoken = String(message.voice?.text || message.text || "").trim();
    if (spoken) {
      const key = String(message.id ?? "");
      // 展开过就记在 messageId 上：整段重画之后还开着，不用再点一次
      const opened = state.openTranscripts.has(key);
      const toggle = doc.createElement("button");
      toggle.type = "button";
      toggle.className = "voice-transcript-toggle";
      toggle.textContent = opened ? "收起文字" : "转文字";
      const transcriptLine = doc.createElement("div");
      transcriptLine.className = "msg-line voice-transcript-line";
      transcriptLine.hidden = !opened;
      const transcript = doc.createElement("div");
      transcript.className = "bubble voice-transcript";
      transcript.hidden = !opened;
      paintRichText(transcript, spoken);
      transcriptLine.append(transcript);
      toggle.addEventListener("click", () => {
        const open = Boolean(transcriptLine.hidden);
        transcript.hidden = !open;
        transcriptLine.hidden = !open;
        toggle.textContent = open ? "收起文字" : "转文字";
        if (open) state.openTranscripts.add(key);
        else state.openTranscripts.delete(key);
      });
      line.append(toggle);
      col.append(transcriptLine);
    }
    // 语音只念得出能读的那几句：音词之外的气泡（分享链接、补充说明）照旧摆回来
    for (const leftover of voiceLeftoverBubbles(message)) {
      const leaveLine = doc.createElement("div");
      leaveLine.className = "msg-line voice-leftover-line";
      const speech = bubbleEl(leftover);
      // 每一小泡记着自己的原文：长按它复制/引用的是这一句，不是整条语音
      if (speech && speech.tag !== "img") speech.__pieceText = String(leftover);
      leaveLine.append(speech);
      col.append(leaveLine);
    }
    // 时间跟着第一条语音控件行一起走（不挂转写/附带文），行内绝对定位到外侧
    const stamp = messageTimeNode(message.at);
    if (stamp) line.append(stamp);
    play.addEventListener("click", () => {
      // 长按刚开过菜单：这一下不算（普通点击照旧）
      if (consumeLongPressClick()) return;
      void toggleVoice(message, row, box, icon);
    });
    paintFeed(col, message);
    if (message.id) feedCols.set(String(message.id), col);
    if (state.melody.showAvatars) row.append(avatarNode("msg-av", mine ? "__user" : state.thread.agentId, mine ? "我" : partnerName), col);
    else row.append(col);
    bindMessageMenu(row, message);
    return row;
  }

  function renderAction(message) {
    const row = doc.createElement("div");
    row.className = "poke-row";
    const line = doc.createElement("span");
    line.className = "poke-line";
    line.textContent = message.text || "";
    row.append(line);
    // 戳一戳/动作也开管理菜单：工具只给它删除（自己那条按本体给撤回），不冒充聊天消息
    bindMessageMenu(row, message);
    return row;
  }

  // ── 消息菜单：长按 / 右键 / Shift+F10 ──
  //
  // 形状、颜色、阴影全用本体的 .message-feed-menu（手机页只把按钮放大到 42px、
  // 八枚排成 4×2），这里只管摆位置、办动作、收尾。
  // 打开时就把伙伴与其世代定死：晚回来的包不许落到新伙伴身上。
  const menuHost = doc.body || chat;
  const feedMenu = doc.createElement("div");
  feedMenu.className = "message-feed-menu";
  feedMenu.hidden = true;
  feedMenu.setAttribute("aria-label", "消息菜单");
  menuHost.append(feedMenu);
  const copyBox = doc.createElement("div");
  copyBox.className = "ch-copy-box";
  copyBox.hidden = true;
  menuHost.append(copyBox);

  /** 消息 id → 气泡列：投喂成功只重画这一处挂件，不整段重绘。 */
  const feedCols = new Map();
  /** 消息 id → 未听圆点 / 已读小字：只变这几样的时候原地拨，不重画气泡。 */
  const voiceDots = new Map();
  const readStateNodes = new Map();
  /** 正在飞的菜单动作（投喂/收藏）：同一枚还没回来之前，再点都不发第二份。 */
  const actionBusy = new Set();

  let menuRow = null;
  let menuMessage = null;
  let menuAgent = "";
  let menuGeneration = 0;
  let menuText = "";
  let pressTimer = null;
  let pressOrigin = null;
  let suppressClickUntil = 0;

  function closeMenu() {
    if (!feedMenu) return;
    feedMenu.hidden = true;
    feedMenu.textContent = "";
    menuRow?.classList.remove("feed-open");
    menuRow = null;
    menuMessage = null;
    menuAgent = "";
    menuText = "";
  }

  function clearPressTimer() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    pressOrigin = null;
  }

  function hideCopyBox() {
    if (!copyBox) return;
    copyBox.hidden = true;
    copyBox.textContent = "";
  }

  function viewportOf() {
    const view = doc.defaultView || (typeof window === "undefined" ? null : window);
    return { width: Number(view?.innerWidth) || 0, height: Number(view?.innerHeight) || 0 };
  }

  function rectOf(node) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : Number(rect.top) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
    };
  }

  /** 这条还在不在、撤没撤：动作发出去之前先在当前线程里核一次。 */
  function targetAlive(agentId, messageId) {
    if (!agentId || !messageId || !state.chatOpen) return false;
    if (state.agent?.id !== agentId || state.thread.agentId !== agentId) return false;
    const row = state.thread.messages.find((message) => message?.id === messageId);
    return Boolean(row) && !row.recalled;
  }

  /** 长按开完菜单的那一下点图/点语音不算数；只管一次。 */
  function consumeLongPressClick() {
    if (!suppressClickUntil) return false;
    if (Date.now() > suppressClickUntil) {
      suppressClickUntil = 0;
      return false;
    }
    suppressClickUntil = 0;
    return true;
  }

  function menuActionButton(label, handler) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "message-menu-action";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function openMenu(row, message, pieceText = "") {
    if (!row || row.isConnected === false || !actionableMessage(message)) return;
    if (!targetAlive(state.thread.agentId, message.id)) return;
    closeMenu();
    clearPressTimer();
    menuRow = row;
    menuMessage = message;
    menuAgent = String(state.thread.agentId || state.agent?.id || "");
    menuGeneration = tracker.generation();
    // 选中文字优先；没选中就用这次点中的那一小泡；纯空白才回落整条
    menuText = selectedTextOf(doc, row) || String(pieceText ?? "").trim();
    feedMenu.textContent = "";
    const action = actionKind(message);
    const feedable = !action && feedableMessage(message);
    if (feedable) {
      const emojiRow = doc.createElement("div");
      emojiRow.className = "message-feed-emojis";
      const already = new Set(messageFeedItems(message.feed).map((item) => item.emoji));
      for (const emoji of FEED_EMOJIS) {
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = emoji;
        button.title = `投喂${emoji}`;
        button.className = already.has(emoji) ? "is-selected" : "";
        button.disabled = actionBusy.has(`feed:${menuAgent}:${message.id}`);
        button.addEventListener("click", () => void feedMessage(message, emoji));
        emojiRow.append(button);
      }
      const divider = doc.createElement("span");
      divider.className = "message-feed-divider";
      feedMenu.append(emojiRow, divider);
    }
    const actionRow = doc.createElement("div");
    actionRow.className = "message-feed-actions";
    if (!action) {
      actionRow.append(
        menuActionButton("复制", () => void copyMessage(message)),
        menuActionButton("引用", () => quoteMessage(message)),
      );
      // 收藏是伙伴那条的事：她自己的话没有「收藏」这个动作
      if (feedable) actionRow.append(menuActionButton("收藏", () => void toggleFavorite(message)));
    }
    // 管理类动作（删除/撤回/编辑/再生成…）由工具模块自己决定要不要摆，这里只给一个容器
    tools?.appendMessageActions?.(actionRow, message);
    // 戳一戳/动作只有管理动作：工具没给就不开一个空菜单
    if (action && !(actionRow.children?.length)) return;
    feedMenu.append(actionRow);
    row.classList.add("feed-open");
    feedMenu.hidden = false;
    // 先摆到屏外量一次尺寸，再按视口夹回来（窄屏上贴着右边的气泡不会溢出）
    feedMenu.style.setProperty("left", "-9999px");
    feedMenu.style.setProperty("top", "0px");
    const place = menuPlacement(rectOf(row.querySelector?.(".bubble") || row), rectOf(feedMenu), viewportOf());
    feedMenu.classList.toggle("below", place.below);
    feedMenu.style.setProperty("left", `${place.left}px`);
    feedMenu.style.setProperty("top", `${place.top}px`);
  }

  async function feedMessage(message, emoji) {
    const agentId = menuAgent;
    const messageId = String(message?.id ?? "");
    const generation = menuGeneration || tracker.generation();
    if (!agentId || !messageId || !FEED_EMOJIS.includes(emoji)) return;
    if (!targetAlive(agentId, messageId)) {
      closeMenu();
      setStatus("这条已经不在了");
      return;
    }
    const key = `feed:${agentId}:${messageId}`;
    // 同条消息单飞，防不同投喂的回包乱序把新份数盖成旧份数
    if (actionBusy.has(key)) return;
    actionBusy.add(key);
    closeMenu();
    try {
      const data = await api("message.feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, messageId, emoji }),
      });
      // 晚回包：换了伙伴或换了世代，一个字都不动
      if (state.agent?.id !== agentId || tracker.generation() !== generation) return;
      if (!targetAlive(agentId, messageId)) return;
      const target = state.thread.messages.find((row) => row?.id === messageId);
      if (data?.feed) {
        // 只认宿主回的那份账：结果不明时绝不自己 +1，否则刷新后凭空多出一杯
        target.feed = data.feed;
        paintFeed(feedCols.get(messageId) || null, target);
        state.signature = signatureOf(state.thread.messages);
      }
      setStatus(`已投喂 ${emoji}`);
    } catch (error) {
      if (state.agent?.id !== agentId || tracker.generation() !== generation) return;
      if (isCanceled(error)) return;
      setStatus(String(error?.message || "这次投喂没放上"));
    } finally {
      actionBusy.delete(key);
    }
  }

  async function toggleFavorite(message) {
    const agentId = menuAgent;
    const messageId = String(message?.id ?? "");
    const generation = menuGeneration || tracker.generation();
    if (!agentId || !messageId) return;
    if (!targetAlive(agentId, messageId)) {
      closeMenu();
      setStatus("这条已经不在了");
      return;
    }
    const key = `favorite:${agentId}:${messageId}`;
    if (actionBusy.has(key)) return;
    actionBusy.add(key);
    closeMenu();
    try {
      const data = await api("message.favorite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, messageId }),
      });
      if (state.agent?.id !== agentId || tracker.generation() !== generation) return;
      setStatus(data?.favorite ? "收藏好了" : "已取消收藏");
    } catch (error) {
      if (state.agent?.id !== agentId || tracker.generation() !== generation) return;
      if (isCanceled(error)) return;
      setStatus(String(error?.message || "这条消息没收藏上"));
    } finally {
      actionBusy.delete(key);
    }
  }

  /**
   * 写剪贴板：navigator 先试，再退到 textarea + execCommand。
   * 两层都过不了就交回空串——调用方会把正文摆出来让她自己长按复制，不谎报“复制好了”。
   */
  async function writeClipboard(text, stillMine) {
    const value = String(text ?? "");
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard?.writeText) {
        await clipboard.writeText(value);
        return "navigator";
      }
    } catch {
      // 被浏览器策略拒了，退下一层
    }
    if (!stillMine()) return "";
    const previousFocus = doc.activeElement;
    let helper;
    try {
      helper = doc.createElement("textarea");
      helper.value = value;
      helper.setAttribute("readonly", "");
      helper.setAttribute("aria-hidden", "true");
      helper.style.setProperty("position", "fixed");
      helper.style.setProperty("left", "-9999px");
      (doc.body || chat).append(helper);
      helper.focus?.({ preventScroll: true });
      helper.select?.();
      helper.setSelectionRange?.(0, value.length);
      if (typeof doc.execCommand === "function" && doc.execCommand("copy")) return "exec";
    } catch {
      // 老办法也不行，交给只读文本框
    } finally {
      helper?.remove();
      if (stillMine()) previousFocus?.focus?.({ preventScroll: true });
    }
    return "";
  }

  function showCopyBox(text) {
    copyBox.textContent = "";
    const area = doc.createElement("textarea");
    area.setAttribute("readonly", "readonly");
    area.setAttribute("aria-label", "要复制的文字");
    area.value = String(text ?? "");
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "关上";
    close.addEventListener("click", () => hideCopyBox());
    copyBox.append(area, close);
    copyBox.hidden = false;
  }

  function messageCopyText(message) {
    return String(menuText ?? "").trim() || messageTextOf(message);
  }

  async function copyMessage(message) {
    const agentId = menuAgent;
    const generation = menuGeneration;
    const stillMine = () => tracker.generation() === generation && targetAlive(agentId, message.id);
    if (!stillMine()) { closeMenu(); return; }
    const text = messageCopyText(message);
    closeMenu();
    if (!text) {
      setStatus("这条消息没有可复制的文字");
      return;
    }
    const how = await writeClipboard(text, stillMine);
    if (!stillMine()) return;
    if (how) {
      setStatus("复制好了");
      return;
    }
    showCopyBox(text);
    setStatus("剪贴板没接住，长按下面的字自己复制");
  }

  function quoteMessage(message) {
    if (!targetAlive(menuAgent, message.id)) { closeMenu(); return; }
    const text = messageCopyText(message);
    closeMenu();
    if (!text) {
      setStatus("这条没有能引用的文字");
      return;
    }
    setQuote(message, text);
  }

  /** 挂件换新之前先把旧的那块拿下来（真假 DOM 都能走：直接数 children）。 */
  function dropFeedNodes(col, partner) {
    for (const node of [...(col?.children ?? [])]) {
      const classes = String(node?.className ?? "").split(/\s+/);
      if (!classes.includes("message-feed")) continue;
      if (Boolean(classes.includes("from-partner")) === Boolean(partner)) node.remove();
    }
  }

  /** 自己这侧那条的投喂挂件（她给伙伴那句话喂的），份数按账上画。 */
  function paintOwnFeed(col, message) {
    if (!col || !message?.id) return "";
    col.querySelector?.(".message-feed:not(.from-partner)")?.remove();
    dropFeedNodes(col, false);
    const items = messageFeedItems(message.feed);
    if (!items.length) return "";
    const text = formatMessageFeed(message.feed);
    const feed = doc.createElement("div");
    feed.className = "message-feed";
    feed.setAttribute("aria-label", `已投喂${text}，数量按份计算`);
    for (const item of items) {
      const unit = doc.createElement("span");
      unit.className = "message-feed-item";
      const emoji = doc.createElement("span");
      emoji.className = "message-feed-emoji";
      emoji.textContent = item.emoji;
      unit.append(emoji);
      if (item.count > 1) {
        const count = doc.createElement("span");
        count.className = "message-feed-count";
        count.textContent = `${item.count}份`;
        count.title = `这条消息收到 ${item.count} 份投喂`;
        unit.append(count);
      }
      feed.append(unit);
    }
    col.append(feed);
    return text;
  }

  /**
   * 伙伴递过来的那份。只读，没菜单——这是 ta 的动作，不是她的。
   * 未读的一律不画：挂上去等于替 ta 说了话，穿帮比不递严重。
   */
  function paintPartnerFeed(col, message) {
    if (!col || !message?.id) return "";
    col.querySelector?.(".message-feed.from-partner")?.remove();
    dropFeedNodes(col, true);
    const items = message.readAt && !message.recalled
      ? visiblePartnerFeedItems(message, state.thread.messages)
      : [];
    if (!items.length) return "";
    const feed = doc.createElement("div");
    feed.className = "message-feed from-partner";
    feed.setAttribute("aria-label", `ta 投喂了${formatMessageFeed({ items })}，意思是她看到了`);
    feed.title = "她看到了，没有要接话的意思";
    for (const item of items) {
      const unit = doc.createElement("span");
      unit.className = "message-feed-item";
      const emoji = doc.createElement("span");
      emoji.className = "message-feed-emoji";
      emoji.textContent = item.emoji;
      unit.append(emoji);
      if (item.count > 1) {
        const count = doc.createElement("span");
        count.className = "message-feed-count";
        count.textContent = String(item.count);
        unit.append(count);
      }
      feed.append(unit);
    }
    col.append(feed);
    return formatMessageFeed({ items });
  }

  function paintFeed(col, message) {
    if (!col || !message) return;
    if (message.role === "assistant") paintOwnFeed(col, message);
    else paintPartnerFeed(col, message);
  }

  /** 挂上右键/长按/键盘三种入口，并把「点图/点语音这一下不算」的闸也接好。 */
  /** 这一下是在哪一小泡上发生的：从 event.target 往上找它记着的原文。 */
  function pieceTextOf(event, row) {
    let node = event?.target ?? null;
    while (node && node !== row) {
      if (typeof node.__pieceText === "string") return node.__pieceText;
      node = node.parentNode ?? node.parent ?? null;
    }
    return "";
  }

  /** 是不是戳一戳 / 动作：这类只给管理菜单，不冒充普通聊天消息。 */
  function actionKind(message) {
    return message?.kind === "poke" || message?.kind === "action";
  }

  function bindMessageMenu(row, message) {
    if (!row || !actionableMessage(message)) return;
    row.setAttribute("tabindex", "0");
    row.addEventListener("contextmenu", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      openMenu(row, message, pieceTextOf(event, row));
    });
    row.addEventListener("keydown", (event) => {
      const key = String(event?.key ?? "");
      if (key !== "ContextMenu" && !(key === "F10" && event?.shiftKey)) return;
      event?.preventDefault?.();
      openMenu(row, message, pieceTextOf(event, row));
    });
    row.addEventListener("pointerdown", (event) => {
      // 第二指按下（或这行上已经有按着的）：这一下不算，之前那一按也当场作废
      if (event?.isPrimary === false || pressOrigin) {
        clearPressTimer();
        return;
      }
      if (event?.button !== undefined && event.button !== 0) return;
      const x = Number(event?.clientX);
      const y = Number(event?.clientY);
      const piece = pieceTextOf(event, row);
      pressOrigin = { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!pressOrigin) return;
        pressOrigin = null;
        // 长按开了菜单：接下来这一下点图/点语音不算数
        suppressClickUntil = Date.now() + LONG_PRESS_CLICK_SUPPRESS_MS;
        openMenu(row, message, piece);
      }, LONG_PRESS_MS);
    });
    row.addEventListener("pointermove", (event) => {
      if (!pressOrigin) return;
      const x = Number(event?.clientX);
      const y = Number(event?.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // 位移：这是在滑，不是按住
      if (Math.abs(x - pressOrigin.x) > 10 || Math.abs(y - pressOrigin.y) > 10) clearPressTimer();
    });
    row.addEventListener("pointerup", clearPressTimer);
    row.addEventListener("pointercancel", clearPressTimer);
    row.addEventListener("pointerleave", clearPressTimer);
    // 冒泡上来的这一下点击也算“用掉长按那一下”，免得漏到后面去
    row.addEventListener("click", () => { consumeLongPressClick(); });
  }

  // 点菜单外面 / ESC：两块浮层都收
  const docBindings = [];
  const bindDoc = (type, fn) => {
    doc.addEventListener(type, fn);
    docBindings.push([type, fn]);
  };
  const unbindDoc = () => {
    for (const [type, fn] of docBindings.splice(0)) doc.removeEventListener?.(type, fn);
  };
  const menuContains = (node) => Boolean(node && feedMenu.contains(node));
  bindDoc("pointerdown", (event) => {
    if (event?.isPrimary === false) clearPressTimer();
    if (feedMenu.hidden) return;
    if (!event?.target) return;
    if (menuContains(event.target)) return;
    closeMenu();
  });
  bindDoc("keydown", (event) => {
    if (String(event?.key ?? "") !== "Escape") return;
    const hadMenu = !feedMenu.hidden;
    const hadBox = !copyBox.hidden;
    if (!hadMenu && !hadBox) return;
    event?.preventDefault?.();
    closeMenu();
    hideCopyBox();
  });

  /** 最后一句自己的话：已读/未读小字只挂在它下面。 */
  function lastOwnMessageId() {
    const rows = state.thread.messages;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row?.role === "user" && !row.recalled && row.id) return String(row.id);
    }
    return "";
  }

  function appendMessage(container, message, partnerName) {
    const mine = message.role === "user";
    if (message.recalled) {
      const row = doc.createElement("div");
      row.className = mine ? "row me" : "row ta";
      const col = doc.createElement("div");
      col.className = "msg-col";
      const line = doc.createElement("div");
      line.className = "msg-line";
      const b = doc.createElement("div");
      b.className = "bubble is-recalled";
      // 要么宿主已经写了撤回占位，要么只打了个 recalled 标记；两种都不能把原文摆出来。
      b.textContent = recallLabelOf(message, { partnerName });
      line.append(b);
      col.append(line);
      row.append(col);
      // 撤回的行没有菜单：里面没有任何还能动的东西
      container.append(row);
      return;
    }
    if (message.voice && (message.voice.status === "ready" || message.voice.status === "pending")) {
      container.append(voiceRow(message, partnerName));
      return;
    }
    const pieces = (Array.isArray(message.bubbles) && message.bubbles.length ? message.bubbles : [message.text])
      .filter((piece) => piece != null && String(piece) !== "");
    if (!pieces.length && !message.attachment?.id) pieces.push("…");
    const row = doc.createElement("div");
    row.className = "row " + (mine ? "me" : "ta");
    const col = doc.createElement("div");
    col.className = "msg-col";
    if (message.quote?.messageId) col.append(quoteStrip(message.quote));
    if (message.attachment?.id) {
      // 同条图文同泡：图在上、字在下，共用一个气泡（而不是图一行字一行）
      const line = doc.createElement("div");
      line.className = "msg-line ch-media-line";
      const bubble = doc.createElement("div");
      bubble.className = "bubble ch-media";
      bubble.__pieceText = pieces.join("\n");
      bubble.append(attachmentNode(message));
      for (const piece of pieces) {
        const part = doc.createElement("div");
        part.className = "ch-media-text";
        paintRichText(part, String(piece));
        bubble.append(part);
      }
      line.append(bubble);
      col.append(line);
    } else {
      for (const piece of pieces) {
        const line = doc.createElement("div");
        line.className = "msg-line";
        const bubble = bubbleEl(String(piece));
        if (bubble && bubble.tag !== "img") {
          // 每一小泡记着自己的原文：菜单从 event.target 往上找，复制/引用就是这一句
          bubble.__pieceText = String(piece);
        }
        line.append(bubble);
        col.append(line);
      }
    }
    const stamp = messageTimeNode(message.at);
    if (stamp) {
      // 时间放进最后一条正文气泡那一行（引用/投喂不在这行），行内绝对定位到气泡外侧；
      // 一条消息只一枚
      const contentLine = [...(col.children ?? [])]
        .filter((node) => String(node?.className ?? "").split(/\s+/).includes("msg-line"))
        .at(-1);
      if (contentLine) contentLine.append(stamp);
      else col.append(stamp);
    }
    // 已读/未读章统一由 applyTransients 挂（只一枚，永远跟着最后一条自己的话）
    paintFeed(col, message);
    if (message.id) feedCols.set(String(message.id), col);
    if (state.melody.showAvatars) row.append(avatarNode("msg-av", mine ? "__user" : state.thread.agentId, mine ? "我" : partnerName), col);
    else row.append(col);
    bindMessageMenu(row, message);
    container.append(row);
  }

  function takeMelody(data) {
    state.melody = {
      meSkin: data?.meSkin || null,
      taSkin: data?.taSkin || null,
      showAvatars: Boolean(data?.showAvatars),
    };
    const melody = state.melody;
    // 皮肤属性两个根都要挂：本体那套既有 [data-me-skin] 的变量规则，
    // 也有带 .chat 前缀的规则（耳朵、贴边动画），只写在 #msgs 上后者一条不生效。
    // 底色/背景那串 CSS 变量仍然只写在 #chat 上，继承链不变。
    for (const node of [chat, msgs]) {
      if (!node) continue;
      if (melody.meSkin) node.setAttribute("data-me-skin", melody.meSkin);
      else node.removeAttribute("data-me-skin");
      if (melody.taSkin) node.setAttribute("data-ta-skin", melody.taSkin);
      else node.removeAttribute("data-ta-skin");
    }
  }

  // ── 背景：桌面那套「图铺满聊天窗 + 头尾两条磨砂玻璃」──
  //
  // 图自己拉（带 Bearer）成 blob，采样也在本地跑，一层一层都靠同一个 ticket 认领归属。
  // 同一间房、同一张图、同一个时间戳只拉一次、只采样一次；轮询回来只重对一下浓度。
  let backgroundState = { key: "", agentId: "", url: "", theme: null };
  let backgroundSeq = 0;
  /**
   * 同一张图的那一发。只记一个：图在飞的时候再来轮询，绝不再 begin（同 key 会卷掉
   * 上一发，弱网下下载永远长于 20s 轮询，就永远铺不上）。只把「这一轮想要的浓度」
   * 记进来，图回来时用最新的那个。
   */
  let backgroundInflight = null;

  function backgroundPaint(veil, url) {
    chat.classList.add("has-bg");
    chat.style.setProperty("background-image", backgroundLayer(veil, url));
    chat.style.setProperty("background-size", "cover");
    chat.style.setProperty("background-position", "center");
    chat.style.setProperty("background-repeat", "no-repeat");
    // 头尾两条玻璃的白度跟着她调的浓度走；不加给整张图 filter:blur，那样连气泡底下的肉都糊了
    chat.style.setProperty("--mc-veil", String(veil));
  }

  function backgroundUnpaint() {
    chat.classList.remove("has-bg");
    chat.style.removeProperty("background-image");
    chat.style.removeProperty("background-size");
    chat.style.removeProperty("background-position");
    chat.style.removeProperty("background-repeat");
    chat.style.removeProperty("--mc-veil");
  }

  /** 主题变量先扫干净再写：清掉背景之后，气泡/按钮不许留着上一张图的颜色。 */
  function applyBackgroundTheme(theme) {
    for (const name of BACKGROUND_THEME_VARS) chat.style.removeProperty(name);
    for (const [name, value] of Object.entries(backgroundThemeVars(theme))) chat.style.setProperty(name, value);
  }

  function releaseBackgroundUrl(url) {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
  }

  /** 切伙伴 / 关闭聊天 / 登出 / 她清掉背景：图、浓度、主题变量一起归零。 */
  function clearBackground() {
    backgroundSeq += 1;
    // 先记下这间房是谁：下面几行就会把 agent 信息清掉，key 得在清之前拼好。
    // 切人/关闭那几条路 tracker.bump() 已经 aborted 了；但「同一个伙伴把背景清空」
    // 不走 bump，得在这里单独取消那一发，否则旧 fetch 还会回来写一遍。
    const owner = String(state.thread.agentId || state.agent?.id || backgroundState.agentId || "").trim();
    if (owner) tracker.cancel("background:" + owner);
    backgroundInflight = null;
    releaseBackgroundUrl(backgroundState.url);
    backgroundState = { key: "", agentId: "", url: "", theme: null };
    if (!chat) return;
    backgroundUnpaint();
    applyBackgroundTheme(null);
  }

  async function fetchBackgroundBlob(agentId, background, signal) {
    const res = await fetch(
      `/bg?agentId=${encodeURIComponent(agentId)}&t=${encodeURIComponent(background?.at || "")}`,
      { headers: { authorization: "Bearer " + token() }, signal },
    );
    if (res.status === 401) { lockOut("密码过期了，再输一次"); throw canceled(); }
    if (!res.ok) throw new Error("这间房的背景没铺上");
    const blob = await res.blob();
    if (!blob || !blob.size) throw new Error("这间房的背景没铺上");
    return blob;
  }

  function installBackground({ agentId, key, url, veil }) {
    const prev = backgroundState.url;
    backgroundState = { key, agentId, url, theme: null };
    applyBackgroundTheme(null);
    backgroundPaint(veil, url);
    if (prev && prev !== url) releaseBackgroundUrl(prev);
  }

  /**
   * 把线程里那份背景元数据落到页面上。
   *
   * 归属分三层：backgroundSeq（这一发还算不算最新）、tracker 票（切伙伴/关闭时当场 abort）、
   * 以及写状态前的 agent/chatOpen 复查。每个 await（fetch / 采样）之后都再验一次：
   * A 的图不会贴到 B 身上；A→B→A 里上一世代回来的色也不会盖掉新会话。
   */
  async function syncBackground(agentId, background) {
    if (!chat) return;
    const file = String(background?.file ?? "").trim();
    if (!file) { clearBackground(); return; }
    const veil = backgroundVeil(background?.opacity, background?.tone);
    const key = backgroundImageKey(agentId, background);
    if (backgroundState.key === key && backgroundState.url) {
      // 还是这间房这张图：她只拖了明暗条，重下/重采样都是白花
      backgroundPaint(veil, backgroundState.url);
      return;
    }
    if (backgroundInflight?.key === key) {
      // 这张图还在路上：不新开一发、也不 abort 它，只改「这一轮想要的浓度」
      backgroundInflight.veil = veil;
      return;
    }
    const seq = ++backgroundSeq;
    const ticket = tracker.begin("background:" + agentId);
    backgroundInflight = { key, agentId, ticket, veil };
    const mine = () => seq === backgroundSeq
      && tracker.isCurrent(ticket)
      && state.chatOpen
      && state.agent?.id === agentId
      && state.thread.agentId === agentId;
    let url = "";
    try {
      const blob = await fetchBackgroundBlob(agentId, background, ticket.controller.signal);
      if (!mine()) return;
      url = URL.createObjectURL(blob);
      if (!mine()) { releaseBackgroundUrl(url); return; }
      // 下载这段时间里她可能又改过浓度：铺的时候用记录里最新的那个
      const wanted = backgroundInflight?.ticket === ticket ? backgroundInflight.veil : veil;
      installBackground({ agentId, key, url, veil: wanted });
      const theme = buttonThemeFromSample(await analyzeBackground(url));
      // 采样回来时可能已经换人、换图、关掉了：这时候一个变量都不许写
      if (!mine() || backgroundState.url !== url) return;
      backgroundState.theme = theme;
      applyBackgroundTheme(theme);
    } catch (error) {
      if (url && backgroundState.url !== url) releaseBackgroundUrl(url);
      if (!mine()) return;
      // 没铺上就退回干净的样子，不留半截图、半截颜色
      clearBackground();
      if (!isCanceled(error)) setStatus(String(error?.message || "这间房的背景没铺上"));
    } finally {
      tracker.settle(ticket);
      // 只清自己那份记录：后来那一发不能被我这条旧 finally 抹掉
      if (backgroundInflight?.ticket === ticket) backgroundInflight = null;
    }
  }

  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  /** 回到底部那颗键：离开底部才出现，回来就收。 */
  function updateJumpBottom() {
    if (!jumpBottom) return;
    jumpBottom.hidden = !state.chatOpen || isNearBottom(msgs);
  }

  const TIME_DIVIDER_GAP_MS = 10 * 60 * 1000;

  function needsTimeDivider(prev, curr) {
    // 第一条不加刻度：头栏已经写着这是谁，再多一行只是噪音
    if (!prev) return false;
    const at = Date.parse(String(curr?.at ?? ""));
    if (!Number.isFinite(at)) return false;
    const before = Date.parse(String(prev?.at ?? ""));
    if (!Number.isFinite(before)) return false;
    return at - before >= TIME_DIVIDER_GAP_MS;
  }

  function appendRowFor(message, partnerName) {
    msgs.append(rowNodeFor(message, partnerName));
  }

  function rowNodeFor(message, partnerName) {
    if (message.kind === "poke" || message.kind === "action") return renderAction(message);
    const holder = doc.createElement("div");
    appendMessage(holder, message, partnerName);
    return holder.children[0] ?? null;
  }

  /** 只变「非本体」的那几样（已读章、投喂、语音听过没）：原地拨，不重画。 */
  function applyTransients() {
    for (const message of state.thread.messages) {
      if (!message?.id) continue;
      const id = String(message.id);
      const col = feedCols.get(id);
      if (col) paintFeed(col, message);
      const dot = voiceDots.get(id);
      if (dot) dot.hidden = Boolean(message.voice?.playedAt) || state.playedNow.has(id);
    }
    syncReadState();
  }

  /**
   * 「未读」标记：全局只一枚，只挂在当前最后一条自己发的话下面。
   * 读到（readAt 有值）就把节点直接摸掉（同本体 paintTick 收起那一手），
   * 绝不改成「已读」两个字留着。
   */
  function syncReadState() {
    const lastOwn = lastOwnMessageId();
    for (const [id, node] of [...readStateNodes]) {
      if (id === lastOwn) continue;
      node.remove?.();
      readStateNodes.delete(id);
    }
    if (!lastOwn) return;
    const message = state.thread.messages.find((row) => String(row?.id ?? "") === lastOwn);
    const col = feedCols.get(lastOwn);
    if (!message || !col) return;
    // 已读到：收起（不重建、不重画气泡）
    if (message.readAt) {
      const node = readStateNodes.get(lastOwn);
      if (node) {
        node.remove?.();
        readStateNodes.delete(lastOwn);
      }
      return;
    }
    if (readStateNodes.has(lastOwn)) return;
    const node = readStateNode();
    readStateNodes.set(lastOwn, node);
    col.append(node);
  }

  function emptyRendered() { return { ids: [], cores: [], transients: [] }; }

  function renderThread({ mode = "replace", wasBottom = true, prevHeight = 0, prevTop = 0 } = {}) {
    const messages = state.thread.messages;
    const partnerName = state.agent?.name || state.thread.agentId || "?";
    const prev = state.rendered;
    const next = {
      ids: messages.map((message) => String(message?.id ?? message?.seq ?? "")),
      cores: messages.map(coreSignatureOf),
      transients: messages.map(transientSignatureOf),
    };
    const sameIds = prev.ids.length === next.ids.length && prev.ids.every((id, i) => id === next.ids[i]);
    const sameCores = sameIds && prev.cores.every((core, i) => core === next.cores[i]);
    // 前面那些没变、后面只多了几条：只补新的，旧 DOM（含正在放的语音）一个都不动
    const extended = prev.ids.length > 0
      && prev.ids.length < next.ids.length
      && prev.ids.every((id, i) => id === next.ids[i] && prev.cores[i] === next.cores[i])
      && mode !== "prepend";
    // 反过来：上翻拿回来的新页正好是「老页 + 前面多 N 条」，只在头部插，不动旧行
    const headOffset = next.ids.length - prev.ids.length;
    const headExtended = mode === "prepend"
      && prev.ids.length > 0
      && headOffset > 0
      && prev.ids.every((id, i) => id === next.ids[i + headOffset] && prev.cores[i] === next.cores[i + headOffset]);

    state.signature = signatureOf(messages);
    state.rendered = next;

    if (sameCores) {
      applyTransients();
      updateJumpBottom();
      return false;
    }
    if (extended) {
      // 内容变了：旧菜单挂在的消息行可能已经不是原来那条，一块收掉
      closeMenu();
      clearPressTimer();
      for (let i = prev.ids.length; i < messages.length; i += 1) {
        if (needsTimeDivider(messages[i - 1], messages[i])) msgs.append(timeDividerNode(timeDividerText(messages[i]?.at)));
        appendRowFor(messages[i], partnerName);
      }
      applyTransients();
      if (wasBottom) scrollBottom();
      paintTyping(Boolean(state.turn));
      updateJumpBottom();
      return true;
    }
    if (headExtended) {
      // 上翻补页：新那几行插到头上，旧行（连同正在放的语音、展开的转写）一个不动
      closeMenu();
      clearPressTimer();
      const nodes = [];
      for (let i = 0; i < headOffset; i += 1) {
        if (needsTimeDivider(messages[i - 1], messages[i])) nodes.push(timeDividerNode(timeDividerText(messages[i]?.at)));
        const node = rowNodeFor(messages[i], partnerName);
        if (node) nodes.push(node);
      }
      // 新老交界处也可能要一条刻度（旧页头一行原来没刻度）
      if (needsTimeDivider(messages[headOffset - 1], messages[headOffset])) {
        nodes.push(timeDividerNode(timeDividerText(messages[headOffset]?.at)));
      }
      if (nodes.length) msgs.prepend(...nodes);
      applyTransients();
      // 插在上面的内容把视线顶下去多少，就把滚动位置补回多少
      msgs.scrollTop = anchorAfterPrepend({ prevHeight, prevTop, nextHeight: msgs.scrollHeight });
      paintTyping(Boolean(state.turn));
      updateJumpBottom();
      return true;
    }
    // 要整段重画了：旧菜单、旧音频、手动复制框、逐渐显现的定时器一起作废（防撤回后还留着旧正文）
    closeMenu();
    hideCopyBox();
    clearPressTimer();
    clearReveal({ restore: false });
    feedCols.clear();
    voiceDots.clear();
    readStateNodes.clear();
    teardownMedia();
    msgs.textContent = "";
    for (let i = 0; i < messages.length; i += 1) {
      if (needsTimeDivider(messages[i - 1], messages[i])) msgs.append(timeDividerNode(timeDividerText(messages[i]?.at)));
      appendRowFor(messages[i], partnerName);
    }
    if (mode === "prepend") msgs.scrollTop = anchorAfterPrepend({ prevHeight, prevTop, nextHeight: msgs.scrollHeight });
    else if (wasBottom) scrollBottom();
    // 没贴在底部（在看旧记录）：重画完之后回到原来的阅读位置，不把人抽走
    else msgs.scrollTop = prevTop;
    // 已读章/投喂/未听点都是「非本体」，统一在这里焊上去（语音行也算）
    applyTransients();
    paintTyping(Boolean(state.turn));
    updateJumpBottom();
    return true;
  }

  function markSeen(agentId, at) {
    if (agentId && at) localStorage.setItem(seenKey(agentId), String(at));
  }

  function maybeMarkRead({ atBottom = isNearBottom(msgs) } = {}) {
    if (!state.chatOpen) return;
    // 没贴在底下就不盖章：屏外的新消息不算看过
    const throughId = readReceiptThrough({
      messages: state.thread.messages,
      chatOpen: state.chatOpen,
      documentVisible: doc.visibilityState !== "hidden",
      atBottom,
    });
    if (!throughId || throughId === state.readFor) return;
    state.readFor = throughId;
    void api("thread.read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: state.thread.agentId, throughId }),
    }).catch(() => { state.readFor = ""; });
  }

  function commitPage(agentId, data, mode, metrics) {
    const prevHeight = msgs.scrollHeight;
    const prevTop = msgs.scrollTop;
    const coresBefore = state.thread.messages.map(coreSignatureOf);
    state.thread = applyThreadPage(state.thread, { agentId, page: data, mode });
    takeMelody(data);
    if (state.agent?.id === agentId) paintPartnerBadge(data?.badge);
    if (data?.messageRefine !== undefined) state.messageRefine = data.messageRefine ?? null;
    // 认识流程的门禁以线程回包为准（名单纯属提前量）
    if (data?.needsOnboarding !== undefined) {
      const pending = data.needsOnboarding === true;
      if (pending !== state.needsOnboarding) {
        state.needsOnboarding = pending;
        applyOnboardingGate();
      }
    }
    void syncBackground(agentId, data?.background);
    const lastAt = state.thread.messages.reduce((acc, m) => (m.at && String(m.at) > acc ? String(m.at) : acc), "");
    // 没贴在底下（在上翻看旧记录）就既不算看过，也不替她把列表里的红点消掉。
    const atBottom = mode === "prepend" ? false : (metrics?.wasBottom ?? true);
    if (lastAt && doc.visibilityState !== "hidden" && atBottom) markSeen(agentId, lastAt);
    const wasBottom = mode === "prepend" ? false : (metrics?.wasBottom ?? true);
    const changed = renderThread({ mode, wasBottom, prevHeight, prevTop });
    // 真的变了才问工具那边重算提案：静置轮询不会刷出请求风暴
    if (changed) refreshTools(true);
    // 线程合并完了就把「内容真变了没」告诉工具（playedAt/readAt 这类不算）
    const contentChanged = coreListChanged(coresBefore, state.thread.messages.map(coreSignatureOf));
    try { tools?.syncThread?.({ contentChanged, revalidate: true }); } catch { /* 工具那边自己的事 */ }
    // 图库只读：面板开着、或者手里有待发表情时，趁这轮成功的 pull 顺带对一下清单
    if (!tray.hidden || state.draftSticker) void refreshStickerList(agentId);
    if (mode === "replace") settleDelivered();
    maybeMarkRead({ atBottom });
  }

  /**
   * 超时后那条后来又落库了（宿主把 clientMessageId 一并发回来）：
   * 把失败提示与可重试的票一起收掉，别让她再发一遍重的。
   */
  function settleDelivered() {
    const plan = sends.retryPlan();
    const ids = deliveredClientIds(state.thread.messages);
    const mine = state.failed;
    const landed = (mine && ids.has(mine.clientMessageId)) || (plan && ids.has(plan.clientMessageId));
    if (!landed) return;
    if (mine?.row?.isConnected) mine.row.remove();
    state.failed = null;
    if (plan) sends.clearRetry();
    setStatus("那条其实已经发出去了");
  }

  async function pull() {
    if (!state.agent) return;
    // 正在翻旧页时先不轮询：否则会把旧页那一发 abort 掉，刚翻上去的历史白翻。
    if (state.loadingOlder) return;
    const agentId = state.agent.id;
    const wasBottom = isNearBottom(msgs);
    // 只按已加载数要：静置轮询不会自动扩窗；扩窗只发生在真正上翻成功之后。
    const limit = pullLimit(state.thread.messages.length);
    // 与上翻共用同一个 key：谁后发谁算数，晚到的那份直接按旧世代丢掉。
    const row = tracker.begin("thread:" + agentId);
    try {
      const data = await api(
        `thread.get?agentId=${encodeURIComponent(agentId)}&limit=${limit}`,
        {},
        { signal: row.controller.signal },
      );
      if (!tracker.isCurrent(row) || state.agent?.id !== agentId) return;
      commitPage(agentId, data, "replace", { wasBottom });
      setStatus("");
    } catch (error) {
      if (isCanceled(error) || !tracker.isCurrent(row)) return;
      setStatus("没连上");
    } finally {
      tracker.settle(row);
    }
  }

  async function loadOlder() {
    if (!state.agent || state.loadingOlder) return;
    const before = earliestSeq(state.thread.messages);
    if (before == null) return;
    const agentId = state.agent.id;
    state.loadingOlder = true;
    // 和轮询共用一个 key：上翻一发起，在飞的那次 poll 就被顶掉，它晚回来也盖不掉刚 prepend 的旧页。
    const row = tracker.begin("thread:" + agentId);
    try {
      const data = await api(
        `thread.get?agentId=${encodeURIComponent(agentId)}&limit=${MOBILE_PAGE_MORE}&before=${before}`,
        {},
        { signal: row.controller.signal },
      );
      if (!tracker.isCurrent(row) || state.agent?.id !== agentId) return;
      commitPage(agentId, data, "prepend", {});
    } catch (error) {
      if (isCanceled(error) || !tracker.isCurrent(row)) return;
      setStatus("更早的翻不动了");
    } finally {
      state.loadingOlder = false;
      tracker.settle(row);
    }
  }

  // ── 聊天开关 ──
  function closeChat() {
    const leaving = state.agent?.id;
    state.chatOpen = false;
    state.agent = null;
    state.thread = createThreadState();
    state.signature = "";
    state.rendered = { ids: [], cores: [], transients: [] };
    state.readFor = "";
    state.playedNow = new Set();
    state.epoch += 1;
    stopTurnWatch();
    // 离开前把这一位的草稿存回会话内存（重进能接着写）
    if (leaving) saveDraft(leaving);
    resetComposer();
    stopPlayback();
    stopPolling();
    closeTray();
    tools?.reset?.();
    // 退出聊天：菜单/计时/兼容框不能跨伙伴留着
    closeMenu();
    clearPressTimer();
    hideCopyBox();
    paintPartnerBadge(null);
    chat.hidden = true;
    home.hidden = false;
    tracker.bump();
    clearBackground();
    void loadPartners();
  }

  async function openChat(row) {
    // 切人先把上一位的草稿收进会话内存，再换页
    if (state.agent?.id && state.agent.id !== row.id) saveDraft(state.agent.id);
    tracker.bump();
    state.agent = row;
    state.thread = createThreadState();
    state.signature = "";
    state.rendered = { ids: [], cores: [], transients: [] };
    state.chatOpen = true;
    state.readFor = "";
    state.playedNow = new Set();
    state.messageRefine = null;
    // 名单上就标了没认识：先按关处理，thread.get 回来再校一次
    state.needsOnboarding = row.needsOnboarding === true;
    state.epoch += 1;
    stopTurnWatch();
    tools?.reset?.();
    resetComposer();
    applyDraft(row.id);
    stopPlayback();
    stopTray();
    closeMenu();
    clearPressTimer();
    hideCopyBox();
    // 上一间房的图和颜色不许在切过来的那一瞬露一下
    clearBackground();
    whoEl.textContent = row.name;
    // 先清上一位的徽章，再用名单带的这份首绘（没有就藏）
    paintPartnerBadge(null);
    paintPartnerBadge(row.badge);
    setStatus("正在翻…");
    chat.hidden = false;
    home.hidden = true;
    msgs.textContent = "";
    await pull();
    if (state.agent?.id !== row.id) return;
    // 上次没发出去的那条：把重试入口摆回来（票不换，宿主据此去重）
    restoreFailedEntry(row.id);
    startPolling();
    updateJumpBottom();
    applyOnboardingGate();
    refreshTools(false);
    setTimeout(() => input.focus(), 120);
  }

  // ── 发送 ──
  function setQuote(message, text = "") {
    // 引用只带她看得懂的文字：表情包那个 \u0001 控制头绝不露到引用条上；
    // 上限跟后端 normalizeQuote 一致（4000），不在 UI 里提前砍成 120。
    const body = String(text ?? "").trim() || messageTextOf(message);
    state.quote = { messageId: String(message?.id ?? ""), text: body.slice(0, MOBILE_QUOTE_MAX) };
    quoteText.textContent = state.quote.text || "（这条没有文字）";
    quoteBar.hidden = false;
    touchDraft();
  }

  function clearQuoteBar() {
    state.quote = null;
    quoteBar.hidden = true;
    quoteText.textContent = "";
  }

  function clearDraftPreview() {
    // 先把还在读的那张图作废：慢回的结果不许再写进草稿
    if (state.agent?.id) tracker.cancel("image:" + state.agent.id);
    if (state.draftUrl) { try { URL.revokeObjectURL(state.draftUrl); } catch { /* 已释放 */ } }
    state.draftUrl = "";
    draftBar.hidden = true;
    draftImg.removeAttribute("src");
    draftName.textContent = "";
  }

  /** 发送键的状态：正文 / 选图 / 待发表情 三样里有一个、且没有在飞的那条；未认识时一律关。 */
  function refreshSendButton() {
    if (state.needsOnboarding === true) { sendBtn.disabled = true; return; }
    sendBtn.disabled = (!input.value.trim() && !state.draftImage && !state.draftSticker) || Boolean(sends.current());
  }

  /** 草稿版本：她每次动正文/选图/引用都 +1，发给出去的回包才知道自己还算不算数。 */
  function touchDraft() {
    state.draftRev += 1;
    return state.draftRev;
  }

  // ── 草稿按伙伴留在本次会话内存（绝不写 localStorage：那是明文聊天）──
  function currentDraft() {
    return {
      text: input.value,
      image: state.draftImage,
      url: state.draftUrl,
      sticker: state.draftSticker,
      quote: state.quote,
      clientMessageId: state.draftClientId,
      failed: state.failedPayload || null,
    };
  }

  function isEmptyDraft(record) {
    if (!record) return true;
    return !String(record.text ?? "").trim() && !record.image && !record.sticker && !record.quote;
  }

  function releaseDraft(record) {
    if (!record?.url) return;
    try { URL.revokeObjectURL(record.url); } catch { /* 已释放 */ }
    record.url = "";
  }

  /** 离开这一位时把草稿收起来：正文/图/表情/引用/同一张票都留着。 */
  function saveDraft(agentId) {
    if (!agentId) return;
    const record = currentDraft();
    if (isEmptyDraft(record) && !record.failed) {
      const old = state.drafts.get(agentId);
      if (old) releaseDraft(old);
      state.drafts.delete(agentId);
      return;
    }
    const old = state.drafts.get(agentId);
    if (old && old.url && old.url !== record.url) releaseDraft(old);
    state.drafts.set(agentId, record);
  }

  function applyDraft(agentId) {
    const record = state.drafts.get(agentId);
    state.draftImage = record?.image ?? null;
    state.draftUrl = record?.url ?? "";
    state.draftSticker = record?.sticker ?? null;
    state.quote = record?.quote ?? null;
    state.draftClientId = record?.clientMessageId ?? "";
    state.failedPayload = record?.failed ?? null;
    input.value = record?.text ?? "";
    autoGrow();
    if (state.quote) {
      quoteText.textContent = state.quote.text || "（这条没有文字）";
      quoteBar.hidden = false;
    } else {
      clearQuoteBar();
    }
    if (state.draftImage) showDraftPreview(state.draftImage.name || "图片");
    else { draftBar.hidden = true; draftImg.removeAttribute("src"); draftName.textContent = ""; }
    showStickerDraft();
    refreshSendButton();
    touchDraft();
  }

  function clearAllDrafts() {
    for (const record of state.drafts.values()) releaseDraft(record);
    state.drafts.clear();
    state.failedPayload = null;
  }

  /** 换伙伴 / 退出 / 登出：输入框、选图、引用一律清空，A 没发出去的东西什么都不留给 B。 */
  function resetComposer() {
    input.value = "";
    autoGrow();
    state.draftImage = null;
    state.draftSticker = null;
    state.draftClientId = "";
    state.draftUrl = "";
    state.quote = null;
    // 还在读的那张图作废：慢回的结果不许再写进新伙伴的草稿
    if (state.agent?.id) tracker.cancel("image:" + state.agent.id);
    draftBar.hidden = true;
    draftImg.removeAttribute("src");
    draftName.textContent = "";
    hideStickerDraft();
    clearQuoteBar();
    sendBtn.disabled = true;
    touchDraft();
  }

  function showStickerDraft() {
    const sticker = state.draftSticker;
    if (stickerDraftBar) stickerDraftBar.hidden = !sticker;
    if (!sticker) {
      if (stickerDraftImg) stickerDraftImg.removeAttribute("src");
      if (stickerDraftName) stickerDraftName.textContent = "";
      return;
    }
    if (stickerDraftImg) stickerDraftImg.src = `/sticker?agentId=${encodeURIComponent(state.thread.agentId)}&id=${encodeURIComponent(sticker.id)}`;
    if (stickerDraftName) stickerDraftName.textContent = sticker.name || "表情包";
  }

  function hideStickerDraft() {
    state.draftSticker = null;
    showStickerDraft();
  }

  function showFailed(onRetry) {
    const row = doc.createElement("div");
    row.className = "row me";
    const col = doc.createElement("div");
    col.className = "msg-col";
    const fail = doc.createElement("div");
    fail.className = "ch-fail";
    const label = doc.createElement("span");
    label.textContent = "这条没发出去";
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "ch-act";
    retry.textContent = "重试";
    retry.addEventListener("click", () => { fail.remove(); onRetry(); });
    fail.append(label, retry);
    col.append(fail);
    row.append(col);
    msgs.append(row);
    scrollBottom();
    return row;
  }

  function captureDraft(agentId) {
    // 同一段草稿用同一张票：失败重试、切回来再发，宿主都能据此去重
    if (!state.draftClientId) state.draftClientId = newClientId();
    const payload = buildTurnPayload({
      agentId,
      text: input.value,
      stickerId: state.draftSticker?.id || "",
      image: state.draftImage,
      quote: state.quote,
      clientMessageId: state.draftClientId,
    });
    return payload;
  }

  function newClientId() {
    const rnd = Math.random().toString(36).slice(2, 10);
    return `m_${Date.now().toString(36)}_${rnd}`;
  }

  function restoreDraft(payload) {
    if (!payload) return;
    if (!input.value.trim() && payload.text) { input.value = payload.text; autoGrow(); }
    if (payload.image?.data && !state.draftImage) {
      state.draftImage = { data: payload.image.data, mimeType: payload.image.mimeType, name: payload.image.name };
      showDraftPreview(payload.image.name || "图片");
    }
    if (payload.stickerId && !state.draftSticker) {
      state.draftSticker = { id: String(payload.stickerId) };
      showStickerDraft();
    }
    if (payload.quote && !state.quote) {
      state.quote = payload.quote;
      quoteText.textContent = payload.quote.text || "";
      quoteBar.hidden = false;
    }
    if (payload.clientMessageId && !state.draftClientId) state.draftClientId = String(payload.clientMessageId);
    refreshSendButton();
  }

  /** 上次没发出去的那条：重新进这间房时把重试入口摆回来（票不换）。 */
  function restoreFailedEntry(agentId) {
    const payload = state.failedPayload;
    if (!payload) return;
    const row = showFailed(() => {
      state.failed = null;
      state.failedPayload = null;
      const plan = sends.retryPlan();
      void dispatch(plan ? plan.payload : payload);
    });
    state.failed = { clientMessageId: payload.clientMessageId, agentId, row };
  }

  async function dispatch(payload) {
    if (!payload || !hasSendableContent(payload)) return;
    if (!fitsTurnLimit(payload)) { setStatus("这条太大了，换张小点的图"); return; }
    const ticket = sends.begin({ clientMessageId: payload.clientMessageId, agentId: payload.agentId, payload });
    if (!ticket) { setStatus("上一条还在发，稍等"); return; }
    sendBtn.disabled = true;
    setStatus("发出去的…");
    const mine = payload.agentId;
    // 这条属于哪个聊天世代 + 发出时的草稿版本：A→B→A 是两个世代，只比 agent.id 不够
    const gen = tracker.generation();
    const rev = state.draftRev;
    const alive = () => state.chatOpen && state.agent?.id === mine && tracker.generation() === gen;
    let bubble = null;
    if (alive()) {
      bubble = doc.createElement("div");
      bubble.className = "row me ch-pending";
      const col = doc.createElement("div");
      col.className = "msg-col";
      if (payload.text) {
        const line = doc.createElement("div");
        line.className = "msg-line";
        const b = doc.createElement("div");
        b.className = "bubble";
        b.textContent = payload.text;
        line.append(b);
        col.append(line);
      }
      if (payload.image?.data) {
        const img = doc.createElement("img");
        img.className = "ch-img ch-pending";
        img.src = `data:${payload.image.mimeType};base64,${payload.image.data}`;
        col.append(img);
      }
      if (payload.stickerId) {
        const img = doc.createElement("img");
        img.className = "sticker ch-pending";
        img.alt = "表情";
        img.src = `/sticker?agentId=${encodeURIComponent(payload.agentId)}&id=${encodeURIComponent(payload.stickerId)}`;
        col.append(img);
      }
      bubble.append(col);
      msgs.append(bubble);
      scrollBottom();
    }
    try {
      const data = await api("turn.send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      sends.done();
      state.failedPayload = null;
      if (state.failed?.clientMessageId === payload.clientMessageId) {
        if (state.failed.row?.isConnected) state.failed.row.remove();
        state.failed = null;
      }
      // 只在“还是那个伙伴的同一个世代”时动界面：B 那边的新输入/选图/引用一概不碰。
      if (alive()) {
        // rev 只说明“改过”；还得看输入框里现在是不是刚发出去的那句。
        // 失败→改正文→用原 clientMessageId 重试时，rev 会等于新世代的值，
        // 光比 rev 会把重试成功后的新正文一起清掉。
        const sameDraft = state.draftRev === rev && input.value.trim() === String(payload.text ?? "").trim();
        if (sameDraft) {
          input.value = "";
          autoGrow();
          state.draftImage = null;
          state.draftUrl = "";
          state.draftSticker = null;
          state.draftClientId = "";
          draftBar.hidden = true;
          draftImg.removeAttribute("src");
          draftName.textContent = "";
          hideStickerDraft();
          clearQuoteBar();
          touchDraft();
        } else {
          // 她在这条飞出去之后又打了新草稿：正文绝不动，只收掉已经发出去的那张图/那句引用
          if (payload.image?.data && state.draftImage?.data === payload.image.data) {
            state.draftImage = null;
            draftBar.hidden = true;
            draftImg.removeAttribute("src");
            draftName.textContent = "";
          }
          if (payload.stickerId && state.draftSticker?.id === payload.stickerId) hideStickerDraft();
          if (payload.quote?.messageId && state.quote?.messageId === payload.quote.messageId) clearQuoteBar();
        }
        refreshSendButton();
        if (data?.notice) setStatus(String(data.notice));
        else setStatus("");
        state.signature = "";
        // 宿主在后台跑这一轮：先打打字，再一条条拿（不为了伪逐条再叫一次模型）
        if (data?.queued && data.turnId) watchTurn(mine, String(data.turnId), gen);
        await pull();
        // pull 成功会清状态行；宿主给的那句话要在它之后还说一遍
        if (data?.notice) setStatus(String(data.notice));
      } else {
        // 在 B 那儿：只把发送键按 B 自己的草稿重算（A 那条已经结束了）
        refreshSendButton();
      }
    } catch (error) {
      sends.fail();
      if (bubble) bubble.remove();
      if (isCanceled(error)) {
        refreshSendButton();
        return;
      }
      // 宿主已经确认这张贴图不能用了：不把失效的那张放回草稿，也不留同一张票的
      // 重试入口（否则会拿着一张已删的图无限重试）。正文/图片/引用照旧还给她，
      // 她在等的时候另选的那张也不动。只看「还在这一页」：已经切走了就不能动
      // 原伙伴那张票（那是 A 唯一能把文字/引用取回来的东西），走下面的旧逻辑。
      if (alive() && payload.stickerId && stickerUnavailableError(error)) {
        sends.clearRetry();
        if (state.draftRev === rev) restoreDraft({ ...payload, stickerId: "" });
        if (state.draftSticker?.id === payload.stickerId) dropDraftSticker("");
        state.failedPayload = null;
        setStatus("这张表情包当前不可用，换一张吧");
        refreshSendButton();
        return;
      }
      // 已经切走了：只保留原伙伴那张 retry 票（sends.fail 已经留着），
      // 不 showFailed（那是 B 的列表）、不 restoreDraft（会把 A 的正文回填给 B）、不报错。
      if (!alive()) {
        refreshSendButton();
        return;
      }
      setStatus(String(error.message));
      if (state.draftRev === rev) restoreDraft(payload);
      state.failedPayload = payload;
      const row = showFailed(() => {
        state.failed = null;
        state.failedPayload = null;
        const plan = sends.retryPlan();
        if (!plan) return;
        // 重试用的是同一张票：clientMessageId 不变，宿主据此去重。
        void dispatch(plan.payload);
      });
      state.failed = { clientMessageId: payload.clientMessageId, agentId: mine, row };
    } finally {
      refreshSendButton();
    }
  }

  async function send() {
    if (!state.chatOpen || !state.agent) return;
    // 还没认识：手机上不发东西，只提示回本体走完
    if (state.needsOnboarding === true) { setStatus("先在茶话会本体完成认识"); return; }
    if (sends.current()) { setStatus("上一条还在发，稍等"); return; }
    // 上一条还在逐段显现：先把它补全，不能留半截文案挂在屏上
    clearReveal();
    // 伙伴在这一刻定死：之后切走、失焦都不影响这条要发给谁。
    const payload = captureDraft(state.agent.id);
    if (!hasSendableContent(payload)) return;
    await dispatch(payload);
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  // ── 选图 ──
  function showDraftPreview(name) {
    draftBar.hidden = false;
    draftName.textContent = name || "图片";
    if (state.draftUrl) draftImg.src = state.draftUrl;
  }

  async function pickImage(file) {
    if (!state.agent || !state.chatOpen) return;
    if (state.needsOnboarding === true) { setStatus("先在茶话会本体完成认识"); return; }
    const agentId = state.agent.id;
    const ticket = tracker.begin("image:" + agentId);
    const stillMine = () => tracker.isCurrent(ticket) && state.agent?.id === agentId && state.chatOpen;
    let result;
    try {
      result = await pickDraftImage(file, {
        stillMine,
        readAsDataURL: readFileAsDataUrl,
        imageSize,
        validate: (value) => validateImageFile({ type: value?.type, size: value?.size }),
      });
    } finally {
      tracker.settle(ticket);
    }
    if (!result.ok) {
      // 被切换/移除顶掉的旧操作悄悄退场；真读不出来才说话
      if (!result.stale) setStatus(result.reason || "这张图读不出来");
      if (result.url) { try { URL.revokeObjectURL(result.url); } catch { /* 已释放 */ } }
      return;
    }
    if (state.draftUrl) { try { URL.revokeObjectURL(state.draftUrl); } catch { /* 已释放 */ } }
    state.draftImage = result.image;
    state.draftUrl = result.url;
    showDraftPreview(result.image.name);
    touchDraft();
    sendBtn.disabled = false;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("这张图读不出来"));
      reader.readAsDataURL(file);
    });
  }

  function imageSize(url) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        const done = () => resolve({
          width: img.naturalWidth || undefined,
          height: img.naturalHeight || undefined,
        });
        img.onload = done;
        img.onerror = () => resolve({});
        img.src = url;
        if (typeof img.decode === "function") img.decode().then(done).catch(() => resolve({}));
      } catch {
        resolve({});
      }
    });
  }

  // ── 表情包抽屉 ──
  const EMOJI_SET = ["😀", "😄", "😁", "🥰", "😍", "😘", "🤤", "😴", "🥱", "😪", "😌", "😔", "😞", "😢", "🥺", "😭", "😤", "😠", "🤬", "🙄", "😏", "😒", "😅", "🤣", "😂", "😲", "😱", "🤯", "😳", "🫣", "🤔", "🤨", "😶", "😐", "🫠", "🙃", "😉", "😊", "☺️", "🥲", "❤️", "💗", "💓", "💕", "💞", "💘", "💔", "🫶", "👏", "🙏", "👍", "👎", "✌️", "🤝", "💪", "🎉", "✨", "🌙", "🌷", "🍵"];

  function renderEmojiGrid() {
    trayGrid.textContent = "";
    trayGrid.classList.add("emoji-mode");
    for (const emoji of EMOJI_SET) {
      const cell = doc.createElement("button");
      cell.className = "ch-tray-cell ch-emoji-cell";
      cell.textContent = emoji;
      cell.addEventListener("click", () => {
        closeTray();
        input.value = input.value ? input.value + emoji : emoji;
        autoGrow();
        // 插表情也算改草稿：正在飞的那条回包不许把新插的这枚抹掉
        touchDraft();
        refreshSendButton();
        input.focus();
      });
      trayGrid.append(cell);
    }
  }

  function renderTrayGrid() {
    if (state.stickerCache.filter === "emoji") { renderEmojiGrid(); return; }
    trayGrid.classList.remove("emoji-mode");
    const all = state.stickerCache.stickers;
    const groupRows = state.stickerCache.filter
      ? all.filter((row) => Array.isArray(row.groupIds) && row.groupIds.includes(state.stickerCache.filter))
      : all;
    // 搜索：描述与情绪标签一起找，不分大小写
    const query = String(state.stickerCache.query ?? "").trim().toLowerCase();
    const rows = query
      ? groupRows.filter((row) => `${row.description ?? ""} ${(row.emotion ?? []).join(" ")}`.toLowerCase().includes(query))
      : groupRows;
    trayGrid.textContent = "";
    if (!rows.length) {
      trayGrid.innerHTML = query
        ? '<div class="ch-tray-empty">没搜到这样的表情。</div>'
        : '<div class="ch-tray-empty">这一类下面没有图。</div>';
      return;
    }
    for (const row of rows) {
      const cell = doc.createElement("button");
      cell.className = "ch-tray-cell";
      cell.title = row.description || (row.emotion || []).join("·");
      cell.style.backgroundImage = `url("/sticker?agentId=${encodeURIComponent(state.thread.agentId)}&id=${encodeURIComponent(row.id)}")`;
      // 点一下先进待发预览：不直接发，她还能配正文/引用再按发送
      cell.addEventListener("click", () => selectSticker(row));
      trayGrid.append(cell);
    }
  }

  function renderTrayTabs() {
    const cache = state.stickerCache;
    trayTabs.textContent = "";
    const makeTab = (label, value) => {
      const btn = doc.createElement("button");
      btn.className = "ch-tray-tab" + (cache.filter === value ? " on" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        state.stickerCache.filter = value;
        renderTrayTabs();
        renderTrayGrid();
        trayGrid.scrollTop = 0;
      });
      trayTabs.append(btn);
    };
    makeTab("Emoji", "emoji");
    makeTab("表情包 " + cache.stickers.length, "");
    for (const group of cache.groups) {
      const count = cache.stickers.filter((row) => Array.isArray(row.groupIds) && row.groupIds.includes(group.id)).length;
      // 空分类也要摆出来（本体刚建/刚清空的那种），点进去给空态，不藏起来
      makeTab(count ? `${group.name} ${count}` : group.name, group.id);
    }
    trayTabs.hidden = false;
  }

  async function openTray() {
    if (!state.agent) return;
    if (state.needsOnboarding === true) { setStatus("先在茶话会本体完成认识"); return; }
    const agentId = state.agent.id;
    tray.hidden = false;
    trayGrid.innerHTML = '<div class="ch-tray-empty">正在翻图库…</div>';
    trayTabs.hidden = true;
    state.stickerCache.filter = "";
    await refreshStickerList(agentId, { opening: true });
  }

  /** 图库清单的内容签名：只看会影响画面的那几样，让「没变」真的不重画。 */
  function stickerListSignature(cache) {
    const stickers = (cache?.stickers ?? []).map((row) => [
      String(row?.id ?? ""),
      String(row?.description ?? ""),
      (row?.emotion ?? []).join("|"),
      (row?.groupIds ?? []).join("|"),
    ]);
    const groups = (cache?.groups ?? []).map((group) => [String(group?.id ?? ""), String(group?.name ?? "")]);
    return JSON.stringify([stickers, groups]);
  }

  /**
   * 拉一份权威图库清单并落到面板上（own/catalog 都在里面，不另存一份）。
   *
   * 只在「伙伴/世代/这次请求还归我」时落盘：切人、关页、登出之后回来的旧榜单
   * 既不能复活旧分类，也不能把已选的待发表情删掉。
   * 面板关着时只允许顺手检查待发那张（不再开面板、不画旧内容）。
   */
  async function refreshStickerList(agentId, { opening = false } = {}) {
    const row = tracker.begin("stickers:" + agentId);
    try {
      const data = await api(`stickers.list?agentId=${encodeURIComponent(agentId)}`, {}, { signal: row.controller.signal });
      if (!tracker.isCurrent(row) || state.agent?.id !== agentId || !state.chatOpen) return;
      applyStickerList(agentId, data, { opening });
    } catch (error) {
      if (isCanceled(error) || !tracker.isCurrent(row)) return;
      if (state.agent?.id !== agentId || !state.chatOpen) return;
      // 这一份清单没拿到：旧清单已经不可信（本体可能刚删过图），必须清掉，
      // 否则搜索一下就把已删的图又画回来了。待发那张不当成已删（网络错不是删图）。
      state.stickerCache = { ...state.stickerCache, stickers: [], groups: [] };
      if (tray.hidden) return;
      trayCount.textContent = "";
      renderTrayTabs();
      if (state.stickerCache.filter === "emoji") renderEmojiGrid();
      else showNote(doc, trayGrid, "ch-tray-empty", "没拉下来：" + String(error?.message || error));
    } finally {
      tracker.settle(row);
    }
  }

  function applyStickerList(agentId, data, { opening = false } = {}) {
    const stickers = Array.isArray(data?.stickers) ? data.stickers : [];
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    // 开面板那一发迟到（她已经关上了）：清单不落、面板不画
    if (opening && tray.hidden) return;
    const draftGone = Boolean(state.draftSticker)
      && !stickers.some((row) => String(row?.id ?? "") === state.draftSticker.id);
    // 面板关着但手里有待发表情：只核那一张还在不在，不动清单也不画
    if (tray.hidden) {
      if (draftGone) dropDraftSticker("刚选的表情已经不在图库了");
      return;
    }

    const cache = state.stickerCache;
    const next = { ...cache, stickers, groups };
    // 分类被删了：回到「全部」
    if (next.filter && next.filter !== "emoji" && !groups.some((group) => String(group?.id) === next.filter)) {
      next.filter = "";
    }
    // 图库是空的也照样给 Emoji 那一页；但她正选着一个（可能刚建、还是空的）分类时，
    // 不能因为总图数是 0 就把她踢回 Emoji。
    if (!stickers.length && !next.filter) next.filter = "emoji";

    const changed = stickerListSignature(cache) !== stickerListSignature(next) || cache.filter !== next.filter;
    state.stickerCache = next;

    trayCount.textContent = stickers.length ? stickers.length + " 张" : "";
    if (draftGone) dropDraftSticker("刚选的表情已经不在图库了");
    if (!changed && !opening) return;
    // 重画时保留搜索、当前分类（含 Emoji 页）与滚动位置
    const scroll = Number(trayGrid.scrollTop) || 0;
    renderTrayTabs();
    renderTrayGrid();
    trayGrid.scrollTop = scroll;
  }

  /** 待发的那张被本体删了：只清那张，正文/图片/引用一个都不动。 */
  function dropDraftSticker(note) {
    state.draftSticker = null;
    showStickerDraft();
    touchDraft();
    refreshSendButton();
    if (note) setStatus(note);
  }

  function closeTray() { tray.hidden = true; }
  function stopTray() {
    closeTray();
    state.stickerCache = { stickers: [], groups: [], filter: "", query: "" };
  }

  /** 选表情先进待发预览：与正文/引用一起走同一张票，点发送才真的发。 */
  function selectSticker(row) {
    if (!state.agent) return;
    const id = String(row?.id ?? "").trim();
    if (!id) return;
    state.draftSticker = { id, name: row?.description || "表情包" };
    closeTray();
    showStickerDraft();
    touchDraft();
    refreshSendButton();
    setStatus("表情放好了，点发送就发出去");
  }

  // ── 轮询 / 长连接 ──
  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => { if (state.chatOpen) void pull(); }, 20000);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  function closeEvents() {
    if (state.sse) { try { state.sse.close(); } catch { /* 已关 */ } }
    state.sse = null;
    if (state.sseTimer) clearTimeout(state.sseTimer);
    state.sseTimer = null;
  }

  async function reconnect() {
    if (!readTokenState(localStorage.getItem(TOKEN_KEY)).valid) { lockOut("登录过太久了，再输一次密码"); return; }
    try {
      // 只探一次鉴权：网络不通就交给下一次重连，别把 api 当心跳刷。
      await api("partners.list", {}, { timeoutMs: 8000 });
      state.sseDelay = 3000;
    } catch (error) {
      if (isCanceled(error)) return;
      state.sseDelay = Math.min(30000, Math.max(3000, (state.sseDelay || 3000) * 2));
    }
    connectEvents();
  }

  function connectEvents() {
    closeEvents();
    if (!readTokenState(localStorage.getItem(TOKEN_KEY)).valid) return;
    let source = null;
    try { source = new EventSource("/events"); } catch { setLink("offline"); return; }
    state.sse = source;
    setLink("connecting");
    source.onopen = () => setLink("online");
    source.onmessage = (event) => {
      if (!parseThreadEvent(event.data)) return;
      if (state.chatOpen) void pull();
      else void loadPartners();
    };
    source.onerror = () => {
      setLink("offline");
      try { source.close(); } catch { /* 已关 */ }
      state.sse = null;
      // 网关重启或 token 过期都会走到这里：先探一次鉴权，过期就回解锁页。
      if (state.sseTimer) clearTimeout(state.sseTimer);
      state.sseTimer = setTimeout(() => { void reconnect(); }, state.sseDelay || 3000);
    };
  }

  // ── 登录 ──
  async function unlock() {
    const password = pw.value.trim();
    if (!password) return;
    errEl.textContent = "";
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) { errEl.textContent = body?.error?.message || "不对"; return; }
      localStorage.setItem(TOKEN_KEY, writeTokenState(body.token));
      // 重新登录：旧流、旧轮询、旧请求全部作废，别让上一段的回包跑进新会话。
      closeEvents();
      stopPolling();
      tracker.bump();
      gate.hidden = true;
      home.hidden = false;
      chat.hidden = true;
      pw.value = "";
      connectEvents();
      void loadPartners();
    } catch (error) {
      errEl.textContent = "连不上电脑：" + String(error.message);
    }
  }

  // ── 事件绑定 ──
  $("go").addEventListener("click", () => void unlock());
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") void unlock(); });
  $("back").addEventListener("click", () => closeChat());
  $("stickerBtn").addEventListener("click", () => void openTray());
  $("trayClose").addEventListener("click", closeTray);
  $("imgBtn").addEventListener("click", () => fileInput.click());
  // 顶栏的两个工具入口 + 双击伙伴名戳一下（工具模块还没落盘时只说一声）
  toolFavorites?.addEventListener("click", () => {
    if (!tools?.openFavorites) { setStatus("工具还没准备好"); return; }
    void tools.openFavorites();
  });
  whoEl?.addEventListener("dblclick", () => {
    if (!state.chatOpen || state.needsOnboarding === true || !tools?.poke) return;
    void tools.poke();
  });
  jumpBottom?.addEventListener("click", () => { scrollBottom(); maybeMarkRead(); updateJumpBottom(); });
  traySearch?.addEventListener("input", () => {
    state.stickerCache.query = traySearch.value;
    renderTrayGrid();
  });
  stickerDraftDrop?.addEventListener("click", () => { hideStickerDraft(); touchDraft(); refreshSendButton(); });
  // 待发的那张图点一下能看大（不抢长按菜单：菜单挂在消息行上，这个预览条不在行内）
  draftImg?.addEventListener("click", () => { if (state.draftUrl) openOverlay(state.draftUrl); });
  draftDrop.addEventListener("click", () => { state.draftImage = null; clearDraftPreview(); touchDraft(); refreshSendButton(); });
  quoteDrop.addEventListener("click", () => { clearQuoteBar(); touchDraft(); });
  overlayClose.addEventListener("click", () => { overlay.hidden = true; overlayImg.removeAttribute("src"); });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) { overlay.hidden = true; overlayImg.removeAttribute("src"); } });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) void pickImage(file);
  });
  // 粘贴进来的图也当待发图（手机上从相册/浏览器拷图很常见）
  doc.addEventListener("paste", (event) => {
    if (!state.chatOpen) return;
    const items = event?.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!String(item?.type ?? "").startsWith("image/")) continue;
      const file = item.getAsFile?.();
      if (!file) continue;
      event?.preventDefault?.();
      void pickImage(file);
      return;
    }
  });
  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("input", () => { touchDraft(); autoGrow(); refreshSendButton(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
  msgs.addEventListener("scroll", () => {
    // 一滑就把菜单和未触发的长按都收了。
    closeMenu();
    clearPressTimer();
    updateJumpBottom();
    // 滑到底 = 真的看到了：补盖一次已读
    maybeMarkRead();
    if (!state.thread.hasMore) return;
    if (shouldLoadOlder({ scrollTop: msgs.scrollTop }, { hasMore: state.thread.hasMore, loading: state.loadingOlder })) void loadOlder();
  });
  doc.addEventListener("visibilitychange", () => {
    // 切回来且聊天开着：补一次拉取并盖章；切走时停掉正在放的语音，别在后台继续响。
    if (doc.visibilityState === "visible") {
      if (state.chatOpen) {
        maybeMarkRead();
        void pull();
      }
    } else {
      stopPlayback();
      // 切到后台就不演了：把正在长的那一条当场补全，回来看到的是完整话
      clearReveal();
    }
  });

  boot();
  return {
    pull,
    loadOlder,
    send,
    openChat,
    closeChat,
    lockOut,
    state,
    // 测试/排查用：看一眼还有没有“失败可重试”的那张票（含原文字/引用）
    retryPlan: () => sends.retryPlan(),
    // 测试/卸载用：把菜单、计时器、文档级监听一次收干净（页面只调一次 startMobileClient）
    destroy() {
      state.chatOpen = false;
      tracker.bump();
      stopTurnWatch();
      stopPolling();
      closeEvents();
      stopPlayback();
      clearBackground();
      closeMenu();
      clearPressTimer();
      hideCopyBox();
      tools?.reset?.();
      unbindDoc();
      feedMenu.remove();
      copyBox.remove();
    },
  };
}
