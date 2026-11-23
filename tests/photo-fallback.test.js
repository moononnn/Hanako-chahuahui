/**
 * 漏标记兜底（2026-11-23 实机：11 条主动零附件，其中 2 次 photo.selected、
 * 护栏与插画检查都过了，但聊天模型两次都只写自然文字，生图一次没请求）。
 *
 * 这一轮钉住：
 * 1. 复现「候选已选中 + 模型纯文字」：按本轮由头补一张固定无人物情景照，真的下单、走同一额度；
 * 2. 24 小时冷却、关闭、额度用完、安静时段、明确不发图、硬拒绝、沉默：一律不兜底；
 * 3. 生图失败时沿用既有文字语义：独立正文单独发，预告过图的整条不发；
 * 4. 城市插画/真实街景不吃这条兜底（它们有自己的条件）。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { PHOTO_FALLBACK_GAP_MS, PHOTO_FALLBACK_SCENES, pickPhotoFallback } from "../lib/chat-image.js";
import { dateKey } from "../lib/clock.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
/** 模型漏标记时给的自然文字：可独立成立，不预告图，也不拒绝发图。 */
const NATURAL = "刚把窗开了会儿，风比昨天大，想起你上次说怕冷。";
const time = ms => new Date(Date.now() + ms).toISOString();

/** 熟悉度刚过门槛、亲密度拉满、无聊天凭据：0.1 的随机值落在「想念」。 */
const AFFECTION_RELATION = { familiarity: { turns: 4, activeDays: 3 }, intimacy: { score: 48 } };

async function boot(t, {
  answer = NATURAL, imageTier = "normal", partnerImageTier = "normal",
  quotaSpent = 0, asleep = false, illustration = false, recentFallbackAt = null, fail = false,
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
      relationship: { ...knowing.relationship, ...AFFECTION_RELATION },
      worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, {
      nextDueAt: time(-HOUR), lastSentAt: time(-HOUR),
      interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } },
      topicSeeds: { lastGrowAt: time(0), seeds: [] },
      ...(recentFallbackAt ? { photoFallback: { at: recentFallbackAt, kind: "affection" } } : {}),
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
    ctx.media = {
      getTask: async () => (fail ? { status: "failed", error: "测试失败" } : { status: "completed" }),
      getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }),
    };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.answer(req => { prompts.push(req); return true; }, answer);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  const tick = async (randomValue = 0.1) => {
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

test("兜底只认可画的普通由头、无标记、独立正文，且守住 24 小时", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  const base = { enabled: true, scene: true, text: NATURAL, reasonKind: "affection", now };
  assert.equal(pickPhotoFallback(base), true);
  assert.equal(pickPhotoFallback({ ...base, reasonKind: "contact" }), true);
  assert.equal(pickPhotoFallback({ ...base, reasonKind: "shared" }), false, "共同经历要凭据，不拿固定场景顶");
  assert.equal(pickPhotoFallback({ ...base, reasonKind: "interest" }), false);
  assert.equal(pickPhotoFallback({ ...base, enabled: false }), false);
  assert.equal(pickPhotoFallback({ ...base, scene: false }), false, "插画/街景/没选中都不兜底");
  assert.equal(pickPhotoFallback({ ...base, blocked: true }), false);
  assert.equal(pickPhotoFallback({ ...base, marker: "invalid" }), false, "硬拒绝不兜底");
  assert.equal(pickPhotoFallback({ ...base, marker: "valid" }), false, "有标记走原路");
  assert.equal(pickPhotoFallback({ ...base, oldImage: "valid" }), false, "旧图优先");
  assert.equal(pickPhotoFallback({ ...base, text: "" }), false);
  assert.equal(pickPhotoFallback({ ...base, text: "今天就不发图了，陪你聊两句。" }), false, "明确不发图不兜底");
  assert.equal(pickPhotoFallback({ ...base, lastAt: new Date(now - PHOTO_FALLBACK_GAP_MS + 60_000).toISOString() }), false);
  assert.equal(pickPhotoFallback({ ...base, lastAt: new Date(now - PHOTO_FALLBACK_GAP_MS - 60_000).toISOString() }), true);
  // 固定场景本身带齐防编造约束。
  for (const kind of ["affection", "contact"]) {
    assert.match(PHOTO_FALLBACK_SCENES[kind], /不出现人物/u);
    assert.match(PHOTO_FALLBACK_SCENES[kind], /可辨认地点/u);
    assert.match(PHOTO_FALLBACK_SCENES[kind], /不代表刚去过某处或刚经历某事/u);
  }
});

/* ── 集成：复现与下单 ── */

test("复现：候选已选中、模型只给自然文字时，按由头补一张无人物情景照并真下单", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  assert.ok(app.diagnostics().some(row => row.event === "proactive.photo.selected"), "先复现：这一轮照片候选确实选中");
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(app.diagnostics().filter(row => /photo|proactive/.test(row.event))));
  const call = app.mediaCalls[0].input;
  assert.equal(call.referenceImages, undefined, "兜底是无人物情景照，不传参考图");
  assert.ok(call.prompt.includes(PHOTO_FALLBACK_SCENES.affection), "固定场景原样进提示词");
  assert.match(call.prompt, /不出现人物或陌生人的自拍/u, "沿用既有的无人物前缀");
  const [photo] = app.photos();
  assert.ok(photo, "文字与图一起落库");
  assert.match(photo.text, /想起你上次说怕冷/u, "模型自己的正文保留");
  assert.equal(photo.photoScene.source, "scene");
  assert.equal(photo.proactiveExpression, "photo");
  const fallback = app.diagnostics().find(row => row.event === "proactive.photo.fallback");
  assert.ok(fallback);
  assert.equal(fallback.kind, "affection");
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1, "走同一份额度，不另开预算");
  const state = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "state.json"), "utf8"));
  assert.ok(state.runtime.partners[AGENT].photoFallback?.at, "限频记在既有主动状态里");
});

test("24 小时内不重复兜底：这一轮只发文字", OPTIONS, async t => {
  const app = await boot(t, { recentFallbackAt: time(-1 * HOUR) });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.fallback"), false);
  const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachment, undefined);
  assert.match(sent[0].text, /想起你上次说怕冷/u);
});

test("关闭、额度用完、安静时段：兜底一律不出", OPTIONS, async t => {
  for (const [label, options] of [
    ["tier-off", { imageTier: "off", partnerImageTier: "off" }],
    ["quota", { quotaSpent: 2 }],
    ["asleep", { asleep: true }],
  ]) {
    await t.test(label, async t => {
      const app = await boot(t, options);
      await app.tick();
      assert.equal(app.mediaCalls.length, 0, label);
      assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.fallback"), false, label);
      const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
      if (label === "asleep") assert.equal(sent.length, 0, "安静时段整条拦住");
      else {
        assert.equal(sent.length, 1, "护栏挡住图，文字照发");
        assert.equal(sent[0].attachment, undefined);
      }
    });
  }
});

test("明确不发图与沉默：不硬配图", OPTIONS, async t => {
  const decline = await boot(t, { answer: "今天就不发图了，陪你聊两句。" });
  await decline.tick();
  assert.equal(decline.mediaCalls.length, 0);
  const sent = reopenThread(decline.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachment, undefined);

  const silent = await boot(t, { answer: "[不回]" });
  await silent.tick();
  assert.equal(silent.mediaCalls.length, 0);
  assert.equal(reopenThread(silent.dataDir, AGENT).filter(row => row.proactive).length, 0);
});

test("硬拒绝（坏标记）沿用原语义：整条不发，也不兜底", OPTIONS, async t => {
  const app = await boot(t, { answer: "[生图:{坏json]" });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.fallback"), false);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
});

test("兜底生图失败：独立正文单独发，预告过图的整条不发", OPTIONS, async t => {
  const standalone = await boot(t, { fail: true });
  await standalone.tick();
  assert.equal(standalone.mediaCalls.length, 1);
  const sent = reopenThread(standalone.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachment, undefined);
  assert.equal(sent[0].proactiveExpression, undefined);
  assert.match(sent[0].text, /想起你上次说怕冷/u);

  const promised = await boot(t, { fail: true, answer: "窗边这杯给你瞅瞅。" });
  await promised.tick();
  assert.equal(promised.mediaCalls.length, 1);
  assert.equal(reopenThread(promised.dataDir, AGENT).filter(row => row.proactive).length, 0, "空头承诺不发");
  const usage = (await promised.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0, "失败不占额度");
});

test("城市插画选中但模型漏标记：不吃兜底，条件照旧", OPTIONS, async t => {
  const app = await boot(t, { illustration: true });
  await app.tick();
  assert.ok(app.diagnostics().some(row => row.event === "proactive.photo.city-illustration.selected"), "先确认插画这一支选中");
  assert.equal(app.mediaCalls.length, 0, "插画有自己的 self/参考照条件，不拿固定场景顶");
  assert.equal(app.diagnostics().some(row => row.event === "proactive.photo.fallback"), false);
  const sent = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachment, undefined);
});
