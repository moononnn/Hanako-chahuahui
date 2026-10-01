/**
 * 删除之后的记忆重建排程：延后跑，而且同一个伙伴只留一个。
 *
 * 重建里有模型调用（日账、摘要、关系档案），一次几十秒。以前它紧跟着删除请求入队，
 * 于是用户在几十秒内再动一次删除，就得排在它后面干等——等过头，界面上就是一个
 * 「Internal Server Error」（服务端的删除其实已经做完了，只是响应没等到）。
 * 重建本身不急，晚半分钟和立刻做没差别，所以这里延后并合并：期间多删几次只跑最后一次。
 *
 * 纯逻辑：定时器与执行函数都由外部注入，方便测试。
 */

export const THREAD_REBUILD_DELAY_MS = 45 * 1000;

export function createThreadRebuildScheduler({
  delayMs = THREAD_REBUILD_DELAY_MS,
  run,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onSchedule = null,
} = {}) {
  const timers = new Map();

  /** 排一次重建。同一伙伴已有排期时重置计时，并把新出现的日子并进去。 */
  const schedule = (agentId, { ledgerDay = null, delay = delayMs } = {}) => {
    const id = String(agentId ?? "").trim();
    if (!id || typeof run !== "function") return null;
    const existing = timers.get(id);
    if (existing) clearTimeoutFn(existing.timer);
    const days = new Set(existing?.days ?? []);
    if (ledgerDay) days.add(String(ledgerDay));
    const wait = Math.max(0, Number(delay) || 0);
    const timer = setTimeoutFn(() => {
      timers.delete(id);
      void run(id, [...days]);
    }, wait);
    timer?.unref?.();
    timers.set(id, { timer, days });
    onSchedule?.({ agentId: id, delayMs: wait, days: [...days] });
    return { agentId: id, delayMs: wait, days: [...days] };
  };

  const cancel = (agentId) => {
    const id = String(agentId ?? "").trim();
    const existing = timers.get(id);
    if (!existing) return false;
    clearTimeoutFn(existing.timer);
    timers.delete(id);
    return true;
  };

  const pending = (agentId) => {
    const existing = timers.get(String(agentId ?? "").trim());
    return existing ? { days: [...existing.days] } : null;
  };

  return { schedule, cancel, pending };
}
