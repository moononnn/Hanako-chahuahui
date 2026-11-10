/** 跨伙伴共享的一份持久预占账；写成功后才更新内存。 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dateKey } from "./clock.js";
import { requirePartnerId } from "./partner-id.js";
import { writeJsonAtomic } from "./persistence.js";
import { normalizeImageTier, GLOBAL_IMAGE_LIMITS, PARTNER_IMAGE_LIMITS } from "./chat-image.js";

export function createImageQuota(dataDir, { getGlobal, getPartner, now = () => new Date() }) {
  const file = path.join(dataDir, "v2", "image-quota.json");
  let entries = [];
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(state.entries) || state.entries.some(row => !row || typeof row.id !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !["pending", "unknown", "success"].includes(row.status))) throw new Error("invalid ledger");
    entries = state.entries;
  } catch (error) {
    if (error?.code !== "ENOENT") throw Object.assign(new Error("生图次数账本无法读取，已停止聊天生图，避免额度失控"), { code: "IMAGE_QUOTA_CORRUPT" });
  }
  const active = new Set();
  function save(next) { writeJsonAtomic(file, { entries: next }); entries = next; }
  function usage(agentId) {
    requirePartnerId(agentId);
    const day = dateKey(now());
    // 前一天仍在本进程真实运行的请求跨天占位；重启后未明结果最多保留到次日。
    const rows = entries.filter(row => row.day === day || active.has(row.id));
    const count = (owner, status) => rows.filter(row => (!owner || row.agentId === owner) && (status === "success" ? row.status === "success" && row.day === day : row.status !== "success")).length;
    return { day, globalUsed: count(null, "success"), globalPending: count(null, "pending"), globalLimit: GLOBAL_IMAGE_LIMITS[normalizeImageTier(getGlobal()?.imageTier)], partnerUsed: count(agentId, "success"), partnerPending: count(agentId, "pending"), partnerLimit: PARTNER_IMAGE_LIMITS[normalizeImageTier(getPartner(agentId)?.imageTier)] };
  }
  function available(agentId) {
    const u = usage(agentId);
    return u.globalUsed + u.globalPending < u.globalLimit && u.partnerUsed + u.partnerPending < u.partnerLimit;
  }
  return {
    usage, available,
    reserve(agentId) {
      requirePartnerId(agentId);
      if (!available(agentId)) return null;
      const day = dateKey(now());
      const row = { id: randomUUID(), agentId, day, status: "pending" };
      save([...entries.filter(entry => entry.day === day || active.has(entry.id)), row]);
      active.add(row.id);
      return row.id;
    },
    settle(id, outcome) {
      const row = entries.find(row => row.id === id);
      if (!row || row.status === "success") return;
      if (!["success", "failed", "unknown"].includes(outcome)) throw new Error("无效生图终态");
      const next = outcome === "failed" ? entries.filter(entry => entry.id !== id) : entries.map(entry => entry.id === id ? { ...entry, status: outcome, ...(outcome === "success" ? { day: dateKey(now()) } : {}) } : entry);
      save(next);
      active.delete(id);
    },
  };
}
