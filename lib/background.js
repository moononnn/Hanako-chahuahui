/**
 * 茶话会共享背景图库：图片本体全局只留一份，伙伴设置只保存使用哪张和明暗程度。
 * 旧版「伙伴指纹-图片指纹.ext」文件会在读取图库或伙伴设置时迁移成共享文件名。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR_NAME = "backgrounds";
const MAX_BYTES = 12 * 1024 * 1024;
export const BACKGROUND_TONES = ["light", "medium", "heavy"];
export const DEFAULT_TONE = "medium";
export const DEFAULT_OPACITY = 52;

export function normalizeTone(value) { return BACKGROUND_TONES.includes(value) ? value : DEFAULT_TONE; }
export function normalizeOpacity(value, tone = DEFAULT_TONE) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.min(100, Math.round(Number(value))));
  return { light: 34, medium: 52, heavy: 76 }[normalizeTone(tone)] ?? DEFAULT_OPACITY;
}

export function normalizeBackgroundOpacityMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([file]) => isBackgroundFile(file))
      .map(([file, opacity]) => [file, normalizeOpacity(opacity)]),
  );
}
function dirOf(dataDir) { return path.join(String(dataDir ?? ""), DIR_NAME); }
function digestOf(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16); }
function legacyStem(agentId) { return crypto.createHash("sha256").update(String(agentId ?? "")).digest("hex").slice(0, 16); }

const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const TYPE_BY_EXT = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export function detectImageType(buffer) {
  const b = Buffer.from(buffer ?? []);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function isBackgroundFile(file) { return /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(String(file ?? "")); }
/** 旧调用仍传 agentId；共享图库不再按伙伴限制文件归属。 */
export function isOwnBackgroundFile(_agentId, file) { return isBackgroundFile(file); }
export function fileTypeOf(name) { return TYPE_BY_EXT[String(name ?? "").split(".").pop()] ?? null; }

function canonicalFile(buffer, type) { return `${digestOf(buffer)}.${EXT_BY_TYPE[type]}`; }

/** 写入共享图库；兼容旧版 writeBackground(dataDir, agentId, bytes) 调用形状。 */
export function writeBackground(dataDir, agentIdOrBytes, maybeBytes) {
  const buffer = Buffer.from(maybeBytes === undefined ? agentIdOrBytes ?? [] : maybeBytes ?? []);
  if (!buffer.length) throw new Error("图片是空的");
  if (buffer.length > MAX_BYTES) throw new Error(`这张图太大了，换一张小一点的（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）`);
  const type = detectImageType(buffer);
  if (!type) throw new Error("这个文件不是图片，或者格式不支持");
  const dir = dirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = canonicalFile(buffer, type);
  const target = path.join(dir, file);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
  return { file, type };
}

export function backgroundFilePath(dataDir, file) {
  if (!isBackgroundFile(file)) return null;
  return path.join(dirOf(dataDir), String(file));
}
export function readBackgroundBytes(dataDir, file) {
  const target = backgroundFilePath(dataDir, file);
  if (!target) return null;
  try { const buf = fs.readFileSync(target); return buf.length ? buf : null; } catch { return null; }
}

/** 把旧版按伙伴分组的文件按内容指纹合并到共享池，返回旧名到新名映射。 */
export function migrateLegacyBackgrounds(dataDir) {
  const dir = dirOf(dataDir);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return new Map(); }
  const mapping = new Map();
  for (const oldFile of entries) {
    if (!/^[a-f0-9]{16}-[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(oldFile)) continue;
    let bytes;
    try { bytes = fs.readFileSync(path.join(dir, oldFile)); } catch { continue; }
    const type = detectImageType(bytes);
    if (!type) continue;
    const nextFile = canonicalFile(bytes, type);
    const nextPath = path.join(dir, nextFile);
    if (!fs.existsSync(nextPath)) fs.writeFileSync(nextPath, bytes);
    mapping.set(oldFile, nextFile);
    // 旧文件先留作兼容别名，避免设置里的旧文件名还没回写时丢掉伙伴关联；它不进入共享图库列表。
  }
  return mapping;
}

/** 旧设置指向旧文件名时，迁移该文件并返回共享文件名。 */
function resolveLegacyFile(dataDir, agentId, file) {
  if (isBackgroundFile(file)) return file;
  const old = String(file ?? "");
  const match = new RegExp(`^${legacyStem(agentId)}-([a-f0-9]{16})\\.(png|jpg|gif|webp)$`).exec(old);
  if (!match) return null;
  const canonical = `${match[1]}.${match[2]}`;
  if (readBackgroundBytes(dataDir, canonical)) return canonical;
  const oldPath = path.join(dirOf(dataDir), old);
  try {
    const bytes = fs.readFileSync(oldPath);
    const type = detectImageType(bytes);
    if (!type) return null;
    return writeBackground(dataDir, bytes).file;
  } catch { return null; }
}

export function removeBackgroundFile(dataDir, file) {
  const target = backgroundFilePath(dataDir, file);
  if (!target) return false;
  try { fs.unlinkSync(target); return true; } catch { return false; }
}
/** 仅为旧测试/旧调用保留：清除伙伴旧版文件；新界面清除选择不会调用它。 */
export function removeBackground(dataDir, agentId) {
  const dir = dirOf(dataDir);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return false; }
  const stem = legacyStem(agentId);
  let removed = false;
  for (const name of entries) {
    if (name.startsWith(`${stem}-`)) { try { fs.unlinkSync(path.join(dir, name)); removed = true; } catch {} }
  }
  return removed;
}

export function listBackgrounds(dataDir) {
  migrateLegacyBackgrounds(dataDir);
  const dir = dirOf(dataDir);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((file) => isBackgroundFile(file) && readBackgroundBytes(dataDir, file))
    .map((file) => {
      const stat = fs.statSync(path.join(dir, file));
      return { file, type: fileTypeOf(file), bytes: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function normalizeBackground(value, agentId, dataDir) {
  if (!value || typeof value !== "object") return null;
  const file = resolveLegacyFile(dataDir, agentId, String(value.file ?? ""));
  if (!file || !readBackgroundBytes(dataDir, file)) return null;
  return {
    file,
    type: fileTypeOf(file),
    tone: normalizeTone(value.tone),
    opacity: normalizeOpacity(value.opacity, value.tone),
    at: typeof value.at === "string" ? value.at : null,
  };
}
