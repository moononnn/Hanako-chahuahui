import fs from "node:fs";
import path from "node:path";

/**
 * 小应用 JSON 账本的共同落盘规则：不存在才用默认值；读失败和坏账本不能伪装成空账。
 */
export function quarantineCorrupt(file, { onQuarantined = null, onFailed = null } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, dest);
    onQuarantined?.({ file, dest });
    return dest;
  } catch (error) {
    onFailed?.({ file, dest, error });
    return null;
  }
}

export function readJsonDurable(file, fallback, { onCorrupt = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    const moved = quarantineCorrupt(file, {
      onQuarantined: (info) => onCorrupt?.({ ...info, error }),
      onFailed: (info) => onCorrupt?.({ ...info, error }),
    });
    if (!moved) {
      throw new Error(`损坏账本无法留档，拒绝继续写入: ${path.basename(file)}`, { cause: error });
    }
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 原文件保持不动 */ }
    throw error;
  }
}
