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

test("搜索词会安全编码到 Google News RSS 地址", () => {
  assert.match(searchUrl("某人 最新进展"), /q=%E6%9F%90%E4%BA%BA%20%E6%9C%80%E6%96%B0%E8%BF%9B%E5%B1%95/);
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
  assert.match(decodeURIComponent(called.url), /新瓜 最新进展/);
});

test("网络不可用、HTTP失败和空结果都安静降级", async () => {
  assert.equal((await searchTimelyTopic(null, { title: "新瓜" })).reason, "network-unavailable");
  assert.equal((await searchTimelyTopic(async () => ({ ok: false, status: 503 }), { title: "新瓜" })).reason, "http-503");
  assert.equal((await searchTimelyTopic(async () => ({ ok: true, async text() { return "没有结果"; } }), { title: "新瓜" })).reason, "no-results");
});
