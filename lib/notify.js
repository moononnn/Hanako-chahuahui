/**
 * 提醒那层：输入框上方横幅的纯判定。
 *
 * 定死的五条（写在这里，不交给模型发挥）：
 *   · 横幅跟着活跃窗口走 —— 认人不认屋。她 A 窗聊完就换 B 窗，横幅必须跟过去
 *   · 只认手动关闭 —— 自动淡走不算提醒过，她可能没抬头看到
 *   · 同一批只冒一次 —— 手关之后，来了新消息才重冒
 *   · 卡片开着不冒 —— 人已经在茶话会里了，不用再喊
 *   · 静默时段不冒 —— 只累计未读，不出声不出条
 *
 * 这里不碰宿主、不碰文件，全是可测的判定。
 */

import { inWindow } from "./proactive.js";

/** 一批提醒最多搁多久，过了就当旧账，免得几天后突然冒一条出来。 */
export const BATCH_TTL_MS = 12 * 60 * 60 * 1000;

/** 她"在场"的判定窗口：心跳断了这么久，就算茶话会卡片不在看。 */
export const PANEL_OPEN_MS = 75 * 1000;

/** 应用服务端按页面实例收在场租约，序号挡住乱序回包。 */
export function applyPresence(leases, sequences, { token, active, seq, now = Date.now() } = {}) {
  const id = String(token ?? "").trim();
  const number = Number(seq);
  if (!id || !Number.isSafeInteger(number) || number < 0) return false;
  const previous = sequences.get(id);
  if (previous != null && number < previous) return false;
  sequences.set(id, number);
  if (active === false) leases.delete(id);
  else leases.set(id, now);
  return true;
}

export function activePanelSeenAt(leases, now = Date.now(), ttlMs = PANEL_OPEN_MS) {
  let latest = 0;
  for (const [token, at] of leases) {
    if (!Number.isFinite(at) || now - at >= ttlMs) {
      leases.delete(token);
      continue;
    }
    latest = Math.max(latest, at);
  }
  return latest;
}

/** 现在是不是静默时段（只看全局那一段；伙伴自己的作息是主动那层的事）。 */
export function isQuietNow(now, quiet) {
  if (!quiet?.start || !quiet?.end) return false;
  return inWindow(now, quiet);
}

/**
 * 把一条新消息并进当前这批提醒。
 *
 * 同一个人连着发多条，只把那一位往前挪，横幅不会重复冒；条数照实累加。
 * 过了 TTL 的旧批次直接丢掉，从这条重新起一批。
 */
export function mergeBatch(prev, entry, now = new Date()) {
  const at = entry?.at ?? now.toISOString();
  const latest = Date.parse(prev?.latestAt ?? "") || 0;
  const fresh = prev && Array.isArray(prev.partners) && latest && now.getTime() - latest < BATCH_TTL_MS;
  const base = fresh ? prev : { partners: [], count: 0, latestAt: null };

  const agentId = String(entry?.agentId ?? "").trim();
  const name = String(entry?.name ?? agentId).trim();
  const partners = base.partners.filter((row) => row.agentId !== agentId);
  if (agentId) partners.push({ agentId, name });

  return {
    partners,
    count: Number(base.count ?? 0) + 1,
    latestAt: at,
  };
}

/** 横幅上写什么：只报谁找她，绝不带消息内容。 */
export function bannerText(batch) {
  const names = [...new Set((batch?.partners ?? []).map((row) => String(row?.name ?? "").trim()).filter(Boolean))];
  if (names.length === 0) return "";
  if (names.length === 1) {
    const n = Number(batch?.count ?? 0) || 0;
    return n > 1 ? `🌸 ${names[0]} 找你说说话 · ${n} 条` : `🌸 ${names[0]} 找你说说话`;
  }
  const head = names.slice(0, 2).join("、");
  const rest = names.length > 2 ? ` 等 ${names.length} 位` : "";
  return `🌸 ${head}${rest} 找你说说话`;
}

/**
 * 这一批现在该不该冒。
 *
 * @param {object} input
 * @param {Date}   input.now
 * @param {object} input.quiet              全局静默时段 { start, end }
 * @param {boolean} input.panelOpen         茶话会卡片是不是开着
 * @param {object} input.batch              当前这批提醒
 * @param {string|null} input.activeSessionPath 她最近开口的那个会话
 */
export function shouldAnnounce({ now, quiet, panelOpen, batch, activeSessionPath }) {
  if (!activeSessionPath) return { ok: false, reason: "no-active-window" };
  if (panelOpen) return { ok: false, reason: "panel-open" };
  if (!batch || Number(batch.count ?? 0) <= 0) return { ok: false, reason: "nothing-to-say" };
  if (isQuietNow(now, quiet)) return { ok: false, reason: "quiet" };
  return { ok: true, reason: "ok" };
}
