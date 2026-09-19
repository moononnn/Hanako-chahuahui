/**
 * 装载守卫：模块能不能被真的加载、apply 能不能跑通。
 *
 * 这道守卫是补出来的。原因：只跑 `node --check`（查语法）加上对源码的文本断言，
 * 拦不住「同一作用域里重复声明」这种错——ta不报语法错，但会让**整个模块加载失败**。
 * 宿主判定装载 failed 之后会把安装记录一起回滚，应用直接从列表里消失，
 * 表现就是「重启后茶话会不见了」。
 *
 * 所以凡是改完 index.js，这两条必须过。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("index.js 能被真的加载，导出齐全", async () => {
  const mod = await import("../index.js");
  assert.equal(mod.name, "chahuahui");
  assert.equal(typeof mod.apply, "function");
  assert.match(mod.version, /^\d+\.\d+\.\d+$/);
});

test("apply 跑得通（装载那一刻出错会让整个应用消失）", async () => {
  const { apply } = await import("../index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-load-"));
  const registered = [];
  const ctx = {
    dataDir: dir,
    logger: { info() {}, warn() {}, error() {} },
    bus: { request: async () => ({ agents: [] }), subscribe: () => () => {} },
    inputBanner: { set() {}, dismiss() {} },
    routes: { register: (fn) => registered.push(fn) },
    tools: { register: () => {} },
    resources: { read: async () => ({ content: "" }) },
  };
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(registered.length, 1, "路由要注册上");
});

test("装载期不碰受保护接口（碰了宿主可能判定装载失败、回滚安装记录）", async () => {
  const { apply } = await import("../index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-load-guard-"));
  const touched = [];
  const guard = (label) => () => {
    touched.push(label);
    return Promise.resolve({});
  };
  const ctx = {
    dataDir: dir,
    logger: { info() {}, warn() {}, error() {} },
    bus: { request: guard("bus.request"), subscribe: () => () => {} },
    inputBanner: { set() {}, dismiss() {} },
    routes: { register: () => {} },
    tools: { register: () => {} },
    resources: { read: guard("resources.read"), list: guard("resources.list") },
    models: { stream: guard("models.stream"), list: guard("models.list"), utility: guard("models.utility") },
  };
  apply(ctx);
  assert.deepEqual(touched, [], "apply 执行期间不该发起受权限保护的调用");
});

test("内测入口必须包在 DEV_TOOLS 开关里（本地验收要用、发布版不许开）", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  // 这些口子能触发模型调用或后台写盘，发布副本构建时 DEV_TOOLS 置 false，整面关掉
  for (const route of ["/probe/last", "/probe/taste", "/analyze/personality", "/notify/test", "/proactive/tick"]) {
    const escaped = route.replace(/\//g, "\\/");
    assert.match(src, new RegExp(`if \\(DEV_TOOLS\\) app\\.(?:get|post)\\("${escaped}"`), `${route} 没包进 DEV_TOOLS`);
  }
  // 三个内测工具也不能裸着
  const toolRe = /if \(DEV_TOOLS\) ctx\.tools\.register\(\{[\s\S]{0,300}?name: "([^"]+)"/g;
  const guarded = new Set();
  let found;
  while ((found = toolRe.exec(src))) guarded.add(found[1]);
  assert.deepEqual(
    [...guarded].sort(),
    ["chahuahui_ping", "chahuahui_remind_now", "chahuahui_taste_probe"],
    "内测工具要刚好这三个，且都包在 DEV_TOOLS 里",
  );
});
