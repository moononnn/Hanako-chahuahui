/**
 * 「和小花聊聊」：在现有画像上做小步修订，不清空、不重生成。
 *
 * 分工：这个文件只管纯逻辑（会话状态、提示词组装、建议的应用与回退），
 * 不碰文件、不碰模型。落盘在 store.js，调模型在 index.js。
 *
 * 三条纪律写进代码：
 *   · 协商期不落档案，只有确认应用才写 knowing；
 *   · 建议必须能指到具体目标（哪一题、哪个色、哪条行为），指不到的一律丢掉；
 *   · 应用前先把当前这版存成历史，回退本身也存一条，所以退错了还能退回来。
 *
 * 文件预算豁免：协商的四个阶段（开体、聊、出建议、应用/回退）共享同一套建议形状与校验，
 * 拆开会让「建议白名单」这个最容易出错的地方分散到多处，故保留在一个文件里。
 */

import { RECOGNITION_QUESTIONS, questionById, normalizeRecognition, emptyRecognition } from "./recognition.js";
import { normalizePalette, addColor, addDerivative, updateDerivative } from "./palette.js";
import { normalizePersonality } from "./knowing.js";
import { standardToText } from "./persona-standard.js";

/** 历史保留几版。清了会出问题：回退要先把当前存一条，至少得留得下一格。 */
export const HISTORY_LIMIT = 2;
/** 协商会话活多久。过期就明说失效，不假装续成新会话。 */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** 一次最多攒几条待改建议。多了用户看不清。 */
export const MAX_SUGGESTIONS = 8;
/** 开场最多几句。多了就不像坐下来说话，像念稿。 */
export const MAX_OPENINGS = 3;
/** 模型没写开场时的兜底。它得是能接下去的一句话，不是标题。 */
const FALLBACK_OPENING = "我把 ta 现在这一版整个过了一遍，有几处想跟你对一对。";

const text = (value, limit = 400) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
const MAX_KEEP = 4;
const MAX_GROW = 4;

/** 能落的八种改动。模型只能在这八种里挑，挑不中的建议直接丢掉。 */
export const REVIEW_OPS = Object.freeze([
  "answer_note",
  "answer_text",
  "scenario_add",
  "scenario_update",
  "color_add",
  "derivative_add",
  "derivative_update",
  "portrait_set",
]);

export const OP_LABELS = Object.freeze({
  answer_note: "改一题的修正说明",
  answer_text: "改一题的自由补充",
  scenario_add: "给某题加一条场景",
  scenario_update: "改某题某条场景的反应",
  color_add: "给调色盘加一个色（可以顺便带第一条行为）",
  derivative_add: "给某个色加一条行为",
  derivative_update: "改某条行为",
  portrait_set: "改自画像",
});

/** 落不上时给人看的原因。笼统一句「落不上」等于没说。 */
const SKIP_REASON = Object.freeze({
  answer_note: "找不到这一题",
  answer_text: "找不到这一题",
  scenario_add: "找不到这一题，或这题的场景已经满了",
  scenario_update: "找不到这一题，或这条场景不在了",
  color_add: "这个名字已经用过了，或这个位置已经满了",
  derivative_add: "找不到这个色，或这个色的记录已经满了",
  derivative_update: "找不到这条行为",
  portrait_set: "自画像没写成能用的样子",
});

const COLOR_ROLES = Object.freeze(["base", "main", "accent"]);
// ── 会话 ────────────────────────────────────────────────────

export function emptySession(agentId, now = new Date()) {
  return {
    agentId,
    stage: "idle",
    baseRevision: null,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    diagnosis: null,
    messages: [],
    suggestions: [],
  };
}

/** 读盘归一 + 过期判定。过期的会话说清楚失效，不续。 */
export function normalizeSession(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || !raw.agentId) return null;
  const updatedAt = new Date(raw.updatedAt ?? raw.startedAt ?? now);
  if (Number.isNaN(updatedAt.getTime())) return null;
  if (Date.now() - updatedAt.getTime() > SESSION_TTL_MS) return null;
  const stage = ["idle", "diagnosed", "chatting", "preview"].includes(raw.stage) ? raw.stage : "idle";
  return {
    agentId: String(raw.agentId),
    stage,
    baseRevision: raw.baseRevision ? String(raw.baseRevision) : null,
    startedAt: new Date(raw.startedAt ?? updatedAt).toISOString(),
    updatedAt: updatedAt.toISOString(),
    diagnosis: raw.diagnosis && typeof raw.diagnosis === "object" ? raw.diagnosis : null,
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((row) => row && (row.role === "user" || row.role === "hua"))
      .map((row) => ({ role: row.role, text: text(row.text, 1200), at: row.at ?? null }))
      .slice(-40),
    suggestions: (Array.isArray(raw.suggestions) ? raw.suggestions : [])
      .map(normalizeSuggestion)
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS),
  };
}

export function touchSession(session, patch = {}, now = new Date()) {
  const base = session ?? emptySession(patch.agentId ?? "", now);
  return { ...base, ...patch, updatedAt: new Date(now).toISOString() };
}

// ── 体检 ────────────────────────────────────────────────────

export function diagnosisSpec({ partnerName = "", userName = "她", dossier = "", mechanical = null } = {}) {
  const systemPrompt = [
    `你叫小花，正跟 ${userName} 一起看茶话会里「${partnerName}」这版性格画像。`,
    "你的活儿是审阅，不是改写。看的是这份画像拿去演的时候，会不会演歪、有没有地方撑不住。",
    "",
    "判定标准（照它逐条过一遍，别漏）：",
    standardToText(),
    "",
    "规矩：",
    `1. 每条结论都必须指到档案里的原话，指不到的就别说。原话照抄，不许改写。`,
    "2. 只写有依据的观察，不许编档案里没有的东西。看不出来的地方就说看不出来。",
    "3. 不要用「应该」「建议 ta 要」这种指导腔；说清楚哪里松、松了会怎样就够。",
    "4. 不说分数，不排名次，不用「很好」「优秀」这类空评价。",
    "5. openings 写 2~3 句，一句一条，像刚坐下来连着发过去的几条消息。第一句先应一声，后面顺着把「像的地方」和「还能长稳的地方」各点一下。别串成条目汇报，也别用「首先/其次/另外」这种把话连起来的说法。",
    "6. 「已经很像 ta 的地方」最多三条，「还可以长稳一点的地方」最多三条，宁少勿凑。",
    "7. grow 里的 direction 只写往哪改的方向，一句话，不写成正式的条文。",
    "8. 场景里的假设必须说清楚是假设，不能写成 ta 真经历过。",
    "只输出 JSON，不要别的字：",
    '{"openings":["先应一声的话","点出很像的地方的话","点出还能长稳的地方的话"],"keep":[{"title":"短标题","quote":"档案原话","why":"为什么这点立得住"}],"grow":[{"title":"短标题","quote":"档案原话","why":"松在哪里，会怎么演歪","direction":"往哪改"}]}',
  ].join("\n");

  const mech = mechanical?.items?.length
    ? mechanical.items.map((item) => `- ${item.id}｜${item.level}｜${item.note}`).join("\n")
    : "（没有机械检查结果）";
  const userText = [
    `【档案原文】\n${dossier}`,
    "",
    `【代码先查过一遍的结果】\n${mech}`,
    mechanical?.render?.note ? `\n【渲染提示】${mechanical.render.note}` : "",
    "",
    "现在按标准给出体检结论。",
  ].join("\n");
  return { systemPrompt, userText };
}

function parseJson(raw) {
  const body = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  if (!body) return null;
  try { return JSON.parse(body); } catch { /* 从外围文字里捞 */ }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

function readRows(raw, limit) {
  return (Array.isArray(raw) ? raw : [])
    .map((row) => ({
      title: text(row?.title, 24),
      quote: text(row?.quote, 200),
      why: text(row?.why, 240),
      direction: text(row?.direction, 200),
    }))
    .filter((row) => row.title && (row.quote || row.why))
    .slice(0, limit);
}

/** 开场几句。数组优先，也认老的单句 `opening`；一行一句，多的裁掉。 */
function readOpenings(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
  return list.map((row) => text(row, 240)).filter(Boolean).slice(0, MAX_OPENINGS);
}

export function parseDiagnosis(raw) {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const keep = readRows(parsed.keep, MAX_KEEP);
  const grow = readRows(parsed.grow, MAX_GROW);
  if (!keep.length && !grow.length) return null;
  const openings = readOpenings(parsed.openings ?? parsed.opening);
  // 开场不能空着：空着这屏又变成「报告 + 留言框」了。
  if (!openings.length) openings.push(FALLBACK_OPENING);
  return {
    openings,
    keep,
    grow,
    at: new Date().toISOString(),
  };
}

// ── 协商 ────────────────────────────────────────────────────

export function chatSpec({ partnerName = "", userName = "她", dossier = "", diagnosis = null, messages = [], suggestions = [] } = {}) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .slice(-12)
    .map((row) => `${row.role === "user" ? userName : "小花"}：${row.text}`)
    .join("\n");
  const pending = (Array.isArray(suggestions) ? suggestions : [])
    .map((row, index) => `${index + 1}. ${row.label}`)
    .join("\n");
  const systemPrompt = [
    `你叫小花，正在和 ${userName} 一起修「${partnerName}」在茶话会里的性格画像。`,
    "你说人话，不端着，一次只聊一个地方。她说的时候先听，听懂了再复述一遍确认，别抢着下判断。",
    "",
    "判定标准（你心里得有这杆秤）：",
    standardToText(),
    "",
    "你能落的改动只有这八种，别的都落不了：",
    REVIEW_OPS.map((op) => `- ${op}：${OP_LABELS[op]}`).join("\n"),
    "",
    "规矩：",
    "1. 你只能给建议，不许说已经改了；改动要等她点确认。",
    "2. 每条建议必须能指到具体目标（哪一题、哪个色、哪条行为），指不到就别给。",
    `3. 材料里每个色、每条行为、每道题后面都带着 id（colorId / derivativeId / questionId）。落改动时照拄这些 id，不要拿名字填进去；名字只写在 label 里给 ${userName} 看。`,
    "4. 不改她的原话，她说过的字照用。",
    "5. 不编档案里没有的事，也不替她做决定；她拿不准时你给一个稳的方向，让她点头或否掉。",
    "6. 调色盘是空的、或者缺底色/主色调时，用 color_add 添一个色（可以顺便带第一条行为）；不要在没这个色的时候硬用 derivative_add。底色只要一个，主色调最多两个，点缀最多两个，满了就换别的建议。",
    '只输出 JSON：{"reply":"你要说的话，口语，一段","suggestions":[{"label":"这次想改什么，一句人话","op":"八种之一","questionId":"材料里给的 questionId","colorId":"材料里给的 colorId","derivativeId":"材料里给的 derivativeId","name":"color_add 用：色名，最多 8 字","role":"color_add 用：base/main/accent","scene":"scenario_add 用","reaction":"scenario_add/scenario_update 用","index":0,"text":"answer_note/answer_text/color_add/derivative_add/derivative_update 用","before":"改前（照拄原话）","after":"改后"}]}',
    "suggestions 可以为空数组（还在聊、还没聊清的时候）。一次最多给 3 条。",
  ].join("\n");

  const userText = [
    `【档案原文】\n${dossier}`,
    "",
    diagnosis
      ? `【你刚才的体检结论】\n像的地方：${diagnosis.keep.map((row) => row.title).join("；") || "无"}\n可以长稳的地方：${diagnosis.grow.map((row) => `${row.title}（${row.direction}）`).join("；") || "无"}`
      : "",
    pending ? `【还没确认的待改条目】\n${pending}` : "",
    "",
    `【聊到现在的原话】\n${transcript || "（刚开始）"}`,
    "",
    `现在轮到你说下一句。`,
  ].filter(Boolean).join("\n");
  return { systemPrompt, userText };
}

/** 题目认不出来时，退一步拿标题反查。模型只能看到标题，拿它当 id 填是常事。 */
function resolveQuestionId(value) {
  const key = text(value, 40);
  if (!key) return null;
  const byId = questionById(key);
  if (byId) return byId.id;
  const byTitle = RECOGNITION_QUESTIONS.find((row) => row.title === key)
    ?? RECOGNITION_QUESTIONS.find((row) => row.title.includes(key) || key.includes(row.title));
  return byTitle ? byTitle.id : null;
}

/** 建议的形状校验。目标存不存在由 applySuggestions 判（那儿才有档案）。 */
export function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const op = REVIEW_OPS.includes(raw.op) ? raw.op : null;
  if (!op) return null;
  const suggestion = {
    label: text(raw.label, 60),
    op,
    before: text(raw.before, 240),
    after: text(raw.after, 400),
  };
  if (!suggestion.label) return null;
  if (op === "answer_note" || op === "answer_text") {
    const questionId = resolveQuestionId(raw.questionId);
    if (!questionId) return null;
    suggestion.questionId = questionId;
    suggestion.text = text(raw.text ?? raw.after, 1200);
    if (!suggestion.text) return null;
  } else if (op === "scenario_add") {
    const questionId = resolveQuestionId(raw.questionId);
    if (!questionId) return null;
    suggestion.questionId = questionId;
    suggestion.scene = text(raw.scene, 50);
    suggestion.reaction = text(raw.reaction, 70);
    if (!suggestion.scene || !suggestion.reaction) return null;
  } else if (op === "scenario_update") {
    const questionId = resolveQuestionId(raw.questionId);
    if (!questionId) return null;
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0) return null;
    suggestion.questionId = questionId;
    suggestion.index = index;
    suggestion.reaction = text(raw.reaction ?? raw.after, 70);
    if (!suggestion.reaction) return null;
  } else if (op === "color_add") {
    suggestion.name = text(raw.name, 8);
    suggestion.role = COLOR_ROLES.includes(raw.role) ? raw.role : null;
    suggestion.text = text(raw.text ?? raw.after, 120);
    if (!suggestion.name || !suggestion.role) return null;
  } else if (op === "derivative_add") {
    suggestion.colorId = text(raw.colorId, 40);
    suggestion.text = text(raw.text ?? raw.after, 120);
    if (!suggestion.colorId || !suggestion.text) return null;
  } else if (op === "derivative_update") {
    suggestion.derivativeId = text(raw.derivativeId, 40);
    suggestion.text = text(raw.text ?? raw.after, 120);
    if (!suggestion.derivativeId || !suggestion.text) return null;
  } else if (op === "portrait_set") {
    const rows = (Array.isArray(raw.rows) ? raw.rows : [])
      .map((row) => ({ title: text(row?.title, 12), text: text(row?.text, 400) }))
      .filter((row) => row.title && row.text)
      .slice(0, 5);
    if (!rows.length) return null;
    suggestion.rows = rows;
  }
  return suggestion;
}

export function parseChatReply(raw) {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const reply = text(parsed.reply, 1200);
  const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
    .map(normalizeSuggestion)
    .filter(Boolean)
    .slice(0, 3);
  if (!reply && !suggestions.length) return null;
  return { reply, suggestions };
}

/** 同一目标只留最后一条建议（后面说的算），避免自己跟自己打架。 */
export function mergeSuggestions(existing, incoming) {
  const key = (row) => [row.op, row.questionId ?? "", row.colorId ?? "", row.derivativeId ?? "", row.index ?? "", row.name ?? ""].join("|");
  const out = [...(Array.isArray(existing) ? existing : [])];
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const at = out.findIndex((item) => key(item) === key(row));
    if (at >= 0) out.splice(at, 1, row);
    else out.push(row);
  }
  return out.slice(-MAX_SUGGESTIONS);
}

// ── 应用 ────────────────────────────────────────────────────

function editRecognition(knowing, questionId, mutate) {
  const recognition = normalizeRecognition(knowing?.recognition ?? emptyRecognition());
  const current = recognition.answers?.[questionId] ?? { selected: [], note: "", text: "" };
  const next = mutate({ ...current });
  if (!next) return null;
  const answers = { ...(recognition.answers ?? {}), [questionId]: next };
  return { ...knowing, recognition: normalizeRecognition({ ...recognition, answers }) };
}

/**
 * 落盘前比一下，真变了才算落下。
 * 不能用 `after === before` 判：palette 那套每次都新归一一个对象，引用永远不同，
 * 会把「其实没动」的当成落成功（比如这个色的记录已经满、或者原话一模一样）。
 */
function paletteChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** 色认不出来时拿名字再认一次。 */
function resolveColor(palette, value) {
  const key = text(value, 40);
  if (!key) return null;
  return palette.colors.find((row) => row.id === key) ?? palette.colors.find((row) => row.name === key) ?? null;
}

/** 行为认不出来时拿原话再认一次。 */
function resolveDerivative(palette, value) {
  const key = text(value, 40);
  if (!key) return null;
  return palette.derivatives.find((row) => row.id === key) ?? palette.derivatives.find((row) => row.text === key) ?? null;
}

/**
 * 把攒下来的建议落到档案上。返回新 knowing + 逐条日志。
 * 落不上的（目标没了、超出上限）不报错，记 skipped 在日志里。
 */
export function applySuggestions(knowing, suggestions, { now = new Date() } = {}) {
  let next = { ...knowing };
  const applied = [];
  const skipped = [];
  for (const row of Array.isArray(suggestions) ? suggestions : []) {
    const suggestion = normalizeSuggestion(row);
    if (!suggestion) { skipped.push({ label: text(row?.label, 60) || "（无法识别的一条）", reason: "形状不对" }); continue; }
    let result = null;
    if (suggestion.op === "answer_note" || suggestion.op === "answer_text") {
      const field = suggestion.op === "answer_note" ? "note" : "text";
      result = editRecognition(next, suggestion.questionId, (answer) => {
        if (field === "text" && answer.text === suggestion.text) return null;
        return { ...answer, [field]: suggestion.text };
      });
    } else if (suggestion.op === "scenario_add") {
      result = editRecognition(next, suggestion.questionId, (answer) => {
        const scenarios = Array.isArray(answer.scenarios) ? answer.scenarios : [];
        if (scenarios.length >= 6) return null;
        return { ...answer, scenarios: [...scenarios, { scene: suggestion.scene, reaction: suggestion.reaction }] };
      });
    } else if (suggestion.op === "scenario_update") {
      result = editRecognition(next, suggestion.questionId, (answer) => {
        const scenarios = Array.isArray(answer.scenarios) ? answer.scenarios : [];
        if (!scenarios[suggestion.index]) return null;
        const updated = scenarios.map((item, index) => (index === suggestion.index ? { ...item, reaction: suggestion.reaction } : item));
        return { ...answer, scenarios: updated };
      });
    } else if (suggestion.op === "color_add") {
      const palette = normalizePalette(next.palette);
      const created = addColor(palette, { name: suggestion.name, role: suggestion.role });
      if (paletteChanged(palette, created)) {
        let withRow = created;
        const color = resolveColor(created, suggestion.name);
        if (color && suggestion.text) {
          const added = addDerivative(created, { colorId: color.id, text: suggestion.text, origin: "user" });
          if (paletteChanged(created, added)) withRow = added;
        }
        result = { ...next, palette: withRow };
      }
    } else if (suggestion.op === "derivative_add") {
      const palette = normalizePalette(next.palette);
      // id 对不上就拿名字 / 原话再认一次：模型只能看到名字，拿名字当 id 填是常事。
      const color = resolveColor(palette, suggestion.colorId);
      if (color) {
        const after = addDerivative(palette, { colorId: color.id, text: suggestion.text, origin: "user" });
        if (paletteChanged(palette, after)) result = { ...next, palette: after };
      }
    } else if (suggestion.op === "derivative_update") {
      const palette = normalizePalette(next.palette);
      const row = resolveDerivative(palette, suggestion.derivativeId);
      if (row) {
        const after = updateDerivative(palette, row.id, { text: suggestion.text });
        if (paletteChanged(palette, after)) result = { ...next, palette: after };
      }
    } else if (suggestion.op === "portrait_set") {
      const palette = normalizePalette(next.palette);
      if (JSON.stringify(palette.portrait) !== JSON.stringify(suggestion.rows)) {
        result = { ...next, palette: { ...palette, portrait: suggestion.rows, updatedAt: new Date(now).toISOString() } };
      }
    }
    if (result) { next = result; applied.push(suggestion); }
    else skipped.push({ label: suggestion.label, reason: SKIP_REASON[suggestion.op] ?? "落不上" });
  }
  return { knowing: next, applied, skipped };
}

// ── 历史版本（后悔药） ──────────────────────────────────────

const snapshotOf = (knowing) => ({
  personality: normalizePersonality(knowing?.personality),
  palette: normalizePalette(knowing?.palette),
  recognition: normalizeRecognition(knowing?.recognition ?? emptyRecognition()),
});

/** 对外拿一份快照（界面对照用）。 */
export function snapshotOfKnowing(knowing) {
  return snapshotOf(knowing);
}

export function listHistory(knowing) {
  const rows = Array.isArray(knowing?.history) ? knowing.history : [];
  return rows
    .filter((row) => row && row.snapshot && row.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 把当前这一版存成一条历史，裁到 HISTORY_LIMIT。 */
export function pushHistory(knowing, { reason = "", at = new Date() } = {}) {
  const rows = listHistory(knowing);
  const entry = { at: new Date(at).toISOString(), reason: text(reason, 80), snapshot: snapshotOf(knowing) };
  return { ...knowing, history: [entry, ...rows].slice(0, HISTORY_LIMIT) };
}

/**
 * 应用改动的正式出口：历史里存的是「改前那一版」，当前挂的是改后的内容。
 * 调用方别自己去 pushHistory，顺序反了就会把改完的版本存成历史。
 */
export function commitChange(before, after, { reason = "", at = new Date() } = {}) {
  return { ...after, history: pushHistory(before, { reason, at }).history };
}

/** 回退：先把当前存一条，再写回目标那一版。所以退错了还能再退回来。 */
export function revertTo(knowing, at, { now = new Date() } = {}) {
  const entry = listHistory(knowing).find((row) => row.at === String(at));
  if (!entry) return { ok: false, reason: "找不到这一版", knowing };
  const withHistory = pushHistory(knowing, { reason: "回退前的那版", at: now });
  return {
    ok: true,
    knowing: {
      ...withHistory,
      personality: entry.snapshot.personality,
      palette: entry.snapshot.palette,
      recognition: entry.snapshot.recognition,
    },
  };
}

/** 给历史列表配一句人话摘要：变了几个地方。 */
export function describeChange(before, after) {
  const parts = [];
  const b = snapshotOf(before);
  const a = snapshotOf(after);
  const colorDiff = a.palette.derivatives.length - b.palette.derivatives.length;
  if (colorDiff > 0) parts.push(`多了 ${colorDiff} 条行为`);
  if (colorDiff < 0) parts.push(`少了 ${-colorDiff} 条行为`);
  const colorNames = a.palette.colors.map((row) => row.name).join("、");
  const beforeNames = b.palette.colors.map((row) => row.name).join("、");
  if (colorNames !== beforeNames) parts.push(colorNames ? `色变成${colorNames}` : "色清掉了");
  const answeredBefore = Object.keys(b.recognition.answers ?? {}).length;
  const answeredAfter = Object.keys(a.recognition.answers ?? {}).length;
  if (answeredAfter > answeredBefore) parts.push(`相处方式多了 ${answeredAfter - answeredBefore} 题`);
  const scenariosBefore = countScenarios(b.recognition);
  const scenariosAfter = countScenarios(a.recognition);
  if (scenariosAfter !== scenariosBefore) parts.push(`场景${scenariosAfter > scenariosBefore ? "多了" : "少了"} ${Math.abs(scenariosAfter - scenariosBefore)} 条`);
  const tagsBefore = [...(b.personality.surface.tags ?? []), ...(b.personality.inner.tags ?? [])].join("、");
  const tagsAfter = [...(a.personality.surface.tags ?? []), ...(a.personality.inner.tags ?? [])].join("、");
  if (tagsBefore !== tagsAfter) parts.push("两层画像变了");
  return parts.join("，") || "内容有改动";
}

function countScenarios(recognition) {
  return Object.values(recognition?.answers ?? {})
    .reduce((sum, answer) => sum + (Array.isArray(answer?.scenarios) ? answer.scenarios.length : 0), 0);
}
