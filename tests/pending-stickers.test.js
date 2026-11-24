/**
 * 伙伴私藏的自制表情（2026-11-23）：她授权过的动作参考 → ta 自己的一张表情。
 *
 * 这一轮钉住：
 * 1. 授权只认她按过的那一下；撤回之后当场作废。
 * 2. 只接这位伙伴本地读得到的附件；没授权过的图一张都不动。
 * 3. 两张参考图各管一头：图一只管动作，图二只管当前角色。
 * 4. 审过才入待发；没审过的、审坏的都不算库存。
 * 5. 私藏草稿不外露：常规附件这条路读不到，发出去之后才读得到。
 * 6. 合适时通过表情路径发出去；发过之后这位伙伴还能再复用。
 * 7. 生成不阻塞主动联系：话先说出去，稿子后补。
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { dropStalePendingShares } from "../lib/pending-shares.js";
import {
  normalizeReferenceUse,
  pickReferenceUseSources,
  referenceUseAllowed,
  stickerDraftStillValid,
} from "../lib/image-reference-use.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const ACTION_ID = "img_action_source";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const time = ms => new Date(Date.now() + ms).toISOString();
const CHAT_LINE = "今天想喝热咖啡";

const ndjson = (text) => [
  { type: "text-delta", requestId: "review", delta: text },
  { type: "done", requestId: "review", stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text }] } },
].map((row) => JSON.stringify(row)).join("\n") + "\n";

const hasImagePart = (request) => (request?.messages ?? []).some((row) => Array.isArray(row?.content)
  && row.content.some((part) => part?.type === "image"));

/* ── 纯函数 ── */

test("授权只认她按过的那一下", () => {
  assert.equal(normalizeReferenceUse({ allowed: true }).allowed, true);
  assert.equal(normalizeReferenceUse({ allowed: false }).allowed, false);
  assert.equal(normalizeReferenceUse({}).allowed, false);
  assert.equal(normalizeReferenceUse(undefined).allowed, false);
  assert.equal(normalizeReferenceUse("yes").allowed, false);
  assert.equal(referenceUseAllowed({ referenceUse: { allowed: true } }), true);
  assert.equal(referenceUseAllowed({ collection: { sticker: true } }), false, "收藏不是授权");
});

test("只从这位伙伴自己、读得到的、授权过的图里挑动作参考", () => {
  const metas = [
    { id: "img_a", agentId: AGENT, referenceUse: { allowed: true }, title: "她的动作参考" },
    { id: "img_b", agentId: AGENT, referenceUse: { allowed: false }, title: "没授权" },
    { id: "img_c", agentId: AGENT, title: "完全没标记" },
    { id: "img_d", agentId: "other", referenceUse: { allowed: true }, title: "别人的图" },
    { id: "img_e", agentId: AGENT, referenceUse: { allowed: true }, purgedAt: "x", title: "清掉的" },
  ];
  const picked = pickReferenceUseSources({ metas, agentId: AGENT, hasBytes: () => true });
  assert.deepEqual(picked.map((row) => row.id), ["img_a"]);
  // 字节读不到的也不算数。
  const alive = pickReferenceUseSources({ metas, agentId: AGENT, hasBytes: (id) => id === "img_a" });
  assert.deepEqual(alive.map((row) => row.id), ["img_a"]);
  assert.deepEqual(pickReferenceUseSources({ metas, agentId: AGENT, hasBytes: () => false }), []);
});

test("源被撤回、源被收回授权、身份换了：稿子都作废", () => {
  const rows = [{ id: "p1", kind: "sticker", attachmentId: "img_s", referenceId: "ref_a", sourceAttachmentId: "img_action" }];
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_a", sourceStates: { img_action: { allowed: true } } }).length, 1);
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_a", sourceStates: { img_action: { allowed: false } } }).length, 0, "撤回了授权");
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_a", sourceStates: { img_action: { allowed: true, recalled: true } } }).length, 0, "源话被撤回");
  assert.equal(dropStalePendingShares(rows, { referenceId: "ref_b", sourceStates: { img_action: { allowed: true } } }).length, 0, "换了身份");
  assert.equal(stickerDraftStillValid({ draft: rows[0], referenceId: "ref_a", sourceAllowed: true }), true);
  assert.equal(stickerDraftStillValid({ draft: rows[0], referenceId: "ref_a", sourceAllowed: true, sourceRecalled: true }), false);
});

/* ── 集成 ── */

async function boot(t, { prep = true, review = true, vision = true, answer = "[不回]", verdicts = ["pass"], withAction = true, actionAge = -2 * HOUR } = {}) {
  const mediaCalls = [], prompts = [], reviewRequests = [];
  let lastTick = null;
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({
      rhythmProactiveEnabled: true, imageTier: "less", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) },
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
      lifeCity: "成都", lifeCityCode: "city-test-code", lifeCityDiscoveries: true,
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
      relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } } });
    store.setProactiveState(AGENT, {
      nextDueAt: time(-HOUR), lastSentAt: time(-HOUR),
      interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } },
      topicSeeds: { lastGrowAt: time(0), seeds: [] },
      newsBook: { lastFetchAt: time(0), lastDomainId: "", history: [], items: [] },
    });
    const chat = store.appendMessage(AGENT, { role: "user", text: CHAT_LINE, at: time(-2 * HOUR) });
    const reply = store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    store.patchMessage(AGENT, chat.id, { readAt: chat.at });
    store.patchMessage(AGENT, reply.id, { readAt: reply.at });
    // 她发来的一张图（还没授权）：授权要走她按的那一下，种子状态里没有。
    if (withAction) {
      const dir = path.join(ctx.dataDir, "v2", "attachments");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ACTION_ID}.bin`), PNG);
      fs.writeFileSync(path.join(dir, `${ACTION_ID}.json`), JSON.stringify({
        id: ACTION_ID, agentId: AGENT, name: "动作参考", mimeType: "image/png", size: PNG.length,
        at: time(-2 * HOUR), title: "她的动作参考", description: "这张图她有权用", hash: "action-fixture",
      }, null, 2), "utf8");
      const sent = store.appendMessage(AGENT, { role: "user", text: "看这张，学学这个动作", at: time(actionAge),
        attachment: { id: ACTION_ID, name: "动作参考", mimeType: "image/png", size: PNG.length } });
      store.patchMessage(AGENT, sent.id, { readAt: sent.at });
    }
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
    // 她说过的话都看过了：这一轮轮到她主动开口。
    store.markRead(AGENT);
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
  /** 给这位伙伴定一张角色参考照：没有它就做不出表情。 */
  const setReference = async () => {
    const added = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const referenceId = added.body?.reference?.history?.[0]?.id;
    assert.ok(referenceId, "参考照建好了");
    const picked = await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId } });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    return referenceId;
  };
  /** 她按一下「允许作为表情动作参考」。 */
  const allow = async (attachmentId = ACTION_ID, allowed = true) => {
    const response = await app.request("POST", "/library/reference-use", { json: { agentId: AGENT, attachmentId, allowed } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const pending = () => app.store.getPendingShares(AGENT);
  return { ...app, mediaCalls, prompts, reviewRequests, tick, diagnostics, setReference, allow, pending, lastTick: () => lastTick, setAnswer: (text) => { rule.text = text; } };
}

test("授权之后：后台能备出一张自制表情（动作图在前，角色参考照在后）", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  assert.equal(app.mediaCalls.length, 1, "做表情要走生图");
  assert.equal(app.reviewRequests.length, 1, "做出来的表情也要过审图");
  const input = app.mediaCalls[0]?.input ?? {};
  const refs = (input.referenceImages ?? []).map((row) => row.path);
  assert.equal(refs.length, 2, "两张参考图：动作 + 角色");
  assert.match(refs[0], new RegExp(`${ACTION_ID}\\.bin$`, "u"), "图一是从她授权的那张来的");
  assert.match(refs[1], /image-references/u, "图二是当前角色的参考照");
  assert.match(String(input.prompt ?? ""), /第一张参考图只管神态与动作/u);
  assert.match(String(input.prompt ?? ""), /第二张参考图只管当前角色的外貌/u);
  const list = app.pending();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "sticker");
  assert.equal(list[0].sourceAttachmentId, ACTION_ID);
  assert.match(list[0].title, /自制表情/u);
});

test("没授权过的图：一张都不动", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.tick();
  const list = app.pending();
  assert.equal(list.filter((row) => row.kind === "sticker").length, 0, "没授权就不做表情");
});

test("审图不通过：这张表情不算库存", OPTIONS, async t => {
  const app = await boot(t, { verdicts: ["reject", "reject"] });
  await app.setReference();
  await app.allow();
  await app.tick();
  assert.equal(app.mediaCalls.length, 2, `reject 会重画一次（实际 ${app.mediaCalls.length}，审图 ${app.reviewRequests.length}，${JSON.stringify(app.diagnostics().filter((row) => /image|quota/i.test(String(row.event))).slice(-6))}）`);
  assert.deepEqual(app.pending(), [], "两张都坏，队列里不留");
});

test("撤回授权：照它做的稿子当场作废", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  const [draft] = app.pending();
  assert.ok(draft);
  await app.allow(ACTION_ID, false);
  assert.deepEqual(app.pending(), [], "撤回之后稿子没了");
  for (const route of ["attachment", "sticker"]) {
    assert.equal((await app.request("GET", `/${route}/${AGENT}/${draft.attachmentId}`)).status, 404, "作废后仍不能读未发稿");
  }
});

test("源话被撤回：稿子作废", OPTIONS, async t => {
  const app = await boot(t, { actionAge: -30_000 });
  await app.setReference();
  await app.allow();
  await app.tick();
  assert.equal(app.pending().length, 1);
  // 她把那张图撤回了：源没了，稿子也不能留。
  const rows = reopenThread(app.dataDir, AGENT);
  const target = rows.find((row) => row.attachment?.id === ACTION_ID);
  assert.ok(target, "有那条发图的消息");
  const recalled = await app.request("POST", `/thread/${AGENT}/retract/${target.id}`);
  assert.equal(recalled.status, 200, JSON.stringify(recalled.body));
  await app.tick();
  assert.deepEqual(app.pending(), [], "源被撤回，稿子作废");
});

test("换身份：稿子作废", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  assert.equal(app.pending().length, 1);
  // 换一张角色参考照：当初那稿子对不上现在这张脸了。
  await app.setReference();
  await app.tick();
  assert.deepEqual(app.pending(), [], "换了身份，旧表情作废");
});

test("私藏草稿：常规附件读不到，发出去之后才读得到", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  const [draft] = app.pending();
  assert.ok(draft, "先备出稿子");
  const before = await app.request("GET", `/attachment/${AGENT}/${draft.attachmentId}`);
  assert.equal(before.status, 404, "还没发出去的私藏稿子，常规附件这条路读不到");
  const beforeSticker = await app.request("GET", `/sticker/${AGENT}/${draft.attachmentId}`);
  assert.equal(beforeSticker.status, 404, "表情这条路也不行");
  // 发出去：这时它才进聊天记录，才读得到。
  app.setAnswer(`[旧图:{"id":"${draft.attachmentId}","as":"sticker"}]`);
  await app.tick();
  const after = await app.request("GET", `/attachment/${AGENT}/${draft.attachmentId}`);
  assert.equal(after.status, 200, `发出去之后就能读了（${JSON.stringify({ tick: app.lastTick(), diag: app.diagnostics().slice(-8) })}）`);
});

test("通过表情路径发出去：气泡挂上了，队列清空，之后还能再发", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  const [draft] = app.pending();
  assert.ok(draft, "先备出稿子");
  app.setAnswer(`[旧图:{"id":"${draft.attachmentId}","as":"sticker"}]`);
  await app.tick();
  const sent = reopenThread(app.dataDir, AGENT).filter((row) => row.proactive);
  assert.equal(sent.length, 1, JSON.stringify({ texts: sent.map((row) => row.text), tick: app.lastTick(), diag: app.diagnostics().slice(-6) }));
  const bubbles = sent.at(-1).bubbles ?? [];
  assert.ok(bubbles.some((piece) => String(piece).includes(draft.attachmentId)), "气泡挂的是那张表情");
  assert.deepEqual(app.pending(), [], "发出去就不再留在队列里");
  // 发过之后这位伙伴还能再复用它：它已经是这位伙伴私藏的表情了。
  const meta = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${draft.attachmentId}.json`), "utf8"));
  assert.equal(meta.collection?.sticker, true, "发过之后就是这位伙伴私藏的表情");
  assert.equal(meta.collection?.origin, "self-made-sticker");
  assert.equal(meta.collection?.sourceMessageId, sent.at(-1).id, "记着是哪一条发出去的");
});

test("还没发出去的稿子不会被当成孤儿清走", OPTIONS, async t => {
  const app = await boot(t);
  await app.setReference();
  await app.allow();
  await app.tick();
  const [draft] = app.pending();
  assert.ok(draft, "先备出稿子");
  // 清理图片时得认下这些稿子：它们还没发过，没有消息认领。
  const cleaned = await app.request("POST", "/images/cleanup", { json: {} });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(app.pending().length, 1, "稿子还在队列里");
  const meta = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${draft.attachmentId}.json`), "utf8"));
  assert.ok(!meta.purgedAt, "字节没被收走");
});

test("生成不阻塞主动联系：话先说出去，稿子后补", OPTIONS, async t => {
  const app = await boot(t, { answer: "今天想喝热咖啡，我这儿也有。" });
  await app.setReference();
  await app.allow();
  await app.tick();
  const sent = reopenThread(app.dataDir, AGENT).filter((row) => row.proactive);
  assert.equal(sent.length, 1, `这一轮该说的话说出来了（${JSON.stringify({ tick: app.lastTick(), diag: app.diagnostics().slice(-8) })}）`);
  assert.equal(app.pending().length, 1, "稿子也备出来了");
  const events = app.diagnostics().map((row) => row.event);
  const sentAt = events.findIndex((event) => event === "proactive.ok");
  const preparedAt = events.findIndex((event) => event === "pending-share.prepared");
  assert.ok(sentAt >= 0 && preparedAt > sentAt, `话要先发、稿子后补（${events.join(",")}）`);
});
