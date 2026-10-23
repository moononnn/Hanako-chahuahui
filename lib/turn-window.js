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
 * 这一行算不算「说的话」。
 *
 * 动作和酒馆开场不是话：它们不进模型上下文（见 lib/prompt.js 的 threadToMessages），
 * 所以也不能当回复目标——排一轮生成去接一句模型根本没看见的话，ta 只能对着空气开口，
 * 2026-10-16 实机就是这么冒出一句接自己上句的回复。回复目标、排期、恢复轮共用这一个判定。
 */
export function isSpeechMessage(row) {
  return Boolean(row) && !NON_SPEECH_KINDS.has(row.kind);
}

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

// ── 插话可中断的生成车道 ────────────────────────────────────────
//
// 2026-10-23 新增。composeWithSupersedeRetry 只能作废两次：她连着补话补到第三次，
// 那一轮就把最新目标交回排期，下一轮才接得上。这里换成「她插多少次都接得住」：
// 每来一句新话就作废当前生成，等最近一次插话之后安静一小会儿（settleMs）再按最新上下文重开，
// 同一时刻仍然只跑一个生成。
//
// 只管「什么时候重开、什么时候停」：不碰提示词、不碰线程账本，也不认识任何具体回复逻辑。
// 旧导出原样留着，老调用方不受影响。

/** 已经有生成在跑，又来一轮：拒掉，不另开一个。 */
export const REPLY_BUSY = "REPLY_BUSY";
/** 被新话作废（我们自己 abort 的那一种，可以吞掉重来）。 */
export const REPLY_SUPERSEDED = "REPLY_SUPERSEDED";
/** 整轮被取消（停用、重载、换人）：吞掉，run 回 stale。 */
export const REPLY_STALE = "REPLY_STALE";

const ABORT_NAME = "AbortError";

/**
 * 只有我们自己 abort 的那两种取消能吞；别的错照实抛出去，不重试。
 */
function abortCodeOf(error, signal) {
  const ownReason = signal?.aborted && error === signal.reason;
  const code = ownReason || error?.name === ABORT_NAME ? error?.code : null;
  return code === REPLY_SUPERSEDED || code === REPLY_STALE ? code : null;
}

/**
 * 一个伙伴一条车道。
 *
 * @param {{settleMs?: number}} options settleMs：最近一次插话之后要安静多久才重开
 * @returns {{run: Function, interrupt: Function, cancel: Function, has: Function}}
 */
export function createInterruptibleComposer({ settleMs = 500 } = {}) {
  /** agentId -> 车道。同一伙伴同时只有一条。 */
  const lanes = new Map();

  const abortLane = (lane, code) => {
    const controller = lane.controller;
    if (!controller || controller.signal.aborted) return;
    try {
      controller.abort({ name: ABORT_NAME, code, waitForRelease: true });
    } catch {
      /* abort 失败不影响后面的判断：靠 quietAt 与 signal.aborted 兜 */
    }
  };

  /**
   * 等到最近一次插话之后安静下来。
   * 插话会把 quietAt 推到当下，等待期重新算——一串插话因此合并成一次重开。
   */
  const waitQuiet = async (lane) => {
    while (!lane.stopped) {
      const wait = lane.quietAt + settleMs - Date.now();
      if (wait <= 0) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          lane.wake = null;
          resolve();
        }, wait);
        lane.wake = () => {
          clearTimeout(timer);
          lane.wake = null;
          resolve();
        };
      });
    }
  };

  /**
   * 跑一轮：make 每被作废一次就按新上下文重来，插多少次都行。
   *
   * @param {string} agentId
   * @param {(ctx: {signal: AbortSignal, attempt: number}) => Promise<object>} make
   * @param {{isCurrent?: () => boolean, onSupersede?: (attempt: number, made: object) => void}} options
   */
  async function run(agentId, make, { isCurrent = () => true, onSupersede = null } = {}) {
    const busy = lanes.get(agentId);
    if (busy && !busy.done) {
      const error = new Error("这位伙伴已经有一轮在跑，不另开生成");
      error.code = REPLY_BUSY;
      throw error;
    }
    const lane = {
      agentId,
      stopped: false,
      done: false,
      latestId: null,
      interrupts: 0,
      quietAt: Date.now(),
      controller: null,
      wake: null,
    };
    // 首 await 之前登记：不等跑起来就已经占住这条伙伴的车道。
    lanes.set(agentId, lane);
    try {
      for (let attempt = 0; ; attempt += 1) {
        await waitQuiet(lane);
        if (lane.stopped) return { ok: false, reason: "stale" };
        if (!isCurrent()) return { ok: false, reason: "stale" };
        const controller = new AbortController();
        lane.controller = controller;
        const seenInterrupts = lane.interrupts;
        const seenLatestId = lane.latestId;
        let made = null;
        try {
          made = await make({ signal: controller.signal, attempt });
        } catch (error) {
          const code = abortCodeOf(error, controller.signal);
          // 自己 abort 的那种取消：吞掉，按新上下文重来。
          if (code === REPLY_SUPERSEDED) {
            onSupersede?.(attempt, { ok: false, reason: "superseded", supersededBy: lane.latestId });
            continue;
          }
          if (code === REPLY_STALE) return { ok: false, reason: "stale" };
          throw error;
        } finally {
          if (lane.controller === controller) lane.controller = null;
        }
        if (lane.stopped) return { ok: false, reason: "stale" };
        // 已经提交成功的原样交回，不改不动（取消除外：取消说了算）。
        if (made?.ok === true) return made;
        if (!isCurrent()) return { ok: false, reason: "stale" };
        // 这轮期间她又说了：这份稿子按旧上下文写的，不许冒充新稿。
        const late = controller.signal.aborted
          || lane.interrupts !== seenInterrupts
          || lane.latestId !== seenLatestId;
        if (late) {
          onSupersede?.(attempt, made);
          continue;
        }
        if (made?.reason === "superseded") {
          onSupersede?.(attempt, made);
          continue;
        }
        return made ?? { ok: false, reason: "empty" };
      }
    } finally {
      lane.done = true;
      // 按车道身份清理：旧车道不许把新车道删掉。
      if (lanes.get(agentId) === lane) lanes.delete(agentId);
    }
  }

  /**
   * 她又说话了：记下最新那条，作废当前生成，等安静期后按新上下文重开。
   * @returns {boolean} 有没有打断到在跑的生成
   */
  function interrupt(agentId, messageId) {
    const lane = lanes.get(agentId);
    if (!lane || lane.done) return false;
    lane.latestId = messageId ?? lane.latestId;
    lane.interrupts += 1;
    lane.quietAt = Date.now();
    abortLane(lane, REPLY_SUPERSEDED);
    lane.wake?.();
    return true;
  }

  /**
   * 整轮停掉（停用、重载、换人）：这一轮回 stale，不再重开。
   * @returns {boolean} 有没有停到在跑的生成
   */
  function cancel(agentId) {
    const lane = lanes.get(agentId);
    if (!lane || lane.done) return false;
    lane.stopped = true;
    abortLane(lane, REPLY_STALE);
    lane.wake?.();
    return true;
  }

  /** 这位伙伴眼下有没有在跑的生成。 */
  const has = (agentId) => Boolean(lanes.get(agentId));

  return { run, interrupt, cancel, has };
}
