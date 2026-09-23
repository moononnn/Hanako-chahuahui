// 茶话会伙伴状态徽章：伙伴自己的表达，用户只读展示。

export const COMMON_BADGES = Object.freeze([
  { id: "online", label: "在线", description: "正在这里，手边有手机。" },
  { id: "busy", label: "忙碌中", description: "手头正有事情，注意力被占着。" },
  { id: "new", label: "有新消息", description: "刚刚有消息留下，等你来看看。" },
  { id: "recent", label: "刚聊完", description: "刚才还在聊，话头的余温还没散。" },
  { id: "away", label: "忙自己的", description: "暂时没拿手机，正在做自己的事。" },
  { id: "idle", label: "摸鱼中", description: "暂时没在处理正事，松下来待一会儿。" },
  { id: "resting", label: "休息中", description: "正在放松，不急着接住所有话。" },
  { id: "sleeping", label: "睡着了", description: "正在睡觉，回复会慢一些。" },
  { id: "waking", label: "刚醒", description: "刚从睡意里回来，脑壳还在开机。" },
  { id: "awaiting", label: "等回音", description: "话已经放下，正在等这边的回应。" },
  { id: "quiet", label: "安静陪着", description: "不急着说很多，只在旁边待着。" },
]);

const COMMON_BY_ID = new Map(COMMON_BADGES.map((badge) => [badge.id, badge]));
const COMMON_BY_LABEL = new Map(COMMON_BADGES.map((badge) => [badge.label, badge]));
const MAX_TITLE = 24;
const MAX_DESCRIPTION = 100;

export const BADGE_GUIDE = [
  "状态徽章是你自己的表达：常见状态能说清楚时，选一个常见状态；说不清楚时，可以用自定义徽章。",
  "对方只能看见你现在佩戴的结果，不能替你选择、修改或批准；这不是奖励、解锁或用户给你的标签。",
  "只有状态真的有变化、或者当前徽章已经不能准确表达你时才更换，不要每轮都换。",
  "需要换徽章时，在正文末尾另起一行写隐藏标记：[徽章:在线]、[徽章:忙碌中]、[徽章:等回音] 等；自定义写：[徽章:自定义|徽章名称|一句简短说明]。",
  "隐藏标记不会显示给对方，也不要解释它；没有必要换徽章时不要输出。",
].join("\n");

function text(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim().slice(0, max);
}

export function commonBadge(id) {
  return COMMON_BY_ID.get(String(id ?? "").trim()) ?? null;
}

export function normalizeBadge(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = raw.type === "custom" ? "custom" : "common";
  if (type === "custom") {
    const title = text(raw.title, MAX_TITLE);
    if (!title) return null;
    return {
      type,
      id: "custom",
      title,
      description: text(raw.description, MAX_DESCRIPTION),
      updatedAt: text(raw.updatedAt, 40) || null,
    };
  }
  const source = commonBadge(raw.id) ?? COMMON_BY_LABEL.get(text(raw.label, MAX_TITLE));
  if (!source) return null;
  return { type: "common", id: source.id, label: source.label, description: source.description, updatedAt: text(raw.updatedAt, 40) || null };
}

const RECENT_ACTIVITY_MS = 2 * 60 * 60 * 1000;

export function fallbackBadge({
  sleeping = false,
  waking = false,
  awaiting = false,
  busy = false,
  unread = 0,
  lastMessage = null,
  now = Date.now(),
  holdingPhone = true,
} = {}) {
  const lastAt = Date.parse(String(lastMessage?.at ?? ""));
  const recent = Boolean(
    lastMessage?.role && ["user", "assistant"].includes(lastMessage.role)
      && lastMessage?.kind !== "action"
      && lastMessage?.kind !== "poke"
      && Number.isFinite(lastAt)
      && Number(now) - lastAt >= 0
      && Number(now) - lastAt <= RECENT_ACTIVITY_MS,
  );
  const id = sleeping ? "sleeping"
    : waking ? "waking"
      : busy ? "busy"
        : awaiting ? "awaiting"
          : Number(unread) > 0 ? "new"
            : recent ? "recent"
              : holdingPhone ? "idle" : "away";
  return normalizeBadge({ type: "common", id });
}

/**
 * 伙伴回复里的隐藏控制标记：
 *   [徽章:在线]
 *   [徽章:自定义|夜行猫|晚上才有精神]
 * 标记只给后端看，正文展示前会被剥掉。
 */
export function parseBadgeMarker(raw) {
  const source = String(raw ?? "");
  const pattern = /\[徽章\s*:\s*([^\]]+)\]/u;
  const match = source.match(pattern);
  if (!match) return { badge: null, before: source, after: "", found: false };
  const parts = match[1].split("|").map((part) => part.trim());
  let badge = null;
  if (parts[0] === "自定义" || parts[0].toLowerCase() === "custom") {
    badge = normalizeBadge({ type: "custom", title: parts[1], description: parts.slice(2).join("|") });
  } else {
    const sourceBadge = COMMON_BY_ID.get(parts[0]) ?? COMMON_BY_LABEL.get(parts[0]);
    badge = sourceBadge ? normalizeBadge({ type: "common", id: sourceBadge.id }) : null;
  }
  return {
    badge,
    before: source.slice(0, match.index).trim(),
    after: source.slice(match.index + match[0].length).trim(),
    found: true,
  };
}

export function badgeText(badge) {
  const normalized = normalizeBadge(badge);
  if (!normalized) return "";
  return normalized.type === "custom" ? normalized.title : normalized.label;
}
