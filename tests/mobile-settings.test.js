import assert from "node:assert/strict";
import test from "node:test";

import { mountMobileSettings } from "../ui/assets/mobile-settings.js";

/**
 * 这一组驱动真的 mountMobileSettings（不是读源码猜），只把 DOM / api / 剪贴板换成假件。
 * 盯的是：状态没读到时不许盲发开关或保存；刷新失败不许报成功；notice 要画出来。
 */

/** 够用的假元素：事件、属性、disabled/textContent、classList、append。 */
function element(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    type: "",
    children: [],
    listeners: new Map(),
    attrs: new Map(),
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    setAttribute(name, value) { node.attrs.set(name, String(value)); },
    getAttribute(name) { return node.attrs.get(name) ?? null; },
    addEventListener(type, handler) {
      if (!node.listeners.has(type)) node.listeners.set(type, []);
      node.listeners.get(type).push(handler);
    },
    append(...children) { node.children.push(...children); },
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() {},
    async click() {
      for (const handler of node.listeners.get("click") ?? []) await handler({ preventDefault() {} });
    },
  };
  return node;
}

const IDS = [
  "mobile-switch",
  "mobile-switch-label",
  "mobile-port",
  "mobile-save",
  "mobile-refresh",
  "mobile-status",
  "mobile-notice",
  "mobile-addresses",
  "mobile-password-show",
  "mobile-password-copy",
  "mobile-password-reset",
  "mobile-password-note",
  "mobile-password",
];

function panelStub() {
  const nodes = Object.fromEntries(IDS.map((id) => [id, element("div")]));
  const root = { querySelector: (selector) => nodes[String(selector).replace(/^#/, "")] ?? null };
  const doc = { createElement: (tag) => element(tag) };
  return { nodes, root, doc };
}

const STATUS_OFF = {
  ok: true,
  enabled: false,
  port: 18090,
  running: false,
  reason: "disabled",
  addresses: [],
  hasPassword: true,
  passwordLength: 16,
  configFile: { status: "ok", error: "" },
  notice: "旧密码太短，已经换成新的；之前解锁过的手机要重新输入一次。",
};

function mountPanel(api, { said = [] } = {}) {
  const { nodes, root, doc } = panelStub();
  globalThis.document = doc;
  const panel = mountMobileSettings({ root, api, hana: {}, say: (text, kind) => said.push({ text, kind }) });
  return { panel, nodes, said };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("状态没读到时：写入口全禁用，点开关只补一次读取，绝不盲发 config", async () => {
  const calls = [];
  const api = async (method, sub, body) => {
    calls.push({ method, sub, body });
    throw new Error("连不上宿主");
  };
  const { nodes, said } = mountPanel(api);

  // 挂上就是锁着的
  assert.equal(nodes["mobile-switch"].disabled, true);
  assert.equal(nodes["mobile-save"].disabled, true);
  assert.equal(nodes["mobile-password-reset"].disabled, true);
  assert.equal(nodes["mobile-port"].disabled, true);

  await nodes["mobile-switch"].click();
  await tick();

  assert.equal(calls.filter((row) => row.sub === "/mobile/config").length, 0, "没有可信状态时绝不能盲启/盲停");
  assert.equal(calls.filter((row) => row.sub === "/mobile/status").length, 1, "点击只应该顺手补读一次状态");
  assert.match(nodes["mobile-status"].textContent, /读不到手机接入的状态/);
  assert.equal(nodes["mobile-switch"].disabled, true, "读失败后继续锁着");
  assert.equal(said.length, 0, "读失败不该有任何成功提示");
});

test("load 失败会把旧状态作废：保存也不 POST，旧值不参与下一次写", async () => {
  let fail = false;
  const calls = [];
  const api = async (method, sub, body) => {
    calls.push({ method, sub, body });
    if (method === "GET") {
      if (fail) throw new Error("网关没回话");
      return { ...STATUS_OFF, enabled: true, running: true, reason: "running" };
    }
    return { ok: true, ...STATUS_OFF };
  };
  const { panel, nodes, said } = mountPanel(api);

  assert.equal(await panel.refresh(), true);
  assert.equal(nodes["mobile-switch"].disabled, false, "读到了就能点");
  assert.equal(nodes["mobile-notice"].hidden, false, "服务端 notice 要画出来");
  assert.match(nodes["mobile-notice"].textContent, /旧密码太短/);

  fail = true;
  assert.equal(await panel.refresh(), false);
  assert.equal(panel.status, null, "失败后不该留着旧 status 当依据");
  assert.equal(nodes["mobile-save"].disabled, true);
  assert.equal(nodes["mobile-switch"].disabled, true);
  assert.equal(nodes["mobile-notice"].hidden, true, "旧 notice 也不能留在屏幕上冒充现状");

  const before = calls.length;
  await nodes["mobile-save"].click();
  await tick();
  assert.equal(calls.slice(before).filter((row) => row.sub === "/mobile/config").length, 0, "状态不可信时不许写");
  assert.equal(calls.slice(before).every((row) => row.sub === "/mobile/status"), true, "只会去补读状态");
  assert.equal(said.some((row) => row.text.includes("刷新好了")), false, "失败不能说刷新好了");
});

test("刷新按钮：成功才说刷新好，失败只留错误、不报成功", async () => {
  let fail = false;
  const api = async (method) => {
    if (method === "GET") {
      if (fail) throw new Error("没连上");
      return { ...STATUS_OFF };
    }
    return { ok: true, ...STATUS_OFF };
  };
  const { nodes, said } = mountPanel(api);

  await nodes["mobile-refresh"].click();
  await tick();
  assert.equal(said.filter((row) => row.text === "状态刷新好了").length, 1);

  fail = true;
  await nodes["mobile-refresh"].click();
  await tick();
  assert.equal(said.filter((row) => row.text === "状态刷新好了").length, 1, "第二次是失败，不能再报一次成功");
});

test("读到状态之后开关才真的写：enabled 取反、端口一起带上", async () => {
  const calls = [];
  const api = async (method, sub, body) => {
    calls.push({ method, sub, body });
    if (method === "GET") return { ...STATUS_OFF };
    return { ok: true, ...STATUS_OFF, enabled: true, notice: "" };
  };
  const { panel, nodes } = mountPanel(api);
  assert.equal(await panel.refresh(), true);
  assert.equal(nodes["mobile-port"].value, "18090", "端口回填");

  await nodes["mobile-switch"].click();
  await tick();
  const write = calls.find((row) => row.sub === "/mobile/config");
  assert.deepEqual(write, { method: "POST", sub: "/mobile/config", body: { enabled: true, port: 18090 } });
});
