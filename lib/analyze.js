/**
 * 自动性格分析：从伙伴现有素材里提炼一份「调色盘」。
 *
 * 2026-09-13 起草。方法论来自写卡 skill 的硬规矩，外加几条这套流程自己的：
 *
 *  ① 衍生写具体场景和行为，不写抽象定义。「性格温柔善良」是写卡规则里点名的反面教材。
 *  ② 阶段衍生是该阶段**新出现**的行为，不是上一阶段衍生的升级版。所以这套只产
 *     「通用衍生」（一认识就有的），阶段衍生等关系推上去、素材厚了再增量生成。
 *  ③ 评判看「换个人还能不能用」，不看「合不合理」。合理通向平庸——模型自己挑
 *     「最合理」的那条，正好会把最没辨识度的留下。
 *  ④ 证据层和结论层分开：先只列发生过的事，再归纳性格。先下结论的模型只会
 *     把输入里的形容词原样还回来。
 *  ⑤ 每条衍生都要能追溯回证据编号。可追溯=可核对，这是防瞎编最省事的办法。
 *
 * 这里的函数只负责「怎么说」和「怎么读」，不碰模型、不碰文件。编排在 index.js。
 *
 * 文件预算豁免：超 500 行是因为「一套流程的提示词与解析」在这里整块收着——拆开会让
 * 写提示词时得来回跳文件，却不会减少任何一条方法论。故不拆。
 */

/** 这些词一出现，这条衍生就算废了——它们是判断，不是行为。 */
export const BANNED_ADJECTIVES = [
  "温柔",
  "细腻",
  "体贴",
  "善解人意",
  "周到",
  "聪明",
  "理性",
  "感性",
  "敏锐",
  "独立",
  "坚强",
  "乐观",
  "开朗",
  "内向",
  "外向",
  "可靠",
  "成熟",
  "细心",
];

/** 一律不许用来开头的笼统词。开头就笼统，后面基本写不出具体事。 */
export const BANNED_OPENERS = ["总是", "经常", "喜欢", "善于", "倾向于", "习惯"];

// ────────────────────────── 第一步：证据 ──────────────────────────

export function buildEvidencePrompt({ partnerName, material }) {
  return [
    `你在给「茶话会」里的一位伙伴做性格分析。这位伙伴叫${partnerName}。`,
    "",
    "这一步**只做一件事：收集证据，不下结论。**",
    "",
    "下面是它在自己系统里留下的原始材料——",
    "",
    material,
    "",
    "──────",
    "",
    "【任务】从材料里挑出 12-20 条**具体发生过的事**：它做过的动作、说过的话、反复出现的处理方式。一条一行：",
    "",
    "证据N：[什么情况] → [它具体怎么做 / 说了什么]",
    "",
    "**优先挑它跟人打交道时的做法**——怎么回应、什么时候问、什么时候不吐声、怎么拒绝、怎么开口。处理任务的流程排在这些后面，而且只在它确实能说明「这是个什么样的人」时才挑。",
    "",    "【硬性要求】",
    "1. 只写材料里**真的出现过**的，能对应到原文。不许推测，不许补全，不许顺手加戏。",
    "2. 每条必须有「情况」和「做法」两半，缺一不可。",
    `3. 不许出现这些判断词：${BANNED_ADJECTIVES.join("、")}。只写行为。`,
    "4. 材料里如果有它说的话，尽量把原话带上。",
    "5. 挑不满 12 条就写多少算多少，宁可少，不许编。一条都挑不出来，就只回四个字：素材不足。",
    "6. 纯操作流程（按某个顺序核对一遍、检查某个文件）不算，除非它真能说明这个人的性子。",
  ].join("\n");
}

/** 从证据块的回复里扒出条目。认「证据N：」开头的行，认不出就整行收着。 */
export function parseEvidence(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const hit = /^证据\s*(\d+)\s*[：:、.]\s*(.+)$/.exec(line);
    const body = hit ? hit[2].trim() : line.replace(/^[-*·]\s*/, "").trim();
    if (!body) continue;
    if (body.length < 6) continue;
    out.push({ id: hit ? Number(hit[1]) : out.length + 1, text: body });
  }
  return out;
}

// ────────────────────────── 第二步：归色 ──────────────────────────

export const PALETTE_SCHEMA_HINT = `{
  "base": { "name": "底色，两到四个字", "evidence": [证据编号] },
  "main": [ { "name": "主色调，一到两个", "evidence": [证据编号] } ],
  "accent": [ { "name": "点缀，零到两个", "evidence": [证据编号] } ]
}`;

export function buildPalettePrompt({ partnerName, evidence }) {
  return [
    `下面是给${partnerName}收集到的证据：`,
    "",
    ...evidence.map((row) => `证据${row.id}：${row.text}`),
    "",
    "──────",
    "",
    "【任务】从这些证据里归纳出它的性格结构：",
    "",
    "- 底色：最深的那层基调。始终在，但不一定最显眼。只写一个。",
    "- 主色调：日常最突出的，一到两个。",
    "- 点缀：特定条件下才露出来的，零到两个。归纳不出就留空数组。",
    "",
    "【硬性要求】",
    "1. 每个色名都必须能对应到**至少两条**证据，并在 evidence 里写出编号。",
    "2. 色名两到四个字，是性格色彩的名字，不是行为描述。",
    "3. 证据撑不起来就少写，不许为了凑结构硬安一个色。",
    "4. 只输出 JSON，不要解释，不要 markdown 代码块。",
    "",
    "结构：",
    PALETTE_SCHEMA_HINT,
  ].join("\n");
}

// ────────────────────────── 第三步：写衍生 ──────────────────────────

export function buildDerivativePrompt({ partnerName, evidence, palette, feedback = null }) {
  const lines = [
    `下面还是${partnerName}的证据：`,
    "",
    ...evidence.map((row) => `证据${row.id}：${row.text}`),
    "",
    `它的性格结构：${describePalette(palette)}`,
    "",
    "──────",
    "",
    "【任务】给每个色写 2-3 条衍生。",
    "",
    "衍生 = 这个色在具体场合里的具体做法。写成一句能演出的话，不是一句概括。",
    "",
    "【硬性要求】",
    "1. 每条都写成「什么情况 → 它怎么做」，必须带触发条件。光说它是什么样，不算。",
    "2. 每条都要能追溯到证据，在 evidence 里写编号。",
    `3. 这些词一个都不许出现（出现即作废）：${BANNED_ADJECTIVES.join("、")}。`,
    `4. 这些词不许放句首：${BANNED_OPENERS.join("、")}。`,
    "5. 不许写「它会让你觉得安心」这种效果描述，只写它做了什么。",
    "6. 每条 15-50 字。某个色写不出两条就写一条，宁可少，不许编。",
  ];
  if (Array.isArray(feedback) && feedback.length) {
    lines.push(
      "",
      "【上一轮被打回的】下面这些太通用了——换到任何一个别的伙伴身上都成立。别换个说法接着交，要往证据里再挖一层：",
      ...feedback.map((row) => `- ${row}`),
    );
  }
  lines.push(
    "",
    "【输出格式】只输出 JSON，不要解释，不要 markdown 代码块：",
    `{ "derivatives": [ { "color": "色名", "scope": "common", "text": "什么情况 → 它怎么做", "evidence": [编号] } ] }`,
    "",
    "scope 一律写 common（这一版只产通用衍生，跟关系阶段无关的那部分）。",
  );
  return lines.join("\n");
}

/** 把调色盘说成一句人话，给衍生那步当参照。 */
export function describePalette(palette) {
  if (!palette) return "（没归纳出来）";
  const parts = [];
  if (palette.base?.name) parts.push(`底色「${palette.base.name}」`);
  const main = (palette.main ?? []).map((row) => row?.name).filter(Boolean);
  if (main.length) parts.push(`主色调「${main.join("、")}」`);
  const accent = (palette.accent ?? []).map((row) => row?.name).filter(Boolean);
  if (accent.length) parts.push(`点缀「${accent.join("、")}」`);
  return parts.join("，") || "（没归纳出来）";
}

// ────────────────────────── 第四步：替换测试 ──────────────────────────
//
// 这一步刻意不给素材。评判者一旦看见素材，就会开始替写的人辩护。
// 只给它候选和一把尺子。

export function buildReplaceTestPrompt({ partnerName, candidates }) {
  return [
    `下面是一组给${partnerName}写的性格衍生。逐条判断：`,
    "",
    "**把它换到任何一个别的伙伴身上，还成立吗？**",
    "",
    "- 成立（换谁都行、谁都会这样）→ 划掉",
    "- 不成立（只有它会这样）→ 留下",
    "",
    "判断的时候只看这句话本身，不要脑补它的来历。看着像通用好话的，一律划掉——这类句子在角色卡里就是废句。",
    "",
    ...[candidates.map((row, i) => `${i + 1}. ${row.text ?? row}`)],
    "",
    "【输出格式】只输出 JSON，不要解释，不要 markdown 代码块：",
    `{ "kept": [留下的编号], "dropped": [ { "index": 编号, "reason": "一句理由" } ] }`,
  ].join("\n");
}

// ────────────────────────── 解析 ──────────────────────────

/** 从模型回复里抠出 JSON。模型爱裹 ```json，也爱在前面寒暄两句。 */
export function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1].trim() : raw;
  const direct = tryJson(body);
  if (direct) return direct;
  // 退一步：抓第一个 { 到最后一个 }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryJson(body.slice(start, end + 1));
    if (sliced) return sliced;
  }
  return null;
}

function tryJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 规整调色盘（分析产的那种：base/main/accent）：只留认得出的字段，色名去重去空。 */
export function normalizeColorPalette(value) {
  const clean = (row) => {
    const name = String(row?.name ?? "").trim();
    if (!name) return null;
    const evidence = Array.isArray(row?.evidence)
      ? row.evidence.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    return { name: name.slice(0, 8), evidence };
  };
  const base = clean(value?.base);
  const main = (Array.isArray(value?.main) ? value.main : []).map(clean).filter(Boolean);
  const accent = (Array.isArray(value?.accent) ? value.accent : []).map(clean).filter(Boolean);
  if (!base && !main.length && !accent.length) return null;
  // 先去重再截数量：不然模型把同一个色写重了，会白白占掉名额
  const seen = new Set();
  if (base) seen.add(base.name);
  const dedupe = (rows, limit) => {
    const out = [];
    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  };
  return { base, main: dedupe(main, 2), accent: dedupe(accent, 2) };
}

/** 规整衍生，顺手把违规的标出来（不删，标出来给她看）。 */
export function normalizeDerivatives(value) {
  const rows = Array.isArray(value?.derivatives) ? value.derivatives : [];
  return rows
    .map((row) => {
      const text = String(row?.text ?? "").trim().replace(/\s+/g, " ");
      const color = String(row?.color ?? "").trim();
      if (!text || !color) return null;
      const evidence = Array.isArray(row?.evidence)
        ? row.evidence.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [];
      return {
        color,
        scope: "common",
        text,
        evidence,
        banned: findBannedWords(text),
        long: text.length > 60,
      };
    })
    .filter(Boolean);
}

/** 扫一眼句子里的违规词。 */
export function findBannedWords(text) {
  const body = String(text ?? "");
  const hits = [];
  for (const word of BANNED_ADJECTIVES) {
    if (body.includes(word)) hits.push(word);
  }
  for (const word of BANNED_OPENERS) {
    if (body.startsWith(word)) hits.push(`${word}（开头）`);
  }
  return hits;
}

/** 读替换测试的回复。编号是 1 起的，要减回 0 起。 */
export function parseReplaceTest(text, count) {
  const value = parseJsonLoose(text);
  const kept = [];
  const dropped = [];
  if (value && (Array.isArray(value.kept) || Array.isArray(value.dropped))) {
    for (const row of Array.isArray(value.kept) ? value.kept : []) {
      const index = Number(row) - 1;
      if (index >= 0 && index < count) kept.push(index);
    }
    for (const row of Array.isArray(value.dropped) ? value.dropped : []) {
      const index = Number(row?.index ?? row) - 1;
      if (index >= 0 && index < count) {
        dropped.push({ index, reason: String(row?.reason ?? "").trim() || "换谁都成立" });
      }
    }
    return { kept, dropped };
  }
  // JSON 抠不出来：整批留下，别因为解析失败把东西丢了。诊断会记下这次失败。
  return { kept: Array.from({ length: count }, (_, i) => i), dropped: [], unparsed: true };
}

// ─────────────────── 捏人：一次出「色 + 候选行为池」 ───────────────────
//
// 跟上面那套的区别：上面产出的是定稿（每个色 2-3 条），这一套产出的是**池子**
// （每个色 4-5 条），用户在池子里挑，挑中的才进定稿。池子先在草稿里活着，不占业务数据。

export const DRAFT_SCHEMA_HINT = `{
  "colors": [
    {
      "name": "色名，两到四个字",
      "role": "base / main / accent 三选一",
      "alternatives": ["另外两个候选色名"],
      "evidence": [证据编号],
      "rows": ["候选行为一", "候选行为二", "候选行为三", "候选行为四"]
    }
  ]
}`;

export function buildDraftColorsPrompt({ partnerName, evidence, feedback = [] }) {
  const lines = [
    `下面是给${partnerName}收集到的证据：`,
    "",
    ...evidence.map((row) => `证据${row.id}：${row.text}`),
    "",
    "──────",
    "",
    `【任务】先给${partnerName}归纳性格，再给每个色备一批行为候选。`,
    "",
    "结构：底色一个（始终在，但不一定最显眼）+ 主色调一到两个（日常最突出）+ 点缀零到两个（特定条件下才露）。",
    "",
    "【行为候选的硬性要求】",
    "1. 写成「什么情况 → 怎么做」，必须带触发条件。",
    "2. **不写主语**——不写名字、不写「它」「ta」，直接写动作。",
    `3. 这些词一个都不许出现：${BANNED_ADJECTIVES.join("、")}。`,
    `4. 这些词不许放句首：${BANNED_OPENERS.join("、")}。`,
    "5. 不许写「会让人觉得安心」这种效果描述，只写做了什么。",
    "6. 每条 15-80 字。每个色给 4-5 条——给得多一点，用户要从里面挑。",
    "7. 每个色另外给两个备选色名（用户在界面上可以不选你给的主名）。",
    "8. 不许把材料里的工作规则原样抄成行为（「发布前先检查」这种是流程，不是性格）。要往背后挖一层：它为什么会这么做。",
    "9. **每一条都要能在纯聊天的场景里看出来。**只在下班干活时才成立的做法不要写——排查某个变量、按某个顺序核对一遍、处理某类工程文件，这些留给自己用就好。",
    "10. 色名要像一个常见的性格词，人一眼看懂（较真、护短、嘴硬、跳脱这种）。不许生造词。",
    "11. 写的是**反复会有的做法**，不是某一次的具体事例。「解释某某词的时候怎么拆谐音」这种带专名的一次性事件不要写，要抽成能重复发生的情况（比如「碰到不懂的词，先说不知道」）。",
    "12. **每条都要带边界。**先写通常怎么做，再用「但」或「不过」补一句：什么时候不会这样，或者做过头会变成什么样。",
    "    例：「不确定就先问清楚；但对方明显累了就收住，不把求真做成审问。」",
    "    没有边界的行为是标签，不是性格。",
  ];
  if (Array.isArray(feedback) && feedback.length) {
    lines.push(
      "",
      "【上一轮被打回的】下面这些太通用了，换到任何一个别的伙伴身上都成立。别换个说法接着交：",
      ...feedback.map((row) => `- ${row}`),
    );
  }
  lines.push("", "【输出格式】只输出 JSON，不要解释，不要 markdown 代码块：", DRAFT_SCHEMA_HINT);
  return lines.join("\n");
}

/** 只给某个色补一批候选（池子被剥空了才用）。 */
export function buildRefillPrompt({ partnerName, evidence, color, feedback = [] }) {
  return [
    `下面是${partnerName}的证据：`,
    "",
    ...evidence.map((row) => `证据${row.id}：${row.text}`),
    "",
    `「${color.name}」这个色现在的候选行为都不够味（太通用，换谁都能用）。重新给 4 条，要能从证据里指出来是它的。`,
    "",
    "照旧：写「什么情况 → 怎么做」、不写主语、禁形容词、每条 15-80 字，而且每条都要带边界（什么时候不会这样）。",
    ...(feedback.length ? ["", "这些是已经试过、被划掉的，别重复：", ...feedback.map((row) => `- ${row}`)] : []),
    "",
    "只输出 JSON：",
    `{ "rows": ["候选一", "候选二", "候选三", "候选四"] }`,
  ].join("\n");
}

/** 草稿里的色名太多太杂，收一收：位置限额、去重、备选名不带重样的。 */
export function normalizeDraftColors(value) {
  const rows = Array.isArray(value?.colors) ? value.colors : [];
  const limit = { base: 1, main: 2, accent: 2 };
  const perRole = { base: 0, main: 0, accent: 0 };
  const seen = new Set();
  const colors = [];
  for (const row of rows) {
    const name = String(row?.name ?? "").trim().slice(0, 8);
    const role = ["base", "main", "accent"].includes(row?.role) ? row.role : null;
    if (!name || !role || seen.has(name)) continue;
    if (perRole[role] >= limit[role]) continue;
    const body = (Array.isArray(row?.rows) ? row.rows : [])
      .map((item) => String(item ?? "").trim().replace(/\s+/g, " "))
      .filter((item) => item.length >= 6 && item.length <= 120)
      .slice(0, 5);
    if (!body.length) continue;
    seen.add(name);
    perRole[role] += 1;
    const index = colors.length + 1;
    const alternatives = (Array.isArray(row?.alternatives) ? row.alternatives : [])
      .map((item) => String(item ?? "").trim().slice(0, 8))
      .filter((item) => item && item !== name && !seen.has(item))
      .slice(0, 2);
    colors.push({
      id: `c${index}`,
      name,
      role,
      alternatives,
      evidence: Array.isArray(row?.evidence)
        ? row.evidence.map((n) => Number(n)).filter((n) => Number.isFinite(n)).slice(0, 12)
        : [],
      rows: body.map((text, i) => ({ id: `d${index}_${i + 1}`, text, origin: "model" })),
    });
  }
  return colors;
}

/** 池子摄平：送去过替换测试的时候，一条条排好、给上编号。 */
export function flattenDraftRows(colors) {
  const out = [];
  for (const color of Array.isArray(colors) ? colors : []) {
    for (const row of color.rows ?? []) out.push({ colorId: color.id, rowId: row.id, text: row.text });
  }
  return out;
}

/**
 * 按替换测试的结果剥池子：划掉的从池子里去掉。
 * 被划掉的句子也记下来，界面可以小声提一句「这些太通用，已经被拿掉了」。
 */
export function applyVerdictToDraft(colors, verdict, flat) {
  const dropIds = new Set(verdict.dropped.map((row) => flat[row.index]?.rowId).filter(Boolean));
  const dropped = [];
  const next = colors.map((color) => {
    const rows = (color.rows ?? []).filter((row) => {
      if (!dropIds.has(row.id)) return true;
      dropped.push({ color: color.name, text: row.text });
      return false;
    });
    return { ...color, rows };
  });
  return { colors: next, dropped, unparsed: Boolean(verdict.unparsed) };
}

/** 草稿收成人话，存盘和界面都用这个。 */
export function summarizeDraft({ agentId, model, colors, dropped = [], notes = [] }) {
  return {
    agentId,
    model,
    createdAt: new Date().toISOString(),
    stats: {
      colors: colors.length,
      rows: colors.reduce((sum, color) => sum + (color.rows?.length ?? 0), 0),
      dropped: dropped.length,
    },
    colors,
    dropped,
    notes,
  };
}


/**
 * 把跑完一轮的原始产物收成一份结果。
 * 落盘的是这个，界面上给人看的也是这个。
 */
/**
 * 让模型先写一版「它是怎样一个人」，给用户当底稿改。
 *
 * 写卡 skill 里这叫「二次解释」——作者对伙伴的终极注释，用来纠正 AI 的理解。
 * skill 要求它由用户自己写，因为「AI 写的只会重复资料库的理解」。
 * 但让人从空白写起会劝退，所以先给一版揭头，她只管改和划掉——判断还是她做的。
 */
export function buildSelfPortraitPrompt({ partnerName = "", material = "" } = {}) {
  return [
    `你在帮一个人写一段关于 ta 伙伴${partnerName ? `（${partnerName}）` : ""}的说明。`,
    "",
    "这段东西的用处：以后这个伙伴自己读到它，会明白「在这人眼里我是什么样子」，不至于把自己演成一个只会说好听话的角色。",
    "",
    "要求：",
    "1. 分 3-4 段。每段一个小标题（不超 6 个字）加一段话（40-120 字）。",
    "2. 用「你」指这个伙伴，像当面跟它说话。不要写成第三人称介绍。",
    "3. 每一段底下都要有材料里的具体观察撑着，不许写空泛的好话。",
    "4. 敢写它不那么好看的地方：较真到让人烦、护短护得不讲理、嘴上不饶人。人就是复杂的，全是好话反而假。",
    "5. **每段至少带一处矛盾或例外**：什么时候它其实不这样、或者这么做反而添乱。只写一面的，是介绍，不是理解。",
    "6. 材料里看不出来的，宁可留白，不许编。",
    "7. 口语，不要用「总的来说」「综上」这种。",
    "",
    "材料：",
    String(material).slice(0, 26000),
    "",
    '只输出 JSON，不要别的：{"portrait":[{"title":"...","text":"..."}]}',
  ].join("\n");
}

/** 兜住模型给的形状。 */
export function normalizePortrait(raw) {
  const list = Array.isArray(raw?.portrait) ? raw.portrait : [];
  return list
    .map((row) => ({
      title: String(row?.title ?? "").trim().slice(0, 12),
      text: String(row?.text ?? "").trim().slice(0, 400),
    }))
    .filter((row) => row.title && row.text)
    .slice(0, 5);
}

export function summarizeRun({ agentId, model, evidence, palette, derivatives, rounds, notes = [] }) {
  const dropped = derivatives.filter((row) => row.dropped).length;
  const kept = derivatives.length - dropped;
  const flagged = derivatives.filter((row) => !row.dropped && row.banned?.length);
  return {
    agentId,
    model,
    analyzedAt: new Date().toISOString(),
    rounds,
    stats: {
      evidenceCount: evidence.length,
      colors: palette
        ? 1 + (palette.main?.length ?? 0) + (palette.accent?.length ?? 0)
        : 0,
      written: derivatives.length,
      kept,
      dropped,
      flagged: flagged.length,
    },
    palette,
    evidence,
    derivatives,
    notes,
  };
}
