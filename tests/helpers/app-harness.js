import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../../lib/store.js";

/**
 * 一个只覆盖茶话会实际用到那点接口的路由宿主。
 *
 * 茶话会不自带 hono：路由由 ctx.routes.register(app => ...) 注册进来。
 * 这里补的形状就是那几行代码真正用到的东西——app.get/post/put/delete/use/onError、
 * c.req.{json,param,query,method,path}、c.json、c.body。
 * 补得刚好够真跑，不多造一层假抽象。
 */

function compile(pattern) {
  const names = [];
  const source = String(pattern)
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        names.push(seg.slice(1));
        return "([^/]+)";
      }
      if (seg === "*") {
        names.push("wildcard");
        return "(.*)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${source}$`), names };
}

function matchOne(compiled, pathValue) {
  const found = compiled.re.exec(pathValue);
  if (!found) return null;
  const params = {};
  compiled.names.forEach((name, index) => { params[name] = decodeURIComponent(found[index + 1] ?? ""); });
  return params;
}

export function createHost() {
  const middlewares = [];
  const routes = [];
  let onError = null;

  const register = (method) => (pattern, handler) => { routes.push({ method, ...compile(pattern), handler }); };
  const app = {
    use(pattern, handler) { middlewares.push({ ...compile(pattern), handler }); },
    onError(handler) { onError = handler; },
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
    patch: register("PUT"),
    delete: register("DELETE"),
  };

  async function dispatch(method, url, { json, searchParams } = {}) {
    const [rawPath, rawQuery = ""] = String(url).split("?");
    const query = new Map(new URLSearchParams(rawQuery));
    let payload = json;
    let failed = false;
    const c = {
      req: {
        method,
        path: rawPath,
        param: (name) => c.__params[name] ?? "",
        query: (name) => query.get(name) ?? undefined,
        async json() { return payload; },
        header: () => undefined,
      },
      __params: {},
      json(body, status) { return { status: status ?? 200, body }; },
      body(value, status) { return { status: status ?? 200, body: value }; },
      text(value, status) { return { status: status ?? 200, body: value }; },
    };

    const chain = [...middlewares, null];
    let index = -1;
    const next = async () => {
      index += 1;
      if (index >= middlewares.length) {
        const route = routes.find((row) => row.method === method && matchOne(row, rawPath));
        if (!route) return { status: 404, body: { ok: false, error: { message: "not found" } } };
        c.__params = matchOne(route, rawPath) ?? {};
        return route.handler(c);
      }
      const mw = middlewares[index];
      const params = matchOne(mw, rawPath);
      if (!params) return next();
      c.__params = params;
      return mw.handler(c, next);
    };
    void chain;
    try {
      return (await next()) ?? { status: 204, body: null };
    } catch (error) {
      failed = true;
      if (onError) return onError(error, c);
      throw error;
    } finally {
      void failed;
    }
  }

  return { app, dispatch, routes, middlewares };
}

/** 可控的模型出口：stream 挂起，由测试自己决定什么时候回、回什么。 */
function createModelStub() {
  const pending = [];
  const calls = [];
  const cancelled = [];
  const stub = {
    calls,
    pending,
    cancelled,
    /** 等到第 n 次（从0起）stream 请求挂起为止。 */
    async waitForCall(index = 0, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (stub.calls.length <= index) {
        if (Date.now() > deadline) throw new Error(`等待第 ${index} 次模型调用超时（实际 ${stub.calls.length} 次）`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return stub.calls[index];
    },
    release(index, text) {
      const entry = stub.calls[index];
      if (!entry) throw new Error(`没有第 ${index} 次模型调用`);
      entry.resolve({ ndjson: text });
    },
    /** 回一个带错的空包：走「模型接不上」那条判定。 */
    releaseError(index, code = "APP_MODEL_QUOTA_EXCEEDED", message = "quota exceeded") {
      const entry = stub.calls[index];
      if (!entry) throw new Error(`没有第 ${index} 次模型调用`);
      entry.resolve({ ndjson: JSON.stringify({ type: "error", code, message }), asEvent: true });
    },
    list: async () => ({ models: [{ provider: "test-provider", model: "test-model" }] }),
    stream(request) {
      const index = stub.calls.length;
      const entry = { index, request, resolve: null };
      stub.calls.push(entry);
      return new Promise((resolve) => {
        entry.resolve = (payload) => resolve({
          text: async () => (payload.asEvent ? payload.ndjson : JSON.stringify({ type: "text-delta", delta: payload.ndjson }) + "\n"),
          json: async () => ({}),
        });
      });
    },
    utility: async () => ({ requestId: "utility-test", text: "" }),
    cancel: async (requestId) => { cancelled.push(requestId); },
  };
  void pending;
  return stub;
}

/**
 * 可控的网络出口：语音合成真正走的就是 ctx.network.fetch
 * （synthesizeVoice → synthesizeChat → postJson → ctx.network.fetch），
 * 不是猜的——它就是 lib/voice.js 里唯一的外部出口。
 */
function createNetworkStub() {
  const calls = [];
  const stub = {
    calls,
    async waitForCall(index = 0, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (stub.calls.length <= index) {
        if (Date.now() > deadline) throw new Error(`等待第 ${index} 次网络请求超时（实际 ${stub.calls.length} 次）`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return stub.calls[index];
    },
    /** 放行：给一个最小合法 WAV 的 base64，够 decodeAudio 与字幕回退走通。 */
    release(index, payload) {
      const entry = stub.calls[index];
      if (!entry) throw new Error(`没有第 ${index} 次网络请求`);
      entry.resolve({
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      });
    },
    fetch(url, options = {}) {
      const index = stub.calls.length;
      const entry = { index, url: String(url), options, resolve: null };
      stub.calls.push(entry);
      return new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
    },
  };
  return stub;
}

/** 44 字节头 + 一小段静音，够 WAV 解析走通。 */
export function fakeWavBase64() {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + 8, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(32000, 24);
  header.writeUInt32LE(64000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(8, 40);
  return Buffer.concat([header, Buffer.alloc(8)]).toString("base64");
}

/**
 * 起一个真装载的茶话会：走真的 apply(ctx)，路由是真的，数据目录是临时的。
 * 只有宿主接口是假的（模型、伙伴列表、网络）。
 */
export async function bootChahuahui({ seed } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-routes-"));
  const store = createStore(dataDir);
  const models = createModelStub();
  const net = createNetworkStub();

  const partner = { id: "nova", name: "小花", description: "测试用伙伴", personality: "嘴上不饶人，但心里有数" };
  const ctx = {
    dataDir,
    routes: { register(callback) { callback(host.app); } },
    logger: { info() {}, warn() {}, error() {} },
    bus: {
      request: async (type) => {
        if (type === "agent:list") return { agents: [partner] };
        if (type === "agent:profile") return { agent: partner };
        return { agents: [] };
      },
      subscribe() { return () => {}; },
    },
    models,
    network: { fetch: net.fetch },
    resources: { read: async () => null, list: async () => [] },
    tools: { call: async () => null },
    inputBanner: null,
  };
  const host = createHost();

  if (typeof seed === "function") seed(store, ctx);
  const { apply } = await import("../../index.js");
  apply(ctx);

  const request = (method, url, options) => host.dispatch(method, url, options);
  return { dataDir, store, models, net, ctx, request, host };
}

/** 临时目录下的真账本读回：证明写进去的是文件里的东西，不是内存里的残留。 */
export function reopenThread(dataDir, agentId) {
  return createStore(dataDir).getThread(agentId).messages;
}
