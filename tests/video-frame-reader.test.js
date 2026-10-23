import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LIMITS,
  assertSafeUrl,
  ffmpegCandidates,
  planVideoFrames,
  readVideoFrames,
  sniffCoverImage,
  sniffMediaContainer,
} from "../lib/video-frame-reader.js";

// ── 测试替身：不起真实进程、不碰网络 ────────────────────────────

function jpeg(size) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.concat([head, Buffer.alloc(Math.max(4, size - head.length), 1)]);
}

function mp4(size) {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return Buffer.concat([head, Buffer.alloc(Math.max(4, size - head.length), 2)]);
}

function makeExec({
  frameSize = 1024, coverSize = 1024, squeezeSize = 512,
  writeFrames = true, failOn = null, ptsMode = "target", ptsOffset = 0,
} = {}) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (failOn && failOn(calls.length, args)) throw new Error("模拟失败");
    const joined = args.join(" ");
    const last = args[args.length - 1];
    if (joined.includes("showinfo")) {
      // 逐点取帧：真实 ffmpeg 会用 showinfo 打出这一帧的 pts_time。
      if (!writeFrames) return { stdout: "", stderr: "" };
      const target = Number(args[args.indexOf("-ss") + 1]);
      await fsp.writeFile(last, jpeg(frameSize));
      if (ptsMode === "none") return { stdout: "", stderr: "[Parsed_showinfo_1 @ 0x1] n: 0 pts: 0" };
      const pts = ptsMode === "negative" ? -1 : target + ptsOffset;
      return {
        stdout: "",
        stderr: `[Parsed_showinfo_1 @ 0x1] n:   0 pts:     0 pts_time:${pts}      duration:      1 duration_time:0.5     fmt:yuv420p`,
      };
    }
    if (joined.includes("-q:v 8")) {
      await fsp.writeFile(last, jpeg(squeezeSize));
      return { stdout: "", stderr: "" };
    }
    await fsp.writeFile(last, jpeg(coverSize));
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function makeFetch(routes) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : null;
    if (!route) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
    if (route.throw) throw new Error(route.throw);
    const body = route.body ?? Buffer.alloc(0);
    return {
      ok: route.ok !== false,
      status: route.status ?? 200,
      url: route.finalUrl ?? url,
      headers: { get: (name) => route.headers?.[name.toLowerCase()] ?? null },
      arrayBuffer: async () => body,
    };
  };
  return { fetch, calls };
}

async function makeDataDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "vfr-test-"));
}

const MEDIA_URL = "https://upos-sz-mirrorzos.bilivideo.com/upgcxcode/x.mp4";
const COVER_URL = "http://i2.hdslb.com/bfs/archive/cover.jpg";

function baseRoutes(overrides = {}) {
  return {
    "bilivideo.com": { body: mp4(4096) },
    "hdslb.com": { body: jpeg(2048) },
    ...overrides,
  };
}

// ── 采样计划 ────────────────────────────────────────────────────

test("计划：稀疏点+局部连续帧，升序、不超上限、落在半秒网格", () => {
  const plan = planVideoFrames({ duration: 40 }, {});
  assert.ok(plan.sampleTimes.length <= LIMITS.maxSamples);
  assert.ok(plan.sampleTimes.length >= 6);
  const sorted = [...plan.sampleTimes].sort((a, b) => a - b);
  assert.deepEqual(plan.sampleTimes, sorted);
  assert.equal(new Set(plan.sampleTimes).size, plan.sampleTimes.length);
  for (let i = 1; i < plan.sampleTimes.length; i += 1) {
    assert.ok(plan.sampleTimes[i] > plan.sampleTimes[i - 1], "采样点必须严格递增");
  }
  for (const t of plan.sampleTimes) {
    assert.ok(t >= 0 && t <= 39.5, `采样点越界：${t}`);
    assert.equal(Math.round(t * 2) / 2, t, `采样点不在半秒网格：${t}`);
  }
});

test("计划：clip 只描述局部连续段，不把跨片点塞进去", () => {
  const plan = planVideoFrames({ duration: 40 }, {});
  assert.ok(plan.sampleTimes.includes(plan.clip.from));
  assert.ok(plan.sampleTimes.includes(plan.clip.to));
  const span = plan.clip.to - plan.clip.from;
  assert.ok(span <= LIMITS.localSpanSec + 1e-9, `clip 跨度 ${span} 太大`);
  // 跨片稀疏点不该落在 clip 里
  const sparse = plan.sampleTimes.filter((t) => t < plan.clip.from || t > plan.clip.to);
  assert.ok(sparse.length >= 1, "应当还有跨片稀疏点");
  assert.ok(Math.max(...sparse) - Math.min(...sparse) > span, "跨片点应离局部段更远");
});

test("计划：局部 6 帧按 2fps 覆盖 2.5 秒", () => {
  const plan = planVideoFrames({ duration: 60 }, { hotTimes: [{ t: 40, count: 9 }, { t: 40.5, count: 8 }, { t: 41, count: 7 }] });
  const local = plan.sampleTimes.filter((t) => t >= 39 && t <= 43.5);
  assert.ok(local.length >= 5, `局部连续帧太少：${local.join(",")}`);
  const gaps = local.slice(1).map((t, i) => Math.round((t - local[i]) * 100) / 100);
  for (const gap of gaps) assert.ok(gap <= 0.5, `局部帧间距超过 2fps：${gap}`);
  assert.ok(plan.clip.from >= 39 && plan.clip.to <= 43.5);
});

test("计划：优先弹幕密集段", () => {
  const plan = planVideoFrames({ duration: 40 }, { hotTimes: [{ t: 30, count: 5 }, { t: 30.5, count: 4 }, { t: 31, count: 3 }] });
  const inCluster = plan.sampleTimes.filter((t) => t >= 29 && t <= 33);
  assert.ok(inCluster.length >= 4, `没有落在密集段：${plan.sampleTimes.join(",")}`);
  assert.ok(plan.clip.from >= 29 && plan.clip.to <= 33);
});

test("计划：没有可靠时间就用中段", () => {
  const plan = planVideoFrames({ duration: 40 }, { hotTimes: [] });
  const mid = plan.sampleTimes.filter((t) => t > 15 && t < 25);
  assert.ok(mid.length >= 5, `没有落回中段：${plan.sampleTimes.join(",")}`);
});

test("计划：短视频夹边，不越界不越量", () => {
  const plan = planVideoFrames({ duration: 3 }, {});
  assert.ok(plan.sampleTimes.length <= LIMITS.maxSamples);
  for (const t of plan.sampleTimes) assert.ok(t >= 0 && t <= 2.5, `短视频采样点越界：${t}`);
});

test("计划：时长未知就没有采样点", () => {
  const plan = planVideoFrames({}, {});
  assert.deepEqual(plan.sampleTimes, []);
  assert.deepEqual(plan.clip, { from: 0, to: 0 });
});

// ── 地址白名单、内容嗅探与候选路径 ──────────────────────────────

test("白名单：只放行白名单域的 https，http 只升级不降级", () => {
  const ok = assertSafeUrl("http://i2.hdslb.com/bfs/archive/a.jpg", { hostSuffix: "hdslb.com", pathPrefix: "/bfs/archive/" });
  assert.equal(ok.protocol, "https:");
  assert.throws(() => assertSafeUrl("https://evil.com/a.jpg", { hostSuffix: "hdslb.com" }));
  assert.throws(() => assertSafeUrl("https://user:pw@i2.hdslb.com/bfs/archive/a.jpg", { hostSuffix: "hdslb.com" }));
  assert.throws(() => assertSafeUrl("https://i2.hdslb.com:8443/bfs/archive/a.jpg", { hostSuffix: "hdslb.com" }));
  assert.throws(() => assertSafeUrl("ftp://i2.hdslb.com/bfs/archive/a.jpg", { hostSuffix: "hdslb.com" }));
  assert.throws(() => assertSafeUrl("https://i2.hdslb.com/bfs/other/a.jpg", { hostSuffix: "hdslb.com", pathPrefix: "/bfs/archive/" }));
});

test("嗅探：媒体只认真 MP4/FLV，播��单一律拒", () => {
  assert.equal(sniffMediaContainer(mp4(2048)), ".mp4");
  assert.equal(sniffMediaContainer(Buffer.concat([Buffer.from("FLV"), Buffer.alloc(64, 1)])), ".flv");
  assert.equal(sniffMediaContainer(Buffer.from("#EXTM3U\n#EXTINF:10,\nhttp://evil/x.ts")), null);
  assert.equal(sniffMediaContainer(Buffer.from("<MPD></MPD>")), null);
  assert.equal(sniffMediaContainer(Buffer.alloc(64, 7)), null);
  assert.equal(sniffMediaContainer(Buffer.from("not a media at all")), null);
});

test("嗅探：封面只认真 JPEG/PNG/WebP", () => {
  assert.deepEqual(sniffCoverImage(jpeg(2048)), { mimeType: "image/jpeg", extension: ".jpg" });
  assert.equal(sniffCoverImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]))?.extension, ".png");
  assert.equal(sniffCoverImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64)]))?.extension, ".webp");
  assert.equal(sniffCoverImage(Buffer.from("#EXTM3U\n")), null);
  assert.equal(sniffCoverImage(Buffer.alloc(64, 3)), null);
});

test("候选：先 ffmpeg，再按 homedir/APPDATA 算出来的目录，不含写死路径", () => {
  const candidates = ffmpegCandidates({ homedir: "D:\\Users\\someone\\AppData\\Local\\Temp\\fake", env: { APPDATA: "D:\\Users\\someone\\AppData\\Roaming" } });
  assert.equal(candidates[0], "ffmpeg");
  assert.ok(candidates.some((c) => c.includes("imageio_ffmpeg") && c.includes("Python314")));
  assert.ok(candidates.some((c) => c.includes("Python312")));
  for (const c of candidates) {
    assert.equal(/laotv/iu.test(c), false, `候选里写死了本机用户名：${c}`);
  }
});

// ── 取帧主流程（全部用替身） ────────────────────────────────────

test("取帧：封面+采样帧，返回的 clip 只覆盖局部段", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { exec, calls } = makeExec();
    const { fetch, calls: fetches } = makeFetch(baseRoutes());
    const result = await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, coverUrl: COVER_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: exec });

    assert.equal(result.coverSeen, true);
    assert.equal(result.parts.length, plan.sampleTimes.length + 1);
    assert.equal(result.parts[0].kind, "cover");
    // 时间戳按实到的帧算
    assert.deepEqual(result.sampleTimes, plan.sampleTimes);
    // clip 只描述局部连续段：不超过 2.5 秒出头，跨片点不在里面
    const span = result.clip.to - result.clip.from;
    assert.ok(span <= LIMITS.localSpanMaxSec, `返回的 clip 跨度 ${span} 太大`);
    assert.deepEqual(result.clip, plan.clip);
    for (const part of result.parts) {
      assert.equal(part.mimeType, "image/jpeg");
      assert.ok(Buffer.isBuffer(part.data));
      assert.ok(part.data.length <= LIMITS.frameBytes);
    }
    // ffmpeg 只准读本地文件，媒体不许它自己拉远程地址
    const decode = calls.find((call) => call.args.join(" ").includes("showinfo"));
    assert.ok(decode, "没有产生逐点解码调用");
    assert.ok(decode.args.includes("-protocol_whitelist"));
    assert.equal(decode.args[decode.args.indexOf("-protocol_whitelist") + 1], "file,pipe");
    assert.ok(decode.args.includes("-format_whitelist"));
    assert.equal(decode.args[decode.args.indexOf("-format_whitelist") + 1], "mov,flv");
    assert.ok(decode.args.includes("-nostdin"));
    assert.ok(decode.args.includes("-an"));
    assert.ok(decode.args.includes("-sn"));
    const input = decode.args[decode.args.indexOf("-i") + 1];
    assert.ok(input.startsWith(dataDir), `解码输入不在 dataDir 内：${input}`);
    assert.equal(/^https?:/iu.test(input), false);
    // 逐点解码：每个采样点一次，取那一时刻的一帧
    const decodeCalls = calls.filter((call) => call.args.join(" ").includes("showinfo"));
    assert.equal(decodeCalls.length, plan.sampleTimes.length);
    const seeks = decodeCalls.map((call) => Number(call.args[call.args.indexOf("-ss") + 1]));
    assert.deepEqual(seeks, plan.sampleTimes);
    assert.ok(decode.args.includes("-copyts"), "缺 -copyts，showinfo 打出来的就不是绝对源时间");
    // 子进程不碰 shell、不给 stdin、时限与缓冲有界
    assert.equal(decode.options.shell, false);
    assert.equal(decode.options.windowsHide, true);
    assert.equal(decode.options.stdio[0], "ignore");
    assert.ok(decode.options.timeout > 0 && decode.options.timeout <= LIMITS.operationTimeoutMs);
    assert.ok(decode.options.maxBuffer > 0);
    // 下载不带 Cookie
    for (const call of fetches) {
      const headers = call.options.headers ?? {};
      assert.equal(headers.Cookie, undefined);
      assert.equal(headers.cookie, undefined);
      assert.equal(call.options.method, "GET");
    }
    // 临时目录用完即删
    assert.deepEqual((await fsp.readdir(dataDir)).filter((n) => n.startsWith("video-frames-")), []);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：域名不在白名单就拒绝，压根不下载", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch, calls } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: "https://evil.example.com/a.mp4", plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec }),
    );
    assert.equal(calls.length, 0);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：声明超限直接拒绝，不下载半个视频", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes({
      "bilivideo.com": { body: mp4(4096), headers: { "content-length": String(LIMITS.mediaBytes + 1) } },
    }));
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：媒体是伪装成 mp4 的播��单就拒绝", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes({
      "bilivideo.com": { body: Buffer.from("#EXTM3U\n#EXTINF:10,\nhttp://evil/x.ts") },
    }));
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：封面不是真图片就当封面失败，正片照常", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes({ "hdslb.com": { body: Buffer.from("<html>not an image</html>") } }));
    const result = await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, coverUrl: COVER_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec });
    assert.equal(result.coverSeen, false);
    assert.equal(result.parts.length, plan.sampleTimes.length);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：只拿到封面但正片帧失败，整体拒绝", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, coverUrl: COVER_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({ writeFrames: false }).exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：封面失败但正片够，继续并标 coverSeen=false", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes({ "hdslb.com": { throw: "封面挂了" } }));
    const result = await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, coverUrl: COVER_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec });
    assert.equal(result.coverSeen, false);
    assert.equal(result.parts.length, plan.sampleTimes.length);
    assert.ok(result.parts.every((part) => part.kind === "sample"));
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：http 封面被规范化成 https，媒体全程 https", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch, calls } = makeFetch(baseRoutes());
    await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, coverUrl: COVER_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec });
    for (const call of calls) assert.ok(call.url.startsWith("https://"), call.url);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：读不出真实时间就拒绝，不拿目标时间冒充", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({ ptsMode: "none" }).exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：时间明显偏离目标或为负都拒绝", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    const deps = { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }) };
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
        { ...deps, execFile: makeExec({ ptsMode: "negative" }).exec }),
    );
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
        { ...deps, execFile: makeExec({ ptsOffset: 3 }).exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：局部连续段间隔不在 2fps 附近就整批拒绝", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({ ptsOffset: 0.5 }).exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：单帧超限会重压，压完后仍在上限内", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    const result = await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({ frameSize: LIMITS.frameBytes + 100, squeezeSize: 1024 }).exec });
    for (const part of result.parts) assert.ok(part.data.length <= LIMITS.frameBytes);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：单帧压不动就整批失败，不报一个缺帧的“看过”", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({
          frameSize: LIMITS.frameBytes + 100,
          failOn: (count, args) => args.join(" ").includes("-q:v 8"),
        }).exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：宿主没放行 ffmpeg 就直接失败，不硬撑", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => null, execFile: makeExec().exec }),
    );
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => { throw new Error("APP_CAPABILITY_DENIED"); }, execFile: makeExec().exec }),
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：ffmpeg 报错就失败，临时目录照样清干净", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes());
    await assert.rejects(
      readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: planVideoFrames({ duration: 40 }, {}) },
        { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec({ failOn: () => true }).exec }),
    );
    assert.deepEqual((await fsp.readdir(dataDir)).filter((n) => n.startsWith("video-frames-")), []);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：计划不自洽就拒绝（不递增、越时长、clip 两端不是采样点）", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes());
    const deps = { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec };
    const good = planVideoFrames({ duration: 40 }, {});
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: { ...good, sampleTimes: [10, 5] } }, deps));
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: { ...good, sampleTimes: [10, 999] } }, deps));
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: { ...good, clip: { from: 11, to: 21.5 } } }, deps));
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: { ...good, clip: { from: 10, to: 30 } } }, deps));
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：没有采样点或没有媒体地址就拒绝", async () => {
  const dataDir = await makeDataDir();
  try {
    const { fetch } = makeFetch(baseRoutes());
    const deps = { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec };
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan: { sampleTimes: [], clip: { from: 0, to: 0 } } }, deps));
    await assert.rejects(readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: "", plan: planVideoFrames({ duration: 40 }, {}) }, deps));
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：60 秒硬上限到点就停，悬挂的下载不许继续", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    // 每次读时钟就往前跳 59.5 秒：剩下的时间立刻不够，悬挂的下载必须自己超时退出。
    let clock = Date.now();
    const now = () => { const value = clock; clock += 59_500; return value; };
    const hanging = () => new Promise(() => { /* 永不落地 */ });
    const promise = readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan }, {
      fetch: hanging,
      resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }),
      execFile: makeExec().exec,
      now,
    });
    await assert.rejects(promise, /超时/u);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("取帧：不会在工作台或别处留文件", async () => {
  const dataDir = await makeDataDir();
  try {
    const plan = planVideoFrames({ duration: 40 }, {});
    const { fetch } = makeFetch(baseRoutes());
    await readVideoFrames({ dataDir }, { video: { duration: 40 }, mediaUrl: MEDIA_URL, plan },
      { fetch, resolveExecutable: async () => ({ path: "C:\\fake\\ffmpeg.exe" }), execFile: makeExec().exec });
    const left = await fsp.readdir(dataDir);
    assert.deepEqual(left.filter((n) => !n.startsWith("video-frames-")), []);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("模块不引工作台路径，也不自带账本读写", () => {
  const source = fs.readFileSync(new URL("../lib/video-frame-reader.js", import.meta.url), "utf8");
  assert.equal(/哈娜的工作台/u.test(source), false);
  assert.equal(/[A-Za-z]:\\|L:\//u.test(source), false);
  assert.equal(/usage-ledger|readFileSync\(/u.test(source), false);
  assert.equal(/execSync|spawnSync\(/u.test(source), false);
});
