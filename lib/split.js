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

// URL 内的 ASCII 标点属于链接；空白、引号、括号和中文标点仍是正文边界。
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`()\[\]{}（）【】《》「」『』“”‘’。，、！？；：…～]+/giu;

/**
 * 正文开头那种时间戳标题：【2026年10月10日 15:00】/【15:00】/【现在】。
 *
 * 有的模型会照抄提示词里【现在】那一块的格式，把时刻顶到第一条气泡上（2026-10-10
 * 实机，deepseek-flash 每条都带）。这是壳不是话，切条之前先摘掉。
 * 只认完整日期、钟点和固定时间标题；【生气】【小声】这种情绪括号不动。
 */
const LEADING_BRACKET = /^【\s*([^】]{0,48}?)\s*】[ \t]*\r?\n?/;
const CLOCK_TITLE = /^\d{1,2}\s*[:：]\s*\d{2}$/u;
const DATE_TITLE = /^\d{4}(?:\s*-\s*\d{1,2}\s*-\s*\d{1,2}|\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}|\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}|\s*年\s*\d{1,2}\s*月\s*\d{1,2}日?)(?:\s+\d{1,2}\s*[:：]\s*\d{2})?$/u;
/** 整格就是这些精确形状时才算标题；装饰性时间括号不算。 */
const TIME_WORD = /^(现在|此刻|时间|日期)$/;
const TIME_HEADER_LINE = /^[ \t]*【\s*([^】]{0,48}?)\s*】[ \t]*$/u;
const PROACTIVE_CONTEXT_PREFIX = "［这条是你主动找她说的，她没先开口";

function stripProactiveContextMarkers(raw) {
  const text = String(raw ?? "");
  let cursor = 0;
  let out = "";
  while (cursor < text.length) {
    const start = text.indexOf(PROACTIVE_CONTEXT_PREFIX, cursor);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "［") depth += 1;
      else if (text[i] === "］" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) break;

    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const markerAtLineStart = !text.slice(lineStart, start).trim();
    let removeStart = markerAtLineStart ? lineStart : start;
    let after = end;
    while (text[after] === " " || text[after] === "\t") after += 1;
    const markerOnlyOnLine = after === text.length || text[after] === "\r" || text[after] === "\n";
    if (markerAtLineStart && markerOnlyOnLine && removeStart > cursor && text[removeStart - 1] === "\n") {
      removeStart -= 1;
      if (removeStart > 0 && text[removeStart - 1] === "\r") removeStart -= 1;
    }
    out += text.slice(cursor, removeStart);
    cursor = after;
  }
  return out + text.slice(cursor);
}

function isInternalTimeTitle(raw) {
  const title = String(raw ?? "").trim();
  return TIME_WORD.test(title) || CLOCK_TITLE.test(title) || DATE_TITLE.test(title);
}

/** 只剥内部时间标题和主动来由块，保留正文里的时间表达、情绪括号与同行正文。 */
export function stripInternalContextLines(raw) {
  return stripProactiveContextMarkers(raw)
    .split(/\r?\n/u)
    .filter((line) => {
      const time = TIME_HEADER_LINE.exec(line);
      return !(time && isInternalTimeTitle(time[1]));
    })
    .join("\n")
    .trim();
}

/**
 * 摘掉开头最多两个时间戳标题行。
 *
 * @param {string} raw 模型原始回复
 * @returns {string} 摘干净之后的正文；整段只有标题时返回空串（交给上层按空回复处理）
 */
export function stripTimeHeader(raw) {
  let text = String(raw ?? "");
  for (let i = 0; i < 2 && text; i += 1) {
    const matched = LEADING_BRACKET.exec(text);
    if (!matched || !isInternalTimeTitle(matched[1])) break;
    text = text.slice(matched[0].length);
  }
  return text.trim();
}

// 仅处理已撞到的 quote 外壳；保留引用正文，不吞中文标记、[ok]或讲解中的字面标签。
export function stripQuoteMarkup(raw) {
  return String(raw ?? '')
    .replace(/\[quote(?:=[^\]\r\n]{0,120})?\]([\s\S]*?)\[\/quote\]/giu, '$1')
    .replace(/^[ \t]*\[\/?quote(?:=[^\]\r\n]{0,120})?\][ \t]*(?:\r?\n|$)/gimu, '');
}

export const DEFAULT_SPLIT = {
  /** 一次最多出几条气泡，超出就并尾巴 */
  maxBubbles: 6,
  /** 单条气泡字数上限，超了就在最近的标点处再切 */
  maxChars: 200,
};

function trimBubble(text) {
  let out = String(text ?? "").trim();
  const lastUrl = [...out.matchAll(HTTP_URL_RE)].at(-1);
  const urlEnd = lastUrl ? lastUrl.index + lastUrl[0].length : -1;
  // 吃掉句末多余标点，但保留情绪标点和 URL 自身的尾部标点
  while (out.length > 0) {
    if (out.length === urlEnd) break;
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
  const urls = new Map([...text.matchAll(HTTP_URL_RE)].map((match) => [match.index, match[0]]));
  for (let i = 0; i < text.length; i += 1) {
    const url = urls.get(i);
    if (url) {
      buf += url;
      i += url.length - 1;
      continue;
    }
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
    const crossingUrl = [...rest.matchAll(HTTP_URL_RE)].find((match) =>
      match.index < cutAt + 1 && match.index + match[0].length > cutAt + 1);
    if (crossingUrl) {
      // 链接不可切断：先切前文；链接本身超长时允许单条超过字数预算。
      cutAt = crossingUrl.index > 0 ? crossingUrl.index - 1 : crossingUrl[0].length - 1;
    }
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
  const text = stripTimeHeader(stripInternalContextLines(raw));
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
