import test from "node:test";
import assert from "node:assert/strict";
import { applySharedPlay, extractSharedPlay, forgetSharedPlaySource, normalizeSharedPlay, sharedPlayBook, sharedPlayPrompt } from "../lib/shared-play.js";
import { buildGuideReconcileSpec } from "../lib/adaptation.js";

const OLD = "img_old", NEW = "img_new", USER = "img_user";
const source = { id: "user_new", role: "user", text: "旧图太丑了，别再用旧的，换这张新的", attachment: { id: NEW } };
const base = normalizeSharedPlay([{ id: "play_versions", title: "纸袋暗号", meaning: "互相发纸袋图表示一起逃跑", imageIds: [USER, OLD], state: "familiar", revision: 2, sourceIds: ["original"], updatedAt: "2026-01-01T00:00:00.000Z" }]);
const tag = (updates) => `<shared-play>${JSON.stringify({ updates })}</shared-play>`;
const prefer = (extra = {}) => ({ op: "prefer", id: base[0].id, revision: 2, imageIds: [NEW], preferredImageIds: [OLD], preferenceNote: "新版画的也是我，但旧版那个欠样更合我意", evidence: [{ sourceId: source.id, quote: "旧图太丑了" }], ...extra });
const extract = (item, book = base) => extractSharedPlay(tag([item]), book, [source], [USER, OLD, NEW]);
const apply = (updates, book = base) => applySharedPlay(book, updates, { resultMessageId: "actual_reply", now: new Date("2026-02-01T00:00:00.000Z") });

test("用户要换新版，伙伴仍可偏爱旧版；新版只是增加选择", () => {
  const parsed = extract(prefer());
  assert.equal(parsed.updates.length, 1);
  const [entry] = apply(parsed.updates);
  assert.deepEqual(entry.imageIds, [USER, OLD, NEW]);
  assert.deepEqual(entry.preferredImageIds, [OLD]);
  assert.equal(entry.meaning, base[0].meaning);
  assert.equal(entry.state, "familiar");
  assert.equal(entry.corrected, false);
  assert.equal(entry.revision, 3);
  const [saved] = normalizeSharedPlay([entry]);
  assert.equal(saved.preferenceNote, entry.preferenceNote);
  assert.deepEqual(saved.preferredImageIds, [OLD]);
});

for (const [name, preferred, note] of [
  ["可以确实更喜欢新版，不统一唱反调", [NEW], "新版眼神更像我，这次换它"],
  ["可以都喜欢，按场合轮着用", [OLD, NEW], "旧版负责欠，新版负责端着"],
  ["也可以都不满意，继续要新图", [], "两版都还没到我的味道，再画一张更得意的"],
]) test(name, () => {
  const [entry] = apply(extract(prefer({ preferredImageIds: preferred, preferenceNote: note })).updates);
  assert.deepEqual(entry.preferredImageIds, preferred);
  assert.equal(entry.preferenceNote, note);
  assert.equal(entry.meaning, base[0].meaning);
});

test("偏好版本校验与重复提交不能覆盖后来的选择", () => {
  const updates = extract(prefer()).updates;
  const once = apply(updates);
  assert.deepEqual(normalizeSharedPlay(apply(updates, once)), normalizeSharedPlay(once));
  assert.deepEqual(extract(prefer({ revision: 1 })).updates, []);
  assert.deepEqual(extract(prefer(), once).updates, []);
});

test("偏好不能借新版本引用外伙伴或不存在的图，也不吃伪造证据", () => {
  for (const invalid of [
    prefer({ imageIds: ["img_foreign"], preferredImageIds: ["img_foreign"] }),
    prefer({ preferredImageIds: ["img_not_in_versions"] }),
    prefer({ imageIds: "img_new" }),
    prefer({ evidence: [{ sourceId: "made_up", quote: "旧图太丑了" }] }),
    prefer({ evidence: [{ sourceId: source.id, quote: "用户最喜欢旧版" }] }),
    prefer({ preferenceNote: "" }),
  ]) assert.deepEqual(extract(invalid).updates, []);
});

test("偏好不解除语义上的停用，复活需要重新修正理解", () => {
  const stopped = [{ ...base[0], state: "stopped" }];
  assert.deepEqual(extract(prefer(), stopped).updates, []);
  const unchanged = apply(extract(prefer()).updates, stopped);
  assert.equal(unchanged[0].state, "stopped");
  assert.equal(unchanged[0].preferenceNote, undefined);
});

test("老人工配对首次也能保存偏爱，多版本去掉二图硬配对但保留已知身份", () => {
  const book = sharedPlayBook([], [{ name: "纸袋", meaning: "互接逃跑", userImageId: USER, partnerImageId: OLD, at: Date.now() }]);
  const update = extract(prefer({ id: book[0].id, revision: 0 }), book).updates;
  const [entry] = apply(update, []);
  assert.deepEqual(entry.preferredImageIds, [OLD]);
  assert.equal(entry.pair, undefined);
  assert.deepEqual(entry.roles, { [USER]: "user", [OLD]: "partner" });
  const prompt = sharedPlayPrompt([entry], [source], { learn: false });
  assert.ok(prompt.includes(entry.preferenceNote));
  assert.ok(prompt.includes(NEW));
  assert.doesNotMatch(prompt, /把另一张甩出来/);
});

test("纠正含义不自动改变审美，去掉的素材不留悬空优选", () => {
  const chosen = apply(extract(prefer()).updates);
  const correction = { id: "user_correction", role: "user", text: "纸袋只表示摸鱼，和逃跑没有关系" };
  const update = extractSharedPlay(tag([{ op: "revise", id: chosen[0].id, revision: 3, title: "纸袋暗号", meaning: "纸袋表示摸鱼", imageIds: [USER, NEW], evidence: [{ sourceId: correction.id, quote: "纸袋只表示摸鱼" }] }]), chosen, [correction], [USER, OLD, NEW]).updates;
  const [entry] = apply(update, chosen);
  assert.equal(entry.meaning, "纸袋表示摸鱼");
  assert.deepEqual(entry.preferredImageIds, []);
  assert.equal(entry.preferenceNote, chosen[0].preferenceNote);
});

test("撤回来源清掉偏好描述；老数据无需迁移", () => {
  const chosen = apply(extract(prefer()).updates);
  const [entry] = forgetSharedPlaySource(chosen, source.id);
  assert.equal(entry.state, "stopped");
  assert.equal(entry.preferenceNote, "");
  assert.deepEqual(entry.preferredImageIds, []);
  assert.equal(base[0].preferenceNote, undefined);
});

test("聊天与主动提示保留自己的偏爱，关系理解器不把图丑升级为硬禁发", () => {
  const chosen = apply(extract(prefer()).updates);
  for (const learn of [true, false]) {
    const prompt = sharedPlayPrompt(chosen, [source], { learn });
    assert.ok(prompt.includes(chosen[0].preferenceNote));
    assert.match(prompt, /审美分歧/);
    assert.match(prompt, /不构成发送白名单/);
  }
  const spec = buildGuideReconcileSpec({ message: source.text });
  assert.match(spec.systemPrompt, /不要生成 sticker.permission 禁发/);
});
