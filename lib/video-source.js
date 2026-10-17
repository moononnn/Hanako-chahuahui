/**
 * B 站视频材料的数据获取层。
 *
 * 硬红线：**只读**。
 * - 全程 GET，任何非 GET 方法直接拒绝，不给「加个评论」留缝。
 * - 域名白名单，白名单外一律拒绝。
 * - 不实现任何写接口：评论、点赞、投币、收藏、弹幕、动态，一个都不做。
 *   这不是保守，是这份设计能成立的前提——用户看到的是内容，代价不该由 ta 的账号承担。
 *
 * 凭证只用于读取登录态才有的内容（字幕、弹幕、评论）。搜索与热榜无需登录。
 */

import fs from "node:fs";
import path from "node:path";

import { MAX_VIDEO_SECONDS } from "./video-materials.js";
import { acceptSubtitle, aggregateDanmaku, parseDanmakuXml, subtitleFingerprint } from "./video-material.js";
import { credentialStorage, protectKey, unprotectKey } from "./crypto.js";
import { writeJsonAtomic } from "./persistence.js";

export const VIDEO_CREDENTIAL_FILE = path.join("v2", "video-credential.json");

/** 只放读接口要用到的域名。新增域名前先想清楚：是不是读操作。 */
export const VIDEO_ALLOWED_HOSTS = [
  "api.bilibili.com",
  "aisubtitle.hdslb.com",
  "comment.bilibili.com",
  "search.bilibili.com",
  "www.bilibili.com",
];

export const VIDEO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── 只读守卫 ───────────────────────────────────────────────────

/** 弹幕发送：即使写成 GET 也是写接口，没道理放行。 */
const WRITE_PATHS = ["/x/v2/dm", "/x/v2/dm/web", "/x/v2/dm/pool"];
/** 点赞、投币、收藏、投榜、投票：整段就是写动作，没有对应的读接口。 */
const WRITE_SEGMENT = /\/(?:like|coin|fav|collect|thumb|vote)(?:$|[/?])/iu;
/** 任何增删改动词段。评论读取是 /x/v2/reply，带 /add、/del 才是写。 */
const WRITE_VERB = /\/(?:add|submit|publish|send|post|delete|del|remove)(?:$|[/?])/iu;

function hostAllowed(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return VIDEO_ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function isAllowedVideoUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return { ok: false, reason: "不是合法 URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "只允许 https" };
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host)) return { ok: false, reason: `域名不在白名单：${host}` };
  // 写接口用的路径，直接挡掉。这是有意的双保险：即使调用方忘了改方法也拦得住。
  // 只读路径（评论读取、弹幕 xml）必须放行——旧规则把 /x/v2/reply 整段挡了，
  // 等于评论功能从来没跑通过过。
  if (WRITE_PATHS.includes(url.pathname)) return { ok: false, reason: `路径是写接口：${url.pathname}` };
  if (WRITE_SEGMENT.test(url.pathname)) return { ok: false, reason: `路径看起来是写接口：${url.pathname}` };
  if (WRITE_VERB.test(url.pathname)) return { ok: false, reason: `路径看起来是写接口：${url.pathname}` };
  return { ok: true, url };
}

/**
 * 只有主 API 域带登录凭据。
 * 字幕 CDN 与弹幕域都是公开资源，不该拿到 SESSDATA。
 *
 * 重定向：已只读核过当前宿主1.1.7-beta实现，IPC不传redirect字段，底层默认跟随；
 * 当前Undici在跨源跳转时删除Cookie，但宿主allowedHosts只查首跳。
 * 因而只把凭据送精确API域，并在响应暴露URL时复查落地域；不声称阻止所有跨域请求。
 * 这是当前安装包的源码核查，不是带真实凭据的重定向实机测试；宿主升级后需复核。
 */
const CREDENTIAL_HOST = "api.bilibili.com";

function safeHost(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function videoGet(fetcher, rawUrl, { cookie = "", referer = "", timeoutMs = 8000, maxResponseBytes = 1048576 } = {}) {
  const guard = isAllowedVideoUrl(rawUrl);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  if (typeof fetcher !== "function") return { ok: false, reason: "网络能力不可用" };

  const headers = { "User-Agent": VIDEO_UA, Referer: referer || "https://www.bilibili.com/" };
  if (cookie && guard.url.hostname === CREDENTIAL_HOST) headers.Cookie = cookie;

  let response;
  try {
    response = await fetcher(guard.url.href, { method: "GET", headers, timeoutMs, maxResponseBytes });
  } catch (error) {
    // 不回显异常原文：里面常带一整条带 auth_key 的地址。
    return { ok: false, reason: `请求失败：${String(error?.code ?? "网络错误")}` };
  }
  if (!response?.ok) return { ok: false, reason: `HTTP ${response?.status ?? "错误"}` };

  const landed = safeHost(response?.url);
  if (landed && !hostAllowed(landed)) return { ok: false, reason: "响应落在白名单外，已丢弃" };
  return { ok: true, url: guard.url.href, response };
}

// ── 凭证 ───────────────────────────────────────────────────────

function credentialFile(dataDir) {
  return path.join(String(dataDir || ""), VIDEO_CREDENTIAL_FILE);
}

/**
 * 读取凭证。落盘时 SESSDATA 一定是密文（系统锁或本机锁，见 lib/crypto.js），
 * 明文只存在于内存，读出即用，不落日志、不打印。
 */
export async function readVideoCredential(dataDir) {
  const file = credentialFile(dataDir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "没有凭证或读不出来" };
  }
  const stored = String(raw?.sessdata ?? "");
  // 磁盘上的明文一律拒。unprotectKey 对不带前缀的值会原样返回，
  // 那等于给一份明文文件开后门。这里先卡住标记，再谈还原。
  if (!stored) return { ok: false, reason: "凭证为空" };
  const storage = credentialStorage(stored);
  if (!storage) return { ok: false, reason: "凭证不是加密格式，拒绝使用（明文或标记造假）" };
  const sessdata = await unprotectKey(stored);
  // 标记在、解不出内容，同样是坏的：不能拿状态接口的 storage 字段当保证。
  if (!sessdata) return { ok: false, reason: "凭证解密失败" };
  return {
    ok: true,
    cookie: `SESSDATA=${sessdata}`,
    hasLogin: true,
    encrypted: storage === "encrypted",
    storage,
    savedAt: String(raw?.savedAt ?? ""),
  };
}

export async function writeVideoCredential(dataDir, { sessdata } = {}) {
  const plain = String(sessdata ?? "").trim();
  if (!plain) return { ok: false, reason: "没有 SESSDATA" };
  const protectedSessdata = await protectKey(plain);
  // 两种锁都拿不到就是没加密成功：宁可写不进去，也不让明文落盘。
  const storage = credentialStorage(protectedSessdata);
  if (!storage) return { ok: false, reason: "凭据没有加密成功，没有写入凭证" };
  const payload = {
    savedAt: new Date().toISOString(),
    // 只存 SESSDATA。取数时也只往主 API 域发它，
    // bili_jct / DedeUserID 没有任何读取方，不存。
    sessdata: protectedSessdata,
    encrypted: storage === "encrypted",
    storage,
  };
  writeJsonAtomic(credentialFile(dataDir), payload);
  return { ok: true, encrypted: storage === "encrypted", storage };
}

export function clearVideoCredential(dataDir) {
  try {
    fs.rmSync(credentialFile(dataDir), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 120) };
  }
}

// ── 素材获取 ───────────────────────────────────────────────────

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function mixinKey(imgKey, subKey) {
  const raw = String(imgKey ?? "") + String(subKey ?? "");
  return MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function md5Hex(text) {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(String(text)).digest("hex");
}

async function signWbi(params, key) {
  const wts = Math.floor(Date.now() / 1000);
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${await md5Hex(query + key)}`;
}

async function fetchWbiKey(fetcher, cookie) {
  const res = await videoGet(fetcher, "https://api.bilibili.com/x/web-interface/nav", { cookie });
  if (!res.ok) return null;
  const json = await res.response.json().catch(() => null);
  const img = json?.data?.wbi_img?.img_url ?? "";
  const sub = json?.data?.wbi_img?.sub_url ?? "";
  if (!img || !sub) return null;
  const strip = (u) => u.slice(u.lastIndexOf("/") + 1).split(".")[0];
  return mixinKey(strip(img), strip(sub));
}

function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").trim();
}

/** 关键词搜索。无需登录。 */
export async function searchVideos(fetcher, keyword, { cookie = "", order = "pubdate", page = 1 } = {}) {
  const clean = String(keyword ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim().slice(0, 80);
  if (!clean) return { ok: false, reason: "没有搜索词", results: [] };
  const key = await fetchWbiKey(fetcher, cookie);
  if (!key) return { ok: false, reason: "拿不到签名密钥", results: [] };

  const query = await signWbi({ search_type: "video", keyword: clean, page, order }, key);
  const res = await videoGet(fetcher, `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, {
    cookie,
    referer: "https://search.bilibili.com/",
  });
  if (!res.ok) return { ok: false, reason: res.reason, results: [] };
  const json = await res.response.json().catch(() => null);
  if (json?.code !== 0) return { ok: false, reason: `搜索失败 code=${json?.code}`, results: [] };

  const results = (json.data?.result ?? [])
    .filter((row) => /^BV[0-9A-Za-z]{10}$/u.test(String(row?.bvid ?? "")))
    .map((row) => ({
      bvid: row.bvid,
      title: stripHtml(row.title).slice(0, 120),
      desc: stripHtml(row.description).slice(0, 400),
      author: String(row.author ?? "").slice(0, 40),
      duration: String(row.duration ?? ""),
      play: Number(row.play ?? 0),
      pubdate: Number(row.pubdate ?? 0),
      tname: String(row.tname ?? ""),
      tags: String(row.tag ?? "").split(",").filter(Boolean).slice(0, 5),
    }));
  return { ok: true, results };
}

/**
 * 视频元信息。无需登录。
 *
 * 分P：cid 与 duration 都取**指定那一页**的。顶层 duration 是全片总长，
 * 拿它去对照 P1 的字幕跨度会把多P视频全判成「字幕短得离谱」。
 * 响应里的 bvid / aid / cid 与请求或与该页对不上时一律拒绝，不猜。
 */
export async function fetchVideoMeta(fetcher, bvid, { cookie = "", page = 1 } = {}) {
  const wanted = Number(page);
  if (!Number.isInteger(wanted) || wanted < 1) {
    return { ok: false, reason: `分P号不合法：${String(page)}` };
  }
  const res = await videoGet(
    fetcher,
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}&p=${wanted}`,
    { cookie },
  );
  if (!res.ok) return { ok: false, reason: res.reason };
  const json = await res.response.json().catch(() => null);
  if (json?.code !== 0) return { ok: false, reason: `取不到视频 code=${json?.code}` };
  const d = json.data ?? {};

  if (String(d.bvid ?? "") !== String(bvid)) {
    return { ok: false, reason: "响应里的 bvid 与请求的不一致，拒绝" };
  }
  const pages = Array.isArray(d.pages) && d.pages.length ? d.pages : null;
  if (pages && wanted > pages.length) {
    return { ok: false, reason: `分P号越界：这部视频只有 ${pages.length} P` };
  }
  const entry = pages ? pages[wanted - 1] : null;
  // pages 里选中的那一页是权威：顶层 cid 常规就是 P1 的 cid，
  // 拿它去对照 P2 只会把正常的请求误拒。只有 page 1 才做这项对照。
  const cid = Number(entry?.cid ?? d.cid);
  const duration = Number(entry?.duration ?? d.duration ?? 0);
  const aid = Number(d.aid);
  if (!Number.isInteger(aid) || aid <= 0) return { ok: false, reason: "响应里没有可用的 aid，拒绝" };
  if (!Number.isInteger(cid) || cid <= 0) return { ok: false, reason: "响应里没有可用的 cid，拒绝" };
  if (entry && Number(entry.page) !== wanted) {
    return { ok: false, reason: `pages 第 ${wanted} 项的页码是 ${String(entry.page)}，不一致，拒绝` };
  }
  if (pages && wanted === 1 && Number(d.cid) !== cid) {
    return { ok: false, reason: "顶层 cid 与 P1 的 cid 不一致，拒绝" };
  }

  return {
    ok: true,
    video: {
      bvid: d.bvid,
      aid,
      cid,
      page: wanted,
      pages: pages ? pages.length : 1,
      title: stripHtml(d.title).slice(0, 160),
      desc: stripHtml(d.desc).slice(0, 600),
      author: String(d.owner?.name ?? "").slice(0, 40),
      authorId: d.owner?.mid ?? null,
      duration,
      pubdate: Number(d.pubdate ?? 0),
      tname: String(d.tname ?? ""),
      view: Number(d.stat?.view ?? 0),
      like: Number(d.stat?.like ?? 0),
      favorite: Number(d.stat?.favorite ?? 0),
      tags: (d.tags ?? []).map((t) => t.tag_name).slice(0, 6),
      // 链接始终带 p，回访时能拿回同一页。
      link: `https://www.bilibili.com/video/${d.bvid}?p=${wanted}`,
    },
  };
}

/**
 * 中文轨的显式优先级：人声中字 > 其它中文轨 > AI 中字。
 * 0 表示不用。外语轨不给兵底：本项目要的是中文内容，
 * 拿一条外语字幕去讲一个中文视频是另一回事。
 */
function trackRank(lan) {
  const v = String(lan ?? "").trim().toLowerCase();
  if (v === "zh-cn" || v === "zh-hans" || v === "zh-hant") return 4;
  if (v.startsWith("zh")) return 3;
  if (v === "ai-zh") return 2;
  return 0;
}

/** 同优先级时保留先出现的那条，所以结果与接口返回的顺序无关。 */
function pickSubtitleTrack(subs) {
  let best = null;
  let bestRank = 0;
  for (const s of Array.isArray(subs) ? subs : []) {
    const rank = trackRank(s?.lan);
    if (rank > bestRank) { best = s; bestRank = rank; }
  }
  return best;
}

/**
 * 字幕地址有三种写法：带协议的绝对地址、`//` 开头的协议相对地址、以及 `/bfs/...` 这种根相对地址。
 * 第三种以前直接被当成非法 URL 丢掉，白白浪费一个候选；这里只补拼 CDN 域，
 * 不改变白名单校验（拼完仍要过 videoGet 的域名检查）。
 */
function subtitleUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  if (/^https?:\/\//iu.test(text)) return text;
  if (text.startsWith("/")) return `https://aisubtitle.hdslb.com${text}`;
  return "";
}

/** 只报告地址形状，不记地址本身。 */
function subtitleUrlShape(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "empty";
  if (text.startsWith("//")) return "protocol-relative";
  if (/^https?:\/\//iu.test(text)) return "absolute";
  if (text.startsWith("/")) return "root-relative";
  return "other";
}

/**
 * 字幕。只有登录态才有（2026-10-16 实测：无 cookie 时三条路全为 0）。
 *
 * 多拍取两票，没有可以绕过的开关：
 * - 至少要有两拍**正文完全相同**（语言也要相同），否则整份作废；
 * - 最多试四拍，凑到两票就停。
 *
 * 不要求前两拍就对得上，原因是 2026-10-17 实测发现服务端很不稳：
 * - 同一条 ai-zh 轨两次请求，ID 从 1605036321447927600 变成 1602396522853706500，正文完全一样；
 * - 同一个视频四拍里，两次给 310 段的完整正文，一次给 7 段 42 字、跟视频毫无关系的占位内容，一次直接给空地址；
 * - 另一条视频四拍给了四份互不相同的正文（20/160/30 段），且内容与标题对不上。
 * 所以“两拍完全一致”才是可靠的标识，单拍不算数，错内容很难连中两拍。
 * 轨 ID 是服务端每次临时分配，不拿它当身份，ID 变了只记在 trackChanged 里。
 *
 * 返回 readKind 标明这次拿到了哪一档——它决定伙伴后来能说什么，
 * 「只有标题」和「读过字幕」不是一回事，不能混。
 */
export async function fetchSubtitle(fetcher, video, { cookie = "", delayMs = 900 } = {}) {
  if (!cookie) return { ok: false, reason: "没有登录态，取不到字幕", readKind: "none" };

  const rounds = [];
  let lastReason = "没有字幕";
  // 最多试四拍：服务端时而给空地址、时而给错配正文，得给「两票相同」留出机会。
  const MAX_ROUNDS = 4;
  /** 已经有两拍正文完全一致：不用再多花请求。 */
  const hasMajority = () => {
    const seen = new Map();
    for (const round of rounds) {
      const key = `${round.lan}\u0000${round.fp}`;
      const next = (seen.get(key) ?? 0) + 1;
      if (next >= 2) return true;
      seen.set(key, next);
    }
    return false;
  };

  for (let i = 0; i < MAX_ROUNDS && !hasMajority(); i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    const url = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(video.bvid)}&cid=${video.cid}&aid=${video.aid}`;
    const res = await videoGet(fetcher, url, { cookie, referer: video.link });
    if (!res.ok) {
      lastReason = res.reason;
      continue;
    }
    const json = await res.response.json().catch(() => null);
    const subs = json?.data?.subtitle?.subtitles ?? [];
    if (!subs.length) {
      lastReason = "没有字幕";
      continue;
    }
    const pick = pickSubtitleTrack(subs);
    if (!pick) {
      lastReason = "没有可用的中文字幕轨，只有外语轨";
      continue;
    }
    const raw = String(pick.subtitle_url ?? "");
    const subUrl = subtitleUrl(raw);
    if (!subUrl) {
      lastReason = `字幕地址形状无法识别（${subtitleUrlShape(raw)}）`;
      continue;
    }
    const sres = await videoGet(fetcher, subUrl, { cookie, referer: video.link, maxResponseBytes: 2097152 });
    if (!sres.ok) {
      lastReason = `${sres.reason}（地址形状：${subtitleUrlShape(raw)}）`;
      continue;
    }
    const body = await sres.response.json().catch(() => null);
    rounds.push({
      lan: String(pick.lan ?? ""),
      trackId: String(pick.id ?? ""),
      url: subUrl,
      body,
      fp: subtitleFingerprint(body),
    });
  }

  // 一轮都没跑成不算「两次一致」。
  // 至少要有两拍才谈得上交叉比对。
  if (rounds.length < 2) {
    return {
      ok: false,
      reason: `字幕复核未完成（只成功 ${rounds.length} 拍）：${lastReason}`,
      readKind: "none",
    };
  }

  // 多拍取两票：实测同一个 ai-zh 轨会随机给出 310 段的完整正文，也会给出 7 段 42 字、
  // 跟视频完全无关的占位内容（另一条视频三次给了三份不同正文）。
  // 错内容靠运气连中两拍的概率极低，所以「两拍完全一致」才是可靠的标识；
  // 只要凑到两票就采用，不要求前两拍就对得上。
  const buckets = new Map();
  for (const round of rounds) {
    const key = `${round.lan}\u0000${round.fp}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(round);
  }
  const winner = [...buckets.values()].find((rows) => rows.length >= 2) ?? null;
  if (!winner) {
    return {
      ok: false,
      reason: `多次取到的字幕互不一致（${rounds.length} 拍没有两拍相同），丢弃`,
      readKind: "none",
      unstable: true,
      attempts: rounds.length,
    };
  }
  const [a, b] = winner;
  const trackChanged = Boolean(a.trackId && b.trackId && a.trackId !== b.trackId);

  const verdict = acceptSubtitle({
    video,
    subtitle: { subtitle_url: a.url },
    body: a.body,
    fingerprint: a.fp,
    referenceFingerprint: b.fp,
  });
  if (!verdict.accepted) {
    return { ok: false, reason: `字幕不可信：${verdict.reason}`, readKind: "none", verdict };
  }
  const segs = Array.isArray(a.body?.body) ? a.body.body : [];
  return {
    ok: true,
    readKind: "subtitle",
    lan: a.lan,
    trackChanged,
    segments: segs.map((s) => ({ from: Number(s.from ?? 0), content: String(s.content ?? "").trim() })),
    verdict,
  };
}

/** 弹幕。需要登录。xml 接口单次约 1200 条，够判断「哪里好笑」。 */
export async function fetchDanmaku(fetcher, video, { cookie = "" } = {}) {
  if (!cookie) return { ok: false, reason: "没有登录态，取不到弹幕", rows: [] };
  const res = await videoGet(fetcher, `https://comment.bilibili.com/${video.cid}.xml`, {
    cookie,
    referer: video.link,
    maxResponseBytes: 2097152,
  });
  if (!res.ok) return { ok: false, reason: res.reason, rows: [] };
  const xml = await res.response.text();
  const rows = parseDanmakuXml(xml);
  return { ok: true, rows, hot: aggregateDanmaku(rows) };
}

/** 评论。需要登录。只取热评，不做翻页。 */
export async function fetchTopReplies(fetcher, video, { cookie = "", limit = 8 } = {}) {
  if (!cookie) return { ok: false, reason: "没有登录态，取不到评论", replies: [] };
  const res = await videoGet(fetcher, `https://api.bilibili.com/x/v2/reply?type=1&oid=${video.aid}&mode=3&ps=${limit}`, {
    cookie,
    referer: video.link,
  });
  if (!res.ok) return { ok: false, reason: res.reason, replies: [] };
  const json = await res.response.json().catch(() => null);
  const replies = (json?.data?.replies ?? []).slice(0, limit).map((r) => ({
    text: String(r.content?.message ?? "").slice(0, 200),
    like: Number(r.like ?? 0),
    isUpper: Boolean(r.up_mid),
  }));
  return { ok: true, replies };
}

/**
 * 一次把一份材料取齐。字幕拿不到是常态（覆盖率不是满的），
 * 此时降级到只标题，并在 readKind 里如实标明——调用方必须照实转述，不能假装读过。
 *
 * requireSubtitle：给自动分享用。只要字幕，取不到就失败/跳过，
 * 弹幕档**不算**可分享，shareable 恒为 false。
 * 这一条分支也不额外取弹幕和评论：那是手动浏览才值得花的钱。
 */
export async function collectVideoMaterials(fetcher, bvid, { cookie = "", page = 1, requireSubtitle = false } = {}) {
  const meta = await fetchVideoMeta(fetcher, bvid, { cookie, page });
  if (!meta.ok) return { ok: false, reason: meta.reason, shareable: false };

  // 时长闸先过：超限的视频连字幕都不取，这一轮所有开销都省下来。
  if (meta.video.duration > MAX_VIDEO_SECONDS) {
    return {
      ok: false,
      reason: `视频 ${Math.round(meta.video.duration / 60)} 分钟，超过 ${MAX_VIDEO_SECONDS / 60} 分钟上限`,
      video: meta.video,
      readKind: "title-only",
      shareable: false,
    };
  }

  const subtitle = await fetchSubtitle(fetcher, meta.video, { cookie })
    .catch(() => ({ ok: false, readKind: "none", reason: "字幕取数失败" }));

  if (requireSubtitle && !subtitle.ok) {
    return {
      ok: false,
      reason: `没有拿到可用字幕：${subtitle.reason ?? "未知原因"}`,
      video: meta.video,
      readKind: "none",
      shareable: false,
    };
  }

  const [danmaku, replies] = requireSubtitle
    ? [{ hot: [], rows: [] }, { replies: [] }]
    : await Promise.all([
        fetchDanmaku(fetcher, meta.video, { cookie }).catch(() => ({ ok: false, rows: [] })),
        fetchTopReplies(fetcher, meta.video, { cookie }).catch(() => ({ ok: false, replies: [] })),
      ]);

  const readKind = subtitle.ok ? "subtitle" : danmaku.rows?.length ? "danmaku" : "title-only";
  return {
    ok: true,
    video: meta.video,
    readKind,
    shareable: readKind === "subtitle",
    subtitle: subtitle.ok ? subtitle.segments : [],
    subtitleReason: subtitle.ok ? "" : subtitle.reason,
    danmakuHot: danmaku.hot ?? [],
    danmakuCount: danmaku.rows?.length ?? 0,
    replies: replies.replies ?? [],
  };
}
