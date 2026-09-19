/**
 * 爱好怎么长出来。
 *
 * 「本来就有」的，第一次就长成；「后来的」得从真实相处里长——
 * 找不到由头就不长，绝不硬凑。她永远看不到这一层，只能从聊天里慢慢感觉到。
 *
 * 纯逻辑：拼提示词、洗结果、判断时机，不碰文件也不碰模型。
 */

import { dayKey, daysBetween } from "./days.js";
import { canAddHobby, normalizeHobbies, normalizePersonality } from "./knowing.js";
import { getStage } from "./relationship.js";

/** 生来就有的：一次长一两条就够 */
export const BORN_MIN = 1;
export const BORN_MAX = 3;
/** 后来长的：两次之间至少隔这些天，别长成每天都添一条 */
export const GROW_MIN_GAP_DAYS = 3;

const COMMON = [
  "只从给出的材料里找依据，不要凭空编造已经发生过的经历。",
  "要具体、克制、有小偏好。别写「看书」「听音乐」「旅行」这种谁都能写的宏大兴趣。",
  "不要把用户聊过的主题、用户的工作、用户的创作项目或伙伴的服务能力换个说法当成兴趣。",
  "不要写成已经发生过的事实，也不要提到这次生成。",
].join("\n");

/** 给原生兴趣提供具体但不绑定用户的生活对象，模型负责按伙伴的偏好重新组合。 */
export const NATIVE_INTEREST_ATOMS = Object.freeze([
  "纸袋的封口方式", "杯底磨出来的痕迹", "旧物被修过的接缝", "招牌里不小心写错的字",
  "没有完全对齐的边角", "雨后没积水的小地方", "钥匙圈上多出来的旧钥匙", "被挪过位置的椅子",
  "包装纸的折痕", "植物叶片朝向光的角度", "楼道里不同的脚步声", "衣服上不成套的纽扣",
  "书页里夹着的票根", "玻璃杯上的水痕", "一件东西被反复使用后的变化",
]);

export const BORN_SYSTEM = [
  "你在给一个聊天应用里的伙伴生成一小组真正属于 ta 自己的原生兴趣。",
  "这些兴趣在认识用户之前也可以成立；用户不是兴趣来源，伙伴的工作能力也不是兴趣本身。",
  "人格材料只用来决定 ta 观察什么方式、偏爱什么质感、怎样反复琢磨，不要直接从材料里的项目名和专业能力取兴趣。",
  "兴趣内容要和用户主题正交，但和伙伴的注意方式相容。即使用户从没聊过，这些兴趣也应该能成立。",
  "每条都要落到一个小对象或小现象，并写出 ta 的偏好、会做的小动作、以及一个小别扭。不要写宏大领域。",
  "可以从这些对象里挑，也可以创造同样具体的对象，但不要整批照抄：",
  NATIVE_INTEREST_ATOMS.join("、"),
  "如果把用户和用户的工作从上下文里删掉，这条兴趣仍然成立，才算合格。",
  "",
  "每一行六个字段，用竖线隔开：",
  "名字|具体对象|个人偏好|平时会做的小动作|不喜欢或不会越过的边界|一句短理由",
  `写 ${BORN_MIN} 到 ${BORN_MAX} 条。材料不足时只回一个字：无`,
].join("\n");

export const GROWN_SYSTEM = [
  "你在给一个聊天应用里的伙伴长出一条新的爱好。",
  "这条爱好必须是从下面这段真实相处里长出来的：她反复提过的、你们聊得深的、一起经历过的事。",
  "找不到能支撑它的线索，就只回一个字：无。宁可不长，也不许硬凑。",
  COMMON,
  "",
  "只输出一行，三个字段用竖线隔开：",
  "名字|为什么会喜欢|这是从哪件事里长出来的",
].join("\n");

/** 洗一行：去掉代码块壳、列表符号、引号、粗体 */
function cleanLine(line) {
  let out = String(line ?? "").trim();
  out = out.replace(/^```[\s\S]*?\n([\s\S]*?)```$/u, "$1");
  out = out.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/u, "");
  out = out.replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1");
  return out.replace(/\*\*/g, "").trim();
}

/** 一行 → 一条候选；认不出来、或者明说「无」，都返回 null。 */
export function parseHobbyLine(line) {
  const text = cleanLine(line);
  if (!text || /^无[。.]?$/u.test(text)) return null;
  const parts = text.split(/[|｜]/u).map((part) => part.trim());
  const name = String(parts[0] ?? "").slice(0, 30);
  if (!name) return null;
  return {
    name,
    reason: String(parts[1] ?? "").slice(0, 160),
    from: String(parts[2] ?? "").slice(0, 160),
  };
}

/** 一次可能回好几行（共同兴趣），也认模型偶尔返回的 JSON 数组；同名的只留一条。 */
export function parseHobbyReply(reply) {
  const raw = String(reply ?? "").trim();
  let rows = [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed)
        ? parsed.map((row) => (row && typeof row === "object" ? parseHobbyLine(`${row.name ?? ""}|${row.reason ?? ""}|${row.from ?? ""}`) : parseHobbyLine(row))).filter(Boolean)
        : [];
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    rows = raw.split(/[\r\n]+/u).map(parseHobbyLine).filter(Boolean);
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

/** 原生兴趣的一行解析：名字、对象、偏好、动作、边界、短理由。 */
export function parseNativeHobbyLine(line) {
  const text = cleanLine(line);
  if (!text || /^无[。. ]?$/u.test(text)) return null;
  const parts = text.split(/[|｜]/u).map((part) => part.trim());
  const name = String(parts[0] ?? "").slice(0, 30);
  if (!name || parts.length < 5) return null;
  return {
    name,
    object: String(parts[1] ?? "").slice(0, 100),
    preference: String(parts[2] ?? "").slice(0, 180),
    ritual: String(parts[3] ?? "").slice(0, 160),
    friction: String(parts[4] ?? "").slice(0, 160),
    reason: String(parts[5] ?? "").slice(0, 160),
  };
}

export function parseNativeHobbyReply(reply) {
  const raw = String(reply ?? "").trim();
  if (!raw || /^无[。. ]?$/u.test(raw)) return [];
  const rows = raw.split(/[\r\n]+/u).map(parseNativeHobbyLine).filter(Boolean);
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

const BROAD_INTEREST_RE = /^(?:文学|艺术|设计|哲学|技术|编程|写作|游戏|音乐|阅读|美食|旅行|摄影|审美)$/u;

/** 生成后门禁：缺具体四件套、只剩宏大领域或直接叫用户名字，都不覆盖旧数据。 */
export function validateNativeHobbies(rows, { userName = "" } = {}) {
  const name = String(userName ?? "").trim();
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const values = [row?.name, row?.object, row?.preference, row?.ritual, row?.friction];
    if (values.some((value) => !String(value ?? "").trim())) return false;
    if (BROAD_INTEREST_RE.test(String(row.name).trim())) return false;
    if (name && values.some((value) => String(value).includes(name))) return false;
    const key = String(row.name).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, BORN_MAX);
}

/** 只把人格的注意方式交给原生兴趣生成，不把整份身份/工作材料继续喂回去。 */
export function nativeInterestSeed(personality) {
  const value = normalizePersonality(personality);
  const lines = [];
  for (const layer of [value.surface, value.inner]) {
    if (layer.tags.length) lines.push(`偏好结构：${layer.tags.join("、")}`);
    if (layer.signals.length) lines.push(...layer.signals.map((signal) => `注意方式：${signal}`));
  }
  return lines.join("\n");
}

/** 原生兴趣只读取伙伴自己的注意方式，不把用户名字和用户主题塞进来源。 */
export function bornHobbySpec({ partnerName, userName = "", personaText = "", personalityText = "" }) {
  const material = String(personalityText || personaText || "").trim();
  const blocks = [
    `这位伙伴叫「${partnerName}」。${userName ? `ta 会在手机上和${userName}聊天，但${userName}不是兴趣来源。` : ""}`,
    material
      ? `只把下面材料当作 ta 的注意方式和偏好结构：\n${material}`
      : "（没有读到足够的注意方式材料，不能生成任何原生兴趣，只回：无）",
    "给 ta 定几条不依赖用户、不依赖用户工作、也不依赖伙伴服务能力的原生兴趣。每条必须具体到小对象，并有个人偏好、小动作和边界。",
  ];
  return { kind: "born", systemPrompt: BORN_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/** 后来那条：要从真实的相处里长。 */
export function grownHobbySpec({ partnerName, userName, existing, material }) {
  const list = normalizeHobbies(existing);
  const blocks = [
    `这位伙伴叫「${partnerName}」，跟 ${userName} 在「茶话会」里说话。`,
    list.length ? `ta 已经有的爱好（不要重复，也不要换皮）：\n${list.map((hobby) => hobby.name).join("、")}` : "",
    material ? `最近的真实相处：\n${material}` : "",
    "看看这里面有没有什么能长出新东西来。",
  ];
  return { kind: "grown", systemPrompt: GROWN_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/**
 * 现在能不能再长一条。
 * 三道闸：还有额度、关系够近、离上次够久。
 */
export function canGrow({ relationship, hobbies, today = dayKey() }) {
  const list = normalizeHobbies(hobbies);
  if (!canAddHobby(list, "grown")) return false;
  if (getStage(relationship) < 1) return false;
  const grownDays = list
    .filter((hobby) => hobby.origin === "grown")
    .map((hobby) => dayKey(hobby.at))
    .filter(Boolean)
    .sort();
  const last = grownDays.at(-1);
  if (last) {
    const gap = daysBetween(last, today);
    if (gap === null || gap < GROW_MIN_GAP_DAYS) return false;
  }
  return true;
}

/** 生来那份要不要补：一条都还没有，就补一次。 */
export function needsBorn(hobbies) {
  return normalizeHobbies(hobbies).every((hobby) => hobby.origin !== "born");
}
