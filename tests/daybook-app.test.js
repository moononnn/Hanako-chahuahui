import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDaybook, daybookAvailable, buildDaybookText, buildAmbientContextText,
} from "../lib/daybook.js";

function snapshot(label = "新App今日") {
  return {
    schemaVersion: 1, generatedAt: "2026-10-05T01:55:00.000Z", dataRev: 43,
    today: { date: "2026-10-05", festivals: [label], events: [], todos: [], workday: false, period: false },
    weather: { line: "晴空万里", temp: 19 },
    summaries: {
      mine: [{ date: "2026-10-04", text: "自己的际遇" }],
      other: [{ date: "2026-10-04", text: "别人的私密际遇" }],
    },
  };
}

function publication(data = snapshot(), patch = {}) {
  return { appId: "shiguangji-app", key: "today", schemaVersion: 1, updatedAt: "2026-10-05T01:55:00.000Z", data, ...patch };
}

function host(get) {
  return {
    publicData: { get },
    resources: { read: async () => { assert.fail("禁止读旧插件文件"); } },
  };
}

// 修改前基线（fake ctx，未读生产文件）：旧 readDaybook 连续两次返回冻结旧日子，
// diskReads=1 / publicReads=0。此回归改为要求新 App 优先、每次读取宿主当前发布。
test("新App优先：临时目录有旧manifest和冻结快照也不读取", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-daybook-app-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const oldDir = path.join(home, "plugin-data", "shiguangji");
  const pluginDir = path.join(home, "plugins", "shiguangji");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "public-today.json"), JSON.stringify(snapshot("冻结旧日子")));
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "shiguangji" }));
  const calls = [];
  const ctx = host(async (args) => { calls.push(args); return publication(); });
  ctx.dataDir = path.join(home, "app-data", "chahuahui");
  assert.equal((await readDaybook(ctx)).today.festivals[0], "新App今日");
  assert.deepEqual(calls, [{ appId: "shiguangji-app", key: "today" }]);
});

test("新App更新立刻可读，不被旧TTL或同步缓存遮住", async () => {
  let current = publication(snapshot("第一次"));
  let reads = 0;
  const ctx = host(async () => { reads += 1; return current; });
  assert.equal((await readDaybook(ctx, { now: 100000 })).today.festivals[0], "第一次");
  current = publication(snapshot("第二次"));
  assert.equal((await readDaybook(ctx, { now: 100001 })).today.festivals[0], "第二次");
  assert.equal(reads, 2);
});

test("接口确实等待异步发布读取完成", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let settled = false;
  const reading = readDaybook(host(() => pending)).then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolve(publication());
  assert.equal((await reading).dataRev, 43);
});

test("发布撤回/停用/权限撤销不复用此前成功快照", async () => {
  for (const reason of ["PUBLIC_DATA_NOT_FOUND", "PUBLISHER_UNAVAILABLE", "PERMISSION_DENIED"]) {
    let revoked = false;
    const ctx = host(async () => {
      if (revoked) throw Object.assign(new Error(reason), { code: reason });
      return publication();
    });
    assert.ok(await readDaybook(ctx));
    revoked = true;
    assert.equal(await readDaybook(ctx), null);
    assert.equal(await daybookAvailable(ctx), false);
  }
});

test("没有publicData接口或get方法，旧插件活跃不可证明时明确不可用", async () => {
  const resources = host().resources;
  for (const ctx of [null, {}, { resources, dataDir: "C:/fake/app-data/chahuahui" }, { resources, publicData: {} }]) {
    assert.equal(await readDaybook(ctx), null);
    assert.equal(await daybookAvailable(ctx), false);
  }
});

test("新App发布读取失败不得偷偷回退旧文件", async () => {
  assert.equal(await readDaybook(host(async () => { throw new Error("permission denied"); })), null);
});

test("封套身份、键与版本必须符合约定，不能接错发布", async () => {
  for (const patch of [{ appId: "shiguangji" }, { key: "yesterday" }, { schemaVersion: 2 }, { schemaVersion: "1" }]) {
    assert.equal(await readDaybook(host(async () => publication(snapshot(), patch))), null);
  }
});

test("业务快照版本与关键结构校验，不把坏格式送入提示词", async () => {
  for (const data of [null, [], {}, { ...snapshot(), schemaVersion: "1" },
    { ...snapshot(), schemaVersion: 2 }, { ...snapshot(), today: [] },
    { ...snapshot(), today: { festivals: "坏列表" } },
    { ...snapshot(), today: { events: {} } }, { ...snapshot(), today: { todos: {} } },
    { ...snapshot(), today: { workday: "false" } },
    { ...snapshot(), summaries: [] }, { ...snapshot(), weather: [] }]) {
    assert.equal(await readDaybook(host(async () => publication(data))), null);
  }
});

test("共享完整schema保留，按自己的agentId提取际遇", async () => {
  const data = snapshot();
  const got = await readDaybook(host(async () => publication(data)));
  assert.deepEqual(got, data);
  const text = buildDaybookText(got, "mine");
  assert.ok(text.includes("自己的际遇"));
  assert.ok(!text.includes("别人的私密际遇"));
  const absent = buildDaybookText(got, "missing");
  assert.ok(!absent.includes("际遇"));
});

test("agentId不借继承属性取得别人的际遇", () => {
  const data = snapshot();
  data.summaries = Object.create({ mine: [{ date: "2026-10-04", text: "继承的私密际遇" }] });
  assert.ok(!buildDaybookText(data, "mine").includes("继承的私密际遇"));
});

test("主动消息仍只取共享天气，不带任何伙伴际遇", async () => {
  const text = buildAmbientContextText(await readDaybook(host(async () => publication())));
  assert.ok(text.includes("晴空万里"));
  assert.ok(!text.includes("际遇"));
  assert.ok(!text.includes("新App今日"));
});

test("设置检测只认可读的当前发布，无权限或坏快照时false", async () => {
  assert.equal(await daybookAvailable(host(async () => publication())), true);
  assert.equal(await daybookAvailable(host(async () => publication(null))), false);
  assert.equal(await daybookAvailable(host(async () => { throw new Error("no grant"); })), false);
});

test("index保留await调用与开关门禁，检测接线不再探旧插件文件", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const detector = source.match(/async function shiguangjiInstalled\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(detector?.includes("return daybookAvailable(ctx)"));
  assert.ok(!detector.includes("resources.read"));
  assert.ok(!detector.includes("public-today.json"));
  assert.ok(source.includes("daybookInstalled: await shiguangjiInstalled()"));
  assert.ok(source.includes("daybookOn() ? await readDaybook(ctx) : null") || source.includes("await readDaybookVerbose(ctx)"));
  assert.ok(source.includes("daybookOn() ? buildAmbientContextText(await readDaybook(ctx))"));
});
