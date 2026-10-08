/**
 * 一轮回复的目标上界。
 *
 * 每轮生成开始时会捕获「这轮真正读进去的最后一条她的话」（replyTargetId）。
 * 捕获之后又落进来的她的话，这一轮的旧稿就不能原样送出去：
 * 送出去等于替还没被读的那句先签了已读，下一轮还会为它再补一次同样的话。
 *
 * 这里只管「该不该作废旧稿」和「作废后怎么顺序重来」两件事，
 * 不管生成本身，也不碰线程账本。
 */

/** 不算「她说了新话」的行：戳一戳、动作、酒馆开场都不进模型上下文，不该逼着重来一轮。 */
const NON_SPEECH_KINDS = new Set(["poke", "action", "tavern-opening"]);

/**
 * 这轮捕获之后，是否又落进来新的她的话。
 *
 * @param {object[]} messages 线程消息（按 seq 递增）
 * @param {string|null} targetId 本轮捕获的目标上界
 * @returns {{ superseded: boolean, newerMessageId: string|null }}
 */
export function hasNewerUserMessage(messages, targetId) {
  const rows = Array.isArray(messages) ? messages : [];
  if (!targetId) return { superseded: false, newerMessageId: null };
  const index = rows.findIndex((row) => row?.id === targetId);
  // 目标自己不在了（被撤回、删掉、清空）：这轮上下文已经不可信，交给调用方按 stale 处理。
  if (index < 0) return { superseded: false, newerMessageId: null };
  for (const row of rows.slice(index + 1)) {
    // 覆盖这条目标的回复已经落盘：这轮结束了，之后的话是下一轮的事，不该把旧稿拖下水。
    if (row?.role === "assistant" && !row.recalled && !row.proactive && !row.nudge
      && String(row.repliedTo ?? "") === String(targetId)) {
      return { superseded: false, newerMessageId: null };
    }
    if (row?.role !== "user" || row.recalled) continue;
    if (NON_SPEECH_KINDS.has(row.kind)) continue;
    return { superseded: true, newerMessageId: row.id ?? null };
  }
  return { superseded: false, newerMessageId: null };
}

/**
 * 最多作废几次：她连着补话时按最新上下文顺序重来，别无限追。
 */
export const SUPERSEDE_MAX_RETRIES = 2;

/**
 * 同一伙伴同一时刻只允许一个生成在进行中：旧稿作废后在这条回合里顺序重来，
 * 不新开第二个模型请求。
 *
 * 追到上限仍然有新话时，返回 superseded 而不是再发一次——按旧上下文写的稿子
 * 明知过期就不该送出去；把它交回调用方，由调用方把最新目标排进正常排期。
 *
 * @param {(attempt: number) => Promise<object>} make
 * @param {{ maxRetries?: number, onSupersede?: (attempt: number, made: object) => void }} options
 */
export async function composeWithSupersedeRetry(make, { maxRetries = SUPERSEDE_MAX_RETRIES, onSupersede = null } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const made = await make(attempt);
    if (made?.reason !== "superseded") return made;
    last = made;
    onSupersede?.(attempt, made);
  }
  // 把最后那次作废的理由带上去，调用方拿它当排期的目标。
  return { ok: false, reason: "superseded", exhausted: true, supersededBy: last?.supersededBy ?? null, generationMs: last?.generationMs ?? 0 };
}
