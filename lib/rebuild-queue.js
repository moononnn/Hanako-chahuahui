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

const STATUSES = new Set(["pending", "running", "failed", "succeeded"]);

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

function copyState(state) {
  return { ...state, days: [...state.days] };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || !STATUSES.has(value.status)) return null;
  const days = Array.isArray(value.days)
    ? [...new Set(value.days.map((day) => String(day ?? "")).filter(Boolean))]
    : [];
  const attempt = Number(value.attempt);
  const generation = Number(value.generation);
  const updatedAt = Number(value.updatedAt);
  return {
    status: value.status,
    days,
    attempt: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
    generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    error: value.error == null ? null : String(value.error),
  };
}

function normalizedDelay(value) {
  const delay = Number(value);
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function createThreadRebuildScheduler({
  delayMs = THREAD_REBUILD_DELAY_MS,
  retryDelaysMs = [],
  run,
  readState = null,
  writeState = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onSchedule = null,
} = {}) {
  const entries = new Map();
  const generations = new Map();
  const retryDelays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.map(Number).filter((delay) => Number.isFinite(delay) && delay >= 0)
    : [];

  const readStored = (id) => {
    if (typeof readState !== "function") return null;
    try {
      const result = readState(id);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        return null;
      }
      return normalizeState(result);
    } catch {
      return null;
    }
  };

  const persist = (id, state) => {
    if (typeof writeState !== "function") return { ok: true };
    try {
      const result = writeState(id, state == null ? null : copyState(state));
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        return { ok: false, error: "writeState must be synchronous" };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  };

  const saveRequired = (id, entry, state) => {
    const result = persist(id, state);
    if (result.ok) {
      entry.state = copyState(state);
      return true;
    }
    const failed = {
      ...state,
      status: "failed",
      attempt: state.status === "running" ? Math.max(0, state.attempt - 1) : state.attempt,
      updatedAt: Date.now(),
      error: `保存${state.status}状态失败: ${result.error}`,
    };
    entry.state = failed;
    persist(id, failed);
    return false;
  };

  const saveTerminal = (id, entry, state) => saveRequired(id, entry, state);

  const notifySchedule = (event) => {
    if (typeof onSchedule !== "function") return;
    try {
      const result = onSchedule(event);
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    } catch { /* diagnostics must not break scheduling */ }
  };

  const clearEntryTimer = (entry) => {
    if (!entry?.timerActive) return;
    clearTimeoutFn(entry.timer);
    entry.timer = null;
    entry.timerActive = false;
  };

  const armTimer = (id, entry, delay) => {
    const wait = normalizedDelay(delay);
    const generation = entry.state.generation;
    try {
      entry.timer = setTimeoutFn(() => {
        entry.timer = null;
        entry.timerActive = false;
        void execute(id, entry, generation).catch(() => {});
      }, wait);
      entry.timerActive = true;
      entry.timer?.unref?.();
      return wait;
    } catch (error) {
      const failed = {
        ...entry.state,
        status: "failed",
        updatedAt: Date.now(),
        error: `创建定时器失败: ${errorText(error)}`,
      };
      entry.state = failed;
      persist(id, failed);
      return null;
    }
  };

  const isCurrent = (id, entry, generation) =>
    entries.get(id) === entry && generations.get(id) === generation;

  const execute = async (id, entry, generation) => {
    if (!isCurrent(id, entry, generation)) return;
    const maxAttempts = 1 + retryDelays.length;
    if (entry.state.attempt >= maxAttempts) {
      saveTerminal(id, entry, {
        ...entry.state,
        status: "failed",
        updatedAt: Date.now(),
        error: entry.state.error || "重建重试次数已耗尽",
      });
      return;
    }
    const running = {
      ...entry.state,
      status: "running",
      attempt: entry.state.attempt + 1,
      updatedAt: Date.now(),
    };
    if (!saveRequired(id, entry, running)) return;

    let result;
    let failure = null;
    try {
      result = await run(id, [...running.days]);
      if (result && typeof result === "object" && result.ok === false) {
        failure = result.error == null ? "重建失败" : errorText(result.error);
      }
    } catch (error) {
      failure = errorText(error);
    }

    if (!isCurrent(id, entry, generation)) return;
    if (failure == null) {
      saveTerminal(id, entry, { ...running, status: "succeeded", updatedAt: Date.now(), error: null });
      return;
    }

    if (running.attempt <= retryDelays.length) {
      const pending = { ...running, status: "pending", updatedAt: Date.now(), error: failure };
      if (!saveRequired(id, entry, pending)) return;
      const wait = armTimer(id, entry, retryDelays[running.attempt - 1]);
      if (wait == null) return;
      return;
    }

    saveTerminal(id, entry, { ...running, status: "failed", updatedAt: Date.now(), error: failure });
  };

  /** 排一次重建。同一伙伴已有待办或失败状态时合并日子，并开启新的重试预算。 */
  const schedule = (agentId, { ledgerDay = null, delay = delayMs } = {}) => {
    const id = String(agentId ?? "").trim();
    if (!id || typeof run !== "function") return null;

    const existing = entries.get(id);
    const stored = existing ? null : readStored(id);
    const storedIsCurrent = stored && stored.generation >= (generations.get(id) ?? 0);
    const previous = existing?.state ?? (storedIsCurrent ? stored : null);
    const previousGeneration = Math.max(
      generations.get(id) ?? 0,
      previous?.generation ?? 0,
    );
    const generation = previousGeneration + 1;
    const days = new Set(previous?.status === "succeeded" ? [] : previous?.days ?? []);
    if (ledgerDay) days.add(String(ledgerDay));
    const mergedDays = [...days];
    const wait = normalizedDelay(delay);
    const state = {
      status: "pending",
      days: mergedDays,
      attempt: 0,
      generation,
      updatedAt: Date.now(),
      error: null,
    };

    clearEntryTimer(existing);
    generations.set(id, generation);
    const entry = { state, timer: null, timerActive: false };
    entries.set(id, entry);
    if (!saveRequired(id, entry, state)) return null;
    if (armTimer(id, entry, wait) == null) return null;

    const scheduled = { agentId: id, delayMs: wait, days: mergedDays };
    notifySchedule(scheduled);
    return scheduled;
  };

  const cancel = (agentId) => {
    const id = String(agentId ?? "").trim();
    if (!id) return false;
    const entry = entries.get(id);
    const stored = entry ? null : readStored(id);
    const hadState = Boolean(entry?.state || stored);
    const generation = Math.max(
      generations.get(id) ?? 0,
      entry?.state?.generation ?? 0,
      stored?.generation ?? 0,
    ) + 1;
    clearEntryTimer(entry);
    entries.delete(id);
    generations.set(id, generation);
    const cleared = persist(id, null);
    if (cleared.ok) return hadState;

    if (entry?.state || stored) {
      const failed = {
        ...(entry?.state ?? stored),
        status: "failed",
        generation,
        updatedAt: Date.now(),
        error: `清除排程状态失败: ${cleared.error}`,
      };
      entries.set(id, { state: failed, timer: null, timerActive: false });
      persist(id, failed);
    }
    return false;
  };

  const pending = (agentId) => {
    const entry = entries.get(String(agentId ?? "").trim());
    return entry?.timerActive ? { days: [...entry.state.days] } : null;
  };

  const resume = (agentId) => {
    const id = String(agentId ?? "").trim();
    if (!id || typeof run !== "function") return null;
    const existing = entries.get(id);
    if (existing) {
      return existing.timerActive
        ? { agentId: id, delayMs: normalizedDelay(delayMs), days: [...existing.state.days] }
        : null;
    }

    const state = readStored(id);
    if (!state || state.generation < (generations.get(id) ?? 0)) return null;
    generations.set(id, state.generation);
    const entry = { state, timer: null, timerActive: false };
    entries.set(id, entry);
    if (state.status === "failed" || state.status === "succeeded") return null;

    const pendingState = { ...state, status: "pending", updatedAt: Date.now() };
    if (!saveRequired(id, entry, pendingState)) return null;
    const wait = armTimer(id, entry, delayMs);
    if (wait == null) return null;
    const resumed = { agentId: id, delayMs: wait, days: [...pendingState.days] };
    notifySchedule({ ...resumed, resumed: true });
    return resumed;
  };

  return { schedule, cancel, pending, resume };
}
