/**
 * 用户生活节拍：只从茶话会自己的聊天记录提取低风险、可解释的弱信号。
 * 不做模型调用；数据不足时返回空，避免把偶然聊天硬说成习惯。
 */

const MIN_MESSAGES = 8;
const MIN_DAYS = 4;
const MAX_ROWS_PER_DAY = 3;
const MAX_AGE_DAYS = 45;
const MIN_STYLE_MESSAGES = 12;
const BUCKET_MINUTES = 30;
const MARKERS = ["哈", "啦", "呀", "嘛", "咯", "哦", "~", "！"];

function validRows(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((row) => row?.role === "user" && !row.recalled && row.kind !== "action" && row.kind !== "poke")
    .map((row) => ({ ...row, date: new Date(row.at) }))
    .filter((row) => row.date instanceof Date && !Number.isNaN(row.date.getTime()) && String(row.text ?? "").trim());
}

function bucketOf(date) {
  return Math.floor((date.getHours() * 60 + date.getMinutes()) / BUCKET_MINUTES);
}

function clockOf(bucket) {
  const minutes = bucket * BUCKET_MINUTES;
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ratioWithMarkers(text) {
  const value = String(text ?? "");
  return MARKERS.reduce((sum, marker) => sum + (value.includes(marker) ? 1 : 0), 0) > 0 ? 1 : 0;
}

function rangeFor(buckets) {
  if (!buckets.length) return null;
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  return { start: clockOf(min), end: clockOf(Math.min(47, max + 1)), min, max };
}

function mainCluster(rows) {
  const counts = new Map();
  for (const row of rows) {
    const bucket = bucketOf(row.date);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const buckets = [...counts.keys()].sort((a, b) => a - b);
  const clusters = [];
  for (const bucket of buckets) {
    const previous = clusters.at(-1);
    if (!previous || bucket - previous.at(-1) > 1) clusters.push([bucket]);
    else previous.push(bucket);
  }
  return clusters
    .map((cluster) => ({ cluster, score: cluster.reduce((sum, bucket) => sum + (counts.get(bucket) ?? 0), 0) }))
    .sort((a, b) => b.score - a.score || a.cluster[0] - b.cluster[0])[0]?.cluster ?? [];
}

/**
 * @returns {{ready:boolean,count:number,usualWindow?:object,weekdayWindows:object,style?:object,latestAt?:string}}
 */
export function analyzeUserRhythm(messages, { now = new Date(), since = null } = {}) {
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const explicitSince = Date.parse(String(since ?? ""));
  const cutoff = Number.isFinite(explicitSince)
    ? Math.max(explicitSince, reference.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    : reference.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const grouped = new Map();
  for (const row of validRows(messages)) {
    if (row.date.getTime() > reference.getTime() || row.date.getTime() < cutoff) continue;
    const day = `${row.date.getFullYear()}-${row.date.getMonth()}-${row.date.getDate()}`;
    const list = grouped.get(day) ?? [];
    if (list.length < MAX_ROWS_PER_DAY) list.push(row);
    grouped.set(day, list);
  }
  const rows = [...grouped.values()].flat().sort((a, b) => a.date - b.date);
  const distinctDays = grouped.size;
  if (rows.length < MIN_MESSAGES || distinctDays < MIN_DAYS) return { ready: false, count: rows.length, distinctDays, weekdayWindows: {} };

  const main = mainCluster(rows);
  const weekdayWindows = {};
  for (let day = 0; day < 7; day += 1) {
    const buckets = rows.filter((row) => row.date.getDay() === day).map((row) => bucketOf(row.date));
    if (buckets.length >= 2) weekdayWindows[day] = rangeFor(buckets);
  }

  const latest = rows.at(-1);
  const style = rows.length < MIN_STYLE_MESSAGES ? null : (() => {
    const split = Math.max(1, Math.floor(rows.length / 2));
    const previous = rows.slice(0, split).reduce((sum, row) => sum + ratioWithMarkers(row.text), 0) / split;
    const recent = rows.slice(-split).reduce((sum, row) => sum + ratioWithMarkers(row.text), 0) / split;
    const delta = recent - previous;
    return {
      markerRate: Number(recent.toFixed(3)),
      baselineRate: Number(previous.toFixed(3)),
      delta: Number(delta.toFixed(3)),
      changed: Math.abs(delta) >= 0.35,
      direction: delta <= -0.35 ? "quieter" : delta >= 0.35 ? "lighter" : "steady",
    };
  })();

  return {
    ready: rows.length >= MIN_MESSAGES && distinctDays >= MIN_DAYS,
    count: rows.length,
    distinctDays,
    usualWindow: rangeFor(main),
    weekdayWindows,
    style,
    latestAt: latest?.date.toISOString() ?? null,
    analyzedAt: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString(),
  };
}

/** 当前是否比个人通常的首个聊天时段明显晚，供主动联系层使用。 */
export function lateStartCue(messages, { now = new Date(), minDelayMinutes = 90, since = null } = {}) {
  const profile = analyzeUserRhythm(messages, { now, since });
  if (!profile.ready || !profile.usualWindow || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const today = now.toDateString();
  if (validRows(messages).some((row) => row.date.toDateString() === today)) return null;
  const expected = profile.usualWindow.min * BUCKET_MINUTES;
  const current = now.getHours() * 60 + now.getMinutes();
  if (current - expected < minDelayMinutes) return null;
  return { profile, expectedAt: clockOf(profile.usualWindow.min), lateMinutes: current - expected };
}

export function userRhythmText(messages, { now = new Date(), since = null, includeStyle = true } = {}) {
  const profile = analyzeUserRhythm(messages, { now, since });
  if (!profile.ready || !profile.usualWindow) return "";
  const lines = [
    "【她的生活节拍（弱信号）】",
    `她通常在 ${profile.usualWindow.start}～${profile.usualWindow.end} 这个时段来找伙伴；这只是从近来的聊天记录归纳出的倾向，不是固定作息。`,
  ];
  if (includeStyle && profile.style?.changed) {
    lines.push(profile.style.direction === "quieter"
      ? "她最近的语气词和轻松符号比自己的平时基线少，可能显得更安静；只能当作轻问一句的由头，不能直接判断她不高兴。"
      : "她最近的语气词和轻松符号比自己的平时基线多，可能显得更轻快；只能当作背景参考。");
  }
  lines.push("如果要提到这些变化，先用试探和留余地的说法，不要说出统计、分析或概率。");
  return lines.join("\n");
}

export { BUCKET_MINUTES, MIN_MESSAGES, MIN_DAYS, MIN_STYLE_MESSAGES };
