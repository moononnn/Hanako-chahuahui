/**
 * 从聊天里捞梗。
 *
 * 为什么只从聊天里捞（2026-11-14 的教训）：B 站弹幕和热评都不产梗。
 * 实测 8 个热门视频、上万个弹幕加评论，出来的是「合影」1055 次、「来了」132 次、
 * 看完之后的个人感想。那些都是**对着内容说的话**；梗是**对着人说的话**。
 * 源头只能是有人当面在用。
 *
 * 这一层只做两件事，都不花钱：
 *   1. 发现「她刚在说梗」——把这一刻标出来，提醒这一轮回复别照字面接
 *   2. 她自己反复用的短句——同一句话她说两遍以上，那是她的口头禅，本来就是梗
 *
 * 提取「梗的原句是什么」不在这里做。试过用正则从她话里抠名字（「老吴梗」→「老吴」），
 * 实测被"就是"「这个」这类常用词淹掉：22 条命中里只有 2 条是真的。语义判断交给
 * 回复那一轮的模型（它本来就刚读完上下文），这层只管喊一声。
 */

/** 她说破的信号：明说自己在玩，或者嫌没接住。 */
const MENTION_PATTERNS = [
  { re: /我在玩梗|在玩梗|我跟你玩梗|跟你玩梗/u, hint: "她说刚才那句是在玩梗" },
  { re: /接不住梗|接不了梗|没接住梗|不懂我的梗|不理解我的梗|没懂我的梗/u, hint: "她说你没接住她的梗" },
  { re: /我在(?:模仿|演|学|扮演)/u, hint: "她说自己在演另一个人" },
  { re: /[\p{Script=Han}]{2,6}梗(?=[吧啊诶呀哈？！。…]|$)/u, hint: "她点名了一个梗" },
];

/** 复读时不算的日常句：说两遍不代表是梗。 */
const CHITCHAT = new Set([
  "晚安", "早安", "早哇", "晚上好", "在吗", "我要睡啦", "我睡了", "我去洗澡",
  "哈哈哈", "哈哈", "嘿嘿", "嗯嗯", "好的", "好呀", "行吧", "收到", "抱抱",
  "爱你", "想你", "睡了", "洗澡去了", "吃饭了",
]);

/** 她在演谁：油腻男、客服、长辈这类。取不到就空。 */
const ACT_NAME_RE = /(?:模仿|演|学|扮演)(?:一下)?([^\s，。！？、…]{2,12})/u;

/**
 * 她说破之后，把她刚才那一手“演”的原句找出来。
 *
 * 为什么靠位置而不靠语义：三次真实样本里，两次的原句就是她**上一条自己发的**
 * （“手滑发了张自拍…我单身”←“我在模仿中年油腻男”）。这条不用花一分钱，
 * 而模型标记会多一次判断、还可能漏。取不到的宁可不存，也不塞一句错的进去。
 *
 * @param {object[]} messages 整个会话的消息
 * @param {number} index 说破那条在数组里的位置
 * @returns {{text: string, messageId: string, meaning: string} | null}
 */
export function pickMemeSource(messages, index) {
  const rows = Array.isArray(messages) ? messages : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at <= 0) return null;
  const said = rows[at];
  const actMatch = String(said?.text ?? "").match(ACT_NAME_RE);
  const who = actMatch ? actMatch[1].replace(/[啦呀啊哈吧…]+$/u, "").trim() : "";

  // 往前看 4 条，只认她自己发的
  for (let i = at - 1; i >= Math.max(0, at - 4); i -= 1) {
    const row = rows[i];
    if (row?.role !== "user") continue;
    if (row?.kind === "action" || row?.kind === "poke") continue;
    const text = String(row?.text ?? "").trim();
    if (!text || text.startsWith("[")) continue;
    if (CHITCHAT.has(text)) continue;
    if (detectMemeMention(text).said) continue;
    // 太短的不是“演了一段”，只是句回话
    if (text.length < 6) continue;
    return { text, messageId: String(row.id ?? ""), meaning: who ? `在演${who}` : "" };
  }
  return null;
}

/**
 * 她事后给的说法释义：“就是模仿猫咪生气叫声哇” 这类。
 * 只在刚说破的一两条以内认，隔远了就不当解释。
 */
export function detectMemeExplanation(text) {
  const body = String(text ?? "").trim();
  if (!body) return "";
  const m = body.match(/(?:就是|意思是|指的是|俗称)([^。！？\n]{2,40})/u);
  if (!m) return "";
  const meaning = m[1].trim().replace(/[啦呀哇啊哈吧呢…]+$/u, "").trim();
  if (meaning.length < 2) return "";
  // “就是觉得累”这种是随口一句，不是释义
  if (/^(?:觉得|感觉|想|说|不太|有点|这么|那样)/u.test(meaning)) return "";
  return meaning.slice(0, 60);
}

/**
 * 她这句里有没有「梗」的信号。
 *
 * @returns {{said: boolean, hint: string}} said 为真时，这一轮回复该被提醒：
 *   她说的可能不是字面意思。具体是哪句、什么意思，交给模型自己看上下文。
 */
export function detectMemeMention(text) {
  const body = String(text ?? "").trim();
  if (!body) return { said: false, hint: "" };
  for (const { re, hint } of MENTION_PATTERNS) {
    if (re.test(body)) return { said: true, hint };
  }
  return { said: false, hint: "" };
}

/** 「XX梗」里的名字不在这里抠。试过了，规则抠不准：
 * 「你怕不是不知道老吴梗吧」会抠成「是不知道老吴」。给错的线索比不给更糟，
 * 所以这一层只喊「她在说梗」，原句交给模型看上下文提。 */