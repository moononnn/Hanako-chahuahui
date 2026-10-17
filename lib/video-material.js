/**
 * B 站视频材料：字幕身份校验与弹幕聚合。
 *
 * 这一层是纯逻辑，不发请求，可以完整单测。
 *
 * 为什么要身份校验：搬运版视频会返回**原片的字幕**，接口不报错、返回 200、
 * 内容还是通顺中文，但讲的是另一个视频的事。2026-10-16 实测踩过：
 * 一个 582 秒的木工技巧视频，拿回来的是 1299 秒的韩国 UP 讲分家和麦当劳账单的字幕。
 * 伙伴拿着这个讲给用户，就是一本正经地编。
 *
 * 为什么要聚合弹幕：热门视频单次返回可达 180 万字节，九成是「牛逼」「前摇过长」，
 * 直接进模型会炸。实测重复出现的弹幕能反映观众反复有反应的类型，
 * 但弹幕本身不带可靠时间语义，所以只当“观众反复刷的句子”用，不推断他们在哪里笑。
 */

// ── 字幕可信度 ────────────────────────────────────────────────
//
// B 站的字幕接口会**随机返回不同的结果**，同一视频连着请求，拿到的可能是完全不同的字幕。
// 2026-10-16 实测：BV1bXt9z9ESP 连续请求 4 次，player/v2 返回的字幕条数依次是
// 1 / 6 / 2 / 6 条，正文段数 235 / 223 / 1 / 223。第 3 次只给 1 段——
// 看起来是完整的 JSON，内容却只有一句话。
//
// 后果很严重：拿这种残缺字幕去讲，伙伴会讲出一个断断续续的视频，
// 而它看起来是真的。这比「完全不知道」恶劣得多。
//
// 所以判据里加了一条：**连续两次必须都成功，且同语言、同轨、全文一致。**
// 不做「凑合用」，宁可这一轮什么都不分享。
//
// 重要边界：下面所有判据都是**启发式筛查**，不是身份保证。
// 它们能降低拿着错东西讲视频的概率，不能证明字幕一定属于这条片子。

/** 把 subtitle_url 里能拿到的数字部分抽出来，仅作日志与辅助，不作主判据。 */
export function parseSubtitleId(subtitleUrl) {
  const url = String(subtitleUrl ?? "");
  const prod = /\/prod\/([0-9a-zA-Z]+)/u.exec(url);
  if (prod) return { form: "prod", token: prod[1] };
  const loose = /\/bfs\/ai_subtitle\/([0-9a-zA-Z]{32,})/u.exec(url);
  if (loose) return { form: "legacy", token: loose[1] };
  return null;
}

/**
 * 词面重合度：标题和简介里的核心词有多少在字幕里出现。
 *
 * **这是启发式，不是身份校验。** 它只能降低“拿着另一个视频的字幕讲这个视频”的概率，
 * 不能证明字幕就是这条片子的。
 *
 * 只取三字及以上的连续汉字片段：二字词（一个、这个、我们、视频）在中文口语里
 * 几乎必然出现，早先把它们也算进候选，等于任何中文字幕都能凑够命中数，闸门形同虚设。
 */
export function topicOverlap(body, video, { minWords = 2 } = {}) {
  const segs = Array.isArray(body?.body) ? body.body : [];
  if (!segs.length) return { ok: false, hits: 0, checked: 0, words: [] };
  const subtitleText = segs.map((s) => String(s.content ?? "")).join("");

  // 从标题与简介里取中文词段（连续 3 字以上的汉字串）
  const source = `${video?.title ?? ""} ${video?.tname ?? ""} ${video?.desc ?? ""}`;
  const cjkRuns = String(source).match(/[\u4e00-\u9fff]{3,}/gu) ?? [];
  const words = [];
  for (const run of cjkRuns.slice(0, 40)) {
    for (let size = 4; size >= 3; size -= 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const word = run.slice(i, i + size);
        if (!words.includes(word)) words.push(word);
      }
    }
  }
  if (!words.length) return { ok: false, hits: 0, checked: 0, words: [] };

  const hits = words.filter((w) => subtitleText.includes(w));
  return {
    ok: hits.length >= minWords,
    hits: hits.length,
    checked: words.length,
    words: hits.slice(0, 6),
  };
}

/**
 * 字幕时间轴覆盖率，与视频时长对照。
 * 实测数据：
 *   104 秒菜板 / 字幕 99.8 秒  → 96%  正常
 *   537 秒半岛铁盒 / 536 秒   → 100% 正常（这���曾被误判）
 *   582 秒木工 / 字幕 1299 秒 → 223% 明显错配
 *   1169 秒木屋 / 字幕 210 秒 → 18%  明显错配
 */
export function subtitleCoverage(body, videoDurationSec) {
  const segs = Array.isArray(body?.body) ? body.body : [];
  if (!segs.length) return { ok: false, coverage: 0, reason: "字幕没有内容" };
  const first = Number(segs[0]?.from);
  const last = Number(segs[segs.length - 1]?.to);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return { ok: false, coverage: 0, reason: "字幕时间轴无效" };
  }
  const span = last - first;
  const duration = Number(videoDurationSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, coverage: 0, reason: "视频时长未知" };
  }
  const coverage = span / duration;
  if (coverage > 1.1) return { ok: false, coverage, reason: "字幕跨度超过视频时长，疑似错配" };
  if (coverage < 0.6) return { ok: false, coverage, reason: "字幕跨度远小于视频时长，疑似不完整或错配" };
  return { ok: true, coverage, reason: "字幕跨度与视频时长吻合" };
}

/** 时间戳容差。AI 字幕的末段偶尔会溢出一点点，不为这点误差卡死整份字幕。 */
export const SUBTITLE_TIMESTAMP_TOLERANCE_SEC = 2;

/**
 * 逐条检查时间戳：有限、非负、to 大于 from、to 不超过视频时长（容少量误差）。
 * 拒绝时不回显字幕正文。
 */
export function subtitleTimestamps(body, videoDurationSec, { toleranceSec = SUBTITLE_TIMESTAMP_TOLERANCE_SEC } = {}) {
  const segs = Array.isArray(body?.body) ? body.body : [];
  if (!segs.length) return { ok: false, checked: 0, reason: "字幕没有内容" };
  const duration = Number(videoDurationSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, checked: 0, reason: "视频时长未知，无法校验时间轴" };
  }
  const limit = duration + Math.max(0, Number(toleranceSec) || 0);
  for (let i = 0; i < segs.length; i += 1) {
    const from = Number(segs[i]?.from);
    const to = Number(segs[i]?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return { ok: false, checked: segs.length, index: i, reason: `第 ${i + 1} 段的时间戳不是有效数值` };
    }
    if (from < 0 || to < 0) {
      return { ok: false, checked: segs.length, index: i, reason: `第 ${i + 1} 段的时间戳为负数` };
    }
    if (to <= from) {
      return { ok: false, checked: segs.length, index: i, reason: `第 ${i + 1} 段的结束时间不大于开始时间` };
    }
    if (to > limit) {
      return { ok: false, checked: segs.length, index: i, reason: `第 ${i + 1} 段超出了视频时长，疑似错配` };
    }
  }
  return { ok: true, checked: segs.length, reason: "逐段时间轴都在时长内" };
}

/**
 * 内容一致性：两次拿到的字幕是否逐条相同。
 * 这是对抗 B 站返回结果不稳定的关键一道。
 *
 * 比较**全部**段落的「起始时间-结束时间-正文」。早先只取头尾，中间被改写或
 * 截断时看不出来；服务端的残缺返回（同一支视频 235/223/1 段）必须一次拦住。
 */
export function subtitleFingerprint(body) {
  const segs = Array.isArray(body?.body) ? body.body : [];
  return segs
    .map((s) => `${Number(s?.from)}>${Number(s?.to)}:${String(s?.content ?? "").trim()}`)
    .join("\n");
}

/** 最小段数。低于此数的字幕视为残缺，不可用——一句字幕撑不起「这个视频讲了什么」。 */
export const MIN_SUBTITLE_SEGMENTS = 8;

/**
 * 最终判定。三道信号都要过：
 *   ① 时间轴跨度与视频吻合
 *   ② 主题词在字幕里出现（挡搬运错配）
 *   ③ 两次取到的内容一致（挡随机返回的残缺字幕）
 * 宁可这一轮什么都没找到，也不能让伙伴拿着错的东西讲这个视频。
 */
export function acceptSubtitle({ video, subtitle, body, fingerprint, referenceFingerprint }) {
  const coverage = subtitleCoverage(body, video?.duration);
  const timestamps = subtitleTimestamps(body, video?.duration);
  const overlap = topicOverlap(body, video);
  const parsed = parseSubtitleId(subtitle?.subtitle_url);
  const segs = Array.isArray(body?.body) ? body.body : [];

  const verdict = {
    coverage,
    timestamps,
    overlap,
    segmentCount: segs.length,
    subtitleId: parsed ? { form: parsed.form, tokenPrefix: parsed.token.slice(0, 12) } : null,
  };

  if (segs.length < MIN_SUBTITLE_SEGMENTS) {
    return { accepted: false, reason: `字幕只有 ${segs.length} 段，疑似接口返回的残缺内容`, ...verdict };
  }
  if (!timestamps.ok) {
    return { accepted: false, reason: timestamps.reason, ...verdict };
  }
  if (!coverage.ok) {
    return { accepted: false, reason: coverage.reason, ...verdict };
  }
  if (!overlap.ok) {
    return {
      accepted: false,
      reason: `字幕内容与视频主题对不上（仅 ${overlap.hits} 个词重合），疑似错配`,
      ...verdict,
    };
  }
  if (referenceFingerprint && fingerprint && fingerprint !== referenceFingerprint) {
    return { accepted: false, reason: "两次取到的字幕内容不一致，接口在返回不稳定结果", ...verdict };
  }
  return { accepted: true, reason: "跨度、主题、完整性都对得上", ...verdict };
}

/** 旧的导出名保留，避免调用方改名踩坑。 */
export function verifySubtitleIdentity(video, subtitle) {
  const parsed = parseSubtitleId(subtitle?.subtitle_url);
  if (!parsed) return { ok: false, form: "unknown", reason: "subtitle_url 里没有可校验的身份片段" };
  // 只报告身份信息，不作判据了：编号长度不固定，按位数拆会误杀。
  return {
    ok: null,
    form: parsed.form,
    reason: "身份字段仅供记录，不作可信度判据（编号长度不固定）",
  };
}

// ── 弹幕聚合 ───────────────────────────────────────────────────

/**
 * 解析弹幕 xml（B 站的 comment.bilibili.com/{cid}.xml）。
 * 单次上限约 1200 条，对「判断这个视频哪里好笑」已经够用。
 */
export function parseDanmakuXml(xml) {
  const text = String(xml ?? "");
  const out = [];
  const re = /<d\b[^>]*>([\s\S]*?)<\/d>/giu;
  for (const m of text.matchAll(re)) {
    const content = decodeXmlEntities(String(m[1] ?? "")).trim();
    if (content) out.push({ text: content });
  }
  return out;
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * 归一化弹幕文本，让同一句话的不同写法聚到一起。
 * 「哈哈哈哈哈」和「哈哈哈哈哈」算同一条；表情符号一律丢掉。
 */
export function normalizeDanmaku(text) {
  return String(text ?? "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/[\s　]+/gu, "")
    .replace(/[!！?？~～,，。.、;；:：\-—]+/gu, "")
    .trim();
}

/** 纯噪声：太短、纯数字、纯符号的一律不要。 */
export function isNoiseDanmaku(normalized) {
  if (!normalized) return true;
  if (normalized.length < 2) return true;
  if (/^[\d\s]+$/u.test(normalized)) return true;
  if (/^[a-zA-Z\s]+$/u.test(normalized) && normalized.length < 4) return true;
  return false;
}

/**
 * 聚合弹幕，取出「观众反复刷的那几句」——那通常就是笑点所在。
 *
 * 实测例子：
 *   「对不起总裁，刚才没有认出你」刷了 3 次 → 保留
 *   「牛逼」「前摇过长」各刷 1 次 → 丢掉
 *
 * @param {Array<{text?: string}>} rows 原始弹幕
 * @param {{minRepeat?: number, limit?: number}} options
 */
export function aggregateDanmaku(rows, { minRepeat = 3, limit = 12 } = {}) {
  const counts = new Map();
  const variants = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = String(row?.text ?? "").trim();
    if (!raw) continue;
    const norm = normalizeDanmaku(raw);
    if (isNoiseDanmaku(norm)) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
    if (!variants.has(norm)) variants.set(norm, new Set());
    if (variants.get(norm).size < 4) variants.get(norm).add(raw.slice(0, 60));
  }
  const rowsOut = [];
  for (const [norm, count] of counts) {
    if (count < minRepeat) continue;
    rowsOut.push({
      text: [...variants.get(norm)][0] || norm,
      count,
      chars: norm.length,
    });
  }
  // 先按出现次数，再按长度。次数是主信号：反复刷出来的才是笑点，
  // 不能因为句子长就排到只出现一次的前面。
  rowsOut.sort((a, b) => b.count - a.count || b.chars - a.chars || a.text.localeCompare(b.text, "zh-CN"));
  return rowsOut.slice(0, limit);
}

/** 单条弹幕文本就别浪费第二轮，直接给出这条视频的弹幕摘要文本。 */
export function formatDanmakuContext(rows, maxChars = 400) {
  const picked = aggregateDanmaku(rows);
  if (!picked.length) return "";
  const lines = ["【观众反复刷的那几句】"];
  for (const row of picked) lines.push(`· ${row.text}（${row.count} 次）`);
  lines.push("这些是观众反复刷出来的句子。弹幕本身不带可靠的时间信息，不能据此说他们在视频的哪一处笑或发愣。");
  return lines.join("\n").slice(0, maxChars);
}
