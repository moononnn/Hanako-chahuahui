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
function setup({ initial = null, nativeConfirm = () => false, request = null, background = false, lostResponse = false } = {}) {
  const host = new Node("div"), calls = [], revoked = [], images = [], timers = new Map();
  let nativeConfirmCalls = 0, timerId = 0, readError = null;
  let current = true, saveResult = true;
  let data = initial || { tier: "off", globalTier: "off", usage: {}, reference: { currentId: null, history: [] } };
  const context = vm.createContext({ setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }, document: { createElement: tag => new Node(tag) }, window: { confirm: () => { nativeConfirmCalls++; return nativeConfirm(); }, addEventListener() {}, removeEventListener() {} }, URL: { createObjectURL: blob => `blob:${blob.route || "test"}`, revokeObjectURL: value => revoked.push(value) } });
  vm.runInContext(source.replace("export function", "function") + "\nglobalThis.mount = mountPartnerImageSettings;", context);
  const options = { agentId: "one", isCurrent: () => current, fetchImage: async route => { images.push(route); return { ok: true, blob: async () => ({ route }) }; }, api: async (method, route, payload) => { calls.push({ method, route, payload }); if (method === "GET" && readError) throw readError; if (method === "PUT") data = { ...data, reference: { ...data.reference, currentId: payload.referenceId } }; return data; }, apiWith: async (method, route, payload, timeout) => { calls.push({ method, route, payload, timeout }); if (request) await request; if (background) { data = { ...data, referenceGeneration: { id: "job_one", status: "running", error: null } }; if (lostResponse) throw new Error("HTTP 500"); return data; } data = { ...data, reference: { ...data.reference, history: [{ id: "new", source: "generated" }, ...data.reference.history] } }; return data; }, saveTier: async value => { if (saveResult) data = { ...data, tier: value }; return saveResult; } };
  const dispose = context.mount(host, options);
  return { host, calls, revoked, images, dispose, get timerCount() { return timers.size; }, async poll() { const entry = timers.entries().next().value; if (!entry) return false; timers.delete(entry[0]); await entry[1](); await flush(); return true; }, setData(next) { data = next; }, setReadError(error) { readError = error; }, get previewImage() { return host.querySelectorAll("div").find(el => el.className === "reference-preview")?.children[0]; }, setCurrent(value) { current = value; }, failSave() { saveResult = false; }, get buttons() { return host.querySelectorAll("button"); }, get data() { return data; }, get nativeConfirmCalls() { return nativeConfirmCalls; }, get confirmation() { return host.querySelectorAll("div").find(el => el.className === "reference-cost-confirm"); } };
}
test("伙伴界面默认关闭，只有四档不填数，生成必须逐次确认", async () => {
  const s = setup(); await flush();
  const tier = s.host.children[0];
  assert.deepEqual(tier.children.map(child => child.textContent), ["关闭", "少一些", "适中", "多一些"]);
  assert.ok(tier.children[0].className.split(" ").includes("on"));
  await s.buttons.find(button => button.textContent === "生成新参考照").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(s.confirmation?.hidden, false, "默认生产路径必须在页面内显示花费确认，不依赖原生window.confirm");
  assert.equal(s.nativeConfirmCalls, 0);
  await s.buttons.find(button => button.textContent === "先不生成").click();
  assert.equal(s.confirmation.hidden, true);
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(s.host.querySelectorAll("input").some(input => input.type === "number"), false);
  s.dispose();
});
test("生成后展示新候选但不自动选用，选用单独PUT；调整有baseId", async () => {
  const s = setup(); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  const generated = s.calls.find(call => call.method === "POST");
  assert.equal(generated.payload.confirm, true); assert.equal(generated.timeout, 12000);
  assert.equal(s.data.reference.currentId, null);
  await s.buttons.find(button => button.textContent === "按这张调整").click(); await flush();
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").at(-1).payload.baseId, "new");
  await s.buttons.find(button => button.textContent === "用这张作为参考").click(); await flush();
  assert.equal(s.calls.find(call => call.method === "PUT").payload.referenceId, "new");
  assert.equal(s.data.reference.currentId, "new");
  s.dispose(); assert.ok(s.revoked.length);
});
test("原生确认框抛错时默认入口仍有可见确认，且只在确认后提交", async () => {
  const s = setup({ nativeConfirm() { throw new Error("native dialog unavailable"); } }); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click();
  assert.equal(s.confirmation.hidden, false); assert.equal(s.nativeConfirmCalls, 0);
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(s.confirmation.hidden, true); s.dispose();
});
test("确认后生成中双击和取消都不会重复提交或改写等待反馈", async () => {
  let finish;
  const s = setup({ request: new Promise(resolve => { finish = resolve; }) }); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click();
  const confirm = s.buttons.find(button => button.textContent === "确认生成");
  const cancel = s.buttons.find(button => button.textContent === "先不生成");
  const running = confirm.click();
  assert.equal(confirm.disabled, true); assert.equal(cancel.disabled, true);
  confirm.click(); cancel.click();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1);
  assert.match(s.host.children.at(-1).textContent, /正在处理/);
  finish(); await running; await flush();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1); s.dispose();
});
test("待确认时切伙伴或卸载界面使原来的确认作废，不发旧请求", async () => {
  for (const dispose of [false, true]) {
    const s = setup(); await flush();
    await s.buttons.find(button => button.textContent === "生成新参考照").click();
    if (dispose) s.dispose(); else s.setCurrent(false);
    await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
    assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
    if (!dispose) s.dispose();
    assert.equal(s.confirmation.hidden, true);
  }
});
test("待确认时换候选会作废原调整，重新确认才用新候选生成", async () => {
  const s = setup({ initial: { tier: "off", globalTier: "off", usage: {}, reference: { currentId: "first", history: [{ id: "first" }, { id: "second" }] } } }); await flush();
  await s.buttons.find(button => button.textContent === "按这张调整").click();
  s.buttons.filter(button => button.className.includes("reference-thumb"))[1].click();
  assert.equal(s.confirmation.hidden, true);
  await s.buttons.find(button => button.textContent === "确认生成").click();
  assert.equal(s.calls.filter(call => call.method === "POST").length, 0);
  assert.match(s.host.children.at(-1).textContent, /本次还没提交/);
  await s.buttons.find(button => button.textContent === "按这张调整").click();
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  assert.equal(s.calls.find(call => call.method === "POST").payload.baseId, "second"); s.dispose();
});
test("生成请求失败会明确显示原因，恢复按钮但不自动重试", async () => {
  let reject;
  const s = setup({ request: new Promise((resolve, fail) => { reject = fail; }) }); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click();
  const running = s.buttons.find(button => button.textContent === "确认生成").click();
  reject(new Error("模拟请求失败")); await running; await flush();
  assert.match(s.host.children.at(-1).textContent, /没能完成：模拟请求失败。未自动重试/);
  assert.equal(s.buttons.find(button => button.textContent === "生成新参考照").disabled, false);
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1); s.dispose();
});
test("失败的档位保存不会假亮新选项，切人后的旧异步回包不写界面", async () => {
  const s = setup(); await flush(); s.failSave();
  await s.host.children[0].children[1].click(); await flush();
  assert.ok(s.host.children[0].children[0].className.split(" ").includes("on"));
  assert.equal(s.host.children[0].children[1].className.split(" ").includes("on"), false);
  s.setCurrent(false); s.dispose();
});
test("短提交后只读轮询进度，完成后自动展示新候选且不自动选用", async () => {
  const s = setup({ background: true, initial: { tier: "off", globalTier: "off", usage: {}, reference: { currentId: "old", history: [{ id: "old" }] } } }); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click();
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  assert.equal(s.buttons.find(button => button.textContent === "参考照生成中…").disabled, true);
  const images = s.images.length;
  await s.poll();
  assert.equal(s.images.length, images, "进度未变时不重复下载大图或重画预览");
  s.setData({ ...s.data, referenceGeneration: { id: "job_one", status: "succeeded" }, reference: { currentId: "old", history: [{ id: "anime" }, { id: "old" }] } });
  await s.poll();
  assert.match(s.previewImage.src, /\/anime$/);
  assert.equal(s.data.reference.currentId, "old");
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(s.timerCount, 0); s.dispose();
});
test("提交回包丢失时GET接回已运行工作，不重发POST，完成后仍显示新图", async () => {
  const s = setup({ background: true, lostResponse: true }); await flush();
  await s.buttons.find(button => button.textContent === "生成新参考照").click();
  await s.buttons.find(button => button.textContent === "确认生成").click(); await flush();
  assert.match(s.host.children.at(-1).textContent, /正在后台生成/);
  s.setData({ ...s.data, referenceGeneration: { id: "job_one", status: "succeeded" }, reference: { currentId: null, history: [{ id: "anime" }] } });
  await s.poll();
  assert.match(s.previewImage.src, /\/anime$/);
  assert.equal(s.calls.filter(call => call.method === "POST").length, 1); s.dispose();
});
test("页面重挂能接回后台进度，刷新候选只读取现有图，不再生成", async () => {
  const s = setup({ initial: { tier: "off", globalTier: "off", usage: {}, referenceGeneration: { id: "existing", status: "running" }, reference: { currentId: null, history: [{ id: "old" }] } } }); await flush();
  assert.ok(s.timerCount);
  s.setData({ ...s.data, referenceGeneration: { id: "existing", status: "succeeded" }, reference: { currentId: null, history: [{ id: "anime" }, { id: "old" }] } });
  await s.buttons.find(button => button.textContent === "刷新候选").click(); await flush();
  assert.match(s.previewImage.src, /\/anime$/);
  assert.equal(s.calls.filter(call => call.method !== "GET").length, 0);
  assert.equal(s.timerCount, 0); s.dispose();
});
test("进度读取连续失败三次就停止定时器，手动刷新可恢复，销毁清理轮询", async () => {
  const s = setup({ initial: { tier: "off", globalTier: "off", usage: {}, referenceGeneration: { id: "existing", status: "running" }, reference: { currentId: null, history: [] } } }); await flush();
  s.setReadError(new Error("测试断网"));
  await s.poll(); await s.poll(); await s.poll();
  assert.equal(s.timerCount, 0);
  assert.match(s.host.children.at(-1).textContent, /不会重新生图/);
  s.setReadError(null);
  await s.buttons.find(button => button.textContent === "刷新候选").click(); await flush();
  assert.equal(s.timerCount, 1);
  s.dispose(); assert.equal(s.timerCount, 0);
  assert.equal(s.calls.filter(call => call.method !== "GET").length, 0);
});
test("设置页给照片模块标记版本，重新打开不会命中旧的确认框代码", () => {
  const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
  const build = settings.match(/const UI_BUILD = "([^"]+)"/)?.[1];
  assert.ok(build);
  assert.ok(settings.includes(`./assets/image-settings.js?v=${build}`));
});
test("桌面实时与异步照片共用附件渲染，不丢纯图，不受逐泡演出吞掉", () => {
  assert.match(panel, /if \(payload.message\?\.attachment\?\.id\)/);
  assert.match(panel, /m.attachment\?\.id && !drawn.has\("image"\)/);
  assert.match(panel, /mountAttachmentImage\(imageNode, m.attachment.id, current/);
  assert.match(panel, /!hasVoiceBubble\(m\) && !m.attachment\?\.id/);
});
