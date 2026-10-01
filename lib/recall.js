export const RECALL_WINDOW_MS = 2 * 60 * 1000;

export function recallWindow(now = Date.now(), sentAt) {
  const at = Date.parse(sentAt ?? "");
  if (!Number.isFinite(at)) return { ok: false, reason: "bad-time", expiresAt: null };
  const expiresAt = at + RECALL_WINDOW_MS;
  if (now > expiresAt) return { ok: false, reason: "expired", expiresAt };
  return { ok: true, reason: "open", expiresAt };
}

/**
 * 这条消息现在能不能撤回。
 *
 * 两分钟窗口只管**已经被对方看到**的消息：那种撤回会留下「你撤回了一条消息」的占位，
 * 拖太久就不该再动。还没被看到的话收回来是无痕的（等于没发过），不扯断任何上下文，
 * 所以它不设时限——刚删掉回复、原话退回未读时，她想撤回随时都能撤。
 */
export function recallEligibility(message, { now = Date.now(), processing = false, delivering = false } = {}) {
  if (!message || message.role !== "user") return { ok: false, reason: "not-user" };
  if (message.recalled || message.kind === "recalled") return { ok: false, reason: "already-recalled" };
  if (processing) return { ok: false, reason: "processing" };
  if (delivering) return { ok: false, reason: "replying" };
  const window = recallWindow(now, message.at);
  // 还没被看过的撤回是无痕的，不挂倒计时
  if (!message.readAt) return { ok: true, read: false, expiresAt: null };
  if (!window.ok) return window;
  return { ok: true, read: true, expiresAt: window.expiresAt };
}

export function shouldCancelScheduledReply(messages) {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  return !messages.slice(lastAssistant + 1).some((row) => row?.role === "user" && !row.recalled && row.kind !== "recalled");
}
