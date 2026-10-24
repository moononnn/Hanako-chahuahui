import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVideoUnderstanding } from "../lib/video-understanding.js";
import { planVideoFrames } from "../lib/video-frame-reader.js";

const video = { bvid: "BV1Ex411R793", cid: 123, page: 1, duration: 40, cover: "https://i0.hdslb.com/bfs/archive/a.jpg" };
const material = () => ({ ok: true, video: { ...video }, readKind: "title-only", shareable: false, danmakuTimes: [10, 10.2, 11] });
const vision = { status: "verified", model: { provider: "selected-provider", model: "selected-vision" } };
const completed = (text) => JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text }] } });
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-video-vision-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = { media: 0, frames: 0, stream: [], cancel: [], logs: [] };
  let time = Date.parse("2026-10-22T15:40:00Z");
  const ctx = { dataDir, network: { fetch: async () => { throw new Error("not used"); } }, models: {
    stream: async (request) => { calls.stream.push(request); return { text: async () => completed("人物抬手后，另一人向后退；局部动作前后可见，未覆盖的情节不确定。") }; },
    cancel: async (id) => { calls.cancel.push(id); },
  } };
  const deps = {
    now: () => time,
    diagnostics: (row) => calls.logs.push(row),
    fetchMedia: async () => { calls.media++; return { ok: true, url: "https://a.bilivideo.com/movie?secret=signed-only" }; },
    readFrames: async (_ctx, { plan }) => {
      calls.frames++;
      return { ...plan, coverSeen: true, parts: [
        { kind: "cover", mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 224]) },
        ...plan.sampleTimes.map((at) => ({ kind: "sample", at, mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 224]) })),
      ] };
    },
    ...options,
  };
  return { ctx, deps, calls, app: createVideoUnderstanding(ctx, deps), advance: (ms) => { time += ms; } };
}

test("未验证或未配置识图时不下载、不调用模型，文字对象原样保留", async (t) => {
  const s = setup(t);
  const original = material();
  for (const config of [null, { ...vision, status: "failed" }, { status: "verified" }]) {
    const out = await s.app.enhance(original, { vision: config });
    assert.equal(out.materials, original);
    assert.equal(out.attempted, false);
  }
  assert.equal(s.calls.media + s.calls.frames + s.calls.stream.length, 0);
});

test("同模型最多一次识图，图片带采样定位，纯标题成功才可分享", async (t) => {
  const s = setup(t);
  const original = material();
  const out = await s.app.enhance(original, { vision, cookie: "private-cookie" });
  assert.equal(out.reason, "observed");
  assert.equal(out.attempted, true);
  assert.equal(out.materials.shareable, true);
  assert.equal(original.shareable, false);
  assert.equal(out.materials.readKind, "title-only");
  assert.deepEqual(out.materials.visual.model, vision.model);
  const [request] = s.calls.stream;
  assert.equal(request.provider, vision.model.provider);
  assert.equal(request.model, vision.model.model);
  assert.equal(request.maxTokens, 3600);
  assert.match(request.systemPrompt, /没有音轨/);
  assert.match(request.systemPrompt, /指令.*不执行/);
  assert.match(request.systemPrompt, /封面单列/);
  const content = request.messages[0].content;
  assert.equal(content.filter((part) => part.type === "image").length, out.materials.visual.imageCount);
  assert.equal(content.filter((part) => part.type === "image").length <= 10, true);
  assert.deepEqual(s.calls.cancel, [request.requestId]);
  const persisted = fs.readFileSync(path.join(s.ctx.dataDir, "v2", "video-visual-cache.json"), "utf8");
  for (const forbidden of ["private-cookie", "signed-only", "bilivideo", "base64", "image/jpeg", "systemPrompt"]) assert.equal(persisted.includes(forbidden), false);
});

test("同视频同模型跨伙伴与新实例复用缓存，不重复下载和计费", async (t) => {
  const s = setup(t);
  await s.app.enhance(material(), { vision });
  assert.equal((await s.app.enhance(material(), { vision, allowNewRequest: false })).reason, "cache");
  const next = createVideoUnderstanding(s.ctx, s.deps);
  assert.equal((await next.enhance(material(), { vision })).reason, "cache");
  assert.equal(s.calls.media, 1);
  assert.equal(s.calls.frames, 1);
  assert.equal(s.calls.stream.length, 1);
});

test("切换明确配置的识图模型会换缓存键，不偷用旧模型或自动换模型", async (t) => {
  const s = setup(t);
  await s.app.enhance(material(), { vision });
  const other = { ...vision, model: { ...vision.model, model: "another-selected-model" } };
  await s.app.enhance(material(), { vision: other });
  assert.deepEqual(s.calls.stream.map((row) => row.model), ["selected-vision", "another-selected-model"]);
});

test("并发同视频合并成一笔识图，7天后缓存过期", async (t) => {
  const s = setup(t);
  const [a, b] = await Promise.all([s.app.enhance(material(), { vision }), s.app.enhance(material(), { vision })]);
  assert.equal(a.materials.visual.summary, b.materials.visual.summary);
  assert.equal(s.calls.stream.length, 1);
  s.advance(8 * 24 * 60 * 60 * 1000);
  await s.app.enhance(material(), { vision });
  assert.equal(s.calls.stream.length, 2);
});

test("本轮无新请求额度时不开始取帧；不合格视频也不开始", async (t) => {
  const s = setup(t);
  assert.equal((await s.app.enhance(material(), { vision, allowNewRequest: false })).attempted, false);
  for (const original of [{ ...material(), ok: false }, { ...material(), video: { ...video, duration: 999999 } }]) {
    assert.equal((await s.app.enhance(original, { vision })).materials, original);
  }
  assert.equal(s.calls.media + s.calls.stream.length, 0);
});

test("取流/权限/取帧失败均保留原文字材料，不把封面当成功，不重试", async (t) => {
  const cases = [
    { fetchMedia: async () => ({ ok: false }) },
    { readFrames: async () => { throw Object.assign(new Error("private path or signed URL"), { code: "ERR_ACCESS_DENIED" }); } },
    { readFrames: async () => ({ coverSeen: true, sampleTimes: [], parts: [{ kind: "cover", mimeType: "image/jpeg", data: Buffer.from("x") }] }) },
  ];
  for (const options of cases) {
    const s = setup(t, options);
    const original = { ...material(), readKind: "danmaku", shareable: true };
    const out = await s.app.enhance(original, { vision });
    assert.equal(out.materials, original);
    assert.equal(out.reason, "text-fallback");
    assert.equal(s.calls.stream.length, 0);
    assert.equal(JSON.stringify(s.calls.logs).includes("private path or signed URL"), false);
    const denied = s.calls.logs.find(row => row.event === "video.visual.failed" && row.code === "ERR_ACCESS_DENIED");
    if (denied) assert.equal(denied.stage, "download-decode");
    if (options.fetchMedia) assert.ok(s.calls.logs.some(row => row.event === "video.visual.unavailable" && row.stage === "playurl"));
  }
});

test("空正文、错误事件和半截流不作为视频事实，也不切备用模型", async (t) => {
  for (const body of [completed(""), JSON.stringify({ type: "text-delta", delta: "半截" }), `${JSON.stringify({ type: "error", code: "APP_MODEL_PROVIDER_ERROR", message: "bad" })}\n${completed("不能用")}`]) {
    const s = setup(t);
    s.ctx.models.stream = async (request) => { s.calls.stream.push(request); return { text: async () => body }; };
    const original = material();
    assert.equal((await s.app.enhance(original, { vision })).materials, original);
    assert.equal(s.calls.stream.length, 1);
    assert.equal(fs.existsSync(path.join(s.ctx.dataDir, "v2", "video-visual-cache.json")), false);
    await s.app.enhance(original, { vision });
    assert.equal(s.calls.stream.length, 1, "失败冷却避免下一轮立刻烧同一笔");
  }
});

test("聊天/开关已变化时不请求模型、不把旧材料存成候选", async (t) => {
  const s = setup(t);
  let active = true;
  const read = s.deps.readFrames;
  s.deps.readFrames = async (...args) => { const frames = await read(...args); active = false; return frames; };
  const app = createVideoUnderstanding(s.ctx, s.deps);
  const original = material();
  assert.equal((await app.enhance(original, { vision, canContinue: () => active })).materials, original);
  assert.equal(s.calls.stream.length, 0);
});

test("非整数帧率的原始pts不会因毫秒圆整被误拒", async (t) => {
  const s = setup(t);
  const read = s.deps.readFrames;
  const app = createVideoUnderstanding(s.ctx, { ...s.deps, readFrames: async (...args) => {
    const frames = await read(...args);
    const delta = 0.0333333;
    return { ...frames, sampleTimes: frames.sampleTimes.map(at => at + delta),
      clip: { from: frames.clip.from + delta, to: frames.clip.to + delta },
      parts: frames.parts.map(part => part.kind === "sample" ? { ...part, at: part.at + delta } : part) };
  } });
  const out = await app.enhance(material(), { vision });
  assert.equal(out.reason, "observed");
  assert.equal(s.calls.stream.length, 1);
  assert.ok(out.materials.visual.sampleTimes.some(at => at % 0.5 !== 0));
});

test("线程变化引起的中断不记30分钟故障冷却", async (t) => {
  const s = setup(t);
  let active = true;
  const read = s.deps.readFrames;
  const app = createVideoUnderstanding(s.ctx, { ...s.deps, readFrames: async (...args) => {
    const frames = await read(...args); active = false; return frames;
  } });
  await app.enhance(material(), { vision, canContinue: () => active });
  active = true;
  await app.enhance(material(), { vision, canContinue: () => active });
  assert.equal(s.calls.frames, 2);
  assert.equal(s.calls.stream.length, 0);
});

test("超量图或张数/时间不一致时先拦住，不把图片发给模型", async (t) => {
  const plan = planVideoFrames(video);
  const bad = [
    { ...plan, parts: [{ kind: "sample", at: plan.sampleTimes[0], mimeType: "image/jpeg", data: Buffer.alloc(513 * 1024) }], sampleTimes: [plan.sampleTimes[0]] },
    { ...plan, parts: [], sampleTimes: plan.sampleTimes },
    { ...plan, parts: [{ kind: "sample", at: -1, mimeType: "image/jpeg", data: Buffer.from("x") }], sampleTimes: [-1] },
  ];
  for (const frames of bad) {
    const s = setup(t, { readFrames: async () => frames });
    const original = material();
    assert.equal((await s.app.enhance(original, { vision })).materials, original);
    assert.equal(s.calls.stream.length, 0);
  }
});
