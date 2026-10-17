import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";
import { dayKey } from "../lib/days.js";
import { makeVideoCandidate, addVideoCandidate, recordVideoShare } from "../lib/video-sharing.js";
import { createVideoLogin } from "../lib/video-login.js";
import { readVideoCredential, writeVideoCredential } from "../lib/video-source.js";

// 有一批用例靠内测路由 /proactive/tick 驱动主动联系；发布副本整块剥掉哨兵后那条路由不存在，
// 这种形态下只跑不依赖它的用例，依赖的如实跳过（与 focus-routes / proactive-reasons 同一口径）。
const SKIP_DEV = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8").includes("// __CHAHUAHUI_DEV_ONLY_END__")
  ? false : "发布副本已剥掉内测巡检路由";
const AGENT = "nova";
const LINK = "https://www.bilibili.com/video/BV1bXt9z9ESP?p=2";
const now = () => new Date().toISOString();
function candidate() {
  return makeVideoCandidate({ readKind: "subtitle", video: {
    bvid: "BV1bXt9z9ESP", aid: 123, cid: 456, page: 2, duration: 100,
    title: "半岛铁盒制作", author: "手作频道", desc: "石膏制作教程", link: LINK,
  }, subtitle: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "半岛铁盒用石膏浇筑，泡沫板做模具。" })) }, {
    interest: { id: "craft", name: "手作" }, plan: { focus: "半岛铁盒制作", searchQuery: "石膏手作" },
  });
}
function seed(store) {
  const hour = (new Date().getHours() + 9) % 24;
  const start = `${String(hour).padStart(2, "0")}:00`;
  const end = `${String((hour + 1) % 24).padStart(2, "0")}:00`;
  store.setGlobalSettings({ rhythmProactiveEnabled: true, videoShareMaxPerDay: 1, quiet: { start, end }, globalGate: { minGapMinutes: 0, maxPerDay: 24 } });
  store.setPartnerSettings(AGENT, { proactiveEnabled: true, videoSharingEnabled: true, tier: "often", model: { provider: "test-provider", model: "test-model" },
    hobbySeedTryAt: now(), sleep: { shape: 2, start, hours: 7, nap: { start: end, minutes: 20 } },
    phone: { holding: true, untilMs: Date.now() + 3600000 }, rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 }, voice: { enabled: false },
  });
  const knowing = store.getKnowing(AGENT);
  store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } } });
  store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() - 3600000).toISOString(),
    interestLearning: { curiosity: { startedAt: now(), thresholdMs: 86400000 } }, topicSeeds: { lastGrowAt: now(), seeds: [] },
  });
  store.appendMessage(AGENT, { role: "user", text: "刚把手上的事情忙完", readAt: now(), at: now() });
  store.appendMessage(AGENT, { role: "assistant", text: "我也歇一会儿", at: now() });
  store.saveVideoBook(AGENT, addVideoCandidate(store.getVideoBook(AGENT), candidate()));
}
async function boot(t, seeded = seed) {
  const app = await bootChahuahui({ seed: seeded });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return app;
}
const disk = (app) => createStore(app.dataDir);
async function sendVideo(app, output, during = null) {
  const original = Math.random;
  Math.random = () => 0;
  try {
    const pending = app.request("POST", "/proactive/tick", { json: {} });
    await app.models.waitForCall(0);
    if (during) await during();
    app.models.release(0, output);
    return await pending;
  } finally { Math.random = original; }
}

test('集中B站设置与旧伙伴入口共用布尔字段，0条暂停保留名单', async (t) => {
  const app = await boot(t, () => {});
  assert.equal((await app.request('GET', '/settings')).body.partners.find(row => row.id === AGENT).settings.videoSharingEnabled, false);
  const saved = await app.request('PUT', '/settings/video-sharing', { json: { maxPerDay: 0, partnerIds: [AGENT, AGENT] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.global.videoShareMaxPerDay, 0);
  assert.deepEqual(saved.body.partners, [{ id: AGENT, videoSharingEnabled: true }]);
  assert.equal((await app.request('GET', '/settings')).body.partners.find(row => row.id === AGENT).settings.videoSharingEnabled, true);
  await app.request('PUT', `/settings/partner/${AGENT}`, { json: { videoSharingEnabled: false } });
  assert.equal((await app.request('GET', '/settings')).body.partners.find(row => row.id === AGENT).settings.videoSharingEnabled, false);
  await app.request('PUT', '/settings/video-sharing', { json: { maxPerDay: 2, partnerIds: [AGENT] } });
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, true);
  assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 2);
});

test('集中保存拒绝非法名单及不完整数据，不部分更新；范围外选择保留', async (t) => {
  const app = await boot(t, store => {
    store.setGlobalSettings({ videoShareMaxPerDay: 2 });
    store.setPartnerSettings(AGENT, { videoSharingEnabled: true });
    store.setPartnerSettings('unavailable', { videoSharingEnabled: true });
  });
  for (const body of [
    { maxPerDay: 6, partnerIds: [] }, { maxPerDay: 1, partnerIds: ['missing'] },
    { maxPerDay: 1, partnerIds: ['__proto__'] }, { maxPerDay: 1, partnerIds: [42] },
    { maxPerDay: 1 }, { partnerIds: [] }, { maxPerDay: 1, partnerIds: [], model: {} },
  ]) {
    assert.equal((await app.request('PUT', '/settings/video-sharing', { json: body })).status, 400);
    assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 2);
    assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, true);
  }
  assert.equal((await app.request('PUT', '/settings/video-sharing', { json: { maxPerDay: 3, partnerIds: [] } })).status, 200);
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, false);
  assert.equal(disk(app).getPartnerSettings('unavailable').videoSharingEnabled, true);
  await app.request('PUT', `/settings/partner/${AGENT}`, { json: { videoSharingEnabled: true } });
  await app.request('POST', `/settings/partner/${AGENT}/hide`, { json: {} });
  assert.equal((await app.request('PUT', '/settings/video-sharing', { json: { maxPerDay: 0, partnerIds: [AGENT] } })).status, 400);
  assert.equal((await app.request('PUT', '/settings/video-sharing', { json: { maxPerDay: 0, partnerIds: [] } })).status, 200);
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, true);
});

test("视频设置默认关闭、六档合法回显、拒绝非法值", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t, () => {});
  assert.equal((await app.request("GET", "/settings")).body.global.videoShareMaxPerDay, 0);
  for (const value of [0, 1, 2, 3, 4, 5]) {
    const response = await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: value } });
    assert.equal(response.status, 200);
    assert.equal(response.body.global.videoShareMaxPerDay, value);
  }
  for (const value of [-1, 6, 1.5, "2", null]) assert.equal((await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: value } })).status, 400);
});

for (const loggedIn of [false, true]) {
  test(`真实探索接线：${loggedIn ? "已登录只搜索B站并保存字幕候选" : "未登录不请求B站"}`, { skip: SKIP_DEV }, async (t) => {
    const app = await boot(t, (store) => {
      seed(store);
      store.saveVideoBook(AGENT, { pending: [], shares: [] });
      store.saveKnowing(AGENT, { ...store.getKnowing(AGENT), hobbies: [{ id: "craft", name: "石膏手作", layer: "motif", object: "半岛铁盒", preference: "喜欢自己浇模具", offers: true }] });
      store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() + 3600000).toISOString(),
        interestLearning: { curiosity: { startedAt: new Date(Date.now() - 40 * 3600000).toISOString(), thresholdMs: 18 * 3600000 } } });
    });
    const calls = [];
    app.ctx.network.fetch = async (url, options) => {
      const u = new URL(url);
      calls.push({ url: u, options });
      let json = null;
      if (u.pathname.endsWith("/nav")) json = { code: 0, data: { isLogin: true, wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } };
      else if (u.pathname.includes("/search/type")) json = { code: 0, data: { result: [{ bvid: "BV1bXt9z9ESP", title: "半岛铁盒石膏手作", author: "手作频道" }] } };
      else if (u.pathname.endsWith("/view")) json = { code: 0, data: { bvid: "BV1bXt9z9ESP", aid: 123, cid: 456, duration: 100, title: "半岛铁盒石膏手作", desc: "半岛铁盒石膏浇筑", owner: { name: "手作频道" }, pages: [{ page: 1, cid: 456, duration: 100 }] } };
      else if (u.pathname.includes("/player/")) json = { code: 0, data: { aid: 123, cid: 456, subtitle: { subtitles: [{ id: 1, lan: "zh-CN", subtitle_url: "https://aisubtitle.hdslb.com/subtitle/test.json" }] } } };
      else if (u.hostname === "aisubtitle.hdslb.com") json = { body: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "半岛铁盒用石膏浇筑，泡沫板做模具。" })) };
      assert.ok(json, `不该请求这条地址：${u.pathname}`);
      return { ok: true, status: 200, url: u.href, json: async () => json };
    };
    app.ctx.models.utility = async () => ({ requestId: "explore-test", text: '{"focus":"半岛铁盒石膏模具","searchQuery":"半岛铁盒 石膏 手作"}' });
    app.ctx.models.stream = async () => ({ text: async () => JSON.stringify({ type: "text-delta", delta: "[不回]" }) + "\n" });
    if (loggedIn) assert.equal((await app.request("POST", "/video/login", { json: { sessdata: "test-login-session", persist: false } })).status, 200);
    calls.length = 0;
    await app.request("POST", "/proactive/tick", { json: {} });
    if (!loggedIn) assert.equal(calls.length, 0);
    else {
      assert.equal(disk(app).getVideoBook(AGENT).pending.length, 1);
      assert.ok(calls.some((row) => row.url.pathname.includes("/search/type")));
      assert.ok(calls.every((row) => ["api.bilibili.com", "aisubtitle.hdslb.com"].includes(row.url.hostname)));
      assert.ok(calls.filter((row) => row.url.hostname !== "api.bilibili.com").every((row) => !row.options.headers.Cookie));
      assert.ok(!JSON.stringify(disk(app).readMemory(AGENT)).includes("test-login-session"));
    }
  });
}

test("探索计划等待期间线程变化，搜索前门禁挡住B站请求", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t, (store) => {
    seed(store);
    store.saveVideoBook(AGENT, { pending: [], shares: [] });
    store.saveKnowing(AGENT, { ...store.getKnowing(AGENT), hobbies: [{ id: "craft", name: "石膏手作", layer: "motif", object: "半岛铁盒", preference: "喜欢自己浇模具", offers: true }] });
    store.setProactiveState(AGENT, { nextDueAt: new Date(Date.now() + 3600000).toISOString(),
      interestLearning: { curiosity: { startedAt: new Date(Date.now() - 40 * 3600000).toISOString(), thresholdMs: 18 * 3600000 } } });
  });
  const calls = [];
  app.ctx.network.fetch = async (raw) => {
    const url = new URL(raw);
    calls.push(url);
    if (url.pathname.endsWith("/nav")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true } }) };
    if (url.pathname.includes("/search/type")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { result: [] } }) };
    assert.fail(`不该请求这条地址：${url.pathname}`);
  };
  assert.equal((await app.request("POST", "/video/login", { json: { sessdata: "test-login-session", persist: false } })).status, 200);
  calls.length = 0;

  let resolveEntered;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  let releasePlan;
  const planWait = new Promise((resolve) => { releasePlan = resolve; });
  app.ctx.models.utility = async () => { resolveEntered(); return planWait; };
  const tick = app.request("POST", "/proactive/tick", { json: {} });
  await entered;
  app.store.appendMessage(AGENT, { role: "user", text: "计划还在等时，我已经换了话题。", at: now() });
  releasePlan({ requestId: "explore-race", text: JSON.stringify({ focus: "半岛铁盒石膏模具", searchQuery: "半岛铁盒 石膏 手作" }) });
  await tick;

  assert.equal(calls.filter((url) => url.pathname.includes("/search/type")).length, 0);
  assert.equal(disk(app).getVideoBook(AGENT).pending.length, 0);
});

test("伙伴级浏览开关保留明确选择、严格布尔、持久化且不影响全局和其他伙伴", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, true);
  assert.equal((await app.request("PUT", `/settings/partner/${AGENT}`, { json: { videoSharingEnabled: "false" } })).status, 400);
  assert.equal((await app.request("PUT", `/settings/partner/${AGENT}`, { json: { videoSharingEnabled: false } })).status, 200);
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, false);
  assert.equal(disk(app).getPartnerSettings("orion").videoSharingEnabled, false);
  assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 1);
  for (const limit of [0, 2]) await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: limit } });
  assert.equal(disk(app).getPartnerSettings(AGENT).videoSharingEnabled, false);
  app.ctx.models.stream = async () => ({ text: async () => JSON.stringify({ type: "text-delta", delta: "[不回]" }) + "\n" });
  await app.request("POST", "/proactive/tick", { json: {} });
  assert.equal(reopenThread(app.dataDir, AGENT).filter((row) => row.videoId).length, 0);
  assert.equal(disk(app).getVideoBook(AGENT).pending.length, 1);
});

test("本次运行登录验证后只留内存，不写磁盘或设置回包", async (t) => {
  const app = await boot(t, () => {});
  const secret = "test-private-session-token";
  app.ctx.network.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { isLogin: true } }) });
  assert.equal((await app.request("GET", "/video/status")).body.hasLogin, false);
  const result = await app.request("POST", "/video/login", { json: { sessdata: secret, persist: false } });
  assert.equal(result.body.storage, "memory");
  assert.equal((await app.request("GET", "/video/status")).body.hasLogin, true);
  assert.ok(!JSON.stringify((await app.request("GET", "/settings")).body).includes(secret));
  const files = fs.readdirSync(app.dataDir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
  for (const f of files) assert.ok(!fs.readFileSync(`${f.parentPath ?? f.path}/${f.name}`, "utf8").includes(secret));
  assert.equal((await app.request("POST", "/video/login", { json: { sessdata: "abc;other=xyz", persist: false } })).status, 400);
  assert.equal((await app.request("POST", "/video/login", { json: { sessdata: secret, persist: true } })).status, 400);
});

test("主接线读取DPAPI保护凭据并nav验证，拒绝明文旧文件", async (t) => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("const videoLoginManager = createVideoLogin({");
  const end = source.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start, "找到主登录管理器接线");
  const wiring = source.slice(start, end);
  assert.match(wiring, /loadCredential:\s*\(\)\s*=>\s*readVideoCredential\(ctx\.dataDir\)/u);
  assert.match(wiring, /writeVideoCredential\(ctx\.dataDir/u);
  assert.match(wiring, /clearVideoCredential\(ctx\.dataDir\)/u);

  const app = await boot(t, () => {});
  const secret = "test-dpapi-session-token";
  const written = await writeVideoCredential(app.dataDir, { sessdata: secret });
  assert.equal(written.ok, true);
  const credentialFile = path.join(app.dataDir, "v2", "video-credential.json");
  const raw = fs.readFileSync(credentialFile, "utf8");
  assert.equal(raw.includes(secret), false, "凭据文件只含系统加密内容");
  let requests = 0;
  const sentCookies = [];
  app.ctx.network.fetch = async (url, options) => {
    requests += 1;
    if (url.includes("/x/web-interface/nav")) sentCookies.push(options.headers.Cookie);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true } }) };
  };
  const status = await app.request("GET", "/video/status");
  assert.deepEqual(status.body, { ok: true, status: "loggedIn", hasLogin: true, storage: "encrypted" });
  assert.equal(requests, 1);
  assert.deepEqual(sentCookies, [`SESSDATA=${secret}`], "只在nav验证时发送SESSDATA");
  assert.equal(JSON.stringify((await app.request("GET", "/settings")).body).includes(secret), false);

  fs.writeFileSync(credentialFile, JSON.stringify({ sessdata: "LEGACY_PLAINTEXT_TEST_MARKER", encrypted: true }), "utf8");
  const rejected = await readVideoCredential(app.dataDir);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.cookie, undefined);
  assert.equal(JSON.stringify(rejected).includes("LEGACY_PLAINTEXT_TEST_MARKER"), false);
});

test("实际主动链选择视频、伙伴模型发出链接、成功后才落条目和两层额度", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  const response = await sendVideo(app, `这个半岛铁盒的石膏模具我想试一哈。${LINK}`);
  assert.equal(response.status, 200);
  const sent = reopenThread(app.dataDir, AGENT).findLast((m) => m.videoId);
  assert.ok(sent, JSON.stringify(response.body));
  assert.ok(sent.text.includes(LINK));
  const store = disk(app);
  assert.equal(store.getVideoBook(AGENT).pending.length, 0);
  assert.equal(store.getVideoBook(AGENT).shares.length, 1);
  assert.equal(store.getVideoBook(AGENT).shares[0].messageId, sent.id);
  assert.equal(store.getGlobalRuntime().videoShares.count, 1);
  assert.ok(store.getGlobalRuntime().sentToday, "沿用全局主动账本而非另开免费消息");
  const request = app.models.calls[0].request;
  assert.equal(request.provider, "test-provider");
  assert.equal(request.model, "test-model");
  const prompt = JSON.stringify(request);
  assert.match(prompt, /半岛铁盒/);
  assert.match(prompt, /不回/);
  assert.doesNotMatch(prompt, /没有可用的种子或新发现/);
  assert.equal(app.net.calls.length, 0);
});

test("伙伴不想分享时不发消息、不扣额度，保留候选并冷却", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  await sendVideo(app, "[不回]");
  assert.equal(reopenThread(app.dataDir, AGENT).filter((m) => m.videoId).length, 0);
  const store = disk(app);
  assert.equal(store.getGlobalRuntime().videoShares?.count ?? 0, 0);
  assert.equal(store.getVideoBook(AGENT).pending.length, 1);
  assert.ok(store.getVideoBook(AGENT).pending[0].offeredAt);
});

test("分享生成期间关闭功能时旧稿不送出、不扣额度", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  await sendVideo(app, `这份半岛铁盒的教程我看着有意思。${LINK}`, async () => {
    await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: 0 } });
  });
  assert.equal(reopenThread(app.dataDir, AGENT).filter((m) => m.videoId).length, 0);
  assert.equal(disk(app).getGlobalRuntime().videoShares?.count ?? 0, 0);
  assert.equal(disk(app).getVideoBook(AGENT).pending[0].offeredAt, null, "门禁作废不白白冷却六小时");
});

for (const change of ["global-off", "partner-off", "video-partner-off", "total-limit"])  {
  test(`生成期间门禁变化也挡住旧稿：${change}`, { skip: SKIP_DEV }, async (t) => {
    const app = await boot(t, (store) => {
      seed(store);
      if (change === "total-limit") store.setGlobalRuntime({ sentToday: { day: dayKey(new Date()), count: 12 } });
    });
    await sendVideo(app, `半岛铁盒的模具这一步我想照着试试。${LINK}`, async () => {
      if (change === "global-off") await app.request("PUT", "/settings/global", { json: { rhythmProactiveEnabled: false } });
      if (change === "partner-off") await app.request("PUT", `/settings/partner/${AGENT}`, { json: { proactiveEnabled: false } });
      if (change === "video-partner-off") await app.request("PUT", `/settings/partner/${AGENT}`, { json: { videoSharingEnabled: false } });
      if (change === "total-limit") await app.request("PUT", "/settings/global", { json: { globalGate: { minGapMinutes: 1, maxPerDay: 12 } } });
    });
    assert.equal(reopenThread(app.dataDir, AGENT).filter((m) => m.videoId).length, 0);
    assert.equal(disk(app).getGlobalRuntime().videoShares?.count ?? 0, 0);
  });
}

test("模型没写链接也由系统补上分享文案，仍算分享成功", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  await sendVideo(app, "这个半岛铁盒做得真有意思。");
  const shared = reopenThread(app.dataDir, AGENT).filter((m) => m.videoId);
  assert.equal(shared.length, 1, "链接由系统附，不该再拿“模型没写链接”当失败");
  const text = String(shared[0].text ?? "");
  assert.match(text, /【[^\n]+-哔哩哔哩】 /u, "最后一条应是 B 站分享文案");
  assert.ok(text.includes(LINK), "分P视频用长链接，别丢了 p=2");
  assert.equal(disk(app).getVideoBook(AGENT).shares.length, 1);
});

test("分享条目经过Store重开和普通记忆写入仍保存，删来源后失效", async (t) => {
  const app = await boot(t, (store) => {
    const c = candidate();
    const message = store.appendMessage(AGENT, { role: "assistant", text: `半岛铁盒 ${LINK}` });
    store.saveVideoBook(AGENT, recordVideoShare(store.getVideoBook(AGENT), c, message));
    store.setProfile(AGENT, "平时喜欢手作");
  });
  let store = disk(app);
  const row = store.getVideoBook(AGENT).shares[0];
  assert.ok(row);
  store.removeFactsBySource(AGENT, row.messageId);
  assert.equal(disk(app).getVideoBook(AGENT).shares.length, 0);
});

async function waitReply(app, turnId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await app.request("GET", `/turns/${turnId}`);
    if (response.body.status === "ready" && response.body.replyMessageId) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("模拟回复未按时完成");
}

test("实际普通回复召回视频、复用记忆反馈存认知、用户具体再提续期，删反馈来源失效", async (t) => {
  const app = await boot(t, (store) => {
    seed(store);
    const message = store.appendMessage(AGENT, { role: "assistant", text: `半岛铁盒的模具 ${LINK}`, proactive: true });
    store.saveVideoBook(AGENT, recordVideoShare(store.getVideoBook(AGENT), candidate(), message));
  });
  const original = app.store.getVideoBook(AGENT).shares[0];
  const quote = "半岛铁盒这个模具用的是石膏吧";
  const turn = await app.request("POST", "/turns", { json: { agentId: AGENT, text: quote, watching: true } });
  await app.models.waitForCall(0);
  const prompt = JSON.stringify(app.models.calls[0].request);
  assert.match(prompt, /视频分享记忆/);
  assert.match(prompt, /泡沫板/);
  assert.match(prompt, /memory-update/);
  app.models.release(0, "嗯，字幕里说用石膏浇筑。" + `<memory-update>${JSON.stringify({ updates: [{
    id: original.cognition.id, decision: "revise", text: "半岛铁盒的模具用石膏浇筑，泡沫板做外框。", note: "这段制作我还想试试", sourceId: turn.body.messageId, quote,
  }] })}</memory-update>`);
  const done = await waitReply(app, turn.body.turnId);
  const saved = disk(app).getVideoBook(AGENT).shares[0];
  assert.match(saved.cognition.text, /石膏浇筑/);
  assert.equal(saved.renewals.length, 1);
  assert.equal(saved.renewals[0].kind, "user");
  assert.ok(!reopenThread(app.dataDir, AGENT).find((m) => m.id === done.replyMessageId).text.includes("memory-update"));
  assert.equal(app.models.calls.length, 1);
  disk(app).removeFactsBySource(AGENT, turn.body.messageId);
  assert.equal(disk(app).getVideoBook(AGENT).shares.length, 0);
});

test("设置扫码路由端到端模拟：本地二维码、确认后验证登录、回包无凭据", async (t) => {
  const app = await boot(t, () => {});
  const calls = [];
  app.ctx.network.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return { ok: true, status: 200, json: async () => {
      if (url.includes('/generate')) return { code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=route-test-key', qrcode_key: 'route-test-key' } };
      if (url.includes('/poll')) return { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/login?SESSDATA=route-private-session' } };
      return { code: 0, data: { isLogin: true } };
    } };
  };
  const started = await app.request('POST', '/video/qrcode/start', { json: {} });
  assert.equal(started.status, 200);
  assert.match(started.body.svg, /^<svg/);
  const polled = await app.request('POST', '/video/qrcode/poll', { json: { id: started.body.id } });
  assert.equal(polled.body.status, 'loggedIn');
  assert.equal(polled.body.storage, 'encrypted');
  const status = await app.request('GET', '/video/status');
  assert.equal(status.body.hasLogin, true);
  assert.equal(status.body.status, 'loggedIn');
  assert.equal(status.body.storage, 'encrypted');
  const credentialFile = path.join(app.dataDir, 'v2', 'video-credential.json');
  assert.equal(fs.readFileSync(credentialFile, 'utf8').includes('route-private-session'), false);
  assert.equal((await readVideoCredential(app.dataDir)).cookie, 'SESSDATA=route-private-session');
  assert.deepEqual(calls.filter((call) => call.url.includes('/x/web-interface/nav')).map((call) => call.headers.Cookie), ['SESSDATA=route-private-session']);
  assert.doesNotMatch(JSON.stringify([started.body, polled.body, status.body]), /route-test-key|route-private-session|SESSDATA|qrcode_key|ticket/);
  assert.doesNotMatch(JSON.stringify(disk(app).getGlobalSettings()), /route-private-session/);

  let restoredCookie = '';
  const reloaded = createVideoLogin({
    loadCredential: () => readVideoCredential(app.dataDir),
    fetcher: async (_url, options) => {
      restoredCookie = options.headers.Cookie ?? '';
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { isLogin: true } }) };
    },
  });
  assert.deepEqual(await reloaded.status(), { status: 'loggedIn', hasLogin: true, storage: 'encrypted' });
  assert.equal(restoredCookie, 'SESSDATA=route-private-session', '新管理器可从DPAPI文件恢复并重新验证');
});

test("扫码路由失败只给受控原因，不回显网络异常或伪报登录", async (t) => {
  const app = await boot(t, () => {});
  app.ctx.network.fetch = async () => { throw new Error('secret-url-and-cookie'); };
  const result = await app.request('POST', '/video/qrcode/start', { json: {} });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(typeof result.body.error.message, 'string');
  assert.doesNotMatch(JSON.stringify(result.body), /secret-url-and-cookie/);
  assert.equal((await app.request('GET', '/video/status')).body.hasLogin, false);
});

test("失效提醒全局每日去重、明确拒绝六小时退避，网络未知和未登录不催", async () => {
  const { videoLoginNoticeDue } = await import("../index.js");
  const at = new Date("2026-10-16T04:00:00.000Z");
  const expired = { status: "expired", episodeId: "episode-a" };
  assert.equal(videoLoginNoticeDue(expired, null, at), true);
  assert.equal(videoLoginNoticeDue(expired, { episodeId: "episode-a", day: dayKey(at), sentAt: at.toISOString() }, at), false);
  assert.equal(videoLoginNoticeDue(expired, { episodeId: "episode-a", offeredAt: at.toISOString() }, new Date(+at + 5 * 3600000)), false);
  assert.equal(videoLoginNoticeDue(expired, { episodeId: "episode-a", offeredAt: at.toISOString() }, new Date(+at + 7 * 3600000)), true);
  assert.equal(videoLoginNoticeDue({ ...expired, episodeId: "episode-b" }, { episodeId: "episode-a", day: dayKey(at), sentAt: at.toISOString() }, at), true);
  for (const status of ["none", "unknown", "loggedIn"]) assert.equal(videoLoginNoticeDue({ status }, null, at), false);
});

async function setExpiredLogin(app) {
  let loggedIn = true;
  app.ctx.network.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: loggedIn ? 0 : -101, data: { isLogin: loggedIn } }) });
  assert.equal((await app.request("POST", "/video/login", { json: { sessdata: "test-private-login-token", persist: false } })).status, 200);
  loggedIn = false;
  const status = await app.request("GET", "/video/status?refresh=1");
  assert.equal(status.body.status, "expired");
  return status.body;
}

test("提醒人格等待期间线程变化，旧提醒不落库也不记主动额", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  app.store.saveVideoBook(AGENT, { pending: [], shares: [] });
  await setExpiredLogin(app);
  let resolvePersonaEntered;
  const personaEntered = new Promise((resolve) => { resolvePersonaEntered = resolve; });
  let releasePersona;
  const personaWait = new Promise((resolve) => { releasePersona = resolve; });
  let held = false;
  app.ctx.resources.read = async ({ path: target }) => {
    const normalized = String(target ?? "").replaceAll("\\", "/").toLowerCase();
    if (!held && normalized.includes(`/agents/${AGENT}/`)) {
      held = true;
      resolvePersonaEntered(normalized);
      return personaWait;
    }
    return null;
  };

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const tick = app.request("POST", "/proactive/tick", { json: {} });
    const personaPath = await personaEntered;
    assert.match(personaPath, new RegExp(`/agents/${AGENT}/`));
    app.store.appendMessage(AGENT, { role: "user", text: "人格读取期间我已经换了话题。", at: now() });
    releasePersona({ content: null });
    await app.models.waitForCall(0);
    app.models.release(0, "B站登录掉了，再去设置扫码就可以。");
    const tickResult = await tick;

    assert.ok(tickResult.body.result.report.some((row) => row.reason === "video-stale"), "提醒线程戳过期后应在出口作废");
    assert.equal(reopenThread(app.dataDir, AGENT).filter((row) => row.videoLoginNotice).length, 0);
    assert.equal(disk(app).getGlobalRuntime().sentToday?.count ?? 0, 0);
  } finally {
    Math.random = originalRandom;
  }
});

test("登录过期走当前伙伴模型的主动提醒、不混视频、不扣视频额但计主动额", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  await setExpiredLogin(app);
  await sendVideo(app, "我这边B站登录掉了，想继续逛得去茶话会设置扫个码。" );
  const sent = reopenThread(app.dataDir, AGENT).findLast((row) => row.videoLoginNotice);
  assert.ok(sent);
  assert.equal(sent.videoId, undefined);
  assert.equal(disk(app).getGlobalRuntime().videoShares?.count ?? 0, 0);
  assert.equal(disk(app).getGlobalRuntime().sentToday.count, 1);
  assert.equal(disk(app).getGlobalRuntime().videoLoginNotice.messageId, sent.id);
  assert.equal(disk(app).getVideoBook(AGENT).pending.length, 1);
  const prompt = JSON.stringify(app.models.calls[0].request);
  assert.match(prompt, /登录已经确认失效/);
  assert.doesNotMatch(prompt, /你已经读过字幕|没有可用的种子或新发现/);
  assert.equal(app.models.calls[0].request.model, "test-model");
});

test("提醒生成期间重新登录时旧的过期提醒不发", { skip: SKIP_DEV }, async (t) => {
  const app = await boot(t);
  await setExpiredLogin(app);
  await sendVideo(app, "B站登录掉了，再去设置扫码哈。", async () => {
    app.ctx.network.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true } }) });
    assert.equal((await app.request("POST", "/video/login", { json: { sessdata: "test-new-login-token", persist: false } })).status, 200);
  });
  assert.equal(reopenThread(app.dataDir, AGENT).filter((row) => row.videoLoginNotice).length, 0);
  assert.equal(disk(app).getGlobalRuntime().videoLoginNotice, undefined);
});

test("明说以后别分享视频会关闭全局上限，普通不喜欢某类不误关", async (t) => {
  const app = await boot(t);
  const first = app.request("POST", "/turns", { json: { agentId: AGENT, text: "以后别给我发视频了", watching: true } });
  const stopped = await first;
  assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 0);
  assert.equal(disk(app).getGlobalRuntime().videoStop.messageId, stopped.body.messageId);
  assert.equal(disk(app).getGlobalRuntime().videoStop.reason, "explicit-user-stop");
  await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: 2 } });
  await app.request("POST", "/turns", { json: { agentId: AGENT, text: "这种视频我不喜欢", watching: true } });
  assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 2);
  await app.request("POST", "/turns", { json: { agentId: AGENT, text: "烦死了，以后别给我发视频了", watching: true } });
  assert.equal(disk(app).getGlobalSettings().videoShareMaxPerDay, 0);
});
