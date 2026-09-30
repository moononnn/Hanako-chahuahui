/**
 * 伙伴投喂 —— 她也可以给你递个小东西。
 *
 * 总纲见 `DESIGN-partner-feed.md`。这里只放判定和挑品，不碰存储、不调模型。
 *
 * 为什么要单开一条通道：ta 的其他表达都要"说一句话"，说话就有成本——
 * 说出去就等回音，可能已读不回，可能撞上「等回音」那段空白。
 * 投喂是这个结构里唯一一个成本为零的动作。它只能表达一件事：**我看到了**。
 *
 * 三条硬规矩，写死在代码里，不交给提示词自觉：
 *   ① 只挂在 ta 真的读过的消息上（readAt）。没读过就递东西，等于替她说了她还没说的话。
 *   ② 不许拿来回避正题。直接问的、认真的心事，ta 该说就说，投喂顶不上。
 *   ③ 一天最多两次。轻的东西一旦变多就不轻了。
 */

/** 一天最多递这么多次。两次是上限，不是配额。 */
export const PARTNER_FEED_MAX_PER_DAY = 2;
/** 两次之间至少隔这么久。太密就变成刷屏了。 */
export const PARTNER_FEED_MIN_GAP_MS = 90 * 60 * 1000;
/** 最近递过的这几个不重复用，免得递出习惯。 */
export const RECENT_LIMIT = 3;

/**
 * 往回找候选时看最近这么多条；只回找伙伴尚未回应的连续用户消息。
 */
export const FEED_SCAN_LIMIT = 30;
/** 候选最多只能比现在早这么久。挂件落在半个月前的话上，像考古。 */
export const FEED_FRESH_HOURS = 48;
/** 伙伴只要回复过这条消息，就不再给它补「我看到了、但没有要接话」的投喂。 */
export const FEED_MAX_ANSWERS_AFTER = 0;
/** 读完到能递，至少隔这么久。刚读完就递会显得急，她可能正在回。 */
export const FEED_SETTLE_MIN = 5;
/** 冷处理那条：读过之后至少安静这么久，才递得像「我还在」而不是台阶。 */
export const FEED_COLD_HOURS = 3;

/**
 * ta 手边有什么。
 *
 * 这些不是"通用礼物表"，是「她自己的东西」：关键词命中 ta 兴趣里的词，
 * 那个东西才算她手边真有。命中不到就走兜底池，按伙伴 id 稳定轮转——
 * 换个人装这个应用，同一件事不会递出同一杯咖啡。
 *
 * 关键词一律两个字以上、不带泛化词。宁可漏判也不误判：
 * 「喝水」不该递奶茶、「糖尿病」不该递糖果、「看看」不该递一本书。
 */
export const FEED_ASSETS = Object.freeze([
  { emoji: "☕", keys: ["咖啡", "手冲", "拿铁", "美式", "espresso"] },
  { emoji: "🍵", keys: ["绿茶", "红茶", "乌龙", "普洱", "抹茶", "奶茶", "茶会"] },
  { emoji: "🧋", keys: ["珍珠", "奶茶", "饮品"] },
  { emoji: "🍰", keys: ["甜品", "蛋糕", "烘焙", "甜点", "面包"] },
  { emoji: "🍩", keys: ["甜甜圈", "donut"] },
  { emoji: "🍪", keys: ["饼干", "曲奇", "零食"] },
  { emoji: "🍫", keys: ["巧克力", "可可"] },
  { emoji: "🍬", keys: ["糖果", "奶糖", "水果糖"] },
  { emoji: "🍭", keys: ["棒棒糖"] },
  { emoji: "🍓", keys: ["草莓", "树莓"] },
  { emoji: "🍑", keys: ["桃子", "樱桃"] },
  { emoji: "🥛", keys: ["牛奶", "乳品", "酸奶"] },
  { emoji: "🍜", keys: ["拉面", "汤面", "意面"] },
  { emoji: "🍡", keys: ["麻薯", "日料", "和果子"] },
  { emoji: "🍙", keys: ["饭团", "便当"] },
  { emoji: "🌿", keys: ["薄荷", "香草", "绿植", "多肉"] },
  { emoji: "🎧", keys: ["音乐", "听歌", "唱歌", "乐队", "钢琴"] },
  { emoji: "📖", keys: ["读书", "小说", "漫画"] },
  { emoji: "🎬", keys: ["电影", "追剧", "动画"] },
  { emoji: "📷", keys: ["拍照", "摄影", "相机"] },
  { emoji: "🎮", keys: ["游戏", "主机"] },
  { emoji: "🧸", keys: ["毛绒", "娃娃", "玩偶", "公仔"] },
  { emoji: "🧵", keys: ["手作", "编织", "钩针", "手工"] },
  { emoji: "🌱", keys: ["种花", "种植", "多肉", "绿植"] },
  { emoji: "🐟", keys: ["金鱼", "养鱼", "水族"] },
]);

/** 什么都没命中时从这儿递（按 id 稳定轮转，不是随机）。 */
const FALLBACK_POOL = Object.freeze(["🍪", "🧋", "🍵", "🍬", "🥛", "🍊"]);

const MAX_ITEMS = 16;

function clean(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function cleanEmoji(value) {
  return String(value ?? "").trim().slice(0, 16);
}

function cleanCount(value) {
  return Math.max(1, Math.min(99, Math.floor(Number(value) || 1)));
}

function truthyText(value) {
  return String(value ?? "").trim();
}

/* ── 账：消息上挂的那一份 ────────────────────────────────────── */

/**
 * 伙伴投喂的账本。跟用户给 ta 的投喂（feed.js）是两本，别混。
 * 多带一个 kind 和 reason：这不是"她喜欢"，是"她在什么情况下递的"。
 */
export function normalizePartnerFeed(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = [];
  const byEmoji = new Map();
  for (const raw of rawItems) {
    const emoji = cleanEmoji(raw?.emoji);
    if (!emoji) continue;
    const existing = byEmoji.get(emoji);
    if (existing) {
      existing.count = cleanCount(existing.count + cleanCount(raw?.count));
      existing.at = raw?.at || existing.at;
      continue;
    }
    const item = {
      emoji,
      count: cleanCount(raw?.count),
      ...(raw?.at ? { at: String(raw.at) } : {}),
      ...(raw?.kind ? { kind: clean(raw.kind, 40) } : {}),
      ...(raw?.reason ? { reason: clean(raw.reason, 160) } : {}),
    };
    byEmoji.set(emoji, item);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return { items };
}

export function addPartnerFeed(value, emoji, { at = new Date().toISOString(), kind = "", reason = "" } = {}) {
  const feed = normalizePartnerFeed(value);
  const target = cleanEmoji(emoji);
  if (!target) return feed;
  const item = feed.items.find((row) => row.emoji === target);
  if (item) {
    item.count = cleanCount(item.count + 1);
    item.at = String(at);
  } else {
    feed.items.push({
      emoji: target,
      count: 1,
      at: String(at),
      ...(kind ? { kind: clean(kind, 40) } : {}),
      ...(reason ? { reason: clean(reason, 160) } : {}),
    });
  }
  return feed;
}

export function partnerFeedItems(value) {
  return normalizePartnerFeed(value).items;
}

export function formatPartnerFeed(value) {
  return partnerFeedItems(value)
    .map((row) => `${row.emoji}${row.count > 1 ? `×${row.count}` : ""}`)
    .join(" ");
}

/* ── 门禁 ─────────────────────────────────────────────────── */

/**
 * 该不该现在递。
 *
 * 只看三件事：今天递过几次、上次什么时候、ta 手上是不是正忙着。
 * 「该不该递」的技术判断都在这儿，语义判断留给 detectFeedSignal。
 */
export function gateFeed({ state = null, now = new Date(), busy = false, day = "" } = {}) {
  if (busy) return { ok: false, reason: "busy" };
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "bad-time" };
  const today = day || lifeDay(at);
  const sameDay = String(state?.day ?? "") === today;
  const count = sameDay ? Number(state?.count ?? 0) : 0;
  if (count >= PARTNER_FEED_MAX_PER_DAY) return { ok: false, reason: "daily-max" };
  const lastAt = Date.parse(String(state?.lastAt ?? "") ?? "");
  if (Number.isFinite(lastAt) && at.getTime() - lastAt < PARTNER_FEED_MIN_GAP_MS) {
    return { ok: false, reason: "too-soon" };
  }
  return { ok: true };
}

/** 记一笔「今天又递了一次」。 */
export function noteFeed(state, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const today = lifeDay(at);
  const sameDay = String(state?.day ?? "") === today;
  return {
    day: today,
    count: sameDay ? Number(state?.count ?? 0) + 1 : 1,
    lastAt: at.toISOString(),
    recent: [...(Array.isArray(state?.recent) ? state.recent : []), ...(state?.lastEmoji ? [cleanEmoji(state.lastEmoji)] : [])]
      .filter(Boolean)
      .slice(-RECENT_LIMIT),
    lastEmoji: state?.lastEmoji ?? null,
  };
}

/* ── 信号 ─────────────────────────────────────────────────── */

/** 生活日 04:00 切换，跟茶话会其余口径一致。 */
export function lifeDay(date = new Date(), startHour = 4) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  if (value.getHours() < startHour) value.setDate(value.getDate() - 1);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const LINK_RE = /https?:\/\/|www\.|@[一-龥A-Za-z0-9_]{2,}|\/u\/\w+/u;

/** 她发的东西看着像"带来给我看看的"。 */
function looksShared(row) {
  if (row?.attachment) return true;
  if (Array.isArray(row?.bubbles) && row.bubbles.length) return true;
  if (row?.visionNote) return true;
  const text = String(row?.text ?? "");
  if (LINK_RE.test(text)) return true;
  return text.length >= 120;
}

/**
 * 这条消息 ta 确实读过了吗。
 *
 * `readAt` 必须是能解析成时间的值——异常旧数据里的空壳字段一律当没读过。
 * 没读过就递东西，等于替她说了一句她还没说的话；这种宁可漏，不能错。
 */
export function isFeedableTarget(row) {
  if (!row || row.role !== "user") return false;
  if (row.recalled) return false;
  if (row.kind === "action" || row.kind === "poke") return false;
  return Number.isFinite(Date.parse(String(row.readAt ?? "")));
}

/**
 * 现在有没有值得递一下的那句话。
 *
 * 刻意不做的事：不按时间投递。定时递出来的东西三个月后就没人看了。
 * 只有三种时刻算数：
 *   cold-treated —— ta 的话被读过了、她一直没接，ta 补一个「我还在」
 *   interest-hit —— 她说的事正好落在 ta 兴趣里
 *   shared       —— 她带来什么东西给她看
 * 三种都没有就什么都不做。
 *
 * 找候选的方式：从后往前扫一个窗口（FEED_SCAN_LIMIT 条 / FEED_FRESH_HOURS 小时），
 * 但不会跨过伙伴回复去回捡旧消息；新发的用户消息仍能在回复之后成为新候选。
 *
 * @returns {{kind: string, messageId: string, reason: string, message: object, weight: number}|null}
 */
export function detectFeedSignal({ messages, readThroughId = null, readThroughAt = null, interestText = "", now = Date.now() } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  if (!rows.length) return null;
  const at = now instanceof Date ? now.getTime() : Number(now) || Date.now();

  // 最后一条是谁说的，决定了这是哪一种时刻
  const last = rows[rows.length - 1];
  if (!last) return null;

  // ① ta 说了话、她读过了、她没接 —— 冷处理。这是最重的一个信号。
  //    仍然只认 ta 主动开的口：你提问、ta 答了，那叫对话结束，不叫冷处理。
  if (last?.role === "assistant" && last.proactive === true && readThroughId) {
    const readIndex = rows.findIndex((row) => row?.id === readThroughId);
    const lastIndex = rows.indexOf(last);
    const read = readIndex >= 0 && lastIndex >= 0 && lastIndex <= readIndex;
    if (read) {
      const readAt = Date.parse(String(readThroughAt ?? ""));
      const ageMs = Number.isFinite(readAt) ? Math.max(0, at - readAt) : 0;
      // 刚读完就还台阶太黏；安静够久之后再递，才像"我还在"。
      if (ageMs >= FEED_COLD_HOURS * 60 * 60 * 1000) {
        const target = lastUserBefore(rows, lastIndex);
        // 已经递过的不再递：同一条消息反复挂小东西会变廉价。
        if (isFeedableTarget(target) && !target.partnerFeed?.items?.length) {
          return {
            kind: "cold-treated",
            messageId: target.id,
            reason: "ta 上一条被读过了，她一直没接",
            message: target,
            weight: 3,
          };
        }
      }
    }
    // 冷处理没成立不关窗：下面的窗口扫描还要看（ta 主动说完，你也回了她）。
  }

  // ②③ 她说的话 ta 读过了，值得递一下：从后往前扫一个窗口，
  // 不再要求整条线程的最后一条必须是 user。
  const haystack = String(interestText ?? "");
  for (let i = rows.length - 1, scanned = 0; i >= 0 && scanned < FEED_SCAN_LIMIT; i -= 1, scanned += 1) {
    const row = rows[i];
    if (row?.role !== "user") continue;
    if (!isFeedableTarget(row) || row.partnerFeed?.items?.length) continue;
    const readAt = Date.parse(String(row.readAt ?? ""));
    if (!Number.isFinite(readAt)) continue;
    // 刚读完就递会显得急：她可能正在回
    if (at - readAt < FEED_SETTLE_MIN * 60 * 1000) continue;
    // 太旧的不递：挂件落在半个月前的话上不像她，像考古
    if (at - readAt > FEED_FRESH_HOURS * 60 * 60 * 1000) break;
    // 这条后面只要已有伙伴回复，就已经接住了，不再提示「没有要接话」。
    const answers = countAnswersAfter(rows, i);
    if (answers > FEED_MAX_ANSWERS_AFTER) continue;
    if (haystack.length >= 2) {
      const hit = hitInterest(row.text, haystack);
      if (hit) {
        return { kind: "interest-hit", messageId: row.id, reason: `正好撞上她在意的东西：${hit}`, message: row, weight: 2 };
      }
    }
    if (looksShared(row)) {
      return { kind: "shared", messageId: row.id, reason: "她带来了什么东西", message: row, weight: 1 };
    }
  }
  return null;
}

/** 这条之后 ta 接了几句话。 */
function countAnswersAfter(rows, index) {
  let count = 0;
  for (let i = index + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row?.role !== "assistant") continue;
    if (row.recalled) continue;
    count += 1;
    if (count > FEED_MAX_ANSWERS_AFTER) return count;
  }
  return count;
}

function lastUserBefore(rows, beforeIndex) {
  for (let i = Math.min(beforeIndex, rows.length) - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.role === "user" && !row.recalled) return row;
  }
  return null;
}

/** 消息正文里有没有踩到 ta 兴趣里的词。 */
export function hitInterest(text, interestText) {
  const body = String(text ?? "");
  if (!body.trim()) return "";
  const pool = String(interestText ?? "");
  const words = pool
    .split(/[\s,，、。.!！?？;；:：/|·—\-()（）"'"'\[\]]+/u)
    .map((row) => row.trim())
    .filter((row) => row.length >= 2 && row.length <= 8);
  for (const word of words) {
    if (body.includes(word)) return word;
  }
  return "";
}

/* ── 挑品 ─────────────────────────────────────────────────── */

/**
 * 从 ta 手边挑一样递过去。
 *
 * 命中 ta 兴趣里的关键词，就递对应的那个东西；一个都没命中就按 id 稳定轮转兜底池。
 * 最近递过的排除掉，避免递出习惯。
 */
export function pickFeedAsset({ assetText = "", agentId = "", recent = [], rnd = null } = {}) {
  const text = String(assetText ?? "");
  const used = new Set((Array.isArray(recent) ? recent : []).map(cleanEmoji).filter(Boolean));
  const owned = [];
  const seen = new Set();
  for (const asset of FEED_ASSETS) {
    if (seen.has(asset.emoji)) continue;
    if (used.has(asset.emoji)) continue;
    if (asset.keys.some((key) => text.includes(key))) {
      owned.push(asset.emoji);
      seen.add(asset.emoji);
    }
  }
  const pool = owned.length
    ? owned
    : FALLBACK_POOL.filter((emoji) => !used.has(emoji));
  const candidates = pool.length ? pool : FALLBACK_POOL;
  // 配了随机源就用随机（测试用），否则按 id 稳定轮转。
  if (typeof rnd === "function") {
    const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(rnd() * candidates.length)));
    return candidates[index];
  }
  const id = String(agentId ?? "");
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return candidates[hash % candidates.length];
}

/** 从伙伴档案里凑出「她手边有什么」那段文本：兴趣、爱好、话题本。 */
export function feedAssetText({ hobbies = [], palette = null, topics = [] } = {}) {
  const parts = [];
  for (const hobby of Array.isArray(hobbies) ? hobbies : []) {
    parts.push(truthyText(hobby?.name), truthyText(hobby?.detail));
    for (const tag of Array.isArray(hobby?.tags) ? hobby.tags : []) parts.push(truthyText(tag));
  }
  const paletteTags = [
    ...(Array.isArray(palette?.surface?.tags) ? palette.surface.tags : []),
    ...(Array.isArray(palette?.inner?.tags) ? palette.inner.tags : []),
  ];
  parts.push(...paletteTags.map(truthyText));
  for (const topic of Array.isArray(topics) ? topics : []) {
    parts.push(truthyText(topic?.title), truthyText(topic?.focus));
  }
  return parts.filter(Boolean).join(" ");
}
