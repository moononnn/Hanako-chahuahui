/**
 * 茶话会自己的一天（天气 + 节日）测试。
 *
 * 守四件事：
 *   1. 节日认的是茶话会自己的节日表，不借拾光记；
 *   2. 天气没填地点就不查，查不到就是没有，不猜也不拿旧缓存冒充今天；
 *   3. 查过一次就进缓存，第二次不再出去问网络；
 *   4. 天气事件是从预报里挑出来的，值得留意的才留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOwnDayText,
  buildOwnFestivalResponseText,
  buildOwnDayContext,
  ownFestivalHasHint,
  ownFestivalOf,
  ownFestivals,
  ownWeather,
  ownWeatherEvents,
  ownWeatherReady,
  probeOwnWeather,
  takeFestivalHint,
  weatherSettings,
  weatherStoreAdapter,
} from "../lib/day-context.js";

/** 一个够用的假 store：设置 + 全局运行态。 */
function fakeStore(settings = {}, runtime = {}) {
  const state = { settings: { ...settings }, runtime: { global: { ...runtime } } };
  return {
    state,
    getGlobalSettings: () => ({ ...state.settings }),
    setGlobalSettings: (patch) => {
      state.settings = { ...state.settings, ...(patch ?? {}) };
      return state.getGlobalSettings();
    },
    getGlobalRuntime: () => ({ ...state.runtime.global }),
    setGlobalRuntime: (patch) => {
      state.runtime.global = { ...state.runtime.global, ...(patch ?? {}) };
      return state.runtime.global;
    },
  };
}

const CURRENT_JSON = {
  current: { temperature_2m: 18.4, weather_code: 61, is_day: 1, time: "2026-10-31T08:00" },
  daily: { weather_code: [61], temperature_2m_max: [20], temperature_2m_min: [14] },
};

const FORECAST_JSON = {
  timezone: "Asia/Shanghai",
  utc_offset_seconds: 28800,
  hourly: {
    time: ["2026-10-31T08:00", "2026-10-31T09:00", "2026-10-31T10:00"],
    temperature_2m: [18, 18, 12],
    apparent_temperature: [18, 18, 11],
    weather_code: [61, 61, 65],
    precipitation_probability: [80, 80, 90],
    wind_gusts_10m: [10, 10, 12],
  },
  daily: {
    time: ["2026-10-31", "2026-11-01"],
    weather_code: [61, 65],
    temperature_2m_max: [20, 16],
    temperature_2m_min: [14, 10],
    precipitation_probability_max: [80, 90],
    wind_gusts_10m_max: [12, 14],
  },
};

function fakeFetcher(seen = []) {
  return async (url) => {
    seen.push(url);
    if (String(url).includes("forecast_days=2")) return FORECAST_JSON;
    return CURRENT_JSON;
  };
}

test("节日表是茶话会自己的：重阳节认得出来，普通日子不硬凑", () => {
  const chongyang = new Date(2026, 9, 18, 9, 0, 0);
  assert.equal(ownFestivalOf(chongyang), "重阳节");
  assert.ok(ownFestivals(chongyang).some((row) => row.name === "重阳节"));
  // 十月三十一日没有表里的节日：就该是空串，不拿别的日子充数。
  const plain = new Date(2026, 9, 31, 9, 0, 0);
  assert.equal(ownFestivalOf(plain), "");
  assert.equal(ownFestivalHasHint("重阳节"), true);
  assert.equal(ownFestivalHasHint("寒露"), false);
});

test("没填地点就不查天气：开关开着也没用", () => {
  assert.equal(ownWeatherReady({ weatherEnabled: true, weatherLocation: "" }), false);
  assert.equal(ownWeatherReady({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区" }), true);
  assert.equal(ownWeatherReady({ weatherEnabled: false, weatherLocation: "四川 成都 武侯区" }), false);
});

test("天气查不到就是没有，不抛也不瞎编", async () => {
  const store = fakeStore({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区" });
  const result = await ownWeather({ store, fetcher: async () => { throw new Error("断网"); }, now: new Date(2026, 9, 31, 8, 0, 0) });
  assert.equal(result, null);
});

test("查到一次就进缓存，第二次不再出去问网络", async () => {
  const store = fakeStore({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区" });
  const seen = [];
  const fetcher = fakeFetcher(seen);
  const now = new Date(2026, 9, 31, 8, 0, 0);
  const first = await ownWeather({ store, fetcher, now });
  assert.ok(first?.line, "第一次应该查到天气");
  const callsAfterFirst = seen.length;
  const second = await ownWeather({ store, fetcher, now });
  assert.ok(second?.line);
  assert.equal(seen.length, callsAfterFirst, "缓存命中就不该再发请求");
});

test("天气事件从预报里挑：值得留意的才留，且带上人话标签", async () => {
  const store = fakeStore({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区", weatherAlertEnabled: true });
  const events = await ownWeatherEvents({
    store,
    fetcher: fakeFetcher(),
    now: new Date(2026, 9, 31, 8, 0, 0),
  });
  assert.ok(events.length > 0);
  assert.ok(events.every((row) => row.key && row.facts.length));
  assert.ok(events.some((row) => row.kind === "rain" || row.kind === "severe"));
});

test("今天这一段：只摊事实，不写规矩", () => {
  const text = buildOwnDayText({
    weather: { line: "小雨，淅淅沥沥，18°C", temp: 18 },
    festivals: [{ name: "重阳节" }],
    workday: false,
  });
  assert.match(text, /【今天】/);
  assert.match(text, /今天是：重阳节。/);
  assert.match(text, /窗外：/);
  assert.match(text, /别逐项播报/);

  assert.equal(buildOwnDayText({}), "");
  assert.equal(buildOwnFestivalResponseText({ festival: "" }), "");
  const festival = buildOwnFestivalResponseText({ festival: "重阳节", userName: "玥儿" });
  assert.match(festival, /【节日回应】今天是重阳节。/);
  assert.match(festival, /玥儿/);
});

test("节日意象抽过就不重复抽", () => {
  const store = fakeStore();
  const first = takeFestivalHint(store, "重阳节");
  const second = takeFestivalHint(store, "重阳节");
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test("天气缓存挂在茶话会自己的账本上，不写拾光记那份", () => {
  const store = fakeStore({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区" });
  const adapter = weatherStoreAdapter(store);
  assert.equal(adapter.getWeatherCache(), null);
  assert.match(adapter.getSettings().weatherLocation, /成都/);
  adapter.setWeatherCache({ location: "四川 成都 武侯区", fetchedAt: 1, result: { line: "晴" } });
  assert.equal(store.getGlobalRuntime().weatherCache.result.line, "晴");
  assert.equal(adapter.getWeatherCache().location, "四川 成都 武侯区");
});

test("设置口径：默认开着、间隔三小时；地点只认她自己填的", () => {
  const settings = weatherSettings({});
  assert.equal(settings.weatherEnabled, true);
  assert.equal(settings.weatherIntervalHours, 3);
  assert.equal(settings.weatherForecastIntervalHours, 1);
  assert.equal(settings.weatherLocation, "");
});

test("试一下天气：认得的区县按中心点查，通就报结果", async () => {
  const seen = [];
  const result = await probeOwnWeather({
    area: { code: "510107" },
    fetcher: fakeFetcher(seen),
    now: new Date(2026, 9, 31, 8, 0, 0),
  });
  assert.equal(result.ok, true);
  assert.match(result.place, /武侯区/);
  assert.ok(result.line);
  assert.equal(seen.length, 1, "认得区县就不用再查地名");
});

test("试一下天气：没选地方、没网络、查不到，都要说清楚而不是装作没事", async () => {
  const none = await probeOwnWeather({ fetcher: fakeFetcher() });
  assert.equal(none.ok, false);
  assert.match(none.error, /还没选地方/);

  const noNet = await probeOwnWeather({ area: { code: "510107" }, fetcher: null });
  assert.equal(noNet.ok, false);
  assert.match(noNet.error, /网络能力/);

  const broken = await probeOwnWeather({
    area: { code: "510107" },
    fetcher: async () => { throw new Error("断网"); },
    now: new Date(2026, 9, 31, 8, 0, 0),
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.error);
});

test("一天那一摊：天气查不到也照样把节日给出去", async () => {
  const store = fakeStore({ weatherEnabled: true, weatherLocation: "四川 成都 武侯区" });
  const context = await buildOwnDayContext({
    store,
    fetcher: async () => { throw new Error("断网"); },
    now: new Date(2026, 9, 18, 9, 0, 0),
    userName: "玥儿",
  });
  assert.equal(context.festival, "重阳节");
  assert.match(context.dayText, /重阳节/);
  assert.match(context.festivalText, /重阳节/);
  assert.equal(context.weather, null);
});
