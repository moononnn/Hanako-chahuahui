import { applyMemoryFeedback, normalizeLongterm, selectLongterm } from "./longterm.js";
import { packMaterials, READ_KINDS } from "./video-materials.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VIDEO_TTL_MS = 7 * DAY_MS;
const OFFER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING = 2;
const MAX_CONTEXT_CHARS = 2400;
const MAX_RECALL_CHARS = 3000;
const CJK_GENERIC = new Set([
  "这个", "那个", "这些", "那些", "我们", "你们", "喜欢", "记得", "事情", "之前", "今天", "昨天", "时候",
  "什么", "一下", "一起", "视频", "标题", "作者", "字幕", "内容", "分享", "看到", "知道", "链接", "上次",
  "口味", "固定", "句型",
]);
const list = (value) => Array.isArray(value) ? value : [];
const text = (value, max = 200) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
  : "";

function dateIso(value) {
  if (!(typeof value === "string" || value instanceof Date)) return "";
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}
function clock(now) {
  const iso = dateIso(now);
  return iso ? new Date(iso) : null;
}
function positiveInt(value) {
  if (!(typeof value === "number" || (typeof value === "string" && value.trim()))) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
function videoMeta(raw) {
  const bvid = text(raw?.bvid, 12);
  const cid = positiveInt(raw?.cid);
  const page = positiveInt(raw?.page);
  const duration = positiveInt(raw?.duration);
  if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid) || !cid || !page || !duration) return null;

  let url;
  try { url = new URL(String(raw?.link ?? "")); } catch { return null; }
  if (url.protocol !== "https:" || !["www.bilibili.com", "bilibili.com"].includes(url.hostname.toLowerCase())
    || url.username || url.password || url.port || url.hash) return null;
  const path = url.pathname.replace(/\/$/u, "");
  if (path !== `/video/${bvid}`) return null;
  const params = [...url.searchParams.entries()];
  if (params.some(([key]) => key !== "p") || params.filter(([key]) => key === "p").length > 1) return null;
  if (params.length && positiveInt(url.searchParams.get("p")) !== page) return null;
  const link = `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ""}`;
  // B站 客户端的「分享」生成的就是这一段：标题截一下 + 官方短链。
  // b23.tv/<BV号> 实测 302 直达视频页，不调接口，也不碰写接口。
  const title = text(raw?.title, 180);
  const shareLink = page > 1 ? link : `https://b23.tv/${bvid}`;
  const shortTitle = (title || bvid).length > 34 ? `${(title || bvid).slice(0, 34)}…` : (title || bvid);
  const shareText = `【${shortTitle}-哔哩哔哩】 ${shareLink}`;
  return {
    bvid, cid, page, duration, link, shareLink, shareText,
    title,
    author: text(raw?.author, 80),
  };
}

/** 文本里是不是已经带了这条视频的分享链接（短链或长链都算）。 */
export function hasVideoShareLink(rawText, rawVideo) {
  const body = String(rawText ?? "");
  if (!body) return false;
  const shareLink = String(rawVideo?.shareLink ?? "");
  const link = String(rawVideo?.link ?? "");
  return Boolean((shareLink && body.includes(shareLink)) || (link && body.includes(link)));
}
function videoId(video) { return `${video.bvid}:${video.page}`; }
function cognitionId(video) { return `video_${video.bvid}_${video.page}`; }
function makeCognition(video, context, { at, sourceIds = [], prior = null, shared = false } = {}) {
  const stamp = dateIso(at);
  const title = (video.title || video.bvid).slice(0, 64);
  const marker = "【字幕资料】";
  const packed = String(context ?? "");
  const markerAt = packed.indexOf(marker);
  const excerpt = markerAt < 0 ? "" : packed.slice(markerAt + marker.length).trim().split(/\n\n/u, 1)[0].replace(/\s+/gu, " ").slice(0, 100);
  const baseText = shared
    ? `我分享过《${video.title || video.bvid}》${video.author ? `（UP：${video.author}）` : ""}，当时仅读到字幕资料，未看画面。`
    : `读过《${video.title || video.bvid}》${video.author ? `（UP：${video.author}）` : ""}的字幕资料${excerpt ? `，留意到「${excerpt}」` : "，未看画面"}；尚未确认分享。`;
  const keys = [video.title, video.author].filter(Boolean).map((key) => key.slice(0, 64));
  const raw = {
    ...(prior && typeof prior === "object" ? prior : {}),
    id: cognitionId(video), kind: "event", title,
    text: (shared && !list(prior?.sourceIds).includes(sourceIds[0]) ? "" : text(prior?.text, 360)) || baseText.slice(0, 360),
    keys: [...new Set([...(Array.isArray(prior?.keys) ? prior.keys : []), ...keys])].slice(0, 12),
    sourceIds, at: dateIso(prior?.at) || stamp,
    updatedAt: dateIso(prior?.updatedAt) || stamp,
    ...(shared ? {} : { feedbackSourceIds: [], resultMessageIds: [], note: "", certainty: "held" }),
  };
  const normalized = normalizeLongterm([raw])[0];
  if (normalized) {
    normalized.id = cognitionId(video);
    normalized.sourceIds = [...new Set(sourceIds)];
    if (shared && !prior?.text) normalized.text = baseText.slice(0, 360);
    return normalized;
  }
  return normalizeLongterm([{
    id: cognitionId(video), kind: "event", title, text: baseText.slice(0, 360), keys,
    sourceIds, at: stamp, updatedAt: stamp,
  }])[0] ?? null;
}
function candidateRow(raw, now, { checkExpiry = true } = {}) {
  const video = videoMeta(raw?.video);
  const createdAt = dateIso(raw?.createdAt);
  const at = clock(now);
  if (!video || !createdAt || !at) return null;
  const expiry = new Date(Date.parse(createdAt) + VIDEO_TTL_MS).toISOString();
  if (checkExpiry && Date.parse(expiry) <= at.getTime()) return null;
  const context = typeof raw?.context === "string" ? raw.context : "";
  if (!context || context.length > MAX_CONTEXT_CHARS) return null;
  return {
    id: videoId(video), video,
    interestId: text(raw?.interestId, 160),
    interestName: text(raw?.interestName, 60),
    focus: text(raw?.focus, 120),
    context, createdAt, expiresAt: expiry,
    offeredAt: dateIso(raw?.offeredAt) || null,
    cognition: makeCognition(video, context, { at: raw?.cognition?.at || createdAt, prior: raw?.cognition }),
  };
}
function renewalRows(raw) {
  const out = [];
  const seen = new Set();
  for (const row of list(raw)) {
    const sourceId = text(row?.sourceId, 160);
    const resultMessageId = text(row?.resultMessageId, 160);
    const quote = text(row?.quote, 2000);
    const at = dateIso(row?.at);
    if (row?.kind !== "user" || !sourceId || !resultMessageId || !quote || !at || seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({ kind: "user", sourceId, resultMessageId, quote, at });
  }
  return out;
}
function shareRow(raw, now) {
  const candidate = candidateRow(raw, now, { checkExpiry: false });
  const at = clock(now);
  const messageId = text(raw?.messageId, 160);
  const sharedText = typeof raw?.sharedText === "string" ? raw.sharedText : "";
  if (!candidate || !at || !messageId || !hasVideoShareLink(sharedText, candidate.video)) return null;
  const sharedAt = dateIso(raw?.sharedAt) || candidate.createdAt;
  const renewals = renewalRows(raw?.renewals);
  const defaultExpiry = Date.parse(sharedAt) + VIDEO_TTL_MS;
  const renewalExpiry = renewals.reduce((latest, row) => Math.max(latest, Date.parse(row.at) + VIDEO_TTL_MS), defaultExpiry);
  const suppliedExpiry = dateIso(raw?.expiresAt);
  const expiresAt = new Date(Math.max(suppliedExpiry ? Date.parse(suppliedExpiry) : defaultExpiry, renewalExpiry)).toISOString();
  if (Date.parse(expiresAt) <= at.getTime()) return null;
  const cognition = makeCognition(candidate.video, candidate.context, {
    at: raw?.cognition?.at || sharedAt,
    sourceIds: [messageId], prior: raw?.cognition, shared: true,
  });
  if (!cognition) return null;
  return {
    ...candidate,
    sharedAt, messageId, sharedText,
    sourceIds: [messageId], expiresAt, renewals, cognition,
  };
}

export function normalizeVideoBook(raw, now = new Date()) {
  const at = clock(now);
  if (!at) return { pending: [], shares: [] };
  const source = raw && typeof raw === "object" ? raw : {};
  const pending = [];
  const seenPending = new Set();
  for (const rawRow of list(source.pending)) {
    const row = candidateRow(rawRow, at);
    if (!row || seenPending.has(row.id)) continue;
    seenPending.add(row.id);
    pending.push(row);
  }
  const sharesById = new Map();
  for (const rawRow of list(source.shares)) {
    const row = shareRow(rawRow, at);
    if (!row) continue;
    const old = sharesById.get(row.id);
    if (!old || Date.parse(row.expiresAt) > Date.parse(old.expiresAt)) sharesById.set(row.id, row);
  }
  const shares = [...sharesById.values()];
  const sharedIds = new Set(shares.map((row) => row.id));
  return { pending: pending.filter((row) => !sharedIds.has(row.id)).slice(-MAX_PENDING), shares };
}

export function makeVideoCandidate(materials, { interest = null, plan = null } = {}, now = new Date()) {
  const at = clock(now);
  if (!at || materials?.readKind !== READ_KINDS.SUBTITLE || !Array.isArray(materials?.subtitle)
    || !materials.subtitle.some((row) => typeof row?.content === "string" && row.content.trim())) return null;
  const video = videoMeta(materials.video);
  if (!video) return null;
  const context = packMaterials(materials, { maxChars: MAX_CONTEXT_CHARS });
  if (typeof context !== "string" || !context.includes("【你已经读过字幕")) return null;
  const createdAt = at.toISOString();
  return {
    id: videoId(video), video,
    interestId: text(interest?.id, 160),
    interestName: text(interest?.name, 60),
    focus: text(plan?.focus, 120),
    context, createdAt,
    expiresAt: new Date(at.getTime() + VIDEO_TTL_MS).toISOString(),
    offeredAt: null,
    cognition: makeCognition(video, context, { at: createdAt }),
  };
}

export function addVideoCandidate(book, candidate, now = new Date()) {
  const current = normalizeVideoBook(book, now);
  const row = candidateRow(candidate, now);
  if (!row || current.shares.some((share) => share.id === row.id) || current.pending.some((item) => item.id === row.id)) return current;
  return { ...current, pending: [...current.pending, row].slice(-MAX_PENDING) };
}

export function nextVideoCandidate(book, now = new Date()) {
  const at = clock(now);
  if (!at) return null;
  return normalizeVideoBook(book, at).pending.find((row) => !row.offeredAt
    || at.getTime() - Date.parse(row.offeredAt) >= OFFER_COOLDOWN_MS) ?? null;
}

export function offerVideoCandidate(book, id, now = new Date()) {
  const current = normalizeVideoBook(book, now);
  const key = text(id, 160);
  const at = clock(now);
  if (!key || !at) return current;
  return {
    ...current,
    pending: current.pending.map((row) => row.id === key ? { ...row, offeredAt: at.toISOString() } : row),
  };
}

export function recordVideoShare(book, candidate, message, now = new Date()) {
  const at = clock(now);
  const current = normalizeVideoBook(book, now);
  const row = candidateRow(candidate, now, { checkExpiry: false });
  const messageId = text(message?.id, 160);
  const sharedText = typeof message?.text === "string" ? message.text : "";
  if (!at || !row || message?.role !== "assistant" || message?.recalled === true || !messageId
    || !hasVideoShareLink(sharedText, row.video)) return current;
  const pending = current.pending.filter((item) => item.id !== row.id);
  if (current.shares.some((item) => item.id === row.id)) return { ...current, pending };
  const sharedAt = at.toISOString();
  const cognition = makeCognition(row.video, row.context, {
    at: sharedAt, prior: row.cognition, sourceIds: [messageId], shared: true,
  });
  const share = {
    ...row, sharedAt, messageId, sharedText, sourceIds: [messageId],
    expiresAt: new Date(at.getTime() + VIDEO_TTL_MS).toISOString(),
    renewals: [], cognition,
  };
  return { ...current, pending, shares: [...current.shares, share] };
}

function isActualShare(row) {
  return Boolean(row?.video?.link && row?.messageId && typeof row.sharedText === "string"
    && hasVideoShareLink(row.sharedText, row.video) && row?.cognition?.id?.startsWith("video_"));
}
export function videoCognitions(shares) {
  const entries = [];
  for (const row of list(shares)) {
    if (!isActualShare(row)) continue;
    entries.push({ ...row.cognition, sourceIds: [text(row.messageId, 160)] });
  }
  return normalizeLongterm(entries).filter((row) => row.id.startsWith("video_"));
}

function renderRecall(rows, maxChars = MAX_RECALL_CHARS) {
  const header = "【视频分享记忆】";
  const selected = [];
  for (const row of list(rows).slice(0, 2)) {
    if (!isActualShare(row) || typeof row.context !== "string" || !row.context) continue;
    const title = row.video.title || row.video.bvid;
    const author = row.video.author ? `｜UP主：${row.video.author}` : "";
    const cognition = row.cognition;
    const certainty = cognition.certainty === "uncertain" ? "存疑" : "当前保留";
    const note = cognition.note ? `\n伙伴自己的备注：${cognition.note}` : "";
    const item = `《${title}》${author}\n原链接：${row.video.link}\n当时实际发出：${row.sharedText}\n当前伙伴认知（${certainty}）：${cognition.text}${note}\n材料边界：当时只读到字幕资料，没有看视频画面。以下为当时保存的完整材料上下文：\n${row.context}`;
    const next = [...selected, item];
    const rendered = [header, ...next].join("\n\n");
    if (rendered.length <= maxChars) selected.push(item);
  }
  return selected.length ? [header, ...selected].join("\n\n") : "";
}
export function videoRecallText(shares) {
  return renderRecall(shares, MAX_RECALL_CHARS);
}

export function selectVideoShares(book, query, { recentMessageIds = [], now = new Date(), maxChars = MAX_RECALL_CHARS } = {}) {
  const at = clock(now);
  const budget = Number.isFinite(Number(maxChars)) ? Math.floor(Math.min(MAX_RECALL_CHARS, Number(maxChars))) : MAX_RECALL_CHARS;
  if (!at || budget < 1) return [];
  const current = normalizeVideoBook(book, at);
  const recent = new Set(list(recentMessageIds).map((id) => text(id, 160)).filter(Boolean));
  const recentRows = current.shares.filter((row) => recent.has(row.messageId))
    .sort((a, b) => Date.parse(b.sharedAt) - Date.parse(a.sharedAt));
  const selectedCognitions = selectLongterm(videoCognitions(current.shares), query, { maxEntries: 2, maxChars: MAX_RECALL_CHARS });
  const byCognitionId = new Map(current.shares.map((row) => [row.cognition.id, row]));
  const candidates = [...recentRows, ...selectedCognitions.map((row) => byCognitionId.get(row.id)).filter(Boolean)];
  const seen = new Set();
  const selected = [];
  for (const row of candidates) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (selected.length >= 2) break;
    const next = [...selected, row];
    const rendered = renderRecall(next, budget);
    if (rendered && rendered.length > renderRecall(selected, budget).length) selected.push(row);
  }
  return selected;
}

function concreteOverlap(quote, row) {
  const marker = "【字幕资料】";
  const context = String(row?.context ?? "");
  const start = context.indexOf(marker);
  const body = start < 0 ? "" : context.slice(start + marker.length).trim().split(/\n\n/u, 1)[0];
  const source = `${row?.video?.title ?? ""} ${row?.video?.author ?? ""} ${body}`.toLowerCase();
  const q = String(quote ?? "").toLowerCase();
  const quoteRuns = q.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of quoteRuns) {
    for (let size = 2; size <= Math.min(8, run.length); size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const term = run.slice(i, i + size);
        if ([...CJK_GENERIC].some((generic) => term.includes(generic))) continue;
        if (source.includes(term)) return true;
      }
    }
  }
  const ascii = q.match(/[a-z][a-z0-9_-]{1,}/giu) ?? [];
  return ascii.some((term) => !["the", "and", "that", "this", "with", "from", "your", "video"].includes(term.toLowerCase())
    && new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^a-z0-9])`, "iu").test(source));
}
function messageIndex(messages) {
  const byId = new Map();
  const duplicates = new Set();
  for (const row of list(messages)) {
    const id = text(row?.id, 160);
    if (!id || row?.recalled === true || ["action", "poke", "tavern-opening"].includes(row?.kind)) continue;
    if (byId.has(id)) duplicates.add(id);
    else byId.set(id, row);
  }
  for (const id of duplicates) byId.delete(id);
  return byId;
}

export function applyVideoFeedback(book, updates, { messages = [], resultMessageId = "", now = new Date() } = {}) {
  const at = clock(now);
  const current = normalizeVideoBook(book, now);
  const messageId = text(resultMessageId, 160);
  if (!at || !messageId) return current;
  const messagesById = messageIndex(messages);
  const result = messagesById.get(messageId);
  if (result?.role !== "assistant" || typeof result.text !== "string") return current;

  const cognitions = videoCognitions(current.shares);
  const cogById = new Map(cognitions.map((row) => [row.id, row]));
  const valid = list(updates).filter((update) => {
    const cognition = cogById.get(update?.id);
    const source = messagesById.get(text(update?.sourceId, 160));
    return cognition && source?.role === "user" && typeof source.text === "string"
      && typeof update?.quote === "string" && update.quote.length > 0 && source.text.includes(update.quote);
  });
  const applied = applyMemoryFeedback(cognitions, valid, { resultMessageId: messageId, now: at });
  const afterById = new Map(applied.map((row) => [row.id, row]));
  const accepted = new Set();
  for (const update of valid) {
    const before = cogById.get(update.id);
    const after = afterById.get(update.id);
    const sourceId = text(update.sourceId, 160);
    if (before && after && !before.feedbackSourceIds.includes(sourceId) && after.feedbackSourceIds.includes(sourceId)) {
      accepted.add(`${update.id}\u0000${sourceId}`);
    }
  }
  const shares = current.shares.map((share) => {
    const cognition = afterById.get(share.cognition.id) ?? share.cognition;
    const renewals = [...share.renewals];
    let expiresAt = share.expiresAt;
    for (const update of valid) {
      const sourceId = text(update.sourceId, 160);
      const key = `${update.id}\u0000${sourceId}`;
      if (update.id !== cognition.id || !accepted.has(key) || renewals.some((item) => item.sourceId === sourceId)) continue;
      if (!concreteOverlap(update.quote, share)) continue;
      renewals.push({ kind: "user", sourceId, resultMessageId: messageId, quote: update.quote, at: at.toISOString() });
      expiresAt = new Date(Math.max(Date.parse(expiresAt), at.getTime() + VIDEO_TTL_MS)).toISOString();
    }
    return { ...share, cognition, renewals, expiresAt };
  });
  return normalizeVideoBook({ pending: current.pending, shares }, at);
}

export function removeVideoSource(book, id, now = new Date()) {
  const current = normalizeVideoBook(book, now);
  const key = text(id, 160);
  if (!key) return current;
  const depends = (row) => row.id === key || row.messageId === key || list(row.sourceIds).includes(key)
    || list(row.cognition?.sourceIds).includes(key) || list(row.cognition?.feedbackSourceIds).includes(key)
    || list(row.cognition?.resultMessageIds).includes(key)
    || list(row.renewals).some((item) => item.sourceId === key || item.resultMessageId === key);
  return {
    pending: current.pending.filter((row) => !depends(row)),
    shares: current.shares.filter((row) => !depends(row)),
  };
}

export function videoShareLimit(value) {
  if (!(typeof value === "number" || typeof value === "string") || String(value).trim() === "") return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : 0;
}
function quotaCount(runtime, day) {
  if (runtime?.day !== day) return 0;
  const count = runtime?.count;
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
export function videoQuotaAvailable(runtime, max, lifeDay) {
  const limit = videoShareLimit(max);
  const day = text(lifeDay, 20);
  return Boolean(day && limit > 0 && quotaCount(runtime, day) < limit);
}
export function noteVideoSent(runtime, lifeDay) {
  const day = text(lifeDay, 20);
  return { day, count: quotaCount(runtime, day) + 1 };
}

export function matchVideoStop(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return false;
  const normalized = raw.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  const lead = "(?:(?:全局|以后|今后|往后|之后|从今以后|以后都|今后都)*)";
  const stop = "(?:不要再|别再|不再|不要|别|停止|关闭|关掉|取消)";
  const action = "(?:给我|向我)?(?:分享|发|推送|推荐)(?:任何|所有)?视频";
  const direct = new RegExp(`${lead}${stop}${action}(?:了|吧|啦)?`, "u");
  const reverse = new RegExp(`${lead}(?:停止|关闭|关掉|取消)(?:所有|全部)?视频(?:分享|推送|推荐)?(?:功能)?`, "u");
  const futureReceive = /(?:以后|今后|往后|从今以后)(?:都)?(?:不想|不要|不再)(?:再)?(?:收到|看|要)(?:任何)?视频/u;
  return direct.test(normalized) || reverse.test(normalized) || futureReceive.test(normalized);
}
