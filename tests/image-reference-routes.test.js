import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createImageReferences } from "../lib/image-reference.js";
import { registerImageReferenceRoutes } from "../lib/image-reference-routes.js";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
function setup(t, generate = async () => ({ bytes: PNG })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-ref-routes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const references = createImageReferences(dir);
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "put"].map(method => [method, (route, handler) => routes.set(`${method} ${route}`, handler)]));
  let service;
  const bus = { handle(name, handler, options) { assert.equal(name, "reference-image-generate"); assert.equal(options.allowCrossApp, false); service = handler; }, request: async (name, payload) => { assert.equal(name, "app:chahuahui/reference-image-generate"); return service(payload, { callerAppId: "chahuahui", signal: new AbortController().signal }); } };
  registerImageReferenceRoutes(app, { references, generate, bus, view: agentId => ({ ok: true, reference: references.view(agentId) }), getPersona: async () => ({ files: { identity: "绿色短发，绿眼睛" } }), listPartners: async () => [{ id: "one" }, { id: "two" }] });
  async function run(method, route, data = {}, params = { agentId: "one" }) {
    return routes.get(`${method} ${route}`)({ req: { param: name => params[name], json: async () => data }, json: (body, status = 200) => ({ body, status }), body: (bytes, status, headers) => ({ bytes, status, headers }) });
  }
  async function settled() {
    for (let i = 0; i < 40; i++) {
      const result = await run("get", "/image/partner/:agentId");
      if (result.body.referenceGeneration?.status !== "running") return result;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error("生成没有结束");
  }
  return { references, run, settled, service: (...args) => service(...args) };
}
test("上传候选、选用、读取是分开的正式路由", async t => {
  const { run } = setup(t);
  const result = await run("post", "/image/reference/:agentId", { image: { data: PNG.toString("base64") } });
  assert.equal(result.status, 200);
  assert.equal(result.body.reference.currentId, null);
  const id = result.body.reference.history[0].id;
  const selected = await run("put", "/image/reference/:agentId", { referenceId: id });
  assert.equal(selected.body.reference.currentId, id);
  const image = await run("get", "/image/reference/:agentId/:id", {}, { agentId: "one", id });
  assert.deepEqual(image.bytes, PNG);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal((await run("get", "/image/reference/:agentId/:id", {}, { agentId: "two", id })).status, 404);
});
test("参考照必须逐次明确确认，生成自动读取外貌并保持候选未选用", async t => {
  let calls = [];
  const { run, settled } = setup(t, async options => { calls.push(options); return { bytes: PNG }; });
  assert.equal((await run("post", "/image/reference/:agentId/generate", {})).status, 400);
  assert.equal(calls.length, 0);
  const accepted = await run("post", "/image/reference/:agentId/generate", { confirm: true, style: "二次元水彩" });
  assert.equal(accepted.status, 202);
  const result = await settled();
  assert.match(calls[0].prompt, /绿色短发/);
  assert.match(calls[0].prompt, /二次元水彩/);
  assert.equal(result.body.reference.currentId, null);
  const id = result.body.reference.history[0].id;
  await run("post", "/image/reference/:agentId/generate", { confirm: true, baseId: id, prompt: "头发长一点" });
  const next = await settled();
  assert.match(calls[1].referencePaths[0], /\.png$/);
  assert.match(calls[1].prompt, /头发长一点/);
  assert.equal(next.body.reference.history.length, 2);
});
test("慢生成不占用HTTP：立即202，可独立读进度，重复点击或服务重入不重复生图", { timeout: 1500 }, async t => {
  let complete;
  let calls = 0;
  const { run, settled, service } = setup(t, () => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const first = await run("post", "/image/reference/:agentId/generate", { confirm: true });
  assert.equal(first.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const progress = await run("get", "/image/partner/:agentId");
  assert.equal(progress.body.referenceGeneration.status, "running");
  await assert.rejects(() => service({ id: progress.body.referenceGeneration.id }, { callerAppId: "other-app" }), /仅供本应用/);
  assert.equal((await service({ id: progress.body.referenceGeneration.id }, { callerAppId: "chahuahui" })).ok, false);
  const second = await run("post", "/image/reference/:agentId/generate", { confirm: true });
  assert.equal(second.status, 409);
  assert.equal(calls, 1);
  complete({ bytes: PNG });
  const done = await settled();
  assert.equal(done.body.referenceGeneration.status, "succeeded");
  assert.equal(done.body.reference.history.length, 1);
  assert.equal((await run("post", "/image/reference/:agentId/generate", { confirm: true, baseId: "../outside" })).status, 404);
  assert.equal(calls, 1);
});
test("后台错误以状态明示，不重发生成请求", async t => {
  let calls = 0;
  const { run, settled } = setup(t, async () => { calls++; throw new Error("测试提供方失败"); });
  assert.equal((await run("post", "/image/reference/:agentId/generate", { confirm: true })).status, 202);
  const done = await settled();
  assert.equal(done.body.referenceGeneration.status, "failed");
  assert.match(done.body.referenceGeneration.error, /测试提供方失败/);
  await run("get", "/image/partner/:agentId");
  assert.equal(calls, 1); assert.equal(done.body.reference.history.length, 0);
});
test("不存在的伙伴和非图上传不写参考照", async t => {
  const { run, references } = setup(t);
  assert.equal((await run("get", "/image/partner/:agentId", {}, { agentId: "absent" })).status, 404);
  assert.equal((await run("post", "/image/reference/:agentId", { image: { data: Buffer.from("not a picture").toString("base64") } })).status, 400);
  assert.deepEqual(references.view("one").history, []);
});
