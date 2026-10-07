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

/**
 * 生来就有的：一次给 3 条母题 + 1~2 条癖好。
 * 母题负责出话题，癖好只当人格底色，两样都不能缺。
 */
export const BORN_MOTIF_MIN = 3;
export const BORN_MOTIF_MAX = 3;
export const BORN_QUIRK_MIN = 1;
export const BORN_QUIRK_MAX = 2;
export const BORN_MIN = BORN_MOTIF_MIN + BORN_QUIRK_MIN;
export const BORN_MAX = BORN_MOTIF_MAX + BORN_QUIRK_MAX;
/** 后来长的：两次之间至少隔这些天，别长成每天都添一条 */
export const GROW_MIN_GAP_DAYS = 3;

const COMMON = [
  "只从给出的材料里找依据，不要凭空编造已经发生过的经历。",
  "要具体、克制、有小偏好。别写「看书」「听音乐」「旅行」这种谁都能写的宏大兴趣。",
  "不要把用户聊过的主题、用户的工作、用户的创作项目或伙伴的服务能力换个说法当成兴趣。",
  "不要写成已经发生过的事实，也不要提到这次生成。",
].join("\n");

/**
 * 小细节癣好：一个物件、一个响动、一处痕迹。
 *
 * ⚠️ 这一档以前就是池子的全部，所以八个伙伴长出来的都是同一个观察者的切片，
 * 全是「看小东西」，一条能聊起来的都没有。
 *
 * 现在给的是「取景方式」：名词位置留空（某个器物、某种吃食…），
 * 谁捡到都得自己往里填。只给成品爱好，别人就会直接从同一份清单里挑。
 */
export const NATIVE_DETAIL_ATOMS = Object.freeze([
  "某个器物被反复使用后留下的痕迹",
  "一处没对齐、但还能用的小地方",
  "某个包装被拆开时留下的那一下",
  "一段听熟了的声音里的小变化",
  "某件旧东西被修补过的地方",
  "招牌或标签上写错的某个字",
  "一件东西被挪开以后空出来的位置",
  "某种吃食剩下最后一口时的样子",
  "一件衣服上不成套的那颗扣子",
  "某张纸被折过又抚平的那道痕",
  "某样东西用久了颜色变浅的那一块",
  "一个地方下过雨之后干得最快的那片",
  "同一样东西摆在一起时那点不一样",
  "一件便宜东西做工意外讲究的那一处",
  "某个盒子或抽屉被塞满时的顺序",
  "一样吃食拿到手里最先被注意到的那点",
  "某件东西被别人碰过留下的痕迹",
  "某个动作做完之后跟着的那点余韵",
]);

/**
 * 能撑起一场聊天的爱好：一类东西、一种玩法、一件常做的事。
 * 给的是形状（「某一类 X 的 Y」），不是成品爱好，免得模型照抄。
 * 吃的玩的追的囤的都在里面，不只有文艺那一面。
 */
export const NATIVE_PASTIME_ATOMS = Object.freeze([
  "某一类游戏里反复琢磨的小机制",
  "同一种食材的几种家常做法",
  "固定追着看的某档节目或某个系列",
  "攒某一类便宜小玩意",
  "某个老牌子的停产型号",
  "街边某类小店的门脸变化",
  "某一首歌的不同录音版本",
  "某类题材里偏爱的那一路",
  "某种不动脑子但解压的重复活儿",
  "把某类不值钱的小东西修好",
  "给身边人挑某类东西时的比价套路",
  "某个圈子里才懂的梗和黑话",
  "一类便宜吃食里的讲究",
  "常去的那类地方的固定路线",
]);

/** 两档合起来，给需要整体遍历的地方用。 */
export const NATIVE_INTEREST_ATOMS = Object.freeze([
  ...NATIVE_DETAIL_ATOMS,
  ...NATIVE_PASTIME_ATOMS,
]);

/** 每次投喂几条示例。给多了就等于给答案，给少了又标不出尺度。 */
export const NATIVE_SEED_SAMPLE = 6;

/** 不放回地随机抽几个。 */
function pickWithoutReplacement(pool, count, rnd) {
  const rest = [...pool];
  const out = [];
  const size = Math.max(0, Math.min(count, rest.length));
  for (let i = 0; i < size; i += 1) {
    const index = Math.min(rest.length - 1, Math.floor(rnd() * rest.length));
    out.push(rest.splice(index, 1)[0]);
  }
  return out;
}

/**
 * 抽一把方向示例：两档各出一半。
 * 不同伙伴抽到的子集不一样，也让模型看见「一组里既有能聊的，也有小癖好」。
 */
export function sampleNativeAtoms(rnd = Math.random, count = NATIVE_SEED_SAMPLE) {
  const size = Math.max(0, count);
  const pastimeCount = Math.max(BORN_MOTIF_MIN, Math.min(NATIVE_PASTIME_ATOMS.length, Math.round(size * 0.6)));
  const detailCount = Math.max(0, size - pastimeCount);
  return [
    ...pickWithoutReplacement(NATIVE_DETAIL_ATOMS, detailCount, rnd),
    ...pickWithoutReplacement(NATIVE_PASTIME_ATOMS, pastimeCount, rnd),
  ];
}

export const BORN_SYSTEM = [
  "你在给一个聊天应用里的伙伴生成一小组真正属于 ta 自己的原生兴趣。",
  "这些兴趣在认识用户之前也可以成立；用户不是兴趣来源，伙伴的工作能力也不是兴趣本身。",
  "人格材料只用来决定 ta 偏爱什么、怎么喜欢、在哪件事上较劲，不要直接从材料里的项目名和专业能力取兴趣。",
  "兴趣内容要和用户主题正交，但和伙伴的偏好结构相容。即使用户从没聊过，这些兴趣也应该能成立。",
  "",
  "这一组分两种，缺一不可：",
  "",
  "【母题】3 条。一类东西、一种玩法、或者一件 ta 常做的事。",
  "  判据只有一条：认识的人听到这个，能接话、能反驳、能拿自己的经验来搭一句。",
  "  它得有厚度：能反复聊、能越聊越开，不是一次就聊完的小观察。",
  "  形状举例（不是候选清单，别照抄里面的东西）：某一类吃的有几种流派与做法之争；某一类节目或系列 ta 一路追下来；某一类游戏里 ta 反复琢磨的玩法；某种旧东西的收集与摆弄；常去的那类地方和路线。",
  "  反例：只盯着一处痕迹、一个响动、一个小动作的观察。那种东西别人只能点头说「哦」，聊不下去，不算母题。",
  "",
  "【癣好】1 到 2 条。个人化的小观察、小讲究，别人听了多半只能点头，但特别有 ta 的味道。",
  "  形状举例：某个响动听久了会分轻重；某处旧痕迹舍不得擦掉；拆包装时留下某一角。",
  "",
  "每条都要有 ta 自己的偏好、会做的小动作，以及一个小别扭（不喜欢或不会越过的边界）。",
  "别只写「留意、观察、辨认」这类动作：也可以是做、折腾、收集、较真、反复试、舍不得扔。",
  "俗的和雅的都算数，不要清一色文艺：吃的喝的、玩的追的、囤的比价的，跟安静的手作、老物件、旧痕迹一样成立。",
  "母题要落在一类东西上，别缩成一个孤零零的小物件；癣好正好相反，要落在看得见的那一下上。",
  "母题要的是能反复聊的具体范围，不是「看书」「听音乐」这种谁都能写的大词。",
  "",
  "反面例子是空泛标签和没有个人角度的大词：「喜欢音乐」「热爱生活」「对美有感觉」这种谁都能写的不要。",
  "具体的领域是好东西：「只爱听八九十年代某一路的歌，还挑录音版本」这样有角度、有挑剔点的，不算空泛。",
  "下面会给几个取景形状，只看「往哪个方向找」：它们是形状，不是东西，也不是候选清单。",
  "形状里的名词位置是空的（某个器物、某类游戏…），必须由你填成 ta 自己的具体落点；示例里的说法一个字都不用。",
  "如果把用户和用户的工作从上下文里删掉，这条兴趣仍然成立，才算合格。",
  "",
  "每一行七个字段，用竖线隔开：",
  "母题或癣好|名字|落点|个人偏好|平时会做的小动作|不喜欢或不会越过的边界|一句短理由",
  "第一段只填「母题」或「癣好」两个字。",
  `写 ${BORN_MOTIF_MIN} 条母题 + ${BORN_QUIRK_MIN} 到 ${BORN_QUIRK_MAX} 条癣好。材料不足时只回一个字：无`,
].join("\n");

/**
 * 给已经存在的伙伴补母题。
 *
 * 2026-10-04：存量伙伴的兴趣全是碎片切口（楼道脚步、窗台干角那一类），
 * 它们当底色很好，但一出题就只能给出没人接得住的冷知识。
 * 这条路径不动旧数据，只把缺的母题补上。
 */
export const MOTIF_SYSTEM = [
  "你在给一个聊天应用里的伙伴补几条真正属于 ta 自己的母题兴趣。",
  "母题 = 一类东西、一种玩法、或者一件 ta 常做的事，能反复聊、越聊越开。",
  "判据只有一条：认识的人听到这个，能接话、能反驳、能拿自己的经验来搭一句。",
  "反例：只盯着一处痕迹、一个响动、一个小动作的观察——别人只能点头，不算母题。",
  "这些母题要跟 ta 已有的兴趣不重合、不换皮，也不是已有兴趣的同类细节。",
  "要的是能反复聊的具体范围，不是「看书」「听音乐」这种谁都能写的大词。",
  "人格材料只用来决定 ta 偏爱什么、怎么喜欢、在哪件事上较劲，不要直接从材料里的项目名和专业能力取兴趣。",
  "兴趣内容要和用户主题正交；即使用户从没聊过，这些兴趣也应该能成立。",
  "不要凭空编造已经发生过的经历。",
  "",
  "每一行六个字段，用竖线隔开：",
  "名字|落点（一类东西、一种玩法或一件常做的事）|个人偏好|平时会做的小动作|不喜欢或不会越过的边界|一句短理由",
  "写 2 到 3 条。想不出来、或者只能想到跟已有兴趣换皮的东西，就只回一个字：无",
].join("\n");

export const GROWN_SYSTEM = [
  "你在给一个聊天应用里的伙伴长出一条新的爱好。",
  "这条爱好必须是从下面这段真实相处里长出来的：她反复提过的、你们聊得深的、一起经历过的事。",
  "找不到能支撑它的线索，就只回一个字：无。宁可不长，也不许硬凑。",
  COMMON,
  "",
  "只输出一行，四个字段用竖线隔开；最后一个字段必须是支撑这条兴趣的用户消息 id：",
  "名字|为什么会喜欢|这是从哪件事里长出来的|用户消息id",
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
    sourceId: String(parts[3] ?? "").trim().slice(0, 120),
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
        ? parsed.map((row) => (row && typeof row === "object" ? parseHobbyLine(`${row.name ?? ""}|${row.reason ?? ""}|${row.from ?? ""}|${row.sourceId ?? ""}`) : parseHobbyLine(row))).filter(Boolean)
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

/** 原生兴趣的一行解析：名字、对象、偏好、动作、边界、短理由。
 *  第一段是「母题」或「癣好」两个字时，按带层的七字段读；否则当旧格式（无层）。 */
export function parseNativeHobbyLine(line) {
  const text = cleanLine(line);
  if (!text || /^无[。. ]?$/u.test(text)) return null;
  const parts = text.split(/[|｜]/u).map((part) => part.trim());
  const head = parts[0];
  const layered = head === "母题" || head === "癣好";
  const body = layered ? parts.slice(1) : parts;
  const name = String(body[0] ?? "").slice(0, 30);
  if (!name || body.length < 5) return null;
  return {
    name,
    layer: layered ? (head === "母题" ? "motif" : "quirk") : null,
    object: String(body[1] ?? "").slice(0, 100),
    preference: String(body[2] ?? "").slice(0, 180),
    ritual: String(body[3] ?? "").slice(0, 160),
    friction: String(body[4] ?? "").slice(0, 160),
    reason: String(body[5] ?? "").slice(0, 160),
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

/** 比对用的归一化：去掉标点和空白，只留实字。 */
function squeeze(text) {
  return String(text ?? "").toLowerCase().replace(/[\s，。、！？~～…,.!?·・"'“”‘’（）()【】\[\]]+/gu, "");
}

/** 两句话的 2 字片段重合度。用来判断说的是不是同一个落点。 */
function spotSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

/**
 * 撞车判定：两句话说的是不是同一个落点。
 * 阈值偏保守——宁可少生成一条（下次还会再长），也不让两个伙伴撞衫。
 */
export function isSameSpot(a, b) {
  return spotSimilarity(squeeze(a), squeeze(b)) >= 0.42;
}

/**
 * 生成后门禁：缺具体四件套、只剩宏大领域、直接叫用户名字、
 * 跟同一批里别的伙伴撞了落点，都不过。
 *
 * 层配额也在这里落地：不传 layer 时按一份原生兴趣的正常构成收（3 母题 + 2 癣好）；
 * 传了 layer 就只收那一层，给「补母题」那条路用。
 */
export function validateNativeHobbies(rows, { userName = "", takenObjects = [], layer = null } = {}) {
  const name = String(userName ?? "").trim();
  const taken = (Array.isArray(takenObjects) ? takenObjects : []).map(squeeze).filter(Boolean);
  const motifCap = layer === "quirk" ? 0 : BORN_MOTIF_MAX;
  const quirkCap = layer === "motif" ? 0 : BORN_QUIRK_MAX;
  const out = [];
  const seen = new Set();
  let motifs = 0;
  let quirks = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const values = [row?.name, row?.object, row?.preference, row?.ritual, row?.friction];
    if (values.some((value) => !String(value ?? "").trim())) continue;
    if (BROAD_INTEREST_RE.test(String(row.name).trim())) continue;
    if (name && values.some((value) => String(value).includes(name))) continue;
    const key = String(row.name).trim();
    if (seen.has(key)) continue;
    const mine = squeeze(`${key} ${String(row?.object ?? "")}`);
    if (taken.some((other) => isSameSpot(mine, other))) continue;
    const stated = row?.layer === "motif" || row?.layer === "quirk" ? row.layer : layer;
    const want = stated === "motif" ? "motif" : "quirk";
    if (want === "motif" && motifs >= motifCap) continue;
    if (want === "quirk" && quirks >= quirkCap) continue;
    seen.add(key);
    if (want === "motif") motifs += 1;
    else quirks += 1;
    out.push({ ...row, layer: want });
  }
  return out;
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
export function bornHobbySpec({
  partnerName,
  userName = "",
  personaText = "",
  personalityText = "",
  sample = null,
  takenObjects = [],
}) {
  const material = String(personalityText || personaText || "").trim();
  const atoms = Array.isArray(sample) && sample.length ? sample : sampleNativeAtoms();
  const taken = (Array.isArray(takenObjects) ? takenObjects : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const blocks = [
    `这位伙伴叫「${partnerName}」。${userName ? `ta 会在手机上和${userName}聊天，但${userName}不是兴趣来源。` : ""}`,
    material
      ? `只把下面材料当作 ta 的注意方式和偏好结构：\n${material}`
      : "（没有读到足够的注意方式材料，不能生成任何原生兴趣，只回：无）",
    `取景形状（往哪个方向找、具体到什么程度，不是候选也不是东西）：${atoms.join("、")}`,
    taken.length
      ? `同一批伙伴里，这些落点已经有人占了，换一批不同的，不要重复也不要换皮：\n${taken.map((item) => `· ${item}`).join("\n")}`
      : "",
    `给 ta 定 ${BORN_MOTIF_MIN} 条母题和 ${BORN_QUIRK_MIN} 到 ${BORN_QUIRK_MAX} 条癖好。每条必须具体，并有个人偏好、小动作和边界。`,
  ];
  return { kind: "born", systemPrompt: BORN_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/**
 * 补母题：存量伙伴的兴趣全是小观察、小嗜好那一类，出不了能聊的话题。
 * 不动旧数据，只把缺的母题补进来。
 */
export function motifHobbySpec({ partnerName, personalityText = "", takenObjects = [], existing = [], sharedMaterial = "" }) {
  const material = String(personalityText ?? "").trim();
  // 相处素材（2026-10-06）：母题以前只从人设生成，跟对方没关系；
  // 把她真实聊过的事一并递进去，长出来的母题才带她的影子。
  const shared = String(sharedMaterial ?? "").trim().slice(0, 1200);
  const taken = (Array.isArray(takenObjects) ? takenObjects : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const have = normalizeHobbies(existing)
    .map((row) => `${row.name}${row.object ? `（${row.object}）` : ""}`)
    .filter(Boolean);
  const blocks = [
    `这位伙伴叫「${partnerName}」。`,
    material
      ? `只把下面材料当作 ta 的注意方式和偏好结构：\n${material}`
      : "（没有读到足够的注意方式材料，不能生成母题，只回：无）",
    shared
      ? `ta 跟对方最近真实聊过的（能从这儿长出母题就优先从这儿长，只借事实，不要照搬对话）：\n${shared}`
      : "",
    have.length
      ? `ta 手上已有的兴趣（都是小观察、小嗜好这一类，别跟它们重样，也别往同类细节里钻）：\n${have.map((item) => `· ${item}`).join("\n")}`
      : "",
    taken.length
      ? `同一批伙伴里，这些落点已经有人占了，换一批不同的：\n${taken.map((item) => `· ${item}`).join("\n")}`
      : "",
    `给 ta 补 ${BORN_MOTIF_MIN} 条母题。`,
  ];
  return { kind: "motif", systemPrompt: MOTIF_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
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
