/**
 * 茶话会 · 话题种子库
 *
 * 2026-10-04：以前内容型主动消息只有一个来源——沿着兴趣联网搜一个「新发现」。
 * 两个后果：产能被卡在 18~36 小时一条，伙伴一天要开口七八次，剩下的只能拿戳一戳填；
 * 而且搜出来的必然是资料，写成消息就成了考据，对方只能回一个「哦」。
 *
 * 现在分两条来源：
 *   种子（主力）：母题本身就有的厚度，不联网，一次长几条，能积成库存；
 *   发现（补充）：时效性的东西还是走搜索，作为备用。
 *
 * 频率始终归用户档位管，这层只管「有货」。
 */

/** 一条种子能给对方留什么位置。这是「她接得住吗」那件事的载体。 */
export const SEED_KINDS = Object.freeze(["stand", "exchange", "self", "ask", "curio"]);

/** 类型的中文标签和内部 id 两边都认：提示词里给模型的是中文，回包可能是任一种。 */
const SEED_KIND_LABELS = Object.freeze({
  "站队": "stand",
  "交换": "exchange",
  "自曝": "self",
  "求解": "ask",
  "好奇": "curio",
  stand: "stand",
  exchange: "exchange",
  self: "self",
  ask: "ask",
  curio: "curio",
});

export const MAX_SEEDS = 30;
export const SEED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SEED_BATCH_MIN = 4;
export const SEED_BATCH_MAX = 6;
/** 跟已有的面撞到这个程度就当重复，不再入库 */
export const SEED_SAME_SPOT = 0.5;

const iso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const short = (value, limit) => String(value ?? "").trim().slice(0, limit);

function grams(value) {
  const out = new Set();
  const text = String(value ?? "").replace(/[\s，,。！？!?~～…、；;：:「」『』（）()"'"]/gu, "");
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/** 两个「面」说的是不是同一件事。宁松勿严：撞了就当重复，宁可少一条。 */
export function isSameSeedSpot(a, b) {
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  if (!shared) return false;
  return shared / (left.size + right.size - shared) >= SEED_SAME_SPOT;
}

export function normalizeSeedKind(value) {
  const kind = short(value, 20);
  return SEED_KIND_LABELS[kind] ?? "curio";
}

export function emptySeedBook() {
  return { seeds: [], lastGrowAt: null };
}

/** 读回一本种子账：过期的直接清掉，字段缺的丢掉。 */
export function readSeedBook(raw, now = new Date()) {
  const current = raw && typeof raw === "object" ? raw : {};
  const nowMs = now.getTime();
  const seeds = (Array.isArray(current.seeds) ? current.seeds : [])
    .map((row) => ({
      id: short(row?.id, 40),
      motifId: short(row?.motifId, 40),
      motifName: short(row?.motifName, 60),
      kind: normalizeSeedKind(row?.kind),
      hook: short(row?.hook, 120),
      angle: short(row?.angle, 160),
      createdAt: iso(row?.createdAt),
      expiresAt: iso(row?.expiresAt),
      usedAt: iso(row?.usedAt),
      usedText: short(row?.usedText, 240),
    }))
    .filter((row) => row.id && row.hook && row.expiresAt && Date.parse(row.expiresAt) > nowMs)
    .slice(-MAX_SEEDS);
  return { seeds, lastGrowAt: iso(current.lastGrowAt) };
}

/**
 * 收一批新种子。跟手上已有的面撞了就不收，撞车判定按 hook 算。
 * @param {object} book
 * @param {object[]} rows 解析好的候选
 * @param {{id?: string, name?: string}} motif 这条母题
 */
export function addSeeds(book, rows, { motif, now = new Date() } = {}) {
  const current = readSeedBook(book, now);
  const list = [...current.seeds];
  let added = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const hook = short(row?.hook, 120);
    if (!hook) continue;
    if (list.some((item) => isSameSeedSpot(item.hook, hook))) continue;
    const createdAt = now.toISOString();
    list.push({
      id: `seed_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      motifId: short(motif?.id, 40),
      motifName: short(motif?.name, 60),
      kind: normalizeSeedKind(row?.kind),
      hook,
      angle: short(row?.angle, 160),
      createdAt,
      expiresAt: new Date(now.getTime() + SEED_TTL_MS).toISOString(),
      usedAt: null,
      usedText: "",
    });
    added += 1;
  }
  return { book: { seeds: list.slice(-MAX_SEEDS), lastGrowAt: now.toISOString() }, added };
}

export function usableSeeds(book, { now = new Date() } = {}) {
  return readSeedBook(book, now).seeds.filter((row) => !row.usedAt);
}

/**
 * 挑一条这次要用的。
 *
 * 两条取舍：
 *   ① 刚聊过的母题先让开，别连着两条都是火锅；
 *   ② 同一批里先来先用，老种子别放到过期。
 * 同一个母题只剩它一条时就不让了，宁可连着聊，也不要空手。
 */
export function pickSeed(book, { now = new Date(), recentMotifIds = [], rnd = Math.random } = {}) {
  const usable = usableSeeds(book, { now });
  if (!usable.length) return null;
  const recent = new Set((Array.isArray(recentMotifIds) ? recentMotifIds : []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const fresh = usable.filter((row) => !recent.has(row.motifId));
  const pool = fresh.length ? fresh : usable;
  // 先来先用，但同一批里随机一点，别总从同一条母题开头
  const sorted = [...pool].sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  const head = sorted.slice(0, Math.min(3, sorted.length));
  const index = Math.min(head.length - 1, Math.floor(Math.max(0, Math.min(0.999999, Number(rnd()) || 0)) * head.length));
  return head[index] ?? sorted[0];
}

export function markSeedUsed(book, seedId, text, now = new Date()) {
  const current = readSeedBook(book, now);
  return {
    seeds: current.seeds.map((row) => (row.id === seedId
      ? { ...row, usedAt: now.toISOString(), usedText: short(text, 240) }
      : row)),
    lastGrowAt: current.lastGrowAt,
  };
}

/** 每种位置对应一句开口方向。给的是说明，不是台词。 */
export function seedKindHint(kind) {
  switch (normalizeSeedKind(kind)) {
    case "stand":
      return "这条有分歧，两边都站得住。开口气就把你的立场摆出来，别和稀泥，也别把话说成定论。";
    case "exchange":
      return "这条是换习惯。你先说自己的做法，再顺势问她那边的，像随口一问，不要写成问卷。";
    case "self":
      return "这条你先露自己的偏好或小糗事，她接不接都不尴尬。别编现实里发生过的经历。";
    case "ask":
      return "这条是你真拿不准，想听她的主意。要真像在征求意见，不是客套地抛问题。";
    default:
      return "这条是你还没想明白的事，说出来像是自己一边琢磨一边跟她讲。";
  }
}

/** 手上哪些母题刚聊过。给挑种子时让路用。 */
export function recentSeedMotifs(book, limit = 3) {
  return readSeedBook(book).seeds
    .filter((row) => row.usedAt)
    .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt))
    .slice(0, Math.max(0, limit))
    .map((row) => row.motifId)
    .filter(Boolean);
}

/**
 * 该从哪个母题长种子：挑手上没用过的面最少的那一个。
 * 一个母题被反复掏空、另一个一口没动，长出来的东西自然就偏。
 */
export function pickMotifForSeeds(motifs, book) {
  const list = (Array.isArray(motifs) ? motifs : []).filter((row) => row?.id && row?.name);
  if (!list.length) return null;
  const counts = new Map();
  for (const row of usableSeeds(book)) counts.set(row.motifId, (counts.get(row.motifId) ?? 0) + 1);
  return [...list].sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0))[0] ?? null;
}

export const SEED_SYSTEM = [
  "你在给一个聊天应用的伙伴准备几条可以主动开口的话题种子。",
  "种子是 ta 回头找对方说话时的料，不是现在要发的消息：不用写称呼，不用写成聊天口吻。",
  "每条要满足：",
  "· 落在 ta 自己长期感兴趣的那个方向上，是其中一个具体面，不是把方向名字换个说法；",
  "· 带 ta 自己的立场、偏好或好奇，不是一条谁都能问的中性问题；",
  "· 对方有位置站：能反驳、能说自己的经验、能交换做法、能回答、或者能接着聊；",
  "· 只让对方回一声「哦」「好可爱」的，不算。",
  "类型只能从这五个里挑一个：",
  "站队｜有分歧，两边都能说",
  "交换｜各说各的习惯做法",
  "自曝｜ta 先说自己的偏好或小糗事",
  "求解｜ta 真有事拿不准，想听对方的",
  "好奇｜ta 还没想明白，想去弄清楚",
  "不要编造现实里发生过的人、地点或经历；好奇和偏好可以是真的，事实不许编。",
  "每行三个字段，用竖线隔开：",
  "类型｜要聊的那一面｜ta 自己的角度",
  `写 ${SEED_BATCH_MIN} 到 ${SEED_BATCH_MAX} 条。想不出来就只回一个字：无`,
].join("\n");

export function seedSpec({ motif, existing = [], now = new Date() }) {
  const used = readSeedBook(existing, now).seeds.map((row) => row.hook).filter(Boolean);
  const blocks = [
    `长期方向：${short(motif?.name, 60) || ""}`,
    motif?.object ? `ta 平时盯着的落点：${short(motif.object, 100)}` : "",
    motif?.preference ? `ta 的偏好：${short(motif.preference, 180)}` : "",
    motif?.friction ? `ta 的边界：${short(motif.friction, 160)}` : "",
    used.length
      ? `这个方向上已经有这些面了，不要重复，也不要换几个字重说：\n${used.map((item) => `· ${item}`).join("\n")}`
      : "这个方向还没有铺开的面。",
    "就着这个方向，想几条能真的聊起来的面。",
  ];
  return { kind: "seed", systemPrompt: SEED_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

function cleanLine(line) {
  let out = String(line ?? "").trim();
  out = out.replace(/^```[\s\S]*?\n([\s\S]*?)```$/u, "$1");
  out = out.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/u, "");
  out = out.replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1");
  return out.replace(/\*\*/g, "").trim();
}

/** 一行 → 一条候选。类型认不出来就按好奇放，面缺了才丢掉。 */
export function parseSeedLine(line) {
  const text = cleanLine(line);
  if (!text || /^无[。. ]?$/u.test(text)) return null;
  const parts = text.split(/[|｜]/u).map((part) => part.trim());
  if (parts.length < 2) return null;
  const kind = parts[0];
  const hook = short(parts[1], 120);
  if (!hook) return null;
  const angle = short(parts[2] ?? "", 160);
  return { kind: normalizeSeedKind(kind), hook, angle };
}

export function parseSeedReply(reply) {
  const raw = String(reply ?? "").trim();
  if (!raw || /^无[。. ]?$/u.test(raw)) return [];
  const rows = raw.split(/[\r\n]+/u).map(parseSeedLine).filter(Boolean);
  const out = [];
  for (const row of rows) {
    if (out.some((item) => isSameSeedSpot(item.hook, row.hook))) continue;
    out.push(row);
  }
  return out.slice(0, SEED_BATCH_MAX);
}
