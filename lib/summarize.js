/**
 * 摘要生成：把滚出窗口的对话、一整天、还有"我认识的她"交给便宜模型整理。
 *
 * 纯函数（拼 prompt、洗结果）跟调用分开：`runSummary(ask, spec)` 里的 `ask` 是注入的，
 * 测试可以塞一个假的，不碰网络也不碰宿主。
 */

import { renderForSummary } from "./memory.js";
import { dayLabel } from "./days.js";

const COMMON_RULES = [
  "写的时候用「我」指代我自己，「你」指代对方。",
  "只写事实和情绪走向，不评价、不总结人生道理、不用书面腔。",
  "不复述每一句，不列条目，不写标题，不写「总结」「摘要」这类前缀。",
  "保留具体的物、人、事、时间（她说过的名字、正在做的东西、答应过的事）。",
  "宁短勿长。",
].join("\n");

export const SEGMENT_SYSTEM = [
  "你在帮一个聊天应用整理记忆。下面是一段较早的对话，它马上要滚出最近的上下文了。",
  "把它压成一两句话，留到以后还能想得起来。",
  COMMON_RULES,
].join("\n");

export const DAILY_SYSTEM = [
  "你在帮一个聊天应用记一天的账。下面是这一天里两个人聊过的内容。",
  "写成一两句话的日账：今天聊了什么、对方是什么状态。像在日记本上补一笔，不像汇报。",
  COMMON_RULES,
].join("\n");

export const PROFILE_SYSTEM = [
  "你在维护一份「我认识的她」的小档案，写给当前伙伴自己看，以后每次说话前都会读一遍。",
  "当前档案所属伙伴的名字会在材料中明确标出；档案里的「我」只能指当前伙伴，不能指用户。",
  "材料可能有两份：一份是主对话框那边一直记着的「关于用户的事」（语气像资料卡），一份是用户和当前伙伴在这边聊出来的近况。",
  "把新信息并进旧档案，输出**更新后的完整档案**；两边说法冲突时，以最近聊到的为准。",
  "只写稳定的关系信息：用户怎么称呼当前伙伴、用户的习惯与偏好、你们之间已经形成的梗与约定。用户最近在忙什么只在确实会影响后续聊天时保留。",
  "不要写一次性的聊天内容，不要写日期流水，不要写「今天用户说了」，不要记录当前伙伴的口头禅、自称、动作文案或表达模板。",
  "把‘小花怎么说话’、‘小花常用什么句式’这类表达风格排除；档案只记录你们之间发生过什么和用户是谁。",
  "资料卡里的东西别照抄，用当前伙伴认识用户之后的语气写；现在这份档案本身的口吻是对的，尽量保留，别重写句子。",
  "主客别写反：用户说「我叫……」时，那是用户在说自己；用户说「我叫你……」时，是用户给当前伙伴起称呼。只有明确说当前伙伴叫什么，才能写当前伙伴的名字或昵称。",
  "控制在四百字以内，宁缺勿滥。",
  COMMON_RULES,
].join("\n");

const LIMITS = { segment: 240, daily: 300, profile: 900 };

/** 洗掉模型爱加的壳：前缀标签、引号、markdown 装饰。 */
export function cleanSummary(text, kind = "segment") {
  let out = String(text ?? "").trim();
  if (!out) return "";
  // 去掉「摘要：」「日账：」这类前缀
  out = out.replace(/^(摘要|总结|日账|档案|记录|更新后的(完整)?档案)\s*[:：]\s*/u, "");
  // 去掉整段被引号或代码块包住的情况
  out = out.replace(/^```[\s\S]*?\n([\s\S]*?)```$/u, "$1");
  out = out.replace(/^[「『"“]([\s\S]*)[」』"”]$/u, "$1");
  // markdown 装饰
  out = out.replace(/^\s*[-*•]\s+/gmu, "").replace(/^\s*#{1,6}\s+/gmu, "");
  out = out.replace(/\*\*/g, "");
  // 折行压成一行（日账和摘要都是短语，不该带换行；档案允许分段）
  out = kind === "profile" ? out.replace(/\n{3,}/g, "\n\n") : out.replace(/\s*\n+\s*/g, " ");
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  const limit = LIMITS[kind] ?? LIMITS.segment;
  if (out.length > limit) out = `${out.slice(0, limit - 1)}…`;
  return out;
}

/** 短到没有信息量就当没写出来，别往账上记。 */
export function isUsableSummary(text, kind = "segment") {
  const out = String(text ?? "").trim();
  if (!out) return false;
  if (kind === "profile") return out.length >= 8;
  return out.length >= 6;
}

export function segmentSpec(batch, userName = "她") {
  return {
    kind: "segment",
    systemPrompt: SEGMENT_SYSTEM,
    userText: `对话内容：\n${renderForSummary(batch, userName)}`,
  };
}

export function dailySpec(messages, day, userName = "她") {
  return {
    kind: "daily",
    systemPrompt: DAILY_SYSTEM,
    userText: `${dayLabel(day)}这一天：\n${renderForSummary(messages, userName)}`,
  };
}

export function profileSpec(profileText, recentMessages, userName = "她", factsText = "", partnerName = "当前伙伴") {
  const old = String(profileText ?? "").trim();
  const facts = String(factsText ?? "").trim();
  const user = String(userName ?? "她").trim() || "她";
  const partner = String(partnerName ?? "当前伙伴").trim() || "当前伙伴";
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  const blocks = [
    `当前伙伴：${partner}`,
    `用户：${user}`,
    "档案中的「我」只能指当前伙伴，「用户」只能指用户。",
    old ? `现在的档案：\n${old}` : "现在的档案：（空，这是第一版）",
  ];
  if (facts) blocks.push(`主对话框那边一直记着的「关于${user}的事」：\n${facts}`);
  blocks.push("", recent.length ? `最近在茶话会里聊过的：\n${renderForSummary(recent, user, partner)}` : "最近在茶话会里还没怎么聊过。");
  return { kind: "profile", systemPrompt: PROFILE_SYSTEM, userText: blocks.join("\n") };
}

/** 防止模型把用户的自称落成当前伙伴的身份事实。 */
export function isProfileIdentitySafe(text, partnerName = "") {
  const value = String(text ?? "");
  const partner = String(partnerName ?? "").trim();
  if (!value.trim() || !partner) return true;
  // 只拦“当前伙伴在自称别的名字”，不拦“她叫我小花”这类用户给伙伴起称呼。
  const selfName = /(?:^|[。！？!?\n])\s*(?:我|本人)\s*(?:的名字)?\s*(?:叫|名叫|名字是|名字叫|是|就是)\s*[「『“"]?([^，。！？!?\s「」『』“”：:]{1,12})/gu;
  for (const match of value.matchAll(selfName)) {
    if (match[1] && match[1] !== partner) return false;
  }
  return true;
}

/**
 * 交给模型跑一次。
 * @param ask (systemPrompt: string, userText: string, maxTokens: number) => Promise<string>
 */
export async function runSummary(ask, spec) {
  if (!spec) return { ok: false, reason: "no-spec" };
  const budget = spec.kind === "profile" ? 500 : 200;
  try {
    const raw = await ask(spec.systemPrompt, spec.userText, budget);
    const text = cleanSummary(raw, spec.kind);
    if (!isUsableSummary(text, spec.kind)) {
      return { ok: false, reason: "too-short", raw: String(raw ?? "").slice(0, 200) };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: "threw", error: error?.message ?? String(error) };
  }
}
