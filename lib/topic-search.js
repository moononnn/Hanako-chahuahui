/**
 * 时效话题的轻量搜索：只在伙伴准备主动开口时临时取一次公开搜索结果。
 * 生产网络必须从宿主 ctx.network.fetch 注入，纯函数和解析逻辑可单独测试。
 */

const SEARCH_URL = "https://news.google.com/rss/search";

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");
}

export function cleanSearchText(value, max = 400) {
  return decodeEntities(String(value ?? ""))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

export function searchUrl(query) {
  const clean = String(query ?? "").trim();
  return `${SEARCH_URL}?q=${encodeURIComponent(clean)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

/** 从 Google News RSS 结果页取少量标题、摘要和链接。 */
export function parseSearchResults(xml, maxResults = 5) {
  const source = String(xml ?? "");
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/giu;
  for (const itemMatch of source.matchAll(re)) {
    const item = itemMatch[1];
    const title = cleanSearchText(/<title>([\s\S]*?)<\/title>/iu.exec(item)?.[1], 160);
    const snippet = cleanSearchText(/<description>([\s\S]*?)<\/description>/iu.exec(item)?.[1], 360);
    const url = cleanSearchText(/<link>([\s\S]*?)<\/link>/iu.exec(item)?.[1], 500);
    const publishedAt = cleanSearchText(/<pubDate>([\s\S]*?)<\/pubDate>/iu.exec(item)?.[1], 80);
    if (!title || !snippet) continue;
    out.push({ title, snippet, url, publishedAt });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function formatSearchContext(results, maxChars = 1400) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return "";
  const lines = [
    "【刚搜到的外部消息】",
    "这些只是公开搜索结果的摘要，可能不完整或不准确。把它们当作你刚刚看到的线索，不要说成已经核实的事实。",
  ];
  for (const row of rows) {
    const date = row.publishedAt ? `（${row.publishedAt}）` : "";
    lines.push(`· ${row.title}${date}：${row.snippet}`);
  }
  return lines.join("\n").slice(0, maxChars);
}

export async function searchTimelyTopic(fetcher, topic, { maxResults = 5 } = {}) {
  if (typeof fetcher !== "function") return { ok: false, reason: "network-unavailable", results: [] };
  const query = String(topic?.searchQuery || topic?.title || "").trim();
  if (!query) return { ok: false, reason: "no-query", results: [] };
  try {
    const response = await fetcher(searchUrl(query), { method: "GET" });
    if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? "error"}`, results: [] };
    const html = await response.text();
    const results = parseSearchResults(html, maxResults);
    return results.length
      ? { ok: true, query, results, context: formatSearchContext(results) }
      : { ok: false, reason: "no-results", query, results: [] };
  } catch {
    return { ok: false, reason: "request-failed", query, results: [] };
  }
}
