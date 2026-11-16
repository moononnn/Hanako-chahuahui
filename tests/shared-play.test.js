import test from "node:test";
import assert from "node:assert/strict";

import {
  SHARED_PLAY_MAX_ENTRIES,
  applySharedPlay,
  extractSharedPlay,
  forgetSharedPlaySource,
  normalizeSharedPlay,
  sharedPlayBook,
  sharedPlayPairId,
  sharedPlayPrompt,
} from "../lib/shared-play.js";

const USER_MSG = { id: "m_u1", role: "user", text: "这只猫打喷嚏的样子笑死我了" };
const ASSISTANT_MSG = { id: "m_a1", role: "assistant", text: "我那张猫在旁边翻白眼" };
const MATERIALS = [USER_MSG, ASSISTANT_MSG];
/** 下一轮她又说了一句：新的证据得用新的那条消息。 */
const NEXT_USER_MSG = { id: "m_u2", role: "user", text: "你又拿那只猫来接梗啦" };
const NEXT_MATERIALS = [...MATERIALS, NEXT_USER_MSG];
const LAST_USER_MSG = { id: "m_u3", role: "user", text: "行吧这个梗就到这里" };
const LAST_MATERIALS = [...NEXT_MATERIALS, LAST_USER_MSG];
const RESTORE_USER_MSG = { id: "m_u4", role: "user", text: "这个梗咱们接着玩吧" };
const RESTORE_MATERIALS = [...LAST_MATERIALS, RESTORE_USER_MSG];
const QUOTE = "这只猫打喷嚏的样子笑死我了";
const NEXT_QUOTE = "你又拿那只猫来接梗啦";

function tag(updates) {
  return `<shared-play>${JSON.stringify({ updates })}</shared-play>`;
}

function learn(extra = {}) {
  return {
    op: "learn",
    title: "猫猫打喷嚏",
    meaning: "她发猫打喷嚏，我发猫翻白眼",
    imageIds: ["img_a"],
    evidence: [{ sourceId: USER_MSG.id, quote: QUOTE }],
    ...extra,
  };
}

test("不用她说「这是梗」也能学：材料里的那点东西够就学", () => {
  const raw = `哈哈哈${tag([learn()])}`;
  const out = extractSharedPlay(raw, [], MATERIALS, ["img_a"]);
  assert.equal(out.updates.length, 1);
  assert.equal(out.updates[0].op, "learn");
  assert.equal(out.updates[0].title, "猫猫打喷嚏");
  assert.equal(out.updates[0].id.startsWith("play_"), true, "learn 的 id 由程序生成");
  assert.equal(out.updates[0].evidence[0].quote, QUOTE, "引语逐字保留");
  assert.equal(out.updates[0].evidence[0].role, "user");
  assert.equal(out.text, "哈哈哈", "标记与内部 JSON 都不许漏进聊天");
});

test("文字梗、单图、三张图都认：图不能超过六张，也不能是不存在的编号", () => {
  const none = extractSharedPlay(tag([learn({ imageIds: [] })]), [], MATERIALS, ["img_a"]);
  assert.equal(none.updates.length, 1, "纯文字的梗允许");
  assert.deepEqual(none.updates[0].imageIds, []);

  const one = extractSharedPlay(tag([learn({ imageIds: ["img_a"] })]), [], MATERIALS, ["img_a"]);
  assert.deepEqual(one.updates[0].imageIds, ["img_a"]);

  const three = extractSharedPlay(tag([learn({ imageIds: ["img_a", "img_b", "img_c"] })]), [], MATERIALS, ["img_a", "img_b", "img_c"]);
  assert.deepEqual(three.updates[0].imageIds, ["img_a", "img_b", "img_c"]);

  const tooMany = extractSharedPlay(tag([learn({ imageIds: ["img_a", "img_b", "img_c", "img_d", "img_e", "img_f", "img_g"] })]), [], MATERIALS, ["img_a", "img_b", "img_c", "img_d", "img_e", "img_f", "img_g"]);
  assert.equal(tooMany.updates.length, 0, "超过六张不收");

  const bad = extractSharedPlay(tag([learn({ imageIds: ["not_an_image"] })]), [], MATERIALS, ["img_a"]);
  assert.equal(bad.updates.length, 0, "编号不合法不收");
});

test("别的伙伴的图不能用", () => {
  const out = extractSharedPlay(tag([learn({ imageIds: ["img_foreign"] })]), [], MATERIALS, ["img_a"]);
  assert.equal(out.updates.length, 0, "不在可用集合里的图不收");
});

test("证据得是材料里真有的原话：编的来源与编的引语都不认", () => {
  const fakeSource = extractSharedPlay(tag([learn({ evidence: [{ sourceId: "m_ghost", quote: QUOTE }] })]), [], MATERIALS, ["img_a"]);
  assert.equal(fakeSource.updates.length, 0, "材料里没有的消息不算证据");

  const fakeQuote = extractSharedPlay(tag([learn({ evidence: [{ sourceId: USER_MSG.id, quote: "她根本没说过的句子" }] })]), [], MATERIALS, ["img_a"]);
  assert.equal(fakeQuote.updates.length, 0, "不是逐字原话的不算证据");

  const emptyQuote = extractSharedPlay(tag([learn({ evidence: [{ sourceId: USER_MSG.id, quote: "  " }] })]), [], MATERIALS, ["img_a"]);
  assert.equal(emptyQuote.updates.length, 0, "空引语不算");

  const onlyPartner = extractSharedPlay(tag([learn({ evidence: [{ sourceId: ASSISTANT_MSG.id, quote: "我那张猫在旁边翻白眼" }] })]), [], MATERIALS, ["img_a"]);
  assert.equal(onlyPartner.updates.length, 0, "伙伴自己说的话不能替她确认一个点");
});

test("坏标记只剥不写：JSON 坏了、半截的、落单的结束标签都不许漏进聊天", () => {
  const broken = extractSharedPlay('前面<shared-play>{"updates":[坏掉的</shared-play>后面', [], MATERIALS, ["img_a"]);
  assert.equal(broken.updates.length, 0);
  assert.equal(broken.text.includes("坏掉的"), false, "半截 JSON 不能漏进聊天");
  assert.equal(broken.text.includes("shared-play"), false);

  const half = extractSharedPlay('前面<shared-play>{"updates":[{"op":"learn"', [], MATERIALS, ["img_a"]);
  assert.equal(half.updates.length, 0);
  assert.equal(half.text, "前面", "半截标记之后的内容全丢");
  for (const bad of ['前面<shared-play {"updates":[]}', '前面<shared-play x="bad">{"updates":[]}</shared-play>']) {
    const result = extractSharedPlay(bad, [], MATERIALS, ["img_a"]);
    assert.equal(result.text, "前面", "坏开标签同样不能把内部JSON漏出去");
    assert.deepEqual(result.updates, []);
  }

  const stray = extractSharedPlay('前面</shared-play>后面', [], MATERIALS, ["img_a"]);
  assert.equal(stray.updates.length, 0);
  assert.equal(stray.text, "前面后面");

  const notJson = extractSharedPlay('前面<shared-play>不是 JSON</shared-play>后面', [], MATERIALS, ["img_a"]);
  assert.equal(notJson.updates.length, 0);
  assert.equal(notJson.text, "前面后面");

  const noUpdates = extractSharedPlay('前面<shared-play>{"foo":1}</shared-play>后面', [], MATERIALS, ["img_a"]);
  assert.equal(noUpdates.updates.length, 0);
  assert.equal(noUpdates.text, "前面后面");
});

test("一轮最多三项", () => {
  const many = [learn(), learn({ title: "第二个" }), learn({ title: "第三个" }), learn({ title: "第四个" })];
  const out = extractSharedPlay(tag(many), [], MATERIALS, ["img_a"]);
  assert.equal(out.updates.length, 3);
});

test("学到一条：先是猜的；再被接住一次才算一起玩过", () => {
  const out = extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]);
  const rows = applySharedPlay([], out.updates, { resultMessageId: "r1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "guess", "刚学的只是猜的");
  assert.equal(rows[0].corrected, false);
  assert.equal(rows[0].revision, 0);
  assert.equal(rows[0].resultMessageIds.includes("r1"), true);
  assert.equal(rows[0].dirty, true, "改过的才要落盘");

  const book = rows;
  const again = extractSharedPlay(tag([{ op: "reinforce", id: book[0].id, revision: 0, evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }] }]), book, NEXT_MATERIALS, ["img_a"]);
  assert.equal(again.updates.length, 1);
  const after = applySharedPlay(book, again.updates, { resultMessageId: "r2" });
  assert.equal(after[0].state, "familiar", "被接住一次才算一起玩过");
  assert.equal(after[0].meaning, book[0].meaning, "reinforce 不改意思");
  assert.equal(after[0].revision, 1);

  // 同一条证据已经用过：重复的 reinforce 不再落一次。
  const repeat = extractSharedPlay(tag([{ op: "reinforce", id: book[0].id, revision: 0, evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }] }]), book, NEXT_MATERIALS, ["img_a"]);
  const afterRepeat = applySharedPlay(after, repeat.updates, { resultMessageId: "r3" });
  assert.equal(afterRepeat[0].revision, 1, "版本已经动过，旧的 reinforce 不再落");
});

test("版本对不上就不改：旧的 revise/stop 不能落在新版本上", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const id = learned[0].id;
  const stale = extractSharedPlay(tag([{ op: "stop", id, revision: 0, evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }] }]), learned, NEXT_MATERIALS, ["img_a"]);
  assert.equal(stale.updates.length, 1, "修订时那条书里的版本就是要改的版本");
  const fixed = extractSharedPlay(tag([{ op: "stop", id, revision: 5, evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }] }]), learned, NEXT_MATERIALS, ["img_a"]);
  assert.equal(fixed.updates.length, 0, "版本对不上不收");
  const unchanged = applySharedPlay(learned, fixed.updates, { resultMessageId: "r2" });
  assert.equal(unchanged[0].state, "guess");
});

test("修订改意思并标成改过；停止留墓碑，旧 learn 复活不了", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const id = learned[0].id;
  const revised = extractSharedPlay(tag([{
    op: "revise", id, revision: 0, title: "猫猫打喷嚏（改）", meaning: "其实是她打喷嚏我拍的",
    imageIds: ["img_b"], evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }],
  }]), learned, NEXT_MATERIALS, ["img_a", "img_b"]);
  assert.equal(revised.updates.length, 1);
  const afterRevise = applySharedPlay(learned, revised.updates, { resultMessageId: "r2" });
  assert.equal(afterRevise[0].title, "猫猫打喷嚏（改）");
  assert.equal(afterRevise[0].corrected, true);
  assert.deepEqual(afterRevise[0].imageIds, ["img_b"]);
  assert.equal(afterRevise[0].revision, 1);

  // 旧的 learn（同来源同图）不能再建一条。
  const again = extractSharedPlay(tag([learn()]), afterRevise, MATERIALS, ["img_a"]);
  assert.equal(again.updates.length, 0, "同来源同图不许重复建，要用 revise");

  const stopped = extractSharedPlay(tag([{ op: "stop", id, revision: 1, evidence: [{ sourceId: LAST_USER_MSG.id, quote: "行吧这个梗就到这里" }] }]), afterRevise, LAST_MATERIALS, ["img_a", "img_b"]);
  const afterStop = applySharedPlay(afterRevise, stopped.updates, { resultMessageId: "r3" });
  assert.equal(afterStop[0].state, "stopped");
  assert.equal(afterStop[0].corrected, true);
  assert.equal(afterStop[0].title, "猫猫打喷嚏（改）", "停掉不是删掉：留着才知道禁的是哪一句");
  assert.equal(afterStop[0].meaning, "其实是她打喷嚏我拍的");
  assert.ok(afterStop[0].sourceIds.includes(LAST_USER_MSG.id), "停用的那句也要留着当依据");

  // 停掉之后，旧 learn 也复活不了。
  const revive = extractSharedPlay(tag([learn()]), afterStop, MATERIALS, ["img_a"]);
  assert.equal(revive.updates.length, 0, "停掉的条目不许被旧 learn 复活");
});
test("同一条更新落两次也不会改两遍", () => {
  const out = extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]);
  const once = applySharedPlay([], out.updates, { resultMessageId: "r1" });
  const twice = applySharedPlay(once, out.updates, { resultMessageId: "r2" });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].revision, 0, "重复的更新不再落一次");
  assert.deepEqual(twice[0].resultMessageIds, ["r1"]);
});

test("存过的条目压过配对投影出来的老条目；纠正与停止把老配对压住", () => {
  const pair = { userImageId: "img_u", partnerImageId: "img_p", name: "猫猫打喷嚏", meaning: "她打喷嚏我翻白眼" };
  const pairId = sharedPlayPairId("img_u", "img_p");
  const book = sharedPlayBook([], [pair]);
  assert.equal(book.length, 1);
  assert.equal(book[0].id, pairId);
  assert.equal(book[0].state, "familiar");
  assert.equal(book[0].legacy, true);
  assert.deepEqual(book[0].pair, { userImageId: "img_u", partnerImageId: "img_p" });

  // 保存过的同 id 胜出。
  const saved = [{ id: pairId, title: "我自己改过的", meaning: "改过的意思", imageIds: ["img_u", "img_p"], state: "familiar", revision: 3, corrected: true }];
  const merged = sharedPlayBook(saved, [pair]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "我自己改过的");
  assert.equal(merged[0].revision, 3);

  // 停掉的老配对不再露出来。
  const stopped = [{ id: "play_x", title: "", meaning: "", imageIds: ["img_u"], state: "stopped", revision: 1, corrected: true }];
  const guarded = sharedPlayBook(stopped, [pair]);
  assert.equal(guarded.length, 1, "只留停掉的那条");
  assert.equal(guarded[0].id, "play_x");
});

test("提示词给出 id、版本、材料的原话与附件编号，也说清画里是谁", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const prompt = sharedPlayPrompt(learned, [
    { id: "m_u2", role: "user", text: "刚那张图真好笑", attachment: { id: "img_a" } },
    ASSISTANT_MSG,
  ]);
  assert.match(prompt, /\[play_[0-9a-f]+\]/u);
  assert.match(prompt, /rev0/u, "要给模型版本号，它才知道改哪一条");
  assert.match(prompt, /你自己猜的，还没确认/u, "猜的不能当既成事实");
  assert.match(prompt, /m_u2/u);
  assert.match(prompt, /刚那张图真好笑/u, "材料给的是原话");
  assert.match(prompt, /附件 img_a/u);
  assert.match(prompt, /不用等她说「这是梗」/u);
  assert.match(prompt, /她没接话、换了话题，都不算她不认这个点/u, "别把没接话当成她不认");
  assert.match(prompt, /发送者不等于画里的人/u);
  assert.match(prompt, /一轮最多 3 项/u);

  const pair = { userImageId: "img_u", partnerImageId: "img_p", name: "猫猫", meaning: "一起打喷嚏", characters: { user: "user", partner: "partner" } };
  const pairPrompt = sharedPlayPrompt(sharedPlayBook([], [pair]), MATERIALS);
  assert.match(pairPrompt, /img_u（画里是她）/u);
  assert.match(pairPrompt, /img_p（画里是伙伴）/u);
  assert.doesNotMatch(pairPrompt, /画里是谁不确定/u, "配对数据给了角色就别装不知道");
});

test("配对角色只在图还是那两张时留着；改成别的图就不再说那一对", () => {
  const pair = { userImageId: "img_u", partnerImageId: "img_p", name: "猫猫", meaning: "一起打喷嚏" };
  const book = sharedPlayBook([], [pair]);
  const id = book[0].id;
  const revised = extractSharedPlay(tag([{
    op: "revise", id, revision: 0, title: "猫猫", meaning: "换了张图", imageIds: ["img_x"],
    evidence: [{ sourceId: USER_MSG.id, quote: QUOTE }],
  }]), book, MATERIALS, ["img_x"]);
  const after = applySharedPlay(book, revised.updates, { resultMessageId: "r1" });
  assert.equal(after[0].pair, undefined, "图换了就不再是原来那一对");
  assert.doesNotMatch(sharedPlayPrompt(after, MATERIALS), /成对的/u);
});

test("原话被撤回：靠它立起来的玩法一起停掉，旧猜法复活不了", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const forgotten = forgetSharedPlaySource(learned, USER_MSG.id);
  assert.equal(forgotten[0].state, "stopped");
  assert.equal(forgotten[0].corrected, true);
  assert.equal(forgotten[0].title, "", "撤回的原话不留下来");
  assert.equal(forgotten[0].meaning, "");
  const again = extractSharedPlay(tag([learn()]), forgotten, MATERIALS, ["img_a"]);
  assert.equal(again.updates.length, 0, "撤回后的旧点子不许再立一条");
});

test("书还是空的也不拦首用：照样给材料与协议；不学的时候才没话说", () => {
  const firstUse = sharedPlayPrompt([], MATERIALS);
  assert.match(firstUse, /【这一轮能参考的原话】/u);
  assert.match(firstUse, /m_u1/u);
  assert.match(firstUse, /一轮最多 3 项/u);
  assert.match(firstUse, /不用等她说「这是梗」/u);
  assert.equal(sharedPlayPrompt([], MATERIALS, { learn: false }), "", "不学的时候没东西可说");
});

test("材料带附件编号与描述；她最后发的那张图最相关", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const prompt = sharedPlayPrompt(learned, [
    { id: "m_u2", role: "user", text: "这张真好笑", attachment: { id: "img_a", description: "一只打喷嚏的猫" } },
  ]);
  assert.match(prompt, /附件 img_a/u);
  assert.match(prompt, /图：一只打喷嚏的猫/u, "把图原本的描述也给模型");

  // 她最后发的那张图最相关：候选按它排。
  const other = applySharedPlay([], extractSharedPlay(tag([learn({ title: "另一条", imageIds: ["img_b"] })]), [], MATERIALS, ["img_b"]).updates, { resultMessageId: "r2" });
  const both = sharedPlayPrompt([...learned, ...other], [
    { id: "m_u3", role: "user", text: "这张", attachment: { id: "img_b" } },
  ]);
  assert.match(both, /另一条/u);
  assert.ok(both.indexOf("另一条") < both.indexOf("猫猫打喷嚏"), "她最后发的那张要排在前面");
});

test("老式条目第一次落盘：靠 base 投影一次，再真改", () => {
  const pair = { name: "猫猫打喷嚏", meaning: "她打喷嚏我翻白眼", userImageId: "img_u", partnerImageId: "img_p", at: Date.parse("2026-10-01T00:00:00Z") };
  const book = sharedPlayBook([], [pair]);
  const target = book[0];
  const revised = extractSharedPlay(tag([{
    op: "revise", id: target.id, revision: 0, title: "猫猫打喷嚏（改）", meaning: "改过的意思",
    imageIds: ["img_u", "img_p"], evidence: [{ sourceId: USER_MSG.id, quote: QUOTE }],
  }]), book, MATERIALS, ["img_u", "img_p"]);
  assert.equal(revised.updates.length, 1);
  assert.ok(revised.updates[0].base, "老式条目要带完整的原目标");
  assert.equal(revised.updates[0].base.id, target.id);
  assert.equal(revised.updates[0].base.pair.userImageId, "img_u");

  // existing 是空的：靠 base 投影一次，落成改过的。
  const rows = applySharedPlay([], revised.updates, { resultMessageId: "r1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, target.id);
  assert.equal(rows[0].title, "猫猫打喷嚏（改）");
  assert.equal(rows[0].revision, 1);
  assert.equal(rows[0].legacy, true);
  assert.equal(rows[0].dirty, true, "落盘那层靠这个标记挑要存的那一条");

  // stop 也一样能投影一次。
  const stopped = extractSharedPlay(tag([{ op: "stop", id: target.id, revision: 0, evidence: [{ sourceId: USER_MSG.id, quote: QUOTE }] }]), book, MATERIALS, ["img_u", "img_p"]);
  assert.ok(stopped.updates[0].base, "stop 也要带 base");
  const stoppedRows = applySharedPlay([], stopped.updates, { resultMessageId: "r2" });
  assert.equal(stoppedRows[0].state, "stopped");
  assert.equal(stoppedRows[0].dirty, true);
});

test("模型的话在路上时别的回合已改过：晚到的旧 learn 不许写进去", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const corrected = applySharedPlay(learned, extractSharedPlay(tag([{
    op: "revise", id: learned[0].id, revision: 0, title: "改过的", meaning: "改过的意思",
    imageIds: ["img_a"], evidence: [{ sourceId: NEXT_USER_MSG.id, quote: NEXT_QUOTE }],
  }]), learned, NEXT_MATERIALS, ["img_a"]).updates, { resultMessageId: "r2" });
  assert.equal(corrected[0].corrected, true);

  // 这条 learn 是另一个 id，但来源与图跟已改过的那条重叠：不能顶进去。
  const late = extractSharedPlay(tag([learn({ title: "另一个说法" })]), corrected, NEXT_MATERIALS, ["img_a"]);
  assert.equal(late.updates.length, 0, "同来源同图的旧 learn 在校验那层就被挡");
  const rows = applySharedPlay(corrected, late.updates, { resultMessageId: "r3" });
  assert.equal(rows.length, 1, "落盘那层也要再挡一次");
});

test("停掉的：提示词说得清禁的是哪一句，同一句不许再学", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const stopped = extractSharedPlay(tag([{ op: "stop", id: learned[0].id, revision: 0, evidence: [{ sourceId: LAST_USER_MSG.id, quote: "行吧这个梗就到这里" }] }]), learned, LAST_MATERIALS, ["img_a"]);
  const afterStop = applySharedPlay(learned, stopped.updates, { resultMessageId: "r2" });
  assert.equal(afterStop[0].state, "stopped");
  const prompt = sharedPlayPrompt(afterStop, LAST_MATERIALS);
  assert.match(prompt, /猫猫打喷嚏/u, "停了也要让模型知道禁的是哪一句");
  assert.match(prompt, /她明确说要恢复的时候，才用 revise/u);
  const again = extractSharedPlay(tag([learn()]), afterStop, LAST_MATERIALS, ["img_a"]);
  assert.equal(again.updates.length, 0, "同一句不许再学一遍");
});

test("她明确要恢复的时候，revise 能把停掉的放回来；reinforce 不能；旧版本不行", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const stopped = applySharedPlay(learned, extractSharedPlay(tag([{ op: "stop", id: learned[0].id, revision: 0, evidence: [{ sourceId: LAST_USER_MSG.id, quote: "行吧这个梗就到这里" }] }]), learned, LAST_MATERIALS, ["img_a"]).updates, { resultMessageId: "r2" });
  assert.equal(stopped[0].state, "stopped");

  // reinforce 解除不了停止。
  const reinforce = extractSharedPlay(tag([{ op: "reinforce", id: learned[0].id, revision: 1, evidence: [{ sourceId: RESTORE_USER_MSG.id, quote: "这个梗咱们接着玩吧" }] }]), stopped, RESTORE_MATERIALS, ["img_a"]);
  assert.equal(reinforce.updates.length, 0, "reinforce 不许解除停止");
  assert.equal(applySharedPlay(stopped, reinforce.updates, { resultMessageId: "r3" })[0].state, "stopped");

  // 旧版本也复活不了。
  const stale = extractSharedPlay(tag([{ op: "revise", id: learned[0].id, revision: 0, title: "改回来", meaning: "改回来", imageIds: ["img_a"], evidence: [{ sourceId: RESTORE_USER_MSG.id, quote: "这个梗咱们接着玩吧" }] }]), stopped, RESTORE_MATERIALS, ["img_a"]);
  assert.equal(stale.updates.length, 0, "旧版本不能复活");

  // 新证据的 revise 才算数。
  const restore = extractSharedPlay(tag([{ op: "revise", id: learned[0].id, revision: 1, title: "这个梗继续玩", meaning: "她要继续玩", imageIds: ["img_a"], evidence: [{ sourceId: RESTORE_USER_MSG.id, quote: "这个梗咱们接着玩吧" }] }]), stopped, RESTORE_MATERIALS, ["img_a"]);
  assert.equal(restore.updates.length, 1);
  const restored = applySharedPlay(stopped, restore.updates, { resultMessageId: "r4" });
  assert.equal(restored[0].state, "guess", "明确恢复后重新当作猜的");
  assert.equal(restored[0].title, "这个梗继续玩");
});

test("撤回后再读同一条撤回消息：不再加版本、不再写盘", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  const once = forgetSharedPlaySource(learned, USER_MSG.id);
  assert.equal(once[0].state, "stopped");
  assert.equal(once[0].title, "");
  assert.equal(once[0].sourceIds.includes(USER_MSG.id), false, "撤回的来源要去掉");
  assert.equal(once[0].seenSourceIds.includes(USER_MSG.id), false);
  assert.equal(once[0].resultMessageIds.length, 0, "对应的结果引用一起去掉");
  const twice = forgetSharedPlaySource(once, USER_MSG.id);
  assert.equal(twice[0].revision, once[0].revision, "重复撤回不动版本");
  assert.equal(twice[0].dirty, undefined, "重复撤回不再写盘");
});

test("dirty 是这一轮的临时标记，不进长期账本；legacy 标识留着", () => {
  const learned = applySharedPlay([], extractSharedPlay(tag([learn()]), [], MATERIALS, ["img_a"]).updates, { resultMessageId: "r1" });
  assert.equal(learned[0].dirty, true, "落盘那层靠它挑要存的");
  const stored = normalizeSharedPlay(learned);
  assert.equal(stored[0].dirty, undefined, "重新读出来时不再带 dirty");
  const pair = { name: "x", meaning: "y", userImageId: "img_u", partnerImageId: "img_p", at: Date.parse("2026-10-01T00:00:00Z") };
  const legacy = sharedPlayBook([], [pair]);
  assert.equal(legacy[0].legacy, true, "legacy 标识要留着");
  assert.equal(normalizeSharedPlay(legacy)[0].legacy, true);
  assert.equal(legacy[0].updatedAt, "2026-10-01T00:00:00.000Z", "投影的时间从配对的 at 来");
});

test("脏数据进来也能读成能用的样子，纠正与停止的记录不因上限被删掉", () => {
  const rows = normalizeSharedPlay([
    { id: "a", title: "  猫猫  ", meaning: "x".repeat(500), imageIds: ["img_a", "img_a", "bad"], sourceIds: ["m1"], state: "weird", revision: -3 },
    { id: "", title: "没编号的不收" },
    null,
    { id: "b", state: "stopped", corrected: true, imageIds: ["img_b"] },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.id === "b"), "停止的记录不因上限被挤掉");
  const one = rows.find((row) => row.id === "a");
  assert.equal(one.title, "猫猫");
  assert.equal(one.meaning.length, 400, "意思截到上限");
  assert.deepEqual(one.imageIds, ["img_a"], "去重且只留合法编号");
  assert.equal(one.state, "guess", "不认识的state回默认");
  assert.equal(one.revision, 0);

  const many = Array.from({ length: SHARED_PLAY_MAX_ENTRIES + 5 }, (_, index) => ({ id: `p${index}`, updatedAt: new Date(2026, 0, 1, 0, index % 60).toISOString() }));
  const capped = normalizeSharedPlay([...many, { id: "old_stop", state: "stopped", corrected: true, updatedAt: "2020-01-01T00:00:00.000Z" }]);
  assert.equal(capped.length, SHARED_PLAY_MAX_ENTRIES + 1, "上限之外还留着那条停止的墓碑");
  assert.ok(capped.some((row) => row.id === "old_stop"));
});

test("满了不新增，也不删掉老的纠正", () => {
  const filled = Array.from({ length: SHARED_PLAY_MAX_ENTRIES }, (_, index) => ({ id: `p${index}`, title: `第${index}条`, updatedAt: new Date(2026, 0, 1).toISOString() }));
  const out = extractSharedPlay(tag([learn()]), filled, MATERIALS, ["img_a"]);
  assert.equal(out.updates.length, 1, "校验照过，写不写得下由落盘那层定");
  const rows = applySharedPlay(filled, out.updates, { resultMessageId: "r1" });
  assert.equal(rows.length, SHARED_PLAY_MAX_ENTRIES, "满了不新增");
  assert.ok(rows.some((row) => row.id === "p0"), "老的纠正一条都不删");
});

test("旧玩法可凭含义里的词唤回，不必逐字说出标题", () => {
  const old = { id: "old_spaceship", title: "重型航母", meaning: "纸袋宇宙飞船是我们的加班逃跑信号", state: "guess", updatedAt: "2020-01-01T00:00:00.000Z" };
  const recent = Array.from({ length: 10 }, (_, index) => ({ id: `recent_${index}`, title: `无关项目${index}`, meaning: "其他内容", updatedAt: "2026-01-01T00:00:00.000Z" }));
  const prompt = sharedPlayPrompt([old, ...recent], [{ id: "latest", role: "user", text: "今天又开纸袋宇宙飞船了" }]);
  assert.match(prompt, /old_spaceship/);
  assert.match(prompt, /主动聊天里先抛/);
});
