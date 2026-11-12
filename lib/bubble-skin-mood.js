/**
 * 伙伴自己那一侧的气泡装扮（2026-10-28 晚）
 *
 * 一句话：「我」的气泡是我自己在设置页挑的；ta 的气泡由 ta 自己决定，
 * 按当天的心情日盘挑一套；这是系统装扮规则，不额外调用聊天模型。
 *
 * 先保留适合当前心情的样式，穿满三天后才允许轮换；满一周仍没换，
 * 就在同一心情的其他候选里挑一套，避免「只要还适合就永久保留」。
 * 一天最多实际换一次。轮换取日期+伙伴的固定种子，不因刷新而重新抽签。
 * 没有心情账或没有对应候选时保留现状，不为了变化硬塞不合适的样式。
 *
 * 挑哪一套用 daySeed 算：同一天同一个伙伴永远是同一套，重启、重载、
 * 换窗口都是同一个答案，不会刷两下就变一个样。
 *
 * 纯逻辑：不碰模型、不碰文件。
 */

import { dayKey } from "./days.js";
import { daySeed } from "./sleep.js";
import { normalizeBubbleSkin, skinsForMood, bubbleSkinById } from "./bubble-skins.js";
import { readMoodDay } from "./mood-daily.js";

/**
 * 今天翻不翻的倾向。
 *
 * 3～7天的温和轮换窗口，以及原款不再合心情时，使用固定日种子决定
 * 换还是保留；满一周且有其他合适候选时不再被保留概率阻挡。
 * 不按每次读取抽随机数，因此刷新页面不能加速换装。
 */
export const SWITCH_CHANCE = 0.55;
export const SKIN_MIN_WEAR_MS = 3 * 24 * 60 * 60_000;
export const SKIN_MAX_WEAR_MS = 7 * 24 * 60 * 60_000;

/** 账本收成标准形状。坏数据一律当「还没挑过」，不拿坏值去挂界面。 */
export function readSkinBook(raw) {
  if (!raw || typeof raw !== "object") return { skin: null, moodId: null, dayKey: null, pickedAt: null };
  // 认不出来的一律当「没挑过」，不能归一成 plain：
  // 那样手改的坏值会变成一次明确的「我选了原味」，跟「还没挑」混在一起。
  const valid = typeof raw.skin === "string" && Boolean(bubbleSkinById(raw.skin));
  return {
    skin: valid ? normalizeBubbleSkin(raw.skin) : null,
    moodId: typeof raw.moodId === "string" && raw.moodId ? raw.moodId : null,
    dayKey: typeof raw.dayKey === "string" && raw.dayKey ? raw.dayKey : null,
    pickedAt: typeof raw.pickedAt === "string" && raw.pickedAt ? raw.pickedAt : null,
  };
}

/**
 * 今天该长什么样。
 *
 * @param {object|null} book 账上记着的那一份（readSkinBook 过的）
 * @param {{mood?: object, now?: Date, agentId?: string}} options
 * @returns {{skin: string|null, changed: boolean, book: object}}
 *   skin 为 null 表示还没有可用的选择（没有心情、或心情没有对应皮肤、且账上也是空的），
 *   调用方这时不挂属性，界面就退回原来的取色。
 */
export function pickPartnerSkin(book = null, { mood = null, now = new Date(), agentId = "" } = {}) {
  const current = readSkinBook(book);
  const day = readMoodDay(mood);
  const today = dayKey(now);

  // 没有心情账（还没结算过、或读不出来）：什么都不定，保住现状。
  // 不拿「平静」去顶——没算出来的心情不是平静，是不知道。
  if (!day.settledAt || !day.moodId) {
    return { skin: current.skin, changed: false, book: current };
  }

  // 旧账缺少/写坏时间时从此刻起计，不把未知穿戴时长冒充一周。
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  let pickedMs = Date.parse(current.pickedAt);
  if (current.skin && (!Number.isFinite(pickedMs) || pickedMs > nowMs)) {
    pickedMs = nowMs;
    current.pickedAt = new Date(nowMs).toISOString();
  }
  const candidates = skinsForMood(day.moodId);
  const fits = current.skin && candidates.includes(current.skin);
  const alternatives = candidates.filter(id => id !== current.skin);
  const wearMs = Number.isFinite(pickedMs) ? nowMs - pickedMs : 0;
  const rotationDue = fits && alternatives.length > 0 && wearMs >= SKIN_MIN_WEAR_MS;

  // 允许旧规则今天已检查但长期没换的账重新评估；真正换过的 pickedAt
  // 是今天，不会满足 rotationDue，因此刷新或重载都不能一天连换几次。
  if (current.skin && current.dayKey === today && !rotationDue) {
    return { skin: current.skin, changed: false, book: current };
  }
  if (!candidates.length) {
    // 这个心情还没人认领：保住上一套，但把「今天看过了」记上，
    // 免得同一份心情在一天里被反复重算。
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  // 还没穿满三天且仍合心情：继续用，不按日历强迫每天换。
  if (fits && !rotationDue) {
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  // 摇一次：同一天同一伙伴结果固定，重启也不变。
  const roll = daySeed(now, `bubble-skin:${String(agentId ?? "?")}`);
  const forceRotation = rotationDue && wearMs >= SKIN_MAX_WEAR_MS;
  const stay = !forceRotation && roll >= SWITCH_CHANCE && Boolean(bubbleSkinById(current.skin));
  if (stay) {
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  // 轮换时排除当前这套，否则「换过了」仍可能画成原样。
  const pool = rotationDue ? alternatives : candidates;
  const index = Math.min(pool.length - 1, Math.floor(daySeed(now, `bubble-skin-pick:${String(agentId ?? "?")}`) * pool.length));
  const skin = pool[index];
  const next = {
    skin,
    moodId: day.moodId,
    dayKey: today,
    pickedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  return { skin, changed: skin !== current.skin, book: next };
}
