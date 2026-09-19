/**
 * 性格体检标准：把「这一版画像拿去演，会不会演歪」拆成能判定的条目。
 *
 * 分两层用：
 *   · 机械项（inspectPersona）—— 字段、引用、数量、生效状态，代码直接查；
 *   · 判断题（STANDARD_JUDGED + 提示词）—— 具体性、排他性、语料像不像同一个人、会不会出戏，
 *     只能交给模型，标准文本会拼进体检提示词。
 *
 * 三档只有三个词：ok 过得去 / gap 有缺口 / empty 空着。不打总分，分数是假的确定感。
 *
 * 跟写卡 skill（tavern-cards）的关系：具体性、替换测试、二次解释「每条防一种误读」、
 * 语料只留纯对话这几条直接借；世界观、叙事弧线、互动钩子不搬；反过来加了现实幻觉、
 * 假设场景被当成真实回忆、阶段泄漏、提示词稀释这四条茶话会特有的风险。
 */

import { normalizePalette, hasPalette } from "./palette.js";
import { normalizePersonality, hasPersonality } from "./knowing.js";
import { normalizeRecognition, isRecognitionComplete, RECOGNITION_QUESTIONS } from "./recognition.js";

export const LEVELS = Object.freeze(["ok", "gap", "empty"]);
export const LEVEL_LABELS = Object.freeze({ ok: "过得去", gap: "有缺口", empty: "空着" });

/** 四组标准。机械项和判断题都在这儿，id 是稳定契约。 */
export const STANDARD_GROUPS = Object.freeze([
  Object.freeze({
    id: "structure",
    title: "结构",
    note: "字段在不在、内容合不合格、最后会不会真的进提示词。第三样最容易漏。",
    items: Object.freeze([
      Object.freeze({
        id: "coverage",
        title: "结构与生效覆盖",
        machine: true,
        judge: "三面各有哪些格子有内容、内容是否合格，再对照渲染结果看哪些其实进不了提示词。",
      }),
      Object.freeze({
        id: "colorWiring",
        title: "色与行为挂接",
        machine: true,
        judge: "每个色下面有没有活着的行为，有没有「有色却无人演」的空壳色。",
      }),
      Object.freeze({
        id: "reverseCoverage",
        title: "反向约束覆盖",
        machine: true,
        judge: "禁区（不能做什么）和误读（别演成什么）分别有没有具体例子，还是只有空口号。",
      }),
    ]),
  }),
  Object.freeze({
    id: "content",
    title: "内容",
    note: "像不像一个人。",
    items: Object.freeze([
      Object.freeze({
        id: "observable",
        title: "行为可观察",
        machine: false,
        judge: "每条能不能回答「什么场合、怎么说、怎么做」。只有形容词的直接算不合格。",
      }),
      Object.freeze({
        id: "executable",
        title: "行为可执行",
        machine: false,
        judge: "有没有触发条件、反应动作、程度边界；是不是只有行为没有发生条件，或只有禁令没有替代方向。",
      }),
      Object.freeze({
        id: "exclusive",
        title: "排他性",
        machine: false,
        judge: "替换测试：单条换到别的伙伴身上还成立吗，多条组合起来还能不能区分出这个人。",
      }),
      Object.freeze({
        id: "traceable",
        title: "证据可追溯",
        machine: false,
        judge: "只判「档案里有没有留下来源」，不判事情是否真发生过（系统没存这个信息，判不了就诚实说判不了）。",
      }),
      Object.freeze({
        id: "corpus",
        title: "语料成色",
        machine: true,
        judge: "数量、场景覆盖、纯不纯（有没有混动作神态）可以数；像不像同一个人只能判。",
      }),
      Object.freeze({
        id: "consistency",
        title: "三面一致性",
        machine: false,
        judge: "分两问：三面像不像同一个人（语义）；看着矛盾的地方能不能用熟度或场合解释（阶段）。",
      }),
    ]),
  }),
  Object.freeze({
    id: "relation",
    title: "关系",
    note: "茶话会是关系模拟器，不是作品，关系这组是角色卡标准里没有的。",
    items: Object.freeze([
      Object.freeze({
        id: "positioning",
        title: "关系定位",
        machine: false,
        judge: "除了关系标签，有没有亲近程度、称呼、谁通常先开口、基本分寸。",
      }),
      Object.freeze({
        id: "occasions",
        title: "场合与主动权",
        machine: false,
        judge: "什么时候适合找 ta、谁开启、什么时候不要追问；是不是只写了「什么时候想找」。",
      }),
      Object.freeze({
        id: "disclosure",
        title: "披露节奏",
        machine: false,
        judge: "哪些刚认识就能用、哪些熟后才出、有没有触发条件；会不会一上来就把亲密内容全平铺。",
      }),
      Object.freeze({
        id: "boundaryUsable",
        title: "边界可执行",
        machine: false,
        judge: "每条边界能不能落成「场景 + 不要做什么 + 可以怎么接」，还是只能算口号。",
      }),
    ]),
  }),
  Object.freeze({
    id: "risk",
    title: "风险",
    note: "这一组只服务一件事：别让模型演歪。",
    items: Object.freeze([
      Object.freeze({
        id: "misread",
        title: "误读类型覆盖",
        machine: false,
        judge: "客服腔、说教、万能解决、装熟、过度卖弄、无条件顺从，覆盖了几种。",
      }),
      Object.freeze({
        id: "reality",
        title: "现实与主体安全",
        machine: false,
        judge: "有没有把假设场景当成真实经历、替用户声称现实事实、擅自安排用户行动。",
      }),
      Object.freeze({
        id: "dilution",
        title: "重复与稀释",
        machine: false,
        judge: "同一信息在三面重复了几遍；活行为是不是多到模型分不清主次。",
      }),
    ]),
  }),
]);

/** 判断题那一层（进体检提示词用的）。 */
export const STANDARD_JUDGED = Object.freeze(
  STANDARD_GROUPS.flatMap((group) => group.items.filter((item) => !item.machine)
    .map((item) => Object.freeze({ group: group.id, id: item.id, title: item.title, judge: item.judge }))),
);

/** 标准全文（落进提示词，也给人看）。 */
export function standardToText() {
  return STANDARD_GROUPS
    .map((group) => [
      `【${group.title}】${group.note}`,
      ...group.items.map((item) => `- ${item.title}：${item.judge}`),
    ].join("\n"))
    .join("\n\n");
}

const text = (value) => String(value ?? "").trim();

function answerHasBody(answer) {
  if (!answer) return false;
  return Boolean(
    (Array.isArray(answer.selected) && answer.selected.length)
    || text(answer.note)
    || text(answer.text)
    || (Array.isArray(answer.scenarios) && answer.scenarios.length),
  );
}

function scenarioCount(answer) {
  return Array.isArray(answer?.scenarios) ? answer.scenarios.length : 0;
}

/** 语料里混没混动作、神态、心理描写。纯对话的语料才拿来当腔调样本。 */
const IMPURE_CORPUS = /[（(]|笑着|皱了|皱眉|点头|摇头|叹气|看着|低头|沉默|心想|心里/;

/**
 * 机械体检。只查能查的，查不到的一律不猜。
 *
 * @param {object} knowing store.getKnowing 的那份
 * @returns {{items: Array, counts: object, render: object, dossier: object}}
 */
export function inspectPersona(knowing, { now = new Date() } = {}) {
  const personality = normalizePersonality(knowing?.personality);
  const palette = normalizePalette(knowing?.palette);
  const recognition = normalizeRecognition(knowing?.recognition, now);
  const surface = personality.surface ?? { tags: [], signals: [] };
  const inner = personality.inner ?? { tags: [], signals: [] };
  const signals = [...(surface.signals ?? []), ...(inner.signals ?? [])].filter(Boolean);

  const paletteLive = hasPalette(palette);
  const paletteAny = paletteLive || palette.portrait.length > 0 || palette.corpus.length > 0;
  const hasLayers = hasPersonality(personality);
  const recognitionDone = isRecognitionComplete(recognition);

  const items = [];
  const push = (id, level, note, evidence = []) => items.push({ id, level, note, evidence });

  // ── A1 结构与生效覆盖 ──
  {
    const bits = [];
    if (hasLayers) bits.push(`两层画像：${[...(surface.tags ?? []), ...(inner.tags ?? [])].join("、") || "无标签"}，具体线索 ${signals.length} 条`);
    else bits.push("两层画像：空");
    bits.push(paletteLive ? `调色盘：${palette.colors.length} 个色 / ${palette.derivatives.filter((row) => row.on).length} 条活行为` : "调色盘：空");
    bits.push(`相处方式：${Object.keys(recognition.answers).length}/${RECOGNITION_QUESTIONS.length} 题`);
    const level = !paletteAny && !hasLayers ? "empty" : (recognitionDone ? "ok" : "gap");
    push("coverage", level, bits.join("；"), [
      { kind: "paletteLive", value: paletteLive },
      { kind: "recognitionDone", value: recognitionDone },
    ]);
  }

  // ── A2 色与行为挂接 ──
  {
    const live = palette.derivatives.filter((row) => row.on);
    const byColor = palette.colors.map((color) => ({
      name: color.name,
      role: color.role,
      live: live.filter((row) => row.colorId === color.id).length,
    }));
    const base = byColor.find((row) => row.role === "base");
    const mains = byColor.filter((row) => row.role === "main");
    const evidence = byColor.map((row) => ({ kind: "color", name: row.name, live: row.live }));
    if (!byColor.length) push("colorWiring", "empty", "还没有色，戏没有落点。", evidence);
    else if (!base || !mains.length) {
      push("colorWiring", "gap", "底色或主色调缺一块，模型抓不住主要样子。", evidence);
    } else if (base.live === 0 || mains.every((row) => row.live === 0)) {
      push("colorWiring", "gap", "色有了，但没有活的行为挂着，演不出来。", evidence);
    } else if (byColor.some((row) => row.live === 0)) {
      push("colorWiring", "gap", `有 ${byColor.filter((row) => row.live === 0).length} 个色没有活行为。`, evidence);
    } else {
      push("colorWiring", "ok", `${byColor.length} 个色都有活行为。`, evidence);
    }
  }

  // ── A3 反向约束覆盖 ──
  {
    const boundaries = recognition.answers?.boundaries;
    const misreadings = recognition.answers?.misreadings;
    const bHas = answerHasBody(boundaries);
    const mHas = answerHasBody(misreadings);
    const bDeep = scenarioCount(boundaries) > 0 || Boolean(text(boundaries?.text));
    const mDeep = scenarioCount(misreadings) > 0 || Boolean(text(misreadings?.text));
    const evidence = [
      { kind: "boundaries", scenarios: scenarioCount(boundaries), hasText: Boolean(text(boundaries?.text)) },
      { kind: "misreadings", scenarios: scenarioCount(misreadings), hasText: Boolean(text(misreadings?.text)) },
    ];
    if (!bHas && !mHas) push("reverseCoverage", "empty", "两题都没答，模型不知道什么不能做。", evidence);
    else if (!bHas || !mHas) push("reverseCoverage", "gap", "只答了一边，另一边的雷没标出来。", evidence);
    else if (!bDeep || !mDeep) push("reverseCoverage", "gap", "只选了词，没有具体例子，拦不住。", evidence);
    else push("reverseCoverage", "ok", "两边都有具体例子。", evidence);
  }

  // ── B5 语料成色（数量与纯度部分） ──
  {
    const speech = recognition.answers?.speech;
    const speechText = text(speech?.text);
    const scenes = palette.corpus;
    const lines = scenes.reduce((sum, row) => sum + row.lines.length, 0);
    const impure = scenes.flatMap((row) => row.lines.filter((line) => IMPURE_CORPUS.test(line)));
    const evidence = [
      { kind: "speechSample", value: Boolean(speechText) },
      { kind: "corpusScenes", value: scenes.length },
      { kind: "corpusLines", value: lines },
    ];
    if (!speechText && !lines) push("corpus", "empty", "一句真人原话都没有，腔调学不到。", evidence);
    else if (!speechText && lines < 2) push("corpus", "gap", "语料太少，撑不起一个人的腔调。", evidence);
    else if (!speechText) push("corpus", "gap", "只有调色盘里的语料，没有她那边的原话样本。", evidence);
    else push("corpus", "ok", `有原话样本${lines ? `，另外 ${scenes.length} 个场景的语料` : ""}。`, evidence);
    if (impure.length) {
      items.push({
        id: "corpusPurity",
        level: "gap",
        note: `有 ${impure.length} 句语料混了动作或神态，纯对话才拿来当腔调。`,
        evidence: impure.slice(0, 3).map((line) => ({ kind: "impure", line })),
      });
    } else if (lines) {
      items.push({ id: "corpusPurity", level: "ok", note: "语料都是纯对话。", evidence: [] });
    }
  }

  // ── 渲染覆盖提示（不是缺陷，是必须知道的事） ──
  const render = {
    paletteOverridesPersonality: paletteLive,
    note: paletteLive
      ? "有调色盘时，注入给模型的是调色盘，两层画像不再进提示词；性格页上展示的标签跟实际生效的可能不是同一份。"
      : "没有调色盘，注入用的是两层画像。",
  };

  return {
    items,
    counts: items.reduce((acc, item) => ({ ...acc, [item.level]: (acc[item.level] ?? 0) + 1 }), { ok: 0, gap: 0, empty: 0 }),
    render,
    dossier: {
      surfaceSignals: (surface.signals ?? []).filter(Boolean),
      innerSignals: (inner.signals ?? []).filter(Boolean),
      tags: [...new Set([...(surface.tags ?? []), ...(inner.tags ?? [])].filter(Boolean))],
      colors: palette.colors.map((color) => ({
        id: color.id,
        name: color.name,
        role: color.role,
        // 带上每行的 id：不带的话模型只能拿原话去猜，derivative_update 就指不准。
        rows: palette.derivatives
          .filter((row) => row.colorId === color.id && row.on)
          .map((row) => ({ id: row.id, text: row.text })),
      })),
      portrait: palette.portrait,
      corpus: palette.corpus,
      answers: recognition.answers,
      completed: recognitionDone,
      questionIds: RECOGNITION_QUESTIONS.map((question) => question.id),
    },
  };
}

/**
 * 把档案摊成给模型看的客观材料（体检用）。
 * 跟 buildKnowingText 的区别：那份是「你就是这个人」的口吻给伙伴自己看，这份是给审阅者看的账。
 */
export function renderDossier(knowing, { userName = "她" } = {}) {
  const { dossier } = inspectPersona(knowing);
  const lines = [];

  lines.push("【两层画像】");
  if (dossier.tags.length) lines.push(`标签：${dossier.tags.join("、")}`);
  if (dossier.surfaceSignals.length) lines.push(`表层线索：${dossier.surfaceSignals.join("；")}`);
  if (dossier.innerSignals.length) lines.push(`里层线索：${dossier.innerSignals.join("；")}`);
  if (!dossier.tags.length && !dossier.surfaceSignals.length && !dossier.innerSignals.length) lines.push("（空）");

  lines.push("\n【性格调色盘】");
  if (dossier.colors.length) {
    const roleLabel = { base: "底色", main: "主色调", accent: "点缀" };
    for (const color of dossier.colors) {
      // id 要写出来：不写模型只能拿色名去猜，猜出来的落不到档案上。
      lines.push(`- ${roleLabel[color.role] ?? color.role}「${color.name}」（colorId: ${color.id}）`);
      if (!color.rows.length) lines.push("  · （没有活的行为）");
      for (const row of color.rows) lines.push(`  · （derivativeId: ${row.id}）${row.text}`);
    }
  } else lines.push("（空。要加色用 color_add，不要拿 derivative_add 硬塞）");
  if (dossier.portrait.length) {
    lines.push("自画像：");
    for (const row of dossier.portrait) lines.push(`- 关于「${row.title}」：${row.text}`);
  }
  if (dossier.corpus.length) {
    lines.push("语料：");
    for (const row of dossier.corpus) lines.push(`- ${row.scene ? `${row.scene} → ` : ""}${row.lines.map((line) => `「${line}」`).join("")}`);
  }

  lines.push("\n【一起聊出来的相处方式】");
  const answers = dossier.answers ?? {};
  const found = Object.keys(answers).length > 0;
  for (const question of RECOGNITION_QUESTIONS) {
    const answer = answers[question.id];
    if (!answer) continue;
    const avoid = question.intent === "avoid";
    const labels = (answer.selected ?? [])
      .map((id) => question.options.find((option) => option.id === id)?.text)
      .filter(Boolean);
    const parts = [];
    if (labels.length) parts.push(`${avoid ? "要避开" : "选了"}：${labels.join("；")}`);
    if (text(answer.note)) parts.push(`修正：${answer.note}`);
    for (const scenario of answer.scenarios ?? []) {
      parts.push(avoid ? `场景：${scenario.scene}；不要：${scenario.reaction}` : `场景：${scenario.scene}；会：${scenario.reaction}`);
    }
    if (text(answer.text)) parts.push(`${question.id === "speech" ? "原话样本" : "自己说"}：${answer.text}`);
    if (parts.length) {
      const clean = parts.map((part) => part.replace(/[。；，、]+$/u, ""));
      lines.push(`- ${question.title}（questionId: ${question.id}）｜${clean.join("。")}。`);
    }
  }
  if (!found) lines.push("（还没走完「认真认识 ta」）");

  lines.push(`\n【采访进度】${dossier.completed ? "七题都答完了" : `${Object.keys(dossier.answers ?? {}).length}/7 题`}`);
  lines.push(`（这份材料里的「你」指跟伙伴说话的那个人，即 ${userName}。）`);
  return lines.join("\n");
}
