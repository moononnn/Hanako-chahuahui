/**
 * 伙伴自己翻旧图（工具）。
 *
 * 她可能隔一天才回头问「昨天五点那张图是什么」。上下文里那 24 条早已换了人，
 * 靠记忆答就是猜。所以得给它一条真能翻的路：按时间范围、按关键词去找，
 * 找到就把时间、她当时的原话、这张图的标题和描述一起交回来。
 *
 * 这里只放纯逻辑（工具声明、时间解析、筛与排）。真正的读写留在 index.js。
 */

export const IMAGE_TOOL_NAME = "find_image";

/** 落在她眼前最多几条：翻出二十条也读不完，反而挤掉她正要问的那张。 */
export const MAX_IMAGE_ROWS = 6;

/** 工具声明（AppModelToolV2：JSON Schema，执行在应用这一侧）。 */
export const IMAGE_TOOL = {
  name: IMAGE_TOOL_NAME,
  description: "翻她以前发给你的图片。按时间范围（她说过「昨天五点那张」就填那天的那个小时）或关键词找，回你每张图的发送时间、她当时的原话、图的标题和描述。这里拿到的是当初看图时写下的描述：她问的细节里头没有的，就说看不清，别替那张图补内容。",
  parameters: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "最早到什么时候，写 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。她说「昨天五点」就写昨天那一天的 17:00。不填就从最早的图开始。",
      },
      until: {
        type: "string",
        description: "最晚到什么时候，格式同上。不填就到此刻。她说「五点那张」时，since 和 until 都给那一小时能把范围卡准。",
      },
      keyword: {
        type: "string",
        description: "关键词：图里有的东西、或者她当时说的话里有的词。只给时间范围也能找。",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * 把工具给的时间字符串读成时间戳。
 *
 * 只认「年-月-日」和「年-月-日 时:分」两种写法：模型偶尔会塞一句自然语言进来，
 * 那种不猜，当没填。宁可按时间全量翻，也别按一个猜错的时间翻。
 */
export function parseImageTime(text, { endOfDay = false } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const hit = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/u);
  if (!hit) return null;
  const [, y, mo, d, h, mi] = hit;
  const hasClock = h !== undefined;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), hasClock ? Number(h) : (endOfDay ? 23 : 0), hasClock ? Number(mi) : (endOfDay ? 59 : 0), hasClock ? 0 : (endOfDay ? 59 : 0));
  return Number.isFinite(at.getTime()) ? at.getTime() : null;
}

/** 时间范围：缺哪头补哪头，不会因为只写了一个 since 就把之后全挡掉。 */
export function resolveImageRange({ since, until } = {}, now = Date.now()) {
  const from = parseImageTime(since) ?? 0;
  const to = parseImageTime(until, { endOfDay: true }) ?? now;
  return { from, to: Math.max(from, to) };
}

/**
 * 从聊天记录里挑出符合条件的那些图。
 *
 * 认的是消息而不是图片文件：同一张图她发过两回，那是两个时刻，
 * 她说「五点那张」指的是其中一条消息，所以时间要按消息算，不按附件算。
 */
export function pickImageMessages(messages, { from, to, keyword } = {}, describeOf = null) {
  const words = String(keyword ?? "").trim().toLowerCase();
  const out = [];
  for (const row of Array.isArray(messages) ? messages : []) {
    if (row?.role !== "user" || !row?.attachment?.id) continue;
    const at = Date.parse(row?.at ?? "");
    if (!Number.isFinite(at)) continue;
    if (at < from || at > to) continue;
    const meta = typeof describeOf === "function" ? describeOf(row.attachment.id) : null;
    const haystack = [row.text, row.visionNote, meta?.title, meta?.description]
      .filter(Boolean).join(" ").toLowerCase();
    if (words && !words.split(/\s+/u).every((word) => haystack.includes(word))) continue;
    out.push({
      attachmentId: row.attachment.id,
      at,
      said: String(row.text ?? "").trim(),
      title: String(meta?.title ?? "").trim(),
      description: String(meta?.description ?? row.visionNote ?? "").trim(),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 本地时间戳写成「10-26 17:00」，跟聊天里看到的那个时间对得上。 */
function stamp(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 翻到的结果排成给伙伴看的一段。
 *
 * 每条都带上「她当时的原话」：那是分辨「五点这张」和「五点半那张」最实在的东西，
 * 光看描述两张长得像的截图永远是同一个故事。
 */
export function formatImageMatches(rows, { maxRows = MAX_IMAGE_ROWS, maxChars = 2400 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const lines = [`【你翻到的旧图，共 ${list.length} 张】`];
  for (const row of list.slice(0, maxRows)) {
    const when = stamp(row.at);
    const said = row.said ? `她说「${row.said.slice(0, 60)}」` : "她当时没说话";
    const title = row.title ? `｜${row.title}` : "";
    lines.push(`· ${when} ${said}${title}`);
    if (row.description) lines.push(`  ${row.description.slice(0, 240)}`);
    if (`${lines.join("\n")}`.length > maxChars) break;
  }
  if (list.length > maxRows) lines.push(`（还有 ${list.length - maxRows} 张没列出来，把时间范围收窄一点再翻。）`);
  return lines.join("\n").slice(0, maxChars);
}

/** 一张都没翻到时给伙伴的话：别编，也别解释内部怎么回事。 */
export const IMAGE_TOOL_EMPTY_TEXT = "这段时间没翻到她发过的图。直接说没找到，别猜是哪张，也别编图里的内容。";
