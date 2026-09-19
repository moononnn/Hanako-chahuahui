/**
 * 分条器：把模型的一整段回复切成几条短消息。
 *
 * 依据调研（AstrBot / astrbot_plugin_splitter）：
 *  - 一次生成 + 后处理按标点切，末尾必须有兜底分支，否则结尾无标点的残句会丢
 *  - 成对符号（括号/引号/书名号）内部不断句
 *  - 代码块整体不拆
 *  - **断句标点 ≠ 显示标点**：切完要吃掉句末的逗号句号，保留问号叹号波浪号省略号
 */

const PAIR_OPEN = "（(【[《「“‘";
const PAIR_CLOSE = "）)】]》」”’";

/** 可靠的硬断点 */
const HARD_BREAK = "。！？!?…~～；;";
/** 换行也算断点，但单独处理（连续空行折叠） */
const SOFT_BREAK = "\n";

/** 句末要吃掉的字（真人手机聊天里不会出现） */
const DROP_TRAILING = "。.，,、；;：:";
/** 句末要保留的字 */
const KEEP_TRAILING = "？！?!~～…";

export const DEFAULT_SPLIT = {
  /** 一次最多出几条气泡，超出就并尾巴 */
  maxBubbles: 6,
  /** 单条气泡字数上限，超了就在最近的标点处再切 */
  maxChars: 200,
};

function trimBubble(text) {
  let out = String(text ?? "").trim();
  // 吃掉句末多余标点，但保留情绪标点
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (KEEP_TRAILING.includes(last)) break;
    if (DROP_TRAILING.includes(last)) {
      out = out.slice(0, -1).trimEnd();
      continue;
    }
    break;
  }
  return out.trim();
}

/** 按标点切段，跳过成对符号内部。 */
function cutSegments(text) {
  const segments = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    buf += ch;
    if (PAIR_OPEN.includes(ch)) depth += 1;
    else if (PAIR_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth > 0) continue;

    if (HARD_BREAK.includes(ch)) {
      while (i + 1 < text.length && HARD_BREAK.includes(text[i + 1])) {
        buf += text[i + 1];
        i += 1;
      }
      segments.push(buf);
      buf = "";
      continue;
    }
    if (SOFT_BREAK.includes(ch)) {
      if (buf.trim()) segments.push(buf);
      buf = "";
    }
  }
  // 兜底：结尾没有标点的残句也要收进来，否则会丢
  if (buf.trim()) segments.push(buf);
  return segments;
}

/** 对过长的单条再切一刀（优先在最近的软标点处断）。 */
function enforceMaxChars(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cutAt = -1;
    for (let i = window.length - 1; i >= Math.floor(maxChars * 0.4); i -= 1) {
      if ("，,、；;：: ".includes(window[i])) {
        cutAt = i;
        break;
      }
    }
    if (cutAt < 0) cutAt = maxChars - 1;
    parts.push(rest.slice(0, cutAt + 1));
    rest = rest.slice(cutAt + 1);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** 把尾部几条合并到上一条，直到条数不超上限。 */
function capBubbles(list, maxBubbles) {
  const out = [...list];
  while (out.length > maxBubbles) {
    const tail = out.pop();
    out[out.length - 1] = `${out[out.length - 1]} ${tail}`;
  }
  return out;
}

/**
 * @param {string} raw 模型原始回复
 * @param {object} [config] 覆盖 DEFAULT_SPLIT
 * @returns {string[]} 可直接当气泡发出的短消息
 */
export function splitReply(raw, config = {}) {
  const cfg = { ...DEFAULT_SPLIT, ...config };
  const text = String(raw ?? "").trim();
  if (!text) return [];

  // 代码块整体不拆（避免把代码切碎）
  if (text.includes("```")) return [`${text}`];

  const cut = [];
  for (const segment of cutSegments(text)) {
    for (const piece of enforceMaxChars(segment, cfg.maxChars)) cut.push(piece);
  }

  const cleaned = [];
  for (const piece of cut) {
    const value = trimBubble(piece);
    if (!value) continue;
    // 纯标点碎片一般不成条（真人不会单独发一个「……」），
    // 但「？」「！」例外：催人的时候一个问号就是一条消息
    if (!/[\p{L}\p{N}]/u.test(value) && !/[?？!！]/.test(value)) continue;
    cleaned.push(value);
  }

  if (cleaned.length === 0) return [text];
  return capBubbles(cleaned, cfg.maxBubbles);
}
