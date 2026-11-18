import test from "node:test";
import assert from "node:assert/strict";

import {
  LIFE_CITY_MAX_LENGTH,
  geocodeLifeCity,
  hasCjk,
  lifeCityBlockers,
  lifeCityReady,
  normalizeLifeCity,
  normalizeStreetViewConsent,
} from "../lib/life-city.js";

test("生活城市：她自己填，空着就是没开", () => {
  assert.equal(normalizeLifeCity("  成都  "), "成都");
  assert.equal(normalizeLifeCity("四川  成都"), "四川 成都");
  assert.equal(normalizeLifeCity(""), "");
  assert.equal(normalizeLifeCity(null), "");
  assert.equal(normalizeLifeCity("x".repeat(80)).length, LIFE_CITY_MAX_LENGTH);
});

test("街景授权只认真布尔：字符串不算开", () => {
  assert.equal(normalizeStreetViewConsent(true), true);
  assert.equal(normalizeStreetViewConsent("true"), false);
  assert.equal(normalizeStreetViewConsent(1), false);
  assert.equal(normalizeStreetViewConsent(undefined), false);
});

test("两个门槛都得过：城市填了、也授权了，这条才开", () => {
  assert.deepEqual(lifeCityBlockers({}), ["no-city", "no-consent"]);
  assert.deepEqual(lifeCityBlockers({ lifeCity: "成都" }), ["no-consent"]);
  assert.deepEqual(lifeCityBlockers({ lifeCity: "成都", lifeCityStreetView: true }), []);
  assert.equal(lifeCityReady({ lifeCity: "成都", lifeCityStreetView: true }), true);
  assert.equal(lifeCityReady({ lifeCity: "", lifeCityStreetView: true }), false);
});

test("中文与英文走不同的检索语言", () => {
  assert.equal(hasCjk("成都"), true);
  assert.equal(hasCjk("Chengdu"), false);
});

test("地理编码：中文用中文那一套，英文用英文那一套", async () => {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    return { results: [{ name: "成都", latitude: 30.67, longitude: 104.07, country: "中国" }] };
  };
  const zh = await geocodeLifeCity("成都", fetcher);
  assert.equal(zh.lat, 30.67);
  assert.match(asked[0], /language=zh/);
  await geocodeLifeCity("Chengdu", fetcher);
  assert.match(asked[1], /language=en/);
  assert.match(asked[1], /name=Chengdu/);
});

test("地理编码查不到就返回空，不报错", async () => {
  assert.equal(await geocodeLifeCity("成都", async () => ({ results: [] })), null);
  assert.equal(await geocodeLifeCity("成都", null), null);
  assert.equal(await geocodeLifeCity("", async () => ({ results: [] })), null);
  let failed = null;
  const result = await geocodeLifeCity("成都", async () => { throw new Error("断了"); }, { onError: (error) => { failed = error; } });
  assert.equal(result, null);
  assert.ok(failed, "失败原因要透出来给上层记日志");
});
