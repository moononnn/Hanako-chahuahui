import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "../lib/vendor/video-qrcode/index.cjs";
import { createVideoLogin } from "../lib/video-login.js";

for (const [name, fetcher, stage, reason] of [
  ['network', async () => { const error = new Error('private-key-and-url'); error.code = 'ERR_ACCESS_DENIED'; throw error; }, 'request-failed', '连接B站二维码接口失败，请检查网络权限或连接。'],
  ['http', async () => response(null, { ok: false, status: 403 }), 'http-rejected', 'B站二维码接口拒绝了请求，请稍后重试。'],
  ['business', async () => response({ code: -412, message: 'private-key-and-url' }), 'business-rejected', 'B站二维码接口拒绝了请求，请稍后重试。'],
  ['json', async () => response(null, { json: async () => { throw new Error('private-key-and-url'); } }), 'response-format', 'B站返回的二维码格式暂不兼容。'],
  ['format', async () => response({ code: 0, data: { url: ORIGIN + '/scan?qrcode_key=private-key', qrcode_key: 'different-private-key' } }), 'response-format', 'B站返回的二维码格式暂不兼容。'],
]) test('二维码生成失败安全分段诊断：' + name, async () => {
  const records = [];
  const login = createVideoLogin({ fetcher, onDiagnostic: (row) => records.push(row) });
  const result = await login.start();
  assert.equal(result.reason, reason);
  assert.equal(records.at(-1).stage, stage);
  assert.doesNotMatch(JSON.stringify([result, records]), /private-key|https:|qrcode_key/);
});

test('本地编码异常只报告安全阶段，不泄漏异常文本', async (t) => {
  t.mock.method(QRCode.prototype, 'make', () => { throw new TypeError('private-key-and-url'); });
  const records = [];
  const login = createVideoLogin({ fetcher: async () => response({ code: 0, data: { url: ORIGIN + '/scan?qrcode_key=private-key', qrcode_key: 'private-key' } }), onDiagnostic: (row) => records.push(row) });
  assert.equal((await login.start()).reason, '本地二维码编码失败。');
  assert.equal(records.at(-1).stage, 'local-encoding');
  assert.equal(records.at(-1).errorType, 'TypeError');
  assert.doesNotMatch(JSON.stringify(records), /private-key|https:/);
});

test('当前官方account二维码地址可编码，仍精确限制域名与key绑定', async () => {
  for (const host of ['account.bilibili.com', 'passport.bilibili.com']) {
    const login = createVideoLogin({ fetcher: async () => response({ code: 0, data: {
      url: `https://${host}/scan?qrcode_key=SYNTHETIC_ACCOUNT_KEY`, qrcode_key: 'SYNTHETIC_ACCOUNT_KEY',
    } }) });
    const result = await login.start();
    assert.equal(result.ok, true, host);
    assert.match(result.svg, /^<svg/);
  }
  for (const host of ['account.bilibili.com.evil.invalid', 'evil-account.bilibili.com']) {
    const login = createVideoLogin({ fetcher: async () => response({ code: 0, data: {
      url: `https://${host}/scan?qrcode_key=SYNTHETIC_ACCOUNT_KEY`, qrcode_key: 'SYNTHETIC_ACCOUNT_KEY',
    } }) });
    assert.equal((await login.start()).ok, false);
  }
});

test('官方确认回包直接带SESSDATA时仍经nav验证才登录，诊断不含秘密', async (t) => {
  const records = [];
  const f = fixture(t, { onDiagnostic: row => records.push(row), poll: () => response(scanned(0, ''), {
    headers: { get: () => `SESSDATA=${NEW}; Path=/; Secure` },
  }) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, 'loggedIn');
  assert.equal(f.count(NAV_PATH), 1);
  assert.equal(f.count('crossDomain'), 0);
  assert.equal(records.find(row => row.stage === 'confirmed').sessionCookieInResponse, true);
  assert.ok(records.some(row => row.stage === 'logged-in'));
  safe(records);
});

test('票据响应不带凭据时安全报告阶段及状态，不归因宿主或泄漏票据', async (t) => {
  const records = [];
  const f = fixture(t, { onDiagnostic: row => records.push(row), poll: () => response(scanned(0, ticketUrl())) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).ok, false);
  const detail = records.find(row => row.stage === 'ticket-response');
  assert.equal(detail.httpStatus, 200);
  assert.equal(detail.sessionCookiePresent, false);
  assert.ok(records.some(row => row.stage === 'credential-unavailable'));
  assert.equal(f.count(NAV_PATH), 0);
  safe(records);
});

test('未知登录地址只记已知域名类别和参数存在性，不放行或记录原URL', async (t) => {
  const records = [];
  const f = fixture(t, { onDiagnostic: row => records.push(row), poll: () => response(scanned(0,
    'https://account.bilibili.com/unknown?ticket=' + TICKET)) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).ok, false);
  const detail = records.find(row => row.stage === 'login-url-rejected');
  assert.equal(detail.loginUrlHost, 'account.bilibili.com');
  assert.equal(detail.hasTicketParameter, true);
  assert.equal(f.count('crossDomain'), 0);
  safe(records);
});

test('SESSDATA中的合法星号不被误拒，换票和手动兼容入口都须经nav验证', async (t) => {
  const star = 'FAKE_STAR%2C123%2Ctail*12';
  const records = [];
  const f = fixture(t, { onDiagnostic: row => records.push(row), poll: () => response(scanned(0, ticketUrl())),
    cross: () => response(null, { headers: { get: () => `SESSDATA=${star}; Path=/; Secure; HttpOnly` } }),
  });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, 'loggedIn');
  assert.equal(await f.login.getCookie(), `SESSDATA=${star}`);
  assert.equal(f.count(NAV_PATH), 1);
  assert.equal((await f.login.loginToken(star)).ok, true);
  assert.doesNotMatch(JSON.stringify(records), /FAKE_STAR|tail\*12/);
});

test('请求来源地址对齐已实测成功的扫码脚本及nav探针', async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, legacy())) });
  const qr = await f.login.start();
  assert.equal(f.calls[0].options.headers.Referer, `${ORIGIN}/login`);
  assert.equal((await f.login.poll(qr.id)).status, 'loggedIn');
  assert.equal(f.calls.find(call => call.url.pathname === NAV_PATH).options.headers.Referer, 'https://www.bilibili.com/');
});

test('同一二维码保留早期poll的SESSDATA，确认前不登录不验证，确认后须经nav', async (t) => {
  const records = [];
  let turn = 0;
  const f = fixture(t, { onDiagnostic: row => records.push(row), poll: () => ++turn === 1
    ? response(scanned(86101), { headers: { getSetCookie: () => [`SESSDATA=${NEW}; Path=/; HttpOnly`] } })
    : response(scanned(turn === 2 ? 86090 : 0)) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, 'waiting');
  assert.equal(await f.login.getCookie(), '');
  assert.equal(f.count(NAV_PATH), 0);
  f.advance(2000);
  assert.equal((await f.login.poll(qr.id)).status, 'scanned');
  f.advance(2000);
  assert.equal((await f.login.poll(qr.id)).status, 'loggedIn');
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal(f.count(NAV_PATH), 1);
  assert.equal(f.count('crossDomain'), 0);
  assert.equal(records.find(row => row.stage === 'confirmed').sessionCookieFromEarlierPoll, true);
  safe(records);
});

for (const replace of ['refresh', 'expire']) test(`早期poll凭据不跨二维码复用：${replace}`, async (t) => {
  let turn = 0;
  const f = fixture(t, { poll: () => ++turn === 1
    ? response(scanned(86101), { headers: { getSetCookie: () => [`SESSDATA=${OLD}; Path=/`] } })
    : response(scanned(0)) });
  const first = await f.login.start();
  assert.equal((await f.login.poll(first.id)).status, 'waiting');
  if (replace === 'expire') {
    f.advance(180000);
    assert.equal((await f.login.poll(first.id)).status, 'expired');
  }
  const next = await f.login.start();
  assert.equal((await f.login.poll(next.id)).ok, false);
  assert.equal(await f.login.getCookie(), '');
  assert.equal(f.count(NAV_PATH), 0);
});

test('后续poll明确清空SESSDATA时不复活早期候选', async (t) => {
  let turn = 0;
  const f = fixture(t, { poll: () => response(scanned(++turn === 1 ? 86101 : 0), {
    headers: { getSetCookie: () => [`SESSDATA=${turn === 1 ? OLD : ''}; Path=/`] },
  }) });
  const qr = await f.login.start();
  await f.login.poll(qr.id);
  f.advance(2000);
  assert.equal((await f.login.poll(qr.id)).ok, false);
  assert.equal(await f.login.getCookie(), '');
  assert.equal(f.count(NAV_PATH), 0);
});

for (const attributes of ['Max-Age=0', 'Max-Age=-1', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']) {
  test(`带删除属性的非空SESSDATA清除早期候选：${attributes}`, async (t) => {
    let turn = 0;
    const f = fixture(t, { poll: () => response(scanned(++turn === 1 ? 86101 : 0), {
      headers: { get: () => `SESSDATA=${OLD}; ${turn === 1 ? 'Path=/' : attributes}, UID=FAKE_UID; Path=/` },
    }) });
    const qr = await f.login.start();
    await f.login.poll(qr.id);
    f.advance(2000);
    assert.equal((await f.login.poll(qr.id)).ok, false);
    assert.equal(f.count(NAV_PATH), 0);
    assert.equal(await f.login.getCookie(), '');
  });
}

test('有效Max-Age优先于过去Expires，仍验证候选才登录', async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0), { headers: { getSetCookie: () => [
    `SESSDATA=${NEW}; Max-Age=600; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ] } }) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, 'loggedIn');
  assert.equal(f.count(NAV_PATH), 1);
});

// 全部为合成数据。fetcher 完全替身，不导入宿主、不读账号、不调用真实网络。
const ORIGIN = "https://passport.bilibili.com";
const NAV_PATH = "/x/web-interface/nav";
const CROSS = "https://passport.biligame.com/x/passport-login/web/crossDomain";
const OLD = "FAKE_OLD%2C123%2Cabc";
const NEW = "FAKE_NEW%2C456%2Cdef";
const TICKET = "FAKE_TICKET_ONLY";
const GOOD = { code: 0, data: { isLogin: true } };
const BAD = { code: -101, data: { isLogin: false } };
const scanned = (code, url) => ({ code: 0, data: { code, ...(url ? { url } : {}), refresh_token: "FAKE_REFRESH_NEVER_COOKIE" } });
const legacy = (value = NEW) => `${ORIGIN}/login/redirect?SESSDATA=${encodeURIComponent(value)}&DedeUserID=FAKE_UID&bili_jct=FAKE_CSRF`;
const ticketUrl = () => `${CROSS}?ticket=${TICKET}&gourl=https%3A%2F%2Fevil.invalid%2F&DedeUserID=FAKE_UID`;
function response(body, extra = {}) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture(t, handlers = {}) {
  let now = 1_800_000_000_000;
  let sequence = 0;
  t.mock.method(Date, "now", () => now);
  const calls = [];
  const state = {
    loadCredential: undefined,
    saveCredential: undefined,
    clearCredential: undefined,
    nav: () => response(GOOD),
    generate: () => {
      const key = `SIMULATED_KEY_${++sequence}`;
      return response({ code: 0, data: { qrcode_key: key, url: `${ORIGIN}/h5-app/passport/login/scan?qrcode_key=${key}` } });
    },
    poll: () => response(scanned(86101)),
    cross: () => response(null),
    ...handlers,
  };
  const login = createVideoLogin({
    loadCredential: state.loadCredential,
    saveCredential: state.saveCredential,
    clearCredential: state.clearCredential,
    onDiagnostic: state.onDiagnostic,
    fetcher: async (raw, options) => {
      const url = new URL(raw);
      calls.push({ url, options });
      assert.equal(options.method, "GET");
      assert.match(options.headers["User-Agent"], /Mozilla\/5\.0.*Chrome/u);
      assert.equal(options.headers.Referer, url.pathname === NAV_PATH ? 'https://www.bilibili.com/' : `${ORIGIN}/login`);
      assert.equal(Object.hasOwn(options, "redirect"), false, "不得假定宿主支持 manual redirect");
      if (url.hostname === "api.bilibili.com" && url.pathname === NAV_PATH) return state.nav(url, options);
      assert.equal(options.headers.Cookie, undefined, "nav 以外接口不携带已有 Cookie");
      if (url.hostname === "passport.bilibili.com" && url.pathname.endsWith("/qrcode/generate")) return state.generate(url, options);
      if (url.hostname === "passport.bilibili.com" && url.pathname.endsWith("/qrcode/poll")) return state.poll(url, options);
      if (url.hostname === "passport.biligame.com" && url.pathname === "/x/passport-login/web/crossDomain") return state.cross(url, options);
      assert.fail("模块发起了未允许的模拟请求");
    },
  });
  return { login, calls, state, now: () => now, advance: (ms) => { now += ms; }, count: (part) => calls.filter((c) => c.url.pathname.includes(part)).length };
}
const saved = () => ({ ok: true, cookie: `SESSDATA=${OLD}` });
function safe(result) {
  const text = JSON.stringify(result);
  for (const secret of [OLD, NEW, TICKET, "FAKE_UID", "FAKE_REFRESH", "SIMULATED_KEY", "evil.invalid", "SESSDATA=", "qrcode_key=", "ticket="]) {
    assert.equal(text.includes(secret), false, `公开结果泄露合成标记 ${secret}`);
  }
}

test("无凭据时状态 none，不发 nav、不默认联网", async () => {
  const login = createVideoLogin();
  assert.deepEqual(await login.status(), { status: "none", hasLogin: false, storage: "none" });
  assert.deepEqual(await login.status({ force: true }), { status: "none", hasLogin: false, storage: "none" });
  assert.equal(await login.getCookie(), "");
  assert.equal((await login.start()).ok, false);
  assert.equal((await login.loginToken(NEW)).ok, false);
});

test("安全加载一次，剥离其他 Cookie，保留已加密存储标记并进行 nav 验证", async (t) => {
  let loads = 0;
  const f = fixture(t, { loadCredential: async () => { loads += 1; return { ok: true, cookie: `SESSDATA=${OLD}; UID=FAKE_UID`, storage: "encrypted" }; } });
  const rows = await Promise.all([f.login.status(), f.login.status(), f.login.getCookie()]);
  assert.equal(loads, 1);
  assert.equal(f.count(NAV_PATH), 1);
  assert.equal(rows[2], `SESSDATA=${OLD}`);
  assert.deepEqual(rows[0], { status: "loggedIn", hasLogin: true, storage: "encrypted" });
  assert.deepEqual(rows[0], rows[1]);
  assert.equal(f.calls[0].options.headers.Cookie, `SESSDATA=${OLD}`);
  safe(rows[0]);
});

for (const [name, loader] of [
  ["安全加载失败", async () => ({ ok: false, cookie: `SESSDATA=${OLD}` })],
  ["加载异常", async () => { throw new Error(`FAKE ${OLD}`); }],
  ["非字符串", async () => ({ ok: true, cookie: {} })],
  ["重复 SESSDATA", async () => ({ ok: true, cookie: "SESSDATA=a; SESSDATA=b" })],
  ["头部换行", async () => ({ ok: true, cookie: "SESSDATA=x\r\nInjected: yes" })],
]) {
  test(`${name}不采用凭据且不反复加载`, async (t) => {
    let loads = 0;
    const f = fixture(t, { loadCredential: async () => { loads += 1; return loader(); } });
    assert.equal((await f.login.status()).status, "none");
    await f.login.status({ force: true });
    assert.equal(await f.login.getCookie(), "");
    assert.equal(loads, 1);
    assert.equal(f.calls.length, 0);
  });
}

test("nav 五分钟缓存，边界后重查，force 绕过缓存", async (t) => {
  const f = fixture(t, { loadCredential: saved });
  await f.login.status();
  f.advance(299999);
  await f.login.status();
  assert.equal(f.count(NAV_PATH), 1);
  f.advance(1);
  await f.login.status();
  assert.equal(f.count(NAV_PATH), 2);
  await f.login.status({ force: true });
  assert.equal(f.count(NAV_PATH), 3);
});

test("force 与普通 nav 请求合并在途", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { loadCredential: saved, nav: () => { entered.resolve(); return held.promise; } });
  const first = f.login.status();
  await entered.promise;
  const second = f.login.status({ force: true });
  const third = f.login.status();
  held.resolve(response(GOOD));
  assert.deepEqual(await Promise.all([first, second, third]), Array(3).fill({ status: "loggedIn", hasLogin: true, storage: "memory" }));
  assert.equal(f.count(NAV_PATH), 1);
});

for (const [name, nav] of [
  ["网络异常", () => { throw new Error(`URL ${legacy()} ${OLD}`); }],
  ["HTTP 失败", () => response(BAD, { ok: false, status: 503 })],
  ["JSON 失败", () => response(null, { json: async () => { throw new Error(OLD); } })],
  ["未知接口码", () => response({ code: -500, message: OLD })],
  ["缺少 isLogin", () => response({ code: 0, data: {} })],
  ["字符串 isLogin", () => response({ code: 0, data: { isLogin: "false" } })],
]) {
  test(`${name}为 unknown，不误报失效`, async (t) => {
    const f = fixture(t, { loadCredential: saved, nav });
    const result = await f.login.status();
    assert.deepEqual(result, { status: "unknown", hasLogin: false, storage: "memory" });
    safe(result);
    assert.equal(await f.login.getCookie(), `SESSDATA=${OLD}`);
    await f.login.status();
    assert.equal(f.count(NAV_PATH), 1, "unknown 同样受缓存约束");
  });
}

for (const body of [{ code: -101 }, { code: 0, data: { isLogin: false } }]) {
  test(`明确失效 ${JSON.stringify(body)} 才清除内存凭据并产生稳定 episodeId`, async (t) => {
    const f = fixture(t, { loadCredential: saved, nav: () => response(body) });
    const first = await f.login.status();
    const second = await f.login.status({ force: true });
    assert.equal(first.status, "expired");
    assert.match(first.episodeId, /^[a-f0-9-]{36}$/u);
    assert.equal(first.episodeId, second.episodeId);
    assert.equal(first.storage, "none");
    assert.equal(await f.login.getCookie(), "");
    assert.equal(f.count(NAV_PATH), 1, "凭据清除后不再重复请求nav");
    safe(first);
  });
}

test("网络未知保留加密凭据；只有B站明确判定过期才清除", async (t) => {
  let clears = 0;
  const f = fixture(t, {
    loadCredential: async () => ({ ...saved(), encrypted: true }),
    clearCredential: async () => { clears += 1; return { ok: true }; },
    nav: () => { throw new Error("network unavailable"); },
  });
  const unknown = await f.login.status();
  assert.deepEqual(unknown, { status: "unknown", hasLogin: false, storage: "encrypted" });
  assert.equal(await f.login.getCookie(), `SESSDATA=${OLD}`);
  assert.equal(clears, 0);

  f.state.nav = () => response(BAD);
  const expired = await f.login.status({ force: true });
  assert.equal(expired.status, "expired");
  assert.equal(expired.storage, "none");
  assert.equal(await f.login.getCookie(), "");
  assert.equal(clears, 1);
  assert.equal(f.count(NAV_PATH), 2);
});

test("重新登录清除旧 episode，下次明确失效产生新 episode", async (t) => {
  const f = fixture(t, { loadCredential: saved, nav: () => response(BAD) });
  const first = await f.login.status();
  f.state.nav = () => response(GOOD);
  const logged = await f.login.loginToken(NEW);
  assert.deepEqual(logged, { ok: true, status: "loggedIn", hasLogin: true, storage: "memory" });
  f.state.nav = () => response(BAD);
  const next = await f.login.status({ force: true });
  assert.equal(next.status, "expired");
  assert.notEqual(next.episodeId, first.episodeId);
});

test("旧 nav 失效回包不能覆盖新登录，也不能清除新状态对应的凭据", async (t) => {
  const held = deferred();
  const entered = deferred();
  let clears = 0;
  const f = fixture(t, { loadCredential: async () => ({ ...saved(), encrypted: true }),
    clearCredential: async () => { clears += 1; return { ok: true }; },
    nav: (_url, options) => {
      if (options.headers.Cookie === `SESSDATA=${OLD}`) { entered.resolve(); return held.promise; }
      return response(GOOD);
    } });
  const old = f.login.status();
  await entered.promise;
  assert.equal((await f.login.loginToken(NEW)).ok, true);
  held.resolve(response(BAD));
  assert.equal((await old).status, "loggedIn");
  assert.equal((await f.login.status()).episodeId, undefined);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal(clears, 0);
});

test("旧 nav 成功回包不能清除新凭据的失效事件", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { loadCredential: saved, nav: (_url, options) => {
    if (options.headers.Cookie === `SESSDATA=${OLD}`) { entered.resolve(); return held.promise; }
    return response(GOOD);
  } });
  const old = f.login.status();
  await entered.promise;
  await f.login.loginToken(NEW);
  f.state.nav = () => response(BAD);
  const expired = await f.login.status({ force: true });
  held.resolve(response(GOOD));
  assert.deepEqual(await old, expired);
  assert.deepEqual(await f.login.status(), expired);
});

for (const token of [null, {}, "", "x;y", "x\r\nHeader:x", "x%0aHeader", "bad%ZZ", "x%3bUID%3dy"]) {
  test(`拒绝非法 token ${JSON.stringify(token)}`, async (t) => {
    const f = fixture(t);
    const result = await f.login.loginToken(token);
    assert.equal(result.ok, false);
    safe(result);
    assert.equal(f.calls.length, 0);
  });
}

test("旧 token 兼容前缀和百分号编码，只有 nav 通过才提交", async (t) => {
  const f = fixture(t);
  assert.equal((await f.login.loginToken("SESSDATA=FAKE_NEW,456,def")).ok, true);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  safe(await f.login.status());
  f.state.nav = () => response(BAD);
  assert.equal((await f.login.loginToken(OLD)).ok, false);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`, "失败不得覆盖原先有效凭据");
});

test("并发 token 登录不让旧尝试覆盖后发成功", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { nav: (_u, options) => {
    if (options.headers.Cookie === `SESSDATA=${OLD}`) { entered.resolve(); return held.promise; }
    return response(GOOD);
  } });
  const old = f.login.loginToken(OLD);
  await entered.promise;
  await f.login.loginToken(NEW);
  held.resolve(response(GOOD));
  assert.equal((await old).ok, false);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("start 只返回 UUID、本地 SVG 和 180s TTL；SVG 模块与编码器矩阵一致", async (t) => {
  const f = fixture(t);
  const qr = await f.login.start();
  assert.deepEqual(Object.keys(qr).sort(), ["expiresAt", "id", "ok", "svg"]);
  assert.match(qr.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.equal(qr.expiresAt, f.now() + 180000);
  assert.match(qr.svg, /^<svg\b/u);
  assert.doesNotMatch(qr.svg, /<!|<\s*(?:script|foreignObject|image|use)\b|\bhref\s*=|\bon\w+\s*=|url\s*\(|@import/iu);
  safe(qr);
  const encoder = new QRCode(0, 0);
  encoder.addData(`${ORIGIN}/h5-app/passport/login/scan?qrcode_key=SIMULATED_KEY_1`);
  encoder.make();
  const n = encoder.getModuleCount();
  assert.ok(qr.svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  const rendered = Array.from({ length: n }, () => Array(n).fill(false));
  const commands = [...qr.svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/gu)];
  assert.ok(commands.length > 100);
  for (const [, x, y, width, back] of commands) {
    assert.equal(width, back);
    for (let dx = 0; dx < Number(width); dx += 1) rendered[Number(y) - 4][Number(x) - 4 + dx] = true;
  }
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) assert.equal(rendered[y][x], encoder.isDark(y, x));
  assert.equal(f.calls.length, 1, "二维码编码不得请求图片服务");
});

for (const [name, data] of [
  ["外域 URL", { qrcode_key: "X", url: "https://evil.invalid/?qrcode_key=X" }],
  ["HTTP URL", { qrcode_key: "X", url: `${ORIGIN.replace("https", "http")}/?qrcode_key=X` }],
  ["URL key 不一致", { qrcode_key: "X", url: `${ORIGIN}/?qrcode_key=Y` }],
  ["缺 key", { url: `${ORIGIN}/?qrcode_key=X` }],
  ["注入 key", { qrcode_key: "X\r\n", url: `${ORIGIN}/?qrcode_key=X` }],
  ["重复 key", { qrcode_key: "X", url: `${ORIGIN}/?qrcode_key=X&qrcode_key=X` }],
]) {
  test(`生成回包${name}安全拒绝`, async (t) => {
    const f = fixture(t, { generate: () => response({ code: 0, data }) });
    const result = await f.login.start();
    assert.equal(result.ok, false);
    safe(result);
  });
}

test("并发刷新只保留最新生成会话", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t);
  const generate = f.state.generate;
  f.state.generate = () => { entered.resolve(); return held.promise; };
  const old = f.login.start();
  await entered.promise;
  f.state.generate = generate;
  const fresh = await f.login.start();
  held.resolve(generate());
  assert.equal((await old).ok, false);
  assert.equal((await f.login.poll(fresh.id)).status, "waiting");
});

test("waiting/scanned 按 2s 节流，不使用后台 timer", async (t) => {
  const f = fixture(t);
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "waiting");
  f.state.poll = () => response(scanned(86090));
  f.advance(1999);
  assert.equal((await f.login.poll(qr.id)).status, "waiting");
  assert.equal(f.count("/qrcode/poll"), 1);
  f.advance(1);
  assert.equal((await f.login.poll(qr.id)).status, "scanned");
  assert.equal(f.count("/qrcode/poll"), 2);
  f.advance(10000);
  assert.equal(f.count("/qrcode/poll"), 2, "时间流逝不应自动发请求");
});

test("同一二维码并发 poll 合并在途，间隔从请求开始计", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => { entered.resolve(); return held.promise; } });
  const qr = await f.login.start();
  const first = f.login.poll(qr.id);
  await entered.promise;
  f.advance(3000);
  const second = f.login.poll(qr.id);
  held.resolve(response(scanned(86090)));
  assert.deepEqual(await first, await second);
  assert.equal(f.count("/qrcode/poll"), 1);
});

test("本地 TTL 和未知 id 均不发请求，不把二维码过期当账号过期", async (t) => {
  const f = fixture(t, { loadCredential: saved });
  await f.login.status();
  const qr = await f.login.start();
  f.advance(180000);
  assert.deepEqual(await f.login.poll(qr.id), { ok: true, status: "expired" });
  assert.deepEqual(await f.login.poll("UNKNOWN_ID"), { ok: true, status: "expired" });
  assert.equal(f.count("/qrcode/poll"), 0);
  assert.equal((await f.login.status()).status, "loggedIn");
});

test("服务端 86038 是终态，不再轮询", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(86038)) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "expired");
  f.advance(2001);
  assert.equal((await f.login.poll(qr.id)).status, "expired");
  assert.equal(f.count("/qrcode/poll"), 1);
  assert.equal((await f.login.status()).status, "none");
});

test("刷新期间旧 poll 成功回包不能安装凭据或继续请求跨域接口", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => { entered.resolve(); return held.promise; } });
  const old = await f.login.start();
  const pending = f.login.poll(old.id);
  await entered.promise;
  const fresh = await f.login.start();
  held.resolve(response(scanned(0, ticketUrl())));
  assert.equal((await pending).status, "expired");
  assert.equal(await f.login.getCookie(), "");
  assert.equal(f.count("crossDomain"), 0);
  assert.notEqual(old.id, fresh.id);
  assert.equal((await f.login.poll(old.id)).status, "expired");
});

test("二维码确认的 nav 在刷新后返回也不得提交", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => response(scanned(0, legacy())), nav: () => { entered.resolve(); return held.promise; } });
  const qr = await f.login.start();
  const pending = f.login.poll(qr.id);
  await entered.promise;
  await f.login.start();
  held.resolve(response(GOOD));
  assert.equal((await pending).status, "expired");
  assert.equal(await f.login.getCookie(), "");
});

test("二维码验证跨过 180s 不提交迟到成功", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => response(scanned(0, legacy())), nav: () => { entered.resolve(); return held.promise; } });
  const qr = await f.login.start();
  const pending = f.login.poll(qr.id);
  await entered.promise;
  f.advance(180000);
  held.resolve(response(GOOD));
  assert.equal((await pending).status, "expired");
  assert.equal(await f.login.getCookie(), "");
});

test("legacy 官方 URL 参数 SESSDATA 经过 nav 验证，仅取 SESSDATA", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, legacy())) });
  const qr = await f.login.start();
  assert.deepEqual(await f.login.poll(qr.id), { ok: true, status: "loggedIn", hasLogin: true, storage: "memory" });
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal(f.calls.find((c) => c.url.pathname === NAV_PATH).options.headers.Cookie, `SESSDATA=${NEW}`);
  assert.equal(f.count("crossDomain"), 0);
  safe(await f.login.status());
  f.advance(200000);
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  assert.equal(f.count("/qrcode/poll"), 1);
});

test("crossDomain 精确 GET，只转发 ticket，从 getSetCookie 取 SESSDATA", async (t) => {
  const f = fixture(t, {
    poll: () => response(scanned(0, ticketUrl())),
    cross: (url) => {
      assert.equal(url.origin + url.pathname, CROSS);
      assert.deepEqual([...url.searchParams], [["ticket", TICKET]]);
      return response(null, { headers: { getSetCookie: () => ["UID=FAKE_UID; Path=/", `SESSDATA=${NEW}; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; Secure`], get: () => { throw new Error("不应读取合并头"); } } });
    },
  });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.deepEqual(result, { ok: true, status: "loggedIn", hasLogin: true, storage: "memory" });
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal(f.count("crossDomain"), 1);
  safe(result);
});

for (const [name, joined] of [
  ["SESSDATA 在后", `other=x; Expires=Wed, 21 Oct 2030 07:28:00 GMT, SESSDATA=${NEW}; Path=/; Secure`],
  ["SESSDATA 在前", `SESSDATA=${NEW}; Expires=Wed, 21 Oct 2030 07:28:00 GMT, UID=FAKE_UID; Path=/`],
  ["无属性合并", `SESSDATA=${NEW}, UID=FAKE_UID`],
  ["原始逗号值", "SESSDATA=FAKE_NEW,456,def; Path=/"],
]) {
  test(`合并 Set-Cookie ${name}，不乱拆 Expires`, async (t) => {
    const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())), cross: () => response(null, { headers: { get: (key) => key === "set-cookie" ? joined : null } }) });
    const qr = await f.login.start();
    assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
    assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  });
}

test("宿主隐藏中间 302 Cookie 时安全失败，不把 ticket/refresh_token 当凭据", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())) });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /有效登录凭据/u);
  assert.equal(await f.login.getCookie(), "");
  assert.equal(f.count(NAV_PATH), 0);
  assert.equal(f.calls.length, 3);
  safe(result);
});

for (const [name, raw] of [
  ["HTTP", ticketUrl().replace("https:", "http:")],
  ["恶意子域", ticketUrl().replace("passport.biligame.com", "passport.biligame.com.evil.invalid")],
  ["错误路径", ticketUrl().replace("/crossDomain", "/other")],
  ["错误域", ticketUrl().replace("passport.biligame.com", "passport.bilibili.com")],
  ["自定义端口", ticketUrl().replace(".com/", ".com:444/")],
  ["账号密码", ticketUrl().replace("https://", "https://user:pass@")],
  ["重复 ticket", `${ticketUrl()}&ticket=OTHER`],
  ["缺少凭据", `${ORIGIN}/login/redirect?refresh_token=FAKE_REFRESH_NEVER_COOKIE`],
  ["重复 SESSDATA", `${legacy()}&SESSDATA=OTHER`],
  ["SESSDATA 头注入", legacy("abc%0d%0aInjected")],
]) {
  test(`成功回包中的${name} URL 不登录、不越界请求`, async (t) => {
    const f = fixture(t, { poll: () => response(scanned(0, raw)) });
    const qr = await f.login.start();
    const result = await f.login.poll(qr.id);
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 2);
    assert.equal(await f.login.getCookie(), "");
    safe(result);
  });
}

for (const [name, nav] of [["明确失效", () => response(BAD)], ["网络故障", () => { throw new Error(`${NEW} ${ticketUrl()}`); }]]) {
  test(`取得 Cookie 但 nav ${name}不伪报成功`, async (t) => {
    const f = fixture(t, { poll: () => response(scanned(0, legacy())), nav });
    const qr = await f.login.start();
    const result = await f.login.poll(qr.id);
    assert.equal(result.ok, false);
    assert.equal(await f.login.getCookie(), "");
    assert.equal((await f.login.status()).status, "none");
    safe(result);
  });
}

test("生成、轮询和跨域原始异常只返回中文固定错误，不泄露 URL/异常", async (t) => {
  const leak = () => { throw new Error(`${legacy()} ${ticketUrl()} ${OLD}`); };
  const f = fixture(t, { generate: leak });
  const failedStart = await f.login.start();
  assert.equal(failedStart.ok, false);
  safe(failedStart);
  f.state.generate = () => response({ code: 0, data: { qrcode_key: "X", url: `${ORIGIN}/?qrcode_key=X` } });
  const qr = await f.login.start();
  f.state.poll = leak;
  const failedPoll = await f.login.poll(qr.id);
  assert.equal(failedPoll.ok, false);
  safe(failedPoll);
  f.advance(2000);
  f.state.poll = () => response(scanned(0, ticketUrl()));
  f.state.cross = leak;
  const failedCross = await f.login.poll(qr.id);
  assert.equal(failedCross.ok, false);
  safe(failedCross);
});

test("没有 Response.url 也能成功，有异域落地 URL 则拒绝", async (t) => {
  const f = fixture(t, { nav: () => response(GOOD, { url: "https://evil.invalid/x/web-interface/nav" }) });
  assert.equal((await f.login.loginToken(NEW)).ok, false);
  assert.equal(await f.login.getCookie(), "");
  f.state.nav = () => response(GOOD);
  assert.equal((await f.login.loginToken(NEW)).ok, true);
  f.state.generate = () => response({ code: 0, data: {} }, { url: "https://evil.invalid/" });
  assert.equal((await f.login.start()).ok, false);
});

test("扫码先成功后 getCookie/status 不再加载旧磁盘凭据", async (t) => {
  let loads = 0;
  const f = fixture(t, { loadCredential: () => { loads += 1; return saved(); }, poll: () => response(scanned(0, legacy())) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal((await f.login.status()).status, "loggedIn");
  assert.equal(loads, 0);
});

test("扫码成功后只保存nav验证通过的SESSDATA，回包和终态标记不含凭据", async (t) => {
  const writes = [];
  const diagnostics = [];
  const f = fixture(t, {
    poll: () => response(scanned(0, legacy(NEW))),
    saveCredential: async (cookie) => { writes.push(cookie); return { ok: true, encrypted: true }; },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.deepEqual(writes, [`SESSDATA=${NEW}`]);
  assert.deepEqual(result, { ok: true, status: "loggedIn", hasLogin: true, storage: "encrypted" });
  assert.deepEqual(await f.login.poll(qr.id), result);
  assert.equal((await f.login.status()).storage, "encrypted");
  safe(result);
  assert.doesNotMatch(JSON.stringify(diagnostics), /FAKE_NEW|SESSDATA=/u);
});

test("持久化失败仍保留本次已验证登录，不清除其他凭据", async (t) => {
  let clears = 0;
  const diagnostics = [];
  const f = fixture(t, {
    poll: () => response(scanned(0, legacy(NEW))),
    saveCredential: async () => { throw new Error(`private ${NEW}`); },
    clearCredential: async () => { clears += 1; return { ok: true }; },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.deepEqual(result, { ok: true, status: "loggedIn", hasLogin: true, storage: "memory" });
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal(clears, 0);
  assert.doesNotMatch(JSON.stringify(diagnostics), /FAKE_NEW|SESSDATA=/u);
  safe(result);
});

test("旧 loader 晚到不覆盖扫码；新登录不等待旧 loader", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { loadCredential: () => { entered.resolve(); return held.promise; }, poll: () => response(scanned(0, legacy())) });
  const oldStatus = f.login.status();
  await entered.promise;
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
  assert.equal((await f.login.status()).status, "loggedIn");
  held.resolve(saved());
  assert.equal((await oldStatus).status, "loggedIn");
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("token 成功使在途 start 失效", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t);
  const generate = f.state.generate;
  f.state.generate = () => { entered.resolve(); return held.promise; };
  const pending = f.login.start();
  await entered.promise;
  await f.login.loginToken(NEW);
  held.resolve(generate());
  assert.equal((await pending).ok, false);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("token 成功使旧二维码 nav 验证回包失效", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => response(scanned(0, legacy(OLD))), nav: (_url, options) => {
    if (options.headers.Cookie === `SESSDATA=${OLD}`) { entered.resolve(); return held.promise; }
    return response(GOOD);
  } });
  const qr = await f.login.start();
  const pending = f.login.poll(qr.id);
  await entered.promise;
  await f.login.loginToken(NEW);
  held.resolve(response(GOOD));
  assert.equal((await pending).status, "expired");
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("状态对象和返回值可被外部修改而不污染模块，实例不共享凭据", async (t) => {
  const f = fixture(t);
  await f.login.loginToken(NEW);
  const state = await f.login.status();
  state.status = "expired";
  state.episodeId = "FAKE_INJECTED";
  assert.equal((await f.login.status()).status, "loggedIn");
  assert.equal((await f.login.status()).episodeId, undefined);
  const other = createVideoLogin();
  assert.equal((await other.status()).status, "none");
  assert.equal(await other.getCookie(), "");
});

test("跨域请求在途时刷新二维码，迟到 Cookie 不触发 nav", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())), cross: () => { entered.resolve(); return held.promise; } });
  const qr = await f.login.start();
  const pending = f.login.poll(qr.id);
  await entered.promise;
  await f.login.start();
  held.resolve(response(null, { headers: { get: () => `SESSDATA=${OLD}; Path=/` } }));
  assert.equal((await pending).status, "expired");
  assert.equal(f.count(NAV_PATH), 0);
  assert.equal(await f.login.getCookie(), "");
});

test("扫码成功也会使旧 nav 失效回包作废", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t, { loadCredential: saved, poll: () => response(scanned(0, legacy())), nav: (_u, options) => {
    if (options.headers.Cookie === `SESSDATA=${OLD}`) { entered.resolve(); return held.promise; }
    return response(GOOD);
  } });
  const oldStatus = f.login.status();
  await entered.promise;
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  held.resolve(response(BAD));
  assert.equal((await oldStatus).status, "loggedIn");
  assert.equal((await f.login.status()).episodeId, undefined);
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("getSetCookie 抛错时回退 get，不透传异常", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())), cross: () => response(null, { headers: {
    getSetCookie: () => { throw new Error(OLD); },
    get: () => `UID=FAKE_UID; Expires=Wed, 21 Oct 2030 07:28:00 GMT, SESSDATA=${NEW}; Path=/`,
  } }) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  assert.equal(await f.login.getCookie(), `SESSDATA=${NEW}`);
});

test("若 fetcher 确实暴露 302 Set-Cookie，可提取但仍须 nav 验证", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())), cross: () => response(null, {
    ok: false, status: 302, headers: { getSetCookie: () => [`SESSDATA=${NEW}; Path=/; Secure`] },
  }) });
  const qr = await f.login.start();
  assert.equal((await f.login.poll(qr.id)).status, "loggedIn");
  assert.equal(f.count(NAV_PATH), 1);
});

test("Set-Cookie 缺少 SESSDATA 或最后清空时不能采用 UID/ticket", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(0, ticketUrl())), cross: () => response(null, { headers: {
    getSetCookie: () => [`SESSDATA=${NEW}; Path=/`, "SESSDATA=; Max-Age=0", `ticket=${TICKET}; Path=/`, "UID=FAKE_UID; Path=/"],
  } }) });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.equal(result.ok, false);
  assert.equal(f.count(NAV_PATH), 0);
  assert.equal(await f.login.getCookie(), "");
  safe(result);
});

test("轮询网络错误受 2s 节流，可重试且不更改已验证登录态", async (t) => {
  const f = fixture(t, { loadCredential: saved, poll: () => { throw new Error(OLD); } });
  await f.login.status();
  const qr = await f.login.start();
  const first = await f.login.poll(qr.id);
  assert.equal(first.ok, false);
  f.advance(1999);
  assert.deepEqual(await f.login.poll(qr.id), first);
  assert.equal(f.count("/qrcode/poll"), 1);
  assert.equal((await f.login.status()).status, "loggedIn");
  f.advance(1);
  f.state.poll = () => response(scanned(86101));
  assert.equal((await f.login.poll(qr.id)).status, "waiting");
  assert.equal(f.count("/qrcode/poll"), 2);
});

test("生成接口回包超过 TTL 不返回已过期二维码", async (t) => {
  const held = deferred();
  const entered = deferred();
  const f = fixture(t);
  const generate = f.state.generate;
  f.state.generate = () => { entered.resolve(); return held.promise; };
  const pending = f.login.start();
  await entered.promise;
  f.advance(180000);
  held.resolve(generate());
  const result = await pending;
  assert.equal(result.ok, false);
  safe(result);
});

test("未知扫码 code 不误判过期，不采用其他登录字段", async (t) => {
  const f = fixture(t, { poll: () => response(scanned(12345)) });
  const qr = await f.login.start();
  const result = await f.login.poll(qr.id);
  assert.equal(result.ok, false);
  assert.equal((await f.login.status()).status, "none");
  assert.equal(f.count(NAV_PATH), 0);
  safe(result);
});
