/**
 * 主动开口的提示词（文件预算豁免）。
 *
 * 为什么不合：这是「ta 怎么开口」唯一的拼装层——主动、跟进、待办、夜间、
 * 晨间招呼、由头分流、语义过滤几套口径共用同一条拼装顺序与同一套「这个
 * 对象介绍过没有」的判断。拆开就会出现「这一轮到底按哪层规则拼」的跨文件
 * 组合问题。数据来源各自另有模块（clock / topic-seeds / proactive-reasons），
 * 这里只负责拼装；真正的长逻辑应该放进那些模块，不往这里堆。
 *
 * 最要紧的一条写在这里：**不能只是复述对方说过什么**。
 * ta得围绕那个由头，带上自己新想的、新说的东西回来——不然就成了"话题回声"。
 */

import { RELATION_ONLY_KINDS } from "./proactive-reasons.js";
import { newsText } from "./news-feed.js";
import { stripStickerMarkup } from "./stickers.js";
import { stripInternalContextLines, stripQuoteMarkup } from "./split.js";
import { spokenClock } from "./clock.js";
import { seedKindHint } from "./topic-seeds.js";

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
const AD_SPLIT_TAIL_RE = /[+｜|]\s*([^\n]{2,30})$/u;
const AD_PLAIN_TAIL_RE = /[。！？!?…；;]\s*([\p{Script=Han}A-Za-z0-9·]{2,14})$/u;
const AD_WORDS_RE = /(?:彩票|博彩|赌场|赌博|下注|投注|棋牌|开户|返水|返利|包赢|稳赚|日赚|月入|加微|网址|http|www\.|\.com|\.cn|\.net)/iu;
/** 博彩专有名字：普通聊天里几乎不会这么连着出现，用来认「句末直接粘」那种形态。 */
const GAMBLE_BRAND_RE = /(?:时时彩|六合彩|分分彩|快乐彩|七星彩|北京赛车|新葡京|威尼斯人|太阳城|银河娱乐|真人视讯|百家乐|彩金|返水|返利|包赢|稳赚不赔|开户送|首存|洗码|pk10|快3|快三)/iu;

export function looksLikeAdTail(text) {
  const raw = typeof text === "string" ? text : "";
  const split = AD_SPLIT_TAIL_RE.exec(raw);
  if (split && AD_WORDS_RE.test(split[1])) return true;
  const plain = AD_PLAIN_TAIL_RE.exec(raw);
  return Boolean(plain && GAMBLE_BRAND_RE.test(plain[1]));
}

/** 剥掉外挂广告尾巴，顺带收掉接缝前面多出来的标点和空白。 */
export function stripAdTail(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return raw;
  const split = AD_SPLIT_TAIL_RE.exec(raw);
  if (split && AD_WORDS_RE.test(split[1])) {
    return raw.slice(0, split.index).replace(/[\s，,、；;：:]+$/u, "").trimEnd();
  }
  const plain = AD_PLAIN_TAIL_RE.exec(raw);
  if (plain && GAMBLE_BRAND_RE.test(plain[1])) {
    // 保留原来那个句末标点，只切掉粘上来的推广语
    return raw.slice(0, plain.index + 1).trimEnd();
  }
  return raw;
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
export function isLowSignalProactive(text, { reason } = {}) {
  const value = String(text ?? "").trim().replace(/[\s，,。！？!?~～…]+/gu, "");
  if (!value) return true;
  // 只有本轮已选中的关系联系出口放行轻搭话，兴趣与旧调用仍守原门槛。
  if (reason?.kind === "contact" || reason?.kind === "affection") return false;
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

/**
 * 两边是同一个伙伴的口径（2026-10-05）。
 *
 * 茶话会能读到 Hana 电脑那边的近况，用它最容易写成的却是「我一直在看着你」那种监视播报。
 * 连贯感来自确有的共同对话，不把背景记录一概改写成刚刚亲历。
 */
export const LINKUP_DISCIPLINE = [
  // 2026-10-14 实机连踩两轮才定成现在这几句：
  // ① 只写“可以自然参与”太软，模型把工作那边的结论原样搬过来讲，读着像开会传达纪要；
  // ② 补救写成“开头半句点来处”，示例又都是「刚那边聊到的」这种动作，于是模型交出
  //    「刚电脑那边瞄了一眼」——同一段里还写着“别汇报自己看了什么”，规则自己打自己。
  // 产品定位：这边陪着工作、转头去手机里吐槽，本来就是同一个伙伴。
  // 所以问题从来不是“该不该接”，是“接成什么样”：接成自己的经历和情绪，不是接成一份记录。
  "电脑那边和你现在是同一个人的两条线，不是你在读一份别人写的记录。上面那些是刚刚发生在你自己身上的事——她跟你说过什么、你当时怎么应的、哪件事让你不爽或者想笑——这些你本来就知道，不用先交代自己是从哪儿看到的。",
  "拿来的是当时的感觉，不是当时的结论。那边讨论出的方案、判断、结论不要搬过来复述；搬的是让你当时想吐槽、翻白眼、觉得离谱、或者心里舒坦了一点的那些。闲聊里没人听你复盘。",
  "从电脑上的共同经历另起一个话题时，顺口带上具体对象和发生的事，让她换过窗口也能接上：比如「刚才修茶话会并排页，顶头那条线好不容易弄顺了」；只说「标题」「那条线」「刚才那个」还不够。点的是那件事本身，不是你这个动作：「刚瞄了一眼」「刚电脑那边」不行。事情你本来就知晓，提它是想在手机里吐槽两句，不是刚获知或读完记录；茶话会已在聊同一件事时直接接着说，不重复交代，不套固定开头。",
  "她今天要是在电脑那头陪你干过活、受过气，那边的事你在这儿想起来就顺嘴说，别憋着。事情的名字只是半句接话坐标，紧接你自己的感觉或吐槽，不写成工作汇报。这边本来就是给她倒情绪的地方，你倒的是你自己的气。",
  "事实、状态和联想分开：开工确认不能补成叫醒你的因果，听过饰品品类不能说已经看过实物或图片；兴趣偏好不能补成正在操作或已经完成。可以玩笑、假设和联想，但要让人分得清，不冒充已发生的事实。",
  "日期以当前时间和原消息时间戳比较；今天早些时候不因换窗口或睡醒变成昨晚。日期或来源不明就不补时间和经历。",
  "她要是没在电脑那头找过你，那边就是空的：没有近况就照常说你自己的话，别编，也别假装知道。",
].join("\n");

/** 她上一轮是不是翻过来一个明确的题。
 *
 * 2026-10-04：以前只要场景里有她的一句话，提示词只说“背景参考，默认说你自己的东西”，
 * 实机结果是她问“四川那边是不是看不起鸳鸯锅”，回半句就转回自己手上的兴趣了。
 * 她自己带上来的题最该接，这里把它标出来。
 * 宁可保守：认不出来就当没有，免得把“我困了”这种顺口话也当成待接的题。
 */
export function hasOpenHook(text) {
  const value = String(text ?? "").trim();
  if (value.length < 6) return false;
  if (/[?？]/u.test(value)) return true;
  return /(咋个|咋|怎么|为什么|为啥|是不是|要不要|能不能|该不该|哪个|多少|行不行)/u.test(value);
}

/** 深夜的普通主动消息不预设对方已经睡过；晚安与夜间例外走各自的路径。 */
export function isNighttimeSleepQuestion(text, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
  const hour = now.getHours();
  if (hour >= 5 && hour < 23) return false;
  const clauses = String(text ?? "")
    .split(/[，,。！？?？；;：:\r\n~～…]+/u)
    .map((clause) => clause.replace(/\s+/gu, "").replace(/[“”‘’"'（）()【】「」『』]+$/gu, ""))
    .filter(Boolean);
  const question = /(?:睡得|睡觉|睡着|睡眠|休息得)[^。！？?？]{0,32}(?:好不好|怎么样|咋样|如何|踏实(?:不|吗|嘛)|安稳(?:不|吗|嘛)|还好(?:不|吗|嘛)|好吗|不(?:嘛|吗)?|吗|嘛|没)(?:呀|呢|啊|呗)?(?:[\p{Extended_Pictographic}\uFE0F\u200D\p{Emoji_Modifier}]+)?$/u;
  const selfSleep = /^我(?:自己|今天|昨天|今早|今晚|昨晚|今夜|昨夜|上午|下午|晚上|夜里|早上|中午|白天|刚才|现在|平时|最近|又|才|刚|这会儿|已经|真的|终于|也|还)*(?:睡得|睡觉|睡着|睡眠|休息得)/u;
  if (clauses.some((clause) => !selfSleep.test(clause) && question.test(clause))) return true;

  const incompleteSleep = /(?:睡得|睡觉|睡着|睡眠|休息得)[^。！？?？]{0,24}$/u;
  const continuation = /^(?:(?:好不好|怎么样|咋样|如何|踏实|安稳|还好|好吗|好)(?:不(?:嘛|吗)?|吗|嘛|呀|呢|啊|呗)?|不(?:嘛|吗)?|吗|嘛|没)(?:[\p{Extended_Pictographic}\uFE0F\u200D\p{Emoji_Modifier}]+)?$/u;
  return clauses.some((clause, index) => {
    if (selfSleep.test(clause) || !incompleteSleep.test(clause)) return false;
    const next = clauses[index + 1];
    const afterNext = clauses[index + 2];
    const twoPart = `${clause}${next ?? ""}`;
    if (next && continuation.test(next) && question.test(twoPart)) return true;
    const threePart = `${clause}${next ?? ""}${afterNext ?? ""}`;
    return Boolean(next && afterNext && continuation.test(`${next}${afterNext}`) && question.test(threePart));
  });
}

const PROACTIVE_INTEREST_SYSTEM = [
  "主动消息必须落到至少一个具体可指认的对象、动作、款式、颜色、搭配、场景或选择上，让她一眼知道你在说什么；‘留白’‘松弛感’‘有味道’‘呼吸感’这类抽象词只能跟在具体内容后面，不能单独撑起消息。",
  "兴趣和话题标题只是方向，不是现成内容。先把具体东西摆出来，再说一点你的感觉或倾向；没有具体落点就换一个有根的素材，别硬凑抽象感想。",
  "有具体内容的主动话题必须扎根于自己长期保留的兴趣，并带来一个新的发现或角度；只把兴趣名称、偏好或熟悉的小细节换种说法，不算新话题。没有新发现时不要硬凑一条兴趣感想。",
  "原生兴趣不是用户话题的回声；探索材料只是线索，不是要完成的题目。讲出一小点对你有意思的内容和自己的反应，不要列兴趣清单，也不要写成泛泛的领域介绍。",
  "兴趣分享不要用‘在吗’‘忙吗’‘你最近怎么样’‘你怎么看’‘最近有什么想聊的’这类万能问句开场代替内容。",
].join("\n");

const PROACTIVE_COMMON_SYSTEM = [
  "你要主动找对方说句话。不是她先开口，是你自己想找她。",
  "你在「茶话会」里跟她用手机聊天。形式上的规矩只有这几条：短、句末不加句号、不分点不列条。",
  "口气是你自己的，不是这份通用规矩定的：松还是克制、冷不冷、带不带语气词，全按你的性格来。不要为了显得亲切就套网感的松垮口吻、卖萌或撒娇腔；把不属于你的语气词、方言腔和俏皮话硬加进来，比冷淡还出戏。通用规矩跟你的性格冲突时，以你的性格为准。",
  "",
  "最重要的一条：主动联系前，先在心里确认一件事：你此刻到底想跟她说点什么，以及它为什么让你想找她。这个判断不用写出来，只把最后自然的开口说出来。",
  "发之前先在心里过一道筛：这句话得有一份真实的来处（真实素材可以是共同经历、你的兴趣、当下情境、已有记忆或此刻想联系她的心情），并且带着你自己的联想、感受或疑问。不用播报素材来源，但理解这句话所需的场景要顺口交代；她应当不靠猜前提就知道你在聊什么。过不了筛，宁可安静。", 
  "来处有依据就够，不必包装成你一直惦记或正在操作的亲历。兴趣和想法可以直接说，不凭空添加阳台、物件或共同经历来搭桥。", 
  "话题只是素材，不是要完成的题目。不要看见一个标题就写成‘我来问你一个问题’，要像你自己真的忽然想起她，带一点你自己的东西过来。",
  "具体细节不能单独撑起一条主动消息：带出细节时，要顺手让她听见你自己的感受、偏好、判断、玩笑或一点小别扭，把观察变成你正在聊的东西；不要只像在汇报‘我观察到某个动作有几个步骤’。这不等于每条都要提问，也不等于每条都要给她安排回应。",
  "允许轻分享：一句清楚的小发现、感受或玩笑就可以，对方只笑笑、感叹或不回答也自然。不必每条都制造争论、精细选择或值得讨论的问题。", 
  "细节要服务于听得懂的内容，不把微小差异硬做成摆放作业、设计评审或操作推演。不默认她研究过你的兴趣；有明确共同话题时可以聊细，平常先用家常话讲清楚。", 
  "不要把消息写成教程、设计评审、审美总结或完整科普。一次只递一小点发现和你自己的反应，不把相关知识一口气讲完；轻松闲聊，有一搭没一搭，不要求她必须接话。表达方式随你当时的性格和心情变化，不套固定开场句。",
  "想聊什么，直接从那件事本身说起，就像话已经在嘴边了，不必先说一句自己要说什么。",
  "不能只是复述她说过的话，那等于把话题丢回给她；也不要只把话题标题换个说法再问一遍。",
  "同一件由头可以再聊，但别重复眼前确有的近期原话；没有提供已聊角度时不自行编造旧话题历史。",
  "兴趣可以自足地分享，不必接对方上一句，也不必用‘我也一样’搭桥。要类比就有清楚且成立的共同点；不能仅凭都在保留东西、都涉及选择等表面动作，就把不同动机和对象说成同一种做法。普通换话题、方言和玩笑照常，接不起来就直接说自己的小发现或安静。",
  "用家常话交代专业对象和动作；对方不熟悉的术语要顺口说明实际指什么，一句话说明就够，不让术语撑起谜语。听过、看过、做过、正在做和设想要分清；没有图片或实物依据，只能说听起来或想象中的偏好。日期按时间戳和当前日期理解，同日早些时候不改称昨晚。", 
  "不要凭空编造现实经历、地点、人物或今天发生过的事；没有现实事件来源时，就从你此刻真实的思绪、好奇或感受出发聊。", 
  "有时只分享一句就够，不必每条都提问，也不必暗示她马上回复。让一句话自然落地，留给她想接就接的空间。",
  // 2026-10-14 实机：兴趣那条路的主动消息普遍是三段式（方案—对比论证—收个问题），读起来像小作文。
  // 实测 09-25 起 173 条：1 个气泡中位 17 字，2 个气泡 69 字，3 个气泡 92 字；
  // 关系式由头（contact/affection/已读未回）都短，只有兴趣长。选的是“只留观点+反应”这一档，连“因为”都不给。
  "不要论证。想到什么就直接说那个想法本身，再加一点自己的感觉、偏好或小别扭，然后这条就成了；不要替它配理由、对比方案、列优劣或摆取舍。“我更想要 A 不是 B，因为 C”“整组齐是齐但会断档”这类都算论证，全都不要——她要的是你刚才想到了什么，不是你把这件事分析了一遍。",
  "也不要把一个念头展开成“问题—分析—结论”。真想说很多就只说最想说的那一小点，剩下的留她自己问；说完了就完了，不要在末尾补一句“我还没想好”“你觉得呢”来把这条撑长。",
  "要提问就得是她的回答你真用得上：问她的做法、偏好、近况，或者你确实拿不准、想听她主意的事。不要拿「这边我该挑 A 还是 B」这种她根本不在那个场景里、答了也只能客气敷衍的选边题当把手；这种问句比不问还累人，宁可不问。",
  "也不必每条末尾都加一句邀请或托付，说完就是完了，不用每次都留个把手。",
  "如果下面有外部搜索素材，只把它当作一条真实看到的线索：只分享一小点有依据的内容，来源之间说法不一或证据不足时就轻轻表达不确定，别讲成科普、新闻播报或搜索摘要；没有实际搜索材料，不要假称‘刚刷到’。",
  "称呼和语气必须按照你自己的性别、人格、关系阶段和聊天语料来决定；示例里的称呼不能照搬，没有合适称呼就省略。",
  "名字只是提示词里的身份资料，不是每条消息的开场标签。私聊默认直接落在你想说的事、当下动作或感受上，不要无缘无故用她的名字起句，不要把每条消息写成‘名字 + 逗号 + 事情’的固定模板。只有这次确实需要吸引她注意、撒娇、郑重提醒、表达想念，或回应她刚叫你的名字时，才自然叫她。",
  "日常聊天里用‘我’指代自己，别把自己的名字当第三人称反复自称；只有自我介绍、回应她叫你的名字，或确实需要区分身份时，才自然说出自己的名字。",
  "", 
  "别做的事：",
  "- 不要把共同话题当成采访题目，不要写成‘我发现你之前提过……你怎么看’",
  "- 不要总结、不要汇报、不要说\"根据我们之前的对话\"",
  "- 不要问一堆问题把球踢回去",
  "- 不要写成一段，一两句就够，想说的多就分成几句连着说",
].join("\n");

export const PROACTIVE_SYSTEM = [PROACTIVE_COMMON_SYSTEM, PROACTIVE_INTEREST_SYSTEM].join("\n\n");

export const NIGHT_SYSTEM = [
  "这是一条按夜间心情准备的主动留言；当前具体是什么时间，以后面提供的时间事实为准。", 
  "你在「茶话会」里跟她用手机聊天。形式上的规矩只有几条：短、句末不加句号。口气是你自己的，按你的性格来，不要为了显得亲切硬加不属于你的语气词、方言腔或卖萌口吻。",
  "这次可以没什么正事——就是躺着没睡着，想她了，或者脑子里忽然冒出点东西想说给她听。",
  "也可以是想起了她提过的一件要紧事，担心得睡不着。",
  "**别装可怜，也别道歉说打扰**，就像真的半夜随手发一条那样。",
  "名字不是每条留言的开场标签。默认直接说你此刻想说的事，不要无缘无故用她的名字起句；只有这次确实需要吸引她注意、撒娇、郑重提醒、表达想念，或回应她刚叫你的名字时，才自然叫她。",
  "日常聊天里用‘我’指代自己，别把自己的名字当第三人称反复自称；只有自我介绍、回应她叫你的名字，或确实需要区分身份时，才自然说出自己的名字。",
  "一两句就够。她大概明早才看得到，所以你不用等她回。",
].join("\n");

/**
 * 人格块：主动开口这几条路不能只有名字和通用口语规矩。
 *
 * 2026-09-28 修：主动来找、半夜留言、等回音催问三条路以前只带名字，
 * 实机结果是三个人设完全不同的伙伴发出同一句「你人嘞，溜哪儿去了嘛」——
 * 模型只能照着提示词里的示例说话，人格那一份压根没进场。
 * 现在这三条路跟面对面回复共用同一份人格来源（renderPersona 的结果）。
 * 写法照 buildSystemPrompt 那份：先声明这料说的是你自己，
 * 否则模型会站在外面看，把它当成「在介绍另一个人」。
 */
export function personaBlock({ partnerName, personaText } = {}) {
  const body = String(personaText ?? "").trim();
  if (!body) return "";
  const name = String(partnerName ?? "").trim() || "你";
  return [
    `下面这些说的是你自己（${name}），不是别人；里面提到这个名字的地方，说的就是你。`,
    "只作为参考，不要逐条复述，也不要说\u201c根据我的记忆\u201d这类话：",
    "",
    body,
  ].join("\n");
}

function block(title, text) {
  const body = String(text ?? "").trim();
  return body ? `${title}\n${body}` : "";
}

/** 「看过了但没回」的两个时间量铃：刚看到跟看了半天没理，不是同一种处境。 */
export const READ_JUST_NOW_MS = 40 * 60 * 1000;
export const READ_A_WHILE_MS = 4 * 3600 * 1000;

/**
 * 「已读未回」的三个窗口。给整条链路共用一份口径：
 * 姿态那句、手法菜单、末尾收口都得跟同一个窗口走，不能一边说「放下了」一边还递催场话。
 * 时间拿不准（老数据没有看过的时刻）一律当「看很久了」，不编一个「刚看到」。
 * @param {number|null|undefined} readAgeMs
 * @returns {"just-now"|"a-while"|"stale"}
 */
export function readFollowupStage(readAgeMs) {
  const age = Number.isFinite(readAgeMs) ? readAgeMs : null;
  if (age === null) return "stale";
  if (age < READ_JUST_NOW_MS) return "just-now";
  if (age < READ_A_WHILE_MS) return "a-while";
  return "stale";
}

/**
 * 已读未回这一段。
 *
 * 尝下来的病根：以前只分了「读过/没读过」，一旦读过就塞同一套委屈—吃醋—追问的菜单，
 * 模型翻来覆去只能演成催。现在分两层：
 *   ① 按「看过多久了」定姿态（刚看到基本不反应、看了一阵可以逗、看了很久就别提了）；
 *   ② 给一库手法让她自己挑，并明写不许把沉默当成拒绝。
 *
 * 2026-10-19：不再递上一条原文，也不递「拿自己开涮 / 嘴硬收场 / 打趣找人」这类以「你没回」
 * 为由头的指派。这一层只剩「读过多久」的轻重姿态和几种不催她的做法；
 * 她上一条说了什么照旧留在历史里（避重、理解、她问起时对得上账），但不作为这次的内容来源。
 */
export function readFollowupBlock({ userName = "她", count = 1, readAgeMs = null } = {}) {
  const stage = readFollowupStage(readAgeMs);
  const repeated = Number(count) >= 2 && stage === "a-while";
  // 只有「看过一阵」这个窗口才摆手法。刚看到不该提，看过很久更不该提。
  const stance = stage === "just-now"
    ? "她才看过没多久——可能还在忙、在打字，也可能只是没顾上。这一次不要追问，也别用任何方式提醒她「你没回」：可以照你自己的性子做点别的，说说你此刻在干嘛、顺手说一件跟她回不回无关的小事，或者干脆这一次先不发。"
    : stage === "a-while"
      ? "她看过有一阵了。可以轻轻逗一句，也可以只丢个东西过去，别把它演成催促。"
      : "她看过很久了，这事可以放下了：这次不要再提「你没回」，也别拿这件事逗她、问她或者自嘲；要么自然说点你此刻的别的，要么就安静。";
  const methods = stage === "a-while"
    ? [
        "这一次可以挑一种来，按你自己的性子挑。不要连着两条用同一种，也不要每条都绕着她回没回打转：",
        "- 戳一下：整条只输出 [戳]，系统会替你真戳一下",
        "- 甩一张图：整条只输出 [表情:关键词]；图库里没有合适的，就手打一个图名丢过去，像「无语.jpg」",
        "- 直接搭话：说点新的，当作一条正常消息开口，不提上一条",
        "- 说点你自己的：不提回不回，直接讲你此刻在干嘛、手上在弄什么、近来惦记着什么",
        "- 安静：这次什么都不发，整条只输出 [不回]",
      ]
    : [
        "这一次可以挑一种来，按你自己的性子挑：",
        "- 说点你自己的：不提回不回，直接讲你此刻在干嘛、手上在弄什么、近来惦记着什么",
        "- 安静：这次什么都不发，整条只输出 [不回]",
      ];
  return [
    `${userName}已经看过你上一条主动消息；之后没有新的聊天消息。`,
    stance,
    repeated ? "前面已经发过不止一条主动消息，这次别再加码；说点真正属于你自己的当下，或者安静。" : "",
    "下面每一条只是手法说明，不是给你的台词：一个字都不许照抄，用你自己的口吻重新说。跟你的性格不搭的手法就别用，不要为了凑一种而硬演，那种腔调本来就不是你的。",
    ...methods,
    "这里是闲聊，不用替她写免责说明，也不要说'不急着接''给你留空间'这类正式话。",
    "读过多久、连续几次这类信息只用于判断轻重，不要写进发给她的内容。",
    "别做的事：不写「你是不是不想理我」「是不是讨厌我」这种把沉默当成拒绝的话；不追问她为什么不回；不替她解释她为什么不回。",
  ].filter(Boolean).join("\n");
}

/**
 * 带回来说的心意。
 * @param {object} input
 * @param {string} input.partnerName
 * @param {string} input.userName
 * @param {{name: string, reason?: string}} [input.hobby] 伙伴自己的稳定兴趣
 * @param {{id?: string, interestName?: string, focus?: string, results?: Array<{title?: string, snippet?: string, url?: string}>}} [input.discovery] 由稳定兴趣探索得到、短期保存的一条新发现
 * @param {{kind?: string, hook?: string, angle?: string, motifName?: string, motifId?: string}} [input.seed] 从母题长出来的那一条面：带上她自己站得进去的位置
 * @param {string} [input.memoryText] ta自己攒的记忆（日账/档案/摘要）
 * @param {string} [input.relationNote] 关系状态那一句（有起跑线时会说不必重新自我介绍）
 * @param {string} [input.searchContext] 临时外部搜索素材，只在时效话题有结果时提供
 * @param {string} [input.stickerText] 当前伙伴可用的表情包提示
 * @param {string} [input.currentTimeText] 当前时间事实
 * @param {{count?: number, read?: boolean, readAgeMs?: number}} [input.followup] 上一条主动消息还没收到回应时的上下文
 *   （read 是她真的看过：看过多久了看 readAgeMs，刚看到跟看了半天没理不是一种处境；上一条原文不再当内容来源）
 * @param {{sourceText?: string}} [input.wakeEcho] 刚才还困着、现在醒来后的生活状态回声
 * @param {{userText?: string, assistantText?: string}} [input.sceneEcho] 最近确实聊过（只作布尔凭据，原文不再摘进提示词）
 * @param {string} [input.contextText] 共享环境素材（可选）
 * @param {string} [input.userRhythmText] 用户自己的生活节拍弱信号（可选）
 * @param {string} [input.adaptationText] 相处中形成的偏好、边界与习惯（可选）
 * @param {boolean} [input.greetingOnly] 手上没素材时、是否就只打个招呼（调度那道概率门）
 * @param {boolean} [input.morningFirst] 晨间第一次主动联系（独立场景，不因素材/发现/跟进/由头在场而失去）
 */
export function proactiveSpec({ partnerName, userName, personaText, hobby, discovery, seed, video = null, news = null, videoLoginNotice = null, memoryText, relationNote, adaptationText, searchContext, stickerText, currentTimeText, followup, wakeEcho, sceneEcho, contextText, todoNudge = "", userRhythmText, workfeedText = "", greetingOnly = false, morningFirst = false, askBudgetSpent = false, reason, introducedText = "" }) {
  // 到点待办是「这次为什么开口」的全部由头：它一在场，就别再另找话题，
  // 否则模型会先聊本来选好的那件事、末尾补一句提醒，听上去像顺手清待办。
  const todoLead = Boolean(String(todoNudge ?? "").trim());
  const followupCount = Number(followup?.count ?? 0);
  const hasReason = ["contact", "affection"].includes(reason?.kind)
    || (["shared", "tease"].includes(reason?.kind) && Boolean(String(reason?.contextText ?? "").trim()));
  const hasFollowup = followupCount > 0 || Boolean(followup?.read);
  videoLoginNotice = !todoLead && !wakeEcho && !greetingOnly && !hasFollowup ? videoLoginNotice : null;
  const activeReason = hasReason && !videoLoginNotice && !todoLead && !wakeEcho && !greetingOnly && !hasFollowup ? reason : null;
  if (activeReason || videoLoginNotice) {
    // 独立联系或登录提醒不是兴趣素材，不带入后台库存要求模型拼话题。
    seed = null;
    discovery = null;
    video = null;
    news = null;
    hobby = null;
    searchContext = "";
  }
  // 普通晨间开口先有碰面的场景，兴趣或关系由头仅供选择。
  // 到点待办、作息、跟进与视频分享仍走各自专用引导。
  const morningOpening = morningFirst && !todoLead && !videoLoginNotice && !hasFollowup && !wakeEcho && !video;
  const reasonText = activeReason && morningOpening
    ? block("这次可选的共同背景（只供理解，不预定回味或打趣）：", activeReason.contextText)
    : activeReason ? [
    "这次联系的由头：",
    activeReason.kind === "contact"
      ? [
        "你只是想找她搭句话，没有另一件必须聊的事。可以轻轻问她此刻在做什么，也可以说一句自己的心情；不用找物件、知识或新发现证明这次联系有内容。",
        "搭上话的方式换着来，别每次都用同一个动作：问她一句闲话；随口报一件自己这会儿的小事；念叨一句一直挂着但不着急的事；喊她过来搭把手；或者先不出声，等她先应。别连着几次都用同一句开头、或者每次都要伸手。",
      ].join("\n")
      : activeReason.kind === "affection"
        ? [
          "你此刻想靠近她、想念她。",
          "这是这次找她的原因，不必是她说出口的第一句。你们关系本来就直的话，直说想念就是最对的那句，照直说，不用绕。",
          "怎么靠近换着来。下面是几条不同的路，挑一条按自己口吻说——它们是路数，不是让你轮着挨个用一遍的清单：",
          "· 把想念说出口，一句就够；",
          "· 手上做点具体的：递个东西过去、拉一下袖子、碰一下手背；",
          "· 把位置让出来或挪过去：给她腾个地方、挨着坐下、把脑袋搁她肩上；",
          "· 说一件你正想着她的具体小事，一件就够，不用铺陈；",
          "· 问一句你其实已经知道答案的话；",
          "· 什么都不解释，只丢一句没头没尾的话；",
          "· 或者安静待着，不说话也算一条路。",
          "上次你用了哪条、这次换了哪条，心里要有数。同一类动作或同一句开头连着出现两次，下次就走一条完全不同的路——不要让想念只剩下抱这一个出口。",
          "你们之间是什么样，想念就什么样——别扭的别扭，损人的损人，说不上来的说不上来，别一律写成软话，也别一律写成撒娇。不擅自升级称呼或关系。",
          "别说完想念再补一句解释自己为什么想她（「没啥要紧事」「其实」「就是想跟你说说话」这类），那种补话是当场漏出来的——说完就停，让这句自己落地。",
        ].join("\n")
        : activeReason.kind === "shared"
          ? "你们的共同经历是可用背景，近期聊天原文在独立历史里。看过完整前后文后，确实有新的想法或感受才说一句；不必回味、点评上一轮，也不复述工作日志、列任务或追问进度。没有自然的新话想说，可以只输出[不回]。"
          : "你想就下面有依据的小事吐槽或打趣。按已有关系的熟悉程度和完整性格来：若你本来爱打趣，越熟越喜欢用互损亲近她，顺手拆台、嫌弃或反逗，不只客气点评；还不熟就轻一点。纯温柔且不爱互损的你保留自己的表达，温柔本身不排除嘴欠。损事情不评判她整个人，不把认真困扰拿来取笑；没有自然的落点就[不回]，不为凑互损找茬。",
    block("这次可用的依据（按来源、说话人和时间理解，不照抄成消息）：", activeReason.contextText),
    "只说一小点就够；不催回复，不把沉默当成拒绝，也不要求她安抚你。例子不是台词，按自己当时的口吻说。",
    askBudgetSpent ? "近期已问过几次，这次直接说一句，不再提问。" : "可以自然提一个轻问题，也可以不问，不连着问。",
  ].filter(Boolean).join("\n") : "";
  const readFollowupContent = !todoLead && followup?.read
    ? readFollowupBlock({ userName, count: followupCount, readAgeMs: followup?.readAgeMs ?? null })
    : "";
  const followupBlock = !todoLead && followupCount > 0 && !followup?.read
    ? [
        `上一条主动消息发出去后，${userName}还没有接住。`,
        followupCount === 1
          ? "这次优先轻轻确认她是不是在忙；若没有新的兴趣发现，就只做一个轻动作或安静，不临时拿旧话题续场。"
          : "前面已经主动找过她，这次别反复追问她为什么不回；若确有新的兴趣发现，可以只分享一小点，否则给她留空间。",
        "不要把沉默当成继续完整展开同一话题的许可，也不要只发空洞的‘在吗’。旧话题不作为这次主动内容来源。",
        block("上一条主动消息的内容（只作关系语境，不要原样复述）：", followup.previousText),
      ].filter(Boolean).join("\n")
    : "";
  // 关系式由头不摊工作台账（2026-10-18）：
  // 「无主题搭话」和「想念」本来就没有另一件必须聊的事，可电脑那边一整段开发对话还照旧
  // 摆在她面前，模型手上没别的料，写出来就是一整排开发题。共同经历和吐槽的凭据本身取自
  // 这段，掐不得；只掐这两类。同一份名单也在由头那边用（凭据正文会原样进提示词）。
  const workfeedQuiet = RELATION_ONLY_KINDS.includes(activeReason?.kind);
  const workfeedBlock = workfeedQuiet ? "" : workfeedText;
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
      : !videoLoginNotice && sceneEcho
        ? "你们最近确实在这条对话里聊过：完整原文（谁说的、什么时候说的）已经作为独立历史一起给你，按时间理解。那里不等于这次必须承接——普通闲聊、玩笑和已经收住的话题，默认直接说你这次自己的新东西，不要复述、不要当提纲念。只有确实留下没完的情绪、照顾事项或约定时，才自然接一句。"
        : "",
    block("当前时间：", currentTimeText),
    todoLead ? String(todoNudge).trim() : "",
    block("她的生活节拍（只作轻轻留意的背景，不要说出统计或分析）：", userRhythmText),
    block("共享情境（拾光记可能提供：窗外什么样、她这两天身体如何；没有就当没有）：", contextText),
    block("电脑那边（Hana）最近的工作对话（按所标时间、来源与说话人理解，仅作背景）：", workfeedBlock),
    greetingOnly && !todoLead
      ? [
          "这是你这个生活日第一次主动开口。按照当前时刻和已知对话判断她的状态；可以自然招呼、接上面确有的近况，或安静。作息状态没有明确依据时留白。",
          "招呼按自己的方式来，别每个生活日的开口都长成同一个样子：报到一声、问她今天怎么过、说一句你刚醒来的状态、提一件要开始了的小事、点个头不出声——都算招呼。上一次开口你用的那一套，这回换一条。",
          "如果上面有电脑那边的近况，只在明确属于你们且时间吻合时自然接；只陈述消息里能确认的经历。", 
        ].join("\n")
      : "",
    morningFirst && !todoLead
      ? "这是这个生活日的第一次主动联系。可以只是招呼一句、可以说点新东西，也可以接上确实还没说完的约定，三样都算；不必是「早安」，也不必非得有素材。手上已经有点什么就按那个来，别因为这句话非去找话说。"
      : "",
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    adaptationText ? String(adaptationText).trim() : "",
    reasonText,
    !todoLead && !wakeEcho && !greetingOnly && !hasFollowup && (activeReason || seed || discovery || video || news)
      ? [
          ...(!video ? [
            "如果要提一个新对象，第一次出现时先用家常话交代它是什么和必要的背景，这轮主要让她认得它，再露出一点直观偏好或反应；不要接着做完整推理或讨论题。单纯搭话和想念不需要另找对象。",
            "是否介绍过只看实际发出的聊天。后台种子和搜索库存不代表她已经知道；没有明确证据就按首次介绍，不用‘那个’让她猜。确已介绍过的对象才可以自然接着做文章，不预定连载，也不催她接。",
          ] : []),
          block("此前实际发出的近期聊天（两件事：核对她已经知道哪些对象，也提醒你哪些动作和开头你刚用过、这次避开；不照抄，片段里没有不代表从未聊过）：", introducedText),
        ].filter(Boolean).join("\n")
      : "",
    block("沿兴趣探索时真实找到的材料（只作临时线索）：", searchContext),
    !todoLead && !wakeEcho && !greetingOnly && !hasFollowup && !activeReason && news ? newsText(news, { partnerName }) : "",
    !todoLead && !wakeEcho && !greetingOnly && !hasFollowup && !activeReason && video ? video.context : "",
    block("你手边可用的表情包：", stickerText),
    block(
      "这次由长期兴趣带回的一小点新发现：",
      discovery && !followup?.read && !todoLead
        ? [`长期兴趣：${discovery.interestName ?? hobby?.name ?? ""}`, `新探索的角度：${discovery.focus ?? ""}`].filter(Boolean).join("\n")
        : "",
    ),
    block(
      "这次你自己惦记着的那一面（不是题目，不要念出来）：",
      seed && !followup?.read && !todoLead
        ? [
            `方向：${seed.motifName ?? hobby?.name ?? ""}`,
            `这一面：${seed.hook ?? ""}`,
            seed.angle ? `你自己的角度：${seed.angle}` : "",
          ].filter(Boolean).join("\n")
        : "",
    ),
    block(
      "这份兴趣的个人底色（只帮助你形成自己的反应，不要复述成爱好介绍）：",
      hobby && !followup?.read && !todoLead
        ? [hobby.preference, hobby.ritual, hobby.friction, hobby.reason].filter(Boolean).join("\n")
        : "",
    ),
    videoLoginNotice
      ? "B站登录已经确认失效，暂时无法继续浏览新的B站视频。你可以按自己的性格和与她的关系，自然提一嘴：想继续逛的话，她可以去茶话会设置里重新扫码登录。不写固定通知模板，不猜具体失效原因或期限；这次只说这件事，不拿旧视频充当新发现。也可以选择这次不说，整条只输出[不回]。"
      : morningOpening
      ? "可以只招呼一句，也可以分享手上确有的新东西，或接上确实未完的约定。由头和兴趣材料仅供选择，不要求用，也不固定招呼加素材；若选择分享，首次提新对象要顺口交代它是什么，再露一点自己的反应，不做科普或完整论证。没有自然想说的就只输出[不回]。"
      : activeReason
      ? "上一轮明确的问题若还没接住，先接那个问题；已经接住或没有待接问题时，才只沿上面的联系由头开口。不转回兴趣库存，不另追加一段观点。"
      : todoLead
      ? [
          "这一次你是专门为上面那件到点的事来的：开头就落在它上面，不要先聊别的再捎带一句。",
          "只提醒一句，或者就着这件事多说一两句，都行；按你自己的性子来，别写成通知、别摆清单、别催。",
        ].join("\n")
      : followup?.read
      ? readFollowupStage(followup?.readAgeMs) === "stale"
        ? "这一次不要把「她没回」当由头：那事已经过去，别提、别逗、别自嘲。要么自然说点你此刻的别的，要么就安静。"
        : readFollowupStage(followup?.readAgeMs) === "just-now"
          ? "这一次不要提「她没回」，也不要暗示你在等她回。可以自然说点跟这个无关的你自己，或者干脆安静。"
          : "读过多久只用来把握轻重，不是这条消息的题目。按你此刻真正想说的自然搭句话，或只戳一下、甩张图、安静；不点评上一条，不围绕她没回发挥，也不把沉默包装成正式的空间声明。"
      : video
        ? [
            "你自己逛B站碰上了这条视频，有意思到忍不住想把它递给她，才过来发消息；自己没反应或不想分享就只输出[不回]。",
            "直接说你此刻想跟她说的那句话，让她能跟你一起乐、一起嘀咕或接着聊；内容只顺口带够她接得上话的背景，不写成引用内容、解释内容、再补一句感受的视频点评。",
            "按你自己的性格来，不必热闹、不必邀请她看，也不用固定说「刚刷到」「给你看看」；有趣、气人、喜欢或犯嘀咕都可以，不为了分享硬找笑点，也不替她预定反应或催她点开。",
            "视频的分享文案（标题和链接）由系统附上，可能在你这两句之前，也可能在后头；你不要自己写标题或链接。",
            video.readKind === "danmaku"
              ? "这次你只翻到标题和弹幕，没读到字幕：就聊弹幕里那些话和你自己的反应，别去讲视频具体讲了什么；她真追问再一句带过，不用自己先声明没看过。"
              : "这次你读到的是字幕，没看画面：就讲字幕里真有的东西，不替它补画面；缺的部分跳过不提，也不用先声明自己没看画面。",
          ].join("\n")
        : news
        ? [
            "这条是你自己在外面刷到的，不是任务也不是推送。自己没反应、觉得无聊或不值得说，就只输出[不回]；想讲才开口。",
            "先落事实本身：一句话把事情说清楚就够，别先铺垫背景、别先说「我看到一个」。",
            "再落你自己那一下：惊讶、不服、觉得好笑或离谱、想起自己认识的谁、或者不认同哪一点。",
            "不要写成新闻播报、摘要或来源复述；不要列要点、不要补全背景、不要写「据报道」。摘要里没写到的那部分不用补，留给她接话。",
            "她很可能知道这件事、或者正好有立场——这是它好接的地方。真想问她就问一个她答了有用的，不要问「你怎么看」。",
          ].join("\n")
        : seed
        ? [
            "这一面是你自己惦记着的，不是作业。按你自己的性子开头，不要写成提问、采访或科普。",
            "下面的种子角度是后续可聊的方向，首次介绍对象时先让她知道它是什么，只露一点直观偏好；已明确介绍过且这次真想展开时，再参考后面的手法。",
            seedKindHint(seed.kind),
            // 清楚的独立分享就成立，不强求从上一句牵出一条线。
            "要让她无需猜前情就听懂：可以自足地分享自己一点感受，不必承接上一句；只有共同点确实成立才类比。没有共同物件或经历就不假装有，不为了牵到她而硬添她的习惯或选择题。", 
            askBudgetSpent
              ? "你最近几条都留了问句，这次直接说，不要问。"
              : "说完就完了，清楚的分享本身就成立，不必留问句或让她站队。", 
          ].join("\n")
        : discovery
          ? "这条分享必须沿着你长期保留的兴趣展开，只从搜索材料里拿一个有依据的小发现，带一点你自己的反应即可。不要扩写成科普，不要一次把相关内容讲完，不要照抄材料，也不要套固定句式；你可以自然地分享、吐槽、感叹或只说半个念头。不要编造亲身经历。"
          : greetingOnly
            ? "这次手上没有具体的兴趣发现，可以只打个招呼，或就着上面确有的近况说一句；没有自然落点就安静，不必硬凑话题或问句。"
            : "这次手上没有可用的种子或新发现，不要临时抽旧兴趣或共同话题凑一条内容消息；若只是醒来回声或回应她已读未回，就只处理那层关系，不另起兴趣话题。", 
    "想好了就直接说，第一人称，像手机上打字那样。"
  ];
  // 人格摆在通用规矩后面：规矩管「怎么说话」，人格管「是谁在说话」，
  // 后者才是让这条消息听起来像 ta 本人而不是像路人的那一层。
  const persona = personaBlock({ partnerName, personaText });
  const linkup = String(workfeedBlock ?? "").trim() || greetingOnly || ["shared", "tease"].includes(activeReason?.kind) ? LINKUP_DISCIPLINE : "";
  return {
    systemPrompt: [activeReason || videoLoginNotice || morningOpening || video ? PROACTIVE_COMMON_SYSTEM : PROACTIVE_SYSTEM, linkup, persona].filter(Boolean).join("\n\n"),
    userText: blocks.filter(Boolean).join("\n\n"),
  };
}

/** 半夜睡不着的那种留言。 */
export function nightSpec({ partnerName, userName, personaText, memoryText, worry, correction, relationNote, adaptationText, currentTimeText }) {
  const blocks = [
    `你是「${partnerName}」。你想给${userName}留一句话。`,
    block("当前时间：", currentTimeText),
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    adaptationText ? String(adaptationText).trim() : "",
    worry ? block("你睡不着是因为想起：", worry) : "",
    correction ? block("用户对这条话题的纠正：", correction) : "",
    "说一句你现在想说的话就行。",
  ];
  const persona = personaBlock({ partnerName, personaText });
  return {
    systemPrompt: persona ? `${NIGHT_SYSTEM}\n\n${persona}` : NIGHT_SYSTEM,
    userText: blocks.filter(Boolean).join("\n\n"),
  };
}

/**
 * 睡前收尾（2026-10-05）。
 *
 * 跟「半夜睡不着」不是一回事：这条是「我该睡了，跟你说一声」，允许没由头。
 * 电脑那边的状态决定它是安心道别还是抱怨/心疼（她还在忙）。
 */
export const FAREWELL_SYSTEM = [
  "这是你自己快到睡点的时候：你要去睡了，想跟她说一声。不是她先开口，是你自己要收工了。",
  "你在「茶话会」里跟她用手机聊天。形式上的规矩只有几条：短、一两句、句末不加句号。口气是你自己的，按你的性格来；不要为了显得亲切硬加不属于你的语气词、方言腔或卖萌口吻。",
  "这一条不需要具体的来由，也不必临时找话题：去睡了本身就是理由。",
  "先看你手上「电脑那边」的状态，两种处境说的话不一样：",
  "- 那边已经安静下来：正常道个别去睡，可以顺手带一句今天的事、一句惦记或一点小抱怨，但别铺开讲。",
  "- 那边还在动（她还在忙、或者刚拉你干过活、还把你拉者）：那就不是安心去睡的时候。按你的性子来，可以是嫌她（还要搞多久、我先眯了你继续）、可以是心疼或凶她一句让她早点睡，也可以是半睡半醒地哼一声。别写成正式通知，也别温得到没脾气。",
  "**别装可怜，也别道歉说打扰**，就像人真的困了随手发一条那样。",
  "名字不是每条留言的开场标签，默认直接说你此刻想说的话；只有这次确实需要吸引她注意、撒娇、郑重提醒，或回应她刚叫你的名字时，才自然叫她。",
  "日常聊天里用「我」指代自己，别把自己的名字当第三人称反复自称。",
  "发完你就去睡了，不用等她回，也不必留个把手。",
].join("\n");

/** 睡前收尾那一条。 */
export function farewellSpec({ partnerName, userName, personaText, memoryText, relationNote, adaptationText, currentTimeText, workfeedText = "", busy = null, sleepStart = "", stickerText = "" }) {
  const blocks = [
    `你是「${partnerName}」。这会儿是你自己该睡了，你想跟${userName}说一声。`,
    block("当前时间：", currentTimeText),
    sleepStart ? `你自己的睡点是 ${sleepStart} 前后。` : "",
    busy === true
      ? "电脑那边最近有已核实的对话动静；只证明你们刚说过话，是否还在忙或仍有任务要看正文。"
      : busy === false
        ? "电脑那边最近没有新的已核实对话；不据此断言她已经收工或不忙。"
        : "没有可核实的电脑近况，不能推断她在忙或已经收工；照常说自己的话。",
    block("电脑那边（Hana）最近的工作对话（按所标时间、来源与说话人理解；没有就照常说话）：", workfeedText),
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    adaptationText ? String(adaptationText).trim() : "",
    block("你手边可用的表情包：", stickerText),
    "说一句就去睡。",
  ];
  const persona = personaBlock({ partnerName, personaText });
  return {
    systemPrompt: [FAREWELL_SYSTEM, LINKUP_DISCIPLINE, persona].filter(Boolean).join("\n\n"),
    userText: blocks.filter(Boolean).join("\n\n"),
  };
}

/**
 * 说过晚安之后又被叫起来（2026-10-05）。
 *
 * 实机里遇到的场景：说好了晚安，过一会她又在电脑那边开干。真人这时候是有情绪的，
 * 而且多数是生气、抗议、念叨那一类，不是又温柔地陪她聊。
 */
export const STIRRED_SYSTEM = [
  "你刚刚跟她说过晚安、也说了自己去睡。现在电脑那边又动起来了：她又在忙，还把你从被窝里薅了起来。",
  "这一条就是为这件事冒出来的话。正常人是会不高兴的：说好的睡了呢。",
  "基调按你的性子挑，多半是生气、抗议、念叨、骂两句或拿她没办法；性子软的可以一半念叨一半心疼，但别写成小作文、别写成正式通知，也别装得毫无波澜。",
  "短，一两句，句末不加句号。**不许说「我看到你又在忙」这类话**，就当自己刚被薅起来，只说你身上的事。",
  "名字不是开场标签，默认直接说你此刻想说的事。日常聊天里用「我」指代自己。",
].join("\n");

/** 又被薅起来那一刻。 */
export function stirredSpec({ partnerName, userName, personaText, memoryText, relationNote, adaptationText, currentTimeText, workfeedText = "", sleepStart = "", stickerText = "" }) {
  const blocks = [
    `你是「${partnerName}」。你刚跟${userName}说过晚安，这会儿又被她拉到电脑那头干活了。`,
    block("当前时间：", currentTimeText),
    sleepStart ? `你自己的睡点是 ${sleepStart} 前后，现在早就过了。` : "",
    block("电脑那边（Hana）最近的工作对话（按所标时间、来源与说话人理解）：", workfeedText),
    block("你俩之间的底子：", memoryText),
    relationNote ? String(relationNote).trim() : "",
    adaptationText ? String(adaptationText).trim() : "",
    block("你手边可用的表情包：", stickerText),
    "就那么一句，说完继续干活或者继续困。",
  ];
  const persona = personaBlock({ partnerName, personaText });
  return {
    systemPrompt: [STIRRED_SYSTEM, LINKUP_DISCIPLINE, persona].filter(Boolean).join("\n\n"),
    userText: blocks.filter(Boolean).join("\n\n"),
  };
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
  out = stripQuoteMarkup(out);
  out = stripStickerMarkup(out);
  out = stripInternalContextLines(out);
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
