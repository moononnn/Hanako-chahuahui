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
};

const FILES = [
  { key: "identity", rel: "identity.md", budget: "identity" },
  { key: "description", rel: "description.md", budget: "description" },
  { key: "public", rel: "AGENTS.public.md", budget: "public" },
  { key: "pinned", rel: "pinned.md", budget: "pinned" },
  { key: "facts", rel: path.join("memory", "facts.md"), budget: "facts" },
  { key: "experience", rel: "experience.md", budget: "experience" },
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
 * 方言（表情包插件的「口吻」功能）是把一整段说话习惯写进 AGENTS.md 的，主对话框靠它说方言。
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
    files[item.key] = clip(value, limit);
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

const RENDER_ORDER = ["identity", "description", "dialect", "pinned", "facts", "experience"];

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
  const push = (label, text) => {
    const filled = fillTemplate(text, { partnerName, userName }).trim();
    if (filled) parts.push(`【${label}】\n${filled}`);
  };
  const labels = { identity: "人格", description: "你是谁", dialect: "说话口吻", pinned: "钉选记忆", facts: "记忆", experience: "经验" };
  const has = (key) => typeof persona.files?.[key] === "string" && persona.files[key].trim();
  const hasIdentity = has("identity");
  const hasDescription = has("description");
  // identity.md 是正主；没写过它的伙伴（实机里就有）至少把自我介绍当「你是谁」接上，
  // 否则提示词里对自己一无所知，容易把上下文里别人的名字当成自己。
  for (const key of RENDER_ORDER) {
    if (key === "description" && hasIdentity) continue;
    push(labels[key], persona.files?.[key]);
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
