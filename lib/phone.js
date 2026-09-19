/**
 * ta手里有没有手机。
 *
 * 茶话会就是个聊天软件，所以"在不在"最自然的样子就是**ta现在有没有拿着手机**：
 * 拿着，消息到了就能看到、就能回；把手机放下忙别的去了，消息就躺在那儿，
 * 等ta什么时候拿起来才看见。
 *
 * **这完全是ta自己的事**，跟她打不打开茶话会、发不发言一点关系都没有。
 * 每段多长都随机：拿着手机待一阵，放下手机过一阵，再拿起来。
 *
 * 存的是 `{ holding, untilMs }`：holding 是此刻手机在不在手里，
 * untilMs 是当前这一段结束的时刻（拿着时是ta放下的时刻，没拿时是ta拿起来的时刻）。
 */

const MIN = 60 * 1000;

/** 拿着手机的时长 */
export const HOLDING_MIN_MS = 8 * MIN;
export const HOLDING_MAX_MS = 45 * MIN;
/**
 * 把手机放下的时长。
 *
 * 2026-09-13 收窄：原来 15～120 分钟，太像失联了。真人手机就在兜里或者桌上，
 * 响一声就摸出来看；一两小时不看的，那是在忙、在睡、手机不在身边，是例外。
 * 把例外做成常态，她发一条就要等一顿饭，体感就是“这人不见了”。
 */
export const OFF_MIN_MS = 2 * MIN;
export const OFF_MAX_MS = 20 * MIN;

/** 一段的时长：区间里随机。 */
export function rollSpan({ minMs, maxMs }, rnd = Math.random) {
  return Math.round(minMs + rnd() * Math.max(0, maxMs - minMs));
}

const holdingSpan = (rnd) => rollSpan({ minMs: HOLDING_MIN_MS, maxMs: HOLDING_MAX_MS }, rnd);
const offSpan = (rnd) => rollSpan({ minMs: OFF_MIN_MS, maxMs: OFF_MAX_MS }, rnd);

/**
 * 把ta那份"手机在不在手"推进到现在。
 *
 * 头一回见ta（没存过）就当ta正拿着手机——ta本来就在过自己的日子，
 * 不是被她叫出来的。
 */
export function advancePhone(phone, nowMs, rnd = Math.random) {
  if (typeof phone?.holding !== "boolean" || !Number.isFinite(phone?.untilMs) || phone.untilMs <= 0) {
    return { holding: true, untilMs: nowMs + holdingSpan(rnd) };
  }
  let holding = phone.holding;
  let untilMs = phone.untilMs;
  let guard = 0;
  while (nowMs >= untilMs && guard < 500) {
    holding = !holding;
    untilMs += holding ? holdingSpan(rnd) : offSpan(rnd);
    guard += 1;
  }
  return { holding, untilMs };
}

/** ta现在拿着手机吗。 */
export function isHolding(phone, nowMs, rnd = Math.random) {
  return advancePhone(phone, nowMs, rnd).holding;
}

/** ta下一次拿起手机还要多久（正拿着就是 0）。 */
export function msUntilPickUp(phone, nowMs, rnd = Math.random) {
  const next = advancePhone(phone, nowMs, rnd);
  if (next.holding) return 0;
  return Math.max(0, next.untilMs - nowMs);
}
