/**
 * 伙伴自己发起的联网搜索（工具）。
 *
 * 2026-10-21 实机：她说「好好，你去找找，然后我们吃瓜」，伙伴上一句刚说「我去查」，
 * 下一句就改口「我这边没法直接搜网页，你把链接甩我嘛」——因为在这之前，搜索是
 * 「应用在回复前代为搜」：关键词规则先判定这句要不要查，搜到的材料塞进提示词，
 * 伙伴全程没有发起权。它说「我去查」是句空话，下一轮只能自己拆台。
 *
 * 所以搜索要变成一个真工具：
 * - 发起权在伙伴：要不要查、查什么词，它自己定；
 * - 执行在应用：真去搜索、把结果回给它（宿主契约里工具由 App 自己执行）；
 * - 隐私门照旧：搜索词里不许出现她的名字、私人经历、联系方式。
 *
 * 这里只放纯逻辑（工具声明、词的处理、结果的排版），执行那一段在 index.js，
 * 因为记账、熔断、引擎选择都住在那儿。
 */

import { isSafeSearchQuery } from "./topic-search.js";
import { containsPrivateStory } from "./chat-search.js";

export const SEARCH_TOOL_NAME = "web_search";

/** 工具声明（宿主契约 AppModelToolV2：JSON Schema，宿主自己不会执行）。 */
export const SEARCH_TOOL = {
  name: SEARCH_TOOL_NAME,
  description: "在公开网页上搜一件事。给它一个具体的搜索词（中文关键词：对象 + 事件/时效；也可以直接是一个梗、黑话、缩写、作品名），回你标题、摘要和来源链接。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索词：对象 + 事件或时效，例如「PCL 我的世界 下载 争议」；听不认识的梗或黑话就直接搜那个词，例如「老吴梗 出处 什么意思」。不要写对方的名字、私事或聊天原话。",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** 搜索词上限：跟聊天那条老路一致，太长的词多半是把整段话塞进来了。 */
export const MAX_TOOL_QUERY = 100;

/**
 * 工具给的搜索词能不能往外发。
 *
 * 守的是「私聊线索不跟着新引擎出门」这条老规矩：她提到的人名、账号、联系方式、
 * 第一人称经历、聊天原话，都不能进搜索词。拦下来不是失败，是不查。
 */
export function sanitizeToolQuery(raw, { privateTerms = [] } = {}) {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return { ok: false, reason: "no-query", query: "" };
  if (text.length > MAX_TOOL_QUERY) {
    return { ok: false, reason: "too-long", query: text.slice(0, MAX_TOOL_QUERY) };
  }
  if (!isSafeSearchQuery(text, privateTerms) || containsPrivateStory(text)) {
    return { ok: false, reason: "unsafe-query", query: "" };
  }
  return { ok: true, query: text, reason: "ok" };
}

/**
 * 搜到的结果排成给伙伴看的一段。
 *
 * 只给标题、摘要、来源链接和日期，不给正文——伙伴没读过那篇网页，
 * 手里只有搜索摘要这件事得在提示词里说清楚，这里也别装成读过全文。
 */
export function formatToolResults(results, { maxChars = 1600, maxRows = 4 } = {}) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return "";
  const lines = ["【搜索结果（标题与摘要，不是网页正文）】"];
  for (const row of rows.slice(0, maxRows)) {
    const date = row?.publishedAt ? `（${row.publishedAt}）` : "";
    const url = row?.url ? ` 来源：${row.url}` : "";
    const line = `· ${row?.title ?? ""}${date}：${row?.snippet ?? ""}${url}`;
    if (`${lines.join("\n")}\n${line}`.length > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n").slice(0, maxChars);
}

/** 没查到时给伙伴的那句话：说人话，不解释内部步骤，也不怪网络。 */
export const TOOL_EMPTY_TEXT = "没扒到能用的公开材料。就说暂时没找到，回到你们正在聊的事；别编来源，别讲你这边怎么查的。";

/** 搜索词被隐私门拦下时给伙伴的那句话。 */
export const TOOL_UNSAFE_TEXT = "这个搜不出去：词里带了不该外发的东西。转回聊天本身，别提搜索这回事。";
