/**
 * 生活城市：跟天气各算各的，默认空、默认关。
 *
 * 她自己填一个城市名，我们就用这个名字去认这座城市；
 * **不读定位**：不问她要 GPS，也不看系统给的位置，填什么就是什么。
 * 城市名只发给两个地方：天气那套本来就在用的 Open-Meteo 地理编码（拿经纬度），
 * 以及素材服务 Wikimedia Commons 的检索词（只送城市名本身）。
 * 聊天原文、她的名字、别的人名一概不外送。
 */

/** 城市名最多这么长：够写「四川 成都 锦江区」，也不至于把一整段话塞进去。 */
export const LIFE_CITY_MAX_LENGTH = 40;

/** 城市名归一：去首尾空白、压掉连续空格、截断。空的就是没填。 */
export function normalizeLifeCity(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, LIFE_CITY_MAX_LENGTH);
}

/** 街景授权只认真布尔：界面上按一下开，按一下关，别用字符串糊弄。 */
export function normalizeStreetViewConsent(value) {
  return value === true;
}

/**
 * 真实街景这一条现在卡在哪儿（只报标识，不带城市名本身）。
 * 两个都齐了才允许去问素材服务要街景。
 */
export function lifeCityBlockers(settings = {}) {
  const out = [];
  if (!normalizeLifeCity(settings.lifeCity)) out.push("no-city");
  if (normalizeStreetViewConsent(settings.lifeCityStreetView) !== true) out.push("no-consent");
  return out;
}

/** 城市填了、也授权了，这条才开。 */
export function lifeCityReady(settings = {}) {
  return lifeCityBlockers(settings).length === 0;
}

/** 城市名里有没有中日韩文字——决定地理编码用哪种语言去问。 */
export function hasCjk(value) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(value ?? ""));
}

/** Open-Meteo 地理编码：跟天气那套同一个服务、同一个地址，不另引新服务。 */
export const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";

export function cityDiscoveryQuery(city, now) {
  const location = normalizeLifeCity(city);
  if (!/^[\p{L}\p{M} .·'-]{2,40}$/u.test(location)) return "";
  const topics = ["展览 活动", "书店 活动", "街区 新动态", "咖啡店 本地报道"];
  return `${location} ${topics[now.getDate() % topics.length]}`;
}

export function cityDiscoveryResults(results, city) {
  const name = normalizeLifeCity(city).replace(/市$/u, "").toLowerCase();
  if (name.length < 2) return [];
  return (Array.isArray(results) ? results : []).filter(row => {
    const copy = `${row?.title ?? ""} ${row?.snippet ?? row?.summary ?? row?.content ?? ""}`.toLowerCase();
    if (!copy.includes(name) || typeof row?.url !== "string" || row.url.length > 500) return false;
    if (!/\p{Script=Han}/u.test(name) && !new RegExp(`(?:^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}])`, "u").test(copy)) return false;
    try {
      const source = new URL(row.url);
      return source.protocol === "https:" && !source.username && !source.password && !source.port && source.hostname.includes(".")
        && /^https:\/\/[a-z0-9.-]+(?:\/[^\s<>]*)?$/iu.test(String(row.url))
        && !/^[\d.]+$|(?:^|\.)(?:localhost|local|internal)$/iu.test(source.hostname);
    } catch { return false; }
  });
}

/**
 * 城市名 → 经纬度 + 一个规范地名。
 *
 * 中文名要用 language=zh 去问，英文/拼音名用默认那套；两边都取第一个结果。
 * 返回的 name 是**当地写法**：中文输入拿到的是中文名，英文输入拿到的是英文名。
 * @returns {Promise<{name:string, lat:number, lon:number, country:string, admin1:string}|null>}
 */
export async function geocodeLifeCity(city, fetcher, { onError, timeoutMs = 8000 } = {}) {
  const name = normalizeLifeCity(city);
  if (!name || typeof fetcher !== "function") return null;
  const language = hasCjk(name) ? "zh" : "en";
  try {
    const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&format=json&language=${language}`;
    const json = await fetcher(url, timeoutMs);
    const rows = json && Array.isArray(json.results) ? json.results : [];
    if (!rows.length) return null;
    const row = rows[0];
    if (typeof row?.latitude !== "number" || typeof row?.longitude !== "number") return null;
    return {
      name: String(row.name || name).trim() || name,
      lat: row.latitude,
      lon: row.longitude,
      country: String(row.country ?? ""),
      admin1: String(row.admin1 ?? ""),
    };
  } catch (error) {
    if (typeof onError === "function") onError(error);
    return null;
  }
}
