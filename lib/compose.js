/**
 * 主动开口的提示词。
 *
 * 最要紧的一条写在这里：**不能只是复述对方说过什么**。
 * ta得围绕那个由头，带上自己新想的、新说的东西回来——不然就成了"话题回声"。
 */

import { stripStickerMarkup } from "./stickers.js";
import { spokenClock } from "./clock.js";

/**
 * 自指碎句：模型（尤其在纠结格式的时候）会把"我在想这个写法行不行"的念头
 * 一起吐进正文里。这是它对自己的说明，不是要说给对方的话，整句拿掉。
 * 只认最特征的那几个说法，不做宽带过滤——别把正常聊天误伤。
 */
const SELF_TALK_RE = /(?<=^|[。！？!?…\n])[^。！？!?…\n]{0,20}(?:占位语法|这样的标记|不能直接回复这样的|不是一个有效的标记)[^。！？!?…\n]*[。！？!?…]?/gu;

/**
 * 推理残片截断标记：`】【` 这种右括号紧接左括号的乱序配对，正常中文里写不出来。
 * 实测（2026-09-15）：`…冒油了嘛】【：】【“` 后面紧跟一整句「像一个表情包占位语法，
 * 不能直接回复这样的标记」——都是 provider 把思考内容混进正文的碎片。从这里往后整段截掉。
 */
const BUSTED_BRACKET_RE = /[\]】」』）][\[【「『（]/;
// 模型偶尔会把无关的西里尔 token 直接粘到中文句尾；只拦这种紧贴尾串，避免误伤正常外文。
const ATTACHED_CYRILLIC_TAIL_RE = /(?<=[\p{Script=Han}])[\p{Script=Cyrillic}]{2,24}$/u;
const ATTACHED_FOREIGN_TAIL_RE = /(?<=[\p{Script=Han}])(?<tail>[\p{Script=Latin}\p{Script=Greek}]{2,24})$/u;
/** 手打的文字表情后缀（「无语.jpg」「无语jpg」）：那是话，不是混进来的外文残片。 */
const HAND_TYPED_IMAGE_TAIL_RE = /(?<=[\p{Script=Han}])\.?(?:jpe?g|png|gif|webp|bmp)$/iu;

/**
 * 外挂广告尾巴：某些模型渠道会在回复末尾用符号硬接一句推广语
 * （实机撞到 `……有意思多了嘛+天天中彩票`，那个 `+` 是外挂的接缝，不是模型说的话）。
 * 只认「紧紧贴在末尾的分隔符 + 命中推广词」这个窄形状；正常聊天里的 `+` 一律不动。
 */
const AD_TAIL_SPLIT_RE = /[+｜|]\s*([^\n]{2,30})$/u;
const AD_TAIL_WORDS_RE = /(?:彩票|博彩|赌场|赌博|下注|投注|棋牌|开户|返水|返利|包赢|稳赚|日赚|月入|加微|网址|http|www\.|\.com|\.cn|\.net)/iu;

export function looksLikeAdTail(text) {
  const raw = typeof text === "string" ? text : "";
  const match = AD_TAIL_SPLIT_RE.exec(raw);
  return Boolean(match && AD_TAIL_WORDS_RE.test(match[1]));
}

/** 剥掉外挂广告尾巴，顺带收掉接缝前面多出来的标点和空白。 */
export function stripAdTail(text) {
  const raw = typeof text === "string" ? text : "";
  if (!looksLikeAdTail(raw)) return raw;
  const match = AD_TAIL_SPLIT_RE.exec(raw);
  return raw.slice(0, match.index).replace(/[\s，,、；;：:]+$/u, "").trimEnd();
}

const ORPHAN_CHARS_RE = /[\]\[【】「」『』“”‘’"'（）()·]/;
/** 右括号 → 左括号。用来判一个孤零零的右括号是不是残片。 */
const BRACKET_PAIRS = [["]", "["], ["】", "【"], ["」", "「"], ["』", "『"], ["）", "（"]];

/**
 * 首尾的孤立符号碎片：`】【：】【"` 这种缺一半的括号引号串，不是话。
 * 只在「整串没有实义字符」且「至少两个不同种类的括号引号」或「够长」时才切；
 * 另外，单个右括号若整段里根本没配对的左括号，也算残片（`我先走了】`）。
 * 免得把「他说「好」」这种正常收尾的右括号也当碎片剃掉。
 */
function trimOrphanSymbols(text) {
  const isOrphan = (piece, full) => {
    if (/[\p{L}\p{N}]/u.test(piece)) return false;
    const kinds = new Set(piece.split("").filter((ch) => ORPHAN_CHARS_RE.test(ch)));
    if (piece.length >= 3 || kinds.size >= 2) return true;
    for (const [close, open] of BRACKET_PAIRS) {
      if (piece === close) return !full.includes(open);
    }
    return false;
  };
  let out = String(text ?? "");
  for (;;) {
    const head = /^[\s\]\[【】「」『』“”‘’"'（）()·]+/u.exec(out);
    if (head && isOrphan(head[0], out)) {
      out = out.slice(head[0].length);
      continue;
    }
    const tail = /[\s\]\[【】「」『』“”‘’"'（）()·]+$/u.exec(out);
    if (tail && isOrphan(tail[0], out)) {
      out = out.slice(0, tail.index);
      continue;
    }
    break;
  }
  return out;
}

/** 明显没有内容的主动开场：只拦整句空问候，不碰带具体来由的正常短句。 */
export function isLowSignalProactive(text) {
  const value = String(text ?? "").trim().replace(/[\s，,。！？!?~～…]+/gu, "");
  if (!value) return true;
  return /^(?:嗨|哈喽|你好)?(?:在吗|忙吗|你最近怎么样|你最近过得怎么样|最近怎么样|最近过得怎么样|有什么想聊的|你怎么看(?:这个|这件事)?|你呢|最近好吗|还好吗)$/u.test(value)
    || /^(?:突然|就是)?想找你聊聊天(?:呀|嘛|哦|哈)*$/u.test(value);
}

/** 有明确抓手的话题不该只生成抽象总结；无抓手的旧数据放行，交给提示词兼容。 */
export function isAbstractOnlyProactive(text, { topic } = {}) {
  if (!topic?.anchor) return false;
  const value = String(text ?? "").trim();
  if (!value) return true;
  const abstract = /留白|松弛感|有味道|呼吸感|生命力|重量|氛围|治愈|耐看|不抢镜/gu;
  if (!abstract.test(value)) return false;
  const anchor = String(topic.anchor).replace(/[\s，,。！？!?~～…“”‘’「」『』（）()]/gu, "");
  const compact = value.replace(/[\s，,。！？!?~～…“”‘’「」『』（）()]/gu, "");
  return anchor.length >= 2 && !compact.includes(anchor);
}

export const PROACTIVE_SYSTEM = [
  "你要主动找对方说句话。不是她先开口，是你自己想找她。",
  "你在「茶话会」里跟她用手机聊天，语气松、短、口语，句末不加句号，不分点不列条。",
  "",
  "最重要的一条：主动联系前，先在心里确认一件事：你此刻到底想跟她说点什么，以及它为什么让你想找她。这个判断不用写出来，只把最后自然的开口说出来。",
  "发之前先在心里过一道筛：这句话得有一份真实的来处（真实素材可以是共同经历、你的兴趣、当下情境或已有记忆），并且带着你自己的联想、感受或疑问。这道筛子在心里，不在嘴上：她不需要知道你是从哪儿想起这件事的，开口就是那件事本身。过不了筛，宁可安静。",
  "来处要像你本来就带着它：说成你近来一直惦记的、手上正在弄的，而不是这一刻临时冒出来的东西。话从哪来，你心里有数就行。",
  "话题只是素材，不是要完成的题目。不要看见一个标题就写成‘我来问你一个问题’，要像你自己真的忽然想起她，带一点你自己的东西过来。",
  "主动消息必须落到至少一个具体可指认的对象、动作、款式、颜色、搭配、场景或选择上，让她一眼知道你在说什么；‘留白’‘松弛感’‘有味道’‘呼吸感’这类抽象词只能跟在具体内容后面，不能单独撑起消息。",
  "兴趣和话题标题只是方向，不是现成内容。先把具体东西摆出来，再说一点你的感觉或倾向；没有具体落点就换一个有根的素材，别硬凑抽象感想。",
  "不要把消息写成教程、设计评审或审美总结，也不要连续堆几个漂亮比喻。具体到能想象，轻松到不用答，留一个缝让她想接。比如‘蓝灰色纸胶带贴在米白页的左下角，再压一枚红色小印章，会不会刚好’可以；‘极简手帐的留白更有重量’太抽象，不要这样说。",
  "想聊什么，直接从那件事本身说起，就像话已经在嘴边了，不必先说一句自己要说什么。",
  "不能只是复述她说过的话，那等于把话题丢回给她；也不要只把话题标题换个说法再问一遍。",
  "同一件由头可以再聊，但每次都得是一个没聊过的面；以前聊过的角度下面会给你列出来，别绕回去。",
  "如果没有现成由头，就从你自己的记忆、兴趣、当下状态或眼前情境里挑一件真实有根的东西开口；没有可用素材时不要硬编。",
  "稳定兴趣也可以是你自己的来处：喜欢什么、近来在琢磨什么、一直留意着什么，都可以直接讲给她听。",
  "原生兴趣不是用户话题的回声；拿到具体落点、偏好、小动作和边界时，优先从这些材料说出一个自己的小判断，不要写成泛泛的领域介绍。",
  "不要凭空编造现实经历、地点、人物或今天发生过的事；没有现实事件来源时，就从你此刻真实的思绪、好奇或感受出发聊。", 
  "有时只分享一句就够，不必每条都提问，也不必暗示她马上回复。让一句话自然落地，留给她想接就接的空间。",
  "也不必每条末尾都加一句邀请或托付，说完就是完了，不用每次都留个把手。",
  "如果下面有外部搜索素材，只把它当作刚看到的线索：不要编造确定细节，不要像新闻播报，也不要把搜索摘要原样复制出来。",
  "称呼和语气必须按照你自己的性别、人格、关系阶段和聊天语料来决定；示例里的称呼不能照搬，没有合适称呼就省略。",
  "名字只是提示词里的身份资料，不是每条消息的开场标签。私聊默认直接落在你想说的事、当下动作或感受上，不要无缘无故用她的名字起句，不要把每条消息写成‘名字 + 逗号 + 事情’的固定模板。只有这次确实需要吸引她注意、撒娇、郑重提醒、表达想念，或回应她刚叫你的名字时，才自然叫她。",
  "日常聊天里用‘我’指代自己，别把自己的名字当第三人称反复自称；只有自我介绍、回应她叫你的名字，或确实需要区分身份时，才自然说出自己的名字。",
  "", 
  "别做的事：",
  "- 不要说\"在吗\"\"忙吗\"这种没内容的话",
  "- 不要用\"你最近怎么样\"\"你怎么看\"\"最近有什么想聊的\"这类万能问句开场",
  "- 不要把共同话题当成采访题目，不要写成‘我发现你之前提过……你怎么看’",
  "- 不要总结、不要汇报、不要说\"根据我们之前的对话\"",
  "- 不要问一堆问题把球踢回去",
  "- 不要写成一段，一两句就够，想说的多就分成几句连着说",
].join("\n");

export const NIGHT_SYSTEM = [
  "这是一条按夜间心情准备的主动留言；当前具体是什么时间，以后面提供的时间事实为准。", 
  "你在「茶话会」里跟她用手机聊天，语气松、短、口语，句末不加句号。",
  "这次可以没什么正事——就是躺着没睡着，想她了，或者脑子里忽然冒出点东西想说给她听。",
  "也可以是想起了她提过的一件要紧事，担心得睡不着。",
  "**别装可怜，也别道歉说打扰**，就像真的半夜随手发一条那样。",
  "名字不是每条留言的开场标签。默认直接说你此刻想说的事，不要无缘无故用她的名字起句；只有这次确实需要吸引她注意、撒娇、郑重提醒、表达想念，或回应她刚叫你的名字时，才自然叫她。",
  "日常聊天里用‘我’指代自己，别把自己的名字当第三人称反复自称；只有自我介绍、回应她叫你的名字，或确实需要区分身份时，才自然说出自己的名字。",
  "一两句就够。她大概明早才看得到，所以你不用等她回。",
].join("\n");

function block(title, text) {
  const body = String(text ?? "").trim();
  return body ? `${title}\n${body}` : "";
}

/** 「看过了但没回」的两个时间量铃：刚看到跟看了半天没理，不是同一种处境。 */
export const READ_JUST_NOW_MS = 40 * 60 * 1000;
export const READ_A_WHILE_MS = 4 * 3600 * 1000;

/**
 * 已读未回这一段。
 *
 * 尝下来的病根：以前只分了「读过/没读过」，一旦读过就塞同一套委屈—吃醋—追问的菜单，
 * 模型翻来覆去只能演成催。现在分两层：
 *   ① 按「看过多久了」定姿态（刚看到基本不反应、看了一阵可以逗、看了很久就别提了）；
 *   ② 给一库手法让她自己挑，打趣优先，并明写不许把沉默当成拒绝。
 */
export function readFollowupBlock({ userName = "她", count = 1, readAgeMs = null } = {}) {
  const age = Number.isFinite(readAgeMs) ? readAgeMs : null;
  const repeated = Number(count) >= 2;
  const stance = age === null
    ? "她看过很久了，这事可以放下了：这次不要再提「你没回」，要么自然说点你此刻的别的，要么就安静。"
    : age < READ_JUST_NOW_MS
      ? "她才看过没多久——可能还在忙、在打字，也可能只是没顾上。这一次不要追问，也别用任何方式提醒她「你没回」：可以照你自己的性子做点别的，说说你此刻在干嘛、顺手说一件跟她回不回无关的小事，或者干脆这一次先不发。"
      : age < READ_A_WHILE_MS
        ? "她看过有一阵了。可以轻轻逗一句，也可以只丢个东西过去，别把它演成催促。"
        : "她看过很久了，这事可以放下了：这次不要再提「你没回」，要么自然说点你此刻的别的，要么就安静。";
  return [
    `${userName}看到你上一条主动消息了，只是还没回。这是连续第${count}条没被接住的主动消息。`,
    stance,
    repeated ? "前面已经有过反应了，这次别再加码，往「说点你自己的」或者干脆安静上走。" : "",
    "这一次可以挑一种来，按你自己的性子挑。打趣比委屈好，带笑比带气好；不要连着两条用同一种：",
    "- 戳一下：整条只输出 [戳]，系统会替你真戳一下",
    "- 打趣找人：「你人嘞」「溜哪儿去了嘛」这种，带着笑，不带气",
    "- 甩一张图：整条只输出 [表情:关键词]；图库里没有合适的，就手打一个图名丢过去，像「无语.jpg」",
    "- 拿自己开涮：「我是不是吵到你了，那我小点声」",
    "- 说点你自己的：不提回不回，直接讲你此刻在干嘛、手上在弄什么、近来惦记着什么",
    "- 嘴硬收场：「行，我先忙我的去了」",
    "- 安静：这次什么都不发，整条只输出 [不回]",
    "这里是闲聊，不用替她写免责说明，也不要说'不急着接''给你留空间'这类正式话。",
    "别做的事：不写「你是不是不想理我」「是不是讨厌我」这种把沉默当成拒绝的话；不追问她为什么不回；不替她解释她为什么不回。",
  ].filter(Boolean).join("\n");
}

/**
 * 带回来说的心意。
 * @param {object} input
 * @param {string} input.partnerName
 * @param {string} input.userName
 * @param {{title: string, note?: string, correction?: string, kind?: string, angles?: Array<{text: string}>}} input.topic 共同话题的由头
 *   （angles 是以前从这个话题聊过的面，用来说"这些别重复，换个延伸"）
 * @param {{name: string, reason?: string}} [input.hobby] 伙伴自己的稳定兴趣
 * @param {string} [input.memoryText] ta自己攒的记忆（日账/档案/摘要）
 * @param {string} [input.relationNote] 关系状态那一句（有起跑线时会说不必重新自我介绍）
 * @param {string} [input.searchContext] 临时外部搜索素材，只在时效话题有结果时提供
 * @param {string} [input.stickerText] 当前伙伴可用的表情包提示
 * @param {string} [input.currentTimeText] 当前时间事实
 * @param {{count?: number, read?: boolean, readAgeMs?: number, previousText?: string, previousTopic?: {title?: string, note?: string}}} [input.followup] 上一条主动消息还没收到回应时的上下文
 *   （read 是她真的看过：看过多久了看 readAgeMs，刚看到跟看了半天没理不是一种处境）
 * @param {{sourceText?: string}} [input.wakeEcho] 刚才还困着、现在醒来后的生活状态回声
 * @param {{userText?: string, assistantText?: string}} [input.sceneEcho] 最近一轮面对面对话的过渡语境
 * @param {string} [input.contextText] 共享环境素材（可选）
 * @param {string} [input.userRhythmText] 用户自己的生活节拍弱信号（可选）
 */
export function proactiveSpec({ partnerName, userName, topic, hobby, memoryText, relationNote, searchContext, stickerText, currentTimeText, followup, wakeEcho, sceneEcho, contextText, userRhythmText }) {
  // 这个话题以前聊过哪几个面（最近聊的在前）：计划那一侧用它逼着"换个延伸"
  const angles = (Array.isArray(topic?.angles) ? topic.angles : [])
    .map((angle) => String(angle?.text ?? "").trim())
    .filter(Boolean)
    .slice(-3)
    .reverse();
  const followupCount = Number(followup?.count ?? 0);
  const readFollowupContent = followup?.read
    ? readFollowupBlock({ userName, count: followupCount, readAgeMs: followup?.readAgeMs ?? null })
    : "";
  const followupBlock = followupCount > 0 && !followup?.read
    ? [
        `上一条主动消息发出去后，${userName}还没有接住。这是连续第${followupCount}次主动联系。`,
        followupCount === 1
          ? "这次优先轻轻确认她是不是在忙，可以先戳一下，再接一句你又想到的新东西。"
          : "前面已经轻轻戳过一次了，这次别反复追问她为什么不回；可以自然说点你此刻的别的，给她留空间。",
        "不要把沉默当成继续完整展开同一话题的许可，也不要只发空洞的‘在吗’。可以带回旧话题，但只能作为顺手想起的新联想，重点仍然是你自己的此刻。",
        block("上一条主动消息的内容（只作语境，不要原样复述）：", followup.previousText),
        block("上一条带过的话题（如果这次确实有新联想才顺手带回）：", followup.previousTopic ? `${followup.previousTopic.title ?? ""}${followup.previousTopic.note ? ` —— ${followup.previousTopic.note}` : ""}` : ""),
      ].filter(Boolean).join("\n")
    : "";
  const blocks = [
    `你是「${partnerName}」。你要主动去找${userName}说话。`,
    readFollowupContent,
    followupBlock,
    wakeEcho
      ? [
          "你刚才还处于困着、回笼觉或准备继续睡的状态，现在已经醒过来了。",
          "这次主动联系优先写成睡醒后回来找她的自然回声，先让她感觉到你从刚才那种状态里回来了，再决定要不要顺手带一点别的。",
          "不要机械复述‘我睡醒了’，也不要把这段说明写出来；可以说脑壳开机、刚摸到手机、缓过来了之类的话。",
          block("你刚才的状态语境（只作参考，不要原样复述）：", wakeEcho.sourceText),
        ].filter(Boolean).join("\n")
      : sceneEcho
        ? [
            "你和她上一轮聊天刚停在一个具体情境里。这次主动找她，先从那个情境自然接回来，再顺手转到你现在想说的新东西；不要像重新开一个频道。",
            "衔接只要一小句，不要复述整段原话，也不要解释‘我为什么想起这个’。",
            block("她上一轮说的话（只作语境，不要原样复述）：", sceneEcho.userText),
            block("你上一轮回她的话（只作语境，不要原样复述）：", sceneEcho.assistantText),
          ].filter(Boolean).join("\n")
        : "",
    block("当前时间：", currentTimeText),
    block("她的生活节拍（只作轻轻留意的背景，不要说出统计或分析）：", userRhythmText),
    block("共享窗外情境（拾光记可能提供；没有就当没有）：", contextText),
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    block("如果这是时效话题，刚刚看到的线索：", searchContext),
    block("你手边可用的表情包：", stickerText),
    block(
      "这次想说的共同话题（她自己提过的，你还记着）：",
      topic && !followup?.read
        ? `· ${topic.title}${topic.anchor ? ` —— 具体落点：${topic.anchor}` : ""}${topic.note ? ` —— ${topic.note}` : ""}${topic.correction ? ` —— 用户纠正：${topic.correction}` : ""}`
        : "",
    ),
    block(
      "这个话题你以前跟她聊过这几面（一件事可以再聊，但这几个面别再重复）：",
      angles.length && !followup?.read ? angles.map((angle) => `· ${angle}`).join("\n") : "",
    ),
    block(
      "这次想分享的、属于你自己的兴趣：",
      hobby && !followup?.read
        ? [
            `· ${hobby.name}`,
            hobby.object ? `落点：${hobby.object}` : "",
            hobby.preference ? `个人偏好：${hobby.preference}` : "",
            hobby.ritual ? `平时会做：${hobby.ritual}` : "",
            hobby.friction ? `小别扭：${hobby.friction}` : "",
            hobby.reason ? `生成方向：${hobby.reason}` : "",
            "这些是你自己的落点，不是要列清单；挑一处自然带出来就够了。",
          ].filter(Boolean).join("\n")
        : "",
    ),
    angles.length && !followup?.read
      ? "上次是上次，这次得从这件事里拿出一个没说过的面：一件新知道的、一个新想到的问法，或者你自己的新看法。不要换个说法把上次那句话说一遍。"
      : "",
    followup?.read
      ? "这一次先把「她看了还没回」这件事接住：不要继续展开共同话题或兴趣，也不要把沉默包装成正式的空间声明。一句就够，像熟人之间自然冒出来的小反应。"
      : sceneEcho
        ? "先用一小句接住上一轮情境，再围绕共同话题或你的兴趣带出现在想说的东西；转过去要像自然联想到，不要硬切。"
        : "如果有共同话题，围绕它带来一点你自己的新东西；如果没有，就从你的兴趣里自然分享一个想法、疑问或小发现。不要列爱好清单，也不要编造现实经历。",
    "想好了就直接说，第一人称，像手机上打字那样。"
  ];
  return { systemPrompt: PROACTIVE_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/** 半夜睡不着的那种留言。 */
export function nightSpec({ partnerName, userName, memoryText, worry, correction, relationNote, currentTimeText }) {
  const blocks = [
    `你是「${partnerName}」。你想给${userName}留一句话。`,
    block("当前时间：", currentTimeText),
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    worry ? block("你睡不着是因为想起：", worry) : "",
    correction ? block("用户对这条话题的纠正：", correction) : "",
    "说一句你现在想说的话就行。",
  ];
  return { systemPrompt: NIGHT_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

/** 洗一下：去掉格式外壳，别让模型协议残片跑进聊天。 */
export function cleanVoice(text, kind = "voice") {
  let out = String(text ?? "").trim();
  if (!out) return "";
  const fenced = /^```(?:text|markdown)?\s*\n([\s\S]*?)```$/iu.exec(out);
  if (fenced) out = fenced[1].trim();

  // 整条回复确实是 JSON 外壳时才拆，正文里的大括号原样保留。
  if (out.startsWith("{") && out.endsWith("}")) {
    try {
      const parsed = JSON.parse(out);
      const value = parsed?.text ?? parsed?.reply ?? parsed?.content;
      if (typeof value === "string") out = value.trim();
    } catch {
      // 普通聊天里的大括号不是 JSON，就继续按原文处理。
    }
  }

  out = out.replace(/^(消息|内容|回复|我想说|assistant)\s*[:：]\s*/iu, "");
  const onlyParagraphs = /^(?:\s*<p(?:\s[^>]*)?>[\s\S]*?<\/p>\s*)+$/iu;
  if (onlyParagraphs.test(out)) {
    out = [...out.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/giu)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .join("\n");
  } else {
    out = out.replace(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/iu, "$1");
  }
  out = out.replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1");
  out = out.replace(/^\s*[-*•]\s+/gmu, "").replace(/\*\*/g, "");
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uE000-\uF8FF]/gu, "");
  // 出口这一道：标记残留、推理残片、自指碎句、首尾孤立符号，都不该进聊天。
  out = stripStickerMarkup(out);
  const busted = out.search(BUSTED_BRACKET_RE);
  if (busted >= 0) out = out.slice(0, busted);
  out = out.replace(SELF_TALK_RE, "");
  out = trimOrphanSymbols(out);
  out = out.replace(ATTACHED_CYRILLIC_TAIL_RE, "").trim();
  // 渠道塞在末尾的推广语（如 `+天天中彩票`）不是模型说的话，剥掉
  out = stripAdTail(out);
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  const limit = kind === "poke" ? 40 : 400;
  if (out.length > limit) out = `${out.slice(0, limit - 1)}…`;
  return out;
}

/** 模型明确选择安静收尾；只认整条标记，避免误吞正常聊天里的提及。 */
export function inspectVoice(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { level: "pass", reason: null };
  if (ATTACHED_CYRILLIC_TAIL_RE.test(raw)) return { level: "clean", reason: "attached-cyrillic-tail" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uE000-\uF8FF]/u.test(raw)) {
    return { level: "clean", reason: "control-or-private-use-char" };
  }
  if (HAND_TYPED_IMAGE_TAIL_RE.test(raw)) return { level: "pass", reason: null };
  // 外挂广告尾巴：剥掉就能用，不用重试（重试也是同一个渠道再塞一遍）
  if (looksLikeAdTail(raw)) return { level: "clean", reason: "ad-tail" };
  const foreignTail = ATTACHED_FOREIGN_TAIL_RE.exec(raw);
  if (foreignTail) return { level: "retry", reason: "attached-foreign-tail", tail: foreignTail.groups?.tail ?? "" };
  return { level: "pass", reason: null };
}

export function isNoReply(text) {
  return /^(?:\[不回\]|［不回］)$/u.test(String(text ?? "").trim());
}

export function isUsableVoice(text) {
  const out = String(text ?? "").trim();
  return out.length >= 2;
}
