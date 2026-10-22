import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui } from "./helpers/app-harness.js";
import { isProtectedKey } from "../lib/crypto.js";
import { createStore } from "../lib/store.js";
import { searchForChat } from "../lib/chat-search.js";

const TAVILY_ROWS = [{ title: "某新款游戏上线日期公布", url: "https://example.com/game", content: "官方宣布新版本上线时间", published_date: "2026-10-18" }];
const DEEPSEEK_ROWS = [{ title: "DeepSeek V4 发布", url: "https://example.com/ds", snippet: "短摘要", summary: "给模型读的长摘要", date: "2026-10-19T05:41:50.168Z" }];

/** 重新开一个账本实例读回：证明写进去的是文件里的东西，不是某个实例的内存残留。 */
function readBack(app) {
  return createStore(app.dataDir).getGlobalSettings().searchEnhancement;
}

/** 会话搜索里那些候选：按引擎分派的假 fetcher。 */
function engineFetcher({ failEngines = [], rows = DEEPSEEK_ROWS } = {}) {
  const seen = { urls: [] };
  const fetcher = async (url) => {
    seen.urls.push(String(url));
    if (String(url).includes("deepseek.com")) {
      if (failEngines.includes("deepseek")) return { ok: false, status: 401 };
      return { ok: true, async json() { return { results: rows }; } };
    }
    if (String(url).includes("tavily.com")) {
      if (failEngines.includes("tavily")) return { ok: false, status: 401 };
      return { ok: true, async json() { return { results: TAVILY_ROWS }; } };
    }
    return { ok: true, async text() { return ""; } };
  };
  return { fetcher, seen };
}

test("保存搜索引擎设置：Key 存的是密文，回包里没有明文", async () => {
  const app = await bootChahuahui();
  const res = await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-plain-key" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const view = res.body.global.searchEnhancement;
  assert.equal(view.engine, "deepseek");
  assert.equal(view.engines.find((item) => item.id === "deepseek").hasKey, true);
  assert.ok(!JSON.stringify(res.body).includes("sk-plain-key"), "回包里不能出现明文 Key");
  const stored = readBack(app);
  assert.equal(stored.keys.deepseek.includes("sk-plain-key"), false, "落盘的也不是明文");
  assert.equal(isProtectedKey(stored.keys.deepseek), true);
});

test("每家一把自己的 Key：换引擎不会把别家的弄丢", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "tavily", apiKey: "tvly-one" } });
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-two" } });
  const stored = readBack(app);
  assert.equal(stored.engine, "deepseek");
  assert.ok(stored.keys.tavily, "Tavily 那把要还在");
  assert.ok(stored.keys.deepseek, "DeepSeek 那把也要在");
  assert.equal(stored.keys.tavily.includes("tvly-one"), false, "两把都得是密文");
});

test("搜索顺序能存能回，落盘前先归一", async () => {
  const app = await bootChahuahui();
  const res = await app.request("POST", "/settings/search-engine", {
    json: { order: ["tavily", "tavily", "google", "deepseek"], keyEngine: "tavily", apiKey: "tvly-x" },
  });
  assert.equal(res.status, 200);
  const expected = ["tavily", "deepseek", "bing"];
  assert.deepEqual(res.body.global.searchEnhancement.order, expected, "回包里就是归一后的顺序（不认的剔掉、默认搜索兜在最后）");
  assert.deepEqual(readBack(app).order, expected, "写进文件的就是归一后的顺序");
  assert.ok(!JSON.stringify(res.body).includes("tvly-x"), "回包里不能出现明文 Key");
});

test("顺序和 Key 是两件事：换顺序不会把别家的 Key 弄丢，也不会改别人家的测试状态", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { order: ["tavily", "deepseek"], keyEngine: "tavily", apiKey: "tvly-x" } });
  await app.request("POST", "/settings/search-engine", { json: { order: ["tavily", "deepseek"], keyEngine: "deepseek", apiKey: "sk-y" } });
  // 只调顺序，不动任何 Key
  const res = await app.request("POST", "/settings/search-engine", { json: { order: ["deepseek", "tavily"] } });
  assert.deepEqual(res.body.global.searchEnhancement.order, ["deepseek", "tavily", "bing"]);
  assert.equal(res.body.global.searchEnhancement.engine, "deepseek", "兼容字段跟着 order[0] 走");
  const stored = readBack(app);
  assert.ok(stored.keys.tavily && stored.keys.deepseek, "两家的 Key 都还在");
  assert.equal(stored.order[0], "deepseek");
});

test("不填 Key 就保持已保存的那把，不动它", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "tavily", apiKey: "tvly-first" } });
  const res = await app.request("POST", "/settings/search-engine", { json: { engine: "tavily", apiKey: "" } });
  assert.equal(res.body.ok, true);
  assert.equal(readBack(app).keys.tavily.includes("tvly-first"), false);
  assert.equal(isProtectedKey(readBack(app).keys.tavily), true);
});

test("传「********」表示保持已保存的那把，不换", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "tavily", apiKey: "tvly-keep-me" } });
  const before = readBack(app).keys.tavily;
  await app.request("POST", "/settings/search-engine", { json: { engine: "tavily", apiKey: "********" } });
  assert.equal(readBack(app).keys.tavily, before, "掩码不该把已保存的 Key 抹掉");
});

test("换回默认搜索，Key 留着但不再用", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-one" } });
  const res = await app.request("POST", "/settings/search-engine", { json: { engine: "bing" } });
  assert.equal(res.body.global.searchEnhancement.engine, "bing");
  assert.equal(res.body.global.searchEnhancement.engines.find((item) => item.id === "deepseek").hasKey, true, "Key 不删，省得她回头再填一遍");
});

test("搜索设置不走通用那条路", async () => {
  const app = await bootChahuahui();
  const res = await app.request("PUT", "/settings/global", { json: { searchEnhancement: { engine: "tavily", apiKey: "tvly-global-plain" } } });
  assert.equal(res.status, 400, "通用路径不许改搜索设置");
  assert.ok(!JSON.stringify(res.body).includes("tvly-global-plain"));
  const stored = readBack(app);
  assert.equal(stored.keys?.tavily ?? "", "", "更不许明文落盘");
});

test("主动那页的响应里不能带出 Key", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-secret" } });
  const res = await app.request("GET", "/proactive");
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.body);
  assert.equal(body.includes("sk-secret"), false, "响应里不能出现明文 Key");
  assert.equal(res.body.global.searchEnhancement.keys, undefined, "这一包里只该有状态投影");
});

test("「测试一下」：真发一次请求，通了就记已验证，额度记一笔", async () => {
  const app = await bootChahuahui();
  // 先存下这把 Key：测已保存的那把，才轮得到改它的状态。
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-test" } });
  const pending = app.request("POST", "/settings/search-engine/test", { json: {} });
  await app.net.waitForCall(0);
  const call = app.net.calls[0];
  assert.equal(call.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer sk-test");
  app.net.release(0, { results: DEEPSEEK_ROWS });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.results, 1);
  assert.equal(res.body.global.searchEnhancement.states.deepseek.status, "verified");
  assert.equal(res.body.global.searchEnhancement.usageThisMonth, 1, "测试也算一次真实请求");
  assert.equal(res.body.global.searchEnhancement.usageByEngine.deepseek, 1);
});

test("「测试一下」：Key 不通要说清楚，不装作成功", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-bad" } });
  const pending = app.request("POST", "/settings/search-engine/test", { json: {} });
  await app.net.waitForCall(0);
  app.net.release(0, { error: "unauthorized" });
  const res = await pending;
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.global.searchEnhancement.states.deepseek.status, "failed");
});

test("用没保存的 Key 测，不许改已保存配置的状态", async () => {
  const app = await bootChahuahui();
  await app.request("POST", "/settings/search-engine", { json: { engine: "deepseek", apiKey: "sk-old" } });
  const pending = app.request("POST", "/settings/search-engine/test", { json: { apiKey: "sk-new-typing" } });
  await app.net.waitForCall(0);
  app.net.release(0, { results: DEEPSEEK_ROWS });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.usedSavedKey, false);
  assert.notEqual(readBack(app).states.deepseek?.status, "verified", "新 Key 测通了也不能说旧 Key 是通的");
});

test("没填 Key 就别测，先让她填", async () => {
  const app = await bootChahuahui();
  const res = await app.request("POST", "/settings/search-engine/test", { json: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Key/);
});

test("旧结构里那把明文 Key：迁移时必须加密，旧字段还得清掉", async () => {
  // seed 阶段就把旧结构写进磁盘，模拟「升级上来的用户」。
  const app = await bootChahuahui({ seed: (store) => {
    store.setGlobalSettings({ searchEnhancement: { engine: "tavily", apiKey: "tvly-plain-legacy" } });
  } });
  const res = await app.request("POST", "/settings/search-engine", { json: { engine: "tavily" } });
  assert.equal(res.status, 200);
  const stored = readBack(app);
  assert.ok(stored.keys?.tavily, "那把 Key 不能丢");
  assert.equal(stored.keys.tavily.includes("tvly-plain-legacy"), false, "落盘的必须是密文");
  assert.equal(isProtectedKey(stored.keys.tavily), true);
  assert.equal(stored.legacyApiKey ?? "", "", "旧字段要清掉，不能跟着每次写盘一直躺着");
});

test("这一家恒不通时，三个候选只试它一次：不会各等 8 秒", async () => {
  const { fetcher, seen } = engineFetcher({ failEngines: ["deepseek"] });
  const result = await searchForChat({
    text: "最近有什么新游戏更新？",
    ask: async () => JSON.stringify({ searchQuery: "新游戏 上线 更新", searchQueryAlt: "新游戏 最新版本 更新" }),
    fetcher,
    enhancement: { engine: "deepseek", keys: { deepseek: "sk-dead" } },
    now: new Date("2026-10-20T06:00:00Z"),
  });
  assert.equal(seen.urls.filter((url) => url.includes("deepseek.com")).length, 1, "这家只试一次");
  assert.equal(seen.urls.filter((url) => url.includes("bing.com")).length, 3, "后面的候选都走默认搜索");
  assert.equal(result.enhancedCalls, 1, "只发出去一个包");
  assert.equal(result.enhancedEngine, "deepseek");
  assert.match(String(result.fallbackReason), /http-401/, "失败原因要带上来，熔断才上得了膛");
});
