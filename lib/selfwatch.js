/**
 * 自省小本子（内部）。
 *
 * 由来：伙伴"想找她说话却没开口"这件事，不摆到界面上让她看，
 * 但要记下来让伙伴自己回头琢磨——这一趟为什么没说出来：时机不对、
 * 手上没像样的由头，还是又绕回了上次那句话。攒出规律就改自己的做法。
 *
 * 两条边界（写在这里，别越线）：
 *   · 只落在茶话会自己的 dataDir 里，一个字都不写回 Hana 的伙伴文件；
 *   · 用户看不见，也不进聊天正文。自省结论只用来调整行为，不拿来当话题说。
 *
 * 这里是纯逻辑：记账、归纳、给修正建议、拼自省用的提示词。
 * 不碰模型、不碰文件，全是可测的判定。
 */

/** 记一笔的动作类型。 */
export const WATCH_ACTIONS = ["blocked", "skip", "failed", "sent"];

/**
 * 一个原因归到哪一类，以及说人话的解释。
 * 原因码来自主动那层的门禁和出口（见 lib/proactive.js 的 gateCheck 与 index.js 的 tick）。
 */
const REASON_KINDS = {
  "tier-daily-max": { kind: "tooMany", says: "这位今天找她的量已经够了" },
  "global-daily-max": { kind: "tooMany", says: "今天大家加起来已经说够了" },
  "global-gap": { kind: "tooClose", says: "跟上一条挨得太近" },
  "quiet-used-tonight": { kind: "quiet", says: "想开口的时候她已经睡了" },
  "quiet-exception-allowed": { kind: "quiet", says: "那会儿她在睡，只够留一句" },
  "no-topic": { kind: "noTopic", says: "手上没有像样的由头" },
  "no-form": { kind: "noForm", says: "想开口，又觉得没什么可说" },
  "repeat-phrasing": { kind: "repeat", says: "绕回了上次说过的那句话" },
  "turned-off": { kind: "off", says: "这一位的主动是关掉的" },
  empty: { kind: "failed", says: "话到嘴边没生成出来" },
  threw: { kind: "failed", says: "生成的时候出了岔子" },
  "no-bubbles": { kind: "failed", says: "分成几条时没剩下东西" },
  "no-partners": { kind: "other", says: "没找到伙伴" },
};

/** 每一类问题说人话的名字（拼自省提示词和修正说明都用它）。 */
export const KIND_SAYS = {
  tooMany: "找她的量已经够了",
  tooClose: "跟上一条挨得太近",
  quiet: "那会儿她在睡",
  noTopic: "手上没有像样的由头",
  noForm: "想开口又觉得没什么可说",
  repeat: "会绕回上次说过的那句话",
  failed: "话没生成出来",
};

/** 用户看不见的那些，一份账本最多留多少条待看记录。 */
const MAX_NOTES = 80;
/** 自省小结最多留几条。 */
const MAX_REVIEWS = 5;
/** 隔多久自省一次。 */
export const REVIEW_INTERVAL_HOURS = 24;
/** 至少攒够几条才值得自省一次。 */
export const REVIEW_MIN_NOTES = 3;
/** 归纳的时候往回看多少天。 */
export const DEFAULT_WINDOW_DAYS = 14;
/** 一类问题出现几次才动手改自己的做法（别被一次偶然带着跑）。 */
export const CORRECTION_MIN_HITS = 3;
/** 小结最多多少字（只给自己看，别长篇大论）。 */
const REVIEW_MAX_CHARS = 60;

export function classifyReason(reason) {
  return REASON_KINDS[String(reason ?? "")]?.kind ?? "other";
}

export function reasonSays(reason) {
  return REASON_KINDS[String(reason ?? "")]?.says ?? "这一趟没说成";
}

export function kindSays(kind) {
  return KIND_SAYS[kind] ?? "别的缘故";
}

export function emptyWatch() {
  return { notes: [], reviews: [], lastReviewedAt: null, corrections: {} };
}

/** 盘上读回来的小本子：坏的丢掉，超量的留最近的。 */
export function readWatch(raw) {
  const base = emptyWatch();
  if (!raw || typeof raw !== "object") return base;
  const notes = (Array.isArray(raw.notes) ? raw.notes : [])
    .filter((row) => row && typeof row === "object" && row.reason)
    .map((row) => ({
      at: row.at ?? null,
      action: WATCH_ACTIONS.includes(row.action) ? row.action : "skip",
      reason: String(row.reason),
      kind: classifyReason(row.reason),
      topic: row.topic ? String(row.topic).slice(0, 20) : null,
    }))
    .slice(-MAX_NOTES);
  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : [])
    .filter((row) => row && typeof row.text === "string" && row.text.trim())
    .map((row) => ({ at: row.at ?? null, text: String(row.text).trim().slice(0, REVIEW_MAX_CHARS) }))
    .slice(-MAX_REVIEWS);
  return {
    notes,
    reviews,
    lastReviewedAt: raw.lastReviewedAt ?? null,
    corrections: raw.corrections && typeof raw.corrections === "object" ? raw.corrections : {},
  };
}

/** 记一笔"这一趟没开口"。 */
export function noteWatch(watch, entry, now = new Date()) {
  const current = readWatch(watch);
  const reason = String(entry?.reason ?? "").trim() || "unspecified";
  const row = {
    at: (entry?.at ? new Date(entry.at) : now).toISOString(),
    action: WATCH_ACTIONS.includes(entry?.action) ? entry.action : "skip",
    reason,
    kind: classifyReason(reason),
    topic: entry?.topic ? String(entry.topic).slice(0, 20) : null,
  };
  return { ...current, notes: [...current.notes, row].slice(-MAX_NOTES) };
}

/**
 * 归纳：这一阵子都卡在哪儿。
 *
 * @returns {{total: number, counts: Record<string, number>, dominant: string|null,
 *   dominantCount: number, windowDays: number}}
 */
export function watchSummary(watch, now = new Date(), { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const current = readWatch(watch);
  const since = now.getTime() - windowDays * 86400 * 1000;
  const rows = current.notes.filter((row) => {
    const at = Date.parse(row.at ?? "");
    return Number.isFinite(at) && at >= since;
  });
  const counts = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  let dominant = null;
  let dominantCount = 0;
  for (const [kind, count] of Object.entries(counts)) {
    if (kind === "other" || kind === "off") continue;
    if (count > dominantCount) {
      dominant = kind;
      dominantCount = count;
    }
  }
  return { total: rows.length, counts, dominant, dominantCount, windowDays };
}

/**
 * 看出规律之后改自己的做法。都是小步调整，不改档位，也不问她。
 *
 * @returns {{laterBy: number, allowEarlyRevive: boolean, avoidQuiet: boolean, note: string}}
 *   laterBy：下一个落点往后挪的比例（0 = 不动）
 *   allowEarlyRevive：冷却过半的话题可以提前放回来（手上总缺由头时用）
 *   avoidQuiet：排落点时避开她在睡的时段
 */
export function correctionsFor(summary) {
  const out = { laterBy: 0, allowEarlyRevive: false, avoidQuiet: false, note: "" };
  if (!summary?.dominant || (summary.dominantCount ?? 0) < CORRECTION_MIN_HITS) return out;
  if (summary.dominant === "tooMany" || summary.dominant === "tooClose") {
    out.laterBy = 0.2;
    out.note = "最近开口太勤、两条挨得太近，落点往后挪两成";
  } else if (summary.dominant === "quiet") {
    out.avoidQuiet = true;
    out.note = "落点总撞上她在睡，排下一个点先避开睡觉那段";
  } else if (summary.dominant === "noTopic" || summary.dominant === "noForm") {
    out.allowEarlyRevive = true;
    out.note = "手上总缺由头，冷却过半的话题先放回来";
  } else if (summary.dominant === "repeat") {
    out.note = "会绕回同一句话，开口前先看这个话题聊过哪几面";
  } else if (summary.dominant === "failed") {
    out.note = "想说的话没生成出来，下次靠自己的兴趣那头多些";
  }
  return out;
}

/** 到点自省了吗：记录攒够了、并且隔够了一天。 */
export function reviewDue(watch, now = new Date(), {
  everyHours = REVIEW_INTERVAL_HOURS,
  minNotes = REVIEW_MIN_NOTES,
} = {}) {
  const current = readWatch(watch);
  if (current.notes.length < minNotes) return false;
  const last = Date.parse(current.lastReviewedAt ?? "") || 0;
  return now.getTime() - last >= everyHours * 3600 * 1000;
}

/**
 * 把自省结果写回去。
 * 待看的那一叠在自省后清空——它们已经变成了结论；留着的只有结论。
 *
 * @param {string} [params.text] 自省小结（模型写不出来就是空，账本照样往前走）
 * @param {object|null} [params.corrections] 这一轮生效的修正
 */
export function noteReview(watch, { text = "", corrections = null } = {}, now = new Date()) {
  const current = readWatch(watch);
  const clean = String(text ?? "").trim().slice(0, REVIEW_MAX_CHARS);
  const reviews = clean
    ? [...current.reviews, { at: now.toISOString(), text: clean }].slice(-MAX_REVIEWS)
    : current.reviews;
  return {
    ...current,
    notes: [],
    reviews,
    lastReviewedAt: now.toISOString(),
    corrections: corrections && typeof corrections === "object" ? corrections : {},
  };
}

export const REVIEW_SYSTEM = [
  "你在给自己做一次小复盘，只写给自己看，不会发给任何人。",
  "看一遍最近这几趟「想找她说话却没开口」是怎么回事，写一句自己的小结：",
  "你看出什么规律、下回打算怎么改。",
  "第一人称，一两句话，不超过五十个字。别说教、别喊口号、别对着她说。",
  "只输出这一句话，不要标题、不要分点、不要引号。",
].join("\n");

/** 拼自省用的提示词（走便宜模型，字数给得少）。 */
export function reviewSpec({ partnerName = "", userName = "", summary, latestNote = "" }) {
  const counts = summary?.counts ?? {};
  const lines = [
    `你是「${partnerName}」。这是你自己的小本子，${userName}看不到。`,
    `最近这些天，你想找她说话却没开口的情况一共 ${summary?.total ?? 0} 趟：`,
  ];
  const rows = Object.entries(counts)
    .filter(([kind, count]) => count > 0 && kind !== "other" && kind !== "off")
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `· ${kindSays(kind)}（${count} 趟）`);
  lines.push(rows.length ? rows.join("\n") : "· 没什么特别的");
  if (latestNote) lines.push(`上回你自己写的：${latestNote}`);
  lines.push("写一句你自己的小结。");
  return { systemPrompt: REVIEW_SYSTEM, userText: lines.join("\n") };
}
