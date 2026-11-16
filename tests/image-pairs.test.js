import test from "node:test";
import assert from "node:assert/strict";
import { activeImagePairs, createImagePairHandler, formatImagePairPrompt, isFreshPairReply, registerImagePairTool } from "../lib/image-pairs.js";

const A = "img_alpha", B = "img_beta";
const bind = { action: "bind", agentId: "nova", userImageId: A, partnerImageId: B, name: "同构图碰杯", meaning: "一人一张大杯子，互相碰杯，也能故意装傻逗对方。", confirm: true };
function fixture() {
  const metas = [A, B].map((id) => ({ id, agentId: "nova", at: "2026-01-01T00:00:00Z", collection: {} }));
  const messages = metas.map((meta, i) => ({ id: `message_${i}`, role: "user", attachment: { id: meta.id } }));
  let writes = 0;
  const options = {
    listPartners: async () => [{ id: "nova" }],
    getMetas: (agentId) => metas.filter((meta) => meta.agentId === agentId && !meta.missing && !meta.purgedAt),
    getMessages: () => messages,
    saveCollection: (_agentId, id, patch) => { writes++; const meta = metas.find((row) => row.id === id); meta.collection = { ...meta.collection, ...patch }; return meta; },
    now: () => 1780000000000,
  };
  return { metas, messages, options, handle: createImagePairHandler(options), writes: () => writes };
}

test("正式工具绑定、回读、幂等：发送者与画中角色各自保存", async () => {
  const f = fixture();
  let tool;
  registerImagePairTool({ tools: { register: (value) => { tool = value; } } }, f.options);
  assert.equal(tool.name, "chahuahui_image_pair");
  const call = async (input) => JSON.parse((await tool.execute({ ...input, context: { ignored: true } })).content[0].text);
  assert.equal((await call(bind)).verified, true);
  const read = await call({ action: "read", agentId: "nova" });
  assert.equal(read.pairs[0].userImageId, A);
  assert.equal(read.pairs[0].partnerImageId, B);
  assert.equal(f.metas[0].collection.sourceRole, "user");
  assert.equal(f.metas[1].collection.sourceRole, "user");
  assert.equal(f.metas[1].collection.pair.character, "partner");
  assert.equal(f.metas[1].collection.sourceMessageId, "", "不捏造赠送原话");
  const before = JSON.stringify(f.metas);
  assert.equal((await call(bind)).alreadyBound, true);
  assert.equal(f.writes(), 2);
  assert.equal(JSON.stringify(f.metas), before);
});

test("输入和权限边界完整校验后才写任一图片", async () => {
  for (const patch of [
    { confirm: false }, { confirm: "true" }, { agentId: "unknown" }, { agentId: "../nova" },
    { partnerImageId: A }, { userImageId: [A] }, { userImageId: "../bad" }, { name: "" }, { meaning: "x\ny" }, { extra: true },
  ]) {
    const f = fixture();
    assert.equal((await f.handle({ ...bind, ...patch })).ok, false, JSON.stringify(patch));
    assert.equal(f.writes(), 0);
  }
  for (const mutate of [
    (f) => { f.metas[1].missing = true; },
    (f) => { f.metas[1].agentId = "other"; },
    (f) => { f.metas[1].purgedAt = "2026-01-01"; },
    (f) => { f.messages[1].recalled = true; },
    (f) => { f.metas[1].collection.pair = { otherId: "img_other" }; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await f.handle(bind)).ok, false);
    assert.equal(f.writes(), 0);
  }
});

test("单边写失败不构成有效暗号，原样重试可补完", async () => {
  const f = fixture();
  const save = f.options.saveCollection;
  f.options.saveCollection = (agentId, id, patch) => id === B ? null : save(agentId, id, patch);
  const fail = await createImagePairHandler(f.options)(bind);
  assert.equal(fail.ok, false);
  assert.deepEqual(activeImagePairs(f.metas, f.messages), []);
  f.options.saveCollection = save;
  assert.equal((await createImagePairHandler(f.options)(bind)).verified, true);
});

test("取消、撤回、来源缺行与串伙伴的配对状态", async () => {
  const f = fixture(); await f.handle(bind);
  assert.equal(activeImagePairs(f.metas, []).length, 1, "历史缺行不等于撤回");
  f.metas[1].collection.sticker = false;
  assert.equal(activeImagePairs(f.metas, f.messages).length, 0);
  f.metas[1].collection.sticker = true;
  f.messages[0].recalled = true;
  assert.equal(activeImagePairs(f.metas, f.messages).length, 0);
  f.messages[0].recalled = false;
  f.metas[1].agentId = "other";
  assert.equal(activeImagePairs(f.metas, f.messages).length, 0);
});

test("来回能接另一张，同一来信不能被回复和主动轮重复接", async () => {
  const f = fixture(); await f.handle(bind);
  const pairs = activeImagePairs(f.metas, []);
  const rows = [{ role: "assistant", imageReuse: { attachmentId: B } }, { role: "user", attachment: { id: A } }];
  assert.equal(isFreshPairReply(pairs, rows, B), true);
  assert.equal(isFreshPairReply(pairs, rows, A), false);
  rows.push({ role: "assistant", imageReuse: { attachmentId: B } });
  assert.equal(isFreshPairReply(pairs, rows, B), false);
  rows.push({ role: "user", attachment: { id: A } });
  assert.equal(isFreshPairReply(pairs, rows, B), true);
  rows.push({ role: "user", attachment: { id: B } });
  assert.equal(isFreshPairReply(pairs, rows, A), true);
  rows.push({ role: "user", text: "普通闲聊" });
  assert.equal(isFreshPairReply(pairs, rows, A), false);
});

test("配对提示提供共同含义、角色和历史，不设置正确答案或固定台词", async () => {
  const f = fixture(); await f.handle(bind);
  const prompt = formatImagePairPrompt(activeImagePairs(f.metas), [{ role: "user", attachment: { id: B }, at: "2026-01-01" }]);
  assert.ok(prompt.includes(bind.meaning));
  assert.match(prompt, /userImageId.*img_alpha/);
  assert.match(prompt, /partnerImageId.*img_beta/);
  assert.match(prompt, /不固定台词、不打分/);
  assert.match(prompt, /latestUserImageId.*img_beta/);
  assert.match(prompt, /主动聊天/);
  assert.equal(formatImagePairPrompt([], []), "");
});
