import path from "node:path";

import { isValidPartnerId } from "./partner-id.js";

/**
 * 读伙伴的人格与记忆 —— 单向阀的「读」那一半。
 *
 * 实测（Hana 0.951.4）：`ctx.resources.read({ kind: "local-file", path })` 能读到
 * <HANA_HOME>/agents/<id>/ 下的人格与记忆文件内容。全程只读，绝不写回。
 *
 * 见知识卡片 kc-v2app-读伙伴资料与记忆单向阀.md
 */

export const PERSONA_BUDGET = {
  identity: 4000,
  /** 自我介绍：写得短，但有些伙伴只有它 */
  description: 1500,
  /** 对外公开的那份自述 */
  public: 1500,
  pinned: 2500,
  facts: 3000,
  experience: 1200,
  /** 方言口吻：从 AGENTS.md 里单独捞出来的那一块，不是整份 */
  dialect: 1400,
  /** 近况：memory.md 里「今天」和「长期情况」两节，合起来这么点 */
  now: 1600,
};

/**
 * memory.md 里只捞这两节：今天她在忙什么、长期是个什么样的人。
 * 「重要事实」跟 facts.md 重样，「本周早些时候」是一周流水账，闲聊用不上。
 * 每节各留一半预算：不然「今天」一长，把人看得长远的那节整段切掉。
 */
const MEMORY_NOW_TITLES = ["今天", "长期情况"];
const MEMORY_NOW_PER_SECTION = 700;

export function pickMemoryNow(raw, { titles = MEMORY_NOW_TITLES, perSection = MEMORY_NOW_PER_SECTION } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const blocks = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    // 只认二级标题：「### 2026-10-17」那种是节内的小日子，算贴着上面那节走
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      current = titles.some((want) => title === want || title.startsWith(want)) ? { title, lines: [] } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  const out = [];
  for (const block of blocks) {
    const body = block.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) continue;
    const clipped = perSection > 0 && body.length > perSection
      ? `${body.slice(0, perSection).trimEnd()}\n…（后略）`
      : body;
    out.push(`## ${block.title}\n${clipped}`);
  }
  return out.join("\n\n");
}

const FILES = [
  { key: "identity", rel: "identity.md", budget: "identity", label: "人格（identity.md）" },
  { key: "description", rel: "description.md", budget: "description", label: "自我介绍（description.md）" },
  { key: "public", rel: "AGENTS.public.md", budget: "public", label: "对外公开（AGENTS.public.md）" },
  { key: "pinned", rel: "pinned.md", budget: "pinned", label: "钉选记忆（pinned.md）" },
  { key: "facts", rel: path.join("memory", "facts.md"), budget: "facts", label: "记忆（memory/facts.md）" },
  {
    key: "now",
    rel: path.join("memory", "memory.md"),
    budget: "now",
    label: "近况（memory/memory.md 的今天与长期情况）",
    shape: pickMemoryNow,
  },
  { key: "experience", rel: "experience.md", budget: "experience", label: "经验（experience.md）" },
];

function toText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (typeof value === "object" && typeof value.toString === "function") {
    const asString = value.toString();
    return asString === "[object Object]" ? null : asString;
  }
  return String(value);
}

function clip(text, limit) {
  if (typeof text !== "string") return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（后略，原文 ${text.length} 字）`;
}

export async function readLocalFileText(ctx, filePath) {
  try {
    const result = await ctx.resources.read({ kind: "local-file", path: filePath });
    return toText(result?.content);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * 从 AGENTS.md 里取方言人格块。
 *
 * 方言（表情包的「口吻」功能）是把一整段说话习惯写进 AGENTS.md 的，主对话框靠它说方言。
 * 茶话会不吃整份 AGENTS.md（那里还压着一堆工作规则，闲聊里冒出来就很怪），
 * 只把带标记的这一块捞出来当「说话口吻」用；没装、没开方言就没这块，静默降级。
 */
const DIALECT_BLOCK_RE = /<!--\s*[\w-]*dialect[\w-]*:start\s*-->([\s\S]*?)<!--\s*[\w-]*dialect[\w-]*:end\s*-->/i;

export function extractDialectBlock(raw) {
  if (typeof raw !== "string") return null;
  const hit = DIALECT_BLOCK_RE.exec(raw);
  const text = hit?.[1]?.trim();
  return text ? text : null;
}

/**
 * @param {object} [options]
 * @param {object} [options.budget] 覆盖各文件的字数预算。分析要的料比聊天宽得多，
 *   反正只跑一次——素材越厚，提炼出来的东西越具体。
 * @param {string[]} [options.extra] 额外要读的文件（相对伙伴目录）。
 * @returns {{agentId: string, files: Record<string, string|null>, extras: Record<string, string|null>, errors: Record<string,string>, readAt: string}}
 */
export async function loadPersona(ctx, { agentsRoot, agentId, budget = PERSONA_BUDGET, extra = [] }) {
  // 路径是拼出来的，id 必须先过关。不只靠路由拦，函数自己也拦一道。
  if (!isValidPartnerId(agentId)) {
    return {
      agentId: String(agentId ?? ""),
      files: {},
      extras: {},
      errors: { id: "invalid-agent-id" },
      readAt: new Date().toISOString(),
    };
  }
  const root = path.join(agentsRoot, agentId);
  const files = {};
  const errors = {};

  for (const item of FILES) {
    const filePath = path.join(root, item.rel);
    const value = await readLocalFileText(ctx, filePath);
    if (value && typeof value === "object" && typeof value.error === "string") {
      errors[item.key] = value.error;
      files[item.key] = null;
      continue;
    }
    const limit = Number(budget?.[item.budget]) || PERSONA_BUDGET[item.budget];
    const raw = toText(value) ?? "";
    files[item.key] = clip(item.shape ? item.shape(raw) : raw, limit);
  }

  // 方言口吻单独走一趟：AGENTS.md 整份不进提示词，只取带标记的那块
  const agentsRaw = await readLocalFileText(ctx, path.join(root, "AGENTS.md"));
  if (agentsRaw && typeof agentsRaw === "object" && typeof agentsRaw.error === "string") {
    errors.dialect = agentsRaw.error;
    files.dialect = null;
  } else {
    files.dialect = clip(extractDialectBlock(toText(agentsRaw) ?? ""), Number(budget?.dialect) || PERSONA_BUDGET.dialect);
  }

  const extras = {};
  for (const rel of Array.isArray(extra) ? extra : []) {
    const value = await readLocalFileText(ctx, path.join(root, rel));
    extras[rel] =
      value && typeof value === "object" && typeof value.error === "string"
        ? null
        : clip(toText(value), Number(budget?.extra) || 6000);
  }

  return {
    agentId,
    files,
    extras,
    errors,
    readAt: new Date().toISOString(),
  };
}

/** 界面用语：给写卡的人看的文件名。跟体检那边的叫法保持一致。 */
export const PERSONA_FILE_LABELS = Object.freeze({
  dialect: "说话口吻（AGENTS.md 里的方言块）",
});

/**
 * 盘点每份设定文件进来多少：原文多少字、上限多少、被砍掉多少。
 *
 * 为什么要有这个：clip() 超预算时只在正文末尾留一句「…（后略，原文 N 字）」，
 * 那句话是给模型看的。写文件的人从头到尾不知道自己的哪一段根本没被读到，
 * 只能靠猜。这份盘点专给她看，只读文件，不碰聊天那条路，也不进任何提示词。
 *
 * 方言块按 AGENTS.md 里标记出来的整块算长度——那才是真正进提示词的那部分。
 *
 * @returns {{agentId: string, files: Array, trimmedCount: number, readAt: string}}
 */
export async function readPersonaUsage(ctx, { agentsRoot, agentId, budget = PERSONA_BUDGET } = {}) {
  if (!isValidPartnerId(agentId)) return { agentId, files: [], trimmedCount: 0, readAt: new Date().toISOString() };
  const root = path.join(agentsRoot, agentId);
  const rows = [];

  for (const item of FILES) {
    const limit = Number(budget?.[item.budget]) || PERSONA_BUDGET[item.budget];
    const value = await readLocalFileText(ctx, path.join(root, item.rel));
    if (value && typeof value === "object" && typeof value.error === "string") {
      rows.push({ key: item.key, label: item.label, status: "unreadable", chars: 0, budget: limit, dropped: 0, droppedHead: "" });
      continue;
    }
    const raw = toText(value) ?? "";
    // 盘点要说的是「真正进提示词那份有多长」，不是原文件有多长：近况只取两节，
    // 拿整份 memory.md 的字数吓人，她改了别处也不该算在这份账上。
    rows.push(usageRow(item.key, item.label, item.shape ? item.shape(raw) : raw, limit));
  }

  const agentsRaw = await readLocalFileText(ctx, path.join(root, "AGENTS.md"));
  if (agentsRaw && typeof agentsRaw === "object" && typeof agentsRaw.error === "string") {
    rows.push({ key: "dialect", label: PERSONA_FILE_LABELS.dialect, status: "unreadable", chars: 0, budget: PERSONA_BUDGET.dialect, dropped: 0, droppedHead: "" });
  } else {
    const limit = Number(budget?.dialect) || PERSONA_BUDGET.dialect;
    rows.push(usageRow("dialect", PERSONA_FILE_LABELS.dialect, extractDialectBlock(toText(agentsRaw) ?? "") ?? "", limit));
  }

  return {
    agentId,
    files: rows,
    trimmedCount: rows.filter((row) => row.status === "trimmed").length,
    readAt: new Date().toISOString(),
  };
}

/** 一份文件的用量。超了就把被砍掉那段的开头摘一小截出来——她能一眼认出那是不是自己精心写的。 */
function usageRow(key, label, text, limit) {
  const chars = text.length;
  const dropped = Math.max(0, chars - limit);
  return {
    key,
    label,
    status: chars === 0 ? "empty" : dropped > 0 ? "trimmed" : "ok",
    chars,
    budget: limit,
    dropped,
    droppedHead: dropped > 0 ? text.slice(limit, limit + 60).replace(/\s+/g, " ").trim() : "",
  };
}

const RENDER_ORDER = ["identity", "description", "dialect", "pinned", "facts", "now", "experience"];

/**
 * 挑出最能代表「这个人是谁」的那一段。
 *
 * identity.md 是正主。但有些伙伴压根没写过它（目录里只有 description.md 和 AGENTS.public.md），
 * 那就往下退：自我介绍 → 对外公开那份 → 她自己钉选的几条。都空才算真没料。
 *
 * @returns {{ key: string|null, text: string }}
 */
export function personaSeedText(files) {
  for (const key of ["identity", "description", "public", "pinned"]) {
    const text = files?.[key];
    if (typeof text === "string" && text.trim()) return { key, text };
  }
  return { key: null, text: "" };
}

/** 把模板占位符换成真名。人设文件里写着 {{agentName}} 却没被渲染过时，
 *  直接拼进去等于给了个空名字（实机：真有伙伴的 AGENTS.public.md 整份是这个状态）。 */
function fillTemplate(text, { partnerName = "", userName = "" } = {}) {
  return String(text ?? "")
    .replace(/\{\{\s*(?:agentName|agent_name|char|name)\s*\}\}/gi, String(partnerName).trim() || "你")
    .replace(/\{\{\s*(?:userName|user_name|user)\s*\}\}/gi, String(userName).trim() || "对方");
}

/** 把人格与记忆拼成给模型看的参考段落。 */
export function renderPersona(persona, { partnerName = "", userName = "", nameFallback = false } = {}) {
  if (!persona) return "";
  const parts = [];
  const rawKeys = new Set(Array.isArray(persona.rawKeys) ? persona.rawKeys : []);
  const push = (label, text, raw = false) => {
    const filled = (raw ? String(text ?? "") : fillTemplate(text, { partnerName, userName })).trim();
    if (filled) parts.push(`【${label}】\n${filled}`);
  };
  const labels = { identity: "人格", description: "你是谁", dialect: "说话口吻", pinned: "钉选记忆", facts: "记忆", now: "近况", experience: "经验" };
  const has = (key) => typeof persona.files?.[key] === "string" && persona.files[key].trim();
  const hasIdentity = has("identity");
  const hasDescription = has("description");
  // identity.md 是正主；没写过它的伙伴（实机里就有）至少把自我介绍当「你是谁」接上，
  // 否则提示词里对自己一无所知，容易把上下文里别人的名字当成自己。
  for (const key of RENDER_ORDER) {
    if (key === "description" && hasIdentity) continue;
    push(labels[key], persona.files?.[key], rawKeys.has(key));
  }
  // 为了聊天那头专门开的（nameFallback）：连自我介绍都没有的伙伴（分享版里很常见：
  // 写上名字就装上了），至少把名字锚死，别让 ta 空着手进聊天。
  // 其他后台生成（爱好/作息/动作文案）不开这扇门：没料就该老老实实不生成，不硬编。
  const name = String(partnerName).trim();
  if (nameFallback && !hasIdentity && !hasDescription && name) {
    parts.unshift(`【你是谁】\n你就是「${name}」。`);
  }
  return parts.join("\n\n");
}
