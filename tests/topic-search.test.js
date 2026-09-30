import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanSearchText,
  formatSearchContext,
  parseSearchResults,
  searchTimelyTopic,
  searchUrl,
} from "../lib/topic-search.js";

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[新进展标题]]></title><link>https://example.com/a</link><description><![CDATA[这是刚刚看到的摘要 &amp; 还有一点内容]]></description><pubDate>Mon, 14 Sep 2026 06:00:00 GMT</pubDate></item>
<item><title>第二条</title><link>https://example.com/b</link><description>第二条摘要</description></item>
</channel></rss>`;

test("搜索词会安全编码到必应 RSS 地址", () => {
  assert.match(searchUrl("某人 最新进展"), /^https:\/\/www\.bing\.com\/search\?q=%E6%9F%90%E4%BA%BA%20%E6%9C%80%E6%96%B0%E8%BF%9B%E5%B1%95&format=rss$/);
});

test("搜索结果只取标题和摘要并解码清洗", () => {
  const rows = parseSearchResults(RSS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "新进展标题");
  assert.equal(rows[0].snippet, "这是刚刚看到的摘要 & 还有一点内容");
  assert.equal(rows[1].url, "https://example.com/b");
  assert.equal(cleanSearchText("  <b>一行</b>\n两行  "), "一行 两行");
});

test("搜索素材明确带不确定性，不把结果当定论", () => {
  const context = formatSearchContext([{ title: "标题", snippet: "摘要" }]);
  assert.match(context, /可能不完整或不准确/);
  assert.match(context, /标题：摘要/);
});

test("时效搜索成功时返回上下文", async () => {
  let called;
  const result = await searchTimelyTopic(async (url, options) => {
    called = { url, options };
    return { ok: true, async text() { return RSS; } };
  }, { title: "新瓜", searchQuery: "新瓜 最新进展" });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(called.options.method, "GET");
  assert.equal(called.options.timeoutMs, 8_000);
  assert.equal(called.options.maxResponseBytes, 1_048_576);
  assert.match(decodeURIComponent(called.url), /新瓜 最新进展/);
});

test("搜索词含私人称呼、个人经历标记或可识别信息时不外发", async () => {
  let called = false;
  const fetcher = async () => { called = true; return { ok: true, async text() { return RSS; } }; };
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "阿舟 火锅蘸料" }, { privateTerms: ["阿舟"] })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "我家狗狗进食" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "我以前遇到的蘸料搭配" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "上次我看到的火锅蘸料" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "林喜欢火锅", }, { privateTerms: ["林"] })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "抖音号:abc1234" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "小红书号：阿舟" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "微博账号：小猫" })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "微博昵称：林" }, { privateTerms: ["林"] })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "微博昵称：「林」" }, { privateTerms: ["林"] })).reason, "unsafe-query");
  assert.equal((await searchTimelyTopic(fetcher, { searchQuery: "电话 13800138000" })).reason, "unsafe-query");
  assert.equal(called, false);
  const generic = await searchTimelyTopic(fetcher, { searchQuery: "林地火锅文化" }, { privateTerms: ["林"] });
  assert.equal(generic.ok, true, "单字名字仅在明显人称结构中拦截，避免误伤普通词");
  const game = await searchTimelyTopic(fetcher, { searchQuery: "我的世界 生成机制" });
  assert.equal(game.ok, true, "公共主题里的‘我的’不误判成自述经历");
  const genericSocial = await searchTimelyTopic(fetcher, { searchQuery: "小红书分享视频" });
  assert.equal(genericSocial.ok, true, "普通平台内容主题不因平台名被误判为账号");
  const accountGuide = await searchTimelyTopic(fetcher, { searchQuery: "小红书账号的隐私设置" });
  assert.equal(accountGuide.ok, true, "平台账号使用指南不是具体账号标识");
  const spacedGuide = await searchTimelyTopic(fetcher, { searchQuery: "小红书账号 隐私设置" });
  assert.equal(spacedGuide.ok, true, "普通空格分词后仍是公开主题，不当作账号昵称");
});

test("网络不可用、HTTP失败和空结果都安静降级", async () => {
  assert.equal((await searchTimelyTopic(null, { title: "新瓜" })).reason, "network-unavailable");
  assert.equal((await searchTimelyTopic(async () => ({ ok: false, status: 503 }), { title: "新瓜" })).reason, "http-503");
  assert.equal((await searchTimelyTopic(async () => ({ ok: true, async text() { return "没有结果"; } }), { title: "新瓜" })).reason, "no-results");
});
