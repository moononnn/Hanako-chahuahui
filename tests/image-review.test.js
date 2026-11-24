/**
 * 生图发出前的二次质量检查（2026-11-23）。
 *
 * 这一轮钉住：
 * 1. 开关默认关；关着时生图照旧直接发，不多调一次模型。
 * 2. 开着时：审图只看候选图和一句构图意图，不带聊天；判定严格 pass/reject/unavailable。
 * 3. 明确 reject 才重画一次（独立预占、同一 provider 与同一参考），第二张也要审；仍坏就不落附件。
 * 4. 审图资源不可用（没配识图模型）时宁可不发未审图，只留文字；审图不可用不重画。
 * 5. 额度用完不重画；这一轮被取消就整条作罢；被判坏的图不留在盘上。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { imageReviewPrompt, parseImageReviewVerdict, shouldRepaintAfterReview } from "../lib/image-review.js";
import { dateKey } from "../lib/clock.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花","self":false}]';
const CHAT_LINE = "今天想喝热咖啡";
const time = ms => new Date(Date.now() + ms).toISOString();

/* ── 纯函数 ── */

test("审核判定严格三选一：认不出来就当 unavailable", () => {
  assert.equal(parseImageReviewVerdict("pass"), "pass");
  assert.equal(parseImageReviewVerdict("PASS"), "pass");
  assert.equal(parseImageReviewVerdict("pass."), "pass");
  assert.equal(parseImageReviewVerdict("reject：脸崩了"), "reject");
  assert.equal(parseImageReviewVerdict("reject 脸崩"), "reject");
  assert.equal(parseImageReviewVerdict("pass 画面正常"), "pass");
  assert.equal(parseImageReviewVerdict("unavailable 看不清"), "unavailable");
  assert.equal(parseImageReviewVerdict('{"verdict":"reject"}'), "reject");
  assert.equal(parseImageReviewVerdict('{"verdict":"pass","reason":"ok"}'), "pass");
  assert.equal(parseImageReviewVerdict("看起来还行吧"), "unavailable");
  assert.equal(parseImageReviewVerdict(""), "unavailable");
});

test("含糊的判定一律 unavailable：不猜它想说什么", () => {
  assert.equal(parseImageReviewVerdict("I cannot tell whether to pass"), "unavailable");
  assert.equal(parseImageReviewVerdict("pass or reject"), "unavailable");
  assert.equal(parseImageReviewVerdict("reject, maybe pass"), "unavailable");
  assert.equal(parseImageReviewVerdict("not sure"), "unavailable");
  assert.equal(parseImageReviewVerdict("passed"), "unavailable");
  assert.equal(parseImageReviewVerdict("无法判断"), "unavailable");
  // 首词后面那截太长：就不是「一句理由」了。
  assert.equal(parseImageReviewVerdict(`pass ${"正常".repeat(30)}`), "unavailable");
});

test("审核提示词只判硬伤，不挑画风，也不宣称身份核验", () => {
  const prompt = imageReviewPrompt({ intent: "窗边一杯咖啡" });
  assert.match(prompt, /窗边一杯咖啡/u);
  assert.match(prompt, /肢体明显不对/u);
  assert.match(prompt, /脸明显崩掉/u);
  assert.match(prompt, /画面明显跑题/u);
  assert.match(prompt, /动作不明确/u);
  assert.match(prompt, /Q 版、简笔/u, "不挑画风");
  assert.match(prompt, /故意遮挡/u);
  assert.match(prompt, /不许对「这是不是同一个角色」下结论/u, "没有可比较的角色输入就不许宣称身份核验");
  assert.match(prompt, /pass、reject 或 unavailable/u);
  assert.match(imageReviewPrompt({ intent: "贴纸：挥手" , kind: "sticker" }), /贴纸\/表情/u);
});

test("只有明确 reject 才重画，且要还在这一轮、有配额、同一 provider 与同一参考", () => {
  const ok = { verdict: "reject", stillCurrent: true, quotaAvailable: true, sameProvider: true, sameReference: true };
  assert.equal(shouldRepaintAfterReview(ok), true);
  assert.equal(shouldRepaintAfterReview({ ...ok, verdict: "unavailable" }), false);
  assert.equal(shouldRepaintAfterReview({ ...ok, verdict: "pass" }), false);
  assert.equal(shouldRepaintAfterReview({ ...ok, stillCurrent: false }), false);
  assert.equal(shouldRepaintAfterReview({ ...ok, quotaAvailable: false }), false);
  assert.equal(shouldRepaintAfterReview({ ...ok, sameProvider: false }), false);
  assert.equal(shouldRepaintAfterReview({ ...ok, sameReference: false }), false);
});

/* ── 集成 ── */

const ndjson = (text) => [
  { type: "text-delta", requestId: "review", delta: text },
  { type: "done", requestId: "review", stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text }] } },
].map((row) => JSON.stringify(row)).join("\n") + "\n";

const hasImagePart = (request) => (request?.messages ?? []).some((row) => Array.isArray(row?.content)
  && row.content.some((part) => part?.type === "image"));

async function boot(t, {
  review = true, verdicts = ["pass"], vision = true, partnerImageTier = "normal", quotaSpent = 0,
  cancelOnReview = false, cancelAfterRepaint = false, answer = PHOTO,
} = {}) {
  const mediaCalls = [], prompts = [], reviewRequests = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({
      rhythmProactiveEnabled: true, imageTier: "less", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) },
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
      ...(review ? { imageReviewEnabled: true } : {}),
      // 复用已经配好并验过的识图模型：只给 provider/model，不另加域名。
      ...(vision ? { vision: { model: { provider: "test-provider", model: "test-model" }, status: "verified" } } : {}),
    });
    store.setPartnerSettings(AGENT, {
      proactiveEnabled: true, tier: "often", imageTier: partnerImageTier,
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
      newsBook: { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] },
    });
    store.appendMessage(AGENT, { role: "user", text: CHAT_LINE, at: time(-2 * HOUR) });
    store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    if (quotaSpent) {
      const file = path.join(ctx.dataDir, "v2", "image-quota.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ entries: Array.from({ length: quotaSpent }, (_, i) => ({
        id: `quota_${i}`, agentId: AGENT, day: dateKey(new Date()), status: "success",
      })) }));
    }
    const request = ctx.bus.request;
    let mediaCount = 0;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") {
        mediaCalls.push(payload);
        mediaCount += 1;
        // 重画时这一轮作废：模拟生成途中来了新消息。
        if (cancelAfterRepaint && mediaCount >= 2) {
          store.appendMessage(AGENT, { role: "user", text: "我刚回了一句", at: new Date().toISOString() });
        }
        return { tasks: [{ taskId: "photo_fixture" }] };
      }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  app.models.answer(req => { prompts.push(req); return String(req.systemPrompt ?? "").includes("【生活照片分享】"); }, answer);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  // 审图是带图的模型请求：单独接住，按用例给的判定词回。
  const stream = app.ctx.models.stream.bind(app.ctx.models);
  let reviewIndex = 0;
  app.ctx.models.stream = async (request) => {
    if (!hasImagePart(request)) return stream(request);
    reviewRequests.push(request);
    const verdict = verdicts[Math.min(reviewIndex, verdicts.length - 1)];
    reviewIndex += 1;
    if (cancelOnReview) {
      // 审图期间来了新消息：这一轮已经作废。
      app.store.appendMessage(AGENT, { role: "user", text: "我刚回了一句", at: new Date().toISOString() });
    }
    return { text: async () => ndjson(verdict) };
  };
  const tick = async (randomValue = 0.1) => {
    const random = Math.random;
    Math.random = () => randomValue;
    try { return await app.request("POST", "/proactive/tick", { json: {} }); }
    finally { Math.random = random; }
  };
  const attachments = () => {
    const dir = path.join(app.dataDir, "v2", "attachments");
    try { return fs.readdirSync(dir); } catch { return []; }
  };
  const diagnostics = () => fs.readFileSync(path.join(app.dataDir, "v2", "diagnostics.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  return { ...app, mediaCalls, prompts, reviewRequests, tick, attachments, diagnostics, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}

test("开关默认关：生图照旧直接发，不多调一次模型", OPTIONS, async t => {
  const app = await boot(t, { review: false });
  await app.tick();
  assert.equal(app.mediaCalls.length, 1);
  assert.equal(app.reviewRequests.length, 0, "没开就不审图");
  assert.equal(app.photos().length, 1);
});

test("审图通过：图照发，审图只拿到候选图和固定意图，不带聊天也不带模型原话", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick();
  assert.equal(app.mediaCalls.length, 1);
  assert.equal(app.reviewRequests.length, 1, "一张图一次审图");
  const request = app.reviewRequests[0];
  const text = request.messages[0].content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.match(text, /质检/u);
  assert.match(text, /没有人出镜/u, "意图是固定表述：按 self 分的那一种");
  assert.equal(text.includes("歪歪的小土豆拉花"), false, "模型写的那句画面描述不能转交给另一家供应商");
  assert.equal(text.includes(CHAT_LINE), false, "审图请求里不能有聊天内容");
  assert.equal(request.messages[0].content.some(part => part.type === "image"), true, "审图拿到候选图");
  assert.equal(request.provider, "test-provider", "沿用已配好的 provider，不新加域名");
  assert.equal(app.photos().length, 1);
  assert.equal(app.attachments().length, 2, "只落一份附件（图片 + 元数据）");
  const verdict = app.diagnostics().find(row => row.event === "image.review.verdict");
  assert.ok(verdict);
  assert.equal(verdict.verdict, "pass");
});

test("人物出镜的图走另一条固定意图，同样不转交模型原话", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我靠在窗边","self":true}]' });
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
  await app.tick();
  assert.equal(app.reviewRequests.length, 1);
  const text = app.reviewRequests[0].messages[0].content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.match(text, /人物出镜/u);
  assert.equal(text.includes("我靠在窗边"), false, "模型写的那句也不能转交");
  assert.equal(text.includes(CHAT_LINE), false);
});

test("重画回来后这一轮已作废：不再发第二次审图", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject"], cancelAfterRepaint: true });
  await app.tick();
  assert.equal(app.mediaCalls.length, 2, "重画过一次");
  assert.equal(app.reviewRequests.length, 1, "作废之后不再审第二次");
  assert.equal(app.photos().length, 0);
  assert.equal(app.attachments().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
});

test("响应读取也受期限约束：text() 在 withModelDeadline 的 run 里", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("  async function reviewGeneratedImage(");
  const code = source.slice(start, source.indexOf("\n  /**", start));
  const runAt = code.indexOf("run: async () => {");
  assert.ok(runAt >= 0, "审图要走 withModelDeadline 的 run");
  const readAt = code.indexOf("await response.text()");
  assert.ok(readAt > runAt, "响应读取也要在期限里面");
});

test("明确 reject：重画一次，第二张过了才落附件；被判坏的那张不落盘", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject", "pass"] });
  await app.tick();
  assert.equal(app.mediaCalls.length, 2, "重画一次");
  assert.equal(app.reviewRequests.length, 2, "第二张也要审");
  assert.equal(app.photos().length, 1);
  assert.equal(app.attachments().length, 2, "只有第二张落了盘");
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 2, "两次生成各记一次原额度");
});

test("两张都坏：不落附件、不发空头配文，盘上不留图", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject", "reject"] });
  await app.tick();
  assert.equal(app.mediaCalls.length, 2);
  assert.equal(app.reviewRequests.length, 2);
  assert.equal(app.photos().length, 0);
  assert.equal(app.attachments().length, 0, "被判坏的两张都不留在盘上");
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 2, "两次生成照旧记额度，失败不额外放大");
});

test("没配识图模型：不画也不发，不白花生图额度", OPTIONS, async t => {
  const app = await boot(t, { vision: false, verdicts: ["reject"] });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0, "没人审就不画");
  assert.equal(app.reviewRequests.length, 0);
  assert.equal(app.photos().length, 0);
  assert.equal(app.attachments().length, 0);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0, "额度不白占");
  assert.ok(app.diagnostics().some(row => row.event === "image.review.skipped"));
});

test("额度用完：明确 reject 也不重画", OPTIONS, async t => {
  // 伙伴档位 less 的额度是 1：第一张就用完了，重画没有位置。
  const app = await boot(t, { partnerImageTier: "less", verdicts: ["reject"] });
  await app.tick();
  assert.equal(app.mediaCalls.length, 1, "没有额度就不重画");
  assert.equal(app.reviewRequests.length, 1);
  assert.equal(app.photos().length, 0);
  assert.equal(app.attachments().length, 0);
});

test("审图期间这一轮被取消：整条作罢，不落附件也不重画", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject"], cancelOnReview: true });
  await app.tick();
  assert.equal(app.mediaCalls.length, 1, "取消后不再重画");
  assert.equal(app.reviewRequests.length, 1);
  assert.equal(app.photos().length, 0);
  assert.equal(app.attachments().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
});
