import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMONS_API,
  ALLOWED_IMAGE_HOSTS,
  buildCommonsUrl,
  deriveCityTokens,
  isAllowedImageUrl,
  isStreetEvidence,
  isUsableCandidate,
  licenseVerdict,
  parseCandidatePage,
  tokenMatchesCity,
  verifyStreetScene,
  createStreetViewLibrary,
} from "../lib/street-view.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");

/** 一个假的 Commons + 地理编码：只回答我们真会问的那几种请求。 */
function fakeNetwork({ city = "Chengdu", lat = 30.67, lon = 104.07, places = [], files = [], categories = {}, imageBytes = PNG } = {}) {
  const calls = [];
  async function fetchImpl(url) {
    const raw = String(url);
    calls.push(raw);
    if (raw.includes("open-meteo.com")) {
      return { ok: true, status: 200, url: raw, json: async () => ({ results: [{ name: city, latitude: lat, longitude: lon, country: "China" }] }) };
    }
    if (raw.startsWith("https://thumb.wikimedia.org") || raw.startsWith("https://upload.wikimedia.org")) {
      return { ok: true, status: 200, url: raw, arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength) };
    }
    const parsed = new URL(raw);
    const params = parsed.searchParams;
    if (params.get("list") === "geosearch") {
      return { ok: true, status: 200, url: raw, json: async () => ({ query: { geosearch: places.map(title => ({ title })) } }) };
    }
    if (params.get("prop") === "categories" && !params.get("generator")) {
      const titles = String(params.get("titles") ?? "").split("|").filter(Boolean);
      return {
        ok: true, status: 200, url: raw,
        json: async () => ({ query: { pages: titles.map(title => ({ title, categories: (categories[title] ?? []).map(name => ({ title: name })) })) } }),
      };
    }
    if (params.get("generator") === "search" || params.get("generator") === "categorymembers") {
      return { ok: true, status: 200, url: raw, json: async () => ({ query: { pages: files } }) };
    }
    if (params.get("list") === "search") {
      return { ok: true, status: 200, url: raw, json: async () => ({ query: { search: [] } }) };
    }
    throw new Error(`未预期的请求：${raw}`);
  }
  return { fetchImpl, calls };
}

function filePage({ title = "File:Street scene - Kuanzhai Alleys - Chengdu, China - DSC05311.jpg", license = "cc0", width = 1024 } = {}) {
  return {
    title,
    pageid: 1,
    imageinfo: [{
      url: "https://upload.wikimedia.org/wikipedia/commons/8/8a/Street_scene.jpg",
      thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Street_scene.jpg/1024px-Street_scene.jpg",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Street_scene.jpg",
      mime: "image/jpeg",
      width,
      height: 640,
      thumbwidth: width,
      thumbheight: Math.round(width * 0.63),
      extmetadata: {
        License: { value: license },
        LicenseShortName: { value: license === "cc0" ? "CC0" : "Public domain" },
        UsageTerms: { value: license === "cc0" ? "Creative Commons Zero, Public Domain Dedication" : "Public domain" },
        LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" },
        Artist: { value: "<a href='#'>Daderot</a>" },
        ImageDescription: { value: "A street in Chengdu" },
      },
    }],
  };
}

test("许可：只收 CC0 与作者自己奉献的公共领域；CC BY、PD-user 这些一律不收", () => {
  assert.deepEqual(licenseVerdict({ license: "cc0" }), { allowed: true, license: "CC0", licenseName: "CC0" });
  assert.equal(licenseVerdict({ license: "cc-by-4.0" }).allowed, false);
  assert.equal(licenseVerdict({ license: "cc-by-sa-3.0" }).allowed, false);
  assert.equal(licenseVerdict({ license: "" }).allowed, false);
  // 公共领域奉献：作者自己放出来的（PD-self / PD-author）。
  assert.equal(licenseVerdict({ license: "pd", categories: ["Category:PD-self"] }).allowed, true);
  assert.equal(licenseVerdict({ license: "pd", categories: ["Category:PD-author"] }).allowed, true);
  // 合理使用那种（PD-user）不是自由使用，不能收。
  assert.equal(licenseVerdict({ license: "pd", categories: ["Category:PD-user"] }).allowed, false);
  // 只是说「公共领域」却没说是哪一条奉献的，不收。
  assert.equal(licenseVerdict({ license: "pd", categories: ["Category:PD China 1996"] }).allowed, false);
});

test("地点与街景：两个证据都要有，缺一不可", () => {
  const tokens = ["Chengdu"];
  const places = ["Category:Wide and Narrow Alleys"];
  const good = verifyStreetScene({
    categories: ["Category:CC-Zero", "Category:Wide and Narrow Alleys"],
    ancestors: ["Category:Streets in Chengdu"],
    cityTokens: tokens,
    placeCategories: places,
  });
  assert.equal(good.ok, true);
  // 只有地点、没有街景（博物馆里的一件东西）不算。
  const museum = verifyStreetScene({
    categories: ["Category:Chinese ivory in the Sichuan Museum"],
    ancestors: [],
    cityTokens: tokens,
    placeCategories: ["Category:Chinese ivory in the Sichuan Museum"],
  });
  assert.equal(museum.ok, false);
  assert.equal(museum.reason, "no-street-evidence");
  // 只有街景、没有地点（别处的街）不算。
  const elsewhere = verifyStreetScene({
    categories: ["Category:Streets in Shanghai"],
    ancestors: [],
    cityTokens: tokens,
    placeCategories: places,
  });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.reason, "no-place-evidence");
});

test("街景词与城市名：分类名要像街，也要认这座城市", () => {
  assert.equal(isStreetEvidence("Category:Streets in Chengdu"), true);
  assert.equal(isStreetEvidence("Category:Wide and Narrow Alleys"), true);
  assert.equal(isStreetEvidence("Category:Pedestrian crossings in Kyōto"), true);
  // 车站、馆子、画不算街景。
  assert.equal(isStreetEvidence("Category:Chunxi Road Station"), false);
  assert.equal(isStreetEvidence("Category:Museums in Chengdu"), false);
  assert.equal(isStreetEvidence("Category:20th-century maps of Sichuan"), false);
  // 城市名按词匹配，重音不算数。
  assert.equal(tokenMatchesCity("Category:Streets in Chengdu", ["Chengdu"]), true);
  assert.equal(tokenMatchesCity("Category:Streets in Chengdu", ["chengdu"]), true);
  assert.equal(tokenMatchesCity("Category:Streets in Chengdu", ["Shanghai"]), false);
  assert.equal(tokenMatchesCity("Category:Pedestrian crossings in Kyōto", ["Kyoto"]), true);
  // 通用词不能当前缀用：「broadway」里没有「roadway」。
  assert.equal(tokenMatchesCity("Category:Broadway, New York", ["road"]), false);
});

test("从坐标附近的分类里推出城市名：取最常出现的那个，别把「街」当地名", () => {
  const titles = [
    "Category:1991 in Chengdu", "Category:Street scenes in Chengdu", "Category:Maps of Chengdu",
    "Category:Chunxi Road", "Category:Wide and Narrow Alleys", "Category:Street trees in Chengdu",
  ];
  const tokens = deriveCityTokens(titles, ["Chengdu"]);
  assert.equal(tokens[0], "Chengdu");
  assert.ok(!tokens.includes("Street"));
  assert.ok(!tokens.includes("Road"));
  // 只有一个地标式分类时，不该把它当地名。
  const landmark = deriveCityTokens(["Category:Tiananmen", "Category:Tiananmen Square"], ["北京"]);
  assert.ok(!landmark.includes("Tiananmen"));
});

test("取图地址只认 Wikimedia 自己的域名与路径", () => {
  assert.equal(isAllowedImageUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/A.jpg/1024px-A.jpg"), true);
  assert.equal(isAllowedImageUrl("https://upload.wikimedia.org/wikipedia/commons/8/8a/A.jpg"), true);
  assert.equal(isAllowedImageUrl("http://thumb.wikimedia.org/wikipedia/commons/8/8a/A.jpg"), false);
  assert.equal(isAllowedImageUrl("https://evil.example.com/wikipedia/commons/8/8a/A.jpg"), false);
  // 路径里带 .. 的会被地址本身抹平，抹平后不在 Commons 目录里就拒。
  assert.equal(isAllowedImageUrl("https://thumb.wikimedia.org/wikipedia/commons/../x"), false);
  assert.equal(isAllowedImageUrl("not a url"), false);
  assert.deepEqual([...ALLOWED_IMAGE_HOSTS].sort(), ["thumb.wikimedia.org", "upload.wikimedia.org"]);
});

test("检索与取图只走 Commons 那一个地址", () => {
  const url = buildCommonsUrl({ list: "geosearch", gscoord: "30.67|104.07" });
  assert.ok(url.startsWith(`${COMMONS_API}?`));
  assert.match(url, /action=query/);
  assert.match(url, /list=geosearch/);
});

test("候选素材：只收够大的真照片", () => {
  const candidate = parseCandidatePage(filePage());
  assert.equal(candidate.license, "cc0");
  assert.equal(candidate.author, "Daderot");
  assert.equal(isUsableCandidate(candidate), true);
  assert.equal(isUsableCandidate({ ...candidate, width: 200 }), false);
  assert.equal(isUsableCandidate({ ...candidate, mime: "image/svg+xml" }), false);
  assert.equal(isUsableCandidate({ ...candidate, thumbUrl: "https://evil.example.com/a.jpg" }), false);
});

test("素材库：找到就用，临时文件落在应用数据目录里，换城市就作废", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-test-"));
  const net = fakeNetwork({
    city: "Chengdu",
    places: ["Category:Wide and Narrow Alleys", "Category:Streets in Chengdu", "Category:Chunxi Road"],
    files: [filePage()],
    categories: {
      "File:Street scene - Kuanzhai Alleys - Chengdu, China - DSC05311.jpg": ["Category:CC-Zero", "Category:Wide and Narrow Alleys"],
      "Category:Wide and Narrow Alleys": ["Category:Streets in Chengdu"],
    },
  });
  const lib = createStreetViewLibrary({ dataDir, fetchImpl: net.fetchImpl });
  const entry = await lib.resolve({ city: "成都", referenceId: "ref_1" });
  assert.ok(entry, "应该找得到一条真实街景");
  assert.equal(entry.scene.license, "CC0");
  assert.equal(entry.scene.title, "File:Street scene - Kuanzhai Alleys - Chengdu, China - DSC05311.jpg");
  assert.ok(entry.path.startsWith(path.join(dataDir, "v2", "street-view")), "临时文件必须在应用数据目录里");
  assert.ok(fs.existsSync(entry.path));
  // 缓存里能再取到同一份，不必重新找。
  assert.equal(lib.peek({ city: "成都", referenceId: "ref_1" }).scene.title, entry.scene.title);
  // 换城市：旧结果作废，临时文件删掉。
  lib.release({ city: "成都" });
  assert.equal(lib.peek({ city: "成都", referenceId: "ref_1" }), null);
  assert.equal(fs.existsSync(entry.path), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("素材库：换参考照后，旧的那份街景连临时文件一起作废", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-ref-"));
  const net = fakeNetwork({
    city: "Chengdu",
    places: ["Category:Wide and Narrow Alleys", "Category:Streets in Chengdu", "Category:1991 in Chengdu"],
    files: [filePage()],
    categories: {
      "File:Street scene - Kuanzhai Alleys - Chengdu, China - DSC05311.jpg": ["Category:CC-Zero", "Category:Wide and Narrow Alleys"],
      "Category:Wide and Narrow Alleys": ["Category:Streets in Chengdu"],
    },
  });
  const lib = createStreetViewLibrary({ dataDir, fetchImpl: net.fetchImpl });
  const first = await lib.resolve({ city: "成都", referenceId: "ref_old" });
  assert.ok(first);
  // 换参考照：预热时旧的那份就被丢掉。
  await lib.warm({ city: "成都", referenceId: "ref_new" });
  assert.equal(lib.peek({ city: "成都", referenceId: "ref_old" }), null);
  assert.equal(fs.existsSync(first.path), false, "旧临时文件要删掉");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("素材库：没有可用素材时不硬凑，也不报错", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-empty-"));
  const net = fakeNetwork({
    city: "Beijing",
    places: ["Category:Museums in Beijing"],
    files: [filePage({ title: "File:Museum.JPG", license: "cc-by-4.0" })],
    categories: { "File:Museum.JPG": ["Category:Museums in Beijing"] },
  });
  const lib = createStreetViewLibrary({ dataDir, fetchImpl: net.fetchImpl });
  const entry = await lib.resolve({ city: "北京", referenceId: "ref_1" });
  assert.equal(entry, null);
  assert.equal(fs.readdirSync(path.join(dataDir, "v2", "street-view")).length, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("素材库：宿主网络不可用时安静失败", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-nonetwork-"));
  const lib = createStreetViewLibrary({ dataDir, fetchImpl: () => { throw new Error("宿主网络能力不可用"); } });
  assert.equal(await lib.resolve({ city: "成都", referenceId: "ref_1" }), null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("素材库：撤销期间正在等的请求不会开启后续请求，同一城市重新开启不受旧任务影响", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-cancel-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let finish;
  let calls = 0;
  const lib = createStreetViewLibrary({ dataDir, fetchImpl: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: false });
  } });
  const input = { city: "成都", referenceId: "ref_1" };
  const old = lib.warm(input);
  await Promise.resolve();
  assert.equal(calls, 1);
  lib.release();
  const next = lib.warm(input);
  finish({ ok: true, json: async () => ({ results: [{ name: "成都", latitude: 30.67, longitude: 104.07 }] }) });
  assert.equal(await old, null);
  assert.equal(await next, null);
  assert.equal(calls, 2);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "v2", "street-view")), []);
});

test("素材库：失败后六小时内不重新探测", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "street-view-backoff-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = 1000;
  let calls = 0;
  const lib = createStreetViewLibrary({ dataDir, now: () => time, fetchImpl: async () => { calls++; return { ok: false }; } });
  const input = { city: "成都", referenceId: "ref_1" };
  await lib.warm(input);
  await lib.warm(input);
  assert.equal(calls, 1);
  time += 6 * 3600_000;
  await lib.warm(input);
  assert.equal(calls, 2);
});

test("设置页：城市从本地城市表里选，授权另有一个开关，并且说清楚会请求 Wikimedia", () => {
  const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
  assert.match(html, /id="life-city-pick"/);
  assert.match(html, /id="life-city-street-switch"/);
  assert.match(html, /Wikimedia Commons/);
  // 城市不再自己手写：从城市表里选，街景那项要先有城市才生效。
  assert.doesNotMatch(html, /id="life-city-input"/);
  assert.match(html, /先在上面选一座城市/);
});
