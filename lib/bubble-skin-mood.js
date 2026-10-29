/**
 * 伙伴自己那一侧的气泡装扮（2026-10-28 晚）
 *
 * 一句话：「我」的气泡是我自己在设置页挑的；ta 的气泡由 ta 自己决定，
 * 按当天的心情日盘挑一套，不随机换、也不一天换好几次。
 *
 * 为什么是「跟着日盘、一天最多看一次」而不是每条消息都算：
 *   气泡是 ta 站在那儿的样子，不是表情包。一天里换三次壳，
 *   看着像有人在后台拨开关，不像一个人的状态。日盘本来就一天结一次
 *   （lib/mood-daily.js），那就一天一个样子，跟心情同步翻页。
 *
 * 三条护栏，都写在代码里而不是提示词里：
 *   1. **不换是默认。** 先看现在这套跟今天的心情搭不搭；搭得上就不动。
 *      换皮是例外，不是义务。
 *   2. **一天最多翻一次。** 账上记着今天已经看过了，就不再动。
 *      跨生活日（凌晨 4 点切）才重新有机会。
 *   3. **当天心情没有对应皮肤就不动。** 心情落不到任何一套上时
 *      （比如「委屈」「生气」还没人认领），保住上一套，不硬塞。
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
 * 0.55 的意思是：换了日子，有一半机会换一套，一半机会接着用昨天那套。
 * 这个数是压着的——心情日盘本身就是「常常没什么变化」的东西，
 * 气泡跟着它走，也该是常常不变。调高会让它变成每天定时换皮肤。
 */
export const SWITCH_CHANCE = 0.55;

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

  // 今天已经看过一次了：原样交回去，不重新摇。
  if (current.dayKey === today) {
    return { skin: current.skin, changed: false, book: current };
  }

  const candidates = skinsForMood(day.moodId);
  if (!candidates.length) {
    // 这个心情还没人认领：保住上一套，但把「今天看过了」记上，
    // 免得同一份心情在一天里被反复重算。
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  // 现在这套本来就搭今天的心情：不换。
  if (current.skin && candidates.includes(current.skin)) {
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  // 摇一次：同一天同一伙伴结果固定，重启也不变。
  const roll = daySeed(now, `bubble-skin:${String(agentId ?? "?")}`);
  const stay = roll >= SWITCH_CHANCE && Boolean(bubbleSkinById(current.skin));
  if (stay) {
    const next = { ...current, moodId: day.moodId, dayKey: today };
    return { skin: current.skin, changed: false, book: next };
  }

  const index = Math.min(candidates.length - 1, Math.floor(daySeed(now, `bubble-skin-pick:${String(agentId ?? "?")}`) * candidates.length));
  const skin = candidates[index];
  const next = {
    skin,
    moodId: day.moodId,
    dayKey: today,
    pickedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  return { skin, changed: skin !== current.skin, book: next };
}
