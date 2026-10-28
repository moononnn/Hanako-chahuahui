/**
 * 图片附件的身份。
 *
 * 她可能同一张图发两遍、隔几天又发一遍。存两遍纯属白占地方，
 * 但"这张图某天某刻又被发了一次"是时间线上的一笔，不能丢。
 * 所以文件按内容认，只有一份；消息各留各的，时间各自记。
 *
 * 认的是字节，不是画面：同一份文件必然命中，同一张图截图两次不会。
 * 要做到"看着像就认一个"，得算感知哈希并容忍容差，代价跟收益不成比例。
 */

import crypto from "node:crypto";

/** 内容指纹。同一份文件算出来的永远是同一串。 */
export function contentHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * 这条元数据能不能代表"同一个伙伴发过的同一份文件"。
 *
 * 必须连同属主一起比：不同伙伴各存各的，删一位伙伴时才能干净带走他的图，
 * 不会牵连别人还在用的那一份。老图没有 hash 字段，自然不命中，也不会被误认。
 */
export function isReusableAttachment(meta, { hash, agentId, mimeType }) {
  if (!meta || typeof meta !== "object") return false;
  if (!hash || !meta.hash) return false;
  if (meta.hash !== hash) return false;
  if (String(meta.agentId ?? "") !== String(agentId ?? "")) return false;
  return String(meta.mimeType ?? "") === String(mimeType ?? "");
}

/** 被再次发送时更新这两个数：最后一次见到它是什么时候、总共发过几次。 */
export function touchAttachmentMeta(meta, now = new Date().toISOString()) {
  return {
    ...meta,
    lastSeenAt: now,
    occurrences: Math.max(1, Number(meta?.occurrences) || 1) + 1,
  };
}
