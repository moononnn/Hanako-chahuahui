/**
 * 手机网关 HTTP 层：只起 127.0.0.1:0 的隔离实例，callApp 全是假的，
 * 不碰生产数据、不连真实模型、不监听 0.0.0.0。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMobileGateway, MOBILE_OPS } from "../runtime/mobile-gateway.mjs";

const PASSWORD = "246813";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function makeApp(overrides = {}) {
  const calls = [];
  const callApp = async (op, payload, timeoutMs) => {
    calls.push({ op, payload, timeoutMs });
    const custom = overrides[op];
    if (custom) return custom(payload);
    switch (op) {
      case "mobile.partners.list": return [{ id: "nova", name: "阿岚" }];
      case "mobile.thread.get": return { agentId: payload.agentId, messages: [] };
      case "mobile.stickers.list": return { groups: [], stickers: [] };
      case "mobile.avatar": return { base64: b64("AVATAR"), type: "image/png" };
      case "mobile.attachment": return { base64: b64("JPGDATA"), type: "image/jpeg" };
      case "mobile.sticker": return { base64: b64("PNG"), type: "image/png" };
      case "mobile.source-sticker": return { base64: b64("SRC"), type: "image/png" };
      case "mobile.voice": return { base64: b64("MP3"), type: "audio/mpeg" };
      case "mobile.page.index": return "<html>page</html>";
      case "mobile.asset": return { base64: b64("body{}"), type: "text/css" };
      default: return { ok: true, op };
    }
  };
  return { calls, callApp };
}

async function boot(t, options = {}) {
  const { calls, callApp } = makeApp(options.overrides);
  const now = options.now || Date.now;
  const gateway = createMobileGateway({
    password: options.password === undefined ? PASSWORD : options.password,
    callApp,
    now,
    limits: options.limits,
  });
  const { port } = await gateway.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await gateway.close(); });
  return { gateway, calls, port, base: `http://127.0.0.1:${port}` };
}

function raw(port, { method = "GET", path: pathname = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function openSse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers }, (res) => resolve({ req, res }));
    req.on("error", (error) => {
      if (error.code === "ECONNRESET") return;
      reject(error);
    });
    req.end();
  });
}

async function tokenFor(port) {
  const res = await raw(port, {
    method: "POST",
    path: "/api/unlock",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body).token;
}

test("修改操作走 GET：405，宿主一次都没被调用", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  for (const op of ["turn.send", "thread.read", "voice.played"]) {
    const res = await raw(port, { path: `/api/${op}?agentId=nova&text=hi`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 405, `${op} 应该 405，实际 ${res.status}`);
    assert.equal(res.headers.allow, "POST");
  }
  assert.deepEqual(calls, [], "GET 到写操作不许转发给宿主");
});

test("白名单外的 op 一律 404，不做任意转发（管理面与设置类始终不开）", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  for (const op of ["model.infer", "delete.everything", "asset", "status", "config", "password", "page.index", "settings.global", "memory.purge", "favorite.delete"]) {
    const res = await raw(port, { path: `/api/${op}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404, `${op} 应该 404，实际 ${res.status}`);
  }
  const post = await raw(port, {
    method: "POST",
    path: "/api/model.infer",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(post.status, 404);
  assert.deepEqual(calls, []);
});

test("读操作只认 Bearer，cookie 不算门票", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const ok = await raw(port, { path: "/api/partners.list", headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(JSON.parse(ok.body).data[0].id, "nova");

  const viaCookie = await raw(port, { path: "/api/partners.list", headers: { cookie: `ch_mobile=${token}` } });
  assert.equal(viaCookie.status, 401);

  const noAuth = await raw(port, { path: "/api/thread.get?agentId=nova" });
  assert.equal(noAuth.status, 401);

  // 只有第一次真读到了宿主
  assert.equal(calls.filter((row) => row.op === "mobile.partners.list").length, 1);
});

test("读操作不走 POST", async (t) => {
  const { port } = await boot(t);
  const token = await tokenFor(port);
  const res = await raw(port, {
    method: "POST",
    path: "/api/partners.list",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET");
});

test("修改操作：cookie 不算授权，必须有 Bearer", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const body = JSON.stringify({ agentId: "nova", text: "在吗" });
  const viaCookie = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { cookie: `ch_mobile=${token}`, "content-type": "application/json" },
    body,
  });
  assert.equal(viaCookie.status, 401);
  assert.deepEqual(calls, [], "cookie 不能把写操作放进来");

  const ok = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "mobile.turn.send");
  assert.equal(calls[0].payload.text, "在吗");
});

test("跨源写请求拒绝：Origin 不同源 / Sec-Fetch-Site cross-site", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const body = JSON.stringify({ agentId: "nova", text: "在吗" });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const evilOrigin = await raw(port, { method: "POST", path: "/api/turn.send", headers: { ...headers, origin: "http://evil.example" }, body });
  assert.equal(evilOrigin.status, 403);

  const nullOrigin = await raw(port, { method: "POST", path: "/api/turn.send", headers: { ...headers, origin: "null" }, body });
  assert.equal(nullOrigin.status, 403);

  const crossSite = await raw(port, { method: "POST", path: "/api/turn.send", headers: { ...headers, "sec-fetch-site": "cross-site" }, body });
  assert.equal(crossSite.status, 403);

  const httpsSameHost = await raw(port, { method: "POST", path: "/api/turn.send", headers: { ...headers, origin: `https://127.0.0.1:${port}` }, body });
  assert.equal(httpsSameHost.status, 403, "这个网关只说 http，https 同 host 也不算同源");

  const forwardedProto = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { ...headers, origin: `https://127.0.0.1:${port}`, "x-forwarded-proto": "https" },
    body,
  });
  assert.equal(forwardedProto.status, 403, "X-Forwarded-Proto 不算数");

  assert.deepEqual(calls, [], "被拒的跨源请求不许到宿主");

  const same = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { ...headers, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
    body,
  });
  assert.equal(same.status, 200, same.body);
  assert.equal(calls.length, 1);
});

test("token 会过期，过期后读写都 401", async (t) => {
  let stamp = 1_000_000;
  const { port } = await boot(t, { now: () => stamp, limits: { tokenTtlMs: 1000 } });
  const token = await tokenFor(port);
  const before = await raw(port, { path: "/api/partners.list", headers: { authorization: `Bearer ${token}` } });
  assert.equal(before.status, 200);

  stamp += 5000;
  const afterGet = await raw(port, { path: "/api/partners.list", headers: { authorization: `Bearer ${token}` } });
  assert.equal(afterGet.status, 401);

  const afterWrite = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: "nova", text: "过期了" }),
  });
  assert.equal(afterWrite.status, 401);
});

test("解锁失败按 IP 节流：连错到上限就 429，对的密码也先歇着", async (t) => {
  const { port } = await boot(t, { limits: { unlockMaxFails: 3, unlockWindowMs: 60000 } });
  const attempt = async (password) => raw(port, {
    method: "POST",
    path: "/api/unlock",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  for (let i = 0; i < 3; i += 1) {
    const res = await attempt("wrong");
    assert.equal(res.status, 401, `第 ${i + 1} 次应该 401`);
  }
  const blocked = await attempt("wrong");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  const blockedRight = await attempt(PASSWORD);
  assert.equal(blockedRight.status, 429, "节流期内对的密码也不能无限试");
});

test("没有密码：不开门——解锁 503、接口一律 401", async (t) => {
  const { port, calls } = await boot(t, { password: "" });
  const unlock = await raw(port, {
    method: "POST",
    path: "/api/unlock",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "anything" }),
  });
  assert.equal(unlock.status, 503);

  const read = await raw(port, { path: "/api/partners.list" });
  assert.equal(read.status, 401);
  const forged = await raw(port, { path: "/api/partners.list", headers: { authorization: "Bearer whatever" } });
  assert.equal(forged.status, 401);
  assert.deepEqual(calls, []);
});

test("body 边界：畸形 JSON 400、非 JSON 415、超大 413", async (t) => {
  const { port, calls } = await boot(t, { limits: { uploadBytes: 1024, jsonBytes: 512 } });
  const token = await tokenFor(port);
  const base = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const broken = await raw(port, { method: "POST", path: "/api/turn.send", headers: base, body: "{oops" });
  assert.equal(broken.status, 400);
  assert.equal(JSON.parse(broken.body).error.code, "invalid_json");

  const wrongType = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: '{"agentId":"nova"}',
  });
  assert.equal(wrongType.status, 415);

  const tooBig = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers: base,
    body: JSON.stringify({ agentId: "nova", text: "x".repeat(4096) }),
  });
  assert.equal(tooBig.status, 413);

  const tooBigReply = await raw(port, {
    method: "POST",
    path: "/api/thread.read",
    headers: base,
    body: JSON.stringify({ agentId: "nova", pad: "x".repeat(2048) }),
  });
  assert.equal(tooBigReply.status, 413, "普通写操作按 JSON 上限卡，不该给 16MiB");

  assert.deepEqual(calls, [], "校验失败的请求一条都不许到宿主");
});

test("附件代理：鉴权后按二进制回，cookie 也可以（img 场景）", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);

  const denied = await raw(port, { path: "/attachment?agentId=nova&attachmentId=att-1" });
  assert.equal(denied.status, 401);
  assert.deepEqual(calls, []);

  const ok = await raw(port, { path: "/attachment?agentId=nova&attachmentId=att-1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/jpeg");
  assert.equal(ok.headers["cache-control"], "no-store", "附件谁都不许缓存");
  assert.equal(ok.body, "JPGDATA");
  assert.equal(calls[0].op, "mobile.attachment");
  assert.deepEqual(calls[0].payload, { agentId: "nova", attachmentId: "att-1" });

  const viaCookie = await raw(port, { path: "/attachment?agentId=nova&attachmentId=att-1", headers: { cookie: `ch_mobile=${token}` } });
  assert.equal(viaCookie.status, 200, "图片标签带不了头，只能靠 cookie");

  const missing = await raw(port, { path: "/attachment?agentId=nova", headers: { authorization: `Bearer ${token}` } });
  assert.equal(missing.status, 400);
});

test("语音不缓存：撤回后别从本地缓存里放出来", async (t) => {
  const { port } = await boot(t);
  const token = await tokenFor(port);
  const res = await raw(port, { path: "/voice?agentId=nova&messageId=m1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("静态资源：只放行允许的类型与名字，公共样式不用登录", async (t) => {
  const { port, calls } = await boot(t);
  const css = await raw(port, { path: "/assets/panel.css" });
  assert.equal(css.status, 200);
  assert.equal(css.body, "body{}");
  assert.equal(css.headers["cache-control"], "no-store", "手机页脚本跟着版本走，不缓存");

  for (const pathname of ["/assets/panel.json", "/assets/.hidden.css", "/assets/a%2F..%2Fb.css", "/assets/../index.js"]) {
    const res = await raw(port, { path: pathname });
    assert.equal(res.status, 404, `${pathname} 应该 404，实际 ${res.status}`);
  }
  assert.equal(calls.filter((row) => row.op === "mobile.asset").length, 1, "怪名字不许去问宿主");
});

test("同 IP 的长连接有上限", async (t) => {
  const { port } = await boot(t, { limits: { maxSsePerIp: 1, maxSse: 4 } });
  const token = await tokenFor(port);
  const first = await openSse(port, { authorization: `Bearer ${token}` });
  assert.equal(first.res.statusCode, 200);
  const second = await raw(port, { path: "/events", headers: { authorization: `Bearer ${token}` } });
  assert.equal(second.status, 429);
  first.req.destroy();
});

test("token 过期的长连接会被关掉", async (t) => {
  let stamp = 2_000_000;
  const { port } = await boot(t, { now: () => stamp, limits: { tokenTtlMs: 1000, sseHeartbeatMs: 20 } });
  const token = await tokenFor(port);
  const { req, res } = await openSse(port, { authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 200);
  res.setEncoding("utf8");
  const seen = [];
  res.on("data", (chunk) => seen.push(chunk));
  const ended = new Promise((resolve) => res.on("end", resolve));
  stamp += 60_000;
  const timedOut = new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000));
  const outcome = await Promise.race([ended.then(() => "ended"), timedOut]);
  assert.equal(outcome, "ended", "token 过期后 SSE 必须被收掉");
  assert.ok(seen.join("").includes("expired"), "关之前该告诉页面一声");
  req.destroy();
});

test("解锁口令不超过 4KiB，普通写操作不被带图上限连累", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const bigUnlock = await raw(port, {
    method: "POST",
    path: "/api/unlock",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, pad: "x".repeat(8192) }),
  });
  assert.equal(bigUnlock.status, 413, "解锁只该收一个小口令");

  // turn.send 放宽到 16MiB：600KiB 的正文得放行
  const bigTurn = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers,
    body: JSON.stringify({ agentId: "nova", text: "x".repeat(600 * 1024) }),
  });
  assert.equal(bigTurn.status, 200, bigTurn.body);

  // 其他写操作还是原来的小体：600KiB 就该 413
  const before = calls.length;
  const bigRead = await raw(port, {
    method: "POST",
    path: "/api/thread.read",
    headers,
    body: JSON.stringify({ agentId: "nova", pad: "x".repeat(600 * 1024) }),
  });
  assert.equal(bigRead.status, 413);
  assert.equal(calls.length, before, "被 413 挡下的不许到宿主");
});

test("附件按解码后的尺寸卡：base64 只算长度也算得出", async (t) => {
  const { port, calls } = await boot(t, { limits: { attachmentBytes: 1024 } });
  const token = await tokenFor(port);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const small = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers,
    body: JSON.stringify({ agentId: "nova", image: { mimeType: "image/png", data: Buffer.alloc(512, 1).toString("base64") } }),
  });
  assert.equal(small.status, 200, small.body);

  const before = calls.length;
  const tooBig = await raw(port, {
    method: "POST",
    path: "/api/turn.send",
    headers,
    body: JSON.stringify({ agentId: "nova", image: { mimeType: "image/png", data: Buffer.alloc(4096, 1).toString("base64") } }),
  });
  assert.equal(tooBig.status, 413);
  assert.equal(JSON.parse(tooBig.body).error.code, "attachment_too_large");
  assert.equal(calls.length, before);
});

test("读操作会把 limit/before 原样带给宿主", async (t) => {  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const res = await raw(port, { path: "/api/thread.get?agentId=nova&limit=20&before=99", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(calls[0].payload, { agentId: "nova", limit: "20", before: "99" });
});

test("二进制缓存有条目上限：同一张图只问宿主一次，多了就淘汰", async (t) => {
  const { gateway, port, calls } = await boot(t, { limits: { cacheMaxEntries: 1 } });
  const token = await tokenFor(port);
  const headers = { authorization: `Bearer ${token}` };
  const first = await raw(port, { path: "/sticker?agentId=nova&id=a", headers });
  assert.equal(first.status, 200);
  await raw(port, { path: "/sticker?agentId=nova&id=a", headers });
  assert.equal(calls.filter((row) => row.op === "mobile.sticker").length, 1, "同一张图不该反复问宿主");
  await raw(port, { path: "/sticker?agentId=nova&id=b", headers });
  assert.equal(gateway.state().caches.sticker, 1, "上限是 1，塞第二个就得淘汰掉旧的");
});

test("附件不缓存：宿主一变脸，同一个 URL 第二次就是 404", async (t) => {
  let allowed = true;
  const { port, calls } = await boot(t, {
    overrides: {
      "mobile.attachment": () => {
        if (!allowed) throw new Error("这条已经撤回了");
        return { base64: b64("JPGDATA"), type: "image/jpeg" };
      },
    },
  });
  const token = await tokenFor(port);
  const headers = { authorization: `Bearer ${token}` };

  const first = await raw(port, { path: "/attachment?agentId=nova&attachmentId=att-1", headers });
  assert.equal(first.status, 200);
  assert.equal(first.body, "JPGDATA");

  allowed = false;
  const second = await raw(port, { path: "/attachment?agentId=nova&attachmentId=att-1", headers });
  assert.equal(second.status, 404, "宿主说没了就必须 404，不能拿网关缓存里的旧图糊过去");
  assert.notEqual(second.body, "JPGDATA");
  assert.equal(calls.filter((row) => row.op === "mobile.attachment").length, 2, "两次都得真问宿主");
});

test("新增的两个投喂/收藏 op：GET 405、cookie 不算门票、跨源 403，合法 Bearer POST 才转给宿主", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const cases = [
    { op: "message.feed", body: { agentId: "nova", messageId: "m_1", emoji: "🍰" } },
    { op: "message.favorite", body: { agentId: "nova", messageId: "m_1" } },
  ];
  for (const { op, body } of cases) {
    const viaGet = await raw(port, {
      path: `/api/${op}?agentId=nova&messageId=m_1&emoji=%F0%9F%8D%B0`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(viaGet.status, 405, `${op} 走 GET 该 405，实际 ${viaGet.status}`);
    assert.equal(viaGet.headers.allow, "POST");

    const viaCookie = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { cookie: `ch_mobile=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(viaCookie.status, 401, `${op} 只有 cookie 该 401，实际 ${viaCookie.status}`);

    const crossOrigin = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify(body),
    });
    assert.equal(crossOrigin.status, 403, `${op} 跨源该 403，实际 ${crossOrigin.status}`);
  }
  assert.deepEqual(calls, [], "被挡下的请求一条都不许到宿主");

  const fed = await raw(port, {
    method: "POST",
    path: "/api/message.feed",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: "nova", messageId: "m_1", emoji: "🍰" }),
  });
  assert.equal(fed.status, 200, fed.body);
  assert.equal(calls.at(-1).op, "mobile.message.feed");
  assert.deepEqual(calls.at(-1).payload, { agentId: "nova", messageId: "m_1", emoji: "🍰" });

  const favored = await raw(port, {
    method: "POST",
    path: "/api/message.favorite",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ agentId: "nova", messageId: "m_1" }),
  });
  assert.equal(favored.status, 200, favored.body);
  assert.equal(calls.at(-1).op, "mobile.message.favorite");
  assert.deepEqual(calls.at(-1).payload, { agentId: "nova", messageId: "m_1" });
});

test("新开的那批写 op：只认鉴权 POST、同源，合法请求真的转成 mobile.* 交给宿主", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const writes = [
    "message.retract", "message.edit", "message.regenerate", "message.delete",
    "favorite.remove", "action.send", "todos.confirm", "todos.dismiss",
  ];

  for (const op of writes) {
    const asGet = await raw(port, { path: `/api/${op}?agentId=nova`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(asGet.status, 405, `${op} 用 GET 该 405，实际 ${asGet.status}`);
    assert.equal(asGet.headers.allow, "POST");

    const viaCookie = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { cookie: `ch_mobile=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "nova" }),
    });
    assert.equal(viaCookie.status, 401, `${op} cookie 不算门票`);

    const cross = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ agentId: "nova" }),
    });
    assert.equal(cross.status, 403, `${op} 跨源该 403`);
  }
  assert.deepEqual(calls, [], "被拒的一个都不许到宿主");

  const posted = await raw(port, {
    method: "POST",
    path: "/api/todos.confirm",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ agentId: "nova", key: "todo:td_1" }),
  });
  assert.equal(posted.status, 200, posted.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "mobile.todos.confirm");
  assert.deepEqual(calls[0].payload, { agentId: "nova", key: "todo:td_1" });

  const retracted = await raw(port, {
    method: "POST",
    path: "/api/message.retract",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: "nova", messageId: "m_1" }),
  });
  assert.equal(retracted.status, 200, retracted.body);
  assert.equal(calls.at(-1).op, "mobile.message.retract");
  assert.deepEqual(calls.at(-1).payload, { agentId: "nova", messageId: "m_1" });
});

test("新开的那批读 op：只认 GET + Bearer", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const reads = ["turn.get", "favorites.list", "todos.list"];

  for (const op of reads) {
    const ok = await raw(port, {
      path: `/api/${op}?agentId=nova&turnId=t_1`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200, `${op}: ${ok.body}`);
    assert.equal(calls.at(-1).op, `mobile.${op}`);
    assert.equal(calls.at(-1).payload.agentId, "nova");

    const asPost = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "nova" }),
    });
    assert.equal(asPost.status, 405, `${op} 用 POST 该 405`);

    const viaCookie = await raw(port, { path: `/api/${op}?agentId=nova`, headers: { cookie: `ch_mobile=${token}` } });
    assert.equal(viaCookie.status, 401, `${op} cookie 不算门票`);
  }
});

test("图库管理在手机上不开：来源/分组/导入/移除全 404，/source-sticker 也不存在", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  for (const op of [
    "stickers.source", "stickers.group.create", "stickers.group.rename",
    "stickers.group.remove", "stickers.import", "stickers.remove", "source-sticker",
  ]) {
    const res = await raw(port, { path: `/api/${op}?agentId=nova`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404, `${op} 不该还开着，实际 ${res.status}`);
    const post = await raw(port, {
      method: "POST",
      path: `/api/${op}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "nova" }),
    });
    assert.equal(post.status, 404, `${op} POST 也该 404`);
  }

  // 旧的专线也不在：不能拿它绕过白名单读来源图
  const viaRoute = await raw(port, { path: "/source-sticker?agentId=nova&id=src_1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(viaRoute.status, 404);
  assert.deepEqual(calls, [], "被拒的一个都不许到宿主");

  // 只读清单和贴图媒体仍在
  const listed = await raw(port, { path: "/api/stickers.list?agentId=nova", headers: { authorization: `Bearer ${token}` } });
  assert.equal(listed.status, 200, listed.body);
  assert.equal(calls.at(-1).op, "mobile.stickers.list");
  const sticker = await raw(port, { path: "/sticker?agentId=nova&id=st_1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(sticker.status, 200);
  assert.equal(calls.at(-1).op, "mobile.sticker");
});

test("长活的超时按 op 单独给：重生成 180s、删除 120s，别的仍是 20s", async (t) => {
  const { port, calls } = await boot(t);
  const token = await tokenFor(port);
  const post = (pathname, body) => raw(port, {
    method: "POST",
    path: pathname,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await post("/api/message.regenerate", { agentId: "nova", messageId: "m_1" })).status, 200);
  assert.equal((await post("/api/message.delete", { agentId: "nova", messageId: "m_1" })).status, 200);
  assert.equal((await post("/api/action.send", { agentId: "nova" })).status, 200);

  assert.deepEqual(calls.map((row) => [row.op, row.timeoutMs]), [
    ["mobile.message.regenerate", 180_000],
    ["mobile.message.delete", 120_000],
    ["mobile.action.send", 20_000],
  ]);
});

test("op 白名单就是 6 读 13 写（图库管理不在里面）", () => {
  const reads = Object.entries(MOBILE_OPS).filter(([, kind]) => kind === "read").map(([op]) => op);
  const writes = Object.entries(MOBILE_OPS).filter(([, kind]) => kind === "write").map(([op]) => op);
  assert.deepEqual(reads.sort(), [
    "favorites.list", "partners.list", "stickers.list", "thread.get", "todos.list", "turn.get",
  ]);
  assert.deepEqual(writes.sort(), [
    "action.send", "favorite.remove", "message.delete", "message.edit", "message.favorite", "message.feed",
    "message.regenerate", "message.retract", "thread.read", "todos.confirm", "todos.dismiss",
    "turn.send", "voice.played",
  ]);
  // 图库管理/来源图都不在：手机上只能看和发，整理图库回桌面那页
  for (const op of [
    "stickers.source", "stickers.group.create", "stickers.group.rename",
    "stickers.group.remove", "stickers.import", "stickers.remove", "source-sticker",
  ]) {
    assert.equal(MOBILE_OPS[op], undefined, `${op} 不该被手机叫到`);
  }
  // 管理面永远不在里面
  for (const op of ["status", "config", "password", "page.index", "asset", "attachment", "avatar", "sticker", "voice", "background.bytes"]) {
    assert.equal(MOBILE_OPS[op], undefined, `${op} 不该被手机直接叫到`);
  }
});
