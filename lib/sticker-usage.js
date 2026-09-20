import fs from "node:fs";
import path from "node:path";

export const STICKER_USAGE_SCHEMA_VERSION = 1;
export const STICKER_USAGE_FILE = path.join("v2", "sticker-usage.json");
export const MAX_STICKER_USAGE_EVENTS = 500;

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function withFileLock(file, callback) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = fs.openSync(lock, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (handle === undefined) throw new Error("sticker usage lock timeout");
  try {
    return callback();
  } finally {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

function usageFile(dataDir) {
  return path.join(String(dataDir || ""), STICKER_USAGE_FILE);
}

function normalizeEvent(input = {}) {
  if (!input || typeof input !== "object") return null;
  const stickerId = cleanText(input.stickerId, 120);
  const partnerId = cleanText(input.partnerId, 120);
  if (!stickerId || !partnerId) return null;
  const sentAt = cleanText(input.sentAt || new Date().toISOString(), 40);
  if (!Number.isFinite(Date.parse(sentAt))) return null;
  return { stickerId, partnerId, sentAt };
}

export function readStickerUsage(dataDir) {
  const raw = readJson(usageFile(dataDir));
  const events = Array.isArray(raw?.events) ? raw.events.map(normalizeEvent).filter(Boolean) : [];
  return {
    schemaVersion: STICKER_USAGE_SCHEMA_VERSION,
    events: events.slice(-MAX_STICKER_USAGE_EVENTS),
  };
}

export function recordStickerUsage(dataDir, input) {
  const event = normalizeEvent(input);
  if (!event || !dataDir) return { ok: false, skipped: true };
  try {
    const file = usageFile(dataDir);
    withFileLock(file, () => {
      const current = readStickerUsage(dataDir);
      const events = [...current.events, event].slice(-MAX_STICKER_USAGE_EVENTS);
      writeJson(file, {
        schemaVersion: STICKER_USAGE_SCHEMA_VERSION,
        events,
      });
    });
    return { ok: true };
  } catch {
    // 记录只是辅助入口，不能影响茶话会正常发消息。
    return { ok: false, skipped: true };
  }
}

export function stickerUsageFile(dataDir) {
  return usageFile(dataDir);
}
