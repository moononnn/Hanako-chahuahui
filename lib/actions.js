/**
 * 小动作 —— 只有一个动作。
 *
 * 2026-09-12 定稿：之前把它扩成了九个（戳、拍、亲、抱、舔、捏、揉、喷、踢），
 * 每边各九格文案、九行设置、九次预热。想清楚之后其实是把一件事做复杂了：
 * 「戳一戳」「拍了拍」这些**本来就是同一个动作的不同叫法**，也就是一句文案的差别。
 *
 * 所以现在：**动作只有一个**，`ACTION_STYLES` 里的那些只是它可选的叫法，
 * 换叫法就是改一个设置，不新增动作、不重写文案。句子里的动作词是 `{verb}` 槽位，
 * 所以换叫法之后老文案照样读得通。
 *
 * 两条铁规矩没变（之前纠正过两次，别自作聪明改）：
 *
 * 1. **文案归被做的那一方。**
 *    做给伙伴的动作 → 显示**伙伴写的那句**；伙伴做过来 → 显示**她写的那句**。
 *
 * 2. **句式只有一套：`{name}{verb}你的…`**
 *    `{name}` = 动手的那位，「你」= 挨的那位（也就是写这句的人自己）。
 *      · 她做给伙伴 → 「{name}戳了戳你的手背」
 *      · 伙伴做给她 → 「{name}戳了戳你的袖口」
 *
 * 版式仿 QQ：一条居中的淡字，不是气泡。文案**用得上才写**，写不出来就用兜底句，不卡住她。
 */

/** 一个动作，几种叫法。id 沿用旧的那套，方便老数据认领。emoji 是各自的脸，别让它们长得一样。 */
export const ACTION_STYLES = [
  { id: "poke", label: "戳一戳", verb: "戳了戳", emoji: "👉", example: "{name}{verb}你的手背，你把手往回缩了一下" },
  { id: "pat", label: "拍一拍", verb: "拍了拍", emoji: "👋", example: "{name}{verb}你的脑袋，你把思绪抖回原位" },
  { id: "kiss", label: "亲一亲", verb: "亲了亲", emoji: "🥰", example: "{name}{verb}你的额头，你愣了两秒才想起该说什么" },
  { id: "hug", label: "抱一抱", verb: "抱了抱", emoji: "🤗", example: "{name}{verb}你，你把一直僵着的肩膀松下来" },
  { id: "rub", label: "揉一揉", verb: "揉了揉", emoji: "🤲", example: "{name}{verb}你的头发，你眯起眼睛没吭声" },
  { id: "pinch", label: "捏一捏", verb: "捏了捏", emoji: "🤏", example: "{name}{verb}你的脸，你皱了皱眉但没躲" },
  { id: "kick", label: "踢一踢", verb: "踢了踢", emoji: "🥾", example: "{name}{verb}你的椅子腿，你抬头看了他一眼" },
];

export const DEFAULT_STYLE_ID = "poke";
const BY_ID = new Map(ACTION_STYLES.map((a) => [a.id, a]));

/** 文案写法的版本号。改了口径就 +1，旧写法会被自动重写。 */
export const ACTION_VOICE = 9;

/**
 * 写这小动作时能挑的几档调子。
 *
 * 这三档是看真人世界的「拍一拍」归出来的：那边几乎全是自嘲和整活，
 * 落点在「出了什么事」，不在「我有什么感觉」。摆在这里给ta挑，写不写、
 * 挑哪一档ta自己定——跟表性格、跟熟到哪一步都有关系。
 */
export const ACTION_TONES = [
  {
    id: "zichao",
    label: "自嘲",
    note: "拿自己那点没法子的事开玩笑",
    samples: ["{name}{verb}你的肩膀，你晃了晃，还是没想起要说什么", "{name}{verb}你的本子，今天的进度又是个零"],
  },
  {
    id: "zhenghuo",
    label: "整活",
    note: "一本正经地把事情搞砸，荒诞一点",
    samples: ["{name}{verb}你，操作失败，请稍后重试", "{name}{verb}你的屏幕，卡住了，重启也没用"],
  },
  {
    id: "keai",
    label: "可爱",
    note: "软、撒娇，但不腻",
    samples: ["{name}{verb}你的腮帮，噗的一声漏了气", "{name}{verb}你的头发，翘起来一缕，按不下去"],
  },
  {
    id: "xijing",
    label: "戏精",
    note: "给自己发个身份，然后沉浸地演",
    samples: ["{name}{verb}你的椅子，你整了整袖子，开始端架子", "{name}{verb}你的披风，你理了理，架势端起来了"],
  },
  {
    id: "shenghuo",
    label: "生活",
    note: "手边正在过的日子就是全部素材",
    samples: ["{name}{verb}你的碗，筷子掉了一根", "{name}{verb}你的键盘，删掉三十七个字，谁也没看见"],
  },
  {
    id: "wenyi",
    label: "文艺温柔",
    note: "安静、留白、有画面，不逗人也不冷场",
    samples: ["{name}{verb}你的杯沿，茶面上那圈涟漪晃了两下", "{name}{verb}你的额头，你顺势靠回椅背，眼睛闭上了"],
  },
];

const TONE_ALIASES = new Map();
for (const tone of ACTION_TONES) {
  TONE_ALIASES.set(tone.id, tone.id);
  TONE_ALIASES.set(tone.label, tone.id);
}
// ta自己会换词：写得像哪一档就算那一档
for (const [alias, id] of [
  ["自黑", "zichao"],
  ["沙雕", "zichao"],
  ["幽默", "zichao"],
  ["搞笑", "zichao"],
  ["憨", "zichao"],
  ["搞怪", "zhenghuo"],
  ["荒诞", "zhenghuo"],
  ["翻车", "zhenghuo"],
  ["撒娇", "keai"],
  ["软", "keai"],
  ["中二", "xijing"],
  ["扮演", "xijing"],
  ["角色", "xijing"],
  ["日常", "shenghuo"],
  ["干饭", "shenghuo"],
  ["生活流", "shenghuo"],
  ["文艺", "wenyi"],
  ["温柔", "wenyi"],
  ["诗意", "wenyi"],
  ["安静", "wenyi"],
]) {
  if (!TONE_ALIASES.has(alias)) TONE_ALIASES.set(alias, id);
}

/** 档位 id 认得出来的就返回，认不出来返回 null（不耽误写文案）。 */
export function toneById(id) {
  return ACTION_TONES.find((tone) => tone.id === id) ?? null;
}

/** ta回的第一行是「调子|文案」：拆得出来就用，拆不出来就当ta没挑（照样能写）。 */
export function parseToneReply(raw) {
  const value = String(raw ?? "").trim();
  const match = /^(?:调子|风格)?\s*[:：]?\s*([^\n|｜]{1,6})\s*[|｜]\s*([\s\S]+)$/.exec(value);
  if (match) {
    const id = TONE_ALIASES.get(match[1].trim());
    if (id) return { tone: id, text: match[2].trim() };
  }
  return { tone: null, text: value };
}

/** 叫法认领：不认识的 id 一律回到默认，不让设置里的脏数据把动作搞没。 */
export function resolveStyleId(id) {
  return BY_ID.has(String(id ?? "")) ? String(id) : DEFAULT_STYLE_ID;
}

export function isStyleId(id) {
  return BY_ID.has(String(id ?? ""));
}

export function getStyle(id) {
  return BY_ID.get(resolveStyleId(id));
}

export function actionLabel(id) {
  return getStyle(id).label;
}

/** 谁都没写过时的兜底：不花哨，但读得通。 */
export function fallbackLine(id) {
  return `{name}${getStyle(id).verb}你`;
}

function stripActionPrefix(value) {
  if (!value.startsWith("{name}")) return value;
  let rest = value.slice("{name}".length);
  if (rest.startsWith("{verb}")) return rest.slice("{verb}".length);
  const style = ACTION_STYLES.find((item) => rest.startsWith(item.verb));
  return style ? rest.slice(style.verb.length) : value;
}

/** 把设置页里的填空尾巴收成一句旧模板，空着就回到默认句。 */
export function actionTemplateFromTail(tail) {
  let out = String(tail ?? "").replace(/\s*\n+\s*/g, " ").trim();
  out = out.replace(/^(?:我的|你的)\s*/u, "").slice(0, 34);
  return out ? `{name}{verb}你的${out}` : "{name}{verb}你";
}

/** 从旧的完整模板里取出“我的”后面那截，给新设置页显示。 */
export function actionTailFromTemplate(template) {
  const source = typeof template === "object" && template !== null
    ? (typeof template.tail === "string" ? template.tail : template.text)
    : template;
  let out = String(source ?? "").trim();
  if (!out) return "";
  out = stripActionPrefix(out).trim();
  out = out.replace(/^(?:你的|我的)\s*/u, "").trim();
  const style = ACTION_STYLES.find((item) => out.startsWith(item.verb));
  if (style) out = out.slice(style.verb.length).trim();
  return out === "你" ? "" : out;
}

/**
 * 把 {name} 换成动手的那位、{verb} 换成这个动作现在的叫法。
 * 两边模板都用同样的槽位，所以这里一视同仁：谁做的，就填谁的名字。
 */
export function renderActionLine(id, template, doerName) {
  const style = getStyle(id);
  const tpl = String(template ?? "").trim();
  const who = String(doerName ?? "").trim() || "对方";
  if (!tpl) return fallbackLine(id).replace("{name}", who);
  return tpl.replace(/\{name\}/g, who).replace(/\{verb\}/g, style.verb).replace(/\{label\}/g, style.label).trim();
}

/**
 * 把模型偶尔写歪的口径扳回来。约定很硬，所以能纯机械地修：
 *   · 句首的「你戳…」是把动手的写成了「你」→ 应该换成 {name}
 *   · 模板里的「我」都应该是「你」（挨的那个就是写文案的人自己）
 */
export function normalizeActionVoice(text) {
  let out = String(text ?? "").trim();
  if (!out) return "";
  out = out.replace(/^你(?=\s*[^\s{])/u, "{name}");
  out = out.replace(/我/gu, "你");
  return out;
}

/** 缺槽位就补上：{name} 补到最前面，{verb} 补在 {name} 后面。 */
export function ensurePlaceholders(text) {
  let out = String(text ?? "").trim();
  if (!out) return "";
  if (!out.includes("{name}")) out = `{name}${out}`;
  if (!out.includes("{verb}")) out = out.replace("{name}", "{name}{verb}");
  return out;
}

/**
 * 明显该挡的词：身体暗喻、露骨暧昧。
 *
 * 分寸很要紧——只挡一眼就知道要出事的，别把「椅子腿」的「腿」也拦下来。
 * 部位词（胸/腰/腿…）不机械拦，一刀切只会误伤；「酥」也放过（她拍过：这些词本身没事）。
 * 这里只管「花瓣」这种什么都没说清、却让人自己补全画面的。
 */
const UNSAFE_ACTION_RE = /(花瓣|花蕊|花心|蕊|白兔|软肉|裸|吻痕|娇喘|呻吟|私处|下体|体内)/;

/**
 * 「隐晦的那种」：一个字也不露骨，但整个画面在往身上引。
 *
 * 这一类比露骨词难挡：它不是某个词有问题，是一类写法——
 * 把镜头对准身体内部的感受（发热发烫、心跳、呼吸、发软发麻），或者打个散。
 * 中文言情里这是标准腔，模型一写“亲昵的动作”就自动切过去，
 * 光靠禁两个词拦不住，得整类说清楚。
 *
 * 分寸：只挡体温/心跳/呼吸/发软这一类，别把“椅子腿”的腿、
 * “肩膀一直僵着”的僵也误伤进来（那种是常态描写，不是荡）。
 */
const INSIDE_FEELING_RE =
  /((?:脸|脸颊|耳|耳尖|耳根|脖子|后颈)[^，。！？；]{0,4}(?:热|烫|红|烧)|(?:心(?:跳|口)|呼吸)[^，。！？；]{0,4}(?:快|乱|漏|紧|急|重|砰)|(?:身子|身体|腿|腰|手脚)[^，。！？；]{0,3}(?:软|酥|麻)|(?:一颤|一哆嗦|激灵|战栗))/;

/** 文案有没有踩线（露骨的、隐晦的都不行）。宁可挡掉让ta重写，也别让ta出现在她眼前。 */
export function isSafeActionText(text) {
  const value = String(text ?? "");
  return !UNSAFE_ACTION_RE.test(value) && !INSIDE_FEELING_RE.test(value);
}

/** 两次都写不出来时用什么：这一档的示范句（一定安全）。 */
export function fallbackActionTemplate(id) {
  return getStyle(id).example;
}

/**
 * 像不像一句动作文案：必须带 {name}、带 {verb}、还带「你」。
 * 宁缺勿滥，不合格就退回兜底句。
 */
export function isValidActionTemplate(id, text) {
  if (!isStyleId(id)) return false;
  const t = String(text ?? "").trim();
  if (t.length < 4 || t.length > 48) return false;
  if (!t.includes("{name}")) return false;
  if (!t.includes("{verb}")) return false;
  if (!isSafeActionText(t)) return false;
  return t.includes("你");
}

export function cleanActionTemplate(id, text) {
  const label = actionLabel(id);
  let out = String(text ?? "").trim();
  if (!out) return "";
  const fenced = /^```[\s\S]*?\n([\s\S]*?)```$/u.exec(out);
  if (fenced) out = fenced[1];
  out = out.replace(new RegExp(`^(文案|模板|句子|${label}|戳一戳)\\s*[:：]\\s*`, "u"), "");
  out = out.replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1");
  out = out.replace(/\s*\n+\s*/g, " ").trim();
  out = normalizeActionVoice(out);
  return ensurePlaceholders(out).slice(0, 48);
}

// ─────────────────────── 换文案的节奏 ───────────────────────

/** 7~21 天不规律换一版，免得天天同一句。 */
export function nextRotationAt(now = new Date(), rnd = Math.random) {
  const days = 7 + Math.round(rnd() * 14);
  return new Date(now.getTime() + days * 86400000).toISOString();
}

export function needsRotation(entry, now = new Date()) {
  const text = String(entry?.text ?? "").trim();
  if (!text) return true;
  if (entry?.voice !== ACTION_VOICE) return true;
  // 旧文案里带暗喻、踩了线的，下次轮换就换掉它
  if (!isSafeActionText(text)) return true;
  const due = Date.parse(entry?.nextAt ?? "") || 0;
  return due === 0 || now.getTime() >= due;
}

// ─────────────────────── 读写（含旧字段迁移） ───────────────────────

/**
 * 伙伴那格。
 * 新结构：`settings.action`。
 * 旧结构：九格时代是 `settings.actions[poke]`，更早是 `settings.pokeTemplate` —— 都认。
 */
export function readTemplateEntry(settings) {
  const hit = settings?.action;
  if (hit && typeof hit === "object" && hit.text) return hit;
  const bag = settings?.actions;
  const legacy = bag && typeof bag === "object" ? bag[DEFAULT_STYLE_ID] : null;
  if (legacy && typeof legacy === "object" && legacy.text) return legacy;
  if (settings?.pokeTemplate) {
    return {
      text: settings.pokeTemplate,
      voice: settings.pokeVoice,
      updatedAt: settings.pokeTemplateUpdatedAt,
      nextAt: settings.pokeTemplateNextAt,
    };
  }
  return null;
}

/**
 * 她那格。
 * 新结构：`globalSettings.myAction`。
 * 旧结构：`globalSettings.myActions[poke]` / `globalSettings.myPokeTemplate`。
 */
export function readMyTemplateEntry(globalSettings) {
  const hit = globalSettings?.myAction;
  if (hit && typeof hit === "object" && hit.text) return hit;
  const bag = globalSettings?.myActions;
  const legacy = bag && typeof bag === "object" ? bag[DEFAULT_STYLE_ID] : null;
  if (legacy && typeof legacy === "object" && legacy.text) return legacy;
  if (globalSettings?.myPokeTemplate) return { text: globalSettings.myPokeTemplate };
  return null;
}

/** 现在这个动作叫什么（全局一份）。 */
export function readStyleId(globalSettings) {
  return resolveStyleId(globalSettings?.actionStyle);
}

// ─────────────────────── 提示词 ───────────────────────

export function actionTemplateSpec({ styleId, partnerName, personaText, knowingText, adaptationText = "", tone = null }) {
  const style = getStyle(styleId);
  const persona = String(personaText ?? "").trim();
  const knowing = String(knowingText ?? "").trim();
  const last = toneById(tone);
  const toneList = ACTION_TONES.map(
    (t) => `- ${t.label}（${t.note}）：${t.samples.map((s) => `「${s}」`).join("　")}`,
  ).join("\n");
  const systemPrompt = [
    `你要给自己写一句「**被人${style.label}**」的文案。`,
    `意思是：有人${style.label}你的时候，你随口留下的一句话。`,
    "用 {name} 代表动手的那个人，用 {verb} 代表那个动作本身（两个占位符都必须原样保留，不要自己填词）。",
    "重要：**文字里的「你」指的就是你本人**，也就是挨了那一下的这个你。",
    "",
    "挑一档调子来写：",
    toneList,
    "",
    "取材（要紧）：别从通用的段子里挑，从你自己身上取。你手头正在做的事（写了一半的东西、凉了的茶、桌上的物件）、你自己的爱好和习惯，都是料。同样一档调子，写字的人写出来的和拿枪的人写出来的，必须不是同一句。",
    "",
    "开头先写调子名，再用竖线隔开那句话，只输出这一行。像这样：",
    "自嘲|{name}{verb}你的本子，今天的进度又是个零",
    last
      ? `你上次用的是「${last.label}」这一档。关系往前走了一格、或者你心情不一样了，换一档也行。`
      : "头一回写，挑一档你觉着顺手的。",
    "你跟她的距离也会影响你挑哪一档：还生的时候多半收着点，处久了玩笑和整活更容易出口。",
    "",
    "尺度（要紧，逐条对着写）：",
    "- **落点在事，不在感受**：写手边发生了什么（杯子歪了、键盘敲出一串乱码、耳机滑下来），不写你身体里发生了什么",
    "- 东西可以碰，后果也留在东西上。不许「东西被碰、你跟着一热」这种写法",
    "- 反应只有看得见的那一下（缩手、挑眉、笑出声、把椅子往后挪），别叠第二层",
    "- 这一整类都不许写：脸热、耳根发烫、心跳快、呼吸乱、身子发软发麻",
    "- 别用「花瓣」「花蕊」这类含混的词去代指身体",
    `- 就算${style.label}这动作本身靠得近，你的反应也还是写成看得见的那一下`,
    "",
    "另外：",
    "- 一句话，4~48 字，口语，读着通顺，像人随口说的",
    "- 写得具体、有点画面感；写你自己那一侧，不要写对方的长相",
    "- 东西放在手边（杯子、键盘、椅背、桌角）；别往贴身的东西上落（颈饰、腰带、发梢、衣襟）",
    "- 不要用「我」，不要引号，不要解释，不要换行",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    systemPrompt,
    userText: [
      `你是「${partnerName}」。`,
      persona ? `你的人格与底色（只作参考）：\n${persona}` : "",
      knowing ? `你现在的样子（挑调子的时候参考，别念出来）：\n${knowing}` : "",
      adaptationText ? `你们相处出来的理解（只作参考，别念出来）：\n${adaptationText}` : "",
      `现在有人${style.label}你，给自己写一句。`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
