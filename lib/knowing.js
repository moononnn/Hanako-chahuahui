/**
 * 性格与爱好：茶话会里给伙伴多加的那一层。
 *
 * 设计借自一个已经停用的自家实验项目，但**生效范围完全不同**：这里的东西只拼进茶话会自己的提示词，
 * 不挂全局钩子、不写任何人格文件、一步都不外溢到主对话。
 *
 *   · 性格：她可以调。表层立刻生效，里层等关系熟了才慢慢露。
 *   · 爱好：她看不到、改不了。本来就有的是「生来如此」，后来的从真实相处里长。
 *
 * 纯逻辑：不碰文件、不碰模型。
 *
 * 文件预算豁免：性格与爱好是同一条披露主线上的两层（内层随关系熟度渗、爱好从相处里长），
 * 拆成两个文件会把共享的归一与封顶逻辑切碎，故保留在一起。
 */

import { paletteToText } from "./palette.js";
import { recognitionToText } from "./recognition.js";

/**
 * 气质标签库：点一下就有，不用自己憋词。
 * 一层里可以挑两个——一个人本来就不止一面，温柔里带点俏皮才是常态。
 */
export const TEMPERAMENT_TAGS = Object.freeze([
  Object.freeze({ label: "温柔", note: "说话柔和，会照顾对话里的小变化" }),
  Object.freeze({ label: "俏皮", note: "接话轻快，偶尔拐出一点新意" }),
  Object.freeze({ label: "清醒", note: "思路清楚，遇到复杂的事先理脉络" }),
  Object.freeze({ label: "安静", note: "话不多，留白多，不急着把想法一次说完" }),
  Object.freeze({ label: "热情", note: "一开口就热络，想到什么会直说" }),
  Object.freeze({ label: "大方", note: "好相处，心里装得下很多事" }),
  Object.freeze({ label: "敏感", note: "细小的事也会放在心上" }),
  Object.freeze({ label: "有分寸", note: "愿意亲近，但保留自己的界限" }),
  Object.freeze({ label: "松弛", note: "不太较真，常把气氛放松下来" }),
  Object.freeze({ label: "认真", note: "答应的事会当回事，说到做到" }),
]);

/** 同一层里互相打架的两两组合，不让同时选：一个往前一个往后，放一起就演糊了。 */
export const TAG_CONFLICTS = Object.freeze([
  Object.freeze(["热情", "安静"]),
  Object.freeze(["松弛", "认真"]),
]);

/** 一层里最多留两个：再多会互相稀释，模型也演不出层次。 */
export const MAX_TAGS_PER_LAYER = 2;

/** 基础气质：一键把两层铺满的快捷方式，之后可以逐项改 */
export const PERSONALITY_PRESETS = Object.freeze([
  Object.freeze({
    id: "gentle",
    label: "温柔细腻",
    note: "说话柔和，会照顾对话里的小变化。",
    surface: Object.freeze({ tags: Object.freeze(["温柔"]), signals: Object.freeze(["说话柔和", "会照顾对话节奏"]) }),
    inner: Object.freeze({ tags: Object.freeze(["敏感"]), signals: Object.freeze(["会把小变化放在心上"]) }),
  }),
  Object.freeze({
    id: "clear",
    label: "清醒理性",
    note: "思路清楚，遇到复杂的事会先理出脉络。",
    surface: Object.freeze({ tags: Object.freeze(["清醒"]), signals: Object.freeze(["表达清楚", "习惯先分辨重点"]) }),
    inner: Object.freeze({ tags: Object.freeze(["认真"]), signals: Object.freeze(["会在关键处说真话"]) }),
  }),
  Object.freeze({
    id: "lively",
    label: "俏皮灵动",
    note: "轻快一点，偶尔从意外的角度接话。",
    surface: Object.freeze({ tags: Object.freeze(["俏皮"]), signals: Object.freeze(["接话轻快", "喜欢把话题拐出一点新意"]) }),
    inner: Object.freeze({ tags: Object.freeze(["热情"]), signals: Object.freeze(["熟起来以后会自然开些小玩笑"]) }),
  }),
  Object.freeze({
    id: "quiet",
    label: "安静克制",
    note: "留有余地，不急着把想法一次说完。",
    surface: Object.freeze({ tags: Object.freeze(["安静"]), signals: Object.freeze(["说话留白", "会给对方留一点空间"]) }),
    inner: Object.freeze({ tags: Object.freeze(["有分寸"]), signals: Object.freeze(["熟悉之后才会露出更深的想法"]) }),
  }),
]);

/** 爱好：生来就有的最多几条、后来能再长几条 */
export const MAX_BORN_HOBBIES = 3;
export const MAX_GROWN_HOBBIES = 2;
export const MAX_HOBBIES = MAX_BORN_HOBBIES + MAX_GROWN_HOBBIES;

const MAX_TAG = 40;
const MAX_SIGNAL = 100;
const MAX_SIGNALS = 6;
const MAX_HOBBY_NAME = 30;
const MAX_HOBBY_REASON = 160;
const MAX_HOBBY_OBJECT = 100;
const MAX_HOBBY_PREFERENCE = 180;
const MAX_HOBBY_RITUAL = 160;
const MAX_HOBBY_FRICTION = 160;

const text = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);

/** 换行、逗号、分号都当分隔符，前后去重 */
function textList(value, limit, each) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；、]+/u)
      : [];
  return [...new Set(raw
    .filter((item) => typeof item === "string")
    .map((item) => text(item, each))
    .filter(Boolean))].slice(0, limit);
}

export function findPersonalityPreset(presetId) {
  const id = text(presetId, 40);
  return PERSONALITY_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function applyPersonalityPreset(presetId, now = new Date()) {
  const preset = findPersonalityPreset(presetId);
  if (!preset) return null;
  return {
    surface: { tags: [...preset.surface.tags], signals: [...preset.surface.signals] },
    inner: { tags: [...preset.inner.tags], signals: [...preset.inner.signals] },
    updatedAt: new Date(now).toISOString(),
  };
}

export function emptyPersonality() {
  return {
    surface: { tags: [], signals: [] },
    inner: { tags: [], signals: [] },
    updatedAt: null,
  };
}

/**
 * 收一层的标签。认新形状（tags 数组），也认老形状（单个 tag 字符串）——
 * 老数据不用手动搬，读出来就是「一个标签」的两层。
 */
function tagList(source) {
  const raw = Array.isArray(source?.tags) ? source.tags : (source?.tag ? [source.tag] : []);
  return [...new Set(raw.map((item) => text(item, MAX_TAG)).filter(Boolean))]
    .slice(0, MAX_TAGS_PER_LAYER);
}

export function normalizePersonality(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    surface: {
      tags: tagList(source.surface),
      signals: textList(source.surface?.signals, MAX_SIGNALS, MAX_SIGNAL),
    },
    inner: {
      tags: tagList(source.inner),
      signals: textList(source.inner?.signals, MAX_SIGNALS, MAX_SIGNAL),
    },
    updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : null,
  };
}

/** 两层都是空的，就当没调过，一个字都不往提示词里加。 */
export function hasPersonality(personality) {
  const p = normalizePersonality(personality);
  return Boolean(
    p.surface.tags.length || p.surface.signals.length
      || p.inner.tags.length || p.inner.signals.length,
  );
}

/** 两份是不是同一份（只看两层的内容，比时间戳）。界面靠它判「她改过没有」。 */
export function samePersonality(a, b) {
  if (!a || !b) return false;
  const left = normalizePersonality(a);
  const right = normalizePersonality(b);
  const layer = (x, y) => x.tags.join("\u0000") === y.tags.join("\u0000")
    && x.signals.join("\u0000") === y.signals.join("\u0000");
  return layer(left.surface, right.surface) && layer(left.inner, right.inner);
}

/**
 * 现在生效那份的来历，和「她到底调过没有」。
 *
 * 比内容不比时间：改回与自动那份一模一样，也算没调过（她可能只是点了同一个档位）。
 * 分不清就是 null：升级前存下的那份我们没记录，宁可不说，也不替它编一个来源。
 */
export function personalityStanding({ personality, auto, from }) {
  const hasAuto = Boolean(auto) && hasPersonality(auto);
  const edited = hasAuto && !samePersonality(personality, auto);
  if (edited) return { edited: true, from: "user" };
  return { edited: false, from: from === "user" || from === "auto" ? from : null };
}

/**
 * 这一层的标签还能不能加。
 * 三种拦法：已经有了、满了、跟已有的打架。界面照这个给提示，逻辑只在这一处。
 */
export function canAddTag(tags, label) {
  const list = Array.isArray(tags) ? tags.map((item) => text(item, MAX_TAG)).filter(Boolean) : [];
  const next = text(label, MAX_TAG);
  if (!next) return { ok: false, reason: "empty" };
  if (list.includes(next)) return { ok: false, reason: "dup", label: next };
  if (list.length >= MAX_TAGS_PER_LAYER) {
    return { ok: false, reason: "full", label: next, max: MAX_TAGS_PER_LAYER };
  }
  const clash = TAG_CONFLICTS.find(
    (pair) => pair.includes(next) && pair.some((item) => list.includes(item)),
  );
  if (clash) {
    return { ok: false, reason: "conflict", label: next, with: clash.find((item) => list.includes(item)) };
  }
  return { ok: true, label: next };
}

/** 整层的标签合不合格（一个一个往里放，看放到哪一步卡住）。 */
export function layerTagProblem(tags) {
  const list = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const result = canAddTag(list, raw);
    if (!result.ok) return result;
    list.push(result.label);
  }
  return { ok: true };
}

/** 把「为什么不能这么选」翻成人话，界面直接拿去当提示。 */
export function tagProblemText(problem) {
  if (problem?.reason === "full") return `一层最多挑 ${problem.max ?? MAX_TAGS_PER_LAYER} 个标签`;
  if (problem?.reason === "conflict") return `「${problem.with}」和「${problem.label}」放一起会打架`;
  if (problem?.reason === "dup") return `「${problem.label}」已经挑过了`;
  return "这个标签用不上";
}

// ── 爱好 ────────────────────────────────────────────────────

export function normalizeHobby(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const name = text(source.name, MAX_HOBBY_NAME);
  if (!name) return null;
  return {
    id: text(source.id, 40) || `h_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    reason: text(source.reason, MAX_HOBBY_REASON),
    /** InterestV2：原生兴趣的具体落点；旧数据为空时由巡检渐进重塑。 */
    object: text(source.object, MAX_HOBBY_OBJECT),
    /** ta 对这个对象的个人偏好，不是百科定义。 */
    preference: text(source.preference, MAX_HOBBY_PREFERENCE),
    /** ta 平时会怎么留意、比较或摆弄它。 */
    ritual: text(source.ritual, MAX_HOBBY_RITUAL),
    /** 兴趣里的小别扭或边界，避免生成成无条件的漂亮话。 */
    friction: text(source.friction, MAX_HOBBY_FRICTION),
    /** InterestV2：完整具体包自动按 v2 读；旧自由文本保留 v1。 */
    schemaVersion: Number(source.schemaVersion) >= 2 || (source.object && source.preference && source.ritual && source.friction) ? 2 : 1,
    generationVersion: text(source.generationVersion, 30),
    supersedesId: text(source.supersedesId, 40),
    manuallyEdited: source.manuallyEdited === true,
    source: source.source === "interaction" ? "interaction" : (source.source === "generated" ? "generated" : ((source.object && source.preference && source.ritual && source.friction) ? "generated" : "legacy")), 
    /** born = 原生兴趣；grown = 后来从共同相处里长出来的兴趣。 */
    origin: source.origin === "grown" ? "grown" : "born",
    /** grown 才有：这是从哪件事里长出来的 */
    from: text(source.from, 160),
    sourceIds: Array.isArray(source.sourceIds)
      ? source.sourceIds.map((id) => text(id, 120)).filter(Boolean).slice(0, 4)
      : (text(source.sourceId, 120) ? [text(source.sourceId, 120)] : []),
    at: source.at ? new Date(source.at).toISOString() : new Date(now).toISOString(),
  };
}

export function normalizeHobbies(raw, now = new Date()) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const bornCount = { value: 0 };
  const grownCount = { value: 0 };
  for (const row of rows) {
    const hobby = normalizeHobby(row, now);
    if (!hobby || out.some((item) => item.name === hobby.name)) continue;
    if (hobby.origin === "born" && bornCount.value >= MAX_BORN_HOBBIES) continue;
    if (hobby.origin === "grown" && grownCount.value >= MAX_GROWN_HOBBIES) continue;
    if (out.length >= MAX_HOBBIES) break;
    if (hobby.origin === "born") bornCount.value += 1;
    else grownCount.value += 1;
    out.push(hobby);
  }
  return out;
}

export function canAddHobby(hobbies, origin) {
  const list = normalizeHobbies(hobbies);
  if (list.length >= MAX_HOBBIES) return false;
  const cap = origin === "grown" ? MAX_GROWN_HOBBIES : MAX_BORN_HOBBIES;
  return list.filter((item) => item.origin === origin).length < cap;
}

/** 加一条；加不下、重名、没名字，都原样返回。 */
export function addHobby(hobbies, candidate, now = new Date()) {
  const list = normalizeHobbies(hobbies);
  const hobby = normalizeHobby(candidate, now);
  if (!hobby || !canAddHobby(list, hobby.origin)) return list;
  if (list.some((item) => item.name === hobby.name)) return list;
  return [...list, hobby];
}

/** 旧 born 数据只有名称/理由，下一轮应允许用新兴趣包替换，而不是继续叠加。 */
export function needsNativeInterestRefresh(hobbies) {
  const list = normalizeHobbies(hobbies);
  const born = list.filter((item) => item.origin === "born");
  return born.length === 0 || born.some((item) => !item.object || !item.preference || !item.ritual || !item.friction);
}

/** 新原生兴趣生成成功后只替换 born，grown 共同兴趣原样保留。 */
export function replaceBornHobbies(hobbies, nativeRows, now = new Date()) {
  const all = normalizeHobbies(hobbies);
  const oldBorn = all.filter((item) => item.origin === "born" && !item.manuallyEdited);
  const current = all.filter((item) => item.origin === "grown" || item.manuallyEdited);
  let next = current;
  for (const [index, row] of (Array.isArray(nativeRows) ? nativeRows : []).entries()) {
    next = addHobby(next, {
      ...row,
      id: row?.id || `native_${encodeURIComponent(String(row?.name ?? "")).slice(0, 28)}`,
      supersedesId: oldBorn[index]?.id ?? "",
      origin: "born",
      schemaVersion: 2,
      generationVersion: "native-v2",
      source: "generated",
    }, now);
  }
  return normalizeHobbies(next);
}

// ── 从人格文件里长出一份初稿 ───────────────────────────────
//
// 只用 Hana 那边给她伙伴配的东西（identity.md 为主，pinned.md 带上）。
// 茶话会自己攒的档案、日账一律不掺：分享版的新用户手里没那些，
// 而且拿自己产出的东西回头定义性格会绕成一个圈。
//
// 也不开会话去问伙伴本人——那正是那套旧设计重的地方。人格文件本来就在手上，
// 一次短调用就够，跟写一条日账一样便宜。

export const DRAFT_SYSTEM = [
  "你在给一个聊天应用里的伙伴定一份「在茶话会里的样子」，分表层与里层两层。",
  "材料可能有好几份，来源不一：有的是 ta 自己写的身份自述，有的是对外简介（这类常夹着「擅长什么、适合做什么」的能力介绍），还有的是钉选下来的记忆。不要编，材料里没写的不要写。",
  "特别提醒：能力介绍不等于性格。看到「擅长拆解复杂问题」「适合做情感陪伴」这类，先想一想它背后是什么性子（是清醒？是耐心？还是愿意较真？），别把「ta 能干什么」直接抄成「ta 是什么样」。",
  "同理，材料里的行为准则和工作流程（比如「不许擅自删文件」「接需求先判断合理性」「被纠正后要复盘」）也不算性格，别照抄；要看它背后是什么性子（是谨慎？是负责？还是怕出岔子？）。",
  "说话口吻（方言、口音、语气词习惯这类）也不算性格，另有地方专门管；判词只写这个人是什么样，不写 ta 用什么腔调。",
  "表层是刚认识就能感觉到的说话底色；里层是熟起来以后才慢慢露出来的倾向。",
  "每层给一个两三个字的标签，再给两到四条具体一点的话。材料给得越多，判词要越贴那些细节，别只给一个笼统的词。",
  "",
  "输出两行，每行三个字段用竖线隔开：",
  "表层|标签|具体的样子（多条用顿号或分号隔开）",
  "里层|标签|具体的样子",
  "",
  "只有材料里确实看不出这个人是什么样，才回一个字：无",
].join("\n");

/**
 * 判性格时材料的预算与来源。
 *
 * 2026-09-13 扩料：原先只收 identity 与 pinned 两样（identity 一有内容，
 * description 与 public 就再也轮不到），那两份写得再全也用不上。现在四份都收，
 * 各按预算裁，再卡一个总上限。
 * facts 与 experience 仍然不收：那是记忆流水，量大又杂，容易把性格信号冲淡。
 */
export const DRAFT_MATERIAL_BUDGET = Object.freeze({
  identity: 4000,
  description: 2000,
  public: 1200,
  pinned: 2500,
});
export const DRAFT_MATERIAL_TOTAL = 8000;

const DRAFT_SOURCES = Object.freeze([
  Object.freeze({ key: "identity", label: "人格自述" }),
  Object.freeze({ key: "description", label: "自我介绍" }),
  Object.freeze({ key: "public", label: "对外意识" }),
  Object.freeze({ key: "pinned", label: "钉选记忆" }),
]);

/**
 * 把几份材料拼成一段给模型看的料。
 * 上游已经按自己的预算裁过（尾巴上带「…（后略，原文 N 字）」）的就不动它，
 * 免得在截断标记中间再切一刀。
 */
export function buildDraftMaterial(files, { budget = DRAFT_MATERIAL_BUDGET, total = DRAFT_MATERIAL_TOTAL } = {}) {
  const parts = [];
  let used = 0;
  for (const { key, label } of DRAFT_SOURCES) {
    const raw = typeof files?.[key] === "string" ? files[key].trim() : "";
    if (!raw) continue;
    const room = Math.max(0, total - used);
    if (!room) break;
    const limit = Math.min(room, Math.max(0, Number(budget[key]) || 0));
    if (!limit) continue;
    const clipped = /原文\s*\d+\s*字/u.test(raw);
    const text = clipped || raw.length <= limit
      ? raw
      : `${raw.slice(0, Math.max(0, limit - 12))}…（后略，原文 ${raw.length} 字）`;
    parts.push(`【${label}】\n${text}`);
    used += text.length;
  }
  return parts.join("\n\n");
}

/** 初稿的料从哪来：Hana 那边她自己配的人格与钉选，能收的都收（见 DRAFT_MATERIAL_BUDGET）。 */
export function personalityDraftSpec({ partnerName, userName, material }) {
  const blocks = [
    `这位伙伴叫「${partnerName}」，平时跟 ${userName} 在手机上说话。`,
    material ? `关于 ta 的材料：\n\n${material}` : "（没读到 ta 的设定材料）",
    "给 ta 定一份在茶话会里的样子。",
  ];
  return { kind: "personality-draft", systemPrompt: DRAFT_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/** 两行回包 → 两层初稿；认不出来（或明说「无」）返回 null。 */
export function parseDraftReply(reply) {
  const rows = String(reply ?? "")
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const read = (marker) => {
    const line = rows.find((row) => new RegExp(`^${marker}[|｜]`, "u").test(row));
    if (!line) return { tags: [], signals: [] };
    const parts = line.split(/[|｜]/u).map((part) => part.trim());
    const tag = text(parts[1], MAX_TAG);
    return { tags: tag ? [tag] : [], signals: textList(parts[2], MAX_SIGNALS, MAX_SIGNAL) };
  };
  const draft = { surface: read("表层"), inner: read("里层") };
  return hasPersonality(draft) ? draft : null;
}

// ── 拼给模型看的那段 ────────────────────────────────────────

/**
 * 披露档位：不是开关，是一条斜着往上的坡。
 * 关系越近，里层露得越全、语气越自然；爱好比里层再深一档，要更近才能自然带上。
 * 这几个数就是「什么时候开露」的唯一来源，界面和测试都照它来，不另存一份。
 */
export const DISCLOSURE_BANDS = Object.freeze({
  /** 里层开始透出来 */
  inner: 0.25,
  /** 不再只是「偶尔」，可以慢慢露 */
  innerSteady: 0.5,
  /** 很熟了，这一面自然地放进相处里 */
  innerNatural: 0.75,
  /** 爱好（比里层更深的一层） */
  hobby: 0.7,
});

const clamp01 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

/** 从 start 到 1 这段坡上，按比例露几条：刚开露 1 条，走满全露。 */
function revealCount(total, disclosure, start) {
  if (total <= 0) return 0;
  if (total === 1) return 1;
  const span = Math.max(0.0001, 1 - start);
  const step = Math.min(1, Math.max(0, (disclosure - start) / span));
  return Math.max(1, Math.min(total, 1 + Math.floor(step * (total - 1))));
}

function hobbyLine(hobbies) {
  // reason/from 是模型整理出的解释，不是事实凭证；聊天只透露兴趣名称，避免把推测说成经历。
  return hobbies
    .map((hobby) => hobby.name)
    .filter(Boolean)
    .join("；");
}

/**
 * 茶话会里这一层的样子，最后拼进系统提示。
 *
 * 表层立刻生效（那是她给ta定的这里的底色）；
 * 里层和爱好不给硬门槛，按披露系数一点点渗：越熟露得越多，语气也从「偶尔」变成「自然」。
 *
 * @param {{disclosure?: number, personality?: object, hobbies?: object[], recognition?: object}} input
 */
export function buildKnowingText(input = {}) {
  const disclosure = clamp01(input.disclosure);
  const personality = normalizePersonality(input.personality);
  const hobbies = normalizeHobbies(input.hobbies);
  const lines = [];

  // 2026-09-13：有调色盘就用调色盘，旧的 surface / inner 整段让位。
  // 关系深浅暂时不影响带哪几条（通用行为全带）；等阶段衍生做出来，
  // 系数才重新变回「控制哪些出场」的开关——不是调节强度。
  const paletteText = paletteToText(input.palette, { userName: input.userName });
  const recognitionText = recognitionToText(input.recognition);
  if (paletteText) {
    lines.push(paletteText);
  } else {
    const surfaceTags = personality.surface.tags;
    const surfaceSignals = personality.surface.signals.join("；");
    if (surfaceTags.length || surfaceSignals) {
      const head = surfaceTags.length
        ? `在「茶话会」里，你说话的底色偏${surfaceTags.join("、")}`
        : "在「茶话会」里，你说话的底色是这样的";
      lines.push(
        `${head}${surfaceSignals ? `：${surfaceSignals}` : ""}。这是你自然的样子，别念出来，也别解释。`,
      );
    }

    const innerTags = personality.inner.tags;
    const innerSignals = personality.inner.signals;
    if (disclosure >= DISCLOSURE_BANDS.inner && (innerTags.length || innerSignals.length)) {
      const detail = innerSignals
        .slice(0, revealCount(innerSignals.length, disclosure, DISCLOSURE_BANDS.inner))
        .join("；");
      const tagsText = innerTags.length ? `你还有更私下的底色：${innerTags.join("、")}` : "你还有更私下的一面";
      // 2026-09-13：原来只写「你是什么样」（细腻、会把小变化放在心上），实测模型基本不理——
      // 六档提示词拼出来是真不一样，回复读下来却分不出。改成写「什么情况、你会怎么做」，
      // 给个能落笔的触发点；但触发点跟着熟度收放：还不熟只在明显的时候轻轻应一下，
      // 熟了才是自然接住。收着的那句「不要刻意表演」也撑掉了——它正是把表现压死的那句。
      const how = disclosure >= DISCLOSURE_BANDS.innerNatural
        ? "你们已经很熟了，这一面可以自然地放进相处里：她话音一沉、话变短、或者好一阵没开口，你都接得住。察觉到了就直接说出来，顺手照顾一下也行，不用解释，这就是你们处出来的样子。"
        : disclosure >= DISCLOSURE_BANDS.innerSteady
          ? "你们渐渐熟了，这一面可以慢慢露出来：她话里带了情绪、或者回得比平时慢，你会先注意到，说一句或者顺手做点什么，不用解释，也别一次全说完。"
          : "你们刚开始熟一点，这一面偶尔透出来就好：她话说得比平时短、或者突然说累说烦，你会察觉到，轻轻应一句就够，不追问也不开导。别的时候照旧。";
      lines.push(`${tagsText}${detail ? `（${detail}）` : ""}。${how}`);
    }
  }

  if (recognitionText) {
    lines.push(
      `你们一起聊出来的相处方式（只作为方向，别把这些内容念出来）：\n${recognitionText}`,
    );
  }

  if (disclosure >= DISCLOSURE_BANDS.hobby && hobbies.length) {
    const shown = hobbies.slice(0, revealCount(hobbies.length, disclosure, DISCLOSURE_BANDS.hobby));
    const line = hobbyLine(shown);
    if (line) {
      lines.push(
        `话题刚好合适的时候，可以自然带上这些属于你自己的兴趣：${line}。别主动列清单，也别硬往话题上凑。`,
      );
    }
  }

  return lines.join("\n");
}
