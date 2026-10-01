/**
 * 立场料：让伙伴撞到自己在意的东西时，手上真有东西可守。
 *
 * 由来：模型每轮回话都是从零开始，看不到「我在这件事上是什么态度」，
 * 于是对方一皱眉就顺着改口。这里不新增规矩，只把伙伴自己已经有的东西
 * 翻出来摆在 ta 眼前：
 *   · 正聊到 ta 某个兴趣上时，把这个兴趣的 friction（不喜欢什么、不越过什么边界）拎出来；
 *   · ta 自己最近说过的明确判断句，作为「你之前是这么说的」还给 ta；
 *   · 连着几轮回复里没有一句自己的看法时，标一句「这一阵有点太顺」。
 *
 * 纯逻辑：不碰模型、不碰文件，一个字都不写回 Hana 的伙伴文件。
 *
 * 第 3 条是粗判，宁可漏也不能把沉默和温柔误判成讨好，所以它要同时满足
 * 「没有自己的判断」和「在附和或极短」两件事才计数；真触发了也只是提醒
 * 「留意一下」，不是要求 ta 去顶嘴。
 */

/** 句子里出现这些，说明这句带了说话人自己的判断，不是纯附和。 */
const OWN_STANCE_RE = /(我觉得|我倒|我认为|我猜|说真的|老实说|其实|我更喜欢|我最(?:爱|喜欢|烦|讨厌)|我不喜欢|我受不了|我讨厌|我宁愿|我宁可|别|不要|不用|没必要|不至于|得先|先别|还是)/u;

/** 附和或敷衍的开头。只有这些、又没有判断句，才算顺着接。 */
const ECHO_RE = /^(?:对|是|嗯|哦|嗷|哈|哈哈|笑死|确实|真的|好嘛|要得|可以|行|好|懂了|明白|收到|谢谢|抱抱|好耶|就是)/u;

/** 极短回复也当顺着接：一句话没接住什么。 */
const ECHO_MAX_CHARS = 12;
const MIN_ANCHOR_CHARS = 6;
const MAX_ANCHOR_CHARS = 60;
/** 连着几条算「太顺」。 */
export const ECHO_MIN_STREAK = 3;

const clean = (value, max = 200) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

/** 聊天记录里真正算「说过话」的那几条。 */
function talkativeAssistant(row) {
  return row?.role === "assistant"
    && row?.kind !== "action"
    && row?.kind !== "poke"
    && !row.recalled
    && String(row?.text ?? "").trim().length > 0;
}

/** 一条回复算不算「纯顺着对方接」。 */
export function isEchoReply(text) {
  const body = clean(String(text ?? "").replace(/\n+/gu, " "), 400);
  if (!body) return false;
  if (OWN_STANCE_RE.test(body)) return false;
  if (/[？?]/u.test(body)) return false;
  if (ECHO_RE.test(body)) return true;
  return body.length <= ECHO_MAX_CHARS;
}

/** 从最近往回数，连着几条回复是纯顺着接的。 */
export function echoStreak(messages, { max = 8 } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter(talkativeAssistant);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && streak < max; i -= 1) {
    if (!isEchoReply(rows[i].text)) break;
    streak += 1;
  }
  return streak;
}

/**
 * 伙伴自己最近说过的明确判断句。
 *
 * 只认 ta 自己发的、带判断词的整句；带方括号标记的（表情包之类）和太短太长的一律不要。
 * 取回来是为了让 ta 有东西可守，不是拿来当话题说。
 */
export function stanceAnchors(messages, { limit = 3, scan = 24 } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter(talkativeAssistant).slice(-scan);
  const out = [];
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const sentences = String(rows[i].text)
      .split(/[。！？!?；;\n]+/u)
      .map((row) => clean(row, 400));
    for (const sentence of sentences) {
      // 先按原句长度筛，再截图：先截后比的话超长句会被截成合法的长度混进来。
      if (sentence.length < MIN_ANCHOR_CHARS || sentence.length > MAX_ANCHOR_CHARS) continue;
      if (/[[\]]/u.test(sentence)) continue;
      if (!OWN_STANCE_RE.test(sentence)) continue;
      const key = sentence.replace(/[\s，,。！!？?、；;：:]/gu, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sentence);
      break;
    }
  }
  return out.reverse();
}

/**
 * 现在聊的这件事落在 ta 哪个兴趣上。
 *
 * 优先认「上一条自己发的消息挂着的兴趣」——主动分享那条会带 interestId / interestName，
 * 那是最准的。旧账里没有这个字段的，退回拿兴趣名和落点在最近这句话里做词面命中；
 * 两种都认不出来就什么都不给，宁可不提。
 */
export function hobbyInPlay({ messages, hobbies, text = "" } = {}) {
  const list = (Array.isArray(hobbies) ? hobbies : []).filter((row) => row?.name);
  if (!list.length) return null;
  const rows = Array.isArray(messages) ? messages : [];
  const lastAssistant = [...rows].reverse().find(talkativeAssistant);
  const wanted = [lastAssistant?.interestId, lastAssistant?.interestName]
    .filter(Boolean)
    .map((row) => String(row).trim());
  for (const key of wanted) {
    const hit = list.find((row) => String(row.id ?? "").trim() === key || String(row.name ?? "").trim() === key);
    if (hit) return hit;
  }
  const body = clean(text, 400);
  if (!body) return null;
  return list.find((row) => {
    const words = [row.name, row.object]
      .map((word) => clean(word, 40))
      .filter((word) => word.length >= 2 && word.length <= 8);
    return words.some((word) => body.includes(word));
  }) ?? null;
}

/** 把三样东西拼成一段给人看的提示词。没料就是空串，不占位置。 */
export function buildStanceText({ inPlay = null, anchors = [], echo = 0, minEcho = ECHO_MIN_STREAK } = {}) {
  const blocks = [];
  const friction = clean(inPlay?.friction, 160);
  if (friction) {
    blocks.push([
      "【你现在正踩在自己在意的东西上】",
      `这件事就是你长期感兴趣的「${clean(inPlay?.name, 40)}」。在这上头你自己的态度是：${friction}`,
      "这就是你的态度，不用往回收。对方不懂、没玩过、不感兴趣，都不构成你要改口的理由；想讲就把好在哪讲清楚，不想讲就收着不提，但不许把你自己刚讲过的东西判成说错了或者串了题。",
    ].join("\n"));
  }
  const rows = (Array.isArray(anchors) ? anchors : []).map((row) => clean(row, MAX_ANCHOR_CHARS)).filter(Boolean);
  if (rows.length) {
    blocks.push([
      "【你自己最近是这么说的】",
      ...rows.map((row) => `· ${row}`),
      "这些是你自己的判断，不是对方说的。别下一条就掉头改成另一套；真要改，得是你自己改了主意。",
    ].join("\n"));
  }
  const streak = Math.max(0, Number(echo) || 0);
  if (streak >= minEcho) {
    blocks.push([
      "【这一阵你有点太顺】",
      `连着 ${streak} 轮你的回复里没有一句自己的看法，全在顺着对方接。`,
      "留意一下这个：同意不同意得是你自己判断出来的，不是因为她说了。也别为了显得有脾气去顶嘴，有不同意的就说，没有就照常。",
    ].join("\n"));
  }
  return blocks.join("\n\n");
}
