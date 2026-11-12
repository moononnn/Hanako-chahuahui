import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { pickPartnerSkin, SWITCH_CHANCE, SKIN_MIN_WEAR_MS, SKIN_MAX_WEAR_MS } from "../lib/bubble-skin-mood.js";
import { skinsForMood } from "../lib/bubble-skins.js";
import { dayKey } from "../lib/days.js";
import { daySeed } from "../lib/sleep.js";
import { bootChahuahui } from "./helpers/app-harness.js";
const NOW = new Date("2026-11-12T04:00:00.000Z"), DAY = 24 * 60 * 60_000;
const mood = (id = "calm") => ({ moodId: id, date: dayKey(NOW), settledAt: NOW.toISOString() });
const book = (age = 8 * DAY) => ({ skin: "polka", moodId: "calm", dayKey: dayKey(NOW), pickedAt: new Date(NOW.getTime() - age).toISOString() });
function agentFor(stay) {
  for (let i = 0; i < 1000; i++) {
    const id = `fixture_${i}`;
    if ((daySeed(NOW, `bubble-skin:${id}`) >= SWITCH_CHANCE) === stay) return id;
  }
  throw new Error("没有找到固定种子样本");
}
test("长期兼容的旧款不再永久锁死，旧规则今天已检查也能迁出", () => {
  const before = book();
  const result = pickPartnerSkin(before, { mood: mood(), now: NOW, agentId: agentFor(true) });
  assert.equal(result.changed, true); assert.notEqual(result.skin, "polka");
  assert.ok(skinsForMood("calm").includes(result.skin));
  assert.equal(result.book.pickedAt, NOW.toISOString());
  assert.deepEqual(before, book(), "不原地改调用者账本");
});
test("适合心情且尚未穿满三天时保留原样，不按日历每天换", () => {
  for (const age of [0, DAY, SKIN_MIN_WEAR_MS - 1]) {
    const before = { ...book(age), dayKey: "2026-11-11" };
    const result = pickPartnerSkin(before, { mood: mood(), now: NOW, agentId: agentFor(false) });
    assert.equal(result.skin, "polka"); assert.equal(result.changed, false);
    assert.equal(result.book.pickedAt, before.pickedAt);
  }
});
test("三至七天按固定日种子允许换或保留，换时排除原款", () => {
  for (const stay of [false, true]) {
    const result = pickPartnerSkin(book(SKIN_MIN_WEAR_MS), { mood: mood(), now: NOW, agentId: agentFor(stay) });
    assert.equal(result.changed, !stay);
    assert.equal(result.skin === "polka", stay);
    const repeated = pickPartnerSkin(book(SKIN_MIN_WEAR_MS), { mood: mood(), now: NOW, agentId: agentFor(stay) });
    assert.deepEqual(repeated, result, "未改账时重复检查也不能重抽");
  }
});
test("穿满一周有其他合适候选时即轮换，不再被保留概率拦住", () => {
  const result = pickPartnerSkin(book(SKIN_MAX_WEAR_MS), { mood: mood(), now: NOW, agentId: agentFor(true) });
  assert.equal(result.changed, true); assert.notEqual(result.skin, "polka");
});
test("当天实际换过后，反复读取和不同种子都不会再换", () => {
  const first = pickPartnerSkin(book(), { mood: mood(), now: NOW, agentId: agentFor(true) });
  for (let i = 0; i < 20; i++) {
    const next = pickPartnerSkin(first.book, { mood: mood("happy"), now: NOW, agentId: `another_${i}` });
    assert.equal(next.skin, first.skin); assert.equal(next.changed, false);
  }
});
test("没有心情或没有对应皮肤时不凑变化，仍保留长期旧款", () => {
  for (const day of [null, { moodId: "calm" }, mood("hurt"), mood("angry")]) {
    const result = pickPartnerSkin(book(), { mood: day, now: NOW, agentId: "fixture" });
    assert.equal(result.skin, "polka"); assert.equal(result.changed, false);
  }
});
test("旧账缺少、损坏或未来计时锚点时从现在起算，不假装穿满一周", () => {
  for (const pickedAt of [null, "broken", "2099-01-01T00:00:00.000Z"]) {
    const result = pickPartnerSkin({ ...book(), pickedAt }, { mood: mood(), now: NOW, agentId: "fixture" });
    assert.equal(result.changed, false); assert.equal(result.skin, "polka");
    assert.equal(result.book.pickedAt, NOW.toISOString());
  }
});
test("无效皮肤即便记了今天也不阻止首次选用合法样式", () => {
  const result = pickPartnerSkin({ ...book(), skin: "not-a-skin" }, { mood: mood(), now: NOW, agentId: "fixture" });
  assert.ok(skinsForMood("calm").includes(result.skin)); assert.equal(result.changed, true);
});
test("真apply读接口会保存新样式且重读不再换，不碰自己一侧或别的伙伴，不调模型", async t => {
  const app = await bootChahuahui({ seed(store) {
    const now = new Date();
    store.setGlobalSettings({ bubbleSkin: "star" });
    store.savePartnerMood("nova", { moodId: "calm", date: dayKey(now), settledAt: now.toISOString() });
    store.savePartnerSkinBook("nova", { skin: "polka", moodId: "calm", dayKey: dayKey(now), pickedAt: new Date(now.getTime() - 8 * DAY).toISOString() });
    store.savePartnerSkinBook("other", { skin: "bear", moodId: "calm", dayKey: dayKey(now), pickedAt: now.toISOString() });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const result = await app.request("GET", "/bubble-skin/partner/nova");
  assert.equal(result.status, 200); assert.notEqual(result.body.skin, "polka");
  assert.equal((await app.request("GET", "/bubble-skin/partner/nova")).body.skin, result.body.skin);
  assert.equal(app.store.getPartnerSkinBook("nova").skin, result.body.skin);
  assert.equal(app.store.getPartnerSkinBook("other").skin, "bear");
  assert.equal(app.store.getGlobalSettings().bubbleSkin, "star");
  assert.equal(app.models.calls.length, 0); assert.equal("moodId" in result.body, false);
});
test("真apply会持久化旧账的计时补齐，后续轮询不会不断重置起点", async t => {
  const app = await bootChahuahui({ seed(store) {
    const now = new Date();
    store.savePartnerMood("nova", { moodId: "calm", date: dayKey(now), settledAt: now.toISOString() });
    store.savePartnerSkinBook("nova", { skin: "polka", moodId: "calm", dayKey: dayKey(now), pickedAt: null });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  await app.request("GET", "/bubble-skin/partner/nova");
  const first = app.store.getPartnerSkinBook("nova"); assert.ok(first.pickedAt);
  await app.request("GET", "/bubble-skin/partner/nova");
  assert.deepEqual(app.store.getPartnerSkinBook("nova"), first);
});
