/**
 * 性格调色盘：性格是一盘色，不是一个滑梯。
 *
 * 2026-09-13 新起（设计见 DESIGN-personality-palette.md）。跟旧的 surface / inner 并存：
 * 有调色盘就用调色盘，没有才退回旧结构。纯逻辑，不碰文件、不碰模型。
 *
 *   · 色（colors）：底色一个、主色调一到两个、点缀零到两个。每个色是个名字，不是形容词。
 *   · 行为（derivatives）：每个色底下挂着「什么情况 → 怎么做」的句子。
 *     **不写主语**——进提示词时主语自然就是「你」，不用改写词形。
 *   · scope：这一版只产 common（不挂关系阶段的通用行为）。
 *   · origin：model 还是 user。用户亲手改过的记 user，以后重跑分析不许覆盖。
 *   · on：留着还是删了。删掉的留档，用户后悔了能捞回来。
 */

export const ROLE_ORDER = Object.freeze(["base", "main", "accent"]);
export const ROLE_LABELS = Object.freeze({ base: "底色", main: "主色调", accent: "点缀" });
/** 每个位置最多几个色 */
export const ROLE_LIMIT = Object.freeze({ base: 1, main: 2, accent: 2 });

/** 每个色最多带几条行为进提示词。再多会互相稀释，模型也演不出层次。 */
export const MAX_LIVE_PER_COLOR = 3;
/** 每个色最多留几条记录（含删掉的），别让废弃的东西无限堆着。 */
export const MAX_ROWS_PER_COLOR = 6;
export const MAX_COLORS = ROLE_LIMIT.base + ROLE_LIMIT.main + ROLE_LIMIT.accent;
export const MAX_COLOR_NAME = 8;
export const MAX_DERIVATIVE = 120;
export const MAX_PORTRAIT_TITLE = 12;
export const MAX_PORTRAIT = 400;
export const MAX_PORTRAIT_ROWS = 5;

/**
 * 语料：ta 在手机上真会发出来的那几句话。
 *
 * 2026-09-14 加。性格写得再准，模型不知道「这个人的句子长什么样」，出来的还是标准 AI 腔。
 * 酒馆那边这一块叫「语料」，写在这里是为了让模型学到腔调，不是让它背台词。
 * 一条一行，纯对话，不写动作神态心理。
 */
export const MAX_CORPUS_SCENES = 6;
export const MAX_CORPUS_SCENE = 40;
export const MAX_CORPUS_LINE = 60;
export const MAX_CORPUS_LINES = 5;

export function emptyPalette() {
  return { colors: [], derivatives: [], portrait: [], corpus: [], updatedAt: null, source: null };
}

const text = (value, limit) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeRole(value) {
  return ROLE_ORDER.includes(value) ? value : null;
}

function normalizeColor(raw) {
  const name = text(raw?.name, MAX_COLOR_NAME);
  const role = normalizeRole(raw?.role);
  if (!name || !role) return null;
  return {
    id: text(raw?.id, 40) || newId("c"),
    name,
    role,
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence.map((n) => Number(n)).filter((n) => Number.isFinite(n)).slice(0, 12)
      : [],
  };
}

export function normalizePalette(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const seenName = new Set();
  const perRole = { base: 0, main: 0, accent: 0 };
  const colors = [];
  for (const row of Array.isArray(source.colors) ? source.colors : []) {
    const color = normalizeColor(row);
    if (!color) continue;
    if (seenName.has(color.name)) continue;
    if (perRole[color.role] >= ROLE_LIMIT[color.role]) continue;
    seenName.add(color.name);
    perRole[color.role] += 1;
    colors.push(color);
  }
  colors.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  const colorIds = new Set(colors.map((row) => row.id));
  const perColor = new Map();
  const derivatives = [];
  for (const row of Array.isArray(source.derivatives) ? source.derivatives : []) {
    const colorId = text(row?.colorId, 40);
    const body = text(row?.text, MAX_DERIVATIVE);
    if (!colorId || !body) continue;
    if (!colorIds.has(colorId)) continue;
    const used = perColor.get(colorId) ?? 0;
    if (used >= MAX_ROWS_PER_COLOR) continue;
    perColor.set(colorId, used + 1);
    derivatives.push({
      id: text(row?.id, 40) || newId("d"),
      colorId,
      text: body,
      scope: text(row?.scope, 20) || "common",
      origin: row?.origin === "user" ? "user" : "model",
      on: row?.on !== false,
    });
  }

  const portrait = (Array.isArray(source.portrait) ? source.portrait : [])
    .map((row) => ({ title: text(row?.title, MAX_PORTRAIT_TITLE), text: text(row?.text, MAX_PORTRAIT) }))
    .filter((row) => row.title && row.text)
    .slice(0, MAX_PORTRAIT_ROWS);

  // 语料：只留「一行一句」的东西，写不成一行的（带动作描写那种）当场筛掉
  const corpus = (Array.isArray(source.corpus) ? source.corpus : [])
    .map((row) => {
      const scene = text(row?.scene, MAX_CORPUS_SCENE);
      const lines = (Array.isArray(row?.lines) ? row.lines : [])
        .map((line) => text(line, MAX_CORPUS_LINE))
        .filter(Boolean)
        .slice(0, MAX_CORPUS_LINES);
      return lines.length ? { scene, lines } : null;
    })
    .filter(Boolean)
    .slice(0, MAX_CORPUS_SCENES);

  return {
    colors,
    derivatives,
    portrait,
    corpus,
    updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : null,
    source: source.source === "reshaped" || source.source === "generated" ? source.source : null,
  };
}

/** 至少有一个色、一条活的行为，才算一份能用的调色盘。 */
export function hasPalette(raw) {
  const palette = normalizePalette(raw);
  return palette.colors.length > 0 && palette.derivatives.some((row) => row.on);
}

/**
 * 这份盘算不算「捏过了」。
 * 门禁和保存得用同一把尺——不然只留了自画像的盘会「存得进、却永远算没捏」。
 */
export function isPaletteDone(raw) {
  const palette = normalizePalette(raw);
  return hasPalette(palette) || palette.portrait.length > 0;
}

/** 某个色现在带几条活的行为。 */
export function liveCount(palette, colorId) {
  return normalizePalette(palette).derivatives.filter((row) => row.colorId === colorId && row.on).length;
}

export function colorById(palette, colorId) {
  return normalizePalette(palette).colors.find((row) => row.id === colorId) ?? null;
}

/** 按位置排出「底色 → 主色调 → 点缀」，渲染和界面都照这个顺序。 */
export function colorsInOrder(palette) {
  const rows = normalizePalette(palette).colors;
  return ROLE_ORDER.flatMap((role) => rows.filter((row) => row.role === role));
}

// ── 编辑 ────────────────────────────────────────────────────
//
// 全部返回新对象，不改原来那份。加不下、有空名、位置满了，原样返回。

function stamp(palette, patch = {}) {
  const base = normalizePalette(palette);
  return { ...base, ...patch, updatedAt: new Date().toISOString() };
}

/** 加一个色。位置满了、重名、空名都加不进去。 */
export function addColor(palette, { name, role, evidence = [] }) {
  const base = normalizePalette(palette);
  const body = text(name, MAX_COLOR_NAME);
  const slot = normalizeRole(role);
  if (!body || !slot) return base;
  if (base.colors.some((row) => row.name === body)) return base;
  if (base.colors.filter((row) => row.role === slot).length >= ROLE_LIMIT[slot]) return base;
  return stamp(base, { colors: [...base.colors, { id: newId("c"), name: body, role: slot, evidence }] });
}

export function renameColor(palette, colorId, name) {
  const base = normalizePalette(palette);
  const body = text(name, MAX_COLOR_NAME);
  if (!body) return base;
  if (base.colors.some((row) => row.id !== colorId && row.name === body)) return base;
  const colors = base.colors.map((row) => (row.id === colorId ? { ...row, name: body } : row));
  return stamp(base, { colors });
}

/** 删色：底下的行为跟着删，但删掉的只是记录，不是用户的字。 */
export function removeColor(palette, colorId) {
  const base = normalizePalette(palette);
  return stamp(base, {
    colors: base.colors.filter((row) => row.id !== colorId),
    derivatives: base.derivatives.filter((row) => row.colorId !== colorId),
  });
}

/** 加一条行为。这个色的记录满了就加不进去。 */
export function addDerivative(palette, { colorId, text: body, origin = "model", scope = "common", on = true }) {
  const base = normalizePalette(palette);
  const id = text(colorId, 40);
  const value = text(body, MAX_DERIVATIVE);
  if (!id || !value) return base;
  if (!base.colors.some((row) => row.id === id)) return base;
  if (base.derivatives.filter((row) => row.colorId === id).length >= MAX_ROWS_PER_COLOR) return base;
  if (base.derivatives.some((row) => row.colorId === id && row.text === value)) return base;
  return stamp(base, {
    derivatives: [
      ...base.derivatives,
      {
        id: newId("d"),
        colorId: id,
        text: value,
        scope: text(scope, 20) || "common",
        origin: origin === "user" ? "user" : "model",
        on: on !== false,
      },
    ],
  });
}

/** 改一条：换字或开关。改过字的记成用户写的。 */
export function updateDerivative(palette, derivativeId, patch = {}) {
  const base = normalizePalette(palette);
  const derivatives = base.derivatives.map((row) => {
    if (row.id !== derivativeId) return row;
    const next = { ...row };
    if (patch.text !== undefined) {
      const value = text(patch.text, MAX_DERIVATIVE);
      if (!value) return row;
      next.text = value;
      next.origin = patch.origin === "model" ? "model" : "user";
    }
    if (patch.on !== undefined) next.on = patch.on !== false;
    return next;
  });
  return stamp(base, { derivatives });
}

export function removeDerivative(palette, derivativeId) {
  const base = normalizePalette(palette);
  return stamp(base, { derivatives: base.derivatives.filter((row) => row.id !== derivativeId) });
}

/** 把一批「选中的候选」换成一个色底下的活行为：先全关，再把选中的打开或补进来。 */
export function setColorDerivatives(palette, colorId, rows) {
  const base = normalizePalette(palette);
  let next = base;
  const want = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ text: text(row?.text, MAX_DERIVATIVE), origin: row?.origin === "user" ? "user" : "model" }))
    .filter((row) => row.text)
    .slice(0, MAX_LIVE_PER_COLOR);
  const existing = next.derivatives.filter((row) => row.colorId === colorId);
  const keep = [];
  for (const row of want) {
    const hit = existing.find((item) => item.text === row.text);
    if (hit) keep.push({ ...hit, on: true, origin: row.origin === "user" ? "user" : hit.origin });
    else keep.push({ id: newId("d"), colorId, text: row.text, scope: "common", origin: row.origin, on: true });
  }
  const keepIds = new Set(keep.map((row) => row.id));
  const others = next.derivatives.filter((row) => row.colorId !== colorId);
  const off = existing.filter((row) => !keepIds.has(row.id)).map((row) => ({ ...row, on: false }));
  // keep 排在 off 前：normalizePalette 每色只留前 6 条，历史关掉的攒多了会把刚选中的挤掉
  next = stamp(next, { derivatives: [...others, ...keep, ...off] });
  return next;
}

// ── 渲染 ────────────────────────────────────────────────────

/**
 * 调色盘拼成给模型看的那段话。
 *
 * 行为句是不带主语的，进提示词后主语自然就是「你」——所以这里一个字都不用改词形。
 * 一个色的活行为超过 MAX_LIVE_PER_COLOR 条时只取前几条。
 */
export function paletteToText(raw, { userName = null } = {}) {
  const palette = normalizePalette(raw);
  const portrait = palette.portrait
    .map((row) => `关于「${row.title}」：${row.text}`)
    .join("\n");
  if (!palette.colors.length && !portrait && !palette.corpus.length) return "";
  const lines = [];
  for (const color of colorsInOrder(palette)) {
    const rows = palette.derivatives
      .filter((row) => row.colorId === color.id && row.on)
      .slice(0, MAX_LIVE_PER_COLOR)
      .map((row) => row.text);
    if (!rows.length) continue;
    lines.push(`【${color.name}】${rows.join("；")}。`);
  }
  const blocks = [];
  if (portrait) {
    blocks.push(
      `${userName ? userName : "她"}眼里的你（这段是ta亲手改过的，比规则更算数）：\n${portrait}`,
    );
  }
  if (lines.length) blocks.push(lines.join("\n\n"));
  if (palette.corpus.length) {
    const body = palette.corpus
      .map((row) => `- ${row.scene ? `${row.scene} → ` : ""}${row.lines.map((line) => `「${line}」`).join("")}`)
      .join("\n");
    blocks.push(`你发消息大概长这样（只参考腔调，别照抄，也别每句都用上）：\n${body}`);
  }
  if (!blocks.length) return "";
  const who = userName ? `${userName}的` : "你的";
  return [
    `在「茶话会」里，你就是这样一个人（这是${who}聊天应用里给ta定的样子）——`,
    "",
    "（下面说的「她」指跟你说话的那个人。）",
    "",
    blocks.join("\n\n"),
    "",
    "这是你自然的样子，别念出来，也别解释，更别一条条照着演。",
  ].join("\n");
}
