/**
 * 表情包联动：只借不给。
 *
 * 图库、标签、分组白名单、偏好、最近发送全部由「表情包」插件拥有，
 * 表情包插件把一份只读快照写在 plugin-data/biaoqingbao/public-index.json（契约见那份仓库的 PUBLIC-INDEX.md）。
 * 茶话会只做三件事：读快照、按自己的规矩挑一张、交给聊天窗渲染。
 *
 * 三条永远不变的前提：
 *   1. 只读。茶话会绝不写回表情包的任何数据，也绝不在里面留下痕迹。
 *   2. 挂了就静默降级。没装表情包、快照缺失、图库为空 —— 都只是"这次没有表情包"，绝不报错。
 *   3. 挑图权在本地，模型只给关键词。图太多，让模型点文件模型会瞎点。
 *
 * 纯逻辑为主，不碰模型；只有 readCatalog 一处读盘。
 */

import path from "node:path";
import { looksLikeImage, toBytes } from "./avatar.js";

/** 表情包插件的数据目录名与快照文件名（对外的门面，不随插件内部结构变）。 */
export const STICKER_PLUGIN_ID = "biaoqingbao";
export const STICKER_INDEX_FILE = "public-index.json";
/** 认得的快照版本；不是这个版本就别解析。 */
export const STICKER_INDEX_SCHEMA_VERSION = 1;
/** 快照在内存里缓存多久（毫秒）。够短，她改完偏好很快能反映过来。 */
export const CATALOG_TTL_MS = 60 * 1000;

/**
 * 标记：模型用它点关键词，例如 `[表情:无语]`；单独一行或接在句尾都认。
 *
 * 2026-09-15 放宽（实机上模型写成 `【表情包：呆萌】`，一个都没吃上，
 * 那串标记原样漏进了聊天）：半角/全角方括号、`表情`/`表情包`、半角/全角冒号，四种写法都认。
 */
const MARKER_RE = /[\[【［]\s*表情包?\s*[:：]\s*([^\]】］\n]{1,20}?)\s*[\]】］]/g;
/** 气泡里的表情包哨兵前缀。用控制字符，正常文本里绝不会出现。 */
const STICKER_BUBBLE_PREFIX = "\u0001stk:";

/** 换一个新的正则实例：MARKER_RE 带 /g，共享 lastIndex 容易踩坑。 */
function markerScanner() {
  return new RegExp(MARKER_RE.source, MARKER_RE.flags);
}

/**
 * 把正文里剩下的表情标记整体拿掉，包括没被识别的变体写法。
 * 用在聊天回复的出口清洗上：宁可这张图不发，也不能把 `【表情包：呆萌】` 这种字面量发给对方。
 */
export function stripStickerMarkup(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return raw;
  return raw.replace(markerScanner(), "").replace(BARE_MARKER_RE, "");
}

/**
 * 残缺标记：模型偶尔漏写关键词，只剩一个光秃秃的 `[表情]`（也可能带个空冒号）。
 * 它不是要说的内容，同样得吃掉——实机撞到过直接显示成「[表情]」三个字。
 */
const BARE_MARKER_RE = /[\[【［]\s*表情包?\s*[:：]?\s*[\]】］]/g;

/** 挑图与发送的默认规矩。 */
export const DEFAULT_STICKER_RULES = Object.freeze({
  /** 最近这几张不再重复 */
  avoidRecentCount: 6,
  /** 同一个关键词最多从这几张候选里随机挑 */
  candidatePool: 12,
});

export function encodeStickerBubble(stickerId) {
  return `${STICKER_BUBBLE_PREFIX}${String(stickerId ?? "").trim()}`;
}

export function isStickerBubble(text) {
  return typeof text === "string" && text.startsWith(STICKER_BUBBLE_PREFIX);
}

export function stickerIdFromBubble(text) {
  return isStickerBubble(text) ? text.slice(STICKER_BUBBLE_PREFIX.length) : "";
}

/**
 * 把模型输出里的表情标记摘出来。
 * 标记通常自己占一行，但模型偶尔会把它接在句尾；两种写法都认。
 * 除了第一个标记拿来点图，剩下的（含各种变体写法）一律从正文里吃掉。
 * @returns {{ before: string, after: string, keyword: string }}
 */
export function parseStickerMarker(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return { before: raw, after: "", keyword: "" };

  const scan = markerScanner();
  let first = null;
  let match;
  while ((match = scan.exec(raw))) {
    if (!first) first = { index: match.index, end: scan.lastIndex, keyword: match[1].trim() };
  }
  if (!first) return { before: raw, after: "", keyword: "" };

  const before = raw.slice(0, first.index);
  const after = stripStickerMarkup(raw.slice(first.end));
  return { before: before.trim(), after: after.trim(), keyword: first.keyword };
}

/** 快照里那个伙伴的那一份；没有就按"没有白名单、没有偏好"处理。 */
export function partnerEntry(index, agentId) {
  const id = String(agentId ?? "").trim();
  const partners = index && typeof index === "object" ? index.partners : null;
  const entry = partners && typeof partners === "object" ? partners[id] : null;
  return entry && typeof entry === "object" ? entry : null;
}

/**
 * 从快照里挑出这个伙伴真正能用的图。
 * @returns {{ stickers: object[], byId: Map<string, object> }}
 */
export function buildCatalog(index, agentId) {
  const all = Array.isArray(index?.stickers) ? index.stickers : [];
  const entry = partnerEntry(index, agentId);
  const allowed = Array.isArray(entry?.allowed) ? new Set(entry.allowed.map(String)) : null;
  const vetoed = new Set((Array.isArray(entry?.vetoed) ? entry.vetoed : []).map(String));
  const stickers = all.filter((row) => {
    if (!row || typeof row !== "object" || !row.id) return false;
    const id = String(row.id);
    if (allowed && !allowed.has(id)) return false;
    return !vetoed.has(id);
  });
  const byId = new Map(stickers.map((row) => [String(row.id), row]));
  return { stickers, byId, preferred: new Set((Array.isArray(entry?.preferred) ? entry.preferred : []).map(String)) };
}

function normalizeTerm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function termsOf(sticker) {
  const bag = [];
  for (const key of ["emotion", "scene", "keywords"]) {
    const list = Array.isArray(sticker?.[key]) ? sticker[key] : [];
    for (const item of list) {
      const text = normalizeTerm(item);
      if (text) bag.push({ text, weight: key === "emotion" ? 3 : key === "keywords" ? 2 : 1 });
    }
  }
  const description = normalizeTerm(sticker?.description);
  return { bag, description };
}

/**
 * 按关键词给候选打分。命中情绪标签最高，其次关键词，再其次场景与画面描述。
 * 关键词为空、或者一个都没命中时返回空数组——这只是「精确」那一层的结论，
 * 最终发不发由 pickSticker 定，那儿还有一层沾亲带故的兜底。
 */
export function matchStickers(stickers, keyword) {
  const query = normalizeTerm(keyword);
  if (!query) return [];
  const scored = [];
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const { bag, description } = termsOf(sticker);
    let score = 0;
    for (const term of bag) {
      if (term.text === query) score = Math.max(score, 100 * term.weight);
      else if (term.text.includes(query) || query.includes(term.text)) score = Math.max(score, 60 * term.weight);
    }
    if (score === 0 && description && description.includes(query)) score = 40;
    if (score > 0) scored.push({ sticker, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.sticker.id).localeCompare(String(b.sticker.id)));
  return scored;
}

/**
 * 兜底那一层：精确和包含都没命中时，退一步找「沾亲带故」的标签（至少共用一个汉字）。
 *
 * 2026-09-13 加：ta想甩图，却被一个图库里恰好没有的词卡住，白挑一次太可惜。
 * 定下的态度是「闲聊里甩错图没关系，就当没认真挑」，
 * 所以宁可发一张不太贴的，也别空手。
 * 只在零命中时才启用，正常词的排序一点不受影响。
 */
export function looseMatchStickers(stickers, keyword) {
  const query = normalizeTerm(keyword);
  if (!query) return [];
  const chars = [...new Set(query.split(""))].filter((ch) => /[\u4e00-\u9fa5]/.test(ch));
  if (chars.length === 0) return [];
  const scored = [];
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const { bag } = termsOf(sticker);
    let best = 0;
    for (const term of bag) {
      const shared = chars.filter((ch) => term.text.includes(ch)).length;
      if (shared > 0) best = Math.max(best, shared * 10 * term.weight);
    }
    if (best > 0) scored.push({ sticker, score: best });
  }
  scored.sort((a, b) => b.score - a.score || String(a.sticker.id).localeCompare(String(b.sticker.id)));
  return scored;
}

function shuffled(list, rnd) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 挑一张图。同分的一档里随机取，避免老发同一张；被偏爱的图优先一点。
 * @returns {object|null} 快照里的那条 sticker
 */
export function pickSticker(catalog, { keyword, recentIds = [], rules = DEFAULT_STICKER_RULES, rnd = Math.random } = {}) {
  // 两级：先精确/包含匹配，一个都没中再退到共用汉字的弱匹配。
  // 弱匹配也没捞着，那才是真没图可发，这次就不发。
  let matched = matchStickers(catalog?.stickers, keyword);
  if (matched.length === 0) matched = looseMatchStickers(catalog?.stickers, keyword);
  if (matched.length === 0) return null;
  const avoid = new Set((Array.isArray(recentIds) ? recentIds : []).map(String));
  const pool = matched.slice(0, Math.max(1, Number(rules.candidatePool) || DEFAULT_STICKER_RULES.candidatePool));
  const fresh = pool.filter((row) => !avoid.has(String(row.sticker.id)));
  let from = fresh.length ? fresh : pool;
  const preferred = catalog?.preferred;
  if (preferred && preferred.size) {
    const liked = from.filter((row) => preferred.has(String(row.sticker.id)));
    if (liked.length) from = liked;
  }
  return shuffled(from.map((row) => row.sticker), rnd)[0] ?? null;
}

/** 最近一次甩表情包是什么时候（毫秒时间戳）；没有就 0。 */
export function lastStickerAt(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i];
    if (!row) continue;
    const bubbles = Array.isArray(row.bubbles) && row.bubbles.length ? row.bubbles : [row.text];
    if (bubbles.some((piece) => isStickerBubble(piece))) return Number(row.at) || 0;
  }
  return 0;
}

/** 从最近的消息里收集用过的表情 id（新的在前），用来避免连发同一张。 */
export function recentStickerIds(history, limit = DEFAULT_STICKER_RULES.avoidRecentCount) {
  const out = [];
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const row = list[i];
    if (!row) continue;
    const bubbles = Array.isArray(row.bubbles) && row.bubbles.length ? row.bubbles : [row.text];
    for (const piece of bubbles) {
      const id = stickerIdFromBubble(piece);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out.slice(0, Math.max(0, Number(limit) || 0));
}

/** 脏标签：带标点、带空格、或者长得不像一个词的，都不往词表里塞。 */
const TAG_JUNK_RE = /[，,、。！？!?；;：:\s/]/;

/** 参考词：该伙伴能用的图里最高频的情绪标签，给模型当词表（可超出这个范围）。 */
export function referenceWords(catalog, limit = 12) {
  const counts = new Map();
  for (const sticker of catalog?.stickers ?? []) {
    for (const tag of Array.isArray(sticker.emotion) ? sticker.emotion : []) {
      const word = String(tag ?? "").trim();
      if (!word || TAG_JUNK_RE.test(word) || word.length > 6) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(([word]) => word);
}

/**
 * 拼给模型看的那一段。图库为空时返回空串——没图就别提这回事。
 *
 * 2026-09-13 改过一版（原来只有一段原则加一个例子，实测基本不触发）：
 *   ① 先摆清楚「哪几个劲儿上会甩图」——具体到场景，模型才好对号；
 *   ② 给一组照着抄的示范。模型是模仿动物，看见怎么用的比读十条说明管用；
 *   ③ 词表从 60 个放到全量，并且松开「别自己造新词」那道口子：
 *      图的匹配有兜底，想到更贴的词照写就是。
 *
 * 两个不变的点：图是ta自己这句话的态度（赌气、嫌弃、得意都算），不是送对方的安慰；
 * 一条回复最多一张。写法上避开“请注意”“不要”这类指令腔，讲成“你就是这么聊天的”。
 */
export function buildStickerHint(catalog) {
  if (!catalog || !Array.isArray(catalog.stickers) || catalog.stickers.length === 0) return "";
  const words = referenceWords(catalog, 400);
  const wordLine = words.length ? `你手边的词大概有这些（只是参考，想到更贴的照写）：${words.join("、")}。` : "";
  return [
    "【表情包】",
    "你手机上有一堆自己的表情包，说话说到某个劲儿上会顺手甩一张。它不是送她的安慰，也不是替你说的客套话，就是你此刻的态度。",
    "到了这几个劲儿上，图比字省事：一句吐槽到了嘴边、被气笑、无语到懒得打字、嫌弃她、得意、想逗她、懒得接这茬。",
    "想甩就单独占一行写 [表情:关键词]，一两个字。这个形状就这么一种，不要换成全角括号、不要写「表情包」三个字、不要加引号，也不要在任何地方解释这张图、解释这个写法、讨论格式对不对。这个词说的是你自己这句话的语气：赌气、嫌弃、得意、懒得理、想逗她，都算。就是这样用的：",
    "她说「我那个 bug 又复现了」",
    "你回：",
    "又来",
    "[表情:无语]",
    "",
    "她说「你猜我今天睡到几点」",
    "你回：",
    "[表情:得意]",
    "（图自己就是你想说的话，不用解释这张图是什么）",
    wordLine,
    "一条回复最多一张。也不是每句都往外套，甩多了就不值钱了。",
  ].join("\n");
}

/** 供路由用：把快照里的相对路径拼成绝对路径。 */
export function stickerAbsolutePath(hanaHome, relative) {
  const rel = String(relative ?? "").replace(/^[\\/]+/, "").split(/[\\/]+/).filter((seg) => seg && seg !== "." && seg !== "..");
  if (!rel.length) return "";
  return path.join(hanaHome, "plugin-data", STICKER_PLUGIN_ID, ...rel);
}

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 按扩展名给 Content-Type；认不出就当 JPEG。 */
export function contentTypeForSticker(file) {
  const ext = String(file ?? "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "image/jpeg";
}

/**
 * 读一张表情包的字节，交给路由发给聊天窗。
 * 对不上图片头就当没读到——宁可这一条不显示图，也不把乱码送进界面。
 * @returns {Promise<{bytes: Buffer, contentType: string}|null>}
 */
export async function readStickerBytes(ctx, relativeFile, hanaHome) {
  const abs = stickerAbsolutePath(hanaHome, relativeFile);
  if (!abs) return null;
  try {
    const result = await ctx.resources.read({ kind: "local-file", path: abs }, { encoding: "base64" });
    const bytes = toBytes(result);
    if (!bytes || !looksLikeImage(bytes)) return null;
    return { bytes, contentType: contentTypeForSticker(relativeFile) };
  } catch {
    return null;
  }
}

let cache = { value: null, at: 0 };

/** 仅供测试：清掉内存缓存。 */
export function __clearCatalogCache() {
  cache = { value: null, at: 0 };
}

/**
 * 真去读一次盘，并把「为什么没读到」带上。
 * @returns {{ index: object|null, reason: string }}
 */
async function loadCatalog(ctx) {
  const dataDir = String(ctx?.dataDir ?? "");
  if (!dataDir) return { index: null, reason: "no-data-dir" };
  const hanaHome = path.dirname(path.dirname(dataDir));
  const file = path.join(hanaHome, "plugin-data", STICKER_PLUGIN_ID, STICKER_INDEX_FILE);
  let text = "";
  try {
    const result = await ctx.resources.read({ kind: "local-file", path: file });
    text = typeof result?.content === "string"
      ? result.content
      : (result?.content ? Buffer.from(result.content).toString("utf8") : "");
  } catch {
    return { index: null, reason: "read-failed" };
  }
  if (!text) return { index: null, reason: "not-found" };
  let index = null;
  try {
    index = JSON.parse(text);
  } catch {
    return { index: null, reason: "bad-json" };
  }
  if (!index || Number(index.schemaVersion) !== STICKER_INDEX_SCHEMA_VERSION) {
    return { index: null, reason: "schema-mismatch" };
  }
  if (!Array.isArray(index.stickers) || index.stickers.length === 0) {
    return { index: null, reason: "empty" };
  }
  return { index, reason: "ok" };
}

/**
 * 读快照，并且说清楚成没成。界面要讲人话，所以有一层专门带原因。
 * @param {object} ctx  App 的 ctx（用它的 resources.read 和 dataDir）
 */
export async function readCatalogWithReason(ctx, { now = Date.now(), ttlMs = CATALOG_TTL_MS } = {}) {
  if (cache.value && now - cache.at < ttlMs) return { index: cache.value, reason: "ok" };
  const loaded = await loadCatalog(ctx);
  if (loaded.index) cache = { value: loaded.index, at: now };
  return loaded;
}

/**
 * 读那份快照。任何一步出问题都返回 null，调用方当"这次没有表情包"处理。
 * @param {object} ctx  App 的 ctx（用它的 resources.read 和 dataDir）
 */
export async function readCatalog(ctx, opts) {
  const { index } = await readCatalogWithReason(ctx, opts);
  return index;
}

/** 仅用于手动导入界面；来源插件不存在或快照不可读时返回 null。 */
export const readSourceCatalog = readCatalog;

/**
 * 快照里的原始一行，不看伙伴白名单。
 * 导入页是「她进货」的地方，跟哪个伙伴没关系，得看得见全库。
 */
export function sourceRowById(index, id) {
  const want = String(id ?? "");
  if (!want) return null;
  for (const row of Array.isArray(index?.stickers) ? index.stickers : []) {
    if (String(row?.id ?? "") === want) return row;
  }
  return null;
}

/**
 * 这行有没有能读的标签。
 * 没有标签的图，伙伴那边只能看到"[表情]"两个字，等于发了个寂寞，所以不让进图库。
 */
export function hasUsableTags(row) {
  for (const key of ["emotion", "scene", "keywords"]) {
    const list = Array.isArray(row?.[key]) ? row[key] : [];
    if (list.some((item) => String(item ?? "").trim())) return true;
  }
  return false;
}

/** 一张图的标签说成人话；没标签就是空串。 */
export function stickerLabelText(row, max = 40) {
  const words = [];
  for (const key of ["emotion", "scene"]) {
    const list = Array.isArray(row?.[key]) ? row[key] : [];
    for (const item of list) {
      const text = String(item ?? "").trim();
      if (text) words.push(text);
    }
  }
  const text = words.length ? words.join("、") : String(row?.description ?? "").trim();
  return text.slice(0, max);
}

/**
 * 给历史里的表情包找标签：先看茶话会自己的图库，再看快照（老消息里残留的外部 id）。
 * 只在本地查，不依赖表情包插件当场在线。
 * @returns {Map<string, string>} 图 id → 一句人话
 */
export function stickerLabelMap({ library, catalog } = {}) {
  const map = new Map();
  const put = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const label = stickerLabelText(row);
      if (label) map.set(String(row?.id ?? ""), label);
    }
  };
  put(catalog?.stickers);
  put(library?.stickers);
  return map;
}
