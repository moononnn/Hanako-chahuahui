import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  createSearchSession,
  engineAllowsUndated,
  listSearchEngines,
  normalizeSearchOrder,
  normalizeSearchEnhancement,
  normalizeSearchEngine,
  recordSearchUsage,
  searchChain,
  searchTavily,
  searchWeb,
  searchWithEngine,
  tavilyBlocked,
  usageCount,
  usageMonth,
} from "../lib/search-engine.js";
import { isFreshEnough, searchForChat } from "../lib/chat-search.js";

const APP_DIR = new URL("../", import.meta.url);
const appSource = readFileSync(new URL("index.js", APP_DIR), "utf8");
const chatSearchSource = readFileSync(new URL("lib/chat-search.js", APP_DIR), "utf8");
const settingsHtml = readFileSync(new URL("ui/settings.html", APP_DIR), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", APP_DIR), "utf8"));

/** 假 fetcher：按 URL 分派，记录每次请求。 */
function recordingFetcher(handlers = {}) {
  const seen = { calls: [] };
  const fetcher = async (url, options = {}) => {
    seen.calls.push({ url: String(url), options });
    const hit = Object.entries(handlers).find(([name]) => String(url).includes(name));
    if (!hit) return { ok: true, async text() { return ""; } };
    const [, handler] = hit;
    return typeof handler === "function" ? handler(String(url), options) : handler;
  };
  return { fetcher, seen };
}

const tavilyRows = [
  { title: "某新款游戏上线日期公布", url: "https://example.com/game", content: "官方宣布新版本上线时间", published_date: "2026-10-18" },
];

test("引擎清单对标 Hana，再加 DeepSeek 自家的", () => {
  const ids = listSearchEngines().map((item) => item.id);
  assert.deepEqual(ids, ["bing", "anysearch", "tavily", "serper", "brave", "deepseek"]);
  assert.equal(normalizeSearchEngine("deepseek"), "deepseek");
  assert.equal(normalizeSearchEngine("DeepSeek"), "deepseek");
  assert.equal(normalizeSearchEngine("google"), "bing", "没实现的引擎不假装能用");
  assert.equal(normalizeSearchEngine(""), "bing");
});

test("只有默认那路不许结果没日期", () => {
  assert.equal(engineAllowsUndated("bing"), false, "必应那条老规矩：日期解析不出就丢");
  assert.equal(engineAllowsUndated("tavily"), true);
  assert.equal(engineAllowsUndated("deepseek"), true);
});

test("配置归一：每家一把 Key，互不干扰", () => {
  const config = normalizeSearchEnhancement({ engine: "deepseek", keys: { deepseek: "sk-1", tavily: "tvly-1" } });
  assert.equal(config.engine, "deepseek");
  assert.equal(config.keys.deepseek, "sk-1");
  assert.equal(config.keys.tavily, "tvly-1");
  assert.equal(normalizeSearchEnhancement(undefined).engine, "bing");
});

test("旧结构里那把单独的 Key 不能自动搬：搬过去就变成明文换了个位置躺着", () => {
  const legacy = normalizeSearchEnhancement({ engine: "tavily", apiKey: "tvly-old" });
  assert.equal(legacy.keys.tavily, undefined, "归一是纯函数，不得在这里搬明文");
  assert.equal(legacy.legacyApiKey, "tvly-old", "旧值原样带出来，交给 async 的地方加密搬迁");
});

test("Tavily 的结果被归一成茶话会认得的那套字段", async () => {
  const { fetcher } = recordingFetcher({ "tavily.com": { ok: true, async json() { return { results: tavilyRows }; } } });
  const result = await searchWithEngine("tavily", fetcher, { query: "新游戏上线", apiKey: "tvly-test" });
  assert.equal(result.results[0].title, "某新款游戏上线日期公布");
  assert.equal(result.results[0].snippet, "官方宣布新版本上线时间");
  assert.equal(result.results[0].publishedAt, "2026-10-18");
});

test("只有标题没摘要的结果不能用", async () => {
  const { fetcher } = recordingFetcher({ "tavily.com": { ok: true, async json() { return { results: [{ title: "只有标题" }] }; } } });
  const result = await searchWithEngine("tavily", fetcher, { query: "新游戏上线", apiKey: "tvly-test" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-results");
});

test("Tavily：真的打到了 api.tavily.com，带 Bearer，日期要开口子", async () => {
  const { fetcher, seen } = recordingFetcher({ "tavily.com": { ok: true, async json() { return { results: tavilyRows }; } } });
  const result = await searchWithEngine("tavily", fetcher, { query: "新游戏上线", apiKey: "tvly-test" });
  assert.equal(result.ok, true);
  assert.equal(seen.calls[0].url, "https://api.tavily.com/search");
  assert.equal(seen.calls[0].options.headers.Authorization, "Bearer tvly-test");
  const body = JSON.parse(seen.calls[0].options.body);
  assert.equal(body.query, "新游戏上线");
  assert.equal(body.include_published_date, true);
});

test("Serper：Google 的结果，Key 走 X-API-KEY", async () => {
  const { fetcher, seen } = recordingFetcher({ "serper.dev": { ok: true, async json() { return { organic: [{ title: "新游上线", link: "https://example.com/x", snippet: "摘要在这", date: "2026-10-18" }] }; } } });
  const result = await searchWithEngine("serper", fetcher, { query: "新游戏上线", apiKey: "serper-key" });
  assert.equal(result.ok, true);
  assert.equal(seen.calls[0].url, "https://google.serper.dev/search");
  assert.equal(seen.calls[0].options.headers["X-API-KEY"], "serper-key");
  assert.equal(result.results[0].publishedAt, "2026-10-18");
  assert.equal(result.results[0].url, "https://example.com/x");
});

test("Brave：自己的索引，摘要字段叫 description", async () => {
  const { fetcher, seen } = recordingFetcher({ "brave.com": { ok: true, async json() { return { web: { results: [{ title: "新游上线", url: "https://example.com/y", description: "摘要在这" }] } }; } } });
  const result = await searchWithEngine("brave", fetcher, { query: "新游戏上线", apiKey: "brave-key" });
  assert.equal(result.ok, true);
  assert.equal(seen.calls[0].url.startsWith("https://api.search.brave.com/res/v1/web/search"), true);
  assert.equal(seen.calls[0].options.headers["X-Subscription-Token"], "brave-key");
  assert.equal(result.results[0].snippet, "摘要在这");
});

test("AnySearch：不给 Key 也能走（免费层）", async () => {
  const { fetcher, seen } = recordingFetcher({ "anysearch.com": { ok: true, async json() { return { data: { results: [{ title: "新游上线", url: "https://example.com/z", content: "摘要在这" }] } }; } } });
  const result = await searchWithEngine("anysearch", fetcher, { query: "新游戏上线", apiKey: "" });
  assert.equal(result.ok, true);
  assert.equal(seen.calls[0].url, "https://api.anysearch.com/v1/search");
  assert.equal(seen.calls[0].options.headers.Authorization, undefined, "免 Key 时不该带 Authorization");
  assert.equal(result.results[0].snippet, "摘要在这");
});

test("DeepSeek：走自家的 /v1/tools/search，长摘要与日期都归一", async () => {
  const { fetcher, seen } = recordingFetcher({ "deepseek.com": { ok: true, async json() { return { results: [{
    title: "DeepSeek V4 发布", url: "https://example.com/ds", snippet: "短摘要", summary: "这是一段给模型读的长摘要，讲清楚了这次发布的来龙去脉。",
    content: "网页正文", site_name: "Example", date: "2026-10-19T05:41:50.168Z", authority: 3, rerank_score: 2.4,
  }] }; } } });
  const result = await searchWithEngine("deepseek", fetcher, { query: "DeepSeek V4 发布", apiKey: "sk-ds" });
  assert.equal(result.ok, true);
  assert.equal(seen.calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(seen.calls[0].options.headers.Authorization, "Bearer sk-ds");
  const body = JSON.parse(seen.calls[0].options.body);
  assert.equal(body.query, "DeepSeek V4 发布");
  assert.ok(body.count >= 1 && body.count <= 50);
  assert.equal(result.results[0].snippet.startsWith("这是一段给模型读的长摘要"), true, "长摘要优先于短摘要");
  assert.equal(result.results[0].publishedAt, "2026-10-19T05:41:50.168Z");
});

test("没有 Key 的引擎不该发请求", async () => {
  const { fetcher, seen } = recordingFetcher({});
  for (const engine of ["tavily", "serper", "brave", "deepseek"]) {
    const result = await searchWithEngine(engine, fetcher, { query: "新游戏上线", apiKey: "" });
    assert.equal(result.ok, false, `${engine} 没 Key 不该发`);
    assert.equal(result.reason, "missing-key");
    assert.equal(result.sent, false);
  }
  assert.equal(seen.calls.length, 0);
});

test("配了哪家就走哪家，不碰默认那条", async () => {
  const { fetcher, seen } = recordingFetcher({ "deepseek.com": { ok: true, async json() { return { results: [{ title: "x", url: "u", summary: "s" }] }; } } });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-ds" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "deepseek");
  assert.equal(result.usedEnhanced, true);
  assert.equal(seen.calls.length, 1);
  assert.ok(seen.calls[0].url.includes("deepseek.com"));
});

test("这家挂了要静默退回默认搜索，不能让聊天断掉", async () => {
  const { fetcher, seen } = recordingFetcher({
    "deepseek.com": { ok: false, status: 401 },
    "bing.com": { ok: true, async text() { return `<?xml version="1.0"?><rss><channel><item><title>新游戏上线消息</title><link>https://example.com/a</link><description>新版本上线时间</description><pubDate>Sat, 18 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>`; } },
  });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-bad" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "bing");
  assert.equal(result.usedEnhanced, true, "确实向那家试过一次，额度要记");
  assert.equal(result.enhancedEngine, "deepseek", "得说清是哪一家挂了");
  assert.equal(result.fallbackReason, "http-401");
  assert.ok(seen.calls.some((call) => call.url.includes("bing.com")));
});

test("私聊线索不跟着新引擎出门", async () => {
  const { fetcher, seen } = recordingFetcher({});
  const result = await searchWeb(fetcher, {
    query: "我的微信号是 zhangsan88 帮我找一下",
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-ds" } },
    privateTerms: ["小明"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsafe-query");
  assert.equal(seen.calls.length, 0, "不该发任何请求");
});

test("Tavily 的结果没日期也留着，必应的老规矩不变", () => {
  const now = new Date("2026-10-20T06:00:00Z");
  assert.equal(isFreshEnough({ publishedAt: "" }, now, true), true, "新引擎没给日期不算过期");
  assert.equal(isFreshEnough({ publishedAt: "" }, now, false), false, "必应没日期的老规矩照旧丢掉");
  assert.equal(isFreshEnough({ publishedAt: "2026-10-18" }, now, true), true);
  assert.equal(isFreshEnough({ publishedAt: "2025-01-01" }, now, true), false, "太久以前的不要");
});

test("聊天里配了哪家，搜出来就是哪家的料", async () => {
  const { fetcher } = recordingFetcher({ "deepseek.com": { ok: true, async json() { return { results: [{ title: "DeepSeek V4 发布", url: "https://example.com/ds", summary: "长摘要在这里" }] }; } } });
  const result = await searchForChat({
    text: "最近有什么新游戏更新？",
    ask: async () => JSON.stringify({ searchQuery: "DeepSeek V4 发布" }),
    fetcher,
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-ds" } },
    now: new Date("2026-10-20T06:00:00Z"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "deepseek");
  assert.equal(result.enhancedEngine, "deepseek");
  assert.match(result.context, /DeepSeek V4 发布/);
  assert.doesNotMatch(result.context, /必应/, "上下文里不该再写死是哪家引擎");
});

test("熔断分长期与瞬时：401 一直拦，429 拦十分钟就放行", () => {
  assert.equal(tavilyBlocked({ status: "verified", error: "没接上（http-401）" }), false, "测通过的 Key 不许被拦");
  assert.equal(tavilyBlocked({ status: "untested" }), false, "没测过的也要照常走");
  assert.equal(tavilyBlocked({ status: "failed", error: "没接上（http-401）" }), true, "鉴权失败是长期故障");
  assert.equal(tavilyBlocked({ status: "failed", error: "没接上（http-433）" }), true, "额度用尽也是长期故障");
  assert.equal(tavilyBlocked({ status: "failed", error: "没接上（no-results）" }), false, "没东西不算故障");
  const justNow = new Date("2026-10-20T06:00:00Z");
  assert.equal(tavilyBlocked({ status: "failed", testedAt: "2026-10-20T05:59:00Z", error: "没接上（http-429）" }, { now: justNow }), true, "限流刚发生：先拦着");
  assert.equal(tavilyBlocked({ status: "failed", testedAt: "2026-10-20T05:40:00Z", error: "没接上（http-429）" }, { now: justNow }), false, "限流过了冷却期：放行重试");
});

test("402 分两种：付费余额耗尽长期拦，匿名层每日额度当天拦、第二天回来", () => {
  const state = { status: "failed", testedAt: "2026-10-20T05:59:00Z", error: "搜索服务没接上（http-402）" };
  assert.equal(tavilyBlocked(state, { now: new Date("2026-10-20T06:00:00Z") }), true, "付费 Key 余额耗尽：长期拦");
  assert.equal(tavilyBlocked(state, { now: new Date("2026-10-20T06:00:00Z"), anonymous: true }), true, "匿名层额度用完：当天拦");
  assert.equal(tavilyBlocked(state, { now: new Date("2026-10-21T12:00:00Z"), anonymous: true }), false, "匿名层第二天额度回来了");
});

test("每家对查询词长度有自己的上限", async () => {
  const long = "长".repeat(200);
  const { fetcher, seen } = recordingFetcher({ "deepseek.com": { ok: true, async json() { return { results: [] }; } } });
  await searchWithEngine("deepseek", fetcher, { query: long, apiKey: "sk-ds" });
  const body = JSON.parse(seen.calls[0].options.body);
  assert.equal([...body.query].length, 128, "DeepSeek 文档写死 1-128 字");
});

test("这家暂时别用了：直接走默认搜索，不白等一次超时", async () => {
  const { fetcher, seen } = recordingFetcher({});
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-dead" }, states: { deepseek: { status: "failed", error: "搜索服务没接上（http-401）" } } },
  });
  assert.equal(result.usedEnhanced, false, "没再向那家发请求");
  assert.equal(result.fallbackReason, "engine-disabled");
  assert.equal(seen.calls.filter((call) => call.url.includes("deepseek.com")).length, 0);
});

test("必应也不行时，说的该是必应的原因", async () => {
  const { fetcher } = recordingFetcher({ "deepseek.com": { ok: false, status: 401 }, "bing.com": { ok: false, status: 503 } });
  const result = await searchWeb(fetcher, { query: "新游戏上线", enhancement: { engine: "deepseek", keys: { deepseek: "sk-bad" } } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "http-503", "别把人往别家引");
  assert.equal(result.fallbackReason, "http-401", "那家的原因另记一笔");
});

test("没填 Key 也没选引擎时，这一层就该完全感觉不到", async () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>新游戏上线消息</title><link>https://example.com/a</link><description>新版本上线时间</description><pubDate>Sat, 18 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>`;
  const { fetcher } = recordingFetcher({ "bing.com": { ok: true, async text() { return xml; } } });
  const plain = await searchWeb(fetcher, { query: "新游戏 上线", enhancement: { engine: "bing" } });
  const untouched = await searchWeb(fetcher, { query: "新游戏 上线" });
  assert.deepEqual(plain, untouched, "没配引擎时两条路得一模一样");
  assert.equal(plain.engine, "bing");
});

test("没真发出去的请求不算额度", async () => {
  const result = await searchWeb(null, { query: "新游戏上线", enhancement: { engine: "deepseek", keys: { deepseek: "sk-ds" } } });
  assert.equal(result.ok, false);
  assert.equal(result.usedEnhanced, false, "一个包都没发出去");
  assert.equal(result.enhancedCalls, 0);
});

test("用量按自然月记，跨月另起一格", () => {
  const october = recordSearchUsage({}, new Date("2026-10-20T06:00:00Z"));
  assert.equal(october["2026-10"], 1);
  const later = recordSearchUsage(october, new Date("2026-11-01T06:00:00Z"));
  assert.equal(later["2026-10"], 1);
  assert.equal(later["2026-11"], 1);
  assert.equal(usageCount(later, new Date("2026-11-05T00:00:00Z")), 1);
  assert.equal(usageCount(later, new Date("2026-12-05T00:00:00Z")), 0, "没用过的月份是 0");
  assert.equal(usageMonth(new Date("2026-10-20T06:00:00Z")), "2026-10");
});

test("宿主得放这些域名出去，不然请求出不了门", () => {
  for (const host of ["api.tavily.com", "api.deepseek.com", "google.serper.dev", "api.search.brave.com", "api.anysearch.com"]) {
    assert.ok(manifest.network?.allowedHosts?.includes(host), `manifest 得允许 ${host}`);
  }
  assert.ok(manifest.network?.methods?.includes("POST"));
  assert.ok(manifest.network?.methods?.includes("GET"), "Brave 走 GET");
});

test("设置页的引擎清单与 Key 框得跟着下拉走", () => {
  assert.match(settingsHtml, /id="search-engine-key-field"/, "得有 Key 那一栏");
  assert.match(settingsHtml, /id="search-engine-key-label"/, "Key 那一栏的标题要能改");
  assert.match(settingsHtml, /searchEditId = id;/, "点某一行就切到那一家填 Key");
  assert.match(settingsHtml, /settings\/search-engine\/test/, "页面要调测试路由");
  assert.doesNotMatch(settingsHtml, /id="search-engine-key"[^>]*tvly-/, "别把某一家的 Key 写死在页面上");
});

test("Key 存好之后切走再切回来，页面不能又显示成没填", () => {
  // 旧写法把 change 处理器绑在 paintSearchEngine 内部的闭包里，攥着「第一次绘制」那版 engines；
  // 那时 Key 还没存，hasKey 是 false，于是存好之后切回这家仍显示没填（2026-10-20 实机反馈）。
  const paintAt = settingsHtml.indexOf("function paintSearchEngine()");
  const refreshAt = settingsHtml.indexOf("function refreshSearchKeyField()");
  assert.ok(paintAt > -1 && refreshAt > -1, "两个函数都得在");
  assert.ok(refreshAt < paintAt, "刷新函数要放外面：处理器读最新快照，不攥画那一刻的闭包");
  assert.match(settingsHtml, /searchEngineSnapshot\.engines = engines/, "每次重绘要把最新引擎快照推给处理器");
  assert.match(settingsHtml, /Key 已经存好/, "状态那一行得直说她填的 Key 存好了");
  assert.match(settingsHtml, /id="search-engine-key-badge"/, "已保存得有一枚常驻标记，不能只靠两秒就散的 toast");
});

test("设置页的内联脚本还是合法模块", () => {
  const script = settingsHtml.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1] ?? "";
  assert.ok(script.length > 0, "得能找到那段内联模块");
  const dir = mkdtempSync(path.join(os.tmpdir(), "chahuahui-settings-"));
  const file = path.join(dir, "settings-inline.mjs");
  try {
    writeFileSync(file, script, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `内联模块语法不能坏：${result.stderr || ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行中撞上 401 也要把状态记下来，否则熔断上不了膛", () => {
  assert.match(appSource, /function markSearchEngineFailed\(reason, engine/, "得有把失败记成状态的入口");
  // 链上可能同时有几家挂：要逐家记，不能只记一家。
  assert.match(appSource, /function bookSearchOutcome\(search\)/, "得有一处统一的搜索记账（用量 + 故障状态）");
  assert.match(appSource, /for \(const failure of Array\.isArray\(search\.failures\)/, "按 failures 逐家看");
  assert.match(appSource, /markSearchEngineFailed\(failure\.reason, failure\.engine\)/, "聊天链路里看到鉴权/额度类失败就要记状态");
  assert.match(appSource, /bookSearchOutcome\(chatSearch\);/, "聊天链路要走这套记账");
  assert.match(appSource, /enhancedEngine: chatSearch\.enhancedEngine \?\? null/, "诊断里也要带上是哪一家");
  assert.match(chatSearchSource, /enhancedEngine: lastEnhancedEngine/, "搜索层要把是哪一家带出来");
});

test("搜索设置不走通用那条路：少一条可能明文落盘的口子", () => {
  assert.match(appSource, /if \(globalPatch\.searchEnhancement\) \{/, "通用路由要明确拒绝改搜索设置");
  assert.doesNotMatch(appSource, /globalPatch\.searchEnhancement\.apiKey/, "通用路由不许碰搜索 Key");
  assert.match(appSource, /await protectKey\(plain\)/, "专用路由要加密");
});

// ── 按顺序降级（2026-10-20）──────────────────────────────────

const bingXml = `<?xml version="1.0"?><rss><channel><item><title>新游戏上线消息</title><link>https://example.com/a</link><description>新版本上线时间</description><pubDate>Sat, 18 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>`;
const dsRows = { ok: true, async json() { return { results: [{ title: "DeepSeek V4 发布", url: "https://example.com/ds", summary: "长摘要" }] }; } };

function hostOf(call) {
  return new URL(String(call.url)).host;
}

test("首选不顺时按她排的顺序往下试，不是直接掉回默认搜索", async () => {
  const { fetcher, seen } = recordingFetcher({
    "tavily.com": { ok: false, status: 401 },
    "deepseek.com": dsRows,
    "bing.com": { ok: true, async text() { return bingXml; } },
  });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "tavily", backups: ["deepseek"], keys: { tavily: "tvly-a", deepseek: "sk-b" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "deepseek", "第二家接上了");
  assert.deepEqual(seen.calls.map(hostOf), ["api.tavily.com", "api.deepseek.com"], "按顺序试，没去碰必应");
  assert.equal(result.enhancedCalls, 2, "两个包都真发出去了，额度就得记两笔");
  assert.deepEqual(result.calls.map((call) => call.engine), ["tavily", "deepseek"]);
  assert.equal(result.failures[0].engine, "tavily");
  assert.equal(result.fallbackReason, "http-401", "掉下来的原因得留着，熔断靠它上膛");
});

test("没填 Key 的备选只是跳过，不算故障、也不发请求", async () => {
  const { fetcher, seen } = recordingFetcher({
    "tavily.com": { ok: false, status: 401 },
    "brave.com": { ok: true, async json() { return { web: { results: [] } }; } },
    "bing.com": { ok: true, async text() { return bingXml; } },
  });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "tavily", backups: ["brave"], keys: { tavily: "tvly-a" } },
  });
  assert.equal(seen.calls.filter((call) => call.url.includes("brave")).length, 0, "没 Key 就别发");
  assert.equal(result.failures.some((row) => row.engine === "brave"), false, "没准备好不是故障，不能给人家记上一笔");
  assert.equal(result.engine, "bing");
});

test("冷却中的那家跳级，后面的备选照常接", async () => {
  const { fetcher, seen } = recordingFetcher({ "deepseek.com": dsRows });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: {
      engine: "tavily",
      backups: ["deepseek"],
      keys: { tavily: "tvly-a", deepseek: "sk-b" },
      states: { tavily: { status: "failed", error: "搜索服务没接上（http-401）" } },
    },
  });
  assert.equal(seen.calls.filter((call) => call.url.includes("tavily")).length, 0, "别白等一次超时");
  assert.equal(result.engine, "deepseek");
  assert.equal(result.failures[0].reason, "engine-disabled");
});

test("它说这个角度没东西时，不拿别家付费再问一遍", async () => {
  const { fetcher, seen } = recordingFetcher({
    "tavily.com": { ok: true, async json() { return { results: [] }; } },
    "deepseek.com": dsRows,
    "bing.com": { ok: true, async text() { return bingXml; } },
  });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "tavily", backups: ["deepseek"], keys: { tavily: "tvly-a", deepseek: "sk-b" } },
  });
  assert.equal(seen.calls.filter((call) => call.url.includes("deepseek")).length, 0, "没结果不是故障，不为质量再掴一次钱");
  assert.equal(result.enhancedCalls, 1);
  assert.equal(result.engine, "bing");
});

test("一次回复的付费次数到顶，后面的就只走免费的", async () => {
  const { fetcher, seen } = recordingFetcher({
    "tavily.com": { ok: false, status: 401 },
    "deepseek.com": dsRows,
    "bing.com": { ok: true, async text() { return bingXml; } },
  });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "tavily", backups: ["deepseek"], keys: { tavily: "tvly-a", deepseek: "sk-b" } },
    session: createSearchSession({ paidBudget: 1 }),
  });
  assert.equal(seen.calls.filter((call) => call.url.includes("deepseek")).length, 0, "预算没了就别再掴");
  assert.equal(result.failures.some((row) => row.reason === "search-budget-spent"), true);
  assert.equal(result.engine, "bing");
});

test("总时间用尽就不再往下发请求，但免费穴底照走", async () => {
  let now = 1_000_000;
  const book = createSearchSession({ totalMs: 1000, clock: () => now });
  now += 5000;
  const { fetcher, seen } = recordingFetcher({ "bing.com": { ok: true, async text() { return bingXml; } } });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { engine: "tavily", backups: ["deepseek"], keys: { tavily: "tvly-a", deepseek: "sk-b" } },
    session: book,
  });
  assert.equal(seen.calls.filter((call) => !call.url.includes("bing")).length, 0, "一个付费包都别发");
  assert.equal(result.failures[0].reason, "search-out-of-time");
  assert.equal(result.engine, "bing");
});

test("默认搜索也能排在第一位：轮到它就真走它，后面那家不动", async () => {
  const { fetcher, seen } = recordingFetcher({ "bing.com": { ok: true, async text() { return bingXml; } }, "deepseek.com": dsRows });
  const result = await searchWeb(fetcher, {
    query: "新游戏上线",
    enhancement: { order: ["bing", "deepseek"], keys: { deepseek: "sk-b" } },
  });
  assert.equal(result.engine, "bing");
  assert.equal(seen.calls.filter((call) => call.url.includes("deepseek")).length, 0, "第一家就给了，不再问下一家");
});

test("搜索顺序归一：认得的、不重复，且一定带默认搜索", () => {
  assert.deepEqual(normalizeSearchOrder(["tavily", "tavily", "google", "deepseek"]), ["tavily", "deepseek", "bing"], "没排默认搜索就自动兜在最后");
  assert.deepEqual(normalizeSearchOrder(["bing", "tavily"]), ["bing", "tavily"], "她真把默认搜索排第一，就按她的来");
  assert.deepEqual(normalizeSearchOrder([]), ["bing"]);
  // 老数据：单个 engine + backups 自动搬成一条顺序，搬过之后就只认 order
  const legacy = normalizeSearchEnhancement({ engine: "tavily", backups: ["deepseek"] });
  assert.deepEqual(legacy.order, ["tavily", "deepseek", "bing"]);
  assert.equal(legacy.engine, "tavily", "兼容字段跟 order[0] 一致");
  assert.deepEqual(
    normalizeSearchEnhancement({ order: ["deepseek", "tavily"], engine: "brave" }).order,
    ["deepseek", "tavily", "bing"],
    "order 在就以 order 为准，不被旧 engine 带偏",
  );
});

test("一条回复里三个候选共用一份预算，不是每个候选各来一次", async () => {
  const { fetcher, seen } = recordingFetcher({
    "tavily.com": { ok: false, status: 401 },
    "bing.com": { ok: true, async text() { return bingXml; } },
  });
  const result = await searchForChat({
    text: "最近有什么新游戏更新？",
    ask: async () => JSON.stringify({ searchQuery: "新游戏 上线 更新", searchQueryAlt: "新游戏 最新版本 更新" }),
    fetcher,
    enhancement: { engine: "tavily", backups: ["deepseek"], keys: { tavily: "tvly-a", deepseek: "sk-b" } },
    session: createSearchSession({ paidBudget: 1 }),
    now: new Date("2026-10-18T06:00:00Z"),
  });
  assert.equal(seen.calls.filter((call) => call.url.includes("tavily")).length, 1, "只付一次");
  assert.equal(seen.calls.filter((call) => call.url.includes("deepseek")).length, 0, "预算给完了，后面的候选不再掏");
  assert.equal(result.enhancedCalls, 1);
});

test("设置页能排搜索顺序，保存时把顺序一起发上去", () => {
  assert.match(settingsHtml, /id="search-order-list"/, "得有顺序列表");
  assert.match(settingsHtml, /function paintSearchOrder\(\)/, "顺序得能重画");
  assert.match(settingsHtml, /order: searchDraftOrder\(\)/, "保存要带上顺序");
  assert.match(appSource, /order: normalizeSearchOrder\(/, "回包里要带顺序");
});

test("页面能自己证明它是旧的；不旧时那一行不露头", () => {
  // 上一版的“版本戳”是后端算的：页面旧了它照样显示新值，等于没测。
  assert.match(settingsHtml, /const UI_BUILD = "[^"]+"/, "页面得带一个写死的版本号");
  assert.match(appSource, /function settingsUiBuild\(\)/, "后端得从同一个文件里读它");
  assert.match(appSource, /settingsUiBuild: settingsUiBuild\(\)/, "回包里要带上");
  assert.match(settingsHtml, /serverBuild === UI_BUILD/, "页面要拿它跟后端比");
  assert.match(settingsHtml, /id="ui-stamp-warn"/, "页面自己发现旧了要明说，别让她猜");
  // 2026-10-22：平时不摆版本哈希和刷新链，那一行只在真旧了才露；哈希那套已经撤掉。
  assert.match(settingsHtml, /<p class="ui-stamp" id="ui-stamp" hidden>/, "默认整行隐身");
  assert.match(settingsHtml, /stampLine\.hidden = !serverBuild \|\| serverBuild === UI_BUILD/, "对得上就不显示");
  assert.doesNotMatch(settingsHtml, /设置页版本：/);
  assert.doesNotMatch(appSource, /settingsUiStamp/, "后端那个没人看的哈希一并拆了");
});

test("搜索顺序只有一份：第一家就是现在走的那家，默认搜索移不掉", () => {
  assert.match(settingsHtml, /order: searchDraftOrder\(\), keyEngine: chosen/, "保存要带上顺序和正在填的那家");
  assert.match(settingsHtml, /if \(id !== "bing"\)/, "默认搜索那行得特殊对待（不给移除）");
  assert.match(settingsHtml, /searchEditId = id;/, "点某一行就切到那一家填 Key");
  assert.match(settingsHtml, /searchEngineShortName/, "列表里只摆名字，不拿长描述占地方");
  assert.doesNotMatch(settingsHtml, /id="search-engine-host"/, "旧下拉框该退了：两处控制同一件事只会更绕");
  assert.doesNotMatch(settingsHtml, /searchBackupDraft/, "别再让“首选 / 备选”两套概念混着用");
});

test("打开搜索栏，Key 那一栏不能一上来就隐着", () => {
  // 实机反馈：默认指着“默认搜索”而它是无 Key 那家，Key 输入框整块隐起来，看着像配置项没了。
  assert.doesNotMatch(settingsHtml, /let searchEditId = "bing"/, "默认目标不能写死成默认搜索");
  assert.match(settingsHtml, /if \(!searchEditId \|\| !engines\.some/, "第一次进来要指着顺序第一行");
});
