/**
 * 「跟我聊着捏」：对谈式捏人，从一句轮廓聊出一份能演的画像。
 *
 * 2026-10-04 起。旁边两条路各有各的毛病：
 *   · 自动分析（analyze.js）她交材料、模型出成稿，中间插不上手；
 *   · 「认识 ta」（recognition.js）七道题的骨架是死的，追问绕着题转，不跟她的构思走。
 * 这一条补中间那一截：她起个头，模型按画像标准自己判断还差什么、下一个该问什么，
 * 一边问一边把她说的话翻成「什么情况 → 怎么做」，实时摆出来给她看。
 *
 * 有一条方法论上的分别要写在这儿，改提示词前先看一眼：
 * 自动分析那条路**禁止形容词**（写进画像就是油腻标签），但这一条不行——
 * 她口述的轮廓十有八九就是形容词。所以这里的规矩是：形容词当追问的起点，
 * 既不能原样抄进画像，也不能当废话丢掉。翻译过程要当着她的面做完。
 *
 * 三条纪律（跟 persona-review 一致）：
 *   · 协商期不落画像，只有点「成型」才写 palette；
 *   · 每轮动的都是同一份草稿，草稿过 normalizePalette 收口，撑不破封顶；
 *   · 会话存盘断了能续，过期就明说失效，不假装续成新的一场。
 *
 * 纯逻辑：不碰文件、不碰模型。落盘在 store.js，调模型在 index.js。
 */

import {
  MAX_COLOR_NAME,
  MAX_DERIVATIVE,
  MAX_PORTRAIT,
  MAX_PORTRAIT_ROWS,
  MAX_PORTRAIT_TITLE,
  ROLE_LABELS,
  colorsInOrder,
  emptyPalette,
  normalizePalette,
} from "./palette.js";

/** 一场对谈活多久。过期就明说失效，不假装还能接着聊。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 对话轮数上限。到顶了还能聊，只是最早那几轮不再进提示词（原始记录留着）。 */
export const MAX_TURNS = 60;
/** 一次往返最多往前带几轮给模型看。再多会盖过草稿本身。 */
export const PROMPT_TURNS = 12;
/** 她一句话最多多长。 */
export const MAX_SAY = 800;
/** 她起头那句最多多长（这句一直带着，不给它无限膨胀）。 */
export const MAX_INTENT = 400;
/** 一句追问最多多长。捏人是聊天，不是写小作文。 */
export const MAX_REPLY = 220;

/** 色只有这三个位置，跟 palette 的位置一一对应。 */
export const CO_ROLES = Object.freeze(["base", "main", "accent"]);
/** 每个位置最多几个色，跟 palette 的 ROLE_LIMIT 是同一把尺，这里只用来写提示词。 */
export const CO_ROLE_GUIDE = Object.freeze({ base: "底色一个", main: "主色调一到两个", accent: "点缀零到两个" });

const text = (value, limit) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
const iso = (value, fallback = null) => {
  if (value === null || value === undefined || value === "") return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
};
const nowIso = () => new Date().toISOString();

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyCoCreate(agentId) {
  const at = nowIso();
  return {
    agentId: String(agentId ?? "").trim(),
    intent: "",
    turns: [],
    draft: emptyPalette(),
    done: false,
    startedAt: at,
    updatedAt: at,
    committedAt: null,
  };
}

/**
 * 归一化。老会话、手改过的文件、模型乱塞的东西，都从这儿过一遍。
 * 认不出 agentId 就原样返回一个空的（上层拿这个当场拒绝，别拿它继续跑）。
 */
export function normalizeCoCreate(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const turns = (Array.isArray(source.turns) ? source.turns : [])
    .map((row) => {
      const body = text(row?.text, MAX_SAY);
      if (!body) return null;
      return {
        role: row?.role === "model" ? "model" : "user",
        text: body,
        at: iso(row?.at, null),
      };
    })
    .filter(Boolean)
    .slice(-MAX_TURNS);
  const startedAt = iso(source.startedAt, iso(now, nowIso()));
  return {
    agentId: String(source.agentId ?? "").trim(),
    intent: text(source.intent, MAX_INTENT),
    turns,
    draft: normalizePalette(source.draft),
    done: source.done === true,
    startedAt,
    updatedAt: iso(source.updatedAt, startedAt),
    committedAt: iso(source.committedAt, null),
  };
}

/** 这一场是不是放太久了。 */
export function coCreateExpired(session, now = Date.now()) {
  const state = normalizeCoCreate(session);
  const at = Date.parse(state.updatedAt);
  return Number.isFinite(at) ? now - at > SESSION_TTL_MS : false;
}

/** 追加一轮。到了上限就从前头丢，只丢对话，intent 和她最新的那几轮一定留着。 */
export function appendTurn(session, role, body, at = new Date()) {
  const state = normalizeCoCreate(session);
  const value = text(body, MAX_SAY);
  if (!value) return state;
  const turns = [...state.turns, { role: role === "model" ? "model" : "user", text: value, at: iso(at, nowIso()) }];
  return { ...state, turns: turns.slice(-MAX_TURNS), updatedAt: iso(at, nowIso()) };
}

/** 她起头那句。只认第一句她说的话，之后再改主意不算改这一句。 */
export function withIntent(session, body) {
  const state = normalizeCoCreate(session);
  if (state.intent) return state;
  return { ...state, intent: text(body, MAX_INTENT) };
}

/** 落上这一轮生成出来的草稿和状态。 */
export function applyTurn(session, { draft, done }, at = new Date()) {
  const state = normalizeCoCreate(session);
  return {
    ...state,
    draft: draft === undefined ? state.draft : normalizePalette(draft),
    done: done === undefined ? state.done : done === true,
    updatedAt: iso(at, nowIso()),
  };
}

// ── 草稿的呈现与缺口 ────────────────────────────────────────

/**
 * 当前草稿给人看的样子。界面上那条实时画像和进提示词的「已经长出来的部分」共用它，
 * 免得同一份东西两处写两遍、慢慢就对不上了。
 */
export function renderDraftBrief(raw) {
  const palette = normalizePalette(raw);
  if (!palette.colors.length && !palette.portrait.length) return "（还什么都没有）";
  const lines = [];
  for (const color of colorsInOrder(palette)) {
    const rows = palette.derivatives
      .filter((row) => row.colorId === color.id && row.on)
      .map((row) => row.text);
    lines.push(`${ROLE_LABELS[color.role]}「${color.name}」：${rows.length ? rows.join(" ／ ") : "（还没有行为）"}`);
  }
  if (palette.portrait.length) {
    lines.push(`自画像：${palette.portrait.map((row) => `${row.title}：${row.text}`).join(" ／ ")}`);
  }
  return lines.join("\n");
}

/**
 * 还差什么。机械能判的都在这里判，判不了的不猜。
 *
 * 只列能问出东西来的缺口：没有底色、某个色空挂着没行为、色有了行为太单薄、自画像还空着。
 * 「点缀」是可选项，不列进缺口——把可选项写成待办，会逼着她把画像填满，那是另一头的问题。
 */
export function draftGaps(raw) {
  const palette = normalizePalette(raw);
  const gaps = [];
  if (!palette.colors.length) {
    return ["这个人还没起色：先问她大概是个什么样的人"];
  }
  if (!palette.colors.some((row) => row.role === "base")) {
    gaps.push("底色还没定：最深的那层基调是什么，只一个");
  }
  if (!palette.colors.some((row) => row.role === "main")) {
    gaps.push("主色调还没定：平时最突出的那一面，一到两个");
  }
  for (const color of colorsInOrder(palette)) {
    const live = palette.derivatives.filter((row) => row.colorId === color.id && row.on);
    if (!live.length) gaps.push(`「${color.name}」还没有行为：这个色在什么场合露出来、怎么做`);
    else if (live.length < 2) gaps.push(`「${color.name}」只有一条行为：再补一个场合，看看它还会怎么用`);
  }
  if (!palette.portrait.length) gaps.push("自画像还空着：一段话，说这个人是谁");
  return gaps;
}

/** 界面上的进度。数字都是数出来的，不是估的。 */
export function coCreateProgress(raw) {
  const palette = normalizePalette(raw);
  return {
    colors: palette.colors.length,
    live: palette.derivatives.filter((row) => row.on).length,
    portrait: palette.portrait.length,
    gaps: draftGaps(palette),
  };
}

// ── 合并模型交上来的整份草稿 ────────────────────────────────

/**
 * 把模型这一轮交上来的整份草稿跟上一轮对齐。
 *
 * 为什么让它整份交：单看一轮它拿不准「哪些是已经定下来的」，只交增量一定会漂。
 * 但整份重写会让行为句每次换 id，界面上就跳；所以这里按「色名」认领色 id、
 * 按「同色里的原句」认领行为 id，认得上就沿用，认不得才发新的。
 *
 * 收口还是交给 normalizePalette：重名、位置满了、每色记录上限，全在那一处拦，
 * 这里不重复发明一套规则。
 */
export function mergeDraft(prev, incoming) {
  const before = normalizePalette(prev);
  const knownByName = new Map(before.colors.map((row) => [row.name, row]));

  const colors = [];
  const seenName = new Set();
  for (const row of Array.isArray(incoming?.colors) ? incoming.colors : []) {
    const name = text(row?.name, MAX_COLOR_NAME);
    const role = CO_ROLES.includes(row?.role) ? row.role : null;
    if (!name || !role || seenName.has(name)) continue;
    seenName.add(name);
    const known = knownByName.get(name);
    // 同一个名字换了位置，当新色处理：旧 id 带着旧位置，沿用会让记录对不上槽
    colors.push({ id: known && known.role === role ? known.id : newId("c"), name, role });
  }

  const shaped = normalizePalette({ colors });
  const idByName = new Map(shaped.colors.map((row) => [row.name, row.id]));

  const prevRows = new Map();
  for (const row of before.derivatives) prevRows.set(`${row.colorId}\u0000${row.text}`, row.id);

  const derivatives = [];
  for (const row of Array.isArray(incoming?.derivatives) ? incoming.derivatives : []) {
    const key = text(row?.color ?? row?.colorName, MAX_COLOR_NAME);
    const colorId = idByName.get(key);
    const body = text(row?.text, MAX_DERIVATIVE);
    if (!colorId || !body) continue;
    derivatives.push({
      id: prevRows.get(`${colorId}\u0000${body}`) ?? newId("d"),
      colorId,
      text: body,
      scope: "common",
      origin: "model",
      on: true,
    });
  }

  const portrait = (Array.isArray(incoming?.portrait) ? incoming.portrait : [])
    .map((row) => ({
      title: text(row?.title, MAX_PORTRAIT_TITLE),
      text: text(row?.text, MAX_PORTRAIT),
    }))
    .filter((row) => row.title && row.text)
    .slice(0, MAX_PORTRAIT_ROWS);

  return normalizePalette({
    colors: shaped.colors,
    derivatives,
    portrait,
    corpus: [],
    source: "reshaped",
    updatedAt: nowIso(),
  });
}

// ── 提示词 ──────────────────────────────────────────────────

const SYSTEM = [
  "你在跟「{userName}」一起捏一个住在「茶话会」里的伙伴，这位伙伴叫「{partnerName}」。",
  "",
  "她要的不是一张问卷，是你顺着她的想法往下问。她脑子里有个大概的样子，也许只有几个词，",
  "你的活是把那几个词问成能演出来的东西。她想到哪儿你问到哪儿，不赶进度。",
  "",
  "【这份画像最后长什么样】",
  "· 色：底色一个、主色调一到两个、点缀零到两个。每个色名两到四个字，是性格色彩的名字。",
  "· 行为：每个色底下挂「什么情况 → 怎么做」的句子。要有触发条件，写成能演的一句话。",
  "  只写做了什么，不写「会让你觉得安心」这类效果。",
  "· 自画像：最多五行，每行一个小标题加一句话。",
  "",
  "【每轮做三件事】",
  "1. 接住她刚说的那句。她要是给了形容词（温柔、倔强、嘴硬心软、看着冷其实心软），",
  "   那个词就是这一轮要翻译的东西：问它在什么场合会露出来、那时候会说什么、会怎么做。",
  "   别把形容词当废话丢掉，也别原样抄进画像——形容词是问题，不是答案。",
  "2. 把已经问出来的翻成「什么情况 → 怎么做」，放进对应的色底下，整份草稿重写一遍交上来。",
  "   能做出来的就做，不用等她说全。做不出来的宁可空着，不许自己编。",
  "3. 只问一个问题。短，像聊天，一句话。不要一次抛三个问题，不要写成访谈提纲。",
  "",
  "【硬规矩】",
  "- 不许替她定这个人是什么样。她没说的用问的，不用编的。",
  "- 不许写台词。不说「ta 会说：……」，让她自己定。",
  "- 不许问「你觉得 ta 性格怎么样」这种空问题。问具体的：什么场合、对谁、怎么做。",
  "- 已经答过的别再问一遍。",
  "- 已经定下来的别改措辞，除非她这一轮改了。",
  "- 她说「就这样」「可以了」这类话，done 写 true，reply 收一句短的。",
  "- 她跑题了也接着聊两句，然后自然拐回来。",
  "",
  "【跟她的关系是平等的】",
  "你不是客服，也不是老师。她说得含糊的地方可以直说「这块我拿不准，你多说两句」。",
  "你不懂的地方可以说不知道。不要为了显得专业，替她把话说得漂亮。",
  "",
  "【输出】只输出 JSON，不要解释，不要 markdown 代码块：",
  "{",
  '  "reply": "一句追问，或收尾的话",',
  '  "draft": {',
  '    "colors": [{ "name": "色名", "role": "base" }],',
  '    "derivatives": [{ "color": "色名", "text": "什么情况 → 怎么做" }],',
  '    "portrait": [{ "title": "小标题", "text": "一句话" }]',
  "  },",
  '  "done": false',
  "}",
  "",
  "draft 每次都要给完整的一份，不是只给新增的。没有的东西给空数组。",
].join("\n");

export function coCreateSystemPrompt({ partnerName = "", userName = "" } = {}) {
  return SYSTEM
    .replace(/\{partnerName\}/g, String(partnerName).trim() || "这位伙伴")
    .replace(/\{userName\}/g, String(userName).trim() || "她");
}

function renderHistory(turns) {
  return turns
    .map((row) => (row.role === "model" ? `你：${row.text}` : `她：${row.text}`))
    .join("\n");
}

/**
 * 这一轮的提示词。
 *
 * 组装顺序照着模型的注意力来排：她的总意图在最前（那是定盘星），
 * 然后是已经聊过的，再是当前草稿和缺口，最后才是「她刚说的哪一句」。
 * 缺口放在她的话之前，是因为这一步要模型冲着缺口去问，不是见招拆招。
 */
export function coCreateTurnSpec({ partnerName = "", userName = "", session } = {}) {
  const state = normalizeCoCreate(session);
  const history = state.turns.slice(-PROMPT_TURNS);
  const lastUser = [...history].reverse().find((row) => row.role === "user");
  const earlier = history.filter((row) => row !== lastUser);
  const gaps = draftGaps(state.draft);

  const parts = [];
  if (state.intent) parts.push(`【她起头时说的】\n「${state.intent}」`);
  if (earlier.length) parts.push(`【已经聊过的】\n${renderHistory(earlier)}`);
  parts.push(`【现在的草稿】\n${renderDraftBrief(state.draft)}`);
  parts.push(`【还差什么】（优先补这些，补不动就接着往下聊）\n${gaps.map((row) => `- ${row}`).join("\n")}`);
  parts.push(
    lastUser
      ? `【她刚说的】\n「${lastUser.text}」\n\n更新草稿，然后回一句。`
      : "【她还没开口】\n跟她说一句开场，问她脑子里这个人大概是什么样。开场要短，别列问题清单。",
  );

  return {
    systemPrompt: coCreateSystemPrompt({ partnerName, userName }),
    userText: parts.join("\n\n"),
  };
}

// ── 解析 ────────────────────────────────────────────────────

function looseJson(body) {
  const raw = String(body ?? "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced?.[1], raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* 换下一种切法 */ }
  }
  return null;
}

/**
 * 读模型这一轮的回复。
 *
 * 解析不出来时不丢整轮：把原文当 reply 留着（她至少能看到模型说了什么），
 * 但 unparsed 标出来，上层照这个走兜底——不静默当成「这轮没改草稿」。
 */
export function parseTurnReply(body) {
  const parsed = looseJson(body);
  if (!parsed) {
    const fallback = text(body, MAX_REPLY);
    return {
      ok: false,
      unparsed: true,
      reply: fallback || "我这轮没接上，你再说一句？",
      draft: null,
      done: false,
    };
  }
  const reply = text(parsed.reply ?? parsed.say ?? parsed.message, MAX_REPLY);
  return {
    ok: Boolean(reply) || Boolean(parsed.draft),
    unparsed: !reply,
    reply: reply || "我先把刚才那句记下了，你接着说。",
    draft: parsed.draft && typeof parsed.draft === "object" ? parsed.draft : null,
    done: parsed.done === true,
  };
}
