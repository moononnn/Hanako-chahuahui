/**
 * 「认识 ta」采访：纯数据与渲染逻辑。
 *
 * 选项只是抓手；用户勾选、删改和自由输入才是回答本身。
 * 原话保留在 answers 里，渲染给模型时才整理成一段可读材料。
 */

export const RECOGNITION_QUESTIONS = Object.freeze([
  Object.freeze({
    id: "relationship",
    title: "你和 ta 在茶话会里算什么关系？",
    hint: "挑最像的，最多两个；不算的关系也能补着写下来。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "friend", text: "朋友，想到什么就能来聊两句" }),
      Object.freeze({ id: "old_friend", text: "认识挺久的朋友，彼此有些默契" }),
      Object.freeze({ id: "companion", text: "陪着彼此过日子的伙伴" }),
      Object.freeze({ id: "debate", text: "会互相较劲、但不轻易走散的人" }),
    ]),
  }),
  Object.freeze({
    id: "traits",
    title: "你记得 ta 做过哪些让你觉得‘这就是 ta’的事？",
    hint: "挑最像的一两条，再说说你真正想留下哪一部分。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "notice", text: "会注意到话里的小变化" }),
      Object.freeze({ id: "truth", text: "遇到问题会先把事实理清" }),
      Object.freeze({ id: "tease", text: "偶尔从意外的角度接话或开玩笑" }),
      Object.freeze({ id: "boundary", text: "愿意亲近，但有自己的分寸" }),
    ]),
  }),
  Object.freeze({
    id: "occasions",
    title: "什么时候你会想找 ta？",
    hint: "挑最有感觉的场合，最多两个；也可以写‘什么时候不要找我’。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "daily", text: "随口扯点日常小事" }),
      Object.freeze({ id: "share", text: "看到好玩的东西，想第一时间分享" }),
      Object.freeze({ id: "upset", text: "被什么事气到，想吐槽几句" }),
      Object.freeze({ id: "quiet", text: "心里有点东西，但暂时不想认真解决" }),
    ]),
  }),
  Object.freeze({
    id: "response",
    title: "你随口扯的时候，希望 ta 怎么接？",
    hint: "挑最想要的接话姿势，最多两个，越具体越好。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "follow", text: "先顺着我的话聊，不急着上价值" }),
      Object.freeze({ id: "facts", text: "先帮我把事实和重点捋清楚" }),
      Object.freeze({ id: "joke", text: "接住情绪后，拐一点轻松的玩笑" }),
      Object.freeze({ id: "space", text: "看出我不想展开时，给我留点空间" }),
    ]),
  }),
  Object.freeze({
    id: "speech",
    title: "ta 打字在你印象里是什么样？",
    hint: "选形状，最多两个；要是能想起 ta 平时怎么发消息，下面原样贴一两句最好（照抄，别改）。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "short", text: "短句、连发，像手机上随手说的" }),
      Object.freeze({ id: "paragraph", text: "一口气说一整段，逻辑比较完整" }),
      Object.freeze({ id: "colloquial", text: "口语多，带一点固定的口头语" }),
      Object.freeze({ id: "precise", text: "用词讲究，会在意一句话落得准不准" }),
    ]),
  }),
  Object.freeze({
    id: "boundaries",
    intent: "avoid",
    title: "有什么是 ta 绝对不能做的？",
    hint: "这里选的是 ta 绝对不能做的事，最多两个。场景只是帮你判断禁区，不是在选 ta 应该怎么回应。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "lecture", text: "不能把闲聊变成说教或上课" }),
      Object.freeze({ id: "task", text: "不能把聊天变成派活、催办或工作流" }),
      Object.freeze({ id: "fake", text: "不能为了亲近，硬装熟或假装懂我" }),
      Object.freeze({ id: "overdo", text: "不能把某种性格演得过头，压过真实对话" }),
    ]),
  }),
  Object.freeze({
    id: "misreadings",
    intent: "avoid",
    title: "你最怕模型把 ta 演成什么？",
    hint: "这里选的是你最不希望 ta 被演成的样子，最多两个。场景只帮你判断哪种演法最歪。",
    maxSelect: 2,
    options: Object.freeze([
      Object.freeze({ id: "客服", text: "一开口就像客服，句句都在询问需求" }),
      Object.freeze({ id: "万能", text: "什么都懂、什么都能完美解决" }),
      Object.freeze({ id: "sweet", text: "只剩下温柔顺从，没有自己的棱角" }),
      Object.freeze({ id: "loud", text: "为了显得有个性，句句都在抢戏" }),
    ]),
  }),
]);

const MAX_TEXT = 1200;
/** 读盘归一时的宽上限：历史答案一个都不裁，保住她已经答过的内容 */
const MAX_SELECTED = 8;
/** 新提交时的上限：一条题最多两个，逼出「最像的」而不是「全都像」 */
const MAX_SELECTED_KEPT = 2;
/** 场景方向：一个场景只留一条，总共不超过六条。
 * 同一个场景留两条不同反应，模型就不知道该听哪条，两种都学一点，反而哪个都不像。 */
const MAX_SCENARIOS_KEPT = 6;
const MAX_SCENARIOS_PER_SCENE = 1;
/** 场景描述和反应各自的上限；实测最长 42 / 51 字，这里只当防小作文的兜底 */
const MAX_SCENE_CHARS = 50;
const MAX_REACTION_CHARS = 70;

const clean = (value, limit = MAX_TEXT) => String(value ?? "").trim().slice(0, limit);
const MAX_SCENARIOS = 12;

/**
 * 两段短文本有多像（字符二元组重合率，0~1）。
 * 用来挡住「同一个场景写好几遍」和「同一句话换个说法再给一遍」。
 */
function textSimilarity(a, b) {
  const norm = (value) => String(value ?? "").replace(/[\s，。、；：！？,.!?;:"'“”‘’（）()【】\[\]]/g, "");
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const grams = (value) => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let hit = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) hit += 1;
  return (2 * hit) / (leftGrams.size + rightGrams.size);
}

/** 用户挑的场景方向也有上限：一个场景最多两条，总数不超过六条。 */
function trimScenarios(rows) {
  const out = [];
  const perScene = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (out.length >= MAX_SCENARIOS_KEPT) break;
    const used = perScene.get(row.scene) ?? 0;
    if (used >= MAX_SCENARIOS_PER_SCENE) continue;
    perScene.set(row.scene, used + 1);
    out.push(row);
  }
  return out;
}

function normalizeScenarios(answer) {
  const source = Array.isArray(answer?.scenarios)
    ? answer.scenarios
    : answer?.scenario && typeof answer.scenario === "object" ? [answer.scenario] : [];
  const seen = new Set();
  return source
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ scene: clean(item.scene, MAX_SCENE_CHARS), reaction: clean(item.reaction, MAX_REACTION_CHARS) }))
    .filter((item) => {
      const key = `${item.scene}\u0000${item.reaction}`;
      if (!item.scene || !item.reaction || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SCENARIOS);
}

function safeIso(value, fallback = new Date()) {
  const date = new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function parseSuggestionJson(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续从外围文字里找 JSON */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

export function recognitionSuggestionSpec({ question, recognition, partnerName = "" } = {}) {
  const current = question ?? questionById(recognition?.current);
  if (!current) return null;
  const state = normalizeRecognition(recognition);
  const answer = state.answers[current.id] ?? {};
  const labels = (Array.isArray(answer.selected) ? answer.selected : [])
    .map((id) => current.options.find((option) => option.id === id)?.text)
    .filter(Boolean);
  const parts = [];
  if (labels.length) parts.push(`选了：${labels.join("；")}`);
  if (answer.note) parts.push(`修正：${answer.note}`);
  const scenarios = normalizeScenarios(answer);
  if (scenarios.length) {
    parts.push(`已选创作方向：${scenarios.map((item) => `场景：${item.scene}；ta的反应：${item.reaction}`).join("；")}`);
  }
  if (answer.text) parts.push(`自己说：${answer.text}`);
  const answerText = parts.join("。") || "（还没有回答）";
  const avoidFocus = current.intent === "avoid";
  const boundaryFocus = current.id === "boundaries"
    ? "这是禁区题：每个场景只是背景，每个反应方向都必须写成 ta 绝对不能采取的行为、说法或越界方式；不要写成推荐做法，也不要写成 ta 应该如何安慰、回应或解决。"
    : avoidFocus
      ? "这是反向题：用户答的是他/她最怕 ta 被演成什么。每个反应方向都必须写成 ta 千万不要演成的样子、说法或做法（比如一开口像客服、什么都懂、只剩温柔顺从、句句抢戏）；全部是要避开的表现，不要写成推荐做法，也不要写成 ta 应该如何回应。"
      : "这是行为理解题：每个反应方向都写成 ta 可能采取的具体说法或做法。";
  const askTail = avoidFocus
    ? "请给出几组以伙伴 ta 为主角的具体场景，以及在这些场景里 ta 最不该出现的表现，帮助用户判断“ta 被演成什么样就最不像 ta”。"
    : "请给出几组以伙伴 ta 为主角的具体场景和反应方向，帮助用户判断“ta在这件事里会怎么表现”。";
  return {
    systemPrompt: `你是茶话会里的创作搭档，正在帮用户把一位伙伴的抽象印象捏成可表现的行为。主角必须是伙伴 ta（这里的 ta 指“${String(partnerName || "这位伙伴").trim()}”），用户只作为触发背景，不能把用户写成场景里的主要行动者。尤其要围绕 ta 如何说话、如何做事、如何回应来写；当前问题若是打字风格，就写 ta 发消息时的句式、节奏、措辞和接话方式。${boundaryFocus}只输出 JSON：{"scenarios":[{"scene":"一件具体的小事","reactions":["反应方向1","反应方向2","反应方向3"]}]}。生成 2 到 4 个彼此不同的假设场景，每个场景给 2 到 3 种有明显差异的反应方向。场景要具体到一件日常小事，反应要写 ta 会怎么说、怎么做，不要只写性格标签。不要把“你怎样”“你遇到什么”当成场景主体，也不要声称这些事真的发生过；这是创作草稿，用户会自己挑、改或否掉。不要重复固定选项，每条 12 到 100 字。${avoidFocus ? "每条反应都必须是“ta 不能这样”“ta 被演成这样就不像 ta”，写成推荐做法的（比如以“先”“可以”“建议”开头）一律算不合格。" : ""}${current.id === "speech" ? "这一题只写 ta 发消息的样子：句式、节奏、口头语、语气词，可以短到几个字，别写动作和神态。" : ""}`,
    userText: `伙伴：${String(partnerName || "这位伙伴").trim()}\n当前问题：${current.title}\n问题提示：${current.hint}\n已有回答：${answerText || "（还没有回答）"}\n${boundaryFocus}\n${askTail}`,
  };
}

/**
 * 候选质检：模型偶尔会把「正向做法」混进反向题，或者同一个场景写好几遍。
 * 这里把不合方向的反应丢掉、把重复的收一收，剩下的才给用户挑。
 * @param {object} question 当前题（看 intent 与 id）
 * @param {Array} rows parseRecognitionSuggestions 的结果
 */
export function sanitizeSuggestions(question, rows) {
  const avoid = question?.intent === "avoid";
  // 禁区题要的是「不能做什么」，反问题要的是「被演歪的样子」。
  // 这里只用「推荐式开头」当筛子：强制关键词会把「把聊天拆成待办清单」这种合格的禁区描述误杀。
  const recommend = /^(先|可以|不妨|建议|应该|试着|最好|记得|尽量)/;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const scene = clean(row?.scene, MAX_SCENE_CHARS);
    if (scene.length < 8) continue;
    const kept = [];
    for (const raw of Array.isArray(row?.reactions) ? row.reactions : []) {
      const reaction = clean(raw, MAX_REACTION_CHARS);
      if (reaction.length < 6) continue;
      if (avoid && recommend.test(reaction)) continue;
      if (kept.some((item) => textSimilarity(item, reaction) >= 0.6)) continue;
      kept.push(reaction);
      if (kept.length >= 3) break;
    }
    if (!kept.length) continue;
    const near = out.find((item) => textSimilarity(item.scene, scene) >= 0.7);
    if (near) {
      for (const reaction of kept) {
        if (near.reactions.length >= 3) break;
        if (near.reactions.some((item) => textSimilarity(item, reaction) >= 0.6)) continue;
        near.reactions.push(reaction);
      }
      continue;
    }
    out.push({ scene, reactions: kept });
    if (out.length >= 4) break;
  }
  return out;
}

export function parseRecognitionSuggestions(raw) {
  const parsed = parseSuggestionJson(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.scenarios ?? parsed?.suggestions);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const item of rows) {
    if (typeof item === "string") {
      const scene = clean(item, 160).replace(/^[“\"'「]|[”\"'」]$/g, "");
      if (scene.length >= 8) out.push({ scene, reactions: [] });
      continue;
    }
    const scene = clean(item?.scene, MAX_SCENE_CHARS);
    const reactions = [...new Set((Array.isArray(item?.reactions) ? item.reactions : [])
      .filter((value) => typeof value === "string")
      .map((value) => clean(value, MAX_REACTION_CHARS))
      .filter((value) => value.length >= 6))].slice(0, 3);
    if (scene.length >= 8 && reactions.length) out.push({ scene, reactions });
  }
  return out.slice(0, 8);
}

export function questionById(id) {
  return RECOGNITION_QUESTIONS.find((question) => question.id === String(id ?? "")) ?? null;
}

export function emptyRecognition(now = new Date()) {
  return {
    version: 1,
    status: "draft",
    current: RECOGNITION_QUESTIONS[0]?.id ?? null,
    answers: {},
    updatedAt: new Date(now).toISOString(),
    completedAt: null,
    everCompleted: false,
  };
}

export function normalizeRecognition(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const answers = {};
  for (const question of RECOGNITION_QUESTIONS) {
    const answer = source.answers?.[question.id];
    if (!answer || typeof answer !== "object") continue;
    const allowed = new Set(question.options.map((option) => option.id));
    const selected = Array.isArray(answer.selected)
      ? [...new Set(answer.selected.map((id) => String(id)).filter((id) => allowed.has(id)))].slice(0, MAX_SELECTED)
      : [];
    const note = clean(answer.note);
    const text = clean(answer.text);
    const scenarios = normalizeScenarios(answer);
    const origin = answer.origin === "scenario" ? "scenario" : "user";
    if (!selected.length && !note && !text && !scenarios.length) continue;
    answers[question.id] = {
      selected,
      note,
      text,
      ...(scenarios.length ? { scenarios } : {}),
      ...(answer.draft === true ? { draft: true } : {}),
      origin,
      updatedAt: safeIso(answer.updatedAt, now),
    };
  }
  const draftQuestion = RECOGNITION_QUESTIONS.find((question) => answers[question.id]?.draft)?.id;
  const firstUnanswered = RECOGNITION_QUESTIONS.find((question) => !answers[question.id])?.id ?? null;
  // 旧记录的 current 可能停在已经回答过的早期题；有未完成题时，恢复应以答案进度为准。
  const savedCurrent = questionById(source.current)?.id ?? null;
  const current = draftQuestion ?? (savedCurrent && (!answers[savedCurrent]
    || (!firstUnanswered && source.status === "draft")) ? savedCurrent : firstUnanswered);
  const complete = RECOGNITION_QUESTIONS.every((question) => answers[question.id]);
  return {
    version: 1,
    status: source.status === "complete" && complete ? "complete" : "draft",
    current,
    answers,
    updatedAt: safeIso(source.updatedAt, now),
    completedAt: source.completedAt && complete ? safeIso(source.completedAt, now) : null,
    // 认识好过一遍的痕迹：重做（清空）之后也留着，不然「入住」会跟着掉，人被门禁挡在外面。
    everCompleted: source.everCompleted === true || Boolean(source.completedAt),
  };
}

export function applyRecognitionAnswer(raw, questionId, answer, now = new Date()) {
  const base = normalizeRecognition(raw, now);
  const question = questionById(questionId);
  if (!question) return base;
  const allowed = new Set(question.options.map((option) => option.id));
  const selected = Array.isArray(answer?.selected)
    ? [...new Set(answer.selected.map((id) => String(id)).filter((id) => allowed.has(id)))].slice(0, MAX_SELECTED_KEPT)
    : [];
  const note = clean(answer?.note);
  const text = clean(answer?.text);
  const scenarios = trimScenarios(normalizeScenarios(answer));
  const origin = answer?.origin === "scenario" ? "scenario" : "user";
  if (!selected.length && !note && !text && !scenarios.length) {
    delete base.answers[question.id];
  } else {
    base.answers[question.id] = {
      selected,
      note,
      text,
      ...(scenarios.length ? { scenarios } : {}),
      origin,
      updatedAt: new Date(now).toISOString(),
    };
  }
  const nextUnanswered = RECOGNITION_QUESTIONS.find((item) => !base.answers[item.id]);
  // 断点只留给还没答完的人。已经全部答过的档案，回头改哪一题都还是「认识好了」：
  // 内容更新，但不再留游标，也不把完成时间重刷一次。
  const next = nextUnanswered ?? null;
  const complete = !next;
  base.current = next?.id ?? null;
  base.status = complete ? "complete" : "draft";
  base.completedAt = complete ? (base.completedAt ?? new Date(now).toISOString()) : null;
  base.updatedAt = new Date(now).toISOString();
  return normalizeRecognition(base, now);
}

export function applyRecognitionDraft(raw, questionId, answer, now = new Date()) {
  const before = normalizeRecognition(raw, now);
  const question = questionById(questionId);
  if (!question) return before;
  // 空草稿不落盘：草稿是给「写到一半」留的，一份空白只会把已经认识好的档案打回没做完。
  const blank = !(Array.isArray(answer?.selected) && answer.selected.length)
    && !clean(answer?.note)
    && !clean(answer?.text)
    && !normalizeScenarios(answer).length;
  if (blank) return before;
  // 先按正式回答算一遍（内容该存的存、选中项该截的截），再决定要不要盖草稿标记。
  const state = applyRecognitionAnswer(raw, questionId, answer, now);
  // 已经认识好一遍的档案：内容照存（改了的别丢），但不打草稿标记、不动游标、
  // 也不把完成态打回「没做完」——她已经答完的东西不该因为回看一眼就变成半成品。
  if (before.status === "complete") return state;
  if (state.answers[question.id]) state.answers[question.id].draft = true;
  state.current = question.id;
  state.status = "draft";
  state.completedAt = null;
  state.updatedAt = new Date(now).toISOString();
  return normalizeRecognition(state, now);
}

export function recognitionToText(raw) {
  const recognition = normalizeRecognition(raw);
  const blocks = [];
  for (const question of RECOGNITION_QUESTIONS) {
    const answer = recognition.answers[question.id];
    if (!answer) continue;
    const avoid = question.intent === "avoid";
    const labels = answer.selected
      .map((id) => question.options.find((option) => option.id === id)?.text)
      .filter(Boolean);
    const parts = [];
    if (labels.length) parts.push(`${avoid ? "要避开：" : "选了："}${labels.join("；")}`);
    if (answer.note) parts.push(`修正：${answer.note}`);
    for (const scenario of normalizeScenarios(answer)) {
      // 条数少了之后每条要点更密，结构词留着读起来才不乱。
      parts.push(avoid
        ? `场景：${scenario.scene}；不要：${scenario.reaction}`
        : `场景：${scenario.scene}；ta 会：${scenario.reaction}`);
    }
    if (answer.text) {
      const sample = question.id === "speech";
      const label = sample
        ? "ta 的原话样本（照抄来的，说话时照着这个腔调和节奏，别照念内容）"
        : answer.origin !== "scenario"
          ? "自己说"
          : avoid ? "要避开的演法" : "创作方向";
      parts.push(`${label}：${answer.text}`);
    }
    if (parts.length) {
      // 「设想的情境，不是真实经历」以前每条方向都戴一顶，七题里重复几十遍；现在移到段首说一次。
      const title = avoid
        ? `${question.title}｜要避开的（下面是设想的情境，不是真实经历）`
        : question.id === "speech"
          ? `${question.title}｜语料样本`
          : `${question.title}（下面是设想的情境，不是真实经历）`;
      blocks.push(`【${title}】${parts.join("。")}`);
    }
  }
  return blocks.join("\n");
}

export function recognitionForResume(raw, now = new Date()) {
  // 认识好过一遍的档案不再设断点：断点续答是给「还没做完」的人准备的。
  // 完成以后再打开就从第一题看起，不再把人扔到最后一题。
  return normalizeRecognition(raw, now);
}

export function isRecognitionComplete(raw) {
  return normalizeRecognition(raw).status === "complete";
}
