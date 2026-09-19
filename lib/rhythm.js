/**
 * 节奏器：算「未读多久 → 已读 → 打字多久 → 一条条蹦出来」的时间表。
 *
 * 依据调研：
 *  - AstrBot 条间间隔的对数式：i = log(字数 + 1, 2.6)，再取 uniform(i, i + 0.5) 秒
 *    → 短句快、长句慢但不线性变慢，像真人
 *  - 真人手机打字：点开得等一下（看消息），点开之后还要打一会儿字
 */

export const DEFAULT_RHYTHM = {
  /** 未读持续多久（闲着的时候） */
  readMinMs: 1200,
  readMaxMs: 6000,
  /** 在忙的时候，未读会拖很久 */
  busyReadMinMs: 20000,
  busyReadMaxMs: 90000,
  /** 从「已读」到第一条气泡之间的打字时间下限 */
  typingMinMs: 700,
  /** 条与条之间的间隔下限 */
  gapMinMs: 800,
  /** 整体节奏缩放（1 = 默认；<1 更快，>1 更慢） */
  speed: 1,
};

const LOG_BASE = 2.6;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 对数式打字/间隔时长（毫秒）。
 * @param {number} chars 这段文字的字数
 * @param {() => number} rand 0..1 随机源（便于测试）
 */
export function logDurationMs(chars, rand = Math.random, base = LOG_BASE) {
  const count = Math.max(0, Number(chars) || 0);
  const i = Math.log(count + 1) / Math.log(base);
  return (i + rand() * 0.5) * 1000;
}

/**
 * 生成一轮的时间表。
 * @param {string[]} bubbles 已切好的气泡
 * @param {{rand?: () => number, rhythm?: object, busy?: boolean}} [options]
 * @returns {{readAfterMs: number, typingMs: number, items: Array<{text: string, showAfterMs: number, gapMs: number}>}}
 */
export function planTurn(bubbles, options = {}) {
  const rand = options.rand ?? Math.random;
  const rhythm = { ...DEFAULT_RHYTHM, ...(options.rhythm ?? {}) };
  const speed = clamp(Number(rhythm.speed) || 1, 0.2, 4);
  const list = (bubbles ?? []).map((item) => String(item ?? "")).filter((item) => item.length > 0);

  const readMin = options.busy ? rhythm.busyReadMinMs : rhythm.readMinMs;
  const readMax = options.busy ? rhythm.busyReadMaxMs : rhythm.readMaxMs;
  const readAfterMs = Math.round((readMin + rand() * Math.max(0, readMax - readMin)) * speed);

  if (list.length === 0) {
    return { readAfterMs, typingMs: 0, items: [] };
  }

  const items = [];
  let cursor = 0;
  for (let index = 0; index < list.length; index += 1) {
    const text = list[index];
    const base = logDurationMs(text.length, rand);
    // 第一条同时充当「打字时间」，但至少 typingMinMs
    const raw = index === 0 ? Math.max(rhythm.typingMinMs, base) : Math.max(rhythm.gapMinMs, base);
    const gapMs = Math.round(raw * speed);
    cursor += gapMs;
    items.push({ text, showAfterMs: cursor, gapMs });
  }

  return { readAfterMs, typingMs: items[0]?.showAfterMs ?? 0, items };
}

/**
 * 一条消息大致要打多久（供「正在输入…」的显示时长参考）。
 */
export function typingDurationFor(text, options = {}) {
  const rand = options.rand ?? Math.random;
  const rhythm = { ...DEFAULT_RHYTHM, ...(options.rhythm ?? {}) };
  const total = (options.bubbles ?? [String(text ?? "")]).reduce(
    (sum, item) => sum + Math.max(rhythm.gapMinMs, logDurationMs(String(item ?? "").length, rand)),
    0,
  );
  const speed = clamp(Number(rhythm.speed) || 1, 0.2, 4);
  return Math.round(Math.max(rhythm.typingMinMs, total) * speed);
}
