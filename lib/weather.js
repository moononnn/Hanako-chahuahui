// 拾光记 · 天气模块
// 数据源：Open-Meteo（免费、无需 API key，分享版友好）

import {
  findAdministrativeRegion,
  formatAdministrativeRegion,
  getAdministrativeRegion,
} from "./administrative-divisions.js";
// 职责：城市→经纬度（geocoding）、查天气（forecast）、天气→氛围文本（轻量角色扮演方向）
// 设计：缓存由外部（data.js）管理，本模块只做「查」和「翻译」，纯函数可测。

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const WEATHER_FETCH_TIMEOUT_MS = 8000;
const WEATHER_MAX_RESPONSE_BYTES = 1024 * 1024;
let configuredWeatherFetcher = null;

// WMO weather code → 中文氛围描述（含「动作方向」，供助手组织语言，不照抄）
// 参考 https://open-meteo.com/en/docs （wmo codes）
const WMO_MAP = {
  0: "晴空万里，阳光正好",
  1: "大晴天，就是云不多",
  2: "多云，偶尔有云飘过",
  3: "阴天，天灰蒙蒙的",
  45: "有雾，看远处模模糊糊",
  48: "有雾凇，白茫茫一片",
  51: "毛毛雨，细细的飘",
  53: "小雨，淅淅沥沥",
  55: "中雨，雨点密起来了",
  56: "冻毛毛雨，有点冷",
  57: "冻雨，路上要小心滑",
  61: "小雨，得打伞了",
  63: "中雨，雨声哗哗",
  65: "大雨，哗啦哗啦的",
  66: "冻雨，冷飕飕的",
  67: "冻雨，路滑别摔",
  71: "小雪，轻轻的飘",
  73: "中雪，地上白了",
  75: "大雪，雪片大得很",
  77: "米雪，细细碎碎",
  80: "阵雨，一阵一阵的",
  81: "强阵雨，说来就来",
  82: "暴雨，哗的一下",
  85: "阵雪，断断续续",
  86: "强阵雪，雪势不小",
  95: "雷阵雨，轰隆隆的",
  96: "雷阵雨夹冰雹，小心点",
  99: "强雷暴带冰雹，别出门",
};

// 默认（未知 code）兜底
const WMO_DEFAULT = "天气有点变化";

// 接受设置里的 latitude/longitude，也兼容内部调用常用的 lat/lon。
export function normalizeWeatherCoordinates(value) {
  if (!value || typeof value !== "object") return null;
  const rawLat = value.latitude ?? value.lat;
  const rawLon = value.longitude ?? value.lon;
  if (rawLat === "" || rawLat == null || rawLon === "" || rawLon == null) return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// 统一解析当前天气地点。旧版只保存 weatherLocation，新版还保存 weatherArea。
// 未能匹配旧地点时保留原文字，仍可走城市级 Open-Meteo 查询。
export function resolveWeatherLocation(settings = {}) {
  const rawLocation = String(settings.weatherLocation || "").trim();
  const storedCode = settings.weatherArea?.code || settings.weatherRegion?.code;
  const area = getAdministrativeRegion(storedCode) || findAdministrativeRegion(rawLocation);
  const location = area ? formatAdministrativeRegion(area) : rawLocation;
  const coordinates = area
    ? { lat: area.latitude, lon: area.longitude }
    : normalizeWeatherCoordinates(settings.weatherArea || settings.weatherCoordinates);
  return { location, rawLocation, area, coordinates };
}

export function weatherCacheMatches(cache, settings = {}) {
  if (!cache || !cache.result) return false;
  const config = resolveWeatherLocation(settings);
  const locations = new Set([config.location, config.rawLocation].filter(Boolean));
  return locations.has(String(cache.location || "").trim());
}

// 只有在刷新间隔内的缓存才是「当前天气」；缺时间戳或时钟倒退时一律要求重新查询。
export function weatherCacheIsFresh(cache, settings = {}, now = new Date()) {
  if (!cache || !cache.result) return false;
  const fetchedAt = Number(cache.fetchedAt);
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || !Number.isFinite(nowTs)) return false;
  const intervalHours = Number(settings.weatherIntervalHours);
  const intervalMs = (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 3) * 3600 * 1000;
  const age = nowTs - fetchedAt;
  return age >= 0 && age < intervalMs;
}

// 新旧时段都可移除；读出时重新生成，天气事实指纹也用同一口径。
const WEATHER_TIME_SUFFIX_RE = /(?:，(?:清晨刚亮|正午阳光|傍晚时分|天已经黑了|夜色清亮|凌晨时分|清晨时分|上午时分|午间时分|下午时分|夜间时分))+$/;

export function stripWeatherTimeSuffix(line) {
  return String(line || "").trim().replace(WEATHER_TIME_SUFFIX_RE, "");
}

function weatherTimeLabel(now) {
  const hour = now instanceof Date ? now.getHours() : NaN;
  if (!Number.isFinite(hour)) return "";
  if (hour < 5) return "凌晨时分";
  if (hour < 8) return "清晨时分";
  if (hour < 11) return "上午时分";
  if (hour < 14) return "午间时分";
  if (hour < 17) return "下午时分";
  if (hour < 20) return "傍晚时分";
  return "夜间时分";
}

// 先从旧缓存补出观测状态，再按读取时刻重绘措辞；不修改缓存或推算真实日出日落。
export function normalizeWeatherResult(result, now = new Date()) {
  if (!result || typeof result !== "object") return null;
  const normalized = { ...result };
  let line = String(normalized.line || "");
  if (line.includes("阳光正好") && line.includes("天已经黑")) {
    line = line
      .replace("晴空万里，阳光正好", "晴朗")
      .replace("，天已经黑了", "，夜色清亮");
  } else if (line.includes("大晴天，就是云不多") && line.includes("天已经黑")) {
    line = line
      .replace("大晴天，就是云不多", "晴朗，云不多")
      .replace("，天已经黑了", "，夜色清亮");
  }
  if (line) normalized.line = line;

  const hasCode = normalized.code !== "" && normalized.code != null && Number.isFinite(Number(normalized.code));
  if (!hasCode) {
    if (/雷|冰雹/.test(line)) normalized.code = 95;
    else if (/雨/.test(line)) normalized.code = 61;
    else if (/雪|米雪/.test(line)) normalized.code = 73;
    else if (/雾|雾凇/.test(line)) normalized.code = 45;
    else if (/多云|阴天/.test(line)) normalized.code = 2;
    else if (/云不多|大晴天/.test(line)) normalized.code = 1;
    else if (/晴|阳光/.test(line)) normalized.code = 0;
  }
  if (typeof normalized.isDay !== "boolean" && normalized.isDay !== 0 && normalized.isDay !== 1) {
    // null 明确保留“未知”；二次正规化不能根据新加的钟点措辞改写观测状态。
    if (normalized.isDay !== null) {
      if (/天已经黑|夜/.test(line)) normalized.isDay = false;
      else if (/清晨|正午|傍晚/.test(line)) normalized.isDay = true;
      else normalized.isDay = null;
    }
  } else if (normalized.isDay === 0 || normalized.isDay === 1) {
    normalized.isDay = normalized.isDay === 1;
  }
  const facts = stripWeatherTimeSuffix(line)
    .replace("晴空万里，阳光正好", "晴朗")
    .replace("大晴天，就是云不多", "晴朗，云不多");
  const timeLabel = weatherTimeLabel(now);
  if (facts) normalized.line = `${facts}${timeLabel ? `，${timeLabel}` : ""}`;
  return normalized;
}

// 从天气数据里挑出「最值得说」的氛围信息
// 返回 { line, temp, feelsLike }，line 是给助手的一句话方向
export function translateWeatherToMood(data, now = data?.current?.time ? new Date(data.current.time) : new Date()) {
  if (!data || !data.current) return null;
  const code = Number(data.current.weather_code);
  const temp = Math.round(data.current.temperature_2m);
  const isDay = data.current.is_day === 1;

  // 晴天的白天和夜晚用不同意象，避免出现「阳光正好，天已经黑了」的自相矛盾。
  let base = WMO_MAP[code] || WMO_DEFAULT;
  if (code === 0 && isDay) base = "晴空万里，阳光正好";
  if (code === 0 && !isDay) base = "晴朗";
  if (code === 1 && !isDay) base = "晴朗，云不多";

  // 组装一句话：包含「状态 + 温度 + 时段感」，让助手有素材自己发挥
  let line = base;
  if (temp !== null && !isNaN(temp)) {
    line += `，${temp}°C`;
  }
  return normalizeWeatherResult({ line, temp, code, isDay }, now);
}

// 把 Hana 的宿主网络能力适配成天气模块使用的 JSON fetcher。
// 生产调用必须从 ctx.network.fetch 注入；没有宿主网络能力时返回 null，禁止静默走全局 fetch。
export function createWeatherFetcher(network) {
  const fetchMethod = typeof network === "function"
    ? network
    : network && typeof network.fetch === "function"
      ? network.fetch.bind(network)
      : null;
  if (!fetchMethod) return null;
  return async (url, timeoutMs = WEATHER_FETCH_TIMEOUT_MS) => {
    const response = await fetchMethod(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs,
      maxResponseBytes: WEATHER_MAX_RESPONSE_BYTES,
    });
    if (response && typeof response.json === "function") {
      if (response.ok === false) throw new Error(`HTTP ${response.status || "error"}`);
      return response.json();
    }
    // 保留测试 fetcher 直接返回 JSON 对象的轻量契约。
    return response;
  };
}

// 路由注册时注入一次宿主网络能力，供无法拿到插件 ctx 的 Pi 扩展后台刷新使用。
export function configureWeatherNetwork(network) {
  configuredWeatherFetcher = createWeatherFetcher(network);
  return configuredWeatherFetcher;
}

export function getConfiguredWeatherFetcher() {
  return configuredWeatherFetcher;
}

// 城市名 → 经纬度。Open-Meteo geocoding 对中国只到城市级，取第一个结果。
// @param onError 可选失败回调（透出底层错误，供日志/页面定位；不传则保持静默）
// @returns {Promise<{lat:number, lon:number, name:string}|null>}
export async function geocode(city, fetcher, onError) {
  const name = String(city || "").trim();
  if (!name || typeof fetcher !== "function") return null;
  try {
    const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&format=json&language=zh`;
    const json = await fetcher(url, WEATHER_FETCH_TIMEOUT_MS);
    const rows = json && Array.isArray(json.results) ? json.results : [];
    if (!rows.length) return null;
    const r = rows[0];
    if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
    return { lat: r.latitude, lon: r.longitude, name: r.name || name };
  } catch (e) {
    typeof onError === "function" && onError(e); // 失败原因透出（定位用）
    return null;
  }
}

// 经纬度 → 天气。只取当前 + 今日概要（注入只需要"现在的氛围"）
// @param onError 可选失败回调（透出底层错误，供日志/页面定位；不传则保持静默）
// @returns {Promise<object|null>}
export async function fetchWeather(lat, lon, fetcher, onError) {
  const coordinates = normalizeWeatherCoordinates({ lat, lon });
  if (!coordinates || typeof fetcher !== "function") return null;
  try {
    const url =
      `${FORECAST_URL}?latitude=${coordinates.lat}&longitude=${coordinates.lon}` +
      `&current=temperature_2m,weather_code,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&timezone=auto&forecast_days=1`;
    const json = await fetcher(url, WEATHER_FETCH_TIMEOUT_MS);
    if (!json || !json.current) return null;
    return json;
  } catch (e) {
    typeof onError === "function" && onError(e); // 失败原因透出（定位用）
    return null;
  }
}

// ── 预报（天气提醒用）──
// 播报当前天气只需要「现在」，但提前提醒需要看未来：小时预报覆盖接下来 24~48 小时，
// 日预报覆盖今天和明天。预报单独缓存一份，刷新比当前天气快（默认 1 小时），
// 免得「下午三点才发现晚上要变」这种钝感。

const HOURLY_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "weather_code",
  "precipitation_probability",
  "wind_gusts_10m",
];
const DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "wind_gusts_10m_max",
];

// 把 Open-Meteo 的响应裁成只留判定要用的字段，缓存体积小一半。
export function normalizeForecastPayload(json) {
  if (!json || typeof json !== "object") return null;
  const hourly = json.hourly && typeof json.hourly === "object" ? json.hourly : null;
  const daily = json.daily && typeof json.daily === "object" ? json.daily : null;
  if (!hourly && !daily) return null;
  const pickFields = (source, fields) => {
    if (!source) return null;
    const out = {};
    for (const field of fields) {
      out[field] = Array.isArray(source[field]) ? source[field] : [];
    }
    return out;
  };
  return {
    timezone: String(json.timezone || ""),
    utcOffsetSeconds: Number(json.utc_offset_seconds) || 0,
    hourly: pickFields(hourly, HOURLY_FIELDS)
      ? { time: Array.isArray(hourly.time) ? hourly.time : [], ...pickFields(hourly, HOURLY_FIELDS) }
      : null,
    daily: pickFields(daily, DAILY_FIELDS)
      ? { time: Array.isArray(daily.time) ? daily.time : [], ...pickFields(daily, DAILY_FIELDS) }
      : null,
  };
}

/**
 * 查预报：未来小时 + 今天明天的日预报。
 * @returns {Promise<object|null>}
 */
export async function fetchWeatherForecast(lat, lon, fetcher, onError) {
  const coordinates = normalizeWeatherCoordinates({ lat, lon });
  if (!coordinates || typeof fetcher !== "function") return null;
  try {
    const url =
      `${FORECAST_URL}?latitude=${coordinates.lat}&longitude=${coordinates.lon}` +
      `&hourly=${HOURLY_FIELDS.join(",")}` +
      `&daily=${DAILY_FIELDS.join(",")}` +
      `&timezone=auto&forecast_days=2`;
    const json = await fetcher(url, WEATHER_FETCH_TIMEOUT_MS);
    const forecast = normalizeForecastPayload(json);
    if (!forecast) return null;
    return forecast;
  } catch (e) {
    onError ? onError(e) : null;
    return null;
  }
}

// 预报缓存新鲜度：默认 1 小时，比当前天气快。
export function weatherForecastCacheIsFresh(cache, settings = {}, now = new Date()) {
  if (!cache || !cache.forecast) return false;
  const fetchedAt = Number(cache.fetchedAt);
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || !Number.isFinite(nowTs)) return false;
  const intervalHours = Number(settings.weatherForecastIntervalHours);
  const intervalMs = (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 1) * 3600 * 1000;
  const age = nowTs - fetchedAt;
  return age >= 0 && age < intervalMs;
}

export function weatherForecastCacheMatches(cache, settings = {}) {
  if (!cache || !cache.forecast) return false;
  const config = resolveWeatherLocation(settings);
  const locations = new Set([config.location, config.rawLocation].filter(Boolean));
  return locations.has(String(cache.location || "").trim());
}

/**
 * 统一入口：给天气提醒用。读缓存→过期/没有就查→写缓存→返回。
 * @returns {Promise<object|null>} { location, fetchedAt, forecast }
 */
export async function getWeatherForecast({ data, location, coordinates, now = new Date(), fetcher, onError, noCache = false } = {}) {
  const settings = data?.getSettings ? data.getSettings() : {};
  const configured = resolveWeatherLocation(settings);
  const requested = String(location || "").trim();
  const loc = requested || configured.location;
  if (!loc) return null;
  const usesConfigured = !requested || requested === configured.location || requested === configured.rawLocation;
  const requestedCoordinates = normalizeWeatherCoordinates(coordinates);
  const targetCoordinates = requestedCoordinates || (usesConfigured ? configured.coordinates : null);

  if (!noCache && data?.getWeatherForecastCache) {
    const cache = data.getWeatherForecastCache();
    const locationMatches = cache && [loc, configured.location, configured.rawLocation]
      .filter(Boolean)
      .includes(String(cache.location || "").trim());
    if (locationMatches && weatherForecastCacheIsFresh(cache, settings, now)) {
      return cache;
    }
  }

  if (typeof fetcher !== "function") return null;
  const geo = targetCoordinates || await geocode(extractCity(loc), fetcher, onError);
  if (!geo) return null;
  const forecast = await fetchWeatherForecast(geo.lat, geo.lon, fetcher, onError);
  if (!forecast) return null;

  const payload = {
    location: loc,
    coordinates: { lat: geo.lat, lon: geo.lon },
    fetchedAt: now.getTime(),
    forecast,
  };
  if (!noCache && data?.setWeatherForecastCache) {
    try {
      await data.setWeatherForecastCache(payload);
    } catch {
      // 缓存写失败忽略
    }
  }
  return payload;
}

/**
 * 保证手上有一份新鲜预报。命中缓存直接返回，命中不了查一次。
 * 与 ensureWeatherFresh 同款契约，方便注入层统一调用。
 * @returns {Promise<object|null>} { location, fetchedAt, forecast }
 */
export async function ensureWeatherForecastFresh({ data, settings = null, now = new Date(), fetcher, onError, log = null, timeoutMs = 0 } = {}) {
  if (!data) return null;
  let current = settings;
  try {
    current = current || data.getSettings();
    if (current.weatherEnabled === false) return null;
    if (current.weatherAlertEnabled === false) return null;
    const config = resolveWeatherLocation(current);
    if (!config.location) return null;
    const cache = data.getWeatherForecastCache?.();
    if (weatherForecastCacheMatches(cache, current) && weatherForecastCacheIsFresh(cache, current, now)) {
      return cache;
    }
    const net = typeof fetcher === "function" ? fetcher : getConfiguredWeatherFetcher();
    if (typeof net !== "function") return null;
    const task = getWeatherForecast({
      data,
      location: config.location,
      coordinates: config.coordinates,
      now,
      fetcher: net,
      onError,
    });
    const result = timeoutMs > 0 ? await withTimeout(task, timeoutMs) : await task;
    if (result) log?.info?.(`天气预报已刷新：${result.location}`);
    return result;
  } catch (e) {
    onError ? onError(e) : log?.warn?.(`天气预报刷新异常：${String(e?.message || e || "").slice(0, 300)}`);
    return null;
  }
}

// 统一入口：给注入用。负责「读缓存→过期/没有就查→写缓存→返回」
// 由外部传入 data（有 getWeatherCache/setWeatherCache）和 location，便于测试
// @param {object} opts { data, location, coordinates, now, fetcher, onError, noCache } noCache=true 时不读写缓存（测试用）；onError 可选失败回调（透出底层错误供日志/页面定位）
// @returns {Promise<{place:string, line:string, temp:number}|null>} null=没配置/失败
export async function getWeatherForInject({ data, location, coordinates, now = new Date(), fetcher, onError, noCache = false }) {
  const settings = data.getSettings();
  const configured = resolveWeatherLocation(settings);
  const requestedLocation = String(location || "").trim();
  const loc = requestedLocation || configured.location;
  if (!loc) return null;
  const usesConfiguredLocation = !requestedLocation || requestedLocation === configured.location || requestedLocation === configured.rawLocation;
  const requestedCoordinates = normalizeWeatherCoordinates(coordinates);
  const targetCoordinates = requestedCoordinates || (usesConfiguredLocation ? configured.coordinates : null);
  // 缓存有效：同地点 + 未过期（noCache 时跳过读缓存）。旧缓存没有 coordinates 也继续兼容。
  if (!noCache) {
    const cache = data.getWeatherCache();
    const locationMatches = cache && [loc, configured.location, configured.rawLocation]
      .filter(Boolean)
      .includes(String(cache.location || "").trim());
    if (locationMatches && weatherCacheIsFresh(cache, settings, now)) {
      return normalizeWeatherResult(cache.result, now);
    }
  }

  // 新版区县设置直接用中心点；旧版地点仍拆出城市走 Open-Meteo 地名搜索。
  // 无宿主网络能力时 fail-closed，缓存命中仍可正常展示。
  if (typeof fetcher !== "function") return null;
  const geo = targetCoordinates || await geocode(extractCity(loc), fetcher, onError);
  if (!geo) return null;
  const weather = await fetchWeather(geo.lat, geo.lon, fetcher, onError);
  if (!weather) return null;

  const mood = translateWeatherToMood(weather, now);
  if (!mood) return null;

  const result = {
    place: loc, // 展示用用户填的完整地名（如「成都 武侯区」）
    line: mood.line,
    temp: mood.temp,
    code: mood.code,
    isDay: mood.isDay,
  };

  // 写缓存（noCache 或失败时不阻塞注入）
  if (!noCache) {
    try {
      await data.setWeatherCache({
        location: loc,
        coordinates: { lat: geo.lat, lon: geo.lon },
        fetchedAt: now.getTime(),
        result,
      });
    } catch {
      // 缓存写失败忽略
    }
  }
  return result;
}

/**
 * 保证手上有一份新鲜天气：缓存命中就直接用，命中不了就查一次。
 * 启动预热、路由网络就绪、每轮注入前都走这一个入口，避免各写各的判断。
 * @param {object} opts { data, settings, now, fetcher, onError, log, timeoutMs }
 *   fetcher 不传时用宿主注入的那一个；log 传 { info, warn } 时写刷新日志。
 *   timeoutMs 只保护「同步等待」场景：超时按没查到处理，后台请求仍会继续写缓存。
 * @returns {Promise<object|null>} 新鲜天气；没配置/查不到返回 null（不抛）
 */
export async function ensureWeatherFresh({ data, settings = null, now = new Date(), fetcher, onError, log = null, timeoutMs = 0 } = {}) {
  if (!data) return null;
  let current = settings;
  try {
    current = current || data.getSettings();
    if (current.weatherEnabled === false) return null;
    const config = resolveWeatherLocation(current);
    const location = config.location;
    if (!location) return null;
    const cache = data.getWeatherCache();
    if (weatherCacheMatches(cache, current) && weatherCacheIsFresh(cache, current, now)) {
      const normalized = normalizeWeatherResult(cache.result, now);
      return normalized ? { ...normalized, place: normalized.place || cache.location || "" } : null;
    }
    const net = typeof fetcher === "function" ? fetcher : getConfiguredWeatherFetcher();
    if (typeof net !== "function") return null; // 宿主网络能力还没就位：静默跳过，等下一次调用
    const task = getWeatherForInject({
      data,
      location,
      coordinates: config.coordinates,
      now,
      fetcher: net,
      onError,
    });
    const result = timeoutMs > 0 ? await withTimeout(task, timeoutMs) : await task;
    if (result) log?.info?.(`天气已刷新：${result.place} · ${result.line}`);
    return result;
  } catch (e) {
    onError ? onError(e) : log?.warn?.(`天气刷新异常：${String(e?.message || e || "").slice(0, 300)}`);
    return null;
  }
}

// 只保护「同步等待」的那一层：超时后按没查到返回，后台请求继续跑并照常写缓存。
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// 从地点文字拆出城市：兼容「成都 武侯区」和「四川省 成都市 武侯区」。
export function extractCity(loc) {
  const parts = String(loc || "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /(?:省|自治区|特别行政区)$/.test(parts[0])) return parts[1];
  return parts[0] || String(loc || "").trim();
}


