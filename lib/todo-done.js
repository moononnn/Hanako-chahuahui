/**
 * 茶话会 · 她说一句"我做完了"，顺手把拾光记那条待办勾掉。
 *
 * 规矩先摆在这：
 *   1. **只勾，不编**。勾哪一条由拾光记自己认；认不出来就不勾，不猜。
 *   2. **宁可漏，不可错**。宁可她多说一句让我们问，宁可这条没勾上，也别把"我待会儿吃"划掉。
 *   3. **她说了算**。勾完要顺口让她知道，别让她自己回去看有没有成。
 *
 * 判定不交给模型：这句话的形状太窄了（"吃了/做完了/搞定了"这类），
 * 用看得见的规则判，反而不会哪天"我待会儿吃"也被当成完成。规则认不准就不动手。
 */

import { DAYBOOK_APP_ID } from "./daybook.js";

export const TODO_COMPLETE_METHOD = "todo/complete";

/** 完成语气：她把这事说成已经落地了。 */
const DONE_WORDS = [
  "吃了", "喝完", "吃完了", "喝完了", "做完了", "写完了", "搞定了", "搞完了", "完成了", "做完了",
  "交了", "交了稿", "交完了", "发了", "发出去了", "寄了", "到了", "买好了", "买完了", "洗完了",
  "看完了", "读完了", "听完了", "练完了", "跑完了", "修好了", "装好了", "打扫完了", "收拾好了",
  "办完了", "办好了", "搞定啦", "做啦", "弄完了", "处理完了", "整完了", "吃啦", "喝啦", "搞定咯",
];

/**
 * 词表穷举的是动作，可中文完成语是「任意动作 + 完/妥」的结构：
 * 浇完啦、喂完啦、弄妥了、跑完……动作多到列不尽，列了就永远差一个。
 * 所以再认形状，不认具体是哪个动作。
 * 「好」故意不收进这一条：「天气好看」「好喝」会把疑问以外的句子也拖进来，
 * 「洗好了」「买好了」交给下面那条「动作 + 好了」认——那一条知道自己在认什么。
 */
const DONE_SHAPE = /[一-龥](?:完|妥)(?:了|啦|咯|嘞|哟|过的?)?/;

/**
 * 日常动作。她会往待办上记的事基本就是这些，集合小且稳。
 * 用来把「做完了」锚到具体哪一条待办，而不是从她整句话里随便捡一个字。
 *
 * 分两档，区别是“这个动作说出口能不能锁定一件事”：
 *   强指向——「浇完啦」里的浇，说出来就只可能是浇那盆，不用提薄荷也不用提水。
 *   泛动词——「我吃完了」里的吃，吃什么都不一定；它必须连宾语一起出现才算数。
 * 这一档之分就是「浇完啦」能勾、「哎妈我吃完了」不勾的全部理由。
 */
const STRONG_VERBS = [
  "浇", "喂", "剪", "种", "贴", "换", "擦", "晾", "还", "付", "修", "装", "寄", "扔", "删", "订", "约",
  "下单", "取", "打印", "抹", "涂", "搬", "喂药", "喂鱼", "扫地", "开窗", "关窗", "晒",
];
const WEAK_VERBS = [
  "吃", "喝", "看", "读", "听", "跑", "拿", "打", "睡", "学", "练", "背", "写", "整理", "收拾", "处理",
  "办", "做", "买", "洗", "扫",
];

/** 完成形态的尾巴：动作后头跟这些，才算那个动作真的落了地。宾语可以跟在完成标记后头（「浇完水了」）。 */
const DONE_TAIL = /(?:完|好|妥)[一-龥]{0,2}(?:了|啦|咯|嘞|哟|的)?$|过[一-龥]{0,3}(?:了|啦|咯|的)?$/;

/** 反证：这些词一出现，就不是"已经做完了"。宁可漏掉这一次，也别划错。 */
const NOT_DONE_WORDS = [
  "待会", "待会儿", "等会", "等一下", "一会儿", "马上", "回头", "晚点", "等会再", "还没", "没吃", "没喝",
  "没做", "没写", "没弄", "差点", "准备", "打算", "正要", "正在", "想吃", "想买", "该吃", "该做",
  "要不要", "能不能", "必须", "得去", "要记得", "提醒我", "别忘",
  // 疑问与虚拟语气：问句、试探、反问一律不当完成。"浇完了吗""该不会忘了吧"都挡在这儿。
  "吗", "没有", "是不是", "会不会", "几点", "什么时候", "还没完", "不完", "好不好", "行不行", "咋", "啥时候",
  // 反问的另一种写法："浇完了没"。按字面它在肯定句里也合法，但口语里十有八九是问句。
  "了没", "了不", "了？", "了?",
];

const TEXT_LIMIT = 400;

function clean(value, maxLength = TEXT_LIMIT) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function normalize(value) {
  return clean(value, 120)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。！？、,.!?;；:："'`~—\-_*·]/g, "");
}

/** 这句话像不像"这件事已经做完了"。 */
export function looksDone(text) {
  const raw = clean(text);
  if (!raw) return false;
  if (NOT_DONE_WORDS.some((word) => raw.includes(word))) return false;
  if (DONE_WORDS.some((word) => raw.includes(word))) return true;
  return DONE_SHAPE.test(raw);
}

/**
 * 这条待办的动作，在她那句话里是不是已经做完的形态。
 * 「给薄荷浇水」对「浇完啦」「浇过水了」——省掉的主语和宾语由这条待办自己补上。
 * 弱动词（吃、看、洗……）光说动作不作数，得连待办里那个东西也提到了。
 */
export function doneByOwnAction(title, said) {
  const key = normalize(title);
  const raw = clean(said);
  const text = normalize(said);
  // 反证词在这条路上也得再拦一遍：它不查 here，疑问句就会从动作路径绕进来。
  if (!raw || !key || !text) return false;
  if (NOT_DONE_WORDS.some((word) => raw.includes(word))) return false;
  const done = (verb) => {
    for (let i = 0; i + verb.length <= text.length; i += 1) {
      if (text.slice(i, i + verb.length) === verb && DONE_TAIL.test(text.slice(i + verb.length))) return true;
    }
    return false;
  };
  for (const verb of STRONG_VERBS) {
    if (key.includes(verb) && done(verb)) return true;
  }
  for (const verb of WEAK_VERBS) {
    if (!key.includes(verb) || !done(verb)) continue;
    // 光说「吃完了」不算「吃维生素d」；得连维生素d一块儿说了才算。
    if (text.includes(key)) return true;
    const core = key.split(verb).join("").replace(/^(?:给|把|去|要|得)/, "");
    if (core.length >= 2 && text.includes(core)) return true;
  }
  return false;
}

/** 标题开头那个动作词：她说“维生素d我吃了”时，认的是“维生素d”那一头。 */
const ACTION_PREFIX = /^(吃|喝|做|写|读|看|买|洗|跑|练|交|发|寄|修|装|打扫|收拾|办|弄|整|处理|完成|搞定|给)/;

function coreTitle(title) {
  const key = normalize(title);
  if (!key) return "";
  const matched = key.match(ACTION_PREFIX);
  return matched ? key.slice(matched[0].length) : key;
}

/** 两个串按顺序共有的部分占短串多少：用来认“薄荷浇完水了”对“给薄荷浇水”。 */
function overlapRatio(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (!short.length) return 0;
  const prev = new Array(long.length + 1).fill(0);
  for (let i = 1; i <= short.length; i += 1) {
    let prevDiag = 0;
    for (let j = 1; j <= long.length; j += 1) {
      const tmp = prev[j];
      prev[j] = short[i - 1] === long[j - 1] ? prevDiag + 1 : Math.max(prev[j], prev[j - 1]);
      prevDiag = tmp;
    }
  }
  return prev[long.length] / short.length;
}

/**
 * 从拾光记摊来的未完成待办里，认领"她说的那一条"。
 * 认得准才动手：只命中一条、或者只有一条待办本身就认；都对不上就交回 null。
 */
export function matchPendingTodo(text, pending = []) {
  const rows = (Array.isArray(pending) ? pending : []).filter((row) => clean(row?.title));
  if (!rows.length) return null;
  const said = normalize(text);
  if (!said) return null;

  // 1) 标题原样出现在她这句话里：最硬的一条证据
  const exact = rows.filter((row) => said.includes(normalize(row.title)));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // 2) 去掉动作词后那个东西出现在她这句话里：“维生素d我吃了”对得上“吃维生素d”
  const core = rows.filter((row) => {
    const key = coreTitle(row.title);
    return key.length >= 2 && said.includes(key);
  });
  if (core.length === 1) return core[0];
  if (core.length > 1) return null;

  // 3) 标题与她这句话认得出是同一件事（换词、换语序都算）
  const partial = rows.filter((row) => {
    const key = normalize(row.title);
    return key.length >= 2 && overlapRatio(key, said) >= 0.6;
  });
  if (partial.length === 1) return partial[0];

  // 4) 口语里常省掉主语宾语：「浇完啦」对「给薄荷浇水」。省掉的那部分由这条待办自己补。
  const byAction = rows.filter((row) => doneByOwnAction(row.title, said));
  if (byAction.length === 1) return byAction[0];
  if (byAction.length > 1) return null;

  // 5) 她什么都没提，手上只挂着一条：那就是它
  if (rows.length === 1) return rows[0];

  return null;
}

/** 快照里认领用的那份未完成待办。 */
export function pendingFromSnapshot(snapshot) {
  const today = snapshot && typeof snapshot === "object" && snapshot.today && typeof snapshot.today === "object"
    ? snapshot.today
    : null;
  if (!today || !Array.isArray(today.todosPending)) return [];
  return today.todosPending
    .map((row) => ({ id: clean(row?.id, 64), title: clean(row?.title), date: clean(row?.date, 10), at: clean(row?.at, 5) }))
    .filter((row) => row.title);
}

/**
 * 「她说完了吗、对上了哪一条」这一步，判定与提议共用。
 * 分开写两边一定会长歪，所以只此一份：completeFromMessage（旧：直接落笔）、
 * proposeFromMessage（新：只提议，等她点）都走这里。
 * @returns {{status:"hit", todo:object}|{status:"not-done"|"no-match"}}
 */
export function judgeCompletion(text, pending = []) {
  const byActionAnywhere = pending.some((row) => doneByOwnAction(row.title, text));
  if (!looksDone(text) && !byActionAnywhere) return { status: "not-done" };
  const hit = matchPendingTodo(text, pending);
  if (!hit) return { status: "no-match" };
  return { status: "hit", todo: hit };
}

/**
 * 这一轮要不要动账，以及动了以后给伙伴看的那句话。
 * @returns {Promise<{done:boolean, factText?:string, reason?:string, todo?:object}>}
 */
export async function completeFromMessage(ctx, { text, snapshot = null, diagnostics = null } = {}) {
  if (!snapshot) {
    diagnostics?.({ event: "todo-done.no-snapshot", text: clean(text, 60) });
    return { done: false, reason: "no-snapshot" };
  }
  const pending = pendingFromSnapshot(snapshot);
  const judged = judgeCompletion(text, pending);
  if (judged.status !== "hit") {
    diagnostics?.({ event: judged.status === "not-done" ? "todo-done.not-a-done-statement" : "todo-done.no-match", text: clean(text, 60), pending: pending.length });
    return { done: false, reason: judged.status };
  }
  const hit = judged.todo;
  if (typeof ctx?.bus?.request !== "function") return { done: false, reason: "no-bus" };
  let result = null;
  try {
    result = await ctx.bus.request(`app:${DAYBOOK_APP_ID}/${TODO_COMPLETE_METHOD}`, { id: hit.id, title: hit.title }, { timeout: 20_000 });
  } catch (error) {
    // 勾不上不是聊天的理由：这一轮照常聊，只把这句咽下去。
    diagnostics?.({ event: "todo-done.call-failed", error: error?.message ?? String(error) });
    return { done: false, reason: "call-failed" };
  }
  if (!result?.ok) {
    diagnostics?.({ event: "todo-done.rejected", reason: result?.reason ?? "unknown" });
    return { done: false, reason: result?.reason ?? "rejected" };
  }
  const todo = result.todo || hit;
  diagnostics?.({ event: "todo-done.completed", title: todo.title, alreadyDone: Boolean(result.alreadyDone) });
  return { done: true, alreadyDone: Boolean(result.alreadyDone), todo, factText: doneFactText(todo, { alreadyDone: result.alreadyDone }) };
}

/** 给 ta 看的那一句：事情已经落在她自己那边的账上了。 */
export function doneFactText(todo, { userName = "她", alreadyDone = false } = {}) {
  const person = String(userName || "她").trim() || "她";
  const title = clean(todo?.title, 60);
  if (!title) return "";
  return [
    "【她刚说的这句话，你已经替她记下了】",
    alreadyDone
      ? `${person}说「${title}」做完了。这条本来就已经是完成状态。`
      : `${person}刚说「${title}」做完了，这条已经从未完成的待办里划掉了。`,
    "用你自己的语气带一句就行：她记得就行，别记账、别说“已为你勾选”这种系统话。",
    "她没提别的就顺着这句回，别把话题拐到待办本上。",
  ].join("\n");
}
