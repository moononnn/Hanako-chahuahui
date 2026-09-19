export const RECALL_WINDOW_MS = 2 * 60 * 1000;

export function recallWindow(now = Date.now(), sentAt) {
  const at = Date.parse(sentAt ?? "");
  if (!Number.isFinite(at)) return { ok: false, reason: "bad-time", expiresAt: null };
  const expiresAt = at + RECALL_WINDOW_MS;
  if (now > expiresAt) return { ok: false, reason: "expired", expiresAt };
  return { ok: true, reason: "open", expiresAt };
}

export function recallEligibility(message, { now = Date.now(), processing = false, delivering = false } = {}) {
  if (!message || message.role !== "user") return { ok: false, reason: "not-user" };
  if (message.recalled || message.kind === "recalled") return { ok: false, reason: "already-recalled" };
  if (processing) return { ok: false, reason: "processing" };
  if (delivering) return { ok: false, reason: "replying" };
  const window = recallWindow(now, message.at);
  if (!window.ok) return window;
  return { ok: true, read: Boolean(message.readAt), expiresAt: window.expiresAt };
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
