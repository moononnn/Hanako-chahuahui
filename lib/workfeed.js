import path from "node:path";

const MAX_TEXT = 800;
const MAX_EVENTS = 240;
const MAX_PROMPT_EVENTS = 8;

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

function contentText(content) {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  return cleanText(content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text;
    return "";
  }).filter(Boolean).join(" "));
}

/** 从 Hana 的 message_end 事件里取出可用于生活联动的正文。 */
export function textFromSessionMessage(message) {
  if (!message || typeof message !== "object") return "";
  return contentText(message.content ?? message.text ?? message.message);
}

/** 茶话会自己的聊天不应回流到电脑端工作经历。 */
export function isTeaHouseSession(sessionPath, event = {}) {
  const pathText = normalizePath(sessionPath);
  const typeText = normalizePath(event?.customType ?? event?.source ?? event?.origin?.source);
  return pathText.includes("/app-data/chahuahui/")
    || pathText.includes("/apps/chahuahui/")
    || typeText.includes("chahuahui");
}

/** 从标准 agents/<id>/sessions/... 路径取伙伴 id，兼容事件自身携带的 agentId。 */
export function agentIdFromSession(sessionPath, event = {}) {
  const direct = String(event?.agentId ?? event?.session?.agentId ?? "").trim();
  if (direct) return direct;
  const parts = String(sessionPath ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "agents");
  return index >= 0 && parts[index + 1] ? parts[index + 1] : "";
}

function eventTime(event, now = new Date()) {
  const candidate = event?.at ?? event?.timestamp ?? event?.message?.at;
  const date = candidate ? new Date(candidate) : now;
  return Number.isNaN(date.getTime()) ? now : date;
}

/** 生活日 04:00 切换；这里只用本地时间，和茶话会现有口径保持一致。 */
export function workLifeDay(date = new Date(), startHour = 4) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  if (value.getHours() < startHour) value.setDate(value.getDate() - 1);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 把宿主事件洗成茶话会自己的只读生活事件。
 * 这里不调用模型，不判断情绪，也不生成主动消息。
 */
export function normalizeWorkEvent(event, sessionPath, { now = new Date(), startHour = 4 } = {}) {
  if (String(event?.type ?? "") !== "message_end") return null;
  if (isTeaHouseSession(sessionPath, event)) return null;
  const agentId = agentIdFromSession(sessionPath, event);
  const text = textFromSessionMessage(event?.message ?? event);
  if (!agentId || !text) return null;
  const at = eventTime(event, now);
  const role = String(event?.message?.role ?? event?.role ?? "").toLowerCase();
  if (role !== "user" && role !== "assistant") return null;
  const entry = {
    id: cleanText(event?.message?.entryId ?? event?.entryId ?? `${agentId}_${at.toISOString()}_${text.slice(0, 24)}`, 180),
    agentId: cleanText(agentId, 80),
    lifeDay: workLifeDay(at, startHour),
    at: at.toISOString(),
    role,
    text,
  };
  return entry;
}

export function normalizeWorkfeed(value) {
  const source = value && typeof value === "object" ? value : {};
  const events = Array.isArray(source.events) ? source.events : [];
  const seen = new Set();
  const clean = events.map((row) => ({
    id: cleanText(row?.id, 180),
    agentId: cleanText(row?.agentId, 80),
    lifeDay: cleanText(row?.lifeDay, 10),
    at: cleanText(row?.at, 40),
    role: row?.role === "assistant" ? "assistant" : "user",
    text: cleanText(row?.text),
  })).filter((row) => {
    if (!row.id || !row.agentId || !row.lifeDay || !row.at || !row.text || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  return { schemaVersion: 1, events: clean.slice(-MAX_EVENTS) };
}

export function appendWorkEvent(feed, event) {
  const current = normalizeWorkfeed(feed);
  const row = normalizeWorkfeed({ events: [event] }).events[0];
  if (!row || current.events.some((item) => item.id === row.id)) return current;
  current.events.push(row);
  current.events = current.events.slice(-MAX_EVENTS);
  return current;
}

export function recentWorkEvents(feed, agentId, { lifeDay = "", limit = MAX_PROMPT_EVENTS } = {}) {
  const id = String(agentId ?? "").trim();
  return normalizeWorkfeed(feed).events
    .filter((row) => row.agentId === id && (!lifeDay || row.lifeDay === lifeDay))
    .slice(-Math.max(0, Number(limit) || 0));
}

/** 给模型看的工作背景。只给少量最近事件，明确它是背景，不是待办。 */
export function buildWorkfeedText(feed, agentId, { lifeDay = "", limit = MAX_PROMPT_EVENTS, userName = "" } = {}) {
  const rows = recentWorkEvents(feed, agentId, { lifeDay, limit });
  if (!rows.length) return "";
  // 标签用运行时的用户名，不写死：换个人装这个应用，标的不应该是别人的名字。
  const userLabel = String(userName ?? "").trim() || "你";
  const lines = rows.map((row) => `${row.role === "user" ? userLabel : "伙伴"}：${row.text}`);
  return [
    "【电脑那边最近发生的事】",
    ...lines,
    "（这是你们在 Hana 电脑端共同经历的工作背景。手机聊天里不要汇报、不要逐条复述，只有话题自然相关时才把它当作共同生活过的事情接起来。）",
  ].join("\n");
}

export function workfeedFile(dataDir) {
  return path.join(String(dataDir ?? ""), "v2", "workfeed.json");
}

export const WORKFEED_LIMITS = Object.freeze({ MAX_TEXT, MAX_EVENTS, MAX_PROMPT_EVENTS });
