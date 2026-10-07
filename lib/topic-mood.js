/**
 * 茶话会 · 话题温度（2026-10-06）
 *
 * 需求来源：她不想接、或者对某个方向不感兴趣，希望主动那边能自己慢慢降频、慢慢消失。
 *
 * 口径定死在这里，不交给模型发挥：
 *   · 按「方向」记账，不按单条消息记 —— 一条没接说明不了什么，同一个方向反复冷才是证据；
 *   · 反应分五档，冷得有轻重：
 *       warm   她真回话了（有内容）            → 温度清零，按下去的状态也一起解掉
 *       light  她只戳了一下、丢个表情、回一个「嗯」 → 冷 +1
 *       read   她读了但一句没回               → 冷 +2，这是最明确的「我不想接」
 *       unseen 她压根没读                     → 冷 +0.5，可能只是没空
 *       reject 她明说不想聊这个               → 直接按到底，不走慢慢降温
 *   · 冷到 2：这个方向歇久一点（一天变成三天）；
 *   · 冷到 3：这个方向暂时不主动提了（mute），新种子也不往那儿长；
 *   · mute 不是永久：她哪天自己提起这个方向，那件事之前的账一笔勾销，当场解冻。
 *
 * 记账方式：每次都从消息流重算一遍（她后来才回话这件事必须能被算进去），
 * 账本里唯一需要留住的事实是「她上次自己提起这个方向是什么时候」。
 *
 * 这里不碰模型、不碰文件，全是可测的判定。
 */

const HOUR = 60 * 60 * 1000;

/** 一个方向本来该歇多久（跟话题种子那边的常态一致）。 */
export const MOOD_BASE_COOLDOWN_MS = 24 * HOUR;
/** 冷过之后歇多久。 */
export const MOOD_SLOW_COOLDOWN_MS = 72 * HOUR;
/** 攒到这儿，这个方向开始歇久一点。 */
export const COLD_SLOW = 2;
/** 攒到这儿，这个方向不再主动提。 */
export const COLD_MUTE = 3;
/**
 * 被接住到这个次数，这个方向就有资格出题了（2026-10-06）。
 * 够热才给话筒：偶尔接一句就飘上去，出题库会变脏。
 */
export const OFFER_WARM_FLOOR = 2;

/**
 * 她明说不想聊这个。命中就直接把这个方向按到底。
 * 只认最直白的说法，免得把「今天不想做饭」这种误伤成拒聊。
 */
export const TOPIC_REJECT_RE = /(不(?:太)?想(?:聊|说|讲)|别说这个|别聊这个|换个话题|换一个话题|聊点别的|对这个没兴趣|不感兴趣)/u;

/** 五档反应各算多少冷。 */
export const REACTION_COLD = Object.freeze({
  warm: 0,
  light: 1,
  read: 2,
  unseen: 0.5,
  reject: COLD_MUTE,
});

/** 低投入的回应：「嗯」「哦」「好诶」这种，算她说过了但没真接。 */
export function isLowEffortReply(text) {
  const value = String(text ?? "").replace(/[\s，,。！？!?~～…、；;：:「」『』（）()"'"]+/gu, "");
  return value.length > 0 && value.length <= 2;
}

const short = (value, limit) => String(value ?? "").trim().slice(0, limit);

export function emptyMoodBook() {
  return { topics: {} };
}

function normalizeTopic(raw) {
  const cold = Number(raw?.cold);
  return {
    name: short(raw?.name, 60),
    object: short(raw?.object, 100),
    cold: Number.isFinite(cold) && cold > 0 ? cold : 0,
    sent: Math.max(0, Number(raw?.sent ?? 0) || 0),
    warm: Math.max(0, Number(raw?.warm ?? 0) || 0),
    mutedAt: typeof raw?.mutedAt === "string" && raw.mutedAt ? raw.mutedAt : null,
    revivedAt: typeof raw?.revivedAt === "string" && raw.revivedAt ? raw.revivedAt : null,
    lastSentAt: typeof raw?.lastSentAt === "string" && raw.lastSentAt ? raw.lastSentAt : null,
  };
}

/** 读回一本温度账：字段缺的补上，形状不对的丢掉。 */
export function readMoodBook(raw) {
  const topics = raw && typeof raw === "object" && raw.topics && typeof raw.topics === "object" ? raw.topics : {};
  const out = {};
  for (const [id, row] of Object.entries(topics)) {
    const key = short(id, 40);
    if (!key) continue;
    out[key] = normalizeTopic(row);
  }
  return { topics: out };
}

/**
 * 一条主动消息发出去之后，她是什么反应。
 *
 * @param {object[]} rows 会话语境消息（动作类留在里面，才认得出「只戳了一下」）
 * @param {number} index 这条主动消息在 rows 里的下标
 * @param {{readThroughIndex?: number}} [options] 她读到哪条了（readThroughId 对应的下标）
 * @returns {"warm"|"light"|"read"|"unseen"|"reject"}
 */
export function reactionOf(rows, index, { readThroughIndex = -1 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (index < 0 || index >= list.length) return "unseen";
  let touched = false;
  for (let i = index + 1; i < list.length; i += 1) {
    const next = list[i];
    if (!next) continue;
    // 下一条主动又出去了：她那句还没来，这条就算没人接
    if (next.role === "assistant" && next.proactive === true) break;
    if (next.role !== "user") continue;
    if (next.recalled) continue;
    if (next.kind === "action" || next.kind === "poke") {
      touched = true;
      continue;
    }
    const text = String(next.text ?? "").trim();
    if (!text) {
      // 只有图或表情
      touched = true;
      continue;
    }
    if (TOPIC_REJECT_RE.test(text)) return "reject";
    if (isLowEffortReply(text)) {
      touched = true;
      continue;
    }
    return "warm";
  }
  if (touched) return "light";
  return readThroughIndex >= index ? "read" : "unseen";
}

function sameTopic(a, b) {
  if (!a || !b) return false;
  return a.cold === b.cold && a.sent === b.sent && a.warm === b.warm && a.mutedAt === b.mutedAt;
}

/**
 * 从消息流重算整本温度账。
 *
 * 全量重算而不是增量累计：她可能过一阵才回话，那一条的反应要从「没人接」改成「接住了」，
 * 只对新消息记账就永远改不过来。她主动提起某个方向之后，那件事之前的旧账也不再算。
 *
 * @returns {{book: object, changed: boolean}}
 */
export function recomputeMood(book, messages, { readThroughId = null, now = new Date() } = {}) {
  const current = readMoodBook(book);
  const rows = Array.isArray(messages) ? messages : [];
  const readThroughIndex = readThroughId ? rows.findIndex((row) => row?.id === readThroughId) : -1;
  const at = now instanceof Date ? now.toISOString() : String(now);
  const next = { topics: {} };

  rows.forEach((row, index) => {
    if (!row || row.role !== "assistant" || row.proactive !== true) return;
    const motifId = short(row.interestId ?? row.seedMotifId, 40);
    if (!motifId) return;
    const before = next.topics[motifId] ?? {
      name: current.topics[motifId]?.name || short(row.interestName, 60),
      object: current.topics[motifId]?.object ?? "",
      cold: 0,
      sent: 0,
      warm: 0,
      mutedAt: null,
      revivedAt: current.topics[motifId]?.revivedAt ?? null,
      lastSentAt: null,
    };
    // 她后来自己提起过这个方向：那之前的静默一笔勾销，从这儿重新开始算
    const revived = before.revivedAt ? Date.parse(before.revivedAt) : NaN;
    const sentAt = Date.parse(row.at ?? "");
    if (Number.isFinite(revived) && Number.isFinite(sentAt) && sentAt <= revived) {
      next.topics[motifId] = before;
      return;
    }

    const reaction = reactionOf(rows, index, { readThroughIndex });
    const topic = { ...before, sent: before.sent + 1, lastSentAt: typeof row.at === "string" ? row.at : before.lastSentAt };
    if (reaction === "warm") {
      topic.cold = 0;
      topic.warm = before.warm + 1;
      topic.mutedAt = null;
    } else {
      topic.cold = Math.round((before.cold + (REACTION_COLD[reaction] ?? 0)) * 10) / 10;
      if (topic.cold >= COLD_MUTE) {
        // 沿用上一次被按下去的时刻，免得每一轮重算都算成「刚发生的变化」
        topic.mutedAt = before.mutedAt ?? at;
      } else {
        topic.mutedAt = null;
      }
    }
    next.topics[motifId] = topic;
  });

  const beforeKeys = Object.keys(current.topics);
  const afterKeys = Object.keys(next.topics);
  const changed = beforeKeys.length !== afterKeys.length
    || afterKeys.some((id) => !sameTopic(next.topics[id], current.topics[id]));
  return { book: next, changed };
}

/** 她在聊天里自己提起了某个方向：这个词库里出现的都算。 */
function mentionWords(text) {
  const clean = String(text ?? "").replace(/[\s，,。！？!?~～…、；;：:「」『』（）()"'"]/gu, "");
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) {
    const pair = clean.slice(i, i + 2);
    // 掺了虚词的二字词不算关键词，免得被噪声撑起来
    if (/[的了是和与或在有个吧吗呢啊就都还]/.test(pair)) continue;
    out.add(pair);
  }
  return out;
}

/**
 * 她这句话算不算提起了某个方向。同时命中两个不同的关键词才算，避免通用词误伤。
 * @returns {string[]} 命中的方向 id
 */
export function mentionedMotifIds(book, text) {
  const current = readMoodBook(book);
  const words = mentionWords(text);
  if (!words.size) return [];
  const hits = [];
  for (const [id, topic] of Object.entries(current.topics)) {
    const own = new Set([...mentionWords(topic.name), ...mentionWords(topic.object)]);
    let shared = 0;
    for (const word of own) if (words.has(word)) shared += 1;
    if (shared >= 2) hits.push(id);
  }
  return hits;
}

/**
 * 她主动聊起了某个被冷落的方向：记下时间，让重算时把旧账放过去。
 * @returns {{book: object, revived: string[]}}
 */
export function reviveMentioned(book, text, { now = new Date() } = {}) {
  const current = readMoodBook(book);
  const at = now instanceof Date ? now.toISOString() : String(now);
  const revived = [];
  for (const id of mentionedMotifIds(current, text)) {
    const topic = current.topics[id];
    if (!topic || (!topic.mutedAt && topic.cold < COLD_SLOW)) continue;
    current.topics[id] = { ...topic, cold: 0, mutedAt: null, revivedAt: at };
    revived.push(id);
  }
  return { book: current, revived };
}

/** 哪些方向不许再主动提。 */
export function mutedMotifIds(book) {
  const current = readMoodBook(book);
  return Object.entries(current.topics)
    .filter(([, topic]) => Boolean(topic.mutedAt))
    .map(([id]) => id);
}

/** 这个方向这次该歇多久：冷过一次就拉长。 */
export function cooldownForMood(mood, motifId) {
  const topic = readMoodBook(mood).topics[short(motifId, 40)];
  if (!topic) return MOOD_BASE_COOLDOWN_MS;
  return topic.cold >= COLD_SLOW ? MOOD_SLOW_COOLDOWN_MS : MOOD_BASE_COOLDOWN_MS;
}

/** 挑种子要用的：每个方向各自该歇多久。 */
export function cooldownByMotif(mood) {
  const current = readMoodBook(mood);
  const out = new Map();
  for (const [id, topic] of Object.entries(current.topics)) {
    out.set(id, topic.cold >= COLD_SLOW ? MOOD_SLOW_COOLDOWN_MS : MOOD_BASE_COOLDOWN_MS);
  }
  return out;
}

/** 诊断用的一行话，看得见每个方向现在什么温度。 */
export function moodSummary(book) {
  const current = readMoodBook(book);
  return Object.entries(current.topics).map(([id, topic]) => ({
    id,
    name: topic.name,
    cold: topic.cold,
    sent: topic.sent,
    warm: topic.warm,
    muted: Boolean(topic.mutedAt),
  }));
}
