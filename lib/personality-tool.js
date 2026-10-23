import { createHash, randomUUID } from "node:crypto";
import {
  normalizePalette, paletteToText, isPaletteDone, ROLE_LIMIT, MAX_COLORS, MAX_ROWS_PER_COLOR, MAX_LIVE_PER_COLOR,
  MAX_COLOR_NAME, MAX_DERIVATIVE, MAX_PORTRAIT_ROWS, MAX_PORTRAIT_TITLE,
  MAX_PORTRAIT, MAX_CORPUS_SCENES, MAX_CORPUS_SCENE, MAX_CORPUS_LINES, MAX_CORPUS_LINE,
} from "./palette.js";
import { commitChange, describeChange } from "./persona-review.js";
import { requirePartnerId } from "./partner-id.js";

const FIELDS = ["colors", "derivatives", "portrait", "corpus"];
const TTL_MS = 30 * 60_000;
const LIMIT = 32;
function warnings(palette) {
  return palette.colors.flatMap((color) => {
    const live = palette.derivatives.filter((row) => row.colorId === color.id && row.on).length;
    if (!live) return [`「${color.name}」没有生效行为，聊天表达块不会单独渲染这个色`];
    return live > MAX_LIVE_PER_COLOR ? [`「${color.name}」已有${live}条活行为，仅前${MAX_LIVE_PER_COLOR}条进入聊天表达块`] : [];
  });
}
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const paletteBody = (palette) => Object.fromEntries(FIELDS.map((key) => [key, palette[key]]));
const fail = (code, message) => { throw Object.assign(new Error(message), { toolCode: code }); };

function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-input", `${label}必须是对象`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("invalid-input", `${label}含未开放字段`);
}
function text(value, max, label) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) fail("invalid-input", `${label}必须为单行文字`);
  const result = value.trim().replace(/\s+/gu, " ");
  if (!result || result.length > max) fail("invalid-input", `${label}长度须为1至${max}字`);
  return result;
}
function rows(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail("invalid-input", `${label}必须为数组，最多${max}条`);
  return value;
}
function id(value) {
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,40}$/u.test(value)) fail("invalid-input", "条目编号无效");
  return value;
}
function unique(list, key, label) {
  if (new Set(list.map((row) => row[key])).size !== list.length) fail("invalid-input", `${label}不可重复`);
}

// 省略的区段原样保留；提交的数组替换该整个区段。拒绝超限，而非让归一化静默裁掉内容。
export function patchPalette(before, patch, now = Date.now()) {
  object(patch, FIELDS, "patch");
  if (!Object.keys(patch).length) fail("invalid-input", "patch不能为空");
  const next = clone(before);
  if (patch.colors !== undefined) {
    const counts = { base: 0, main: 0, accent: 0 };
    next.colors = rows(patch.colors, MAX_COLORS, "性格色").map((row) => {
      object(row, ["id", "name", "role"], "性格色");
      if (!Object.hasOwn(ROLE_LIMIT, row.role) || ++counts[row.role] > ROLE_LIMIT[row.role]) fail("invalid-input", "性格色位置或数量无效");
      const color = { id: id(row.id), name: text(row.name, MAX_COLOR_NAME, "色名"), role: row.role, evidence: [] };
      const old = before.colors.find((item) => item.id === color.id && item.name === color.name && item.role === color.role);
      if (old) color.evidence = old.evidence;
      return color;
    });
    unique(next.colors, "id", "色编号");
    unique(next.colors, "name", "色名");
  }
  if (patch.derivatives !== undefined) {
    next.derivatives = rows(patch.derivatives, MAX_COLORS * MAX_ROWS_PER_COLOR, "行为").map((row) => {
      object(row, ["id", "colorId", "text", "on"], "行为");
      if (row.on !== undefined && typeof row.on !== "boolean") fail("invalid-input", "on必须为布尔值");
      const colorId = id(row.colorId);
      if (row.colorId === undefined || !next.colors.some((color) => color.id === colorId)) fail("invalid-input", "行为必须指向已有的色编号");
      return { id: id(row.id), colorId, text: text(row.text, MAX_DERIVATIVE, "行为"), scope: "common", origin: "user", on: row.on !== false };
    });
    unique(next.derivatives, "id", "行为编号");
  }
  const colorIds = new Set(next.colors.map((row) => row.id));
  const count = new Map();
  for (const row of next.derivatives) {
    if (!colorIds.has(row.colorId)) fail("invalid-input", "删色时须同时处理其行为，不能留下孤立行为");
    count.set(row.colorId, (count.get(row.colorId) || 0) + 1);
    if (count.get(row.colorId) > MAX_ROWS_PER_COLOR) fail("invalid-input", `每个色最多${MAX_ROWS_PER_COLOR}条行为（含停用）`);
  }
  if (patch.derivatives !== undefined) {
    for (const colorId of colorIds) {
      if (next.derivatives.filter((row) => row.colorId === colorId && row.on).length > MAX_LIVE_PER_COLOR) fail("invalid-input", `每色最多${MAX_LIVE_PER_COLOR}条生效行为，多余条目请显式停用`);
    }
  }
  if (patch.portrait !== undefined) next.portrait = rows(patch.portrait, MAX_PORTRAIT_ROWS, "自画像").map((row) => {
    object(row, ["title", "text"], "自画像");
    return { title: text(row.title, MAX_PORTRAIT_TITLE, "自画像标题"), text: text(row.text, MAX_PORTRAIT, "自画像正文") };
  });
  if (patch.corpus !== undefined) next.corpus = rows(patch.corpus, MAX_CORPUS_SCENES, "语料场景").map((row) => {
    object(row, ["scene", "lines"], "语料场景");
    const lines = rows(row.lines, MAX_CORPUS_LINES, "语料句子").map((line) => text(line, MAX_CORPUS_LINE, "语料句子"));
    if (!lines.length) fail("invalid-input", "每个语料场景至少一句话");
    return { scene: text(row.scene, MAX_CORPUS_SCENE, "场景"), lines };
  });
  if (!isPaletteDone(next)) fail("invalid-input", "不能把性格档案清空：至少保留一个色和活行为，或一段自画像");
  next.colors.sort((a, b) => ["base", "main", "accent"].indexOf(a.role) - ["base", "main", "accent"].indexOf(b.role));
  if (fingerprint(paletteBody(before)) === fingerprint(paletteBody(next))) fail("no-change", "内容没有变化，不必保存");
  next.source = "reshaped";
  next.updatedAt = new Date(now).toISOString();
  const normalized = normalizePalette(next);
  if (fingerprint(next) !== fingerprint(normalized)) fail("invalid-input", "内容无法完整保存，请按读取结果核对条目和格式");
  return next;
}

const colorSchema = { type: "object", properties: { id: { type: "string" }, name: { type: "string", maxLength: MAX_COLOR_NAME }, role: { type: "string", enum: ["base", "main", "accent"] } }, required: ["name", "role"], additionalProperties: false };
const derivativeSchema = { type: "object", properties: { id: { type: "string" }, colorId: { type: "string" }, text: { type: "string", maxLength: MAX_DERIVATIVE }, on: { type: "boolean" } }, required: ["colorId", "text"], additionalProperties: false };
export const PERSONALITY_PARAMETERS = {
  type: "object", properties: {
    action: { type: "string", enum: ["read", "preview", "apply"] },
    agentId: { type: "string", description: "目标伙伴的准确编号，不按名字猜测，也不默认当前伙伴" },
    baseRevision: { type: "integer", minimum: 0, description: "preview必填，来自本工具read的revision" },
    patch: { type: "object", description: "preview必填。省略区段不动；传入数组完整替换该区段。色与行为用id关联。不要照抄只读的evidence/origin/scope字段。", properties: {
      colors: { type: "array", maxItems: MAX_COLORS, items: colorSchema },
      derivatives: { type: "array", maxItems: MAX_COLORS * MAX_ROWS_PER_COLOR, items: derivativeSchema },
      portrait: { type: "array", maxItems: MAX_PORTRAIT_ROWS, items: { type: "object", properties: { title: { type: "string", maxLength: MAX_PORTRAIT_TITLE }, text: { type: "string", maxLength: MAX_PORTRAIT } }, required: ["title", "text"], additionalProperties: false } },
      corpus: { type: "array", maxItems: MAX_CORPUS_SCENES, items: { type: "object", properties: { scene: { type: "string", maxLength: MAX_CORPUS_SCENE }, lines: { type: "array", minItems: 1, maxItems: MAX_CORPUS_LINES, items: { type: "string", maxLength: MAX_CORPUS_LINE } } }, required: ["scene", "lines"], additionalProperties: false } },
    }, additionalProperties: false },
    token: { type: "string", description: "apply必填，原样使用preview返回的token；重载后失效" },
    confirm: { type: "boolean", description: "apply须为true；仅在对方已明确同意本次具体改动后提交，不代表宿主权限授权" },
  }, required: ["action", "agentId"], additionalProperties: false,
};

// 预览仅留在本次App实例内，30分钟失效、最多32份；不保存聊天，不额外调用模型。
export function createPersonalityHandler({ store, listPartners, now = Date.now }) {
  const previews = new Map();
  function current(agentId) {
    const knowing = store.getKnowing(agentId);
    return { knowing, revision: knowing.revision, palette: normalizePalette(knowing.palette) };
  }
  const draftWarnings = (agentId) => store.getPaletteDraft?.(agentId) || store.getCoCreateSession?.(agentId)
    ? ["已有捏人草稿仍保留，未替你删除；以后确认旧草稿可能替换当前画像，届时请先核对"] : [];
  const result = (agentId, state) => ({ agentId, revision: state.revision, palette: clone(state.palette), effectiveText: paletteToText(state.palette), warnings: [...warnings(state.palette), ...draftWarnings(agentId)] });
  function verify(entry, state) {
    return state.revision > entry.baseRevision && fingerprint(state.palette) === fingerprint(entry.after)
      && fingerprint(state.knowing.history?.[0]?.snapshot?.palette) === entry.beforeHash;
  }
  return async (input) => {
    try {
      object(input, ["action", "agentId", "baseRevision", "patch", "token", "confirm"], "请求");
      if (!["read", "preview", "apply"].includes(input.action)) fail("invalid-input", "action须为read、preview或apply");
      let agentId;
      try { agentId = requirePartnerId(input.agentId); } catch { fail("invalid-input", "伙伴编号无效"); }
      const allowed = input.action === "read" ? ["action", "agentId"] : input.action === "preview"
        ? ["action", "agentId", "baseRevision", "patch"] : ["action", "agentId", "token", "confirm"];
      object(input, allowed, "本次操作");
      const partners = await listPartners();
      if (!Array.isArray(partners) || !partners.some((row) => row.id === agentId)) fail("unknown-partner", "找不到这位可见伙伴，不会创建档案或改到别人");
      const state = current(agentId);
      if (input.action === "read") return { ok: true, action: "read", ...result(agentId, state), note: "只读性格档案；不含采访、聊天、兴趣癖好或Hana身份。语料是表达样例，不是真实经历。" };
      const time = now();
      for (const [key, entry] of previews) if (entry.expiresAt <= time) previews.delete(key);
      if (input.action === "preview") {
        if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision !== state.revision) fail("revision-changed", "档案版本不一致，请重新读取后预览");
        if (previews.size >= LIMIT) fail("preview-limit", "待处理预览已满，请稍后再试");
        const after = patchPalette(state.palette, input.patch, time);
        const token = randomUUID();
        const expiresAt = time + TTL_MS;
        const entry = { agentId, baseRevision: state.revision, beforeHash: fingerprint(state.palette), after, expiresAt, attempted: false };
        previews.set(token, entry);
        return { ok: true, action: "preview", agentId, token, baseRevision: state.revision, expiresAt: new Date(expiresAt).toISOString(), before: state.palette, after: clone(after), effectiveText: paletteToText(after), warnings: [...warnings(after), ...draftWarnings(agentId)], changedFields: FIELDS.filter((key) => fingerprint(state.palette[key]) !== fingerprint(after[key])), saved: false, note: "尚未保存。请展示具体改动，获得同意后再apply；已有明确同意且内容一致时无需重复询问。" };
      }
      if (input.confirm !== true) fail("confirmation-required", "应用须confirm=true，并已有针对本次改动的明确同意");
      const entry = previews.get(input.token);
      if (!entry || entry.agentId !== agentId) fail("preview-expired", "预览失效或不属于这位伙伴，请重新读取并预览；没有执行保存");
      // 写盘后回包失败时允许原token回查，不重复写盘、不重复消耗历史版本。
      if (entry.attempted && verify(entry, state)) return { ok: true, action: "apply", saved: true, verified: true, alreadyApplied: true, ...result(agentId, state) };
      if (state.revision !== entry.baseRevision || fingerprint(state.palette) !== entry.beforeHash) fail("revision-changed", "档案已经变化，不覆盖。请重新读取并预览");
      entry.attempted = true;
      store.saveKnowing(agentId, commitChange(state.knowing, { ...state.knowing, palette: entry.after }, { reason: `Hana 对话修订：${describeChange(state.knowing, { ...state.knowing, palette: entry.after })}`, at: new Date(time) }));
      const saved = current(agentId);
      if (!verify(entry, saved)) fail("verification-failed", "已尝试保存但回读未确认，不能报成功。保留预览，请用原token重试回查或read核对");
      return { ok: true, action: "apply", saved: true, verified: true, alreadyApplied: false, ...result(agentId, saved), note: "旧版已存入现有性格历史（最近两版）；下次生成读取新档案，在途回复不追溯修改。聊天自然度尚待实测。" };
    } catch (error) {
      return { ok: false, code: error?.toolCode || "operation-failed", error: error?.toolCode ? error.message : "操作失败，保存结果未确认；保留原预览，先read核对或用原token重试，不要猜测成功", saved: null };
    }
  };
}

export function registerPersonalityTool(ctx, options) {
  const handle = createPersonalityHandler(options);
  ctx.tools.register({
    name: "chahuahui_personality",
    description: "读取、预览或应用茶话会伙伴的性格档案，无模型费用。read取准确agentId的palette和revision；preview传baseRevision与局部patch，返回改前/改后和30分钟token（不保存）；apply仅在对方明确同意具体修改后传原token、同一agentId及confirm=true，保存旧版并回读核实。省略区段保留，提供数组替换整个区段。冲突先重新读取，不盲重试。只开放性格色/行为/自画像/语料，不读写隐藏兴趣、采访、聊天或Hana身份文件。不得把语料当真实经历。",
    parameters: PERSONALITY_PARAMETERS,
    execute: async (input) => {
      // 宿主附加的context是调用元信息，不是性格改动；不读取、不回显，也不传进档案校验。
      const { context: _context, ...argumentsOnly } = input ?? {};
      const response = await handle(argumentsOnly);
      return { ...(response.ok ? {} : { isError: true }), content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  });
}
