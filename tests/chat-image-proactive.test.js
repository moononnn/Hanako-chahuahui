import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"窗边一杯咖啡，歪歪的小土豆拉花，不出现人物","self":false}]';
const time = ms => new Date(Date.now() + ms).toISOString();
async function boot(t, { enabled = true, answer = PHOTO } = {}) {
  const mediaCalls = [], prompts = [];
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({ rhythmProactiveEnabled: true, imageTier: enabled ? "less" : "off", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) }, weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false });
    store.setPartnerSettings(AGENT, { proactiveEnabled: true, tier: "often", imageTier: enabled ? "normal" : "off", model: { provider: "test-provider", model: "test-model" }, hobbySeedTryAt: time(0), sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } }, voice: { enabled: false } });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } }, worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    store.setProactiveState(AGENT, { nextDueAt: time(-HOUR), lastSentAt: time(-HOUR), interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: time(0), seeds: [] }, newsBook: { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] } });
    store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: time(-2 * HOUR) });
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
  app.models.answer(req => { prompts.push(req); return true; }, answer);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : answer };
  };
  const tick = async (randomValue = 0.99) => {
    const random = Math.random;
    Math.random = () => randomValue; // 默认落在有聊天凭据的关系由头；照片候选可单独验证低随机值。
    try { return await app.request("POST", "/proactive/tick", { json: {} }); }
    finally { Math.random = random; }
  };
  return { ...app, mediaCalls, prompts, tick, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}
async function waitUntil(testFn) {
  for (let i = 0; i < 800; i++) { if (testFn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("等待测试工作启动超时");
}
test("真主动调度：纯图沿既有消息通路保存并通知，只生成一次，额度与普通聊天共用", OPTIONS, async t => {
  const app = await boot(t);
  const result = await app.tick();
  assert.equal(result.status, 200);
  assert.equal(app.mediaCalls.length, 1, JSON.stringify(result.body));
  const [message] = app.photos(); assert.ok(message);
  assert.equal(message.text, "[图片]"); assert.equal(message.proactiveKind, "proactive");
  assert.equal(JSON.stringify(message).includes("[生图:"), false);
  assert.equal((await app.request("GET", `/attachment/${AGENT}/${message.attachment.id}`)).status, 200);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1); assert.equal(usage.globalUsed, 1); assert.equal(usage.partnerPending, 0);
  const prompt = app.prompts.find(req => req.systemPrompt.includes("【聊天照片】"))?.systemPrompt;
  assert.match(prompt, /【发图意愿：适中】/, "主动分享也按伙伴档位，不取全局少一些");
  assert.doesNotMatch(prompt, /【发图意愿：少一些】/);
  const generation = app.models.calls.find(row => row.request.systemPrompt.includes("【聊天照片】"))?.request;
  assert.ok(generation, "主动消息使用聊天流式模型");
  assert.equal(generation.provider, "test-provider");
  assert.equal(generation.model, "test-model");
  assert.equal(generation.maxTokens, 1800);
  const diagnostics = fs.readFileSync(`${app.dataDir}/v2/diagnostics.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(diagnostics.some(row => row.event === "chat.image.offered" && row.source === "proactive" && row.enabled));
  assert.ok(diagnostics.some(row => row.event === "chat.image.parsed" && row.status === "valid"));
  assert.ok(app.serviceCalls.some(row => row.type === "app:chahuahui/chat-image-generate"));
  assert.ok(app.emittedAppEvents.some(row => row.type === "partner-message-arrived" && row.payload.messageId === message.id));
});
test("生活照片候选即使有参考也可不出镜，沿原通道落库并保留由头分类", OPTIONS, async t => {
  const app = await boot(t);
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
  await app.tick(0.1);
  const [photo] = app.photos();
  assert.ok(photo);
  assert.equal(photo.proactiveExpression, "photo");
  assert.equal(photo.photoScene.source, "scene");
  assert.ok(photo.photoScene.key);
  assert.equal(app.mediaCalls.length, 1);
  assert.ok(app.prompts.some(req => req.systemPrompt.includes("【生活照片分享】")));
  const sources = JSON.parse(fs.readFileSync(`${app.dataDir}/v2/state.json`, "utf8")).runtime.partners[AGENT].proactiveSources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].group, "relational");
  assert.equal(app.mediaCalls[0].input.referenceImages, undefined);
});
test("生活照片候选可以放弃、协议写坏或明确拒绝出图，都不花生图额度", OPTIONS, async t => {
  // 2026-11-23：可独立成立的自然文字现在会被漏标记兜底接住（见 photo-fallback.test.js）；
  // “放弃出图”的语义落在明确拒绝、[不回] 与坏协议上，这里验后者。
  for (const answer of ["[不回]", "今天就不发图了，咖啡我还是喜欢不加糖的。", '[生图:{坏json}]']) {
    await t.test(answer, async t => {
      const app = await boot(t, { answer });
      await app.tick(0.1);
      assert.ok(app.prompts.some(req => req.systemPrompt.includes("【生活照片分享】")));
      assert.equal(app.mediaCalls.length, 0);
      const rows = reopenThread(app.dataDir, AGENT).filter(row => row.proactive);
      if (answer === "今天就不发图了，咖啡我还是喜欢不加糖的。") {
        // 候选不是硬性出图：模型给了普通文字就照常发出去，但不能把它记成一张照片。
        assert.equal(rows.length, 1);
        assert.equal(rows[0].attachment, undefined);
        assert.equal(rows[0].proactiveExpression, undefined);
        assert.equal(rows[0].photoScene, undefined);
      } else {
        assert.equal(rows.length, 0, "不回仍静默，坏协议不当正文发");
      }
      const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
      assert.equal(usage.partnerUsed, 0);
      assert.equal(usage.partnerPending, 0);
    });
  }
});
test("中间发过主动消息，最近那轮面对面聊天仍作照片依据", OPTIONS, async t => {
  const app = await boot(t);
  const replyAt = app.store.getThread(AGENT).messages[1].at;
  // 用消息上的回应确认接住主动，不另造一轮未完成的面对面聊天。
  app.store.appendMessage(AGENT, { role: "assistant", text: "今天风挺大", at: time(-HOUR), proactive: true,
    feed: { items: [{ emoji: "☕", count: 1, at: time(-HOUR + 1000) }] } });
  await app.tick(0.1);
  const photos = app.photos();
  assert.equal(photos.length, 1, "跨主动消息后照片候选仍成立");
  assert.equal(photos[0].photoScene.source, "scene");
  assert.equal(photos[0].photoScene.key, replyAt, "去重键仍是那轮面对面聊天的回复时间");
  const generation = app.models.calls.find(row => row.request.systemPrompt.includes("【生活照片分享】"))?.request;
  assert.ok(generation, "照片这一轮真的调了聊天模型");
  assert.match(JSON.stringify(generation.messages), /今天想喝热咖啡/, "模型手上真的有那轮面对面对话");
});
test("同一场景已经真出过图，这一轮不再挑照片", OPTIONS, async t => {
  const app = await boot(t, { answer: "今天风真大，出门记得穿外套。" });
  const replyAt = app.store.getThread(AGENT).messages[1].at;
  app.store.appendMessage(AGENT, {
    role: "assistant", text: "[图片]", at: time(-1 * HOUR), proactive: true,
    attachment: { id: "old_photo", description: "窗边一杯咖啡" },
    photoScene: { key: replyAt, source: "scene" },
    feed: { items: [{ emoji: "☕", count: 1, at: time(-HOUR + 1000) }] },
  });
  // 把旧图移出最近三条，单独验证场景键去重，低随机值原本会抽中照片。
  for (let i = 0; i < 3; i++) app.store.appendMessage(AGENT, {
    role: "assistant", text: `补充近况${i}`, at: time(-HOUR + 2000 + i), proactive: true,
    feed: { items: [{ emoji: "☕", count: 1, at: time(-HOUR + 3000 + i) }] },
  });
  await app.tick(0.1);
  assert.equal(app.mediaCalls.length, 0, "同一场景不重复出图");
  const rows = fs.readFileSync(`${app.dataDir}/v2/diagnostics.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const considered = rows.find(row => row.event === "proactive.photo.considered");
  assert.ok(considered, "照片候选要看得到");
  assert.ok(considered.excludedBy.includes("scene-used"), JSON.stringify(considered));
  assert.equal(considered.excludedBy.includes("recent-photo"), false, "这次只应是同一场景挡的，不是最近图片护栏");
});
test("照片这一轮的排除理由只报标识，不带聊天正文", OPTIONS, async t => {
  const app = await boot(t);
  await app.tick(0.99);
  const rows = fs.readFileSync(`${app.dataDir}/v2/diagnostics.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const considered = rows.find(row => row.event === "proactive.photo.considered");
  assert.ok(considered);
  assert.ok(Array.isArray(considered.excludedBy));
  assert.equal(JSON.stringify(considered).includes("今天想喝热咖啡"), false, "诊断里不能出现聊天正文");
  const offered = rows.find(row => row.event === "chat.image.offered");
  assert.ok(offered);
  assert.ok(Array.isArray(offered.excludedBy));
});
test("生活照片可自选露脸、背影或手部，出现本人均带当前参考照", OPTIONS, async t => {
  for (const framing of ["我露脸拿着咖啡", "我的背影站在窗边，不露脸", "只拍我的手拿着咖啡，不露脸"]) {
    await t.test(framing, async t => {
      const app = await boot(t, { answer: `[生图:${JSON.stringify({ prompt: framing, self: true })}]` });
      const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
      const referenceId = uploaded.body.reference.history[0].id;
      await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId } });
      await app.tick(0.1);
      assert.equal(app.photos()[0]?.proactiveExpression, "photo");
      assert.equal(app.mediaCalls.length, 1);
      assert.ok(app.mediaCalls[0].input.referenceImages[0].path.endsWith(`${referenceId}.png`));
      assert.ok(app.mediaCalls[0].input.prompt.includes(framing));
      assert.match(app.mediaCalls[0].input.prompt, /不因参考照强制露脸/);
    });
  }
});
test("生活照片无参考时不能用背影或手部冒充伙伴，不花生图额度", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"只拍我拿咖啡的手，不露脸","self":true}]' });
  await app.tick(0.1);
  assert.ok(app.prompts.some(req => req.systemPrompt.includes("【生活照片分享】")));
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(app.photos().length, 0);
});
test("生活照片候选不能把近期发过的同一画面重新生成", OPTIONS, async t => {
  const app = await boot(t);
  app.store.appendMessage(AGENT, { role: "assistant", text: "[图片]", at: time(-4 * HOUR), attachment: { id: "old_photo", description: "窗边一杯咖啡，歪歪的小土豆拉花，不出现人物" } });
  for (let i = 0; i < 3; i++) {
    app.store.appendMessage(AGENT, { role: "user", text: "咖啡喝完了吗", at: time(-2 * HOUR + i * 2000) });
    app.store.appendMessage(AGENT, { role: "assistant", text: "我打算换个杯子", at: time(-2 * HOUR + i * 2000 + 1000) });
  }
  await app.tick(0.1);
  assert.ok(app.prompts.some(req => req.systemPrompt.includes("【生活照片分享】")));
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(app.photos().length, 0);
});
test("生活照片选中后生成期间有新消息，图和配文一起作废，成功仍计次", OPTIONS, async t => {
  const app = await boot(t, { answer: `窗边这杯给你看一眼。${PHOTO}` });
  let finish;
  app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.tick(0.1);
  await waitUntil(() => finish);
  app.store.appendMessage(AGENT, { role: "user", text: "我又想到一件事", at: time(0) });
  finish({ status: "completed" });
  await pending;
  assert.equal(app.photos().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  assert.equal((await app.request("GET", `/image/partner/${AGENT}`)).body.usage.partnerUsed, 1);
});
test("聊天模型路由仅覆盖普通主动，提醒与回访保留原通道", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /const ordinaryProactive = kind === "proactive" && !exception && !followup && !wakeEcho && !greetingOnly/);
  assert.match(source, /!String\(todoNudge \?\? ""\)\.trim\(\) && !publicEvent && !shareableVideo && !shareableNews && !videoLoginNotice/);
  assert.match(source, /if \(ordinaryProactive \|\| shareableVideo \|\| videoLoginNotice\)/);
});
test("生活照抽中但生图不可用时退回普通文字，不整条丢掉", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /if \(shouldDegradePhotoShare\(\{ photoShare: Boolean\(photoShare\), imageEnabled \}\)\) \{/);
  assert.match(source, /diagnostics\(\{ event: "proactive\.photo\.skipped", agentId, reason: "image-disabled" \}\);/);
  assert.doesNotMatch(source, /if \(photoShare && !imageEnabled\) return \{ ok: false, reason: "image-disabled" \}/);
});
test("主动聊天模型空回包不降级到整理模型，也不触发生图", OPTIONS, async t => {
  const app = await boot(t, { answer: "" });
  const utilityPrompts = [];
  app.ctx.models.utility = async req => { utilityPrompts.push(req.systemPrompt); return { text: '{"decision":"send"}' }; };
  await app.tick();
  assert.equal(app.models.calls.length, 1);
  assert.ok(utilityPrompts.every(prompt => !prompt.includes("【聊天照片】")));
  assert.equal(app.mediaCalls.length, 0);
  assert.equal(app.photos().length, 0);
});
test("主动与普通聊天确实共用伙伴上限，用完后硬输出标记也不再生成", OPTIONS, async t => {
  const app = await boot(t); await app.tick();
  await app.request("PUT", `/settings/partner/${AGENT}`, { json: { phone: { holding: true, untilMs: Date.now() + HOUR }, rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 } } });
  app.models.answer(() => true, PHOTO);
  for (let i = 0; i < 2; i++) {
    const before = reopenThread(app.dataDir, AGENT).filter(row => row.role === "assistant").length;
    await app.request("POST", "/turns", { json: { agentId: AGENT, text: "再看看你的咖啡", watching: true, clientMessageId: `shared_photo_${i}` } });
    await waitUntil(() => reopenThread(app.dataDir, AGENT).filter(row => row.role === "assistant").length > before);
  }
  assert.equal(app.mediaCalls.length, 2, "主动一张、普通一张，第三次不能再调用宿主");
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 2); assert.equal(usage.partnerPending, 0);
});
test("主动自拍只带当前选用的伙伴参考照，照片属性沿现有附件存储", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我在窗边拿着热咖啡","self":true}]' });
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  const referenceId = uploaded.body.reference.history[0].id;
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId } });
  await app.tick(); assert.equal(app.photos().length, 1);
  assert.equal(app.mediaCalls[0].input.imageIntent, "edit");
  assert.ok(app.mediaCalls[0].input.referenceImages[0].path.endsWith(`${referenceId}.png`));
  assert.match(app.mediaCalls[0].input.prompt, /同一角色.*画风/);
});
test("静默、坏协议与重复协议不触发主动生图", OPTIONS, async t => {
  for (const answer of [`[不回]${PHOTO}`, '[生图:{坏json}]', PHOTO + PHOTO]) {
    await t.test(answer.slice(0, 12), async t => {
      const app = await boot(t, { answer }); await app.tick();
      assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
      const rows = fs.readFileSync(`${app.dataDir}/v2/diagnostics.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(rows.some(row => row.event === "chat.image.parsed" && row.status === (answer.startsWith("[不回]") ? "valid" : "invalid")));
    });
  }
});
test("开关关闭时不注入发图能力，模型硬输出照片协议也不能付费或发空头配文", OPTIONS, async t => {
  const app = await boot(t, { enabled: false, answer: `给你看看我刚冲的咖啡。${PHOTO}` });
  await app.tick();
  assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  assert.ok(app.prompts.every(req => !req.systemPrompt.includes("【聊天照片】")));
});
test("未选外貌参考时，主动自拍不能生成陌生脸", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我靠着窗拿咖啡","self":true}]' });
  await app.tick(); assert.equal(app.mediaCalls.length, 0); assert.equal(app.photos().length, 0);
});
test("慢生图期间不落配文，成功时图文一起落库，不并发语音", OPTIONS, async t => {
  const app = await boot(t, { answer: `窗边这杯咖啡的拉花歪得像个小土豆，给你瞅瞅。${PHOTO}` });
  let finish;
  app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.tick(); await waitUntil(() => finish);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  finish({ status: "completed" }); await pending;
  const [message] = app.photos(); assert.ok(message); assert.match(message.text, /小土豆/); assert.equal(message.voice, undefined);
});
test("失败只结算这一次，不自动重试、不发送声称已出图的配文", OPTIONS, async t => {
  const app = await boot(t, { answer: `窗边这杯咖啡的拉花歪得像个小土豆，给你瞅瞅。${PHOTO}` });
  app.ctx.media.getTask = async () => ({ status: "failed", error: "测试失败" });
  await app.tick(); assert.equal(app.mediaCalls.length, 1); assert.equal(app.photos().length, 0);
  assert.equal(reopenThread(app.dataDir, AGENT).filter(row => row.proactive).length, 0);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 0); assert.equal(usage.partnerPending, 0);
});
test("自拍生成期间切换参考照，不把旧外貌照片发出去，成功仍计数", OPTIONS, async t => {
  const app = await boot(t, { answer: '[生图:{"prompt":"我在窗边拿着热咖啡","self":true}]' });
  const upload = async () => (await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } })).body.reference.history[0].id;
  const one = await upload(), two = await upload();
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: one } });
  let finish; app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
  const pending = app.tick(); await waitUntil(() => finish);
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: two } });
  finish({ status: "completed" }); await pending;
  assert.equal(app.photos().length, 0); assert.equal(app.mediaCalls.length, 1);
  const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
  assert.equal(usage.partnerUsed, 1); assert.equal(usage.partnerPending, 0);
});
test("等待期间新消息或关闭生图/主动开关，都不投递过期照片；已成功生成仍计数", OPTIONS, async t => {
  for (const change of ["message", "imageOff", "proactiveOff", "partnerOff"]) {
    await t.test(change, async t => {
      const app = await boot(t); let finish;
      app.ctx.media.getTask = () => new Promise(resolve => { finish = resolve; });
      const pending = app.tick(); await waitUntil(() => finish);
      if (change === "message") app.store.appendMessage(AGENT, { role: "user", text: "我又发了新话", at: time(0) });
      else if (change === "imageOff") await app.request("PUT", "/settings/global", { json: { imageTier: "off" } });
      else if (change === "proactiveOff") await app.request("PUT", "/settings/global", { json: { rhythmProactiveEnabled: false } });
      else await app.request("PUT", `/settings/partner/${AGENT}`, { json: { proactiveEnabled: false } });
      finish({ status: "completed" }); await pending;
      assert.equal(app.photos().length, 0); assert.equal(app.mediaCalls.length, 1);
      const usage = (await app.request("GET", `/image/partner/${AGENT}`)).body.usage;
      assert.equal(usage.partnerUsed, 1); assert.equal(usage.partnerPending, 0);
    });
  }
});
