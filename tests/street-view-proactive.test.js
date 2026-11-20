import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui, reopenThread } from "./helpers/app-harness.js";

const HAS_DEV_ROUTE = /const DEV_TOOLS = true;/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
const OPTIONS = { skip: HAS_DEV_ROUTE ? false : "正式包不含手动主动巡检路由" };
const AGENT = "nova", HOUR = 3600_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
const PHOTO = '[生图:{"prompt":"我站在巷口回头拍了一张","self":true}]';
const time = ms => new Date(Date.now() + ms).toISOString();

/** Commons + 地理编码的假出口：只答我们真会问的那几种请求。 */
function fakeCommons() {
  const calls = [];
  const places = ["Category:Wide and Narrow Alleys", "Category:Streets in Chengdu", "Category:Chunxi Road",
    "Category:1991 in Chengdu", "Category:Street scenes in Chengdu", "Category:Maps of Chengdu", "Category:Views of Chengdu"];
  const title = "File:Street scene - Kuanzhai Alleys - Chengdu, China - DSC05311.jpg";
  const categories = {
    [title]: ["Category:CC-Zero", "Category:Wide and Narrow Alleys"],
    "Category:Wide and Narrow Alleys": ["Category:Streets in Chengdu"],
  };
  async function fetchImpl(url) {
    const raw = String(url);
    calls.push(raw);
    if (raw.includes("open-meteo.com")) {
      return { ok: true, status: 200, url: raw, json: async () => ({ results: [{ name: "成都", latitude: 30.67, longitude: 104.07, country: "中国" }] }) };
    }
    if (raw.startsWith("https://thumb.wikimedia.org")) {
      const bytes = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
      return { ok: true, status: 200, url: raw, arrayBuffer: async () => bytes };
    }
    const params = new URL(raw).searchParams;
    if (params.get("prop") === "categories" && !params.get("generator")) {
      const titles = String(params.get("titles") ?? "").split("|").filter(Boolean);
      return { ok: true, status: 200, url: raw, json: async () => ({ query: { pages: titles.map(name => ({ title: name, categories: (categories[name] ?? []).map(row => ({ title: row })) })) } }) };
    }
    if (params.get("generator") === "geosearch" && params.get("ggsnamespace") === "14") {
      return { ok: true, status: 200, url: raw, json: async () => ({ query: { pages: places.map(title => ({ title })) } }) };
    }
    if (params.get("generator") === "search" || params.get("generator") === "categorymembers" || params.get("generator") === "geosearch") {
      return {
        ok: true, status: 200, url: raw,
        json: async () => ({
          query: {
            pages: [{
              title,
              pageid: 1,
              imageinfo: [{
                url: "https://upload.wikimedia.org/wikipedia/commons/8/8a/Street_scene.jpg",
                thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Street_scene.jpg/1024px-Street_scene.jpg",
                descriptionurl: "https://commons.wikimedia.org/wiki/File:Street_scene.jpg",
                mime: "image/jpeg", width: 1024, height: 640, thumbwidth: 1024, thumbheight: 640,
                extmetadata: {
                  License: { value: "cc0" },
                  LicenseShortName: { value: "CC0" },
                  UsageTerms: { value: "Creative Commons Zero, Public Domain Dedication" },
                  LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" },
                  Artist: { value: "Daderot" },
                },
              }],
            }],
          },
        }),
      };
    }
    if (params.get("list") === "search") return { ok: true, status: 200, url: raw, json: async () => ({ query: { search: [] } }) };
    throw new Error(`未预期的请求：${raw}`);
  }
  return { fetchImpl, calls };
}

async function boot(t, { answer = PHOTO, city = "成都", consent = true, discoveries = false, cityIllustrations = false, cityFixture = false } = {}) {
  const mediaCalls = [], prompts = [], net = fakeCommons();
  const app = await bootChahuahui({ seed(store, ctx) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({
      rhythmProactiveEnabled: true, imageTier: "less", quiet: { start: clock(far.getHours()), end: clock(far.getHours() + 1) },
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      lifeCity: city, lifeCityCode: "city-test-code", lifeCityStreetView: consent,
      lifeCityDiscoveries: discoveries, lifeCityIllustrations: cityIllustrations,
      // 测试里要连续跑两轮主动（第一轮备素材，第二轮才发照片），所以把间隔放开。
      globalGate: { minGapMinutes: 0, maxPerDay: 24 },
    });
    store.setPartnerSettings(AGENT, {
      proactiveEnabled: true, tier: "often", imageTier: "normal", model: { provider: "test-provider", model: "test-model" },
      hobbySeedTryAt: time(0), sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } }, voice: { enabled: false },
    });
    const knowing = store.getKnowing(AGENT);
    store.saveKnowing(AGENT, { ...knowing, personality: { surface: { tags: ["俏皮"], signals: [] }, inner: { tags: [], signals: [] } }, relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 120, activeDays: 50 }, intimacy: { ...knowing.relationship.intimacy, score: 18 } }, worldInterests: [{ id: "wi_craft", name: "手作", domains: ["手作"], sources: ["B站"], createdAt: time(0), updatedAt: time(0) }] });
    const sourceAt = new Date();
    const illustrationFixture = cityFixture ? [{ id: "local_fixture", domainId: "local-city", domainName: "同城发现", localCity: city,
      localCityCode: "city-test-code", title: `${city}街区的巷道与院落`,
      snippet: `${city}街区导览介绍了窄巷和青砖院落的布局。`,
      url: "https://example.org/chengdu/lanes", publishedAt: sourceAt.toISOString(),
      createdAt: sourceAt.toISOString(), expiresAt: new Date(sourceAt.getTime() + 24 * HOUR).toISOString(), sharedAt: sourceAt.toISOString() }] : [];
    store.setProactiveState(AGENT, { nextDueAt: time(-HOUR), lastSentAt: time(-HOUR), interestLearning: { curiosity: { startedAt: time(0), thresholdMs: 7 * 24 * HOUR } }, topicSeeds: { lastGrowAt: time(0), seeds: [] }, localNewsFetchAt: cityFixture ? time(48 * HOUR) : null, newsBook: cityFixture ? { lastFetchAt: time(48 * HOUR), items: illustrationFixture, history: [] } : discoveries ? { items: [], history: [] } : { lastFetchAt: time(0), lastDomainId: "", items: [], history: [] } });
    store.appendMessage(AGENT, { role: "user", text: "今天想喝热咖啡", at: time(-2 * HOUR) });
    store.appendMessage(AGENT, { role: "assistant", text: "我一会儿也去冲一杯", at: time(-2 * HOUR + 1000) });
    ctx.network.fetch = net.fetchImpl;
    const request = ctx.bus.request;
    ctx.bus.request = async (type, payload, ...rest) => {
      if (type === "media:generate-image") { mediaCalls.push(payload); return { tasks: [{ taskId: "photo_fixture" }] }; }
      return request(type, payload, ...rest);
    };
    ctx.media = { getTask: async () => ({ status: "completed" }), getTaskResources: async () => ({ resources: [{ resource: { kind: "resource", resourceId: "photo_fixture" } }] }) };
    ctx.resources.read = async () => ({ content: PNG.toString("base64") });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  let current = answer;
  const rule = app.models.answer(req => { prompts.push(req); return true; }, current);
  app.ctx.models.utility = async req => {
    prompts.push(req);
    return { text: String(req.systemPrompt || "").includes("检查一条准备发出的普通私聊主动消息") ? '{"decision":"send"}' : current };
  };
  /** 换这一轮模型要说的话（模型桩的规则是按顺序匹配的，改规则本身才换得掉）。 */
  const setAnswer = (text) => { current = text; rule.text = text; };
  const tick = async (randomValue = 0.99) => {
    const random = Math.random;
    Math.random = () => randomValue;
    try { return await app.request("POST", "/proactive/tick", { json: {} }); }
    finally { Math.random = random; }
  };
  return { ...app, mediaCalls, prompts, tick, net, setAnswer, photos: () => reopenThread(app.dataDir, AGENT).filter(row => row.proactive && row.attachment) };
}

async function waitForStreetFile(dataDir, timeoutMs = 4000) {
  const dir = path.join(dataDir, "v2", "street-view");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const names = fs.readdirSync(dir); if (names.length) return names[0]; } catch { /* 还没建目录 */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

test("城市插画复用当前同城来源：提示清楚标为插画、仅传角色参考照并保留出处", OPTIONS, async t => {
  const app = await boot(t, { consent: false, discoveries: true, cityIllustrations: true, cityFixture: true });
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
  let searches = 0;
  app.ctx.network.fetch = async url => {
    if (String(url).startsWith("https://www.bing.com/search")) searches++;
    return { ok: false, status: 429, text: async () => "" };
  };
  app.setAnswer(PHOTO);
  await app.tick(0.1);
  const [message] = app.photos();
  assert.ok(message, "应保留原有主动照片候选");
  assert.equal(message.photoScene.source, "city-illustration", fs.readFileSync(path.join(app.dataDir, "v2", "diagnostics.jsonl"), "utf8"));
  assert.equal(message.cityIllustration.label, "城市插画");
  assert.equal(message.cityIllustration.city, "成都");
  assert.equal(message.cityIllustration.url, "https://example.org/chengdu/lanes");
  assert.equal(message.streetView, undefined, "城市插画不得冒充真实街景");
  assert.equal(app.mediaCalls.length, 1);
  const refs = app.mediaCalls[0].input.referenceImages;
  assert.equal(refs.length, 1, JSON.stringify(app.mediaCalls[0].input));
  assert.ok(refs[0].path.includes("image-references"), "只传角色参考照，不传城市素材图");
  assert.match(app.mediaCalls[0].input.prompt, /【城市插画】/u);
  assert.match(app.mediaCalls[0].input.prompt, /不代表你到过/u);
  assert.match(app.mediaCalls[0].input.prompt, /https:\/\/example\.org\/chengdu\/lanes/u);
  assert.ok(app.prompts.some(req => req.systemPrompt.includes("【城市插画】")));
  const meta = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${message.attachment.id}.json`), "utf8"));
  assert.equal(meta.source.kind, "city-illustration");
  assert.equal(meta.source.url, message.cityIllustration.url);
  assert.equal(searches, 0, "插画不触发额外搜索，只复用现有同城发现缓存");
});

test("城市插画关闭时仍走普通主动照片，不复用城市来源", OPTIONS, async t => {
  const app = await boot(t, { consent: false, discoveries: true, cityIllustrations: false, cityFixture: true });
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
  app.setAnswer(PHOTO);
  await app.tick(0.1);
  const [message] = app.photos();
  assert.ok(message);
  assert.equal(message.photoScene.source, "scene");
  assert.equal(message.cityIllustration, undefined);
  assert.equal(app.mediaCalls[0].input.referenceImages.length, 1);
});

test("仅打开城市插画但未授权同城发现时，不触发搜索或选用城市素材", OPTIONS, async t => {
  const app = await boot(t, { consent: false, discoveries: false, cityIllustrations: true });
  let searches = 0;
  app.ctx.network.fetch = async url => {
    if (String(url).startsWith("https://www.bing.com/search")) searches++;
    return { ok: false, status: 429, text: async () => "" };
  };
  await app.tick(0.99);
  assert.equal(searches, 0);
  assert.equal(app.store.getGlobalSettings().lifeCityIllustrations, true);
  assert.equal(app.store.getGlobalSettings().lifeCityDiscoveries, false);
});

test("真实街景自拍：人物在前、已核过的真实街景在后，来路留在消息与附件上", OPTIONS, async t => {
  const app = await boot(t);
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });

  // 第一轮：只让素材在后台备着（这一轮模型不说话，所以不发消息，也不占间隔）。
  app.setAnswer("[不回]");
  await app.tick(0.99);
  const file = await waitForStreetFile(app.dataDir);
  assert.ok(file, "后台应该把街景素材备好");

  // 第二轮：照片候选抽中，街景那一支也抽中。
  app.setAnswer(PHOTO);
  await app.tick(0.1);
  const photos = app.photos();
  assert.equal(photos.length, 1, JSON.stringify(photos.map(row => row.text)));
  const [message] = photos;
  assert.equal(message.proactiveExpression, "photo");
  assert.equal(message.photoScene.source, "street");
  assert.equal(message.photoScene.city, "成都");
  // 来路：城市、素材标题、许可、页面链接。
  assert.equal(message.streetView.city, "成都");
  assert.match(message.streetView.title, /^File:Street scene - Kuanzhai Alleys/);
  assert.equal(message.streetView.license, "CC0");
  assert.match(message.streetView.descriptionUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\//);
  // 附件自己的元数据里也有来路。
  const meta = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "attachments", `${message.attachment.id}.json`), "utf8"));
  assert.equal(meta.source.kind, "wikimedia-commons");
  assert.equal(meta.source.license, "CC0");
  // 参考路径：角色在前、真实街景在后。
  assert.equal(app.mediaCalls.length, 1);
  const refs = app.mediaCalls[0].input.referenceImages;
  assert.equal(refs.length, 2, JSON.stringify(app.mediaCalls[0].input));
  assert.ok(refs[0].path.includes("image-references"), "第一张是角色参考照");
  assert.ok(refs[1].path.includes("street-view"), "第二张是已核过的真实街景");
  assert.match(app.mediaCalls[0].input.prompt, /第一张参考图是唯一的人物外貌和画风参考/);
  assert.match(app.mediaCalls[0].input.prompt, /第二张参考图只管地点/);
  // 提示词走的是街景那一套。
  assert.ok(app.prompts.some(req => req.systemPrompt.includes("【真实街景自拍】")));
  // 冷却：刚发过，短时间内不再发第二张街景自拍。
  const state = JSON.parse(fs.readFileSync(path.join(app.dataDir, "v2", "state.json"), "utf8"));
  assert.ok(state.runtime.partners[AGENT].streetView?.usedAt, "发出去才记账");
});

test("没授权、没填城市时，一条街景素材都不去找", OPTIONS, async t => {
  const app = await boot(t, { consent: false });
  await app.tick(0.99);
  assert.equal(app.net.calls.filter(url => url.includes("commons.wikimedia.org")).length, 0, "没授权就不问素材服务");
  assert.equal(app.net.calls.filter(url => url.includes("open-meteo.com")).length, 0, "没填城市就不查经纬度");
});

test("填了城市但没授权：不去 Commons 要素材", OPTIONS, async t => {
  const app = await boot(t, { consent: false, city: "成都" });
  await app.tick(0.99);
  assert.equal(app.net.calls.filter(url => url.includes("commons.wikimedia.org")).length, 0);
});

test("生活城市从本地候选保存，错误代码不覆盖旧设置", OPTIONS, async t => {
  const app = await boot(t, { consent: false, city: "成都" });
  const choices = await app.request("GET", "/settings/life-cities");
  assert.equal(choices.status, 200);
  const pick = choices.body.items.find(row => row.city === "成都市");
  assert.ok(pick);
  assert.equal((await app.request("PUT", "/settings/global", { json: { lifeCityCode: "拼错的地名" } })).status, 400);
  assert.equal((await app.request("PUT", "/settings/global", { json: { lifeCityCode: pick.code, lifeCity: "错误地名" } })).status, 200);
  const saved = await app.request("GET", "/settings");
  assert.equal(saved.body.global.lifeCity, "成都市");
  assert.equal(saved.body.global.lifeCityCode, pick.code);
  assert.equal((await app.request("PUT", "/settings/global", { json: { lifeCityCode: null } })).status, 200);
  const cleared = await app.request("GET", "/settings");
  assert.equal(cleared.body.global.lifeCity, "");
});

test("关掉授权后旧素材作废：临时文件删掉，不再用旧城的街景", OPTIONS, async t => {
  const app = await boot(t);
  const uploaded = await app.request("POST", `/image/reference/${AGENT}`, { json: { image: { data: PNG.toString("base64") } } });
  await app.request("PUT", `/image/reference/${AGENT}`, { json: { referenceId: uploaded.body.reference.history[0].id } });
  await app.tick(0.99);
  const file = await waitForStreetFile(app.dataDir);
  assert.ok(file);
  const saved = await app.request("PUT", "/settings/global", { json: { lifeCityStreetView: false } });
  assert.equal(saved.status, 200);
  assert.equal(fs.existsSync(path.join(app.dataDir, "v2", "street-view", file)), false, "旧临时文件要删掉");
});
