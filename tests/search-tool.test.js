import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_TOOL_QUERY,
  SEARCH_TOOL,
  SEARCH_TOOL_NAME,
  TOOL_EMPTY_TEXT,
  TOOL_UNSAFE_TEXT,
  formatToolResults,
  sanitizeToolQuery,
} from "../lib/search-tool.js";

test("工具声明：名字、参数与必填项按宿主契约来", () => {
  assert.equal(SEARCH_TOOL.name, SEARCH_TOOL_NAME);
  assert.equal(SEARCH_TOOL.name, "web_search");
  assert.equal(SEARCH_TOOL.parameters.type, "object");
  assert.deepEqual(SEARCH_TOOL.parameters.required, ["query"]);
  assert.equal(typeof SEARCH_TOOL.parameters.properties.query.description, "string");
});

test("搜索词：正常的中文查询放行", () => {
  const checked = sanitizeToolQuery("PCL 我的世界 下载 争议", { privateTerms: ["阿岚", "小花"] });
  assert.equal(checked.ok, true);
  assert.equal(checked.query, "PCL 我的世界 下载 争议");
});

test("搜索词：空词、过长的词都不查", () => {
  assert.equal(sanitizeToolQuery("   ", {}).reason, "no-query");
  assert.equal(sanitizeToolQuery(null, {}).reason, "no-query");
  const long = sanitizeToolQuery("热".repeat(MAX_TOOL_QUERY + 10), {});
  assert.equal(long.ok, false);
  assert.equal(long.reason, "too-long");
});

test("搜索词：她的名字、私人经历、联系方式都不许出门", () => {
  assert.equal(sanitizeToolQuery("阿岚 喜欢什么口红", { privateTerms: ["阿岚"] }).reason, "unsafe-query");
  assert.equal(sanitizeToolQuery("我朋友 最近的八卦", { privateTerms: [] }).reason, "unsafe-query");
  assert.equal(sanitizeToolQuery("微博号：某某某", { privateTerms: [] }).reason, "unsafe-query");
  assert.equal(sanitizeToolQuery("https://example.com/a", { privateTerms: [] }).reason, "unsafe-query");
  assert.equal(sanitizeToolQuery("她的手机号 13800001111", { privateTerms: [] }).reason, "unsafe-query");
});

test("结果排版：只给标题、摘要、来源，并认得材料长度上限", () => {
  const text = formatToolResults([
    { title: "PCL 暂停下载功能", snippet: "官方公告说暂时不提供。", url: "https://example.com/a", publishedAt: "2026-10-20" },
  ]);
  assert.match(text, /PCL 暂停下载功能/);
  assert.match(text, /2026-10-20/);
  assert.match(text, /官方公告说暂时不提供。/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.match(text, /不是网页正文/);
  assert.equal(formatToolResults([]), "");
});

test("结果排版：超长就截断，不把整页塞进去", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    title: `标题${index}`,
    snippet: "摘".repeat(200),
    url: `https://example.com/${index}`,
  }));
  const text = formatToolResults(rows, { maxChars: 600 });
  assert.ok(text.length <= 600, `实际 ${text.length}`);
});

test("没查到与被拦下：给伙伴的是人话，不是内部状态码", () => {
  assert.doesNotMatch(TOOL_EMPTY_TEXT, /请求|查询计划|触发|上下文|联网通道/);
  assert.doesNotMatch(TOOL_UNSAFE_TEXT, /请求|查询计划|触发|上下文|联网通道/);
});

test("接线：聊天回复这一路真的把工具交给了模型", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  // 工具不止搜索一个了：她手边真有视频时，读视频的那个也一起给，所以走数组，有几个给几个。
  assert.match(source, /if \(offerSearchTool\) chatTools\.push\(SEARCH_TOOL\)/);
  assert.match(source, /if \(videoShelf\.length\) chatTools\.push\(READ_VIDEO_TOOL\)/, "没东西可点开时不给读视频工具");
  assert.match(source, /tools: chatTools\.length \? chatTools : null/, "空数组不发，发的是真手上有的那几个");
  assert.match(source, /executeTool: runChatTool/);
  assert.match(source, /createWebSearchTool\(\{ agentId, partnerName/);
});
