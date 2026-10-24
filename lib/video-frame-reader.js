/**
 * 视频取帧：把一段 B 站视频变成「封面 + 若干张真实画面」。
 *
 * 这里的每条边界都是硬边界，不是建议：
 * - 只读。不写聊天、不动账本、不发模型请求、不读任何密钥或 Cookie。
 * - 下载只走宿主给的 ctx.network.fetch：GET、不带 Cookie、只走白名单域
 *   （媒体 *.bilivideo.com，封面 *.hdslb.com/bfs/archive）。首跳地址与
 *   响应落地域都要过白名单；http 只允许升级成 https，不允许降级。
 * - ffmpeg 绝不自己拉远程地址：媒体必须先由 ctx.network.fetch 落到临时目录，
 *   ffmpeg 只读本地文件（-protocol_whitelist file,pipe），这样远程取数仍然
 *   受宿主网络权限管着。
 * - 下载内容只认真实容器：媒体必须是 ftyp 的 MP4 或 FLV，封面必须是真 JPEG/PNG/WebP。
 *   播��单（#EXTM3U / MPD）之类一律拒；ffmpeg 侧再加 -format_whitelist 兜底。
 * - 可执行文件由宿主 ctx.process.resolveExecutable 正式定位（app/process.spawn）。
 *   这里只提供候选名与按 os.homedir()/APPDATA 算出来的常见目录，不硬编码任何
 *   本机用户名或绝对路径，也不安装、不下载可执行文件、不跑 Python、不走 shell。
 * - 临时目录只在 ctx.dataDir 里 mkdtemp，结束必删；不读工作台上的任何文件。
 * - 帧是本地真解码出来的连续采样，不是雪碧图、不是预采样缩略图。
 * - 整次操作有 60 秒绝对时限：定位、下载、读正文、每一次 ffmpeg（含重试与压体积）
 *   都按剩余时间收紧；超了就是失败，不许拿超时后迟到的结果继续往下走。
 * - 计划里的帧必须全部取到：少一帧就整批失败，不报「看过了」，也不照搬时间戳。
 *   封面可以单独失败（coverSeen=false），但正片帧不齐一律拒绝。
 *
 * 对外两个函数：
 *   planVideoFrames(video, { hotTimes })  → 采样计划（纯逻辑，好测）
 *   readVideoFrames(ctx, { video, mediaUrl, coverUrl, plan }) → { parts, sampleTimes, clip, coverSeen }
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 限额与采样参数。改这里等于改成本，改之前先想清楚。 */
export const LIMITS = Object.freeze({
  mediaBytes: 20 * 1024 * 1024,      // 媒体硬上限 20MB
  coverBytes: 2 * 1024 * 1024,       // 封面硬上限 2MB
  frameBytes: 512 * 1024,            // 单张（含封面）上限 512KB
  totalBytes: 5 * 1024 * 1024,       // 全部 part 合计上限 5MB
  operationTimeoutMs: 60_000,        // 整次操作的绝对时限
  networkTimeoutMs: 30_000,         // 单次下载
  execTimeoutMs: 40_000,            // 单次 ffmpeg
  execMaxBuffer: 2 * 1024 * 1024,    // ffmpeg 输出缓冲上限
  longEdge: 512,                    // 帧与封面的长边
  maxSamples: 9,                    // 采样点上限
  localSamples: 6,                  // 局部连续帧数
  localFps: 2,                      // 局部连续帧的采样率
  sparseSamples: 3,                 // 跨片稀疏点
  sampleGridSec: 0.5,               // 采样点落在 0.5 秒网格上
  localSpanSec: 2.5,                // 局部连续段覆盖 2.5 秒
  ptsToleranceSec: 0.15,            // 帧的真实时间与目标的最大偏差
  localGapMinSec: 0.4,              // 局部相邻帧最小间隔
  localGapMaxSec: 0.6,              // 局部相邻帧最大间隔
  localSpanMaxSec: 2.7,             // 局部片段最长跨度
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MEDIA_HOST_SUFFIX = "bilivideo.com";
const COVER_HOST_SUFFIX = "hdslb.com";
const COVER_PATH_PREFIX = "/bfs/archive/";

// ── 纯逻辑：采样计划 ────────────────────────────────────────────

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 采样点必须落在 0.5 秒网格上：局部连续段才能按 2fps 对齐。 */
function quantize(seconds) {
  return Math.round(seconds * 2) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 弹幕时间归一化。接受裸秒数，也接受 { t|time|at, count|weight }。
 * 落在视频时长之外的一律丢掉——那多半是解析错了，不是「很热」。
 */
function normalizeHotTimes(hotTimes, duration) {
  const out = [];
  for (const item of Array.isArray(hotTimes) ? hotTimes : []) {
    const raw = item && typeof item === "object" ? (item.t ?? item.time ?? item.at) : item;
    const t = toNumber(raw);
    if (t === null || t < 0 || t > duration) continue;
    const weight = toNumber(item && typeof item === "object" ? (item.count ?? item.weight) : 1);
    out.push({ t, w: weight && weight > 0 ? weight : 1 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 找最密的一段：滑窗扫「长度 = 局部跨度」的窗口，取权重和最大的那个起点。
 * 只有一两个点时判不出密度，交给调用方走中段。
 */
function densestWindowStart(dense, span) {
  let best = null;
  for (const point of dense) {
    for (const candidate of [point.t, point.t - span]) {
      const start = clamp(candidate, 0, point.t);
      let weight = 0;
      for (const other of dense) {
        if (other.t >= start - 1e-9 && other.t <= start + span + 1e-9) weight += other.w;
      }
      if (!best || weight > best.weight) best = { start, weight };
    }
  }
  return best ? best.start : null;
}

/**
 * 采样计划。
 *
 * sampleTimes：3 个跨片稀疏点（全片 25% / 50% / 75%）+ 局部 6 帧（2fps，覆盖 2.5 秒），
 *   去重后不超过 9 个，全部落在 0.5 秒网格上、按时间严格递增。
 * clip：**只描述局部连续段**（局部 6 帧的首尾，例如 19–21.5 秒），
 *   不代表「整段都看过了」；跨片稀疏点不在 clip 里，也不在 clip 的语义范围内。
 * 局部段优先落在弹幕密集处；没有可靠时间就用中段——不额外叫模型选片。
 * 短视频会被夹边（采样点不越过时长，且留出 0.5 秒余量）。
 */
export function planVideoFrames(video, { hotTimes = [] } = {}) {
  const duration = toNumber(video?.duration) ?? 0;
  if (duration <= 0) return { sampleTimes: [], clip: { from: 0, to: 0 } };

  const maxT = Math.max(0, quantize(duration - LIMITS.sampleGridSec));
  const dense = normalizeHotTimes(hotTimes, duration);

  let burstStart = dense.length >= 2 ? densestWindowStart(dense, LIMITS.localSpanSec) : null;
  if (burstStart === null) {
    // 没有可靠时间：取中段，别假装知道哪儿热闹。
    burstStart = clamp(quantize(duration / 2 - LIMITS.localSpanSec / 2), 0, maxT);
  } else {
    burstStart = clamp(quantize(burstStart), 0, maxT);
  }

  const local = [];
  for (let i = 0; i < LIMITS.localSamples; i += 1) {
    local.push(clamp(quantize(burstStart + i * (1 / LIMITS.localFps)), 0, maxT));
  }

  const sparse = [];
  for (let i = 1; i <= LIMITS.sparseSamples; i += 1) {
    sparse.push(clamp(quantize((duration * i) / (LIMITS.sparseSamples + 1)), 0, maxT));
  }

  const unique = [...new Set([...sparse, ...local])].sort((a, b) => a - b);
  const sampleTimes = unique.slice(0, LIMITS.maxSamples);

  // clip 只取局部连续段的首尾；它必须真的落在 sampleTimes 里。
  const localInPlan = local.filter((t) => sampleTimes.includes(t));
  const from = localInPlan.length ? localInPlan[0] : sampleTimes[0] ?? 0;
  const to = localInPlan.length ? localInPlan[localInPlan.length - 1] : from;
  return { sampleTimes, clip: { from, to } };
}

// ── 可执行文件定位 ─────────────────────────────────────────────

/**
 * ffmpeg 候选：先是 PATH 上的名字，再是按 os.homedir()/APPDATA 算出来的
 * imageio-ffmpeg 常见安装位置（含 Python 3.12/3.13/3.14 与几个版本号）。
 * 全部是算出来的路径，不含任何本机用户名或写死的绝对路径。
 */
export function ffmpegCandidates({ homedir = os.homedir?.() ?? "", env = process.env } = {}) {
  const candidates = ["ffmpeg"];
  const roots = [];
  if (env.APPDATA) roots.push(env.APPDATA);
  if (homedir) {
    roots.push(path.join(homedir, "AppData", "Roaming"));
    roots.push(path.join(homedir, "AppData", "Local"));
  }
  const versions = ["Python314", "Python313", "Python312"];
  const bins = [
    "ffmpeg-win-x86_64-v7.1.exe",
    "ffmpeg-win64-v7.1.exe",
    "ffmpeg-win-x86_64-v6.0.exe",
    "ffmpeg-win64-v4.2.2.exe",
    "ffmpeg.exe",
  ];
  for (const root of roots) {
    for (const version of versions) {
      const relatives = [
        path.join("Python", version, "site-packages", "imageio_ffmpeg", "binaries"),
        path.join("Python", version, "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
        path.join("Programs", "Python", version, "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
      ];
      for (const relative of relatives) {
        for (const bin of bins) candidates.push(path.join(root, relative, bin));
      }
    }
  }
  return candidates;
}

/** 宿主实测每次仅接受1～64个候选；去重并分批，不能截掉后面的安装位置。 */
export async function resolveVideoFfmpeg(resolve, { candidates = ffmpegCandidates(), remainingMs = null } = {}) {
  const deadline = Date.now() + LIMITS.operationTimeoutMs;
  const left = remainingMs ?? (() => deadline - Date.now());
  const unique = [...new Set(candidates)];
  for (let offset = 0; offset < unique.length; offset += 64) {
    const ms = left();
    if (ms <= 0) throw new Error("定位 ffmpeg 超时");
    const result = await withTimeout(resolve({ candidates: unique.slice(offset, offset + 64) }), ms, "定位 ffmpeg");
    if (result?.path) return result;
  }
  return null;
}

// ── 时限：绝对 deadline ─────────────────────────────────────────

/**
 * 给一个 promise 加时限。到点了就抛；迟到的结果不许继续后面的流程，
 * 但也不能变成未处理的拒绝。
 */
async function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), Math.max(1, ms));
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    // 迟到的结果：吞掉它的失败，不让它在后台接着往下走。
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
  }
}

// ── 网络：只走白名单、只读、有上限 ──────────────────────────────

/**
 * 地址白名单。http 只允许升级为 https；不许带用户信息、不许带端口、
 * 不许别的协议；域名必须是白名单域本身或其子域。
 */
export function assertSafeUrl(rawUrl, { hostSuffix, pathPrefix = null, label = "地址" } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    throw new Error(`${label}不是合法 URL`);
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error(`${label}只允许 https`);
  if (url.username || url.password) throw new Error(`${label}不得携带用户信息`);
  if (url.port && url.port !== "443") throw new Error(`${label}不得携带端口`);
  const host = url.hostname.toLowerCase();
  if (host !== hostSuffix && !host.endsWith(`.${hostSuffix}`)) {
    throw new Error(`${label}域名不在白名单：${host}`);
  }
  if (pathPrefix && !url.pathname.startsWith(pathPrefix)) {
    throw new Error(`${label}路径不在白名单：${url.pathname}`);
  }
  return url;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/**
 * 读回响应体，并守住体积上限与时限。
 * 有流就边读边数（超了当场停），没有流就用 arrayBuffer 再量一次。
 */
async function readBody(response, maxBytes, label, timeoutMs) {
  const stream = response?.body;
  const read = async () => {
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value?.length ?? 0;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* 取消失败不影响判定 */ }
          throw new Error(`${label}实际超过 ${maxBytes} 字节上限`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }
    if (typeof response?.arrayBuffer !== "function") throw new Error(`${label}响应没有可读的正文`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`${label}实际 ${buffer.length} 字节，超过上限`);
    return buffer;
  };
  return await withTimeout(read(), timeoutMs, `${label}读正文`);
}

/**
 * 下载一段二进制。Content-Length 声明超限就直接拒绝；实际读到的大小也要再查一遍，
 * 超限就整份作废——绝不把截断了一半的媒体当视频用。
 */
export async function downloadBinary(fetcher, rawUrl, {
  hostSuffix, pathPrefix = null, maxBytes, timeoutMs, label,
}) {
  const url = assertSafeUrl(rawUrl, { hostSuffix, pathPrefix, label });
  if (typeof fetcher !== "function") throw new Error("宿主网络能力不可用");
  const response = await withTimeout(fetcher(url.href, {
    method: "GET",
    headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
    timeoutMs,
    maxResponseBytes: maxBytes,
  }), timeoutMs, `${label}请求`);
  if (!response?.ok) throw new Error(`${label}下载失败（HTTP ${response?.status ?? "?"}）`);
  // 落地域也要过白名单：重定向不能把取数带到别处。
  assertSafeUrl(response?.url || url.href, { hostSuffix, pathPrefix, label: `${label}落地域` });
  const declared = toNumber(headerValue(response?.headers, "content-length"));
  if (declared !== null && declared > maxBytes) {
    throw new Error(`${label}声明 ${declared} 字节，超过 ${maxBytes} 字节上限`);
  }
  return await readBody(response, maxBytes, label, timeoutMs);
}

// ── 内容嗅探：只认真容器 ────────────────────────────────────────

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function isWebp(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12
    && buffer.subarray(0, 4).toString("latin1") === "RIFF"
    && buffer.subarray(8, 12).toString("latin1") === "WEBP";
}

function looksLikePlaylist(buffer) {
  const head = buffer.subarray(0, 64).toString("latin1").trimStart();
  return head.startsWith("#EXTM3U") || head.startsWith("<MPD") || head.startsWith("<?xml")
    || head.startsWith("<html") || head.startsWith("<HTML");
}

/**
 * 媒体容器：只认 ftyp 的 MP4 与 FLV。
 * 播��单、未知容器一律拒——不能让下载来的东西被 ffmpeg 当成 playlist 或脚本去读本机文件。
 */
export function sniffMediaContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (looksLikePlaylist(buffer)) return null;
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (buffer.subarray(0, 3).toString("latin1") === "FLV") return ".flv";
  return null;
}

/** 封面：只认真 JPEG / PNG / WebP。 */
export function sniffCoverImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (looksLikePlaylist(buffer)) return null;
  if (isJpeg(buffer)) return { mimeType: "image/jpeg", extension: ".jpg" };
  if (isPng(buffer)) return { mimeType: "image/png", extension: ".png" };
  if (isWebp(buffer)) return { mimeType: "image/webp", extension: ".webp" };
  return null;
}

// ── ffmpeg 调用 ────────────────────────────────────────────────

/** 子进程只拿到够用的环境变量，不把宿主的密钥环境整个传下去。 */
function childEnv(env = process.env) {
  const allow = ["PATH", "SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"];
  const out = {};
  for (const key of allow) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 正式调 ffmpeg：不走 shell、不给 stdin、时限与缓冲都有界。 */
async function runFfmpeg(exec, exePath, args, { timeoutMs }) {
  return await exec(exePath, args, {
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: LIMITS.execMaxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(),
  });
}

function scaleFilter(withDivisible) {
  const base = `scale=${LIMITS.longEdge}:${LIMITS.longEdge}:force_original_aspect_ratio=decrease`;
  return withDivisible ? `${base}:force_divisible_by=2` : base;
}

// ── 解码 ───────────────────────────────────────────────────────

/**
 * 解码出采样帧：每个采样点单独一次本地解码，取那一时刻的一帧。
 *
 * 为什么逐点解码而不是「一次 fps=2 + select 若干帧」：
 * 本机 ffmpeg 7.1 上，**当前这组命令组合**（fps=2 + 多段 select=between(t,…)，
 * 再接 scale）复现出过错帧：8 段表达式只放行 2 帧，其余输出是 image2 复用同一帧
 * 补出来的（日志里 dup=17），内容全错。这是该命令组合的问题，不要外推成
 * 「ffmpeg 的 select 一律不可靠」——单段 select、别的写法都另说。
 * 逐点解码没有这些坑，且每一帧都能打出真实源时间（showinfo 的 pts_time）。
 *
 * 逐点解码的代价是 N 次子进程（N ≤ 9），但只下载一次媒体，N 次都读同一个本地文件。
 */
async function decodeSamples({ exec, exePath, mediaPath, outDir, sampleTimes, timeoutMsFor }) {
  const frames = [];
  for (let i = 0; i < sampleTimes.length; i += 1) {
    const target = sampleTimes[i];
    const out = path.join(outDir, `sample_${String(i + 1).padStart(2, "0")}.jpg`);
    // 变体顺序：先带容器白名单与偶数尺寸；老版本 ffmpeg 不认某个选项时退到下一档。
    const variants = [
      { whitelist: true, divisible: true },
      { whitelist: true, divisible: false },
      { whitelist: false, divisible: true },
      { whitelist: false, divisible: false },
    ];
    let stderr = "";
    let failed = null;
    for (const variant of variants) {
      const args = [
        "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-y",
        // ffmpeg 只准读本地文件：远程取数只能走 ctx.network.fetch。
        "-protocol_whitelist", "file,pipe",
      ];
      if (variant.whitelist) args.push("-format_whitelist", "mov,flv");
      args.push(
        // -copyts：保留源时间戳，showinfo 打出来的才是绝对源时间。
        "-copyts",
        "-ss", target.toFixed(3),
        "-i", mediaPath,
        "-an", "-sn", "-dn",
        "-vf", `${scaleFilter(variant.divisible)},showinfo`,
        "-frames:v", "1",
        "-q:v", "3",
        out,
      );
      try {
        const outcome = await runFfmpeg(exec, exePath, args, { timeoutMs: timeoutMsFor() });
        stderr = outcome?.stderr ?? "";
        failed = null;
        break;
      } catch (error) {
        failed = error;
      }
    }
    if (failed) throw new Error(`抽帧失败（${target}s）：${String(failed?.message ?? failed).slice(0, 160)}`);
    let buffer = null;
    try {
      buffer = await fsp.readFile(out);
    } catch {
      buffer = null;
    }
    if (!buffer || !isJpeg(buffer)) throw new Error(`抽帧失败（${target}s）：没有产出可读画面`);

    // 帧的真实时间必须是 showinfo 打出来的那个；拿不到就不拿这一帧。
    const match = /pts_time:([0-9.]+)/u.exec(stderr);
    const pts = match ? Number(match[1]) : null;
    if (pts === null || !Number.isFinite(pts) || pts < 0) {
      throw new Error(`抽帧失败（${target}s）：读不出这一帧的真实时间`);
    }
    if (Math.abs(pts - target) > LIMITS.ptsToleranceSec) {
      throw new Error(`抽帧失败（${target}s）：这一帧的真实时间是 ${pts}s，偏得太远`);
    }
    frames.push({ file: out, buffer, at: pts, target });
  }
  return frames;
}

/** 单张图超限时重压一次；还超就丢掉，不拿一张巨图充数。 */
async function squeezeFrame({ exec, exePath, frame, outDir, timeoutMsFor }) {
  if (frame.buffer.length <= LIMITS.frameBytes) return frame;
  const out = path.join(outDir, `squeezed_${path.basename(frame.file)}`);
  const args = [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y",
    "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "image2",
    "-i", frame.file,
    "-an", "-sn", "-dn",
    "-vf", scaleFilter(false),
    "-frames:v", "1",
    "-q:v", "8",
    out,
  ];
  try {
    await runFfmpeg(exec, exePath, args, { timeoutMs: timeoutMsFor() });
    const buffer = await fsp.readFile(out);
    if (isJpeg(buffer) && buffer.length <= LIMITS.frameBytes) return { ...frame, buffer };
  } catch {
    // 压不动就算了，这张不要。
  }
  return null;
}

// ── 主流程 ────────────────────────────────────────────────────

/**
 * 取帧。
 *
 * @param {object} ctx        App 上下文（用 ctx.process / ctx.network / ctx.dataDir）
 * @param {object} options
 * @param {object} options.video    视频元信息（至少含 duration）
 * @param {string} options.mediaUrl  已验证的 *.bilivideo.com 媒体直链
 * @param {string} options.coverUrl  可选的 *.hdslb.com/bfs/archive 封面
 * @param {object} options.plan      planVideoFrames 的产物
 * @param {object} [options.deps]    注入依赖：fetch / resolveExecutable / execFile
 * @returns {Promise<{parts: Array, sampleTimes: number[], clip: {from:number,to:number}, coverSeen: boolean}>}
 */
export async function readVideoFrames(ctx, { video, mediaUrl, coverUrl, plan, deps: inlineDeps } = {}, depsArg = {}) {
  const deps = { ...depsArg, ...(inlineDeps ?? {}) };
  const sampleTimes = Array.isArray(plan?.sampleTimes) ? plan.sampleTimes : [];
  const clip = plan?.clip ?? { from: 0, to: 0 };
  if (!sampleTimes.length) throw new Error("没有采样点，拒绝取帧");
  if (sampleTimes.length > LIMITS.maxSamples) throw new Error("采样点超过上限");

  // 计划自检：非负、严格递增、在视频时长内；clip 两端必须是采样点本身。
  const duration = toNumber(video?.duration);
  for (let i = 0; i < sampleTimes.length; i += 1) {
    const t = sampleTimes[i];
    if (!Number.isFinite(t) || t < 0) throw new Error("采样点不合法");
    if (i > 0 && t <= sampleTimes[i - 1]) throw new Error("采样点未严格递增");
    if (duration !== null && t > duration + 1e-6) throw new Error("采样点越过了视频时长");
  }
  if (!sampleTimes.includes(clip.from) || !sampleTimes.includes(clip.to)) {
    throw new Error("clip 两端必须是采样点本身");
  }
  // 局部连续段：落在 clip 里的那些点。跨片稀疏点不在里面。
  const localTargets = sampleTimes.filter((t) => t >= clip.from && t <= clip.to);
  if (!localTargets.length) throw new Error("clip 里没有局部连续采样点");

  if (!mediaUrl) throw new Error("没有媒体地址，拒绝取帧");

  const dataDir = ctx?.dataDir;
  if (!dataDir) throw new Error("没有 dataDir，临时目录无处安放");

  const fetchImpl = deps.fetch ?? (typeof ctx?.network?.fetch === "function" ? ctx.network.fetch.bind(ctx.network) : null);
  const resolveImpl = deps.resolveExecutable
    ?? (typeof ctx?.process?.resolveExecutable === "function" ? ctx.process.resolveExecutable.bind(ctx.process) : null);
  const execImpl = deps.execFile ?? execFileP;

  // 绝对时限：到点就是到点，后面的步骤不再开始。
  // 时钟可注入（测试用），默认就是真实时间。
  const clock = typeof deps.now === "function" ? deps.now : () => Date.now();
  const deadline = clock() + LIMITS.operationTimeoutMs;
  const remaining = () => deadline - clock();
  const requireTime = (label) => {
    const left = remaining();
    if (left <= 0) throw new Error(`取帧超时（${label}）`);
    return left;
  };
  const timeoutMsFor = (label = "解码") => Math.min(LIMITS.execTimeoutMs, requireTime(label));

  // 1) 正式定位 ffmpeg。没有 app/process.spawn 授权时这里会被宿主挡住。
  if (typeof resolveImpl !== "function") throw new Error("宿主没有提供可执行文件定位能力（需要 app/process.spawn）");
  let exe = null;
  try {
    exe = await resolveVideoFfmpeg(resolveImpl, { remainingMs: () => requireTime("定位 ffmpeg") });
  } catch (error) {
    const reason = String(error?.message ?? error);
    if (/超时/u.test(reason)) throw error;
    const failure = new Error(`定位 ffmpeg 失败：${reason.slice(0, 160)}`);
    failure.code = error?.code;
    throw failure;
  }
  if (!exe?.path) throw new Error("本机没有可用的 ffmpeg");

  let tempDir = null;
  try {
    tempDir = await fsp.mkdtemp(path.join(dataDir, "video-frames-"));

    // 2) 媒体先落本地。ffmpeg 不许自己拉远程地址。
    const mediaBuffer = await downloadBinary(fetchImpl, mediaUrl, {
      hostSuffix: MEDIA_HOST_SUFFIX,
      maxBytes: LIMITS.mediaBytes,
      timeoutMs: Math.min(LIMITS.networkTimeoutMs, requireTime("媒体下载")),
      label: "媒体",
    });
    if (mediaBuffer.length < 1024) throw new Error("媒体内容过小，可能下载失败");
    // 容器只认真 MP4/FLV；临时文件名按内容嗅探，不从 URL 拼。
    const extension = sniffMediaContainer(mediaBuffer);
    if (!extension) throw new Error("媒体不是可识别的 MP4/FLV，放弃");
    const mediaPath = path.join(tempDir, `source${extension}`);
    await fsp.writeFile(mediaPath, mediaBuffer);

    // 3) 封面是可选件：取不到就 coverSeen=false，但不能因此说"看懂了正片"。
    let coverPart = null;
    if (coverUrl) {
      try {
        const coverBuffer = await downloadBinary(fetchImpl, coverUrl, {
          hostSuffix: COVER_HOST_SUFFIX,
          pathPrefix: COVER_PATH_PREFIX,
          maxBytes: LIMITS.coverBytes,
          timeoutMs: Math.min(LIMITS.networkTimeoutMs, requireTime("封面下载")),
          label: "封面",
        });
        const sniffed = sniffCoverImage(coverBuffer);
        if (!sniffed) throw new Error("封面不是真实图片");
        // 临时名带正确的扩展名：ffmpeg 靠它选 image2 解复用器。
        const coverSrc = path.join(tempDir, `cover_src${sniffed.extension}`);
        await fsp.writeFile(coverSrc, coverBuffer);
        const coverOut = path.join(tempDir, "cover_512.jpg");
        // 封面只准走图片解复用器，不许被当成别的东西读；老版本 ffmpeg 不认这个选项时退一档。
        const coverVariants = [
          ["-format_whitelist", "image2,webp_pipe,png_pipe"],
          [],
        ];
        let coverFailed = null;
        for (const extra of coverVariants) {
          try {
            await runFfmpeg(execImpl, exe.path, [
              "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y",
              "-protocol_whitelist", "file,pipe",
              ...extra,
              "-i", coverSrc,
              "-an", "-sn", "-dn",
              "-vf", scaleFilter(false),
              "-frames:v", "1",
              "-q:v", "3",
              coverOut,
            ], { timeoutMs: timeoutMsFor("封面缩放") });
            coverFailed = null;
            break;
          } catch (error) {
            coverFailed = error;
          }
        }
        if (coverFailed) throw coverFailed;
        const scaled = await fsp.readFile(coverOut);
        if (isJpeg(scaled) && scaled.length <= LIMITS.frameBytes) {
          coverPart = { mimeType: "image/jpeg", data: scaled, kind: "cover" };
        }
      } catch {
        coverPart = null;   // 封面失败不算正片失败
      }
    }

    // 4) 正片帧。拿不到就整体失败：不能只留一张封面就让主流程以为"看懂了"。
    const frames = await decodeSamples({
      exec: execImpl,
      exePath: exe.path,
      mediaPath,
      outDir: tempDir,
      sampleTimes,
      timeoutMsFor,
    });
    if (frames.length !== sampleTimes.length) {
      throw new Error(`正片画面只取到 ${frames.length}/${sampleTimes.length} 帧，放弃整批`);
    }

    // 局部连续段的自检：相邻帧间隔要在 2fps 附近，整体跨度不超过 2.5 秒出头。
    const localFrames = frames.filter((frame) => frame.target >= clip.from && frame.target <= clip.to);
    if (localFrames.length !== localTargets.length) {
      throw new Error(`局部连续段只取到 ${localFrames.length}/${localTargets.length} 帧，放弃整批`);
    }
    for (let i = 1; i < localFrames.length; i += 1) {
      const gap = localFrames[i].at - localFrames[i - 1].at;
      if (gap < LIMITS.localGapMinSec || gap > LIMITS.localGapMaxSec) {
        throw new Error(`局部连续段间隔 ${gap.toFixed(3)}s 不在 2fps 附近，放弃整批`);
      }
    }
    const localSpan = localFrames[localFrames.length - 1].at - localFrames[0].at;
    if (localSpan > LIMITS.localSpanMaxSec) {
      throw new Error(`局部连续段跨度 ${localSpan.toFixed(3)}s 太长，放弃整批`);
    }

    const kept = [];
    for (const frame of frames) {
      const squeezed = await squeezeFrame({
        exec: execImpl, exePath: exe.path, frame, outDir: tempDir, timeoutMsFor,
      });
      if (squeezed) kept.push(squeezed);
    }
    // 压体积压不下去也是「缺帧」：宁可整批失败，也不能少一帧却报「看过了」。
    if (kept.length !== sampleTimes.length) {
      throw new Error(`正片画面只保下 ${kept.length}/${sampleTimes.length} 帧，放弃整批`);
    }

    // 5) 合计上限 5MB。超了就是超了，不静默丢帧——那会让人以为计划被完整执行了。
    const total = kept.reduce((sum, frame) => sum + frame.buffer.length, 0) + (coverPart?.data.length ?? 0);
    if (total > LIMITS.totalBytes) {
      throw new Error(`正片画面合计 ${total} 字节，超过 ${LIMITS.totalBytes} 字节上限`);
    }

    const parts = [];
    if (coverPart) parts.push(coverPart);
    for (const frame of kept) {
      parts.push({ mimeType: "image/jpeg", data: frame.buffer, kind: "sample", at: frame.at });
    }

    // 时间戳按实到的帧算；clip 只描述局部连续段，不把跨片点塞进去。
    const actualTimes = kept.map((frame) => frame.at);
    const localTimes = kept
      .filter((frame) => frame.target >= clip.from && frame.target <= clip.to)
      .map((frame) => frame.at);
    return {
      parts,
      sampleTimes: actualTimes,
      clip: { from: Math.min(...localTimes), to: Math.max(...localTimes) },
      coverSeen: Boolean(coverPart),
    };
  } finally {
    if (tempDir) {
      try {
        // 子进程都带 timeout，到这里时该杀的已经杀了；删完不留残骸。
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 临时目录删不掉也不能拖垮主流程。
      }
    }
  }
}
