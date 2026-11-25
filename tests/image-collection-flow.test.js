import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { pickCollectedImageRows } from "../lib/image-tool.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const STICKER_PREFIX = "\u0001stk:";
/** 第二轮的用户话里带这个词，模型规则靠它认出该回哪一句。 */
const TURN = "旧图";

async function boot(t) {
  const mediaCalls = [];
  let partner = null;
  const app = await bootChahuahui({ seed(store, ctx) {
    partner = store.createLocalPartner({ name: "测试伙伴", description: "嘴硬心软" });
    store.saveKnowing(partner.id, { ...store.getKnowing(partner.id), personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } } });
    store.setPartnerSettings(partner.id, {
      phone: { holding: true, untilMs: Date.now() + 60 * 60_000 },
      rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 },
      voice: { enabled: false },
      imageTier: "off",
      model: { provider: "test-provider", model: "test-model" },
    });
    store.setGlobalSettings({ weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false, imageTier: "off" });
    const original = ctx.bus.request;
    ctx.bus.request = async (method, payload, ...rest) => {
      if (method === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "task_photo" }] }; }
      return original(method, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "task_photo" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  // 目录里的模型得收图，否则她发来的图会走识图那条路，压根接不上话。
  app.models.setCatalog([{ provider: "test-provider", model: "test-model", supportsImage: true }]);
  // 平常那轮回一句；带「旧图」的那轮由用例自己定回什么。
  app.models.answer(req => !JSON.stringify(req.messages ?? []).includes(TURN), "嗯，我在。");
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return { ...app, partner, mediaCalls };
}

async function waitFor(app, agentId, predicate, what = "消息") {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = reopenThread(app.dataDir, agentId);
    const hit = rows.find(predicate);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待${what}超时`);
}

function attachmentsDir(app) { return path.join(app.dataDir, "v2", "attachments"); }
function metaOf(app, id) {
  return JSON.parse(fs.readFileSync(path.join(attachmentsDir(app), `${id}.json`), "utf8"));
}
function assistantRows(app, agentId) {
  return reopenThread(app.dataDir, agentId).filter((row) => row.role === "assistant");
}

/** 还没被回答的那次模型调用（后台记忆维护那些不算）。 */
async function pendingCall(app, match, what = "模型调用") {
  for (let i = 0; i < 200; i += 1) {
    const hit = [...app.models.calls].reverse().find((entry) => !entry.settled && match(entry.request));
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待${what}超时`);
}

/** 她发一张图，并等到这一轮回复走完（收藏就是在那时补认的）。 */
async function sendImage(app, id, text, clientMessageId) {
  const sent = await app.request("POST", "/turns", { json: { agentId: id, text, image: { data: PNG.toString("base64"), mimeType: "image/png" }, watching: true, clientMessageId } });
  const row = await waitFor(app, id, (item) => item.id === sent.body.messageId && item.role === "user" && item.attachment?.id, "用户那条图");
  assert.equal(sent.body.attachmentId, row.attachment.id, "发送成功时就要返回原图编号，右键不必等回复");
  await waitFor(app, id, (item) => item.role === "assistant", "伙伴那条回复");
  return { attachmentId: row.attachment.id, messageId: sent.body.messageId };
}

test("明确收作表情的旧图能当表情重发：不生图、不扣额度、不复制字节", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "这张给你做表情包", "gift_000001");
  app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), `[旧图:{"id":"${attachmentId}","as":"sticker"}]`);
  await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}甩我看看`, watching: true, clientMessageId: "gift_000002" } });
  const reply = await waitFor(app, id, (row) => row.role === "assistant" && row.imageReuse, "伙伴那条旧图");
  assert.equal(reply.imageReuse.attachmentId, attachmentId);
  assert.equal(reply.imageReuse.as, "sticker");
  assert.equal(reply.attachment, undefined, "当表情发不能再挂一张附件，免得一条出两张图");
  const bubble = reply.bubbles.find((piece) => String(piece).startsWith(STICKER_PREFIX));
  assert.ok(bubble, "旧图要进气泡");
  assert.equal(bubble, `${STICKER_PREFIX}${attachmentId}`);
  assert.equal(app.mediaCalls.length, 0, "旧图不许触发生图");
  const usage = (await app.request("GET", `/image/partner/${id}`)).body.usage;
  assert.equal(usage.partnerUsed, 0);
  assert.equal(usage.partnerPending, 0);
  // 表情图走原来那条路：读的就是原件，字节与 GIF 都不变。
  const sticker = await app.request("GET", `/sticker/${id}/${attachmentId}`);
  assert.equal(sticker.status, 200);
  assert.equal(Buffer.from(sticker.body).equals(PNG), true, "发出去的还是原图");
  const thumb = await app.request("GET", `/sticker-thumb/${id}/${attachmentId}`);
  assert.equal(thumb.status, 200, "手机端缩略图那条路也得认旧图");
});

test("旧图当普通图重发：挂原附件，不复制字节，也不记成新照片", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "上次那家店的猫", "reuse_000001");
  const before = fs.readdirSync(attachmentsDir(app)).filter((name) => name.endsWith(".bin")).length;
  app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), `[旧图:{"id":"${attachmentId}","as":"image"}]`);
  await app.request("POST", "/turns", { json: { agentId: id, text: `再发一次那张${TURN}`, watching: true, clientMessageId: "reuse_000002" } });
  const reply = await waitFor(app, id, (row) => row.role === "assistant" && row.imageReuse, "伙伴那条旧图");
  assert.equal(reply.attachment.id, attachmentId, "挂的还是原来那张");
  assert.equal(reply.attachment.reused, true);
  assert.equal(reply.photoScene, undefined, "旧图不是新拍的照片，不记场景");
  assert.equal(app.mediaCalls.length, 0);
  const after = fs.readdirSync(attachmentsDir(app)).filter((name) => name.endsWith(".bin")).length;
  assert.equal(after, before, "不复制字节");
  const served = await app.request("GET", `/attachment/${id}/${attachmentId}`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(served.body).equals(PNG), true, "原字节不变");
  assert.equal(metaOf(app, attachmentId).agentId, id, "属主不变");
  // 重发算「最近又见过一次」：清理期限按这次算。
  assert.ok(Date.parse(metaOf(app, attachmentId).lastSeenAt) > Date.parse(metaOf(app, attachmentId).at), "重发要 touch lastSeenAt");
});

test("没被收作表情的图不能当表情发：整轮安全收手，不发空头配文", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "随手拍的", "plain_000001");
  const before = assistantRows(app, id).length;
  app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), `这张我记着呢[旧图:{"id":"${attachmentId}","as":"sticker"}]`);
  await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}发我看看`, watching: true, clientMessageId: "plain_000002" } });
  await new Promise(resolve => setTimeout(resolve, 600));
  const rows = assistantRows(app, id);
  assert.equal(rows.length, before, "发不出去的旧图不该带出任何一条消息");
  assert.equal(JSON.stringify(rows).includes(attachmentId), false);
  assert.equal(app.mediaCalls.length, 0);
});

test("坏协议、坏 id、重复标记都不发，连生图也不触发", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  await sendImage(app, id, "随手拍的", "bad_000001");
  const before = assistantRows(app, id).length;
  for (const answer of [
    '[旧图:{"id":"img_not_here","as":"sticker"}]',
    '[旧图:{"id":"photo_x","as":"image"}]',
    '[旧图:{"id":["img_a"],"as":"image"}]',
    '[旧图:{"id":"img_a","as":"sticker"}][旧图:{"id":"img_b","as":"sticker"}]',
    '[旧图:{"id":"img_a"',
  ]) {
    app.models.rules.length = 0;
    app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), answer);
    await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}发我看看`, watching: true, clientMessageId: `bad_${answer.length}_${Math.random().toString(36).slice(2, 6)}` } });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(assistantRows(app, id).length, before, `坏协议不该发消息：${answer}`);
  }
  assert.equal(app.mediaCalls.length, 0, "坏旧图不许带着生图一起花钱");
});

test("坏旧图与合法生图同轮：不生图，也不发那条消息", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  await sendImage(app, id, "随手拍的", "both_000001");
  const before = assistantRows(app, id).length;
  app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), '看这张[旧图:{"id":"img_not_here","as":"image"}][生图:{"prompt":"窗边一杯咖啡","self":false}]');
  await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}发我看看`, watching: true, clientMessageId: "both_000002" } });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(app.mediaCalls.length, 0, "出现旧图标记就不许生图");
  assert.equal(assistantRows(app, id).length, before, "也不发那条消息");
});

test("别的伙伴的图与假元数据都拿不到", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const dir = attachmentsDir(app);
  fs.writeFileSync(path.join(dir, "img_other_1.bin"), PNG);
  fs.writeFileSync(path.join(dir, "img_other_1.json"), JSON.stringify({ id: "img_other_1", agentId: "other_partner", name: "别人的图", mimeType: "image/png", size: PNG.length, at: new Date().toISOString(), lastSeenAt: new Date().toISOString() }, null, 2));
  // 元数据里写的 id 跟文件名对不上：不能拿它顶上来。
  fs.writeFileSync(path.join(dir, "img_fake_1.json"), JSON.stringify({ id: "img_fake_2", agentId: id, name: "假图", mimeType: "image/png", size: PNG.length, at: new Date().toISOString(), lastSeenAt: new Date().toISOString(), collection: { sticker: true } }, null, 2));
  const before = assistantRows(app, id).length;
  for (const target of ["img_other_1", "img_fake_1"]) {
    app.models.rules.length = 0;
    app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), `发我看看[旧图:{"id":"${target}","as":"sticker"}]`);
    await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}发我看看`, watching: true, clientMessageId: `cross_${target}_${Math.random().toString(36).slice(2, 6)}` } });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(assistantRows(app, id).length, before, `${target} 不该发出来`);
  }
  const sticker = await app.request("GET", `/sticker/${id}/img_other_1`);
  assert.equal(sticker.status, 404, "表情那条路也不许读别人的图");
});

test("收藏的旧图过清理那关：期限到了也不清；退收藏后照常清", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "这张给你做表情包", "keep_000001");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true);
  await app.request("PUT", "/settings/global", { json: { imageRetentionDays: 30 } });
  // 把这张图的时间改老：过期该清，但收藏要护住。
  const metaPath = path.join(attachmentsDir(app), `${attachmentId}.json`);
  const old = { ...metaOf(app, attachmentId), at: new Date(Date.now() - 90 * 86400_000).toISOString(), lastSeenAt: new Date(Date.now() - 90 * 86400_000).toISOString() };
  fs.writeFileSync(metaPath, JSON.stringify(old, null, 2));
  const cleaned = await app.request("POST", "/images/cleanup", { json: {} });
  assert.equal(cleaned.status, 200);
  assert.ok(fs.existsSync(path.join(attachmentsDir(app), `${attachmentId}.bin`)), "收作表情的收藏不被期限清掉");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true);

  // 明确取消收藏后按普通图清；审美上的不喜欢不会自动退收藏。
  const said = await app.request("POST", "/turns", { json: { agentId: id, text: "取消这张的收藏", watching: true, clientMessageId: "keep_000002" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === said.body.messageId, "伙伴那条回复");
  assert.equal(metaOf(app, attachmentId).collection.sticker, false, "退收藏留墓碑");
  await app.request("POST", "/images/cleanup", { json: {} });
  assert.equal(fs.existsSync(path.join(attachmentsDir(app), `${attachmentId}.bin`)), false, "退收藏后按普通图清掉");
});

test("同一个附件上超过二十条指令：最后一条说了算，反复候选也不写回", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId, messageId } = await sendImage(app, id, "这张给你做表情包", "many_000001");
  for (let i = 0; i < 25; i += 1) {
    app.store.appendMessage(id, {
      role: "user",
      text: i % 2 === 0 ? "取消这张的收藏" : "这张收作表情",
      quote: { messageId, text: "看这个" },
    });
  }
  // 再走一轮，让收藏重新算一次。
  const turn = await app.request("POST", "/turns", { json: { agentId: id, text: "随便说句", watching: true, clientMessageId: "many_000002" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === turn.body.messageId, "伙伴那条回复");
  const first = metaOf(app, attachmentId).collection;
  assert.equal(first.sticker, false, "最后一条是退收藏，旧的赠送不许翻回来");
  assert.equal(first.sourceMessageId?.startsWith("m_"), true);
  // 再走一轮：状态不变，也不该反复写回。
  const again = await app.request("POST", "/turns", { json: { agentId: id, text: "再说一句", watching: true, clientMessageId: "many_000003" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === again.body.messageId, "伙伴那条回复");
  const second = metaOf(app, attachmentId).collection;
  assert.equal(second.at, first.at, "同一份决定不重写");
  assert.equal(second.sticker, false);
});

test("旧的赠送话滚出窗口后，墓碑不会被复活；后来明确再收一次仍然生效", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId, messageId } = await sendImage(app, id, "这张给你做表情包", "revive_000001");
  const remove = app.store.appendMessage(id, { role: "user", text: "取消这张的收藏", quote: { messageId, text: "看这个" } });
  const first = await app.request("POST", "/turns", { json: { agentId: id, text: "先说一句", watching: true, clientMessageId: "revive_000002" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === first.body.messageId, "伙伴那条回复");
  assert.equal(metaOf(app, attachmentId).collection.sticker, false, "先退收藏");
  // 退订那句话被撤回了：历史里那条旧的赠送也不许把墓碑翻回来。
  app.store.patchMessage(id, remove.id, { recalled: true, recallMode: "hard" });
  const second = await app.request("POST", "/turns", { json: { agentId: id, text: "再说一句", watching: true, clientMessageId: "revive_000003" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === second.body.messageId, "伙伴那条回复");
  assert.equal(metaOf(app, attachmentId).collection.sticker, false, "旧的赠送翻不动墓碑");
  // 后来她明确又收一次：照样生效。
  app.store.appendMessage(id, { role: "user", text: "这张收作表情", quote: { messageId, text: "看这个" } });
  const third = await app.request("POST", "/turns", { json: { agentId: id, text: "再一句", watching: true, clientMessageId: "revive_000004" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === third.body.messageId, "伙伴那条回复");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true, "后来明确收作要生效");
});

test("源消息真的滚出聊天记录后：工具照样挂着，收藏能翻到也能重发", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "这张给你做表情包", "gone_000001");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true);
  // 同属主、但本体不在盘上的假收藏：不能进候选，也不能被翻出来。
  fs.writeFileSync(path.join(attachmentsDir(app), "img_nobody_1.json"), JSON.stringify({
    id: "img_nobody_1", agentId: id, name: "没本体", mimeType: "image/png", size: 1,
    at: new Date().toISOString(), lastSeenAt: new Date().toISOString(), collection: { sticker: true },
  }, null, 2));
  // 源消息真的不在聊天记录里了（是滚出去，不是撤回）。
  const cleared = await app.request("POST", `/thread/${id}/clear`, { json: {} });
  assert.equal(cleared.status, 200);
  assert.equal(reopenThread(app.dataDir, id).length, 0, "聊天记录里真的没有那条了");

  const turn = await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}甩我看看`, watching: true, clientMessageId: "gone_000002" } });
  assert.equal(turn.status, 200);
  // 没有附件历史了，翻旧图的工具照样挂着。
  const call = await pendingCall(app, (req) => Array.isArray(req.tools) && req.tools.some((tool) => tool.name === "find_image"), "翻旧图的工具");
  assert.match(call.request.systemPrompt, new RegExp(attachmentId), "候选里仍有那张收藏");
  assert.doesNotMatch(call.request.systemPrompt, /img_nobody_1/, "缺本体的收藏不能进候选");
  // 让伙伴真的调一次工具。
  call.resolve({
    ndjson: [
      JSON.stringify({ type: "tool-call", id: "call_find_1", name: "find_image", arguments: {} }),
      JSON.stringify({ type: "done", requestId: "req_find_1", stopReason: "toolUse", assistant: { role: "assistant", content: [] } }),
    ].join("\n") + "\n",
    asEvent: true,
  });
  const after = await pendingCall(app, (req) => JSON.stringify(req.messages ?? []).includes(attachmentId), "工具结果那轮");
  assert.match(JSON.stringify(after.request.messages), new RegExp(attachmentId), "工具结果里要能看到那张收藏");
  assert.doesNotMatch(JSON.stringify(after.request.messages), /img_nobody_1/, "缺本体的收藏不能被翻出来");
  // 伙伴据此把那张旧图当表情重发。
  after.resolve({ ndjson: `[旧图:{"id":"${attachmentId}","as":"sticker"}]` });
  const reply = await waitFor(app, id, (row) => row.role === "assistant" && row.imageReuse, "伙伴那条旧图");
  assert.equal(reply.imageReuse.attachmentId, attachmentId, "滚出聊天记录也照样重发成功");
  assert.equal(reply.attachment, undefined);
});

test("原图那一行被撤回：收回去的图不再发出去", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId, messageId } = await sendImage(app, id, "看这个", "recall_000001");
  app.store.appendMessage(id, { role: "user", text: "这张给你做表情包", quote: { messageId, text: "看这个" } });
  const first = await app.request("POST", "/turns", { json: { agentId: id, text: "随便一句", watching: true, clientMessageId: "recall_000002" } });
  await waitFor(app, id, (row) => row.role === "assistant" && row.repliedTo === first.body.messageId, "伙伴那条回复");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true, "先收着");
  // 原图那一行被撤回了：收回去的图不再当候选，也不再发得出去。
  app.store.patchMessage(id, messageId, { recalled: true, recallMode: "hard" });
  const before = assistantRows(app, id).length;
  app.models.rules.length = 0;
  app.models.answer(req => JSON.stringify(req.messages ?? []).includes(TURN), `[旧图:{"id":"${attachmentId}","as":"sticker"}]`);
  const second = await app.request("POST", "/turns", { json: { agentId: id, text: `把${TURN}甩我看看`, watching: true, clientMessageId: "recall_000003" } });
  assert.equal(second.status, 200);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(assistantRows(app, id).length, before, "撤回去的图不该再发出来");
});

test("彻底删除伙伴时，收藏的旧图也跟着带走", async t => {
  const app = await boot(t);
  const id = app.partner.id;
  const { attachmentId } = await sendImage(app, id, "这张给你做表情包", "purge_000001");
  assert.equal(metaOf(app, attachmentId).collection.sticker, true);
  const purged = await app.request("POST", `/settings/partner/${id}/purge`, { json: {} });
  assert.equal(purged.status, 200);
  assert.equal(fs.existsSync(path.join(attachmentsDir(app), `${attachmentId}.bin`)), false, "彻底删除伙伴要带走收藏");
});
