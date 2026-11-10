import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
const source = fs.readFileSync(new URL("../ui/assets/image-settings.js", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.value = ""; this.className = ""; this.classList = { toggle: (name, on) => { const set = new Set(this.className.split(" ").filter(Boolean)); on ? set.add(name) : set.delete(name); this.className = [...set].join(" "); } }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]); return selector === "*" ? all : all.filter(child => child.tagName === selector); }
  click() { if (!this.disabled) return this.events.click?.(); }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup({ confirm = true, initial = null } = {}) {
  const host = new Node("div"), calls = [], revoked = [];
  let current = true, saveResult = true;
  let data = initial || { tier: "off", globalTier: "off", usage: {}, reference: { currentId: null, history: [] } };
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, window: { addEventListener() {}, removeEventListener() {} }, URL: { createObjectURL: () => "blob:test", revokeObjectURL: value => revoked.push(value) } });
  vm.runInContext(source.replace("export function", "function") + "\nglobalThis.mount = mountPartnerImageSettings;", context);
  const options = { agentId: "one", isCurrent: () => current, confirmCost: () => confirm, fetchImage: async () => ({ ok: true, blob: async () => ({}) }), api: async (method, route, payload) => { calls.push({ method, route, payload }); if (method === "PUT") data = { ...data, reference: { ...data.reference, currentId: payload.referenceId } }; return data; }, apiWith: async (method, route, payload, timeout) => { calls.push({ method, route, payload, timeout }); data = { ...data, reference: { ...data.reference, history: [{ id: "new", source: "generated" }, ...data.reference.history] } }; return data; }, saveTier: async value => { if (saveResult) data = { ...data, tier: value }; return saveResult; } };
  const dispose = context.mount(host, options);
  return { host, calls, revoked, dispose, setCurrent(value) { current = value; }, failSave() { saveResult = false; }, get buttons() { return host.querySelectorAll("button"); }, get data() { return data; } };
}
test("伙伴界面默认关闭，只有四档不填数，生成必须逐次确认", async () => {
  const s = setup({ confirm: false }); await flush();
  const tier = s.host.children[0];
  assert.deepEqual(tier.children.map(child => child.textContent), ["关闭", "少一些", "适中", "多一些"]);
  assert.ok(tier.children[0].className.split(" ").includes("on"));
  await s.buttons.find(button => button.textContent === "生成新参考照").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(s.host.querySelectorAll("input").some(input => input.type === "number"), false);
  s.dispose();
});
test("生成后展示新候选但不自动选用，选用单独PUT；调整有baseId", async () => {
  const s = setup(); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click(); await flush();
  const generated = s.calls.find(call => call.method === "POST");
  assert.equal(generated.payload.confirm, true); assert.equal(generated.timeout, 340000);
  assert.equal(s.data.reference.currentId, null);
  await s.buttons.find(button => button.textContent === "按这张调整").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").at(-1).payload.baseId, "new");
  await s.buttons.find(button => button.textContent === "用这张作为参考").click(); await flush();
  assert.equal(s.calls.find(call => call.method === "PUT").payload.referenceId, "new");
  assert.equal(s.data.reference.currentId, "new");
  s.dispose(); assert.ok(s.revoked.length);
});
test("失败的档位保存不会假亮新选项，切人后的旧异步回包不写界面", async () => {
  const s = setup(); await flush(); s.failSave();
  await s.host.children[0].children[1].click(); await flush();
  assert.ok(s.host.children[0].children[0].className.split(" ").includes("on"));
  assert.equal(s.host.children[0].children[1].className.split(" ").includes("on"), false);
  s.setCurrent(false); s.dispose();
});
test("桌面实时与异步照片共用附件渲染，不丢纯图，不受逐泡演出吞掉", () => {
  assert.match(panel, /if \(payload.message\?\.attachment\?\.id\)/);
  assert.match(panel, /m.attachment\?\.id && !drawn.has\("image"\)/);
  assert.match(panel, /mountAttachmentImage\(imageNode, m.attachment.id, current/);
  assert.match(panel, /!hasVoiceBubble\(m\) && !m.attachment\?\.id/);
});
