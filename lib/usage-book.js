// 茶话会自己的调用索引：每次向模型发请求时，把「这个 requestId 是替哪位伙伴、
// 干什么活儿发的」记一笔。
//
// 只记身份，不记 token——token 在宿主账本里已经有一份准的，这里只补宿主
// 不肯记的那一维（插件调用没有伙伴归因）。两边用 requestId 对上：
// 宿主条目的 metadata.requestId 就是我们发过去的那个 id。
//
// 保留最近六千条、最多 31 天，文件很小，一个请求几十字节。

import path from "node:path";

import { readJsonDurable, writeJsonAtomic } from "./persistence.js";

const FILE = "usage-calls.json";
const SCHEMA_VERSION = 1;
const MAX_ROWS = 6000;
const MAX_AGE_MS = 31 * 86400000;

export function usageBookPath(dataDir) {
  return path.join(String(dataDir), FILE);
}

const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function normalizeRow(input) {
  if (!input || typeof input !== "object") return null;
  const requestId = text(input.requestId, 120);
  const at = text(input.at, 40);
  if (!requestId || !at || !Number.isFinite(Date.parse(at))) return null;
  return {
    requestId,
    at,
    agentId: text(input.agentId, 80),
    kind: text(input.kind, 40),
  };
}

function readRaw(dataDir) {
  const value = readJsonDurable(usageBookPath(dataDir), { schemaVersion: SCHEMA_VERSION, rows: [] });
  if (Number(value?.schemaVersion) !== SCHEMA_VERSION || !Array.isArray(value?.rows)) {
    return { schemaVersion: SCHEMA_VERSION, rows: [] };
  }
  return value;
}

function trim(rows, now) {
  const floor = now - MAX_AGE_MS;
  const fresh = rows.filter((row) => Date.parse(row.at) >= floor);
  return fresh.slice(-MAX_ROWS);
}

/**
 * 追加一笔调用身份。写不进去也不能让聊天挂掉，所以由调用方兜住异常。
 * @returns {{ok: boolean, rows: number, error?: string}}
 */
export function recordUsageCall(dataDir, input, now = Date.now()) {
  const row = normalizeRow(input);
  if (!row) return { ok: false, rows: 0, error: "bad-row" };
  const book = readRaw(dataDir);
  const rows = trim(book.rows.map(normalizeRow).filter(Boolean), now);
  rows.push(row);
  const next = { schemaVersion: SCHEMA_VERSION, rows: trim(rows, now) };
  writeJsonAtomic(usageBookPath(dataDir), next);
  return { ok: true, rows: next.rows.length };
}

/** 读回来（已按时间与条数裁过）。坏账本按空账处理，不外抛。 */
export function readUsageBook(dataDir, now = Date.now()) {
  try {
    return trim(readRaw(dataDir).rows.map(normalizeRow).filter(Boolean), now);
  } catch {
    return [];
  }
}

/** requestId → { agentId, kind }。查不到的说明这次调用没留身份（比如旧记录或辅助路径）。 */
export function usageIndex(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) index.set(row.requestId, row);
  return index;
}
