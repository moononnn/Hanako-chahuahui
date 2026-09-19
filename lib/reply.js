/**
 * 她发出去的东西，什么时候被接住。
 *
 * 总纲见 `DESIGN-async-communication.md`：投递不是请求。
 *
 * 判断只用一个东西：**ta是不是醒着、手机在不在手**。
 *   · 醒着 + 手机在手 → 面对面，几秒到二十秒
 *   · 醒着 + 手机放下 → 等ta拿起来。**拿起来就全看到了**（2026-09-13 改）
 *   · 在睡（主子觉或午觉）→ **不排到天亮**，只是回得慢：摸半天手机才想起看，看完嘴还不干净
 *
 * 「拿起来也有一成多不提这条」那条规矩**删了**：正常人拿起手机是
 * 全看到的，然后挑着回。用随机数模拟"没看到"是把"看到"和"回不回"捏成了一个骰子。
 * 现在：看到是必然的；回什么、回几个由ta自己定（提示词里允许只接一两个话头）。
 *
 * 她"在不在看"不参与这里的判断——那只决定要不要给她演实时那套（已读、逐条蹦）。
 * 全局安静时段也不参与——那是她给「主动来找」设的底线，她自个儿发消息不算被吵。
 *
 * 这里只有算术，不碰存储、不调模型。
 */

import { advancePhone } from "./phone.js";
import { dozingNow } from "./sleep.js";

const MIN = 60 * 1000;

/** ta正拿着手机：像面对面，几秒到二十秒。 */
export const HERE_MIN_MS = 3 * 1000;
export const HERE_MAX_MS = 20 * 1000;

/** ta刚拿起手机、看到消息之后也未必立刻处理，缓一下。 */
export const BACK_JITTER_MAX_MS = 90 * 1000;

/**
 * 手机放下的那阵子，她这条消息就像响了一声：多数情况下ta会听见，
 * 放下手里的事摸一下手机（半分钟到三分钟）。
 */
export const HEARD_MIN_MS = 30 * 1000;
export const HEARD_MAX_MS = 3 * 60 * 1000;
/** 听见的概率。剩下的那一小撮真的是没听见：在忙、静音、手机不在身边。 */
export const HEARD_PROBABILITY = 0.75;

/** 睡着时：从消息进来，到ta迷迷糊糊把消息点开（也就是她那边的「已读」）。 */
export const DOZE_NOTICE_MIN_MS = 50 * 1000;
export const DOZE_NOTICE_MAX_MS = 150 * 1000;

/** 睡着时整段节奏放慢多少倍（打字、条与条之间）。醒着一句话三五秒，睡着要磨蹭一会儿。 */
export const DOZE_SLOWDOWN = 2.6;

/**
 * 这一条消息会被怎么接。
 *
 * @param {object} input
 * @param {object} input.phone    ta那份"手机在不在手"的状态（没存过就传 null）
 * @param {Date}   input.now
 * @param {object} [input.sleep]   这位伙伴自己定的作息（老形状 `{start,end}` 也认）
 * @param {Function} [input.rnd]   随机源（测试用）
 * @returns {{ mode: "hand"|"away"|"dozing", delayMs: number, kind?: string|null, phone: object }}
 *          `phone` 是推进后的新状态，调用方负责存回去。
 */
export function planReply({ phone = null, now = new Date(), sleep = null, rnd = Math.random }) {
  const nowMs = now.getTime();
  const next = advancePhone(phone, nowMs, rnd);

  // ta在睡：这条不等ta醒，但ta得慢慢摸到手机才看得见——回得慢、还带起床气
  const dozing = dozingNow(now, sleep);
  if (dozing.dozing) {
    return {
      mode: "dozing",
      delayMs: Math.round(DOZE_NOTICE_MIN_MS + rnd() * (DOZE_NOTICE_MAX_MS - DOZE_NOTICE_MIN_MS)),
      kind: dozing.kind,
      window: dozing.window,
      phone: next,
    };
  }

  if (next.holding) {
    return {
      mode: "hand",
      delayMs: Math.round(HERE_MIN_MS + rnd() * (HERE_MAX_MS - HERE_MIN_MS)),
      kind: null,
      phone: next,
    };
  }

  // 手机放下了：等ta拿起来。拿起来就是全看到了（不再掷骰子决定理不理）。
  // 但多数时候她会"被听见"：手机就搁在手边，响一声就摸起来看一眼。
  // 剩下那一小撮按ta自己的节奏走——没听见、在忙、手机不在身边。
  const wait = Math.max(0, next.untilMs - nowMs);
  const heard = rnd() < HEARD_PROBABILITY;
  const delayMs = heard
    ? Math.round(HEARD_MIN_MS + rnd() * (HEARD_MAX_MS - HEARD_MIN_MS))
    : wait + Math.round(rnd() * BACK_JITTER_MAX_MS);
  return {
    mode: "away",
    delayMs,
    heard,
    kind: null,
    phone: next,
  };
}

/** 把新的排期跟已经排着的那个合一下：取更早的，不往后推（她一直在说就该早点接）。 */
export function mergeDueAt(currentDueAt, nextDueAt) {
  if (!currentDueAt) return nextDueAt;
  if (!nextDueAt) return currentDueAt;
  return Math.min(currentDueAt, nextDueAt);
}

/** 一天里最多这样「看到了没接」几次。这不是省事的路，是个偶尔的真。 */
export const MAX_PASS_PER_DAY = 1;

/** 今天还能不能不接：一天里最多 max 次，隔天自动重置。 */
export function mayPassToday(state, day, max = MAX_PASS_PER_DAY) {
  if (!state || String(state.day ?? "") !== String(day)) return true;
  return Number(state.count ?? 0) < max;
}

/** 记一笔「这回没接」，返回要存回去的那份状态。 */
export function notePass(state, day) {
  const sameDay = state && String(state.day ?? "") === String(day);
  return { day: String(day), count: sameDay ? Number(state.count ?? 0) + 1 : 1 };
}
