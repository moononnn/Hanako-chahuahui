/**
 * 真实街景素材：只走 Wikimedia Commons API，只认明确可自由使用的许可。
 *
 * 这一份是给「真实街景自拍」当背景用的真照片，不是生成出来的布景。
 * 几条硬规矩，写在这里就别改：
 *
 * - **只用 Commons**：检索与取图都走 commons.wikimedia.org / Wikimedia 图片域名，
 *   不接任意链接、不接第三方图库、不做重定向链。取图前先核域名，落地后再核一次。
 * - **只用明确可自由使用的许可**：首版只收 CC0 与作者自己奉献的公共领域
 *   （PD-self / PD-author / 已过期版权）。CC BY、CC BY-SA、FAL、PD-user 这些
 *   一律不收——首版宁可窄，也不要一张说不清权属的图。
 * - **地点要能验**：不能因为标题里出现了城市名就算它在那座城市。
 *   地点证据来自两处：Commons 上带坐标的分类（城市中心 10 公里内），
 *   或者分类名里确实写着这座城市。街景证据另算：分类得是街、路、巷那类。
 *   两个证据都齐了才算一条可用素材。
 * - **不外送闲话**：只把城市名发去检索；聊天原文、她的名字、别的人名一概不发。
 * - **临时文件**：素材落在应用自己的数据目录里，用完能删；换城市、关掉授权、
 *   换参考照都把旧结果丢掉。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { detectImageType } from "./background.js";
import { geocodeLifeCity, normalizeLifeCity } from "./life-city.js";

/** Commons 检索与取图的唯一入口。 */
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/** 只认 Wikimedia 自己的图片域名。 */
export const ALLOWED_IMAGE_HOSTS = new Set(["thumb.wikimedia.org", "upload.wikimedia.org"]);

/** 街景自拍在「这一轮本来会发照片」里占多大把握。低频：一次主动消息大概几十分之一。 */
export const STREET_VIEW_CHANCE = 0.2;

/** 同一位伙伴的街景自拍最短间隔：一天最多一张，别变成每日打卡。 */
export const STREET_VIEW_COOLDOWN_MS = 24 * 3600_000;

const USER_AGENT = "chahuahui-street-view/0.1 (Hana app; Wikimedia Commons lookup)";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** 缩略图至少这么宽，太小的当拼图用。 */
const MIN_THUMB_WIDTH = 800;
/** 城市中心多大范围内算这座城市：Commons 的 geosearch 最多 10 公里。 */
const GEOSEARCH_RADIUS_M = 10_000;
const GEOSEARCH_LIMIT = 100;
/** 一轮最多看多少个候选文件。 */
const MAX_CANDIDATES = 40;

// ── 词表 ────────────────────────────────────────────────────────

/** 街景词：分类名里有这些，才算「街、路、巷」那类地方。 */
const STREET_WORDS = [
  "street", "road", "lane", "alley", "avenue", "boulevard", "sidewalk", "crosswalk", "crossing",
  "square", "market", "plaza", "passage", "passageway", "walkway", "promenade",
  "street scene", "streetscape", "道路", "街道", "街景", "马路", "巷",
];

/** 不是街景的词：分类名里有这些，说明这拍的是别的东西（车站、馆子、画…）。 */
const NOT_STREET_WORDS = [
  "station", "stations", "metro", "subway", "railway", "airport", "airports", "museum", "museums",
  "hotel", "hotels", "temple", "temples", "university", "universities", "hospital", "hospitals",
  "library", "libraries", "theater", "theaters", "theatre", "theatres", "church", "churches",
  "cathedral", "cathedrals", "mosque", "mosques", "interior", "interiors", "indoor", "indoors",
  "portrait", "portraits", "painting", "paintings", "drawing", "drawings", "map", "maps",
  "postcard", "postcards", "engraving", "engravings", "sculpture", "sculptures", "statue", "statues",
  "monument", "monuments", "memorial", "memorials", "cemetery", "cemeteries", "diagram", "diagrams",
  "blueprint", "blueprints",
];

/** 算城市名时不算数的词：这些词到处都是，不能拿来当城市名。 */
const TOKEN_STOPWORDS = new Set([
  "in", "of", "and", "the", "at", "on", "for", "with", "from", "new", "old", "a", "an", "to", "by",
  "photos", "photographs", "image", "images", "picture", "pictures", "file", "files", "category",
  "categories", "view", "views", "people", "building", "buildings", "street", "streets", "road", "roads",
  "lane", "lanes", "alley", "alleys", "avenue", "square", "market", "park", "former", "district",
  "prefecture", "province", "city", "town", "village", "day", "night", "morning", "evening",
  "summer", "winter", "spring", "autumn", "year", "history", "historic", "center", "centre",
]);

// ── 纯函数：小工具 ──────────────────────────────────────────────

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 去重音、转小写：Kyōto 与 Kyoto 要能当成同一个词。 */
export function foldText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** 按词匹配（不是子串）：「plan」不该命中「planning」，「road」也不该命中「broad」。 */
function hasWord(text, word) {
  if (!word) return false;
  if (/[\u3400-\u9fff]/u.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "u").test(text);
}

/** 街景词允许一个复数尾巴：streets / roads / sidewalks 都算。 */
function hasStreetWord(text, word) {
  if (!word) return false;
  if (/[\u3400-\u9fff]/u.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}s?([^a-z0-9]|$)`, "u").test(text);
}

/** 分类名是不是街景那类（路、街、巷）。 */
export function isStreetEvidence(title) {
  const folded = foldText(title);
  if (!folded) return false;
  if (NOT_STREET_WORDS.some(word => hasWord(folded, word))) return false;
  return STREET_WORDS.some(word => hasStreetWord(folded, word));
}

/** 分类名里是不是写着这座城市。 */
export function tokenMatchesCity(title, tokens = []) {
  const folded = foldText(title);
  if (!folded) return false;
  return tokens.some(token => {
    const value = foldText(token).trim();
    if (!value) return false;
    if (TOKEN_STOPWORDS.has(value)) return false;
    if (/[\u3400-\u9fff]/u.test(value)) return folded.includes(value);
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(value)}([^a-z0-9]|$)`, "u").test(folded);
  });
}

/**
 * 许可判定。首版只收两种：
 * CC0（明确的公共领域奉献）与作者自己奉献/版权已过期的公共领域作品。
 * PD-user（美国合理使用那种）与任何需要署名、限制再发布的都不收。
 */
export function licenseVerdict({ license = "", licenseName = "", usageTerms = "", categories = [] } = {}) {
  const code = String(license ?? "").trim().toLowerCase();
  const name = String(licenseName ?? "").trim();
  const terms = String(usageTerms ?? "").trim().toLowerCase();
  const cats = (Array.isArray(categories) ? categories : []).map(row => String(row ?? ""));
  const has = (re) => cats.some(row => re.test(row));
  if (code === "cc0" || hasWord(code, "cc0") || terms.includes("creative commons zero")) {
    return { allowed: true, license: "CC0", licenseName: name || "CC0" };
  }
  const looksPublicDomain = code === "pd" || code === "public domain" || terms.includes("public domain");
  if (looksPublicDomain) {
    if (has(/^Category:PD-user$/iu)) return { allowed: false, reason: "fair-use" };
    const dedicated = has(/^Category:PD-(self|author)$/iu);
    if (dedicated) return { allowed: true, license: "Public domain", licenseName: name || "Public domain" };
    return { allowed: false, reason: "pd-not-dedicated" };
  }
  return { allowed: false, reason: "license-not-allowed" };
}

/**
 * 一条素材是不是「这座城市里真的一条街」。
 * 地点证据与街景证据要分别成立，缺一不可。
 */
export function verifyStreetScene({ categories = [], ancestors = [], cityTokens = [], placeCategories = [] } = {}) {
  const places = new Set((Array.isArray(placeCategories) ? placeCategories : []).map(row => String(row)));
  const all = [...(Array.isArray(categories) ? categories : []), ...(Array.isArray(ancestors) ? ancestors : [])]
    .map(row => String(row ?? ""))
    .filter(Boolean);
  const placeHits = all.filter(row => places.has(row) || tokenMatchesCity(row, cityTokens));
  const streetHits = all.filter(isStreetEvidence);
  if (!placeHits.length) return { ok: false, reason: "no-place-evidence" };
  if (!streetHits.length) return { ok: false, reason: "no-street-evidence" };
  return { ok: true, place: placeHits[0], street: streetHits[0] };
}

/** 图片地址只认 Wikimedia 自己的域名与路径。 */
export function isAllowedImageUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (!ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase())) return false;
    return url.pathname.startsWith("/wikipedia/commons/");
  } catch {
    return false;
  }
}

/** Commons 的分类/文件标题去掉前缀。 */
function categoryLabel(title) {
  return String(title ?? "").replace(/^Category:/u, "").trim();
}

/** 去掉 HTML 标签（Commons 的作者字段常带链接）。 */
export function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * 从一批分类标题里推出这座城市的名字。
 * 办法很土但顶用：出现得最多的那个专名词。
 * 优先用「正好等于分类名」的那一个（Category:Chengdu 这种）。
 */
export function deriveCityTokens(titles = [], extras = []) {
  const counts = new Map();
  const afterIn = new Map();
  for (const title of titles) {
    const label = categoryLabel(title);
    if (!label) continue;
    const words = label.split(/[\s,/()\[\]·\-—_]+/u).filter(Boolean);
    words.forEach((raw, index) => {
      const value = raw.replace(/[.:;'"]/gu, "");
      if (!value || value.length < 2) return;
      if (!/^[A-ZÀ-Þ]/u.test(value)) return;   // 只认看起来像专名的词
      if (TOKEN_STOPWORDS.has(value.toLowerCase())) return;
      if (NOT_STREET_WORDS.some(word => hasWord(foldText(value), word))) return;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      // 「…… in Chengdu」这种写法最能说明城市名。
      const previous = (words[index - 1] ?? "").toLowerCase();
      if (previous === "in" || previous === "of") afterIn.set(value, (afterIn.get(value) ?? 0) + 1);
    });
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
  // 只留最能代表这座城市的那一个：地名要是「街」「广场」「天安门」这种词，
  // 拿来当地点证据就会把别处的街也算成这座城市的。
  const picked = [];
  const push = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    if (picked.some(row => foldText(row) === foldText(text))) return;
    picked.push(text);
  };
  // 先信「in 后面那个词」：它几乎总是城市名。
  const inRanked = [...afterIn.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
  if (inRanked.length) push(inRanked[0]);
  // 还不够，再看出现最多的那个专名（零星几个不算，地标名常常也只出现一两次）。
  if (!picked.length) {
    const top = ranked.find(value => (counts.get(value) ?? 0) >= 3);
    if (top) push(top);
  }
  // 连着都不够：宁可当没有这座城市，也不要把一个地标当地名（「天安门」不等于「北京」）。
  // 用户自己填的英文/拼音名与地理编码回来的当地名，同样算数。
  for (const value of extras) {
    const text = String(value ?? "").trim();
    if (!text || /[\u3400-\u9fff]/u.test(text)) continue;
    if (picked.length >= 3) break;
    push(text);
  }
  return picked;
}

/** 生成 Commons 的查询串：只用这一个地址。 */
export function buildCommonsUrl(params = {}) {
  const search = new URLSearchParams();
  search.set("action", "query");
  search.set("format", "json");
  search.set("formatversion", "2");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  return `${COMMONS_API}?${search.toString()}`;
}

/** 把 Commons 的一个文件页读成候选素材。 */
export function parseCandidatePage(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const title = String(page.title ?? "");
  if (!title.startsWith("File:")) return null;
  const meta = info.extmetadata ?? {};
  const thumbUrl = String(info.thumburl ?? "");
  const width = Number(info.thumbwidth ?? info.width ?? 0);
  return {
    title,
    pageId: Number(page.pageid ?? 0),
    mime: String(info.mime ?? "").toLowerCase(),
    width,
    height: Number(info.thumbheight ?? info.height ?? 0),
    thumbUrl,
    fileUrl: String(info.url ?? ""),
    descriptionUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /gu, "_"))}`,
    license: String(meta.License?.value ?? ""),
    licenseName: String(meta.LicenseShortName?.value ?? ""),
    usageTerms: String(meta.UsageTerms?.value ?? ""),
    licenseUrl: String(meta.LicenseUrl?.value ?? ""),
    author: stripHtml(meta.Artist?.value ?? ""),
    credit: stripHtml(meta.Credit?.value ?? ""),
    description: stripHtml(meta.ImageDescription?.value ?? "").slice(0, 300),
  };
}

/** 素材本身像不像一张能用的照片。 */
export function isUsableCandidate(candidate) {
  if (!candidate) return false;
  if (!["image/jpeg", "image/png"].includes(candidate.mime)) return false;
  if (!Number.isFinite(candidate.width) || candidate.width < MIN_THUMB_WIDTH) return false;
  if (!candidate.thumbUrl || !isAllowedImageUrl(candidate.thumbUrl)) return false;
  return true;
}

// ── 素材库 ──────────────────────────────────────────────────────

/**
 * 一个伙伴一份的街景素材库。
 * 素材按「城市 + 参考照」记：换城市、换参考照都当旧结果作废。
 */
export function createStreetViewLibrary({ dataDir, fetchImpl = null, now = () => Date.now(), random = Math.random } = {}) {
  const root = path.join(dataDir, "v2", "street-view");
  const cache = new Map();
  const pending = new Map();
  const retry = new Map();
  fs.mkdirSync(root, { recursive: true });

  function sweep() {
    // 启动时缓存是空的：目录里剩下的文件没人认领，全是上次留下的临时件。
    let names = [];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      if (!/^[a-f0-9]{16}\.(jpg|png)$/u.test(name)) continue;
      try { fs.unlinkSync(path.join(root, name)); } catch { /* 清不掉也不影响使用 */ }
    }
  }
  sweep();

  function fetchOf() {
    if (typeof fetchImpl === "function") return fetchImpl;
    throw new Error("宿主网络能力不可用");
  }

  async function apiGet(params, request) {
    const url = buildCommonsUrl(params);
    const response = await request(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_JSON_BYTES,
    });
    if (!response?.ok) throw new Error(`Commons 请求失败（HTTP ${response?.status ?? "?"}）`);
    const landing = new URL(response?.url || url);
    if (landing.origin + landing.pathname !== COMMONS_API || landing.username || landing.password) throw new Error("Commons 请求落到了别处");
    return await response.json();
  }

  /** 取图片字节：只认白名单域名，落地域再核一次，不追重定向链。 */
  async function downloadImage(rawUrl, request) {
    if (!isAllowedImageUrl(rawUrl)) throw new Error("图片地址不在 Wikimedia 白名单里");
    const response = await request(rawUrl, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_IMAGE_BYTES,
    });
    if (!response?.ok) throw new Error(`图片下载失败（HTTP ${response?.status ?? "?"}）`);
    const landing = String(response?.url ?? rawUrl);
    if (!isAllowedImageUrl(landing)) throw new Error("图片落到了白名单以外的地方");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("图片大小不对");
    const mimeType = detectImageType(buffer);
    if (!mimeType || !["image/jpeg", "image/png"].includes(mimeType)) throw new Error("下载到的不是可用图片");
    return { bytes: buffer, mimeType };
  }

  async function geocodeCity(city, request) {
    const jsonFetcher = async (url, timeoutMs) => {
      const response = await request(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        timeoutMs: timeoutMs ?? REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_JSON_BYTES,
      });
      if (!response?.ok) throw new Error(`地理编码失败（HTTP ${response?.status ?? "?"}）`);
      return await response.json();
    };
    return await geocodeLifeCity(city, jsonFetcher);
  }

  /** 城市中心附近的带坐标分类：这些分类名就是 Commons 认得的城市写法。 */
  async function geosearch(lat, lon, request) {
    const json = await apiGet({
      list: "geosearch",
      gscoord: `${lat}|${lon}`,
      gsradius: GEOSEARCH_RADIUS_M,
      gslimit: GEOSEARCH_LIMIT,
      gsnamespace: 14,
    }, request);
    const rows = Array.isArray(json?.query?.geosearch) ? json.query.geosearch : [];
    return rows.map(row => String(row?.title ?? "")).filter(Boolean);
  }

  /** 一批文件的直接分类（分批问，别一次塞太多）。 */
  async function categoriesOf(titles, request) {
    const out = new Map();
    const list = [...new Set(titles.filter(Boolean))];
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      const json = await apiGet({ prop: "categories", titles: chunk.join("|"), cllimit: 200 }, request);
      const pages = Array.isArray(json?.query?.pages) ? json.query.pages : [];
      for (const page of pages) {
        const cats = (Array.isArray(page?.categories) ? page.categories : []).map(row => String(row?.title ?? "")).filter(Boolean);
        out.set(String(page?.title ?? ""), cats);
      }
    }
    return out;
  }

  /** 候选文件：全文检索 + 街景分类的成员，两条路都走。 */
  async function collectCandidates(tokens, placeCategories, request) {
    const found = new Map();
    const take = (pages) => {
      for (const page of pages) {
        const candidate = parseCandidatePage(page);
        if (!candidate) continue;
        if (!found.has(candidate.title)) found.set(candidate.title, candidate);
      }
    };
    const searchParams = (query) => ({
      generator: "search",
      gsrsearch: query,
      gsrnamespace: 6,
      gsrlimit: 30,
      prop: "imageinfo",
      iiprop: "url|extmetadata|size|mime",
      iiurlwidth: 1024,
    });
    for (const token of tokens.slice(0, 2)) {
      try {
        const json = await apiGet(searchParams(`"${token}" street scene filetype:bitmap`), request);
        take(Array.isArray(json?.query?.pages) ? json.query.pages : []);
      } catch { /* 一条检索路走不通不算失败，换下一条 */ }
    }
    if (found.size < 3) {
      for (const token of tokens.slice(0, 2)) {
        try {
          const json = await apiGet(searchParams(`"${token}" street filetype:bitmap`), request);
          take(Array.isArray(json?.query?.pages) ? json.query.pages : []);
        } catch { /* 同上 */ }
      }
    }
    // 街景分类的成员：分类名要既像街景，又认这座城市（或就是坐标附近那个）。
    // 坐标附近的街景分类本身就是地点证据（它们带坐标），名字像街景才收。
    const streetCategories = [];
    for (const title of placeCategories) {
      if (!isStreetEvidence(title)) continue;
      streetCategories.push(title);
      if (streetCategories.length >= 4) break;
    }
    try {
      const json = await apiGet({ list: "search", srnamespace: 14, srlimit: 20, srsearch: `${tokens[0] ?? ""} street` }, request);
      for (const row of Array.isArray(json?.query?.search) ? json.query.search : []) {
        const title = String(row?.title ?? "");
        if (!title.startsWith("Category:")) continue;
        if (!isStreetEvidence(title) || !tokenMatchesCity(title, tokens)) continue;
        if (!streetCategories.includes(title)) streetCategories.push(title);
        if (streetCategories.length >= 6) break;
      }
    } catch { /* 分类检索走不通就只用坐标附近那批 */ }
    for (const category of streetCategories.slice(0, 5)) {
      try {
        const json = await apiGet({
          generator: "categorymembers",
          gcmtitle: category,
          gcmtype: "file",
          gcmlimit: 40,
          prop: "imageinfo",
          iiprop: "url|extmetadata|size|mime",
          iiurlwidth: 1024,
        }, request);
        take(Array.isArray(json?.query?.pages) ? json.query.pages : []);
      } catch { /* 单个分类取不到就跳过 */ }
    }
    return [...found.values()].slice(0, MAX_CANDIDATES);
  }

  /** 逐个核：许可、是不是照片、地点证据、街景证据。 */
  async function verifyCandidates(candidates, { tokens, placeCategories, request }) {
    const usable = candidates.filter(isUsableCandidate);
    if (!usable.length) return [];
    const direct = await categoriesOf(usable.map(row => row.title), request);
    const interesting = new Set();
    for (const cats of direct.values()) {
      for (const cat of cats) {
        if (isStreetEvidence(cat) || tokenMatchesCity(cat, tokens)) interesting.add(cat);
      }
    }
    const ancestors = interesting.size ? await categoriesOf([...interesting], request) : new Map();
    const verified = [];
    for (const candidate of usable) {
      const cats = direct.get(candidate.title) ?? [];
      const parentTitles = new Set();
      for (const cat of cats) {
        if (!interesting.has(cat)) continue;
        for (const parent of ancestors.get(cat) ?? []) parentTitles.add(parent);
      }
      const license = licenseVerdict({
        license: candidate.license,
        licenseName: candidate.licenseName,
        usageTerms: candidate.usageTerms,
        categories: cats,
      });
      if (!license.allowed) continue;
      const scene = verifyStreetScene({ categories: cats, ancestors: [...parentTitles], cityTokens: tokens, placeCategories });
      if (!scene.ok) continue;
      verified.push({ ...candidate, license: license.license, licenseName: license.licenseName, placeEvidence: scene.place, streetEvidence: scene.street });
    }
    return verified;
  }

  /** 挑一条：街景分类说得越具体越优先，同样好就随机。 */
  function pickScene(verified) {
    if (!verified.length) return null;
    const score = (row) => {
      let value = 0;
      if (/street scene|streetscape|street/iu.test(foldText(row.streetEvidence))) value += 3;
      if (tokenMatchesCity(row.streetEvidence, [row.cityToken ?? ""])) value += 2;
      value += Math.min(2, Math.floor(row.width / 1024));
      return value;
    };
    const ranked = [...verified].sort((a, b) => score(b) - score(a));
    const top = ranked.slice(0, Math.min(3, ranked.length));
    return top[Math.floor(random() * top.length)] ?? top[0];
  }

  /** 素材落成应用数据目录里的临时文件。 */
  async function materialize(scene, key, request, active) {
    const { bytes, mimeType } = await downloadImage(scene.thumbUrl, request);
    if (!active()) return null;
    const name = `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.${mimeType === "image/png" ? "png" : "jpg"}`;
    const target = path.join(root, name);
    fs.writeFileSync(target, bytes, { flag: "wx" });
    return { path: target, mimeType, size: bytes.length };
  }

  function keyOf(city, referenceId) {
    return `${normalizeLifeCity(city)}|${String(referenceId ?? "")}`;
  }

  async function lookup({ city, referenceId }, active) {
    const request = (url, options) => {
      if (!active()) throw new Error("街景查找已停止");
      return fetchOf()(url, { ...options, redirect: "error" });
    };
    const display = normalizeLifeCity(city);
    if (!display) return null;
    const geo = await geocodeCity(display, request);
    if (!geo) return null;
    const placeCategories = await geosearch(geo.lat, geo.lon, request);
    const tokens = deriveCityTokens(placeCategories, [geo.name, display]);
    if (!tokens.length) return null;
    const candidates = await collectCandidates(tokens, placeCategories, request);
    if (!candidates.length) return null;
    const verified = await verifyCandidates(candidates, { tokens: [geo.name], placeCategories, request });
    if (!verified.length) return null;
    const key = keyOf(display, referenceId);
    const scene = pickScene(verified.map(row => ({ ...row, cityToken: tokens[0] })));
    if (!scene) return null;
    const file = await materialize(scene, key, request, active);
    if (!file) return null;
    return {
      scene: {
        title: scene.title,
        city: display,
        cityName: geo.name,
        latitude: geo.lat,
        longitude: geo.lon,
        placeEvidence: scene.placeEvidence,
        streetEvidence: scene.streetEvidence,
        license: scene.license,
        licenseName: scene.licenseName,
        licenseUrl: scene.licenseUrl,
        author: scene.author,
        credit: scene.credit,
        description: scene.description,
        fileUrl: scene.fileUrl,
        thumbUrl: scene.thumbUrl,
        descriptionUrl: scene.descriptionUrl,
        width: scene.width,
        height: scene.height,
      },
      path: file.path,
      mimeType: file.mimeType,
      size: file.size,
      at: new Date(now()).toISOString(),
    };
  }

  function dropEntry(key) {
    const entry = cache.get(key);
    cache.delete(key);
    if (!entry?.path) return;
    try { fs.rmSync(entry.path, { force: true }); } catch { /* 临时文件删不掉也不影响下一轮 */ }
  }

  return {
    keyOf,
    /** 缓存里有没有现成的（同步，不碰网络）。 */
    peek({ city, referenceId } = {}) {
      const key = keyOf(city, referenceId);
      const entry = cache.get(key);
      if (!entry) return null;
      if (!fs.existsSync(entry.path) || now() - Date.parse(entry.at) >= 24 * 3600_000) { dropEntry(key); return null; }
      return entry;
    },
    resolve(options) { return this.warm(options); },
    /** 后台预热：不阻塞主动消息那一轮。 */
    warm({ city, referenceId } = {}) {
      const key = keyOf(city, referenceId);
      // 换参考照：同一座城市下旧的那份一律作废（临时文件也删掉），
      // 不让上一张脸配着上一份素材继续用。
      for (const oldKey of new Set([...cache.keys(), ...pending.keys(), ...retry.keys()])) {
        const [entryCity, entryReference] = oldKey.split("|");
        if (entryCity === normalizeLifeCity(city) && entryReference !== String(referenceId ?? "")) {
          dropEntry(oldKey);
          pending.delete(oldKey);
          retry.delete(oldKey);
        }
      }
      const cached = this.peek({ city, referenceId });
      if (cached) return Promise.resolve(cached);
      if (pending.has(key)) return pending.get(key);
      if ((retry.get(key) ?? 0) > now()) return Promise.resolve(null);
      const active = () => pending.get(key) === task;
      const task = Promise.resolve().then(async () => {
        try {
          const entry = await lookup({ city, referenceId }, active);
          if (!active()) return null;
          if (entry) cache.set(key, entry);
          else retry.set(key, now() + 6 * 3600_000);
          return entry;
        } catch {
          if (active()) retry.set(key, now() + 6 * 3600_000);
          return null;
        } finally {
          if (active()) pending.delete(key);
        }
      });
      pending.set(key, task);
      return task;
    },
    /** 换城市、关掉授权、换参考照：旧结果一律作废，临时文件删掉。 */
    release({ city, referenceId } = {}) {
      const all = city === undefined && referenceId === undefined;
      for (const key of new Set([...cache.keys(), ...pending.keys(), ...retry.keys()])) {
        const [entryCity, entryReference] = key.split("|");
        if (!all) {
          if (city !== undefined && entryCity !== normalizeLifeCity(city)) continue;
          if (referenceId !== undefined && entryReference !== String(referenceId ?? "")) continue;
        }
        pending.delete(key);
        retry.delete(key);
        dropEntry(key);
      }
    },
    stats() {
      return { cached: cache.size, pending: pending.size };
    },
  };
}
