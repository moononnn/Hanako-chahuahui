/**
 * 主动图片饥饿（2026-11-20 实机：15 条主动零附件，其中 7 条被视频整轮挤掉）。
 *
 * 这一轮要钉住的是「照片优先机会」的边界：
 * 1. 视频占着这一轮时，照片能按低频机会插一次队，且视频候选不被吃掉（下一轮照发）；
 * 2. 机会有间隔，刚用过就不再抢视频；
 * 3. 没有照片语境、生图额度用完、安静时段，都不越线；
 * 4. 插队之后这一轮仍是普通主动：模型不出图就按普通文字，不花生图额度。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { addVideoCandidate, makeVideoCandidate } from "../lib/video-sharing.js";
import { dateKey } from "../lib/clock.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花，不出现人物","self":false}]';
/** 城市插画必须由角色参考照出图（self:true）；普通生活照也用它比参考图数量。 */
const PHOTO_SELF = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花","self":true}]';
const VIDEO_LINK = "https://www.bilibili.com/video/BV1bXt9z9ESP?p=2";
const VIDEO_TEXT = "这个半岛铁盒的石膏模具我看完了，边缘收得挺干净。";
const time = ms => new Date(Date.now() + ms).toISOString();

/** 池子里躺着的待发视频：只是被看一眼，没标记就还在。 */
function seedVideo(store) {
  store.saveVideoBook(AGENT, addVideoCandidate(store.getVideoBook(AGENT), makeVideoCandidate({
    readKind: "subtitle",
    video: { bvid: "BV1bXt9z9ESP", aid: 123, cid: 456, page: 2, duration: 100,
      title: "半岛铁盒制作", author: "手作频道", desc: "石膏制作教程", link: VIDEO_LINK },
    subtitle: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "半岛铁盒用石膏浇筑，泡沫板做模具。" })),
  }, { interest: { id: "craft", name: "手作" }, plan: { focus: "半岛铁盒制作", searchQuery: "石膏手作" } })));
}

async function boot(t, {
  answer = PHOTO, photoOpportunityAt = null, imageTier = "normal", partnerImageTier = "normal",
  context = true, video = true, quotaSpent = 0, asleep = false, illustration = false,
} = {}) {
  const mediaCalls = [], prompts = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    const now = new Date();
    const sleepStart = `${String((now.getHours() + 23) % 24).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({
      rhythmProactiveEnabled: true, imageTier, quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) },
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      ...(video ? { videoShareMaxPerDay: 1 } : {}),
      // 城市插画：独立的两个开关都打开，且手上真有一份合格的同城来源。
      ...(illustration ? { lifeCity: "成都", lifeCityCode: "city-test-code", lifeCityDiscoveries: true, lifeCityIllustrations: true } : {}),
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
    });
    store.setPartnerSettings(AGENT, {
      proactiveEnabled: true, tier: "often", imageTier: partnerImageTier,
      model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: time(0),
      // 睡着的时候整轮都不该开口，照片机会也不例外。
      sleep: { shape: 2, start: asleep ? sleepStart : clock(far.getHours()), hours: asleep ? 7 : 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } },
      voice: { enabled: false }, ...(video ? { videoSharingEnabled: true } : {}),
    });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing,
      personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } },
      relationship: { ...knowing.relationship,
        familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 },
        intimacy: { ...knowing.relationship.intimacy, score: 18 } },
      worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, {
      nextDueAt: time(-HOUR), lastSentAt: time(-HOUR),
      interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } },
      topicSeeds: { lastGrowAt: time(0), seeds: [] },
      // 新闻刚取过料、池子也空：这一轮不去搜，省得用例里多出一次网络动作。
      newsBook: illustration
        ? { lastFetchAt: time(0), lastDomainId: "", history: [], items: [{
          id: "local_fixture", domainId: "local-city", domainName: "同城发现",
          localCity: "成都", localCityCode: "city-test-code",
          title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。",
          url: "https://example.org/chengdu/lanes", publishedAt: time(0), createdAt: time(0),
          expiresAt: time(24 * HOUR), sharedAt: time(0),
        }] }
        : { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] },
      ...(photoOpportunityAt ? { photoOpportunity: { at: photoOpportunityAt } } : {}),
    });
    if (context) {
      store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: time(-2 * HOUR) });
      store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    }
    if (video) seedVideo(store);
    if (quotaSpent) {
      // 额度账本在 apply 之前就落盘，createImageQuota 读到的就是扣过的账。
      const file = path.join(ctx.dataDir, "v2", "image-quota.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ entries: Array.from({ length: quotaSpent }, (_, i) => ({
        id: `quota_${i}`, agentId: AGENT, day: dateKey(new Date()), status: "success",
      })) }));
    }
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.answer(req => { prompts.push(req); return true; }, answer);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  const tick = async (randomValue = 0.99) => {
    const random = Math.random;
    Math.random = () => randomValue;
    try { return await app.request("POST", "/proactive/tick", { json: {} }); }
    finally { Math.random = random; }
  };
  const diagnostics = () => fs.readFileSync(path.join(app.dataDir, "v2", "diagnostics.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const videoBook = () => JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "partners", AGENT, "memory.json"), "utf8")).videoSharing;
  return { ...app, mediaCalls, prompts, tick, diagnostics, videoBook, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}

test("视频占着这一轮时，照片按低频机会插一次队，视频候选不吃掉", OPTIONS, async t => {
  const app = await boot(t);
  // 低随机值：机会（0.35）抽中，档位概率也抽中。
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(app.diagnostics().slice(-6)));
  const [photo] = app.photos();
  assert.ok(photo, "这一轮应该是一张照片");
  assert.equal(photo.photoScene.source, "scene");
  assert.equal(photo.videoId, undefined, "插队之后这一轮不再是视频");
  const rows = app.diagnostics();
  assert.ok(rows.some(row => row.event === "proactive.photo.opportunity" && row.releasedVideo === true));
  // 视频候选只是被看一眼：没标记、没算分享，下一轮还在。
  const book = app.videoBook();
  assert.equal(book.pending.length, 1);
  assert.equal(book.shares.length, 0);
  // 机会限频记账落在既有主动状态里，不新开设置项。
  const state = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "state.json"), "utf8"));
  assert.ok(state.runtime.partners[AGENT].photoOpportunity?.at);
});

test("优先机会有间隔：刚用过就不抢视频，视频照常发", OPTIONS, async t => {
  const app = await boot(t, { answer: VIDEO_TEXT, photoOpportunityAt: time(-1 * HOUR) });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0);
  const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].videoId, "BV1bXt9z9ESP:2", JSON.stringify(sent[0]).slice(0, 400));
  assert.ok(String(sent[0].text).includes(VIDEO_LINK), "视频这一轮该怎么发还怎么发");
  const book = app.videoBook();
  assert.equal(book.shares.length, 1);
  assert.equal(book.pending.length, 0);
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.opportunity"), false);
});

test("没有照片语境时不抢视频：普通主动照常走视频", OPTIONS, async t => {
  const app = await boot(t, { answer: VIDEO_TEXT, context: false });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0);
  assert.ok(reopenThread(app.dataDir, AGENT).some(row => row.proactive && row.videoId));
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.opportunity"), false);
});

test("生图额度用完时不抢视频，也不花生图", OPTIONS, async t => {
  // 伙伴档位 normal 的额度是 2，先记满。
  const app = await boot(t, { answer: VIDEO_TEXT, quotaSpent: 2 });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0);
  assert.ok(reopenThread(app.dataDir, AGENT).some(row => row.proactive && row.videoId));
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.opportunity"), false);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 2, "额度账没被插队改写");
});

test("安静时段里机会也不开口：这一轮整条拦住，视频候选留着", OPTIONS, async t => {
  const app = await boot(t, { answer: VIDEO_TEXT, asleep: true });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.opportunity"), false);
  const book = app.videoBook();
  assert.equal(book.pending.length, 1, "没发出去的候选还在池子里");
});

test("有合格同城来源时插队这一轮画成城市插画，没材料仍走普通图", OPTIONS, async t => {
  for (const illustration of [true, false]) {
    await t.test(illustration ? "city-illustration" : "scene", async t => {
      const app = await boot(t, { illustration, answer: PHOTO_SELF });
      const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
      await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
      await app.tick(0.1);
      assert.equal(app.mediaCalls.length, 1, JSON.stringify(app.diagnostics().filter(row => /photo|proactive|video/.test(String(row.event)))));
      const [photo] = app.photos();
      assert.ok(photo);
      assert.equal(photo.photoScene.source, illustration ? "city-illustration" : "scene");
      // 不管画不画插画，都只传当前角色参考照这一张图，不比普通自拍多传素材。
      assert.equal(app.mediaCalls[0].input.referenceImages.length, 1);
    });
  }
});

test("插队之后模型仍可放弃：明确拒绝出图就当普通主动发，不花生图额度", OPTIONS, async t => {
  // 2026-11-23：自然文字会被漏标记兜底接住；“放弃”的语义是明确拒绝（见 photo-fallback.test.js）。
  const app = await boot(t, { answer: "今天就不发图了，窗边坐了一会儿，杯子还是原来那个。" });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0);
  const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1, "放弃出图不等于这一轮不发");
  assert.equal(sent[0].attachment, undefined);
  assert.equal(sent[0].photoScene, undefined);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0);
  assert.equal(usage.partnerPending, 0);
});

test("优先机会不新开设置、不新开定时器、不碰网络", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /pickPhotoOpportunity\(\{/);
  // 只在既有 tick 里做决定：没有新路由、没有新定时器、没有新网络出口。
  assert.doesNotMatch(source, /setInterval\([^)]*photoOpportunity/u);
  assert.doesNotMatch(source, /fetch\([^)]*photoOpportunity/u);
  const lib = fs.readFileSync(new URL("../lib/chat-image.js", import.meta.url), "utf8");
  assert.match(lib, /export const PHOTO_OPPORTUNITY_CHANCE = 0\.35;/);
  assert.match(lib, /export const PHOTO_OPPORTUNITY_GAP_MS = 8 \* 60 \* 60_000;/);
  assert.doesNotMatch(lib, /fetch\(/u, "照片这一层始终不联网");
});
