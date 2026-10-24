/**
 * 她发来的链接：伙伴调 read_bilibili_video 时，画面事实必须进 toolResult。
 *
 * 历史基线：2026-10-24 之前 createReadVideoTool 只走 collectInboundVideo → packMaterials，
 * 没接 videoUnderstanding.enhance，于是缓存里明明有这条视频的画面记录，工具回给伙伴的
 * 仍是「你只知道标题，没看过内容」。第一条用例就是那次的回归（现已修复，留作守卫）。
 *
 * 用真路由 + 假宿主：只 mock 网络（B站 view 元信息）与模型出口；不碰真实模型/真实网络。
 * 每个用例都通过 t.after 统一收尾（停泵、放行挂着的模型流、删临时目录），断言中途失败也不留悬挂。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { bootChahuahui } from "./helpers/app-harness.js";

const AGENT = "nova";
const PROVIDER = "test-provider";
const MODEL = "test-model";

/** A：缓存里有的那条（= 生产里真识过一次的那条）。 */
const A = { bvid: "BV1VthX6XE2E", cid: 30040000001, page: 1, duration: 54 };
/** B：缓存里没有的一条，用来验证「新尝试只发生一次」。 */
const B = { bvid: "BV1K1pY6cEdK", cid: 30040000099, page: 1, duration: 40 };
/** C：第三条新目标，额度已经被 B 用掉，它连取流都不该发生。 */
const C = { ...B, bvid: "BV1GJ411x7h7" };

/** 画面记录里只有它会出现的字样：断言靠它，避免和模板文案撞车。 */
const VISUAL_MARK = "局部连续段里那个人把篮状容器扣在头上";
const SAMPLE_TIMES = [13.5, 26, 26.5, 27, 27.5, 28, 28.5, 40.5];
const VISION_REQUEST_PREFIX = "chahuahui_video_visual_";
const INTERRUPT_TEXT = "不看视频了，先说别的";

const linkOf = (row) => `https://www.bilibili.com/video/${row.bvid}`;
const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const doneStop = (requestId) => ({ type: "done", requestId, stopReason: "stop", assistant: { role: "assistant", content: [] } });
const textDone = (requestId, delta) => [
  { type: "text-delta", requestId, delta },
  doneStop(requestId),
];

function viewPayload(row) {
  return {
    code: 0,
    message: "OK",
    data: {
      bvid: row.bvid,
      aid: 114500000000001,
      cid: row.cid,
      videos: 1,
      title: "测试用视频",
      desc: "",
      owner: { name: "测试UP" },
      duration: row.duration,
      pubdate: 1761000000,
      tname: "",
      stat: { view: 1, like: 1, favorite: 1 },
      pages: [{ cid: row.cid, page: 1, from: "vupload", part: "P1", duration: row.duration }],
      dimension: { width: 1080, height: 1920 },
    },
  };
}

function jsonResponse(url, payload) {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(Buffer.byteLength(body)) : null) },
    json: async () => payload,
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}

function notFound(url) {
  return {
    ok: false, status: 404, url,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

/**
 * 网络口：view 元信息按请求里的 bvid 回声；其余地址一律 404（不 reject，
 * 免得在 App 内部留下未处理的拒绝把用例带歪）。playurl 因此必然软失败。
 *
 * hold(url) 返回 true 的请求故意不放行，交给用例自己决定什么时候放——
 * 用来做「取流挂起时被打断」那条。
 */
function pumpNetwork(app, { hold = null } = {}) {
  const held = [];
  const timer = setInterval(() => {
    for (const entry of app.net.calls) {
      if (entry.__answered || entry.__held) continue;
      const url = String(entry.url);
      if (hold && hold(url)) {
        entry.__held = true;
        held.push(entry);
        continue;
      }
      entry.__answered = true;
      const hit = /\/x\/web-interface\/view\?bvid=([^&]+)/u.exec(url);
      if (hit) {
        const bvid = decodeURIComponent(hit[1]);
        const row = [A, B, C].find((item) => item.bvid === bvid) ?? { ...B, bvid };
        entry.resolve(jsonResponse(url, viewPayload(row)));
        continue;
      }
      entry.resolve(notFound(url));
    }
  }, 5);
  return {
    held,
    stop: () => clearInterval(timer),
    release(entry, row) {
      entry.__answered = true;
      entry.resolve(jsonResponse(String(entry.url), viewPayload(row)));
    },
  };
}

/** 按生产同 schema 预种一条画面记录（同视频 / 同模型 / 时间新鲜）。 */
function seedVisualCache(dataDir, row) {
  const key = createHash("sha256")
    .update(JSON.stringify([1, row.bvid, row.cid, row.page, row.duration, PROVIDER, MODEL]))
    .digest("hex");
  const dir = path.join(dataDir, "v2");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "video-visual-cache.json"), JSON.stringify({
    version: 1,
    entries: [{
      key,
      visual: {
        status: "ok",
        summary: `${VISUAL_MARK}；随后他抬头张嘴，字幕写着送去综合医院。`,
        model: { provider: PROVIDER, model: MODEL },
        imageCount: 9,
        coverSeen: true,
        sampleTimes: SAMPLE_TIMES,
        clip: { from: 26, to: 28.5 },
        observedAt: new Date().toISOString(),
      },
    }],
  }, null, 2), "utf8");
  return key;
}

function readCacheKeys(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "v2", "video-visual-cache.json"), "utf8"));
    return (raw?.entries ?? []).map((entry) => entry.key);
  } catch {
    return [];
  }
}

/** 临时目录里的真诊断：用来确认「没取到画面」是被额度挡住的，不是取材料失败。 */
function readDiagnostics(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, "v2", "diagnostics.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function boot({ vision = { model: { provider: PROVIDER, model: MODEL }, status: "verified" }, texts = [linkOf(A)] } = {}) {
  return bootChahuahui({
    seed(store) {
      if (vision) store.setGlobalSettings({ vision });
      store.setPartnerSettings(AGENT, {
        phone: { holding: true, untilMs: Date.now() + 60 * 60 * 1000 },
        rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 },
        voice: { enabled: false },
      });
      for (const value of texts) store.appendMessage(AGENT, { role: "user", text: value });
    },
  });
}

/** 断言失败也不留下悬挂：停泵、放行所有还挂着的模型流、删临时目录。 */
function cleanup(t, app, pump) {
  t.after(async () => {
    try { pump?.stop?.(); } catch { /* 已经停过 */ }
    for (const entry of app.models.calls) {
      if (entry.settled) continue;
      try { entry.resolve({ ndjson: ndjson(doneStop(entry.request?.requestId)), asEvent: true }); } catch { /* 已经收口 */ }
    }
    await sleep(50);
    try { fs.rmSync(app.dataDir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  });
}

const videoToolOffered = (request) => Array.isArray(request?.tools) && request.tools.some((tool) => tool?.name === "read_bilibili_video");
const toolResults = (request) => (request?.messages ?? []).filter((row) => row?.role === "toolResult");
const toolResultText = (request, toolCallId) => {
  const rows = toolResults(request);
  const row = toolCallId ? rows.find((item) => item.toolCallId === toolCallId) : rows[0];
  return String(row?.content?.[0]?.text ?? "");
};
const visionCalls = (app) => app.models.calls.filter((entry) => String(entry.request?.requestId ?? "").startsWith(VISION_REQUEST_PREFIX));
const mediaCalls = (app) => app.net.calls.filter((entry) => /bilivideo|\/playurl/u.test(String(entry.url)));

function toolCallEvents(requestId, calls) {
  return [
    ...calls.map((call) => ({ type: "tool-call", requestId, id: call.id, name: "read_bilibili_video", arguments: call.arguments })),
    {
      type: "done", requestId, stopReason: "toolUse",
      assistant: {
        role: "assistant",
        content: calls.map((call) => ({ type: "toolCall", id: call.id, name: "read_bilibili_video", arguments: call.arguments })),
      },
    },
  ];
}

// ── ① 核心回归：缓存有画面，toolResult 就必须带上它 ─────────────────
test("伙伴点开她发来的视频：toolResult 带画面事实，缓存命中不另发识图或取流", async (t) => {
  const app = await boot();
  const pump = pumpNetwork(app);
  cleanup(t, app, pump);

  const cacheKey = seedVisualCache(app.dataDir, A);
  assert.equal(cacheKey.length, 64, "缓存键必须是 64 位 sha256");

  const first = await app.models.waitForCallWhere(videoToolOffered, "带 read_bilibili_video 的模型请求", 8000);
  first.resolve({
    ndjson: ndjson(...toolCallEvents(first.request.requestId, [{ id: "call_video_1", arguments: { url: linkOf(A) } }])),
    asEvent: true,
  });

  const second = await app.models.waitForCallWhere((request) => toolResults(request).length > 0, "带 toolResult 的模型请求", 8000);
  const text = toolResultText(second.request, "call_video_1");
  assert.match(text, /【她刚给你发了一个视频】/u, "得说清这是她发来的那条");
  assert.match(text, /【画面记录】/u, "缓存里有画面记录，toolResult 就必须带上它");
  assert.ok(text.includes(VISUAL_MARK), `toolResult 里缺画面事实：${text.slice(0, 240)}`);
  assert.doesNotMatch(text, /你只知道标题/u, "手里有画面记录时，不能再按标题档说话");
  assert.doesNotMatch(text, /没看过内容/u, "手里有画面记录时，不能再声称没看过内容");
  assert.equal(visionCalls(app).length, 0, "缓存命中不该再发识图请求");
  assert.equal(mediaCalls(app).length, 0, "缓存命中不该再去取流");

  second.resolve({ ndjson: ndjson(...textDone(second.request.requestId, "看到了，那个容器扣头上确实好笑。")), asEvent: true });
  await sleep(150);
  assert.ok(app.models.replyCalls().length >= 2, "工具回合至少两轮模型请求");
});

// ── ② 没配好识图：不读画面、不取流，但文字材料照常给 ─────────────────
test("识图没验证通过：工具照常给标题文字，但不取画面也不取流", async (t) => {
  const app = await boot({ vision: { model: { provider: PROVIDER, model: MODEL }, status: "unverified" } });
  const pump = pumpNetwork(app);
  cleanup(t, app, pump);
  seedVisualCache(app.dataDir, A);

  const first = await app.models.waitForCallWhere(videoToolOffered, "带 read_bilibili_video 的模型请求", 8000);
  first.resolve({
    ndjson: ndjson(...toolCallEvents(first.request.requestId, [{ id: "call_no_vision", arguments: { url: linkOf(A) } }])),
    asEvent: true,
  });

  const second = await app.models.waitForCallWhere((request) => toolResults(request).length > 0, "带 toolResult 的模型请求", 8000);
  const text = toolResultText(second.request, "call_no_vision");
  assert.match(text, /【她刚给你发了一个视频】/u, "文字材料要照常给");
  assert.match(text, /· 标题：测试用视频/u, "标题这一档必须保留");
  assert.doesNotMatch(text, /【画面记录】/u, "识图没验证通过时不能出现画面记录");
  assert.equal(visionCalls(app).length, 0, "没验证通过时不该发识图请求");
  assert.equal(mediaCalls(app).length, 0, "没验证通过时不该去取流");

  second.resolve({ ndjson: ndjson(...textDone(second.request.requestId, "我先把标题记下了。")), asEvent: true });
  await sleep(150);
});

// ── ③ 工具在手边但伙伴不调：零视频网络 ───────────────────────────────
test("伙伴选择不调工具：手里有链接也一条视频请求都不发", async (t) => {
  const app = await boot();
  const pump = pumpNetwork(app);
  cleanup(t, app, pump);
  seedVisualCache(app.dataDir, A);

  const first = await app.models.waitForCallWhere(videoToolOffered, "带 read_bilibili_video 的模型请求", 8000);
  assert.ok(first, "她发了链接，工具应当递给伙伴（调不调是 ta 自己的事）");
  first.resolve({ ndjson: ndjson(...textDone(first.request.requestId, "这条我先不看，改天再说。")), asEvent: true });
  await sleep(200);

  assert.equal(app.net.calls.length, 0, "伙伴没点开，就不该有任何视频网络请求");
  assert.equal(visionCalls(app).length, 0, "更不该发识图请求");
  assert.ok(app.models.replyCalls().length <= 1, "没有工具回合，就只该有一条回复请求");
});

// ── ④ 一轮三次调用：缓存不占额度，新目标最多试一次 ───────────────────
test("同轮三条调用：缓存不占额度，B 用掉额度，C 连取流都不发生", async (t) => {
  const app = await boot();
  const pump = pumpNetwork(app);
  cleanup(t, app, pump);
  const cacheKey = seedVisualCache(app.dataDir, A);

  const first = await app.models.waitForCallWhere(videoToolOffered, "带 read_bilibili_video 的模型请求", 8000);
  first.resolve({
    ndjson: ndjson(...toolCallEvents(first.request.requestId, [
      { id: "call_cached", arguments: { url: linkOf(A) } },
      { id: "call_fresh_b", arguments: { url: linkOf(B) } },
      { id: "call_fresh_c", arguments: { url: linkOf(C) } },
    ])),
    asEvent: true,
  });

  const second = await app.models.waitForCallWhere(
    (request) => toolResults(request).length >= 3,
    "带三条 toolResult 的模型请求",
    8000,
  );
  const cachedText = toolResultText(second.request, "call_cached");
  const freshBText = toolResultText(second.request, "call_fresh_b");
  const freshCText = toolResultText(second.request, "call_fresh_c");

  // 缓存那条：画面事实照旧在
  assert.match(cachedText, /【画面记录】/u, "缓存那条照样要有画面记录");
  assert.ok(cachedText.includes(VISUAL_MARK), "缓存那条的画面事实不能丢");
  // 两条没缓存的：不许凭空有画面，但文字那一档要保留
  assert.doesNotMatch(freshBText, /【画面记录】/u, "B 取流失败，不能有画面记录");
  assert.doesNotMatch(freshCText, /【画面记录】/u, "C 额度已用尽，不能有画面记录");
  assert.match(freshCText, /· 标题：测试用视频/u, "C 仍然要拿到标题这一档文字");
  assert.match(freshCText, /【你只知道标题，没看过内容】/u, "C 该老实按标题档说话");

  // 新尝试只发生一次：只有 B 走到 playurl，且没真下媒体
  const playurlCalls = app.net.calls.filter((entry) => /\/playurl/u.test(String(entry.url)));
  assert.equal(playurlCalls.length, 1, "三个目标里只该有一次新取流尝试（缓存不占额度，C 被额度挡住）");
  assert.ok(/bvid=BV1K1pY6cEdK/u.test(String(playurlCalls[0].url)), "唯一那次应当属于 B");
  assert.equal(app.net.calls.filter((entry) => /bilivideo/u.test(String(entry.url))).length, 0, "取流在 playurl 就失败了，不该真下媒体");
  assert.equal(visionCalls(app).length, 0, "三条都没走到识图，就不该发识图请求");
  assert.ok(readCacheKeys(app.dataDir).includes(cacheKey), "缓存里那条记录必须还在");

  // 用临时诊断确认：C 是被额度挡住的，不是取材料失败
  await sleep(100);
  const rows = readDiagnostics(app.dataDir).filter((row) => row?.event === "chat.tool.video" && row?.ok === true);
  const rowB = rows.find((row) => row.bvid === B.bvid);
  const rowC = rows.find((row) => row.bvid === C.bvid);
  assert.ok(rowB, `没有 B 的工具诊断：${JSON.stringify(rows)}`);
  assert.equal(rowB.hasVisual, false);
  assert.equal(rowB.visualAttempted, true, "B 才是那次新尝试");
  assert.equal(rowB.visualReason, "text-fallback", "B 是取流失败后退回文字");
  assert.ok(rowC, `没有 C 的工具诊断：${JSON.stringify(rows)}`);
  assert.equal(rowC.visualReason, "budget-or-cooling", "C 必须是被额度挡住的");
  assert.equal(rowC.visualAttempted, false, "C 不该发起新尝试");
  assert.equal(rowC.readKind, "title-only", "C 的材料本身是取到的（不是 collection 失败）");

  second.resolve({ ndjson: ndjson(...textDone(second.request.requestId, "一条看过，另外两条没打开。")), asEvent: true });
  await sleep(150);
});

// ── ⑤ 取流挂起时插话打断：旧工具尽快退出，不再回喂、不再取流 ─────────
test("取流挂起时她插话：旧工具被中断，不再回喂那条结果也不再取流", async (t) => {
  // 只有 B 的 view 会被挂住，别的照常放行
  const app = await boot({ texts: [linkOf(A)] });
  const pump = pumpNetwork(app, { hold: (url) => /view\?bvid=BV1K1pY6cEdK/u.test(url) });
  cleanup(t, app, pump);
  seedVisualCache(app.dataDir, A);

  const first = await app.models.waitForCallWhere(videoToolOffered, "带 read_bilibili_video 的模型请求", 8000);
  first.resolve({
    ndjson: ndjson(...toolCallEvents(first.request.requestId, [{ id: "call_hang", arguments: { url: linkOf(B) } }])),
    asEvent: true,
  });

  // 等那条 view 真的挂在那儿：不下发就不会有「取流中被打断」这回事
  const heldView = await app.net.waitForCall(0, 4000);
  assert.match(String(heldView.url), /view\?bvid=BV1K1pY6cEdK/u, "第一次网络请求应当是那条 video 的元信息");

  // 她插话：走正式 /turns 路由（replyComposer.interrupt + 安静期重开）
  const startedAt = Date.now();
  const posted = await app.request("POST", "/turns", { json: { agentId: AGENT, text: INTERRUPT_TEXT } });
  assert.equal(posted?.status ?? 200, 200, `插话没被接受：${JSON.stringify(posted)}`);

  const reopened = await app.models.waitForCallWhere(
    (request) => videoToolOffered(request)
      && JSON.stringify(request.messages ?? []).includes(INTERRUPT_TEXT)
      && toolResults(request).length === 0,
    "插话后重开的那一轮模型请求",
    4000,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 4000, `重开太慢：${elapsed}ms`);
  assert.ok(!heldView.__answered, "旧那条 view 这时还应当挂在那儿（没有被偷偷放行）");

  // 新一轮先正常说完
  reopened.resolve({ ndjson: ndjson(...textDone(reopened.request.requestId, "行，那先聊别的。")), asEvent: true });
  await sleep(150);

  // 现在才放行旧 view：旧工具已被打断，它的结果不该再被回喂，也不该去取流
  pump.release(heldView, B);
  await sleep(400);

  // 先分辨“真回喂”与“共享数组被事后追加”：
  // 若真发了一轮回喂，replyCalls 会多一条；只有数组被改则仍是一开始那两条。
  const rounds = app.models.replyCalls();
  const afterReopen = rounds.filter((entry) => entry.index > reopened.index);
  t.diagnostic(`插话后总轮次=${rounds.length}（期望 2）；第一轮消息数组当前 toolResult 数=${toolResults(first.request).length}`);
  assert.equal(
    afterReopen.length,
    0,
    `插话后不该再冒出新的一轮（含旧回合的重试）；实际：${afterReopen.map((entry) => String(entry.request?.requestId ?? "")).join(",")}`,
  );
  assert.equal(toolResults(reopened.request).length, 0, "重开那一轮不该带 toolResult");
  assert.equal(app.net.calls.filter((entry) => /\/playurl/u.test(String(entry.url))).length, 0, "被打断后不该再发起取流");
  assert.equal(visionCalls(app).length, 0, "更不该发识图请求");
});
