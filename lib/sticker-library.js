import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonDurable, writeJsonAtomic } from "./persistence.js";

const VERSION = 1;
const FILE_NAME = "sticker-library.json";
const IMAGE_DIR = "stickers";

function cleanText(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function normalizeGroupIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 30);
}

function emptyLibrary() {
  return { version: VERSION, groups: [], stickers: [] };
}

function filePath(dataDir) { return path.join(dataDir, FILE_NAME); }
function imagePath(dataDir, file) {
  const root = path.resolve(dataDir, IMAGE_DIR);
  const target = path.resolve(root, String(file || ""));
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

export function readStickerLibrary(dataDir) {
  const raw = readJsonDurable(filePath(dataDir), emptyLibrary());
  const groups = Array.isArray(raw?.groups)
    ? raw.groups.filter((group) => group && group.id && group.name).map((group) => ({ id: cleanText(group.id, 80), name: cleanText(group.name, 40) }))
    : [];
  const stickers = Array.isArray(raw?.stickers)
    ? raw.stickers.filter((row) => row && row.id && row.file).map((row) => ({
      id: cleanText(row.id, 120), sourceId: cleanText(row.sourceId, 120), file: cleanText(row.file, 180),
      sha256: cleanText(row.sha256, 64), description: cleanText(row.description, 80),
      emotion: Array.isArray(row.emotion) ? row.emotion.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 5) : [],
      scene: Array.isArray(row.scene) ? row.scene.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 5) : [],
      keywords: Array.isArray(row.keywords) ? row.keywords.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 8) : [],
      groupIds: normalizeGroupIds(row.groupIds),
    }))
    : [];
  return { version: VERSION, groups, stickers };
}

/** 图库总量闸：导图是一次几百张的批量活，不设上限能把数据目录塞满。 */
const STICKER_TOTAL_BYTES = 500 * 1024 * 1024;

function saveStickerLibrary(dataDir, library) {
  writeJsonAtomic(filePath(dataDir), library);
}

export function listStickerLibrary(dataDir) {
  const library = readStickerLibrary(dataDir);
  return {
    groups: library.groups,
    stickers: library.stickers.map(({ file, sha256, ...row }) => row),
  };
}

export function createStickerGroup(dataDir, name) {
  const label = cleanText(name, 40);
  if (!label) throw new Error("分组名不能为空");
  const library = readStickerLibrary(dataDir);
  const duplicate = library.groups.find((group) => group.name === label);
  if (duplicate) return duplicate;
  const group = { id: `grp_${crypto.randomUUID()}`, name: label };
  library.groups.push(group);
  saveStickerLibrary(dataDir, library);
  return group;
}

export function importStickerBytes(dataDir, source, bytes, groupIds = []) {
  const buffer = Buffer.from(bytes);
  if (!buffer.length) throw new Error("图片为空");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const library = readStickerLibrary(dataDir);
  const existing = library.stickers.find((row) => row.sha256 === sha256);
  if (existing) {
    const next = new Set([...existing.groupIds, ...normalizeGroupIds(groupIds)]);
    existing.groupIds = [...next];
    saveStickerLibrary(dataDir, library);
    return { sticker: existing, duplicate: true };
  }
  const id = `local_${sha256.slice(0, 20)}`;
  const extension = String(source?.contentType || "image/jpeg").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
  const file = `${id}.${extension}`;
  const target = imagePath(dataDir, file);
  if (!target) throw new Error("图片路径不合法");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 单张管住了，总量也得管。超了只拒新的，不偷偷删她已经导进去的。
  const stickerDir = path.dirname(target);
  let usedBytes = 0;
  try {
    for (const name of fs.readdirSync(stickerDir)) {
      try { usedBytes += fs.statSync(path.join(stickerDir, name)).size; } catch { /* 读不到的跳过 */ }
    }
  } catch { /* 目录还没建 */ }
  if (usedBytes + buffer.length > STICKER_TOTAL_BYTES) {
    throw new Error(`图库太大了（已用约 ${Math.round(usedBytes / 1048576)} MB），先删掉一些不用的表情包再导`);
  }
  fs.writeFileSync(target, buffer);
  const sticker = {
    id, sourceId: cleanText(source?.id, 120), file, sha256,
    description: cleanText(source?.description, 80),
    emotion: Array.isArray(source?.emotion) ? source.emotion.slice(0, 5).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    scene: Array.isArray(source?.scene) ? source.scene.slice(0, 5).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    keywords: Array.isArray(source?.keywords) ? source.keywords.slice(0, 8).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    groupIds: normalizeGroupIds(groupIds),
  };
  library.stickers.push(sticker);
  saveStickerLibrary(dataDir, library);
  return { sticker, duplicate: false };
}

export function readOwnSticker(dataDir, stickerId) {
  const id = cleanText(stickerId, 120);
  const library = readStickerLibrary(dataDir);
  const row = library.stickers.find((sticker) => sticker.id === id);
  if (!row) return null;
  const file = imagePath(dataDir, row.file);
  if (!file || !fs.existsSync(file)) return null;
  return { row, bytes: fs.readFileSync(file), contentType: `image/${path.extname(file).slice(1) || "jpeg"}` };
}

/**
 * 从图库移除一张。
 * 图片文件故意留着：她以前发出去的那条消息还得看得见。
 * @returns {boolean} 有没有真的移除
 */
export function removeSticker(dataDir, stickerId) {
  const id = cleanText(stickerId, 120);
  if (!id) return false;
  const library = readStickerLibrary(dataDir);
  const stickers = library.stickers.filter((row) => row.id !== id);
  if (stickers.length === library.stickers.length) return false;
  saveStickerLibrary(dataDir, { ...library, stickers });
  return true;
}

/**
 * 删一个分组。组里的图不跟着删，只是退回「全部」。
 * @returns {boolean} 有没有真的删掉
 */
export function removeStickerGroup(dataDir, groupId) {
  const id = cleanText(groupId, 80);
  if (!id) return false;
  const library = readStickerLibrary(dataDir);
  const groups = library.groups.filter((group) => group.id !== id);
  if (groups.length === library.groups.length) return false;
  const stickers = library.stickers.map((row) => (
    row.groupIds.includes(id) ? { ...row, groupIds: row.groupIds.filter((g) => g !== id) } : row
  ));
  saveStickerLibrary(dataDir, { ...library, groups, stickers });
  return true;
}

export function __testSaveStickerLibrary(dataDir, library) { saveStickerLibrary(dataDir, library); }
