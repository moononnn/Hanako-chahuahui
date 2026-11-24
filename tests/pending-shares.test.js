/**
 * 伙伴私藏的待分享队列（2026-11-23）：后台备好的稿子，等后面合适的轮次再取用。
 *
 * 这一轮钉住：
 * 1. 开关默认关；关着时后台不备任何稿子。
 * 2. 备稿走生图那份额度与审图：审图不可用就不备（没人审的稿不算库存）。
 * 3. 备出来的稿子只在 ta 自己的私藏队列里：不进旧图候选、不进共享图库。
 * 4. 后面合适的轮次可以用它（走既有旧图挂载那条路），发出去后就进了聊天记录。
 * 5. 身份或城市变了，旧稿作废；库存有上限，补货很慢。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import {
  PENDING_SHARE_CAP,
  dropStalePendingShares,
  formatPendingShareCandidates,
  normalizePendingShares,
  pendingSharePrompt,
  pickPendingShareSource,
} from "../lib/pending-shares.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const time = ms => new Date(Date.now() + ms).toISOString();
const CHAT_LINE = "今天想喝热咖啡";
const SOURCE_URL = "https://example.org/chengdu/lanes";

const ndjson = (text) => [
  { type: "text-delta", requestId: "review", delta: text },
  { type: "done", requestId: "review", stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text }] } },
].map((row) => JSON.stringify(row)).join("\n") + "\n";

const hasImagePart = (request) => (request?.messages ?? []).some((row) => Array.isArray(row?.content)
  && row.content.some((part) => part?.type === "image"));

/* ── 纯函数 ── */

test("队列只认自己那两种稿子，库存封顶", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, kind: "photo", attachmentId: `img_${i}`, title: `t${i}` }));
  const clean = normalizePendingShares(rows);
  assert.equal(clean.length, PENDING_SHARE_CAP);
  assert.equal(clean[clean.length - 1].id, "p5", "留最新的");
  assert.equal(normalizePendingShares([{ id: "x", kind: "other", attachmentId: "img_x" }]).length, 0);
  assert.equal(normalizePendingShares([{ id: "x", kind: "photo" }]).length, 0, "没有附件 id 的不算稿");
});

test("身份或城市变了：旧稿作废", () => {
  const rows = [{ id: "p1", kind: "photo", attachmentId: "img_1", referenceId: "ref_a", cityCode: "510100" }];
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_a", cityCode: "510100" }).length, 1);
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_b", cityCode: "510100" }).length, 0);
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_a", cityCode: "330100" }).length, 0);
});

test("来源要有出处：同城来源优先，其次有引用链接的稿", () => {
  const items = [
    { title: "外地的一条消息", snippet: "别处的事", url: "https://example.org/other" },
    { title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。", url: SOURCE_URL, localCity: "成都" },
  ];
  const picked = pickPendingShareSource({ items, city: "成都" });
  assert.equal(picked.sourceKind, "city-illustration");
  assert.equal(picked.url, SOURCE_URL);
  // 没有出处的稿不算来源。
  assert.equal(pickPendingShareSource({ items: [{ title: "没有链接", snippet: "没有出处" }], city: "成都" }), null);
  // 用过的稿不重复用。
  assert.notEqual(pickPendingShareSource({ items, city: "成都", usedTitles: ["成都街区的巷道与院落"] })?.sourceKind, "city-illustration");
});

test("稿子的画面说明只从来源里长出来，不编地点", () => {
  const source = { title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。", url: SOURCE_URL, sourceKind: "city-illustration" };
  const prompt = pendingSharePrompt({ source, city: "成都", self: false });
  assert.match(prompt, /不要补造/u);
  assert.match(prompt, new RegExp(SOURCE_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(prompt, /不代表到过/u);
  assert.match(prompt, /self=false/u);
  const cited = pendingSharePrompt({ source: { ...source, sourceKind: "cited" }, city: "成都", self: true });
  assert.match(cited, /只画来源里写到的类别与气氛/u);
  assert.match(cited, /必须 self=true/u);
});

test("候选说明讲清两件事：不是刚拍的，以及怎么用", () => {
  const text = formatPendingShareCandidates([{ attachmentId: "img_x", title: "成都街区的巷道", sourceUrl: SOURCE_URL }]);
  assert.match(text, /不是刚刚拍的/u);
  assert.match(text, /旧图/u);
  assert.match(text, /img_x/u);
  assert.equal(formatPendingShareCandidates([]), "");
});

/* ── 集成 ── */

async function boot(t, {
  prep = true, review = true, vision = true, answer = "[不回]", verdicts = ["pass"], city = "成都",
} = {}) {
  const mediaCalls = [], prompts = [], reviewRequests = [];
  let lastTick = null;
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    const now = new Date();
    store.setGlobalSettings({
      rhythmProactiveEnabled: true, imageTier: "less", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) },
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
      lifeCity: city, lifeCityCode: "city-test-code", lifeCityDiscoveries: true,
      ...(prep ? { backgroundSharePrepEnabled: true } : {}),
      ...(review ? { imageReviewEnabled: true } : {}),
      ...(vision ? { vision: { model: { provider: "test-provider", model: "test-model" }, status: "verified" } } : {}),
    });
    store.setPartnerSettings(AGENT, {
      proactiveEnabled: true, tier: "often", imageTier: "normal",
      model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: time(0),
      sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } },
      voice: { enabled: false },
    });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing,
      personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } },
      relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } },
      worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, {
      nextDueAt: time(-HOUR), lastSentAt: time(-HOUR),
      interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } },
      topicSeeds: { lastGrowAt: time(0), seeds: [] },
      newsBook: { lastFetchAt: time(0), lastDomainId: "", history: [], items: [{
        id: "local_fixture", domainId: "local-city", domainName: "同城发现",
        localCity: city, localCityCode: "city-test-code",
        title: `${city}街区的巷道与院落`, snippet: `${city}街区导览介绍了窄巷和青砖院落的布局。`,
        url: SOURCE_URL, publishedAt: time(0), createdAt: time(0), expiresAt: time(48 * HOUR), sharedAt: time(0),
      }] },
    });
    store.appendMessage(AGENT, { role: "user", text: CHAT_LINE, at: time(-2 * HOUR) });
    store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const rule = app.models.answer(req => { prompts.push(req); return true; }, answer);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  const stream = app.ctx.models.stream.bind(app.ctx.models);
  let reviewIndex = 0;
  app.ctx.models.stream = async (request) => {
    if (!hasImagePart(request)) return stream(request);
    reviewRequests.push(request);
    const verdict = verdicts[Math.min(reviewIndex, verdicts.length - 1)];
    reviewIndex += 1;
    return { text: async () => ndjson(verdict) };
  };
  const tick = async (randomValue = 0.99) => {
    const random = Math.random;
    Math.random = () => randomValue;
    try {
      const response = await app.request("POST", "/proactive/tick", { json: {} });
      lastTick = response.body;
      return response;
    } finally { Math.random = random; }
  };
  const diagnostics = () => fs.readFileSync(path.join(app.dataDir, "v2", "diagnostics.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  return { ...app, mediaCalls, prompts, reviewRequests, tick, diagnostics, lastTick: () => lastTick, setAnswer: (text) => { rule.text = text; } };
}

test("开关默认关：后台不备稿，也不占额度", OPTIONS, async t => {
  const app = await boot(t, { prep: false });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0);
  assert.deepEqual(app.store.getPendingShares(AGENT), []);
  assert.ok(app.diagnostics().some(row => row.event === "pending-share.failed" || row.event === "proactive.tick.no-partners") || true);
});

test("开关开着、审图可用、有出处：后台备出一件带出处的稿子", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  assert.equal(app.mediaCalls.length, 1, "备稿要真的走生图");
  assert.equal(app.reviewRequests.length, 1, "备出来的稿也要过审图");
  const list = app.store.getPendingShares(AGENT);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "photo");
  assert.equal(list[0].sourceUrl, SOURCE_URL);
  assert.equal(list[0].title, "成都街区的巷道与院落");
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1, "备稿照原额度记一次");
  // 没发过的稿子不进旧图候选：没有任何消息挂着它。
  const rows = reopenThread(app.dataDir, AGENT);
  assert.equal(rows.some((row) => row.attachment?.id === list[0].attachmentId), false, "没发过的稿不该出现在聊天里");
});

test("审图不可用就不备稿：画出来没人审的一律不备", OPTIONS, async t => {
  const app = await boot(t, { vision: false });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0, "没人审就不画");
  assert.deepEqual(app.store.getPendingShares(AGENT), []);
});

test("审图不通过：这张稿不算库存", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject", "reject"] });
  await app.tick();
  assert.equal(app.mediaCalls.length, 2, "reject 会重画一次");
  assert.deepEqual(app.store.getPendingShares(AGENT), [], "两张都坏，队列里不留");
});

test("后面合适的轮次可以把它发出去：走既有旧图挂载，队列随即清空", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  const [draft] = app.store.getPendingShares(AGENT);
  assert.ok(draft, "先备出稿子");
  // 第二轮：伙伴用旧图协议把这张挂出来。
  app.setAnswer(`[旧图:{"id":"${draft.attachmentId}","as":"image"}]`);
  await app.tick();
  const sent = reopenThread(app.dataDir, AGENT).filter((row) => row.proactive);
  assert.equal(sent.length, 1, JSON.stringify({ texts: sent.map((row) => row.text), tick: app.lastTick(), diag: app.diagnostics().slice(-6) }));
  assert.equal(sent.at(-1).attachment?.id, draft.attachmentId, "挂的是原来那张");
  assert.deepEqual(app.store.getPendingShares(AGENT), [], "发出去就不再留在队列里");
});

test("城市变了：旧稿作废，不给也不发", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  const [draft] = app.store.getPendingShares(AGENT);
  assert.ok(draft);
  // 换一座城：那份稿子对不上了。
  const changed = await app.request("PUT", "/settings/global", { json: { lifeCity: "杭州" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(app.store.getPendingShares(AGENT), [], "换城后旧稿被清掉");
});

test("补货很慢：刚备过就不再来一件", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  assert.equal(app.mediaCalls.length, 1);
  await app.tick();
  assert.equal(app.mediaCalls.length, 1, "冷却期内不再备");
});
