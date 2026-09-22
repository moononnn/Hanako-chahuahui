import { resolveRelationalPolicy } from "./plasticity.js";

/**
 * 主动那层的纯逻辑：什么时候够格、够格了发什么、不够格怎么办。
 *
 * 定死的几条硬规矩（写在这里，不交给模型发挥）：
 *   · 不是定时器响 —— 落点在区间里随机，事先不定
 *   · 带话的心意必须有由头，没由头就不发
 *   · 静默时段和伙伴作息都算睡觉：睡着时不主动发，醒着才联系
 *   · 时机不合适就只记下"想找你"，不硬发
 *
 * 这里不碰模型、不碰文件，全是可测的判定。
 */

const MIN = 60 * 1000;
const WAKE_ECHO_MAX_AGE_MS = 8 * 60 * MIN;
const SLEEPY_ECHO_RE = /困|睡会|睡一觉|回笼觉|眯一会|眯会儿|先睡|再睡|脑壳还在加载/iu;

/** 档位表。数字是起点，体感说了算。 */
export const TIER_PLANS = {
  rare: { label: "很少找我", minMs: 240 * MIN, maxMs: 360 * MIN, dailyMax: 2, pokeChance: 0 },
  sometimes: { label: "偶尔聊聊就好", minMs: 120 * MIN, maxMs: 180 * MIN, dailyMax: 4, pokeChance: 0 },
  often: { label: "经常来找我", minMs: 60 * MIN, maxMs: 120 * MIN, dailyMax: 6, pokeChance: 0.25 },
  clingy: { label: "很黏人", minMs: 30 * MIN, maxMs: 60 * MIN, dailyMax: 12, pokeChance: 0.5 },
};

export const DEFAULT_QUIET = { start: "23:00", end: "08:00" };
export const DEFAULT_GLOBAL_GATE = { minGapMinutes: 30, maxPerDay: 24 };
/** 设置页「一天最多收到几条」的三档，跟 ui/settings.html 保持一份。 */
export const GATE_MAX_CHOICES = [12, 24, 30];

/**
 * 老数据里可能存着已经下架的档位（比如 20），挪到最近的一档。
 * 20 会落到 24；认不出来的值（空/NaN）回默认档。
 */
export function normalizeGateMax(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_GLOBAL_GATE.maxPerDay;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GLOBAL_GATE.maxPerDay;
  if (GATE_MAX_CHOICES.includes(n)) return n;
  return GATE_MAX_CHOICES.reduce(
    (best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best),
    GATE_MAX_CHOICES[0],
  );
}
/** 暂存意图最多留多久（过了就作废，不硬塞） */
export const INTENT_TTL_MS = 24 * 60 * MIN;
/** 每个伙伴最多同时搁几条“想找你” */
export const MAX_STAGED_INTENTS = 2;

// ── 说法去重（车轱辘话兑底）─────────────────────────────
// 口径（2026-09-15 定）：同一个由头可以再提，但每次得是新的延伸。
// 拦的不是话题，是“换了说法说同一句话”。计划那一侧靠话题本的角度账本，
// 这一层是出口兑底：模型没照做的时候，别把同一句话再发一遍。

/** 这么久以内发过的主动消息，才拿来跟新写的比。 */
export const PHRASING_WINDOW_MS = 6 * 3600 * 1000;
/** 相似到这个程度就算车轱辘话，不发了。 */
export const PHRASING_THRESHOLD = 0.86;

/** 归一：去标点空白、小写。 */
export function normalizePhrasing(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s，。、！？~～…,.!?·・"'“”‘’（）()【】\[\]]+/gu, "");
}

/** 最长公共子序列长度（一维滚动，文本短，够了）。 */
function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = keep;
    }
  }
  return row[b.length];
}

/**
 * 两句像不像（0~1）。口径跟 difflib 的 ratio 一路：2×公共部分÷总长。
 * 中文按字算就行，不用分词；两句都短，算得起。
 */
export function textSimilarity(a, b) {
  const na = normalizePhrasing(a);
  const nb = normalizePhrasing(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const total = na.length + nb.length;
  return total > 0 ? (2 * lcsLength(na, nb)) / total : 0;
}

/**
 * 新写的这条，是不是在跟最近发过的某条重念一遍。
 *
 * @param {Array<{at: number|string, text: string}>} history 最近的主动消息（新的在后也行）
 * @returns {{repeated: boolean, score: number}}
 */
export function isRepeatedPhrasing(history, text, {
  now = Date.now(),
  windowMs = PHRASING_WINDOW_MS,
  threshold = PHRASING_THRESHOLD,
} = {}) {
  if (!normalizePhrasing(text)) return { repeated: false, score: 0 };
  let best = 0;
  for (const row of Array.isArray(history) ? history : []) {
    const at = typeof row?.at === "number" ? row.at : Date.parse(row?.at ?? "");
    if (!Number.isFinite(at) || now - at >= windowMs) continue;
    const score = textSimilarity(text, row?.text);
    if (score > best) best = score;
    if (score >= threshold) return { repeated: true, score };
  }
  return { repeated: false, score: best };
}

export function planFor(tier) {
  return TIER_PLANS[tier] ?? TIER_PLANS.sometimes;
}

const parseTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
};

/** 现在落在 start~end 这个窗口里吗？支持跨零点。 */
export function inWindow(now, window) {
  const start = parseTime(window?.start);
  const end = parseTime(window?.end);
  if (start == null || end == null || start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * 这个窗口是从哪天开始的（跨零点的窗口要往前一天算）。
 * 用来给"今晚最多一条破例"计数。
 */
export function windowStartDate(now, window) {
  const start = parseTime(window?.start);
  const end = parseTime(window?.end);
  if (start == null || end == null) return null;
  const d = new Date(now.getTime());
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (start > end && minutes < end) d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 全局静默时段、以及伙伴自己的作息，任意一个命中就算在睡。
 *
 * 第三个参数可以是一个窗（`{start,end}`），也可以是一串窗——伙伴那边现在有主睡和午觉两条，
 * 而且每天时长会浮动，所以调用方算好当天的窗户再递进来（见 sleep.js 的 sleepWindows）。
 */
export function quietNow(now, quiet = DEFAULT_QUIET, sleep = null) {
  const extra = Array.isArray(sleep) ? sleep : sleep ? [sleep] : [];
  const windows = [quiet, ...extra].filter((w) => w && w.start && w.end);
  const hit = windows.find((w) => inWindow(now, w));
  return hit ? { sleeping: true, window: hit, night: windowStartDate(now, hit) } : { sleeping: false, night: null };
}

/** 下一次"可能想找你"的落点：区间里随机，不是固定周期。 */
export function rollIntervalMs(tier, rnd = Math.random) {
  const plan = planFor(tier);
  return Math.round(plan.minMs + rnd() * Math.max(0, plan.maxMs - plan.minMs));
}

export function scheduleNext(now, tier, rnd = Math.random) {
  return new Date(now.getTime() + rollIntervalMs(tier, rnd)).toISOString();
}

/** 主动联系和等回音共用的一份关系策略；这里只动软间隔，不碰设置与硬门禁。 */
export function resolveProactivePolicy({ guides = [], userGuides = [], partnerGuides = [], relationship = null, personality = null, context = {}, runtime = {}, now = new Date() } = {}) {
  const resolved = resolveRelationalPolicy({
    capability: "proactive.frequency",
    baseline: { intervalFactor: 1 },
    guides,
    userGuides,
    partnerGuides,
    relationship,
    personality,
    context,
    runtime,
    now,
    adapter: {
      applyPreference: (effective, direction) => ({ ...effective, intervalFactor: direction > 0 ? 0.75 : direction < 0 ? 1.5 : 1 }),
    },
  });
  return { ...resolved, intervalFactor: resolved.allowed === false ? 1 : Number(resolved.effective?.intervalFactor ?? 1) };
}

export function applyProactiveInterval(delayMs, policy = null) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const factor = Math.max(0.5, Math.min(2, Number(policy?.intervalFactor ?? 1) || 1));
  return Math.round(delay * factor);
}

export function dailyKey(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function countOn(counter, day) {
  if (!counter || counter.day !== day) return 0;
  return Number(counter.count ?? 0) || 0;
}

/**
 * 综合门禁。返回 ok=false 时 reason 说明被谁拦下的（诊断用）。
 *
 * @param {object} input
 * @param {Date} input.now
 * @param {object} input.settings       这位伙伴的设置（tier/proactiveEnabled/sleep）
 * @param {object} input.globalSettings 全局（quiet/globalGate）
 * @param {object} input.state          这位伙伴的主动状态（lastSentAt/sentToday/exceptionNight/exceptionCount）
 * @param {object} input.globalState    全局的（lastAnySentAt/sentToday）
 */
export function gateCheck({ now, settings, globalSettings, state = {}, globalState = {}, relationalPolicy = null }) {
  if (settings?.proactiveEnabled === false) return { ok: false, reason: "turned-off" };

  const plan = planFor(settings?.tier);
  const day = dailyKey(now);
  const quiet = globalSettings?.quiet ?? DEFAULT_QUIET;
  const gate = { ...DEFAULT_GLOBAL_GATE, ...(globalSettings?.globalGate ?? {}) };

  // ta自己今天说了多少
  if (countOn(state.sentToday, day) >= plan.dailyMax) return { ok: false, reason: "tier-daily-max" };
  // 全部加起来的日上限
  if (countOn(globalState.sentToday, day) >= gate.maxPerDay) return { ok: false, reason: "global-daily-max" };

  // 相邻两条至少隔多久（跨伙伴）
  const lastAny = Date.parse(globalState.lastAnySentAt ?? "") || 0;
  const gapMs = Math.max(1, Number(gate.minGapMinutes) || 0) * MIN;
  if (lastAny && now.getTime() - lastAny < gapMs) return { ok: false, reason: "global-gap" };

  // 睡着时不主动开口。睡眠是连续场景，不能一边睡一边主动发普通话题。
  const sleep = quietNow(now, quiet, settings?.sleep);
  if (sleep.sleeping) return { ok: false, reason: "quiet" };
  if (relationalPolicy?.allowed === false) return { ok: false, reason: "relationship-denied" };

  return { ok: true, exception: false, reason: "open" };
}

/** 由头和形式：优先带话；有自己的真实素材时也允许主动说一点。 */
/** 连续未回应时的退避倍率，沉默因素最多放大到 4 倍。 */
export function proactiveDelayFactor(silenceCount) {
  return 1 + Math.min(3, Math.max(0, Number(silenceCount) || 0));
}

export function decideForm({ topic, selfSource = false, tier, rnd = Math.random }) {
  if (topic) return { form: "word", topic };
  // 自己有可用底子时，偶尔从自身状态/兴趣开口；没有底子仍不凭空编话题。
  if (selfSource && rnd() < 0.35) return { form: "word", topic: null };
  const plan = planFor(tier);
  if (plan.pokeChance > 0 && rnd() < plan.pokeChance) return { form: "poke", topic: null };
  return { form: "none", topic: null };
}

/**
 * 找出最近一串“主动发出后还没被用户接住”的消息。
 * 主动联系下一轮要先感知这件事，不能把沉默当成继续播同一话题的许可。
 */
/** 找最近一轮完整的面对面对话，给主动消息垫一层过渡语境。 */
export function recentSceneFor(messages, { now = Date.now(), maxAgeMs = 12 * 60 * MIN } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastProactive = rows.reduce((index, row, current) => row?.role === "assistant" && row?.proactive === true ? current : index, -1);
  const usable = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => index > lastProactive && row && (row.role === "user" || (row.role === "assistant" && !row.proactive && row.kind !== "action" && row.kind !== "poke")));
  const reply = usable.at(-1);
  const user = usable.at(-2);
  if (!reply || reply.row.role !== "assistant" || !user || user.row.role !== "user") return null;
  const at = Date.parse(reply.row.at ?? "");
  if (!Number.isFinite(at) || now - at < 0 || now - at > maxAgeMs) return null;
  const userText = String(user.row.text ?? "").trim();
  const assistantText = String(reply.row.text ?? "").trim();
  if (!userText || !assistantText) return null;
  return { userText, assistantText, at: reply.row.at };
}

/** 找一条最近的“我还困着/再睡会”状态，供醒来后的第一次主动联系回声。 */
export function wakeEchoFor(messages, { now = Date.now(), consumedId = null, maxAgeMs = WAKE_ECHO_MAX_AGE_MS } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    // 用户、主动消息和动作都表示场景已经往前走了，不能穿过去捡旧困意。
    if (row.role === "user" || row.proactive || row.kind === "action" || row.kind === "poke") return null;
    if (row.role !== "assistant") continue;
    const at = Date.parse(row.at ?? "");
    if (!Number.isFinite(at) || now - at < 0 || now - at > maxAgeMs) return null;
    if (row.id === consumedId) return null;
    if (!SLEEPY_ECHO_RE.test(String(row.text ?? ""))) return null;
    return { sourceId: String(row.id ?? ""), sourceText: String(row.text ?? "").trim(), at: row.at };
  }
  return null;
}

/** 用户紧接着回复伙伴主动消息时，沿用伙伴已经醒着的场景。 */
export function isDirectReplyToProactive(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const last = rows[rows.length - 1];
  return Boolean(last?.role === "assistant" && last?.proactive === true);
}

export function proactiveSilenceContext(messages, { readThroughId = null, readThroughAt = null, now = Date.now() } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const rows = source.filter((row) => row && (row.role === "user" || (row.kind !== "action" && row.kind !== "poke"))) ;
  let lastUser = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const tail = rows.slice(lastUser + 1);
  if (!tail.length || tail[tail.length - 1]?.proactive !== true) return null;
  const proactive = [];
  for (let i = tail.length - 1; i >= 0 && tail[i]?.proactive === true; i -= 1) {
    proactive.unshift(tail[i]);
  }
  const last = proactive[proactive.length - 1];
  const readIndex = readThroughId ? source.findIndex((row) => row?.id === readThroughId) : -1;
  const lastIndex = last ? source.indexOf(last) : -1;
  const read = readIndex >= 0 && lastIndex >= 0 && lastIndex <= readIndex;
  // 「读过」还要带上「多久前读的」：刚看到和看了半天没理，是两种处境。
  const parsed = read && readThroughAt ? Date.parse(readThroughAt) : NaN;
  const readAgeMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  return {
    count: proactive.length,
    last,
    read,
    readAt: read ? (readThroughAt ?? null) : null,
    readAgeMs,
    previousText: String(last?.text ?? "").trim(),
    previousTopicId: last?.topicId ?? null,
  };
}

/** 该不该现在动手：到点了才动手，没到点不打扰。 */
export function dueNow(state, now) {
  const due = Date.parse(state?.nextDueAt ?? "") || 0;
  return due === 0 || now.getTime() >= due;
}

/** 把一条"想找你"记进暂存（过了 TTL 或满了就丢最老的）。 */
export function stageIntent(state, intent, now = new Date()) {
  const kept = (state?.staged ?? []).filter(
    (row) => now.getTime() - Date.parse(row.at ?? 0) < INTENT_TTL_MS,
  );
  kept.push(intent);
  return kept.slice(-MAX_STAGED_INTENTS);
}

/** 暂存里还有活着的意图吗（最老的那个先兑现）。 */
export function takeIntent(state, now = new Date()) {
  const alive = (state?.staged ?? []).filter(
    (row) => now.getTime() - Date.parse(row.at ?? 0) < INTENT_TTL_MS,
  );
  if (alive.length === 0) return { intent: null, rest: [] };
  return { intent: alive[0], rest: alive.slice(1) };
}

/** 记一次成功送出（这位 + 全局各记一笔）。 */
export function noteSent(
  { state = {}, globalState = {}, now = new Date() },
  { exception = false, quiet = DEFAULT_QUIET } = {},
) {
  const day = dailyKey(now);
  const bump = (counter) =>
    counter?.day === day ? { day, count: Number(counter.count ?? 0) + 1 } : { day, count: 1 };
  const nextState = {
    ...state,
    lastSentAt: now.toISOString(),
    sentToday: bump(state.sentToday),
  };
  if (exception) {
    // 破例计数按"今晚"算，所以要拿真正在用的静默时段来算窗口起始日
    const night = windowStartDate(now, quiet ?? DEFAULT_QUIET);
    nextState.exceptionNight = night;
    nextState.exceptionCount = state.exceptionNight === night ? Number(state.exceptionCount ?? 0) + 1 : 1;
  }
  return {
    state: nextState,
    globalState: { ...globalState, lastAnySentAt: now.toISOString(), sentToday: bump(globalState.sentToday) },
  };
}

/** 记一次"想找你但时机不对"。 */
export function noteSkipped(state = {}, now = new Date()) {
  return { ...state, lastSkippedAt: now.toISOString() };
}
