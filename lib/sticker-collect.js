// 聊天里的一张图收进表情包。
//
// 分两种情况，调用方不用判断：
//   装了表情包：把图递过去（它自己会认图打标签），同时在茶话会留一张，
//                这样表情包面板里也能立刻看到。
//   没装 / 没启用 / 递不过去：只留茶话会自己的库，不打扰她。
//
// 递不过去不算失败：她右键这张图，为的是「以后发得出来」，本地这张永远保底。

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { importStickerBytes } from "./sticker-library.js";

export const COLLECT_TARGET = "app:biaoqingbao-app/sticker/add-from-chat";

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
const ALLOWED_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** 这张图该叫什么后缀：先认 MIME，再认文件名，都不认就 png。 */
export function extForAttachment(meta = {}) {
  const mime = String(meta?.mimeType || meta?.contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const ext = String(meta?.name || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALLOWED_EXTS.has(ext) ? ext : "png";
}

/**
 * 收下这张图。
 * @param {object} options
 * @param {string} options.dataDir 茶话会数据目录
 * @param {string} options.agentId 伙伴 id（附件属主校验用）
 * @param {string} options.attachment 附件 id
 * @param {(id: string, agentId: string) => {data: Buffer, mimeType?: string, name?: string} | null} options.readAttachment
 * @param {(tmpPath: string, meta: object) => Promise<{ok: boolean, error?: string}>} options.forward 递给表情包
 * @param {Function} [options.importBytes] 留茶话会自己库，默认 importStickerBytes
 */
export async function collectStickerImage({ dataDir, agentId, attachment, readAttachment, forward, importBytes = importStickerBytes }) {
  const stored = readAttachment(attachment, agentId);
  if (!stored?.data?.length) return { ok: false, reason: "attachment-missing" };

  const ext = extForAttachment(stored);
  const dir = path.join(dataDir, "v2", "sticker-inbox");
  const tmp = path.join(dir, `${randomUUID()}.${ext}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, stored.data);

  let forwarded = { ok: false, error: "not-attempted" };
  try {
    forwarded = await forward(tmp, stored);
  } catch (error) {
    forwarded = { ok: false, error: error?.message || String(error) };
  } finally {
    // 临时文件只是递图的搬运工，读完就删；删不掉也不影响结果。
    try { fs.unlinkSync(tmp); } catch { /* 留着下次清 */ }
  }

  const imported = importBytes(dataDir, {
    contentType: stored.mimeType || `image/${ext}`,
    description: "",
    emotion: [],
    scene: [],
    keywords: [],
  }, stored.data, []);

  return {
    ok: true,
    forwardedOk: forwarded?.ok === true,
    forwarded,
    sticker: imported?.sticker ?? null,
    duplicate: Boolean(imported?.duplicate),
  };
}
