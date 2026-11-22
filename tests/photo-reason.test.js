/**
 * 由头照片（2026-11-23）：由头先站住，照片只是这一轮的表达方式。
 *
 * 这一轮钉住四件事：
 * 1. 「想念」这类关系由头在没有最近面对面聊天时也能出一张图（低频、按档位、不连发）；
 * 2. 城市插画可以 self=false：零参考图仍然画街景，并把可追溯出处留在附件上；
 * 3. 护栏（安静时段、额度、档位关闭）一律照旧，新路不绕过任何一道门；
 * 4. 生图没成时，只有本身就完整的正文才单独发；预告过这张图的整条不发。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { PHOTO_REASON_GAP_MS, hasImagePromise, pickReasonPhoto } from "../lib/chat-image.js";
import { cityIllustrationPrompt } from "../lib/city-illustration.js";
import { dateKey } from "../lib/clock.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花，不出现人物","self":false}]';
const ILLUSTRATION = '[生图:{"prompt":"窄巷和青砖院落","self":false}]';
const time = ms => new Date(Date.now() + ms).toISOString();

/**
 * 由头落点：熟悉度刚过门槛、亲密度拉满、不给聊天凭据。
 * 这样候选只有「搭话」和「想念」，前者占比小到 0.1 的随机值一定落到「想念」。
 */
const AFFECTION_RELATION = {
  familiarity: { turns: 4, activeDays: 3 },
  intimacy: { score: 48 },
};

async function boot(t, {
  answer = PHOTO, imageTier = "normal", partnerImageTier = "normal",
  affection = true, context = false, illustration = false, quotaSpent = 0, asleep = false,
  recentReasonPhotoAt = null,
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
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
      ...(illustration ? { lifeCity: "成都", lifeCityCode: "city-test-code", lifeCityDiscoveries: true, lifeCityIllustrations: true } : {}),
    });
    store.setPartnerSettings(AGENT, {
      proactiveEnabled: true, tier: "often", imageTier: partnerImageTier,
      model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: time(0),
      sleep: { shape: 2, start: asleep ? sleepStart : clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } },
      voice: { enabled: false },
    });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing,
      personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } },
      relationship: { ...knowing.relationship, ...(affection ? AFFECTION_RELATION : {}) },
      worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, {
      nextDueAt: time(-HOUR), lastSentAt: time(-HOUR),
      interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } },
      topicSeeds: { lastGrowAt: time(0), seeds: [] },
      ...(recentReasonPhotoAt ? { reasonPhoto: { at: recentReasonPhotoAt, kind: "affection" } } : {}),
      newsBook: illustration
        ? { lastFetchAt: time(0), lastDomainId: "", history: [], items: [{
          id: "local_fixture", domainId: "local-city", domainName: "同城发现",
          localCity: "成都", localCityCode: "city-test-code",
          title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。",
          url: "https://example.org/chengdu/lanes", publishedAt: time(0), createdAt: time(0),
          expiresAt: time(24 * HOUR), sharedAt: time(0),
        }] }
        : { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] },
    });
    if (context) {
      store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: time(-2 * HOUR) });
      store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    }
    if (quotaSpent) {
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
  return { ...app, mediaCalls, prompts, tick, diagnostics, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}

/* ── 纯函数 ── */

test("由头照片只认关系式由头，按档位折算概率，并守住间隔", () => {
  const base = { enabled: true, tier: "normal", recentPhoto: false, blocked: false, now: Date.parse("2026-11-23T10:00:00Z") };
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, random: () => 0.1 }), true);
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "interest" }, random: () => 0.1 }), false, "兴趣那一份靠素材，不靠这条");
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, tier: "off", random: () => 0.1 }), false);
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, enabled: false, random: () => 0.1 }), false);
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, blocked: true, random: () => 0.1 }), false);
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, recentPhoto: true, random: () => 0.1 }), false);
  // 刚用过就整段冷却，不给“马上再来一张”。
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, lastAt: new Date(base.now - PHOTO_REASON_GAP_MS + 60_000).toISOString(), random: () => 0.1 }), false);
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, lastAt: new Date(base.now - PHOTO_REASON_GAP_MS - 60_000).toISOString(), random: () => 0.1 }), true);
  // 高随机值这轮就不发，也不占频率记录。
  assert.equal(pickReasonPhoto({ ...base, reason: { kind: "affection" }, random: () => 0.99 }), false);
});

test("城市插画没有角色参考照时走 self=false：不传参考图，出处与“不是实景”都留在提示词里", () => {
  const prompt = cityIllustrationPrompt({ city: "成都", title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。", url: "https://example.org/chengdu/lanes" }, { self: false });
  assert.match(prompt, /只画风格化街景/u);
  assert.match(prompt, /不出现人物/u);
  assert.match(prompt, /self=false/u);
  assert.match(prompt, /https:\/\/example\.org\/chengdu\/lanes/u);
  assert.match(prompt, /不代表你到过/u);
  const withSelf = cityIllustrationPrompt({ city: "成都", title: "t", snippet: "成都青砖院落", url: "https://example.org/a" });
  assert.match(withSelf, /必须 self=true/u);
});

test("正文里预告过图的句子不会被当成独立文字单独发出去", () => {
  assert.equal(hasImagePromise("窗边这杯给你瞅瞅。"), true);
  assert.equal(hasImagePromise("我发张照片给你"), true);
  assert.equal(hasImagePromise("今天风挺大，出门记得穿外套。"), false);
});

/* ── 集成 ── */

test("想念由头在没有最近聊天时也能出一张图，且正文与图一起落库", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(app.diagnostics().filter(row => /photo|proactive/.test(row.event))));
  const [photo] = app.photos();
  assert.ok(photo, "由头在，照片就该能发出来");
  assert.equal(photo.photoScene.source, "scene");
  assert.match(String(photo.photoScene.key), /^reason:affection$/u);
  const reason = app.diagnostics().find(row => row.event === "proactive.photo.reason");
  assert.ok(reason, "新路要留诊断");
  assert.equal(reason.kind, "affection");
  // 提示词里说清这一轮没有聊天依据，画面只能取自当下状态。
  const prompt = app.prompts.find(req => String(req.systemPrompt ?? "").includes("【生活照片分享】"))?.systemPrompt;
  assert.ok(prompt, "照片这一轮真的进了提示词");
  assert.match(prompt, /没有最近的面对面聊天可依据/u);
  assert.match(prompt, /不要编造刚刚发生的事/u);
  // 额度照旧记一次。
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1);
});

test("刚发过由头照片就冷却：下一轮不出图，也不会连发", OPTIONS, async t => {
  // 这一轮不给照片候选，模型也就只写文字（主动照片靠这一轮的候选或它自己发的图，这里验前者）。
  const app = await boot(t, { recentReasonPhotoAt: time(-1 * HOUR), answer: "刚把窗开了会儿，风比昨天大。" });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0, JSON.stringify(app.diagnostics().filter(row => /photo|proactive/.test(row.event))));
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.reason"), false);
  // 这一轮退回普通文字主动：她等的仍然是 ta 来找她，不是必须带图。
  const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachment, undefined);
  assert.equal(sent[0].photoScene, undefined);
});

test("城市插画 self=false：零参考图、出处留在附件、消息不冒充真实街景", OPTIONS, async t => {
  const app = await boot(t, { answer: ILLUSTRATION, illustration: true });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(app.diagnostics().filter(row => /photo|illustration/.test(row.event))));
  const call = app.mediaCalls[0].input;
  assert.equal(call.referenceImages, undefined, "self=false 不传任何参考图");
  assert.match(call.prompt, /【城市插画】/u);
  assert.match(call.prompt, /不出现人物/u);
  assert.match(call.prompt, /https:\/\/example\.org\/chengdu\/lanes/u);
  const [photo] = app.photos();
  assert.ok(photo);
  assert.equal(photo.photoScene.source, "city-illustration");
  assert.equal(photo.cityIllustration.url, "https://example.org/chengdu/lanes");
  assert.equal(photo.streetView, undefined, "插画不得冒充真实街景");
  const meta = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${photo.attachment.id}.json`), "utf8"));
  assert.equal(meta.source.kind, "city-illustration");
  assert.equal(meta.source.url, "https://example.org/chengdu/lanes");
});

test("安静时段、额度用完、档位关闭时由头照片一律不出", OPTIONS, async t => {
  for (const [label, options] of [["asleep", { asleep: true }], ["quota", { quotaSpent: 2 }], ["tier-off", { imageTier: "off", partnerImageTier: "off" }]]) {
    await t.test(label, async t => {
      const app = await boot(t, options);
      await app.tick(0.1);
      assert.equal(app.mediaCalls.length, 0, label);
      assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.reason"), false, label);
      if (label === "asleep") assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
    });
  }
});

test("生图没成时：预告过图的整条不发，独立完整正文才单独发出", OPTIONS, async t => {
  const promised = await boot(t, { answer: `窗边这杯给你瞅瞅。${PHOTO}` });
  promised.ctx.media.getTask = async () => ({ status: "failed", error: "测试失败" });
  await promised.tick(0.1);
  assert.equal(promised.mediaCalls.length, 1);
  assert.equal(reopenThread(promised.dataDir, AGENT).filter(row => row.proactive).length, 0, "空头承诺不发");

  const standalone = await boot(t, { answer: `今天风挺大，出门记得穿外套。${PHOTO}` });
  standalone.ctx.media.getTask = async () => ({ status: "failed", error: "测试失败" });
  await standalone.tick(0.1);
  assert.equal(standalone.mediaCalls.length, 1);
  const sent = reopenThread(standalone.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1, "正文本身完整，就按普通主动发出去");
  assert.match(sent[0].text, /出门记得穿外套/u);
  assert.equal(sent[0].attachment, undefined);
  assert.equal(sent[0].proactiveExpression, undefined, "没出图就不能记成照片");
  assert.equal(sent[0].photoScene, undefined);
  const usage = (await standalone.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0, "失败照旧不占额度");
});
