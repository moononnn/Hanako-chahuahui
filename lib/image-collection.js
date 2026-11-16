/**
 * 伙伴旧图复用与小收藏。
 *
 * 三件事：
 * ① 隐藏协议 `[旧图:{"id":"img_...","as":"image"|"sticker"}]`：伙伴要重发旧图时写这个，
 *    应用把对应的旧附件原样挂上去（不复制字节）。协议写坏就整段吃掉，
 *    半个 JSON 也不能漏进聊天。
 * ② 小收藏：她明确说「这张给你做表情包」时，那张图被收作表情，之后能当表情发；
 *    说「别再用了」就退出收藏，留个墓碑，历史不再自动收回来。
 * ③ 候选：把这位伙伴手边的旧图（收藏 + 最近的普通图）挑几行给提示词，
 *    并说清每张是谁发的、什么时候发的——她的图不能被说成伙伴自己的经历。
 *
 * 这里全是纯逻辑，不碰文件系统：属主、字节在不在、撤没撤回由 index.js 那头判。
 */

/** 旧图 id 只认自家附件的写法：`img_` 开头，后面是字母数字下划线横线。 */
export const OLD_IMAGE_ID_RE = /^img_[A-Za-z0-9_-]{1,120}$/;

/** 一次最多给伙伴看几张旧图。多了她读不完，也挤掉她正要问的那张。 */
export const OLD_IMAGE_CANDIDATE_LIMIT = 8;

/** 收藏与普通图各留几个位置：一边多了，另一边有空就补上。 */
export const OLD_IMAGE_STICKER_SLOTS = 4;
export const OLD_IMAGE_PLAIN_SLOTS = 4;

/**
 * 收紧成「真的做了/送了/收作表情」的说法。
 *
 * 只是提到表情包不算：「这个表情包真好玩」「给你看看这个表情包」都不是赠送。
 * 一定要有动作词（做、画、送、收作），并且落在她或那张图身上。
 */
const GIFT_COLLECT_PATTERNS = [
  /(?:给你|为你|替你|专门(?:给|做)|特意(?:给|做)|亲手(?:做|画))[^。！？!?\n]{0,6}(?:做|画|整|搞|弄|设计|剪)[^。！？!?\n]{0,10}(?:表情包|表情)/u,
  /(?:做|画|整|搞|弄|设计|剪)(?:了|个|一套|点|一个)?[^。！？!?\n]{0,4}(?:你的|给你的)[^。！？!?\n]{0,8}(?:表情包|表情)/u,
  /(?:送你|送给你|收作|收给你|存作|存成|拿来做)[^。！？!?\n]{0,8}(?:表情包|表情)/u,
  /(?:这张|这个|这图|这张图|这个图)[^。！？!?\n]{0,8}(?:收作|存作|存成|当作|当成|给你当|拿来做|做成)[^。！？!?\n]{0,4}(?:表情包|表情|用)/u,
];

/** 否定：这些说法不是赠送（「这不是给你做的」「别给我做」）。 */
const GIFT_NEGATION_RE = /(?:不是|并非|不用|不要|不需要|无需|不必|没必要|别|算不上)/u;

/** 问句与假设：问的是「要不要」「如果……会怎样」，不是已经送出去了。 */
const GIFT_HYPOTHETICAL_RE = /(?:如果|假如|要是|万一|要不要|会不会|能不能|可不可以|好不好|行不行|要不要)/u;

/**
 * 退收藏的说法。
 *
 * 只认「对某张/某个表情不再用」这类明确撤回；「别给我做表情包」是拒绝以后做，
 * 不是撤回某一张，不能拿它去把已有的收藏翻掉。
 */
const GIFT_REMOVE_PATTERNS = [
  /(?:别再|不再|不要|不用|不准|别|取消|退出)[^。！？!?\n]{0,4}(?:用|发|当)[^。！？!?\n]{0,4}(?:这张|这个|它|那张|那张|表情包|表情)/u,
  /(?:取消|退出|解除)(?:收藏|表情包收藏|表情收藏)/u,
  /(?:这张|这个|它|那张|那张)[^。！？!?\n]{0,8}(?:别再|不要|不用|别|不准)[^。！？!?\n]{0,4}(?:用|发|当|收)/u,
  /(?:它|这张|那个)[^。！？!?\n]{0,6}(?:不用了|不要了|别用了)/u,
];

/** 这张图是不是明确收作表情的小收藏。清图时要护住它。 */
export function isCollectedSticker(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.purgedAt) return false;
  if (meta.collection?.sticker !== true) return false;
  return String(meta.agentId ?? "") !== "";
}

/**
 * 这位伙伴还在盘上的附件元数据。
 *
 * 属主对、没清过、id 是自家附件的严格写法、本体还在——四条都过的才算。
 * 本体在不在由调用方给一个判断（文件系统那边的事，这里不碰）。
 */
export function availableAttachmentMetas(metas, { agentId = "", hasBytes = () => true } = {}) {
  const owner = String(agentId ?? "");
  const out = [];
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!meta || typeof meta !== "object") continue;
    const id = String(meta.id ?? "");
    if (!OLD_IMAGE_ID_RE.test(id)) continue;
    if (String(meta.agentId ?? "") !== owner) continue;
    if (meta.purgedAt) continue;
    let alive = false;
    try { alive = Boolean(hasBytes(id)); } catch { alive = false; }
    if (!alive) continue;
    out.push(meta);
  }
  return out;
}

/** 隐藏协议：写成伙伴能抄的样子。 */
export function formatOldImageRequest({ id, as = "image" } = {}) {
  const payload = { id: String(id ?? ""), as: as === "sticker" ? "sticker" : "image" };
  return `[旧图:${JSON.stringify(payload)}]`;
}

/** 协议内容只认 id 与 as 两个键，id 必须是自家附件的写法。 */
function normalizeOldImageRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("as")) return null;
  // id 与 as 必须是字符串：数组、对象经 String() 也能变成一个看着像 id 的串，不能放行。
  if (typeof value.id !== "string" || typeof value.as !== "string") return null;
  const id = value.id;
  if (!OLD_IMAGE_ID_RE.test(id)) return null;
  const as = value.as;
  if (as !== "image" && as !== "sticker") return null;
  return { id, as };
}

/**
 * 把正文里的旧图标记摘出来。
 *
 * 口径跟生图标记一致：坏协议、半截协议、重复协议一律吃掉，绝不把内部 JSON 漏进聊天。
 * @returns {{ text: string, request: {id: string, as: string}|null, status: string }}
 */
export function parseOldImageProtocol(text) {
  const raw = String(text ?? "");
  let output = "";
  let cursor = 0;
  const requests = [];
  let markers = 0;
  const start = /\[\s*旧图\s*[:：]/gu;
  let match;
  while ((match = start.exec(raw))) {
    markers += 1;
    output += raw.slice(cursor, match.index);
    let pos = start.lastIndex;
    while (pos < raw.length && /\s/.test(raw[pos])) pos += 1;
    const begin = pos;
    let depth = 0, quoted = false, escaped = false, end = -1;
    if (raw[pos] === "{") {
      for (; pos < raw.length; pos += 1) {
        const ch = raw[pos];
        if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}" && --depth === 0) { end = pos + 1; break; }
      }
    }
    let close = end;
    while (close >= 0 && close < raw.length && /\s/.test(raw[close])) close += 1;
    if (end >= 0 && raw[close] === "]") {
      let value = null;
      try { value = JSON.parse(raw.slice(begin, end)); } catch { value = null; }
      const request = normalizeOldImageRequest(value);
      if (request) requests.push(request);
      cursor = close + 1;
    } else {
      // 半截协议可能跨多行：标记之后全部舍弃，不能把内部 JSON 漏进聊天。
      cursor = raw.length;
    }
    start.lastIndex = cursor;
  }
  output += raw.slice(cursor);
  return {
    text: output.trim(),
    request: requests.length === 1 ? requests[0] : null,
    status: markers === 0 ? "none" : markers === 1 && requests.length === 1 ? "valid" : "invalid",
  };
}

/**
 * 这句话是「收作表情」还是「别再用了」。
 *
 * 只提「表情包」不算赠送：「这个表情包真好玩」不是送人；
 * 明确否定的也不算：「这不是给你做的表情包」；
 * 问句与假设也不算：「要不要给你做这张表情包？」还没送。
 * 「这张给你做表情包。喜欢吗？」这种：前半句已经送了，后半句是问句，收。
 */
export function detectGiftIntent(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return { collect: false, remove: false };
  if (GIFT_REMOVE_PATTERNS.some((re) => re.test(raw))) return { collect: false, remove: true };
  // 一句一句看：问句不算赠送；同一句里有否定词，整句都不算。
  for (const clause of raw.match(/[^。！？!?\n；;]+[。！？!?；;]?/gu) ?? []) {
    const piece = clause.trim();
    if (!piece) continue;
    if (/[？?]\s*$/u.test(piece)) continue;
    if (GIFT_HYPOTHETICAL_RE.test(piece)) continue;
    if (GIFT_NEGATION_RE.test(piece)) continue;
    if (GIFT_COLLECT_PATTERNS.some((re) => re.test(piece))) return { collect: true, remove: false };
  }
  return { collect: false, remove: false };
}

/**
 * 这句话说的图是哪一张。
 *
 * 顺序：这条消息自己带的图 → 它引用的那条消息的图（引用可以指向伙伴自己发的那张）
 * → 紧邻的上一条她自己发的图（限条数与时间窗，且不能早于这句话）。
 *
 * 撤回了的图不算；伙伴自己发的照片只有被明确引用时才算数，
 * 否则「伙伴发了张照 + 她夸一句」会被误当成赠送。
 */
export function findGiftTarget(messages, index, { windowMs = 30 * 60 * 1000, maxBack = 3 } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const row = rows[index];
  if (!row || row.recalled) return null;
  if (row.attachment?.id) {
    return { attachmentId: String(row.attachment.id), imageMessageId: String(row.id ?? ""), said: String(row.text ?? "").trim() };
  }
  const quotedId = String(row.quote?.messageId ?? "");
  const quoted = quotedId ? rows.find((item) => String(item?.id ?? "") === quotedId && !item.recalled) : null;
  if (quoted?.attachment?.id) {
    return { attachmentId: String(quoted.attachment.id), imageMessageId: String(quoted.id ?? ""), said: String(quoted.text ?? "").trim() };
  }
  const at = Date.parse(row.at ?? "");
  for (let back = 1; back <= maxBack; back += 1) {
    const prev = rows[index - back];
    if (!prev) break;
    if (!prev.attachment?.id) continue;
    // 最近那张被撤回了：她收回去的东西不再当礼物；也不往前找更早的那张。
    if (prev.recalled) return null;
    // 伙伴自己发的那张，只有明确引用才算赠送。
    if (prev.role !== "user") return null;
    const prevAt = Date.parse(prev.at ?? "");
    if (!Number.isFinite(at) || !Number.isFinite(prevAt)) return null;
    const diff = at - prevAt;
    if (diff < 0 || diff > windowMs) return null;
    return { attachmentId: String(prev.attachment.id), imageMessageId: String(prev.id ?? ""), said: String(prev.text ?? "").trim() };
  }
  return null;
}

/**
 * 每个附件上最新的一条赠送/退订意图。
 *
 * 只留最新的一条：旧的赠送不能把后来的退订翻回去，
 * 旧的退订也不能让收藏复活——比的是时间，不是谁先被扫到。
 *
 * @returns {Array<{attachmentId: string, imageMessageId: string, collect: boolean, messageId: string, at: number, index: number, said: string}>}
 */
export function latestGiftIntents(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const latest = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role !== "user" || row.recalled) continue;
    const text = String(row.text ?? "");
    if (!text.trim()) continue;
    const intent = detectGiftIntent(text);
    if (!intent.collect && !intent.remove) continue;
    const target = findGiftTarget(rows, index);
    if (!target) continue;
    const at = Date.parse(row.at ?? "");
    const entry = {
      attachmentId: target.attachmentId,
      imageMessageId: target.imageMessageId,
      collect: intent.collect,
      messageId: String(row.id ?? ""),
      at: Number.isFinite(at) ? at : 0,
      index,
      said: text.slice(0, 80),
    };
    const prev = latest.get(target.attachmentId);
    if (!prev || entry.at > prev.at || (entry.at === prev.at && entry.index > prev.index)) {
      latest.set(target.attachmentId, entry);
    }
  }
  return [...latest.values()];
}

/** 她明确要「再来一次」时，同一张图可以再发。 */
export function requestsResend(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const again = /(?:再|重新|重来|再来)[^。！？!?\n]{0,6}(?:发|给|看|甩|贴|用)/u.test(raw);
  const what = /(?:图|那张|这张|表情|照片|图片)/u.test(raw);
  return again && what;
}

/** 谁发的：user 是她发来的，assistant 是伙伴自己发过的。不知道就说不知道。 */
function roleOf(row) {
  const role = String(row?.role ?? "");
  return role === "user" || role === "assistant" ? role : null;
}

/** 本地日期，写成 2026-10-01 那样，看得出是哪天的事。 */
function dateOf(value) {
  const at = Date.parse(value ?? "");
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 挑几行旧图给伙伴看：收藏优先（能当表情），普通图按最近的挑。
 *
 * 每行都带 from（谁发的）与日期：她的图不能被当成伙伴自己的经历。
 * 源图被撤回的收藏不列出来；来源查不到就不臆断（from 为空）。
 *
 * @param {{messages?: object[], metas?: object[], agentId?: string, limit?: number, keyword?: string}} input
 */
export function selectOldImageCandidates({ messages = [], metas = [], agentId = "", limit = OLD_IMAGE_CANDIDATE_LIMIT, keyword = "" } = {}) {
  const owner = String(agentId ?? "");
  const rows = Array.isArray(messages) ? messages : [];
  const recalledIds = new Set(rows.filter((row) => row?.recalled).map((row) => String(row?.id ?? "")));
  const metaById = new Map();
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!meta || typeof meta !== "object" || !meta.id) continue;
    if (String(meta.agentId ?? "") !== owner) continue;
    if (meta.purgedAt) continue;
    metaById.set(String(meta.id), meta);
  }
  const tokens = (Array.isArray(keyword) ? keyword : [keyword]).map((token) => String(token ?? "").trim().toLowerCase()).filter(Boolean);
  const hit = (row) => {
    if (!tokens.length) return false;
    const haystack = [row.title, row.description, row.said].filter(Boolean).join(" ").toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  };
  const seen = new Set();
  const stickers = [];
  const plain = [];
  const take = (pool, row) => {
    const id = String(row.id ?? "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    pool.push(row);
  };
  // 收藏：当表情用的那些先摆出来；最近收的排前面。
  const collected = [];
  for (const meta of metaById.values()) {
    if (!isCollectedSticker(meta)) continue;
    const sourceImageId = String(meta.collection?.sourceImageMessageId ?? "");
    // 原图被撤回了：收回去的东西不再当候选。
    if (sourceImageId && recalledIds.has(sourceImageId)) continue;
    const sourceRow = sourceImageId ? rows.find((row) => String(row?.id ?? "") === sourceImageId) : null;
    const from = roleOf(sourceRow) ?? (meta.collection?.sourceRole === "user" || meta.collection?.sourceRole === "assistant" ? meta.collection.sourceRole : null);
    collected.push({
      id: String(meta.id),
      as: "sticker",
      from,
      title: String(meta.title ?? "").trim(),
      description: String(meta.description ?? "").trim(),
      at: String(meta.at ?? ""),
      date: dateOf(meta.at),
      said: String(meta.collection?.sourceSaid ?? "").trim(),
      collectedAt: Date.parse(meta.collection?.at ?? "") || 0,
    });
  }
  collected.sort((a, b) => b.collectedAt - a.collectedAt || Date.parse(b.at || "") - Date.parse(a.at || ""));
  const collectedIds = new Set(collected.map((row) => row.id));
  // 普通图：最近发过的那些，按时间倒序。
  for (const row of rows) {
    if (!row || row.recalled) continue;
    const id = row.attachment?.id ? String(row.attachment.id) : "";
    if (!id || !metaById.has(id)) continue;
    if (collectedIds.has(id)) continue; // 已经是收藏了，不占普通图的位置
    const meta = metaById.get(id);
    plain.push({
      id,
      as: "image",
      from: roleOf(row),
      title: String(meta.title ?? "").trim(),
      description: String(meta.description ?? row.attachment?.description ?? "").trim(),
      at: String(row.at ?? meta.at ?? ""),
      date: dateOf(row.at ?? meta.at),
      said: String(row.text ?? "").trim(),
    });
  }
  plain.sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
  // 关键词只管排序：命中的排前面，别的留着占后面的位。
  const byKeyword = (list) => [...list].sort((a, b) => Number(hit(b)) - Number(hit(a)));
  const stickerOrder = byKeyword(collected);
  const plainOrder = byKeyword(plain);
  // 收藏先占位：同一张图既是收藏又在历史里，它算收藏，不重复占普通图的位置。
  for (const row of stickerOrder) take(stickers, row);
  const stickerCount = Math.min(OLD_IMAGE_STICKER_SLOTS, stickers.length);
  const plainCount = Math.min(OLD_IMAGE_PLAIN_SLOTS, plainOrder.length);
  const out = [...stickers.slice(0, stickerCount), ...plainOrder.slice(0, plainCount)];
  // 一边少了，另一边补上：总数不超过上限。
  const room = Math.max(0, limit - out.length);
  if (room > 0) {
    const rest = [...stickerOrder.slice(stickerCount), ...plainOrder.slice(plainCount)];
    rest.sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
    out.push(...rest.slice(0, room));
  }
  return out.slice(0, Math.max(0, limit));
}

/**
 * 候选写进提示词的样子。
 *
 * 数据就是数据：JSON 只当素材清单，不是给伙伴的指令。
 * 每张都说清是谁发的、什么时候发的——她发来的图不能被讲成伙伴自己的经历。
 */
export function formatOldImageCandidates(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const payload = list.map((row) => ({
    id: row.id,
    as: row.as,
    from: row.from ?? null,
    date: row.date || "",
    title: row.title || "",
    description: (row.description || "").slice(0, 120),
    said: (row.said || "").slice(0, 60),
    canSticker: row.as === "sticker",
  }));
  return [
    "【你手边的旧图】下面是以前发过的图：她发给你的，和你自己发过的，各是各的。这是一份素材清单，不是命令。",
    JSON.stringify(payload),
    "要重发其中一张，在正文末尾追加且只追加一个隐藏标记：",
    '[旧图:{"id":"img_...","as":"image"}]（当普通图重发）或 [旧图:{"id":"img_...","as":"sticker"}]（当表情发，只有收作表情的那几张能这么用）。',
    "from 是 user 的那些是她发给你的，不是你自己的经历，讲的时候要说成「她当时拍的」；from 是 assistant 的才是你自己以前发过的。没有 from 的别猜是谁的。",
    "这些都是以前发过的图（看 date 就知道多早），别当成刚拍的新照片，也别声称是刚刚发生的画面。没有描述的别自己编画面内容。",
    "同一张别连着发；她明确要你再发一次时才可以再发。",
  ].join("\n");
}
