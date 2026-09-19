/**
 * 日子怎么切。
 *
 * 一天从凌晨四点算起（聊天常拖到很晚），所以：
 *   9月12日 03:30  →  算 9月11日
 *   9月12日 04:00  →  算 9月12日
 * 不这么切的话，一场通宵会被劈成两天，日账上就散了。
 */

export const DAY_START_HOUR = 4;

const pad = (n) => String(n).padStart(2, "0");

export function dayKey(date = new Date(), startHour = DAY_START_HOUR) {
  const d = new Date(date instanceof Date ? date.getTime() : new Date(date).getTime());
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-09-12" → "9月12日" */
export function dayLabel(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ""));
  if (!match) return String(key ?? "");
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** 两个 dayKey 差几天（用于"昨天""前天"这类说法）。 */
export function daysBetween(fromKey, toKey) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromKey ?? ""));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toKey ?? ""));
  if (!a || !b) return null;
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((tb - ta) / 86400000);
}
