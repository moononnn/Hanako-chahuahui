/**
 * 茶话会自己的一天：天气、节日、节日回应。
 *
 * 这一层不借拾光记：节日表是茶话会自己的，天气也是茶话会自己查、自己记。
 * 拾光记那条路（lib/daybook.js）还留着当补充——两边都开着时，同一件事以这边的为准，
 * 免得伙伴对着两份「今天是中秋」各说一遍。
 *
 * 四条规矩：
 *   1. 只摊事实，不替伙伴决定该不该说。节日说没说出口，由聊天历史约束。
 *   2. 天气查不到就是没有。不猜，也不拿昨天的缓存冒充今天。
 *   3. 失败一律安静收场：天气挂了、节日表读不出来，聊天照常走。
 *   4. 一天一次：节日问候按天记账，谁说过谁就不再提。
 *
 * 天气数据源用 Open-Meteo（免费、不用密钥），行政区分表照搬拾光记那份，
 * 缓存落在茶话会自己的账本里（runtime.global），不落明文文件。
 */

import { dateKey } from "./clock.js";
import { getBuiltinFestivals, isWorkday } from "./festivals.js";
import { getFestivalHintPool, pickFestivalHint } from "./festival-hints.js";
import { formatAdministrativeRegion, getAdministrativeRegion } from "./administrative-divisions.js";
import { collectWeatherEvents, KIND_LABELS } from "./weather-alert.js";
import {
  ensureWeatherForecastFresh,
  ensureWeatherFresh,
  extractCity,
  fetchWeather,
  geocode,
  resolveWeatherLocation,
  translateWeatherToMood,
} from "./weather.js";

/** 有专属节日意象的那一批。跟日子账本认的是同一批节日，不另立一套。 */
export const OWN_FESTIVAL_NAMES = new Set([
  "中秋节", "春节", "元宵节", "端午节", "七夕", "情人节", "儿童节", "元旦", "国庆节", "平安夜", "跨年夜", "重阳节",
]);

/** 天气缓存默认三小时一换；预报一换一小时（提醒要看得见接下来）。 */
const DEFAULT_WEATHER_INTERVAL_HOURS = 3;
const DEFAULT_FORECAST_INTERVAL_HOURS = 1;
/** 同步等待的上限：查不动就当没有，不让一条消息卡在这儿。 */
const WEATHER_WAIT_MS = 5000;

/**
 * 天气那几项设置。跟拾光记同一套口径：地点、区县、刷新间隔。
 * 没填地点就等于没开——天气是她的所在地，不是我们猜的。
 */
export function weatherSettings(globalSettings = {}) {
  const hours = Number(globalSettings.weatherIntervalHours);
  const forecastHours = Number(globalSettings.weatherForecastIntervalHours);
  return {
    weatherEnabled: globalSettings.weatherEnabled !== false,
    weatherLocation: String(globalSettings.weatherLocation ?? "").trim(),
    weatherArea: globalSettings.weatherArea ?? null,
    weatherIntervalHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WEATHER_INTERVAL_HOURS,
    weatherForecastIntervalHours: Number.isFinite(forecastHours) && forecastHours > 0
      ? forecastHours
      : DEFAULT_FORECAST_INTERVAL_HOURS,
    weatherAlertEnabled: globalSettings.weatherAlertEnabled !== false,
  };
}

/** 天气模块要的那套存取接口，接到茶话会自己的账本上。 */
export function weatherStoreAdapter(store) {
  return {
    getSettings: () => weatherSettings(store.getGlobalSettings()),
    getWeatherCache: () => store.getGlobalRuntime().weatherCache ?? null,
    setWeatherCache: async (payload) => {
      store.setGlobalRuntime({ weatherCache: payload });
    },
    getWeatherForecastCache: () => store.getGlobalRuntime().weatherForecastCache ?? null,
    setWeatherForecastCache: async (payload) => {
      store.setGlobalRuntime({ weatherForecastCache: payload });
    },
  };
}

/** 天气这一项现在到底能不能用：开着、并且她填了地点。 */
export function ownWeatherReady(globalSettings = {}) {
  const settings = weatherSettings(globalSettings);
  if (settings.weatherEnabled === false) return false;
  return Boolean(resolveWeatherLocation(settings).location);
}

/**
 * 茶话会自己的当前天气。
 * @returns {Promise<{place?:string,line?:string,temp?:number}|null>} 查不到就是 null
 */
export async function ownWeather({ store, fetcher = null, now = new Date(), timeoutMs = WEATHER_WAIT_MS } = {}) {
  if (!store) return null;
  const settings = weatherSettings(store.getGlobalSettings());
  if (settings.weatherEnabled === false) return null;
  if (!resolveWeatherLocation(settings).location) return null;
  const data = weatherStoreAdapter(store);
  try {
    const result = await ensureWeatherFresh({ data, settings, now, fetcher, timeoutMs });
    if (!result?.line) return null;
    return { place: result.place || settings.weatherLocation, line: result.line, temp: result.temp ?? null };
  } catch {
    return null;
  }
}

/**
 * 今天值得留意的那几件天气事（降温、降水、阵风、恶劣天气）。
 * 跟播报分开：播报说的是「现在什么样」，这里说的是「接下来会变」。
 * @returns {Promise<object[]>} 没有就空数组
 */
export async function ownWeatherEvents({ store, fetcher = null, now = new Date(), timeoutMs = WEATHER_WAIT_MS } = {}) {
  if (!store) return [];
  const settings = weatherSettings(store.getGlobalSettings());
  if (settings.weatherEnabled === false || settings.weatherAlertEnabled === false) return [];
  if (!resolveWeatherLocation(settings).location) return [];
  const data = weatherStoreAdapter(store);
  try {
    const current = await ensureWeatherFresh({ data, settings, now, fetcher, timeoutMs });
    const payload = await ensureWeatherForecastFresh({ data, settings, now, fetcher, timeoutMs });
    // 预报入口给的是一份带缓存信息的壳，真正要判的是壳里那份预报本身。
    const forecast = payload?.forecast ?? null;
    if (!forecast) return [];
    const events = collectWeatherEvents({
      forecast,
      now,
      currentTemp: Number.isFinite(current?.temp) ? current.temp : null,
      settings,
    });
    return events.map((event) => ({ ...event, label: KIND_LABELS[event.kind] || "天气有变化" }));
  } catch {
    return [];
  }
}

/** 今天是什么日子（茶话会自己的节日表）。 */
export function ownFestivals(now = new Date()) {
  try {
    return getBuiltinFestivals(now).map((row) => ({
      name: String(row.name || ""),
      emoji: String(row.emoji || ""),
      kind: String(row.kind || ""),
    }));
  } catch {
    return [];
  }
}

/** 今天那个该说出口的节日。没有就是空串——不是所有节日都要开口。 */
export function ownFestivalOf(now = new Date()) {
  const list = ownFestivals(now);
  const hit = list.find((row) => OWN_FESTIVAL_NAMES.has(row.name));
  return hit ? hit.name : "";
}

/** 今天的节日名里，有没有带专属意象池的（有池子才谈得上「一句意象」）。 */
export function ownFestivalHasHint(name) {
  return Boolean(getFestivalHintPool(String(name || "")));
}

/**
 * 抽一条节日意象。抽过的先不重复抽，都抽过就从头轮。
 * 抽中就记下来——意象库落在茶话会自己的账本里。
 */
export function takeFestivalHint(store, festival) {
  const name = String(festival || "").trim();
  if (!store || !name) return "";
  const book = store.getGlobalRuntime().festivalHints ?? {};
  const picked = pickFestivalHint(name, Array.isArray(book[name]) ? book[name] : []);
  if (!picked) return "";
  store.setGlobalRuntime({
    festivalHints: { ...book, [name]: picked.nextUsed },
  });
  return picked.text;
}

/**
 * 试一下这条路走不走得通：拿当前选的地方真去查一次天气，把结果原样报回来。
 *
 * 不写缓存、不改设置、也不碰已保存的地点——只是告诉她「查得到 / 查不到」。
 * @param {object} opts
 *   area { code } 选中的区县（认得就按区县中心点查）
 *   location 文字地点（没选区县时按城市查）
 *   fetcher 宿主网络能力
 * @returns {Promise<{ok:boolean, place?:string, line?:string, temp?:number, error?:string}>}
 */
export async function probeOwnWeather({ area = null, location = "", fetcher = null, now = new Date() } = {}) {
  const code = String(area?.code ?? "").trim();
  const region = code ? getAdministrativeRegion(code) : null;
  const raw = String(location ?? "").trim();
  const place = region ? formatAdministrativeRegion(region) : raw;
  if (!place) return { ok: false, error: "还没选地方，先选省份和城市" };
  if (typeof fetcher !== "function") return { ok: false, error: "宿主网络能力不可用，查不了" };
  try {
    let coordinates = region ? { lat: region.latitude, lon: region.longitude } : null;
    if (!coordinates) {
      const geo = await geocode(extractCity(place), fetcher, null);
      if (!geo) return { ok: false, error: "这个地方没认出来，换个区县试试" };
      coordinates = { lat: geo.lat, lon: geo.lon };
    }
    const payload = await fetchWeather(coordinates.lat, coordinates.lon, fetcher, null);
    const mood = payload ? translateWeatherToMood(payload, now) : null;
    if (!mood) return { ok: false, error: "天气接口没回话（网络不通，或这个地点查不到）" };
    return { ok: true, place, line: mood.line, temp: mood.temp ?? null };
  } catch (error) {
    return { ok: false, error: `查天气失败：${String(error?.message || error).slice(0, 120)}` };
  }
}

/**
 * 拼给伙伴看的那一段「今天」。
 * 跟日子账本那段一个口径：讲事实，不讲规矩；只说今天有什么，不催她怎么样。
 * @returns {string} 没有可说的就空串
 */
export function buildOwnDayText({ weather = null, festivals = [], workday = false } = {}) {
  const facts = [];
  const names = (Array.isArray(festivals) ? festivals : [])
    .map((row) => (typeof row === "string" ? row : row?.name))
    .filter(Boolean);
  if (names.length) facts.push(`今天是：${names.join("、")}。`);
  if (workday) facts.push("今天她那边是调休上班日。");
  if (weather?.line) {
    facts.push(`窗外：${weather.line}${Number.isFinite(weather.temp) ? `（${weather.temp}°C）` : ""}`);
  }
  if (!facts.length) return "";
  return [
    "【今天】",
    ...facts,
    "（这是背景，别逐项播报；只在自然相关的时候带一句。）",
  ].join("\n");
}

/**
 * 节日回应的分寸。跟日子账本那套一个写法，不另起一套腔调：
 * 轻轻带一句就好，不问她怎么过，也不替她安排情绪。
 */
export function buildOwnFestivalResponseText({ festival, userName = "她" } = {}) {
  const name = String(festival || "").trim();
  if (!name) return "";
  const person = String(userName || "她").trim() || "她";
  return [
    `【节日回应】今天是${name}。如果这段茶话会聊天里还没有给${person}送过这个节日的祝福或相关意象，先回应${person}眼前的话，再在答完后自然地轻轻带一句祝福和一个具体意象；提过一次就算完成，不要重复。`,
    "别问她怎么过、和谁过、回不回家；不预设团聚、节日食物或眼前景象，也不说“大家都在”。意象可以是文化联想、祝愿或将来的条件式想象；没有事实依据，不说此刻亲眼看见、吃到或经历了什么。语气平和，不庆祝过头；她不接或明确不想聊，就自然转开。",
  ].join("\n");
}

/**
 * 把今天这一摊收成一份：节日、天气、节日回应，外加今天是不是调休上班日。
 * 任何一步拿不到就少一段，绝不因为天气查不到就把节日也一起吞了。
 *
 * @returns {Promise<{dayText:string, festivalText:string, festival:string, weather:object|null}>}
 */
export async function buildOwnDayContext({ store, fetcher = null, now = new Date(), userName = "她", withWeather = true } = {}) {
  const festivals = ownFestivals(now);
  const festival = ownFestivalOf(now);
  let weather = null;
  if (withWeather) {
    weather = await ownWeather({ store, fetcher, now });
  }
  const dayText = buildOwnDayText({
    weather,
    festivals,
    workday: isWorkday(now),
  });
  const festivalText = buildOwnFestivalResponseText({ festival, userName });
  return { dayText, festivalText, festival, weather };
}

/** 今天这一天（给外部记账用，跟公共事件那层同一个日子口径）。 */
export function ownDayKey(now = new Date()) {
  return dateKey(now);
}
