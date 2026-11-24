/**
 * 「从本对话的表情找灵感」（2026-11-24）：伙伴自己挑动作参考。
 *
 * 这一条是替掉「逐张授权」那条路的：她不用一张张地点，伙伴也能自己从这段对话里
 * 她发过的表情里挑一张当动作参考。
 *
 * 三条边界（都不能破）：
 * ① 只看本对话：这位伙伴的这段聊天里、她发出去的表情。别的话题、别的伙伴的都不算。
 * ② 只收本地读得到的：走现有公开读取路径能拿到字节的才算。外部 App 的私有图库不碰，
 *    别的对话里的图也不碰，普通照片更不能拿来冒充表情。
 * ③ 只给伙伴看少量文字（编号 + 一句话说明）：候选原图不进任何额外模型。
 *
 * 挑不挑、挑哪张，ta 自己说；也可以说这一轮不做。
 */

import { stickerIdFromBubble } from "./stickers.js";

/** 一次最多给几个候选：再多就不叫「挑」，叫「发牌」。 */
export const STICKER_CHOICE_MAX = 6;

/** 这条消息是不是她发出去的表情（消息里真有的那种形态）。 */
function isUserStickerMessage(row) {
  if (!row || typeof row !== "object") return false;
  if (row.role !== "user") return false;
  if (row.kind !== "sticker") return false;
  if (row.recalled) return false;
  return Array.isArray(row.bubbles) && row.bubbles.length > 0;
}

/** 这条消息里带的表情 id（气泡哨兵里解出来的）。 */
export function stickerIdsOfMessage(row) {
  if (!isUserStickerMessage(row)) return [];
  const ids = [];
  for (const piece of Array.isArray(row.bubbles) ? row.bubbles : []) {
    const id = stickerIdFromBubble(String(piece ?? ""));
    if (id) ids.push(id);
  }
  return ids;
}

/** 这段对话里她发过的所有表情 id（撤回的也算——撤回的要想办法作废，不能装作没有）。 */
export function conversationStickerIds(messages = []) {
  const ids = [];
  const seen = new Set();
  for (const row of Array.isArray(messages) ? messages : []) {
    if (!row || row.role !== "user" || row.kind !== "sticker") continue;
    for (const id of stickerIdsOfMessage(row)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 这段对话里能当动作参考的表情。
 *
 * 只认：她发的、没被撤回的、本地读得到的、这一阵没用过的。
 * 每条只带少量文字：编号、标题、动作提示——原图不进这里。
 */
export function conversationStickerCandidates({
  messages = [], isReadable = () => false, describe = () => ({}), usedIds = [], limit = STICKER_CHOICE_MAX,
} = {}) {
  const used = new Set((Array.isArray(usedIds) ? usedIds : []).map((row) => String(row ?? "").trim()).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(messages) ? messages : []) {
    if (!isUserStickerMessage(row)) continue;
    for (const id of stickerIdsOfMessage(row)) {
      if (seen.has(id) || used.has(id)) continue;
      let readable = false;
      try { readable = Boolean(isReadable(id)); } catch { readable = false; }
      if (!readable) continue;
      seen.add(id);
      let info = {};
      try { info = describe(id) ?? {}; } catch { info = {}; }
      out.push({
        id,
        title: String(info.title ?? "").trim().slice(0, 80),
        action: String(info.action ?? "").trim().slice(0, 120),
        messageId: String(row.id ?? ""),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 给伙伴的挑图说明：只有编号和一句话，不给图。
 *
 * 挑哪张、还是这一轮不做，ta 自己回。这里不塞图片，也不塞别的话。
 */
export function stickerChoicePrompt(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return "";
  const lines = [
    "你在这段对话里收到过下面这几张表情。",
    "每条只给编号和一句话说明，图不在这儿。",
    "挑一张最合适的，当你自己做表情时的动作参考：只回那个编号。",
    "这一轮你不想做表情，就回「不做」。",
  ];
  for (const row of rows) {
    const title = row.title || "（没写说明）";
    const extra = row.action;
    lines.push(`· ${row.id}｜${title}${extra ? `｜${extra}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * 解析 ta 的选择：回一个编号就算挑中，回「不做」或认不出来就算这一轮不做。
 *
 * 认不出的编号一律当没挑——不能自己替 ta 挑第一张。
 */
export function parseStickerChoice(text, candidateIds = []) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  return Array.isArray(candidateIds) && candidateIds.includes(raw) ? raw : "";
}
