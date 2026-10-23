/**
 * 视频画面观察（visual）的纯逻辑：归一化、范围判定、来源表述。
 *
 * 为什么单独一层：画面这件事最容易说过头。一次观察里可能同时有
 * 全片稀疏采样点、一小段连续帧、和一张封面，它们能支撑的说法完全不同：
 * 稀疏点只能说"某一瞬间是怎样的"，连续段才能说"怎么变"，封面只能认出是哪条。
 *
 * 四条硬边界（写进 helper，别指望每个调用方自觉）：
 *   ① 封面不算正片；只有封面或只有一张正片帧，都不算看过视频内容。
 *   ② 没有合格的连续采样，就不许说"连续"，只许说稀疏。
 *   ③ clip 不能凭空给一段区间来冒充连续：范围内必须有贴着边界的真实采样。
 *   ④ 画面没有声音。听不见语气、语气词、配乐，这些不能靠画面编。
 */

export const MAX_VISUAL_SUMMARY_CHARS = 900;
export const MAX_VISUAL_SAMPLE_TIMES = 9;
export const MIN_VISUAL_IMAGES = 1;
export const MAX_VISUAL_IMAGES = 10;

/** 采样名义间隔 0.5 秒（每秒 2 帧），允许一点抖动。 */
export const VISUAL_SAMPLE_STEP = 0.5;
const MAX_GAP = 0.6;
const BOUND_TOL = 0.6;
const RANGE_TOL = 0.01;

/** frames = 有可用正片帧；cover-only = 只有封面或单帧。 */
export const VISUAL_SCOPES = {
  FRAMES: "frames",
  COVER_ONLY: "cover-only",
  NONE: "none",
};

/** 能不能支撑"怎么变"。 */
export const VISUAL_CONTINUITY = {
  CLIP: "clip",
  SPARSE: "sparse",
  NONE: "none",
};

function text(value, max = 200) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * 只认真正的数字。`Number(null)=0`、`Number(true)=1`、`Number("")=0` 这些坑
 * 会把"没给"读成"给了 0 秒"，所以类型先卡住，再做范围判断。
 */
function strictNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * clip 能不能声称"这一段连续"。
 * 范围内至少有 2 个真实采样；相邻间隔不超过一个采样步长加抖动；
 * 首末采样必须贴着 clip 的两端，否则就是拿一段区间给几张散图背书。
 */
function validateClip(rawClip, times) {
  if (!rawClip || typeof rawClip !== "object") return null;
  const from = strictNumber(rawClip.from);
  const to = strictNumber(rawClip.to);
  if (from === null || to === null || from < 0 || to <= from) return null;
  const inRange = times.filter((t) => t >= from - RANGE_TOL && t <= to + RANGE_TOL);
  if (inRange.length < 2) return null;
  for (let i = 1; i < inRange.length; i += 1) {
    if (inRange[i] - inRange[i - 1] > MAX_GAP) return null;
  }
  if (Math.abs(inRange[0] - from) > BOUND_TOL) return null;
  if (Math.abs(inRange[inRange.length - 1] - to) > BOUND_TOL) return null;
  return { from: round3(from), to: round3(to), times: inRange };
}

/**
 * 归一化一条画面观察。
 *
 * 必填：status 是 ok、summary 非空（超 900 字截断留痕，不整条丢）、model 双字段、
 * observedAt 可解析、imageCount 1~10 的整数。
 * 张数要对得上：正片帧数（imageCount 减去封面那一张）必须等于采样时刻个数，
 * 因为一个时刻对应一张帧；对不上说明记录本身是拼的。
 * sampleTimes 排序去重后比对，重复时间会被数量校验挡下；null/布尔/空串一律拒。
 */
export function normalizeVideoVisual(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (String(raw.status ?? "") !== "ok") return null;

  const summaryRaw = text(raw.summary, 20_000);
  if (!summaryRaw) return null;
  // 二次归一化时不能再凭长度判断，被截过的必须保留痕迹。
  const truncated = raw.summaryTruncated === true || summaryRaw.length > MAX_VISUAL_SUMMARY_CHARS;
  const summary = summaryRaw.length > MAX_VISUAL_SUMMARY_CHARS
    ? summaryRaw.slice(0, MAX_VISUAL_SUMMARY_CHARS)
    : summaryRaw;

  const provider = text(raw.model?.provider, 80);
  const model = text(raw.model?.model, 80);
  if (!provider || !model) return null;

  const imageCount = strictNumber(raw.imageCount);
  if (imageCount === null || !Number.isInteger(imageCount)
    || imageCount < MIN_VISUAL_IMAGES || imageCount > MAX_VISUAL_IMAGES) return null;

  const coverSeen = raw.coverSeen === true;

  const rawTimes = Array.isArray(raw.sampleTimes) ? raw.sampleTimes : [];
  if (rawTimes.length > MAX_VISUAL_SAMPLE_TIMES) return null;
  const parsedTimes = [];
  for (const row of rawTimes) {
    const value = strictNumber(row);
    if (value === null || value < 0) return null;
    parsedTimes.push(round3(value));
  }
  const times = [...new Set(parsedTimes)].sort((a, b) => a - b);
  const visibleFrames = imageCount - (coverSeen ? 1 : 0);
  if (visibleFrames < 0 || times.length !== visibleFrames) return null;

  const clip = validateClip(raw.clip, times);

  const observedAt = isoOrNull(raw.observedAt);
  if (!observedAt) return null;

  const clipTimes = clip ? clip.times : [];
  return {
    status: "ok",
    summary,
    summaryTruncated: truncated,
    model: { provider, model },
    imageCount,
    coverSeen,
    sampleTimes: times,
    clip: clip ? { from: clip.from, to: clip.to } : null,
    observedAt,
    // 下面两项是派生量，随归一化一起固定下来，下游不用再算一遍。
    visibleFrames,
    clipTimes,
  };
}

/**
 * 这条 visual 到底够不够当"看过一点画面"。
 *
 * 单张不放行（一张封面或一帧静图撑不起视频内容）；
 * 至少两个不同的有效正片时间点才算，且必须有至少两张正片帧。
 * clip 合格就记为连续，不合格就老实记成稀疏，不许嘴上说连续。
 */
export function visualScope(raw) {
  const visual = normalizeVideoVisual(raw);
  if (!visual) {
    return { scope: VISUAL_SCOPES.NONE, continuity: VISUAL_CONTINUITY.NONE, frameCount: 0, distinctTimes: [], clipTimes: [] };
  }
  const usable = visual.visibleFrames >= 2 && visual.sampleTimes.length >= 2;
  const clipTimes = visual.clipTimes;
  const continuity = visual.clip
    ? VISUAL_CONTINUITY.CLIP
    : usable ? VISUAL_CONTINUITY.SPARSE : VISUAL_CONTINUITY.NONE;
  return {
    scope: usable ? VISUAL_SCOPES.FRAMES : VISUAL_SCOPES.COVER_ONLY,
    continuity,
    frameCount: visual.visibleFrames,
    imageCount: visual.imageCount,
    coverSeen: visual.coverSeen,
    distinctTimes: visual.sampleTimes,
    clipTimes,
    clip: visual.clip,
    sparseTimes: visual.clip
      ? visual.sampleTimes.filter((t) => !clipTimes.includes(t))
      : [...visual.sampleTimes],
    model: visual.model,
    observedAt: visual.observedAt,
  };
}

/** 能不能当画面材料用。只有 frames 这一档算。 */
export function isUsableVideoVisual(raw) {
  return visualScope(raw).scope === VISUAL_SCOPES.FRAMES;
}

/** 范围的汉语说法。材料、认知、回忆、成文四处共用这一套措辞。 */
export function videoVisualScopeText(raw) {
  const scope = visualScope(raw);
  if (scope.scope === VISUAL_SCOPES.COVER_ONLY) return "只有一张封面或单帧，不算看过正片";
  if (scope.scope !== VISUAL_SCOPES.FRAMES) return "";
  const parts = [`全片 ${scope.distinctTimes.length} 个时间点的取样`];
  if (scope.clip) {
    parts.push(`其中第 ${scope.clip.from} 秒到第 ${scope.clip.to} 秒是局部连续画面（${scope.clipTimes.length} 张）`);
  } else {
    parts.push("没有连续片段，只有单张画面");
  }
  if (scope.coverSeen) parts.push("另有一张封面，只够认出是哪条片子");
  return `看过${parts.join("，")}；没有完整看过整片`;
}

/**
 * 材料头里的画面纪律。这些是硬约束，放头部，不参与预算裁剪。
 */
export function videoVisualDiscipline(raw) {
  const scope = visualScope(raw);
  if (scope.scope === VISUAL_SCOPES.COVER_ONLY) {
    return ["【这次只有一张封面】", "封面只够认出是哪条片子，不是视频里发生的事，别拿它当看过正片。"];
  }
  if (scope.scope !== VISUAL_SCOPES.FRAMES) return [];
  const lines = ["【画面上你确实看到的那部分】"];
  lines.push(`看过的是全片 ${scope.distinctTimes.length} 个时间点的取样，不是整片：没覆盖的地方不要补，也不要拿字幕或标题去补画面。`);
  if (scope.clip) {
    lines.push(`其中第 ${scope.clip.from} 秒到第 ${scope.clip.to} 秒是连续画面（${scope.clipTimes.length} 张），这一段可以讲怎么变；这段之外只有单张画面，别推断中间过程。`);
  } else {
    lines.push("只有单张画面，没有连续片段：可以说某一瞬间是什么样，别推断中间怎么变、别描述动作过程。");
  }
  lines.push("画面没有声音：语气、语气词、配乐你都听不见，别替它描述声音。");
  if (scope.coverSeen) lines.push("另有一张封面，只用来认出是哪条，不当正片内容。");
  return lines;
}

/** 认知/回忆里的来源句。必须是当时真实读到的那一档，不能倒推成整片。 */
export function videoVisualSourceSentence(raw, readKind = "") {
  const scope = visualScope(raw);
  const kind = String(readKind ?? "");
  if (scope.scope === VISUAL_SCOPES.FRAMES) {
    const seen = scope.clip
      ? `看过全片 ${scope.distinctTimes.length} 个时间点的画面，其中 ${scope.clip.from} 到 ${scope.clip.to} 秒是局部连续画面（${scope.clipTimes.length} 张），未完整看过`
      : `看过全片 ${scope.distinctTimes.length} 个时间点的单张画面，未完整看过`;
    if (kind === "subtitle") return `读到字幕资料，也${seen}`;
    if (kind === "danmaku") return `只翻到标题和弹幕，另外${seen}，没读字幕`;
    return `没读字幕，只${seen}`;
  }
  if (kind === "subtitle") return "仅读到字幕资料，未看画面";
  if (kind === "danmaku") return "只翻到标题和弹幕，没读字幕也没看画面";
  return "只知道标题，没读内容";
}

/** 回忆块用的口径：只拦描述画面，不要求主动声明。字幕档保持原来的说法。 */
export function videoVisualRecallBoundary(raw, readKind = "") {
  const scope = visualScope(raw);
  if (scope.scope === VISUAL_SCOPES.FRAMES) {
    const clip = scope.clip ? `，其中 ${scope.clip.from} 到 ${scope.clip.to} 秒是局部连续（${scope.clipTimes.length} 张）` : "，都是单张画面";
    const withSubtitle = String(readKind) === "subtitle" ? "，也读过字幕" : "";
    return `看过全片 ${scope.distinctTimes.length} 个时间点的画面${clip}${withSubtitle}，不是整片，没覆盖的地方不能补`;
  }
  if (String(readKind) === "subtitle") return "只读到字幕资料，没有看视频画面";
  if (String(readKind) === "danmaku") return "只看到标题和弹幕，没读字幕也没看画面";
  return "只知道标题";
}

/** 成文里那一句：告诉伙伴这次能说到哪。不可用时返回空串，调用方走旧口径。 */
export function videoVisualComposeLine(raw) {
  const scope = visualScope(raw);
  if (scope.scope !== VISUAL_SCOPES.FRAMES) return "";
  const range = scope.clip
    ? `其中第 ${scope.clip.from} 秒到第 ${scope.clip.to} 秒是局部连续的一段（${scope.clipTimes.length} 张），这一段可以讲怎么变`
    : "全片只有几个时间点的单张画面，没有连续片段，只能讲某一瞬间的样子";
  return `这次你确实看过一些画面：${range}；没覆盖的地方不要补，也不把封面当成正片；画面没有声音，语气、语气词和配乐你都听不见，别替它描述。`;
}
