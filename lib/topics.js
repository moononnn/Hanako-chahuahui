/**
 * 话题本：ta脑子里"搁着"的话题。
 *
 * 由来：想被这样找上门 ——"别我说化妆、你下次就找我聊化妆"，
 * 而是"围绕着我提过的话题做展开，主动发现你想说的新话题"。
 *
 * 所以三道闸是硬的，不靠模型自觉：
 *   ① 发酵期：提过之后不马上回来说
 *   ② 回来必须带新东西（生成那边约束 + 角度账本提醒）
 *   ③ 冷却：同题材不能反复回来（但聊过的面还没用光，就能再回来）
 *
 * 这里只管"挑哪个话题、什么时候够格"这类可测的纯逻辑，不碰模型也不碰文件。
 */

export const TOPIC_KINDS = ["interest", "worry", "plan", "gossip", "want", "other"];
export const TOPIC_FRESHNESS = ["evergreen", "timely"];
export const TOPIC_STATES = ["fermenting", "ready", "used", "dropped"]; 

/** 老话题里的 gossip 默认按时效内容处理；其他类型默认常青。 */
export function normalizeFreshness(value, kind = "other") {
  if (value === "timely" || (value == null && kind === "gossip")) return "timely";
  return "evergreen";
}

/** 发酵时长（小时）区间。心事要搁久一点才显得是"忽然想起"，八卦可以快些。 */
const FERMENT_HOURS = {
  gossip: [2, 20],
  interest: [6, 48],
  want: [4, 36],
  plan: [12, 72],
  worry: [18, 96],
  other: [12, 60],
};

/** 说过之后多久内不再提同一件事。 */
const COOLDOWN_DAYS = { gossip: 10, interest: 21, want: 14, plan: 21, worry: 30, other: 21 };

const MAX_TOPICS = 60;
/** 搁太久没机会说的，就别攒了 */
const EXPIRE_DAYS = 45;

/**
 * 同一个话题最多回来几次。
 *
 * 口径（2026-09-15 定）：同一件由头可以再提，但每次得是新的延伸，
 * 不能车轱辘话。所以这里不是"说过一次就放下"，而是"聊过的面用光了才放下"。
 */
const MAX_USES_PER_TOPIC = 4;
/** 每个话题记几个聊过的延伸点（只留最近几个，够提醒"别再重复"就行）。 */
const MAX_ANGLES_PER_TOPIC = 4;
/** 一条延伸点最多记多少字（拿当次说出去的那句话当记录）。 */
const ANGLE_MAX_CHARS = 40;

export function emptyTopicBook() {
  return { topics: [], lastExtractedAt: null, extractedThroughId: null };
}

const hoursToMs = (h) => Math.round(h * 3600 * 1000);
const daysToMs = (d) => Math.round(d * 86400 * 1000);

export function fermentMsFor(kind, rnd = Math.random) {
  const [lo, hi] = FERMENT_HOURS[kind] ?? FERMENT_HOURS.other;
  return hoursToMs(lo + rnd() * (hi - lo));
}

export function cooldownMsFor(kind) {
  return daysToMs(COOLDOWN_DAYS[kind] ?? COOLDOWN_DAYS.other);
}

/** 标题比对用的规范化：去标点、去空白、小写。 */
export function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[\s，。、！？~～…,.!?·・"'"'（）()【】\[\]]+/gu, "");
}

/** 两个话题算不算同一件：标题相等，或短的被长的含住且够长。 */
export function isSameTopic(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 4 && long.includes(short);
}

export function makeTopic(raw, now = new Date()) {
  const title = String(raw?.title ?? "").trim();
  if (!title) return null;
  const kind = TOPIC_KINDS.includes(raw?.kind) ? raw.kind : "other";
  const ms = fermentMsFor(kind);
  return {
    id: `tp_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: title.slice(0, 20),
    anchor: String(raw?.anchor ?? "").trim().slice(0, 80),
    note: String(raw?.note ?? "").trim().slice(0, 200),
    kind,
    freshness: normalizeFreshness(raw?.freshness, kind),
    searchQuery: String(raw?.searchQuery ?? "").trim().slice(0, 120) || null,
    state: "fermenting",
    openedAt: now.toISOString(),
    /** 到这个点才够格回来说 */
    readyAt: new Date(now.getTime() + ms).toISOString(),
    usedAt: null,
    usedCount: 0,
    cooldownUntil: null,
    /** 用户手动补充的纠正，优先于模型原先的理解 */
    correction: String(raw?.correction ?? "").trim().slice(0, 240),
    /** 用户手动放下后保留墓碑，防止下一轮抽取立刻捞回来 */
    dismissedAt: null,
    /** 以前从哪几个面聊过这件（只留最近的几个），下次回来得换个面 */
    angles: [],
  };
}

/** 延伸点比对用的规范化：跟标题一样去标点、去空白、小写。 */
export function normalizeAngle(text) {
  return normalizeTitle(text);
}

/** 两个延伸点算不算同一个面：一串被另一串含住且够长，就算聊的是同一面。 */
export function isSameAngle(a, b) {
  const na = normalizeAngle(a);
  const nb = normalizeAngle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 6 && long.includes(short);
}

/** 盘上读回来的角度那一栏：坏的丢掉，超量的留最近的。 */
function cleanAngles(row) {
  return (Array.isArray(row?.angles) ? row.angles : [])
    .map((angle) => ({
      text: String(angle?.text ?? "").trim().slice(0, ANGLE_MAX_CHARS),
      at: angle?.at ?? null,
    }))
    .filter((angle) => angle.text)
    .slice(-MAX_ANGLES_PER_TOPIC);
}

/**
 * 这个话题以前聊过哪几个面（最近聊的在前）。
 * 准备开口时拿它提醒模型换个延伸，而不是把话题封掉。
 */
export function usedAnglesFor(topic, limit = MAX_ANGLES_PER_TOPIC) {
  const angles = Array.isArray(topic?.angles) ? topic.angles : [];
  return angles
    .map((angle) => String(angle?.text ?? "").trim())
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

export function readBook(book) {
  const base = emptyTopicBook();
  if (!book || typeof book !== "object") return base;
  const topics = Array.isArray(book.topics)
    ? book.topics.map((row) => {
        const kind = TOPIC_KINDS.includes(row?.kind) ? row.kind : "other";
        return {
          ...row,
          anchor: String(row?.anchor ?? "").trim().slice(0, 80),
          correction: String(row?.correction ?? "").trim().slice(0, 240),
          dismissedAt: row?.dismissedAt ?? null,
          kind,
          freshness: normalizeFreshness(row?.freshness, kind),
          searchQuery: String(row?.searchQuery ?? "").trim().slice(0, 120) || null,
          angles: cleanAngles(row),
        };
      })
    : [];
  return {
    topics,
    lastExtractedAt: book.lastExtractedAt ?? null,
    extractedThroughId: book.extractedThroughId ?? null,
  };
}

/** 新抽到的话题并进本子：同一件只留一条（保留更早那次，时间线才对）。 */
export function mergeTopics(book, incoming, now = new Date()) {
  const current = readBook(book);
  const topics = [...current.topics];
  let added = 0;
  let mergedCount = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const exist = topics.find((row) => isSameTopic(row.title, raw?.title));
    if (exist) {
      mergedCount += 1;
      // 补一句更具体的语境，但不覆盖原来的时间；时效性一旦被识别出来就保留。
      if (!exist.note && raw.note) exist.note = String(raw.note).trim().slice(0, 200);
      if (!exist.anchor && raw.anchor) exist.anchor = String(raw.anchor).trim().slice(0, 80);
      if (normalizeFreshness(raw.freshness, raw.kind) === "timely") exist.freshness = "timely";
      if (!exist.searchQuery && raw.searchQuery) exist.searchQuery = String(raw.searchQuery).trim().slice(0, 120);
      continue;
    }
    const topic = makeTopic(raw, now);
    if (!topic) continue;
    topics.push(topic);
    added += 1;
  }
  return { book: { ...current, topics }, added, merged: mergedCount };
}

/** 把到点的发酵话题转成 ready（不改变顺序，只是状态推进）。 */
export function advanceTopics(book, now = new Date()) {
  const current = readBook(book);
  let changed = 0;
  const topics = current.topics.map((row) => {
    if (row.state !== "fermenting") return row;
    if (!row.readyAt || Date.parse(row.readyAt) > now.getTime()) return row;
    changed += 1;
    return { ...row, state: "ready" };
  });
  return { book: { ...current, topics }, changed };
}

/** 够格回来说的话题，最该说的在前：等得越久、越靠前的越优先，但带点抖动。 */
export function readyTopics(book, now = new Date(), { rnd = Math.random, excludeId = null } = {}) {
  const current = readBook(book);
  return current.topics
    .filter((row) => row.state === "ready" && row.id !== excludeId)
    .map((row) => {
      const waited = now.getTime() - Date.parse(row.readyAt ?? row.openedAt ?? 0);
      return { topic: row, score: waited + rnd() * 6 * 3600 * 1000 };
    })
    // 新抽取的话题有具体落点时优先；旧数据仍可作为兼容性回退，避免一升级就突然没话题。
    .sort((a, b) => {
      const aConcrete = a.topic.anchor ? 1 : 0;
      const bConcrete = b.topic.anchor ? 1 : 0;
      return bConcrete - aConcrete || b.score - a.score;
    })
    .map((row) => row.topic);
}

export function pickTopic(book, now = new Date(), options) {
  return readyTopics(book, now, options)[0] ?? null;
}

/**
 * 说过一次：进冷却，并把"这次聊的是哪一面"记下来。
 *
 * @param {string} [options.angle] 这次说出去的落点（一般就用生成出来的那句话）。
 *   记它不是为了封话题，是为了下次回来时能说"这几个面聊过了，换个延伸"。
 */
/** 用户明确放下：保留墓碑，避免旧聊天再次把它抽回来。 */
export function dropTopic(book, topicId, now = new Date()) {
  const current = readBook(book);
  return {
    ...current,
    topics: current.topics.map((row) => row.id === topicId
      ? { ...row, state: "dropped", dismissedAt: now.toISOString(), cooldownUntil: null }
      : row),
  };
}

/** 用户纠正话题的人话描述，不改模型维护的排期字段。 */
export function correctTopic(book, topicId, correction) {
  const text = String(correction ?? "").trim().slice(0, 240);
  if (!text) return readBook(book);
  const current = readBook(book);
  return {
    ...current,
    topics: current.topics.map((row) => row.id === topicId ? { ...row, correction: text } : row),
  };
}

export function markTopicUsed(book, topicId, now = new Date(), { angle = "" } = {}) {
  const current = readBook(book);
  const said = String(angle ?? "").trim().slice(0, ANGLE_MAX_CHARS);
  const topics = current.topics.map((row) => {
    if (row.id !== topicId) return row;
    const angles = said
      ? [...(row.angles ?? []).filter((item) => !isSameAngle(item.text, said)), { text: said, at: now.toISOString() }]
          .slice(-MAX_ANGLES_PER_TOPIC)
      : (row.angles ?? []);
    return {
      ...row,
      state: "used",
      usedAt: now.toISOString(),
      usedCount: (row.usedCount ?? 0) + 1,
      cooldownUntil: new Date(now.getTime() + cooldownMsFor(row.kind)).toISOString(),
      angles,
    };
  });
  return { ...current, topics };
}

/**
 * 冷却是软的：到点之后可以再提，聊过的面还没用光就还有新话可说。
 * 用过且还在冷却期内的，一律不算够格。
 *
 * @param {boolean} [options.eager] 自省发现"手上总缺由头"时的修正：
 *   冷却过了一半就先把话题放回来，别让本子看着满、实际一个能用的都没有。
 */
export function refreshUsedTopics(book, now = new Date(), { eager = false } = {}) {
  const current = readBook(book);
  const nowMs = now.getTime();
  const topics = current.topics.map((row) => {
    if (row.state !== "used") return row;
    const until = Date.parse(row.cooldownUntil ?? 0);
    const gate = eager && Number.isFinite(until) ? until - cooldownMsFor(row.kind) / 2 : until;
    if (!gate || gate > nowMs) return row;
    // 聊过的面用光了就放下；还有没聊过的面，就重新发酵一轮再回来
    if ((row.usedCount ?? 0) >= MAX_USES_PER_TOPIC) return { ...row, state: "dropped" };
    return {
      ...row,
      state: "fermenting",
      readyAt: new Date(nowMs + fermentMsFor(row.kind) / 2).toISOString(),
    };
  });
  return { ...current, topics };
}

/** 剪枝：过期的、用过的老账清掉，也守住总量上限。 */
export function pruneTopics(book, now = new Date(), { max = MAX_TOPICS } = {}) {
  const current = readBook(book);
  const nowMs = now.getTime();
  const kept = current.topics.filter((row) => {
    if (row.state === "dropped" && !row.dismissedAt) return false;
    const born = Date.parse(row.openedAt ?? 0);
    if (born && nowMs - born > daysToMs(EXPIRE_DAYS)) return false;
    return true;
  });
  // 超量就丢最老的（未使用的先丢，因为用的那些已经进了历史）
  let topics = kept;
  if (topics.length > max) {
    const sorted = [...topics].sort((a, b) => {
      const aUsed = a.state === "used" ? 1 : 0;
      const bUsed = b.state === "used" ? 1 : 0;
      if (aUsed !== bUsed) return bUsed - aUsed;
      return String(b.openedAt).localeCompare(String(a.openedAt));
    });
    topics = sorted.slice(0, max);
  }
  return { ...current, topics };
}

/** 本子里已经有的标题，抽新话题时丢给模型避免重复。 */
export function existingTitles(book, limit = 20) {
  const current = readBook(book);
  return current.topics
    .slice(-limit)
    .map((row) => row.title);
}

// ── 抽取：拼 prompt + 洗结果（模型部分在 summarize 那层调） ──

export const TOPIC_SYSTEM = [
  "你在帮一个聊天应用整理「还没聊透的话题」。",
  "下面这段对话里，挑出对方（用户）提过、但还没展开完、以后可以接着聊的事。",
  "只挑真的值得回头说的：她的兴趣、她的难处、她的打算、她随口提的八卦、她想要的东西。",
  "每行开头的名字是说话人：标着用户名字的才是对方说的话。",
  "标着伙伴名字的那些行是伙伴自己在说。伙伴自己抛出的兴趣、想法、小物件不算对方提过的话题，哪怕它再具体、再值得再聊，也不要抽。",
  "一件事只有伙伴提过、对方没接话，就不要抽。",
  "一次最多三条。没有就输出空数组。",
  "每条必须落到具体可指认的对象、动作、款式、颜色、搭配、场景或二选一；‘留白’‘松弛感’‘有味道’‘治愈’这类抽象结论不能单独成为话题。只有抽象感受、没有具体落点时不要抽。",
  "标题写具体落点，不写大主题；例如‘蓝灰胶带搭配’可以，‘极简手帐’不行。备注里保留她的原话或语境，具体落点字段写模型从原话里看见的物件/动作/选择。",
  "备注里的话不是对话内容，不要拿它当话题。对话实在太少、没东西可抽时，就老实输出 []。",
  '严格输出 JSON 数组，每项形如 {"title":"不超过八个字的具体标题","kind":"interest|worry|plan|gossip|want|other","freshness":"evergreen|timely","searchQuery":"仅时效话题填写搜索词","anchor":"不超过三十字的具体物件、动作、款式、颜色、搭配、场景或选择","note":"一句话，她的原话或语境"}。',
  "不会很快变化的兴趣、烦恼、计划等标 evergreen；娱乐八卦、新闻、比赛、产品更新等可能有新进展的标 timely。gossip 通常标 timely。" ,
  "不要输出任何解释、不要用代码块包住。",
].join("\n");

export function topicSpec(recentMessages, knownTitles = [], renderFn) {
  const lines = renderFn ? renderFn(recentMessages) : "";
  const known = knownTitles.length
    ? `已经在册的（别重复）：\n${knownTitles.map((t) => `· ${t}`).join("\n")}`
    : "（备注：这本子还空着，你是在抽第一批）";
  // ⚠️ 备注和对话必须用显眼的界线分开。
  // 吃过一次亏：把"本子还是空的"这类说明写进 prompt 后，模型把它当成对话内容，
  // 抽出了一个叫「空白本子」的假话题。
  return {
    kind: "topics",
    systemPrompt: TOPIC_SYSTEM,
    userText: [
      "下面是两段东西，别搞混：先是一段备注（不是对话），然后才是对话原文。",
      "",
      `【备注】${known}`,
      "",
      "【对话原文开始】只从这里抽话题，备注里的字不算话题；只抽用户名字那几行里的事，伙伴名字那几行不算。",
      lines,
      "【对话原文结束】",
    ].join("\n"),
  };
}

/** 模型爱加壳，这里耐着性子把 JSON 数组抠出来。 */
export function parseTopics(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let body = text;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced) body = fenced[1].trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const title = String(row.title ?? "").trim();
    if (!title) continue;
    out.push({
      title: title.slice(0, 20),
      kind: TOPIC_KINDS.includes(row.kind) ? row.kind : "other",
      freshness: normalizeFreshness(row.freshness, TOPIC_KINDS.includes(row.kind) ? row.kind : "other"),
      searchQuery: String(row.searchQuery ?? "").trim().slice(0, 120) || null,
      anchor: String(row.anchor ?? "").trim().slice(0, 80),
      note: String(row.note ?? "").trim().slice(0, 200),
    });
    if (out.length >= 3) break;
  }
  return out;
}
