/**
 * 主动消息的来源交错：外部素材、兴趣种子、关系式由头三类轮着上，别让一类连着占住。
 *
 * 背景（2026-10-29）：配比实验把兴趣从「最多 1 条」改成「目标 2 条」、又让种子每轮优先之后，
 * 主动消息变成了一条线：一颗种子发出去，读过没回的跟进和想念都顺着同一个话题往下讲，
 * 一晚上连着四条都在说同一盆植物。配额只决定「发几条」，管不到「连着几条是同一类」。
 *
 * 口径：
 *   · 只认三类内容来源。到点待办、睡前收尾、醒来回声、读过没回的跟进、节日天气、纯招呼
 *     都是「机动」，该发就得发，不参与交错，也不记账。所以账上是一串干净的内容轮。
 *   · 关系式那一档要让素材先退，才轮得到它；退之前得确认真有由头可抽。抽不出来就原样放回去，
 *     宁可连着两个同源，也不空着一轮不说话（跟挑种子那套「全在冷却里就空手」正好相反）。
 *   · 纯计算：只吃一串已发送的类目和两个「手上还有没有」的布尔，不调模型、不碰发送。
 */

/** 参与交错的三类。顺序也代表「没别的事时谁先上」，这里只用来做标签。 */
export const MIX_GROUPS = Object.freeze(["material", "interest", "relational"]);

export const MIX_SOURCE_LABELS = Object.freeze({
  material: "外部素材",
  interest: "兴趣种子",
  relational: "关系式",
});

/** 账上留几轮。三轮就够判断「连着两个同源」，留八轮是给事后看日志用的。 */
export const MIX_WINDOW = 8;

const short = (value, limit) => String(value ?? "").trim().slice(0, limit);

const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function normalizeMixGroup(value) {
  const group = short(value, 20);
  return MIX_GROUPS.includes(group) ? group : null;
}

/** 读回交错账：认不出来的类目、没有时间的行都丢掉，只留最近的几条。 */
export function readSourceBook(raw, { limit = MIX_WINDOW } = {}) {
  const size = Math.max(1, Number(limit) || MIX_WINDOW);
  return (Array.isArray(raw) ? raw : [])
    .map((row) => ({ group: normalizeMixGroup(row?.group), at: iso(row?.at) }))
    .filter((row) => row.group && row.at)
    .slice(-size);
}

/** 最近几轮的内容类目，新的在前。机动不记账，所以这里天然只是一串内容轮。 */
export function recentMixGroups(raw, { limit = MIX_WINDOW } = {}) {
  return readSourceBook(raw, { limit }).map((row) => row.group).reverse();
}

/** 记一条真发出去的来源。同一类连着记也不合并：交错看的就是「连着几轮」。 */
export function noteSentSource(raw, group, at = new Date(), { limit = MIX_WINDOW } = {}) {
  const kind = normalizeMixGroup(group);
  const when = iso(at);
  const rows = readSourceBook(raw, { limit });
  if (!kind || !when) return rows;
  rows.push({ group: kind, at: when });
  return rows.slice(-Math.max(1, Number(limit) || MIX_WINDOW));
}

/** 连着几轮没轮到关系式。素材和种子交替着发也算连着，因为那一头始终没开口。 */
export function nonRelationalStreak(groups) {
  let count = 0;
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group === "relational") break;
    if (normalizeMixGroup(group)) count += 1;
  }
  return count;
}

/**
 * 这一轮该让谁上。
 *
 * @param {object} input
 * @param {string[]} [input.recent] 最近几轮的内容类目，新的在前
 * @param {boolean} [input.material] 手上有没有视频或新闻
 * @param {boolean} [input.interest] 手上有没有种子或发现，且今天兴趣配额还没满
 * @returns {{prefer: "material"|"interest"|"relational", why: string}|null} 没有记录或该照旧排队时返回 null
 */
export function planSourceMix({ recent = [], material = false, interest = false } = {}) {
  const groups = (Array.isArray(recent) ? recent : []).map(normalizeMixGroup).filter(Boolean);
  if (!groups.length) return null;
  const last = groups[0];
  // 连着两轮都是素材或种子（交替着发也算）：这一轮该轮到关系式，让「没事也想找她」有位置。
  if (nonRelationalStreak(groups) >= 2) return { prefer: "relational", why: "relational-due" };
  if (last === "material") {
    return interest
      ? { prefer: "interest", why: "after-material" }
      : { prefer: "relational", why: "after-material" };
  }
  if (last === "interest") {
    return material
      ? { prefer: "material", why: "after-interest" }
      : { prefer: "relational", why: "after-interest" };
  }
  // 上一条就是关系式：回到原来的排队，不额外指定。
  return null;
}

/**
 * 这条消息算哪一类来源。机动（待办、睡前收尾、跟进、节日天气、纯招呼）返回 null。
 *
 * @param {object} input
 * @param {boolean} [input.routine] 这一轮是不是被机动占着
 * @param {object|null} [input.reason] 实际用的由头，只认 kind
 */
export function sourceGroupOf({ video = null, news = null, seed = null, discovery = null, reason = null, routine = false } = {}) {
  if (routine) return null;
  if (video || news) return "material";
  if (seed || discovery) return "interest";
  const kind = short(reason?.kind, 20);
  if (!kind) return null;
  return kind === "interest" ? "interest" : "relational";
}

/**
 * 从聊天账里读出最近几轮的内容类目，新的在前。
 * 只在交错账还是空的时候兜底用一次：装上这套逻辑的头一轮就能接着历史往下交替，
 * 不用等它自己攒够几轮。
 *
 * @param {Array} messages 聊天账的 rows
 */
export function groupsFromMessages(messages, { limit = MIX_WINDOW } = {}) {
  const rows = (Array.isArray(messages) ? messages : []) //
    .filter((row) => row && row.role === "assistant" && row.proactive)
    .map((row) => {
      const context = row.proactiveContext ?? null;
      return sourceGroupOf({
        video: row.videoId ?? null,
        news: row.newsId ?? null,
        seed: row.seedId ?? null,
        discovery: row.discoveryId ?? null,
        reason: context?.reason ?? null,
        // 跟进、待办、醒来回声、睡前收尾带的是别的上下文；带由头的那几种才按内容轮算。
        routine: Boolean(row.proactiveKind && row.proactiveKind !== "proactive") || Boolean(context && !context.reason),
      });
    })
    .filter(Boolean);
  return rows.slice(-Math.max(1, Number(limit) || MIX_WINDOW)).reverse();
}
