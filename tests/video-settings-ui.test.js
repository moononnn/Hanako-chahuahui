import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const client = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const loginCode = client.slice(client.indexOf("    // 扫码登录局部状态"), client.indexOf('    document.getElementById("msg-avatars-switch").addEventListener'));
const partnerCode = client.slice(client.indexOf("    function partnerVideoField("), client.indexOf("    async function openPartner("));
const plain = (value) => JSON.parse(JSON.stringify(value));
function element() {
  const classes = new Set();
  return {
    textContent: "", hidden: false, disabled: false, attrs: {}, dataset: {}, children: [], label: { textContent: "" },
    replaceChildren() { this.children = []; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; },
    classList: { toggle(key, value) { if (value) classes.add(key); else classes.delete(key); }, contains: (key) => classes.has(key) },
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this[key]; delete this.attrs[key]; },
    querySelector() { return this.label; }, appendChild(child) { this.children.push(child); },
    addEventListener(type, handler) { this[type] = handler; },
  };
}
function harness(api) {
  const nodes = Object.fromEntries(["video-login-status", "video-login-button", "video-qrcode-refresh", "video-qrcode", "video-qrcode-countdown", "panel-proactive"].map((id) => [id, element()]));
  nodes["video-qrcode-countdown"].hidden = true;
  const timers = new Map(); const countdowns = new Map();
  const events = {};
  let clock = 10000;
  let timerId = 0;
  const doc = { hidden: false, getElementById(id) { assert.ok(nodes[id], id); return nodes[id]; }, addEventListener(type, handler) { events[type] = handler; } };
  const context = vm.createContext({ document: doc, window: { addEventListener(type, handler) { events[type] = handler; } }, api, apiWith: api,
    Date: { now: () => clock, parse: Date.parse }, encodeURIComponent,
    setTimeout(fn, delay) {
      assert.ok(delay === 1000 || delay === 2000, `unexpected timer delay: ${delay}`);
      (delay === 2000 ? timers : countdowns).set(++timerId, fn);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); countdowns.delete(id); },
  });
  vm.runInContext(loginCode, context);
  return { nodes, context, events, doc, timers, countdowns,
    run: (code) => vm.runInContext(code, context),
    start: () => nodes["video-login-button"].click(),
    refresh: () => nodes["video-qrcode-refresh"].click(),
    async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); clock += 2000; await fn(); },
    async tickCountdown() { const [id, fn] = countdowns.entries().next().value; countdowns.delete(id); clock += 1000; await fn(); },
    expire() { clock = 999999; },
  };
}
const qr = (id = "test-qr") => ({ ok: true, id, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h2v2z"/></svg>', expiresAt: 100000 });

test("客户端内联脚本语法与所有固定DOM监听目标", () => {
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(source.replace(/^\s*import .*;\s*$/gm, ""));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of client.matchAll(/document\.getElementById\("([^"]+)"\)\.addEventListener/g)) assert.ok(ids.includes(id), id);
});

test("保留全局六档，扫码区替代凭据输入且状态独占一行", () => {
  const panel = html.slice(html.indexOf('<section id="panel-proactive"'), html.indexOf('<section id="panel-partners"'));
  const choices = vm.runInNewContext(client.match(/const VIDEO_SHARE_CHOICES = (\[.*\]);/)[1]);
  assert.deepEqual(plain(choices), [[0, "暂停"], [1, "1条"], [2, "2条"], [3, "3条"], [4, "4条"], [5, "5条"]]);
  assert.doesNotMatch(panel, /SESSDATA|type="password"|type="number"|type="range"|退出登录/);
  assert.match(panel, /扫码登录B站/); assert.match(panel, /刷新二维码/);
  assert.match(panel, /加密保存在本机/); assert.match(panel, /下次打开不用重扫/); assert.match(panel, /只有B站明确判定过期才清除/); assert.match(panel, /不评论、不点赞、不投币/);
  assert.match(panel, /<\/div>\s*<img[^>]+id="video-qrcode"[^>]+hidden>\s*<small[^>]+id="video-login-status"/);
  assert.match(panel, /id="video-qrcode-countdown" aria-live="off" hidden><\/small>/);
  assert.match(html, /#video-login-actions \{[^}]*flex-wrap: nowrap;/);
  assert.doesNotMatch(loginCode, /localStorage|sessionStorage|console\.|innerHTML|video\/login|sessdata/i);
});

test("扫码操作行只保留既有两按钮，刷新DOM在左、扫码最后且保留主次样式", () => {
  const actions = html.match(/<div class="detail-actions" id="video-login-actions">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...actions.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]), ["video-qrcode-refresh", "video-login-button"]);
  assert.match(actions, /<button class="soft-button" id="video-qrcode-refresh"[^>]*\bhidden>刷新二维码<\/button>/);
  assert.match(actions, /<button class="primary-button" id="video-login-button"[^>]*>扫码登录B站<\/button>\s*$/);
  assert.equal(actions.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, "").trim(), "", "不增加额外布局或把提示塞进操作行");
});

test("按钮共同固定同高并清除默认margin，整行右对齐使刷新显隐不挪扫码", () => {
  const rowRule = html.match(/#video-login-actions\s*\{([^}]+)\}/)[1];
  const buttonRule = html.match(/#video-login-actions button\s*\{([^}]+)\}/)[1];
  assert.match(rowRule, /flex-wrap:\s*nowrap\s*;/);
  assert.match(rowRule, /justify-content:\s*flex-end\s*;/);
  assert.match(buttonRule, /flex:\s*none\s*;/);
  assert.match(buttonRule, /margin:\s*0\s*;/, "清除primary-button默认的顶距和auto左距");
  assert.match(buttonRule, /height:\s*38px\s*;/, "同一选择器规定两个按钮同高");
  assert.match(buttonRule, /white-space:\s*nowrap\s*;/);
  assert.doesNotMatch(rowRule + buttonRule, /position:\s*absolute|display:\s*grid|row-reverse|order:/);
});

test("普通API仍为8秒超时，apiWith按调用方传入超时", async () => {
  const start = client.indexOf("    async function api(method, sub, body)");
  const end = client.indexOf('    el.backToChat.addEventListener', start);
  const timeouts = []; const requests = [];
  const context = vm.createContext({
    // 这段切片里还有顶层的页面接线（比如设置页自报版本旁边那个重新载入链接），
    // 给个空 document 就行：这条用例只关心超时参数。
    document: { getElementById: () => null },
    window: { location: { reload() {} } },
    AbortSignal: { timeout(ms) { timeouts.push(ms); return { timeoutMs: ms }; } },
    hana: { api: { async fetch(path, init) {
      requests.push([path, plain(init)]);
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    } } },
  });
  vm.runInContext(client.slice(start, end), context);
  await vm.runInContext('api("GET", "video/status")', context);
  await vm.runInContext('apiWith("POST", "video/qrcode/start", {}, 12000)', context);
  await vm.runInContext('apiWith("POST", "video/qrcode/poll", {id:"test-qr"}, 30000)', context);
  assert.deepEqual(timeouts, [8000, 12000, 30000]);
  assert.equal(requests[0][0], "video/status");
  assert.deepEqual(requests[0][1], { method: "GET", signal: { timeoutMs: 8000 } });
  assert.equal(requests[2][1].body, '{"id":"test-qr"}');
});

const sharingCode = client.slice(client.indexOf("    function paintVideoSharing()"), client.indexOf("    function paintGlobalChoices()"));
function sharingHarness(api, draft = null) {
  const nodes = Object.fromEntries(["video-share-partners", "video-share-options", "video-share-save", "video-share-status"].map((id) => [id, element()]));
  const status = element(); status.dataset.videoPartnerId = "yes";
  const rows = [{ id: "yes", name: "参与者", settings: { videoSharingEnabled: true, other: "keep" } },
    { id: "unset", name: "未设置", settings: {} }, { id: "string", name: "非布尔", settings: { videoSharingEnabled: "true" } }];
  const context = vm.createContext({ api, partners: rows, globalSettings: { videoShareMaxPerDay: 2 },
    videoShareDraft: draft, videoShareSaving: false, videoShareNotice: "", globalSaveChain: Promise.resolve(), say() {},
    VIDEO_SHARE_CHOICES: plain(vm.runInNewContext(client.match(/const VIDEO_SHARE_CHOICES = (\[.*\]);/)[1])),
    document: { createElement: element, getElementById: (id) => nodes[id], querySelectorAll: (selector) => selector === "[data-video-partner-id]" ? [status] : nodes["video-share-options"].children },
  });
  const choices = client.slice(client.indexOf("    function choiceGroup("), client.indexOf("    function paintGlobal()"));
  vm.runInContext(choices + sharingCode, context);
  const run = (code) => vm.runInContext(code, context);
  run("paintVideoSharing()");
  return { nodes, context, rows, status, run, save: () => nodes["video-share-save"].click(),
    pickLimit(n) { nodes["video-share-options"].children[n].click(); },
    pickPartner(n) { nodes["video-share-partners"].children[n].click(); } };
}

function loadSharing(h, nextRows = h.run("partners")) {
  // 执行真实GET设置回填片段（包含可见集合替换），不调用任何网络或模型。
  const start = client.indexOf("      const previousVisibleIds", client.indexOf("    async function reloadSettings()"));
  const end = client.indexOf("      if (currentId", start);
  h.context.reloadData = { partners: nextRows, global: h.run("globalSettings") };
  h.run("{ const data = reloadData;\n" + client.slice(start, end) + "\n}");
  h.run("paintVideoSharing()");
}

test("初始加载前保存与选项禁用，GET伙伴严格true参与，不读取隐藏伙伴", () => {
  const h = sharingHarness(async () => assert.fail("不得保存"));
  assert.equal(h.nodes["video-share-save"].disabled, true);
  assert.ok(h.nodes["video-share-options"].children.every((b) => b.disabled));
  assert.ok(h.nodes["video-share-partners"].children.every((b) => b.disabled));
  h.pickLimit(5); h.pickPartner(1); h.save();
  assert.equal(h.run("videoShareDraft"), null);
  loadSharing(h);
  assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 2, partnerIds: ["yes"] });
  assert.equal(h.nodes["video-share-save"].disabled, false);
  assert.deepEqual(h.nodes["video-share-partners"].children.map((b) => b.attrs["aria-pressed"]), ["true", "false", "false"]);
  assert.doesNotMatch(sharingCode, /hiddenPartners|listAgents|localStorage|sessionStorage|savePartner|saveGlobal\(/);
  assert.match(html, /id="video-share-save"[^>]*disabled/);
});

test("六档与多选仅改共同草稿，暂停保留名单，重画及重新加载不覆盖草稿", () => {
  const h = sharingHarness(async () => assert.fail("选择不得发请求")); loadSharing(h);
  h.pickPartner(1); h.pickPartner(0);
  for (let n = 0; n <= 5; n++) { h.pickLimit(n); assert.equal(h.run("videoShareDraft.maxPerDay"), n); }
  h.pickLimit(0);
  h.run("globalSettings.videoShareMaxPerDay = 5; paintVideoSharing()"); loadSharing(h);
  assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 0, partnerIds: ["unset"] });
  assert.match(h.nodes["video-share-status"].textContent, /全部暂停，参与名单保留.*尚未保存/);
  assert.match(html, /主动联系总闸关闭时不会自动分享/);
  assert.match(html, /选择参与不保证每日必发/);
  const globalChoices = client.slice(client.indexOf("    function paintGlobalChoices()"), client.indexOf("    // 扫码登录局部状态"));
  assert.match(globalChoices, /paintVideoSharing\(\)/);
  assert.doesNotMatch(globalChoices, /videoShareMaxPerDay|video-share-options/);
});

test("明确保存一次原子PUT，保存中锁定相关选择并去重，回显更新全局及伙伴同一字段", async () => {
  const calls = []; let release;
  const h = sharingHarness(async (...args) => { calls.push(plain(args)); return new Promise((r) => { release = r; }); }); loadSharing(h);
  h.pickPartner(1); h.pickLimit(4);
  const pending = h.save();
  assert.equal(h.nodes["video-share-save"].disabled, true);
  assert.equal(h.nodes["video-share-save"].textContent, "正在保存…");
  assert.ok([...h.nodes["video-share-options"].children, ...h.nodes["video-share-partners"].children].every((b) => b.disabled));
  h.pickPartner(0); h.pickLimit(0); await h.save();
  assert.deepEqual(calls, [["PUT", "settings/video-sharing", { maxPerDay: 4, partnerIds: ["yes", "unset"] }]]);
  release({ ok: true, global: { videoShareMaxPerDay: 3, other: "server" }, partners: [
    { id: "yes", videoSharingEnabled: false }, { id: "unset", videoSharingEnabled: true }, { id: "string", videoSharingEnabled: false },
  ] }); await pending;
  assert.deepEqual(plain(h.run("globalSettings")), { videoShareMaxPerDay: 3, other: "server" });
  assert.deepEqual(h.rows.map((p) => p.settings.videoSharingEnabled), [false, true, false]);
  assert.equal(h.rows[0].settings.other, "keep");
  assert.equal(h.status.textContent, "不参与B站分享");
  assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 3, partnerIds: ["unset"] });
  assert.equal(h.nodes["video-share-save"].disabled, false);
  assert.match(h.nodes["video-share-status"].textContent, /已保存/);
});

test("失败保留名单与次数草稿和保存入口，不刷新覆盖，不泄露原错，重试同一payload", async () => {
  const calls = [];
  const h = sharingHarness(async (...args) => { calls.push(plain(args)); throw new Error("private-token-url"); }); loadSharing(h);
  h.pickPartner(1); h.pickLimit(0);
  await h.save();
  assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 0, partnerIds: ["yes", "unset"] });
  assert.equal(h.run("globalSettings.videoShareMaxPerDay"), 2);
  assert.equal(h.nodes["video-share-save"].disabled, false);
  assert.ok(h.nodes["video-share-options"].children.every((b) => !b.disabled));
  assert.match(h.nodes["video-share-status"].textContent, /全部暂停，参与名单保留.*没存上.*草稿已保留/);
  assert.doesNotMatch(h.nodes["video-share-status"].textContent, /private-token-url/);
  await h.save(); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.doesNotMatch(sharingCode, /reloadSettings\(|refreshVideoStatus\(/);
});

test("B站保存等待已有全局保存，后续全局保存等待B站，提交只包含当前可见伙伴", async () => {
  const calls = []; let release;
  const h = sharingHarness(async (...args) => { calls.push(plain(args)); return { ok: true, global: { videoShareMaxPerDay: 1 }, partners: [
    { id: "yes", videoSharingEnabled: true }, { id: "unset", videoSharingEnabled: false }, { id: "string", videoSharingEnabled: false },
  ] }; }, { maxPerDay: 1, partnerIds: ["yes", "hidden-id"] });
  h.context.prior = new Promise((r) => { release = r; }); h.run("globalSaveChain = prior");
  const pending = h.save(); await Promise.resolve(); assert.equal(calls.length, 0);
  const order = []; h.context.after = () => order.push("after"); h.run("globalSaveChain.then(after)");
  release(); await pending; await Promise.resolve();
  assert.deepEqual(calls[0][2], { maxPerDay: 1, partnerIds: ["yes"] }); assert.deepEqual(order, ["after"]);
});

test("reload合并新可见伙伴服务端true，旧伙伴未保存选择与次数不被覆盖，恢复后可再次初始化", async () => {
  const calls = [];
  const h = sharingHarness(async (...args) => {
    calls.push(plain(args));
    return { ok: true, global: { videoShareMaxPerDay: args[2].maxPerDay }, partners: h.run("partners").map((p) => ({ id: p.id, videoSharingEnabled: args[2].partnerIds.includes(p.id) })) };
  });
  loadSharing(h); h.pickPartner(0); h.pickPartner(1); h.pickLimit(4);
  const next = [...plain(h.rows),
    { id: "restored", name: "恢复伙伴", settings: { videoSharingEnabled: true } },
    { id: "new-unset", settings: {} }, { id: "new-string", settings: { videoSharingEnabled: "true" } },
  ];
  loadSharing(h, next);
  assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 4, partnerIds: ["unset", "restored"] });
  assert.equal(h.nodes["video-share-partners"].children[3].attrs["aria-pressed"], "true");
  // 用户取消新伙伴后再次加载，仍须保留该取消，而非重新按服务端true选中。
  h.pickPartner(3); loadSharing(h, plain(next));
  assert.deepEqual(plain(h.run("videoShareDraft.partnerIds")), ["unset"]);
  loadSharing(h, next.filter((p) => p.id !== "restored"));
  loadSharing(h, plain(next));
  assert.deepEqual(plain(h.run("videoShareDraft.partnerIds")), ["unset", "restored"]);
  await h.save();
  assert.deepEqual(calls[0][2], { maxPerDay: 4, partnerIds: ["unset", "restored"] });
});

test("非B站伙伴设置慢回包保留集中保存的新参与字段，返回值同样不含旧参与状态", async () => {
  for (const [before, after] of [[true, false], [false, true], [undefined, false]]) {
    let release; const calls = [];
    const h = sharingHarness(async (method, path, body) => {
      calls.push([method, path, plain(body)]);
      if (path.startsWith("settings/partner/")) return new Promise((resolve) => { release = resolve; });
      return { ok: true, global: { videoShareMaxPerDay: 1 }, partners: h.rows.map((p) => ({ id: p.id, videoSharingEnabled: p.id === "yes" ? after : false })) };
    });
    if (before === undefined) delete h.rows[0].settings.videoSharingEnabled;
    else h.rows[0].settings.videoSharingEnabled = before;
    loadSharing(h);
    h.context.encodeURIComponent = encodeURIComponent; h.context.holdViewport = () => {};
    const start = client.indexOf("    async function savePartner(");
    h.run(client.slice(start, client.indexOf("    function detailCard(", start)));
    const slow = h.run('savePartner("yes", {tier:"often"})');
    await h.save();
    assert.equal(h.rows[0].settings.videoSharingEnabled, after);
    release({ ok: true, settings: { tier: "often", videoSharingEnabled: before } });
    const result = await slow;
    assert.equal(h.rows[0].settings.videoSharingEnabled, after);
    assert.equal(result.videoSharingEnabled, after);
    assert.equal(result.tier, "often");
    assert.equal(calls.length, 2);
    assert.equal(h.status.textContent, after ? "参与B站分享" : "不参与B站分享");
  }
});

test("不完整或非法集中保存回包不污染任何已保存状态，保留草稿与重试入口", async () => {
  const valid = { ok: true, global: { videoShareMaxPerDay: 1 }, partners: [
    { id: "yes", videoSharingEnabled: false }, { id: "unset", videoSharingEnabled: true }, { id: "string", videoSharingEnabled: false },
  ] };
  const replies = [null, {}, { ...valid, global: null }, ...[-1, 6, 1.5, "2", undefined].map((limit) => ({ ...valid, global: { videoShareMaxPerDay: limit } })),
    ...[undefined, {}, [], [valid.partners[0]], [...valid.partners.slice(0, 2), { id: "string", videoSharingEnabled: "false" }],
      [...valid.partners.slice(0, 2), { id: "string" }], [{ id: "yes", videoSharingEnabled: null }, ...valid.partners]].map((rows) => ({ ...valid, partners: rows })),
  ];
  for (const reply of replies) {
    const h = sharingHarness(async () => reply); loadSharing(h);
    h.pickPartner(1); h.pickLimit(5);
    const priorRows = plain(h.rows); const priorGlobal = plain(h.run("globalSettings")); const draft = plain(h.run("videoShareDraft"));
    const priorStatus = h.status.textContent;
    await h.save();
    assert.deepEqual(plain(h.rows), priorRows);
    assert.deepEqual(plain(h.run("globalSettings")), priorGlobal);
    assert.deepEqual(plain(h.run("videoShareDraft")), draft);
    assert.equal(h.status.textContent, priorStatus);
    assert.equal(h.nodes["video-share-save"].disabled, false);
    assert.match(h.nodes["video-share-status"].textContent, /没存上.*草稿已保留/);
  }
});

test("reload的慢旧GET与集中保存共用队列，两个调用顺序都不会回退全局或伙伴只读状态", async () => {
  for (const first of ["reload", "save"]) {
    const calls = []; const putBodies = []; let releaseGet; let releasePut; let server;
    const h = sharingHarness(async (method, path, body) => {
      calls.push([method, path]);
      if (method === "GET") {
        const snapshot = plain(server);
        if (first === "reload") await new Promise((resolve) => { releaseGet = resolve; });
        return snapshot;
      }
      putBodies.push(plain(body));
      if (first === "save") await new Promise((resolve) => { releasePut = resolve; });
      server = { global: { videoShareMaxPerDay: body.maxPerDay }, partners: server.partners.map((p) => ({
        ...p, settings: { ...p.settings, videoSharingEnabled: body.partnerIds.includes(p.id) },
      })) };
      return { ok: true, global: server.global, partners: server.partners.map((p) => ({ id: p.id, videoSharingEnabled: p.settings.videoSharingEnabled })) };
    });
    loadSharing(h); h.pickPartner(0); h.pickPartner(1); h.pickLimit(4);
    server = { global: plain(h.run("globalSettings")), partners: plain(h.run("partners")) };
    if (first === "reload") server.partners.push({ id: "restored", name: "恢复伙伴", settings: { videoSharingEnabled: true } });
    h.context.currentId = "yes";
    h.context.paintGlobal = () => h.run("paintVideoSharing()");
    h.context.paintPartnerList = () => {};
    // reloadSettings 末尾会重写「ta 那侧戴着 xx」那句话。这张测试只验队列顺序，
    // 给个不做事的桩；那句话的渲染在 bubble-skins.test.js 里验。
    h.context.paintPartnerSkinNote = () => {};
    h.context.openPartner = async () => {
      h.status.textContent = h.run('partners.find((p) => p.id === "yes").settings.videoSharingEnabled') === true ? "参与B站分享" : "不参与B站分享";
    };
    const start = client.indexOf("    async function reloadSettings()");
    h.run(client.slice(start, client.indexOf("    async function boot()", start)));
    let reloaded; let saved;
    if (first === "reload") {
      reloaded = h.run("reloadSettings()");
      await Promise.resolve();
      assert.equal(typeof releaseGet, "function", "旧GET已取得快照并正在等待回包");
      saved = h.save();
      await Promise.resolve();
      assert.deepEqual(calls, [["GET", "settings"]], "旧GET回填完成之前不发PUT");
      releaseGet();
    } else {
      saved = h.save();
      await Promise.resolve();
      assert.equal(typeof releasePut, "function");
      reloaded = h.run("reloadSettings()");
      await Promise.resolve();
      assert.deepEqual(calls, [["PUT", "settings/video-sharing"]], "PUT完成前不提前发GET取得旧快照");
      releasePut();
    }
    await Promise.all([reloaded, saved]);
    assert.deepEqual(calls.map(([method]) => method), first === "reload" ? ["GET", "PUT"] : ["PUT", "GET"]);
    assert.equal(h.run("globalSettings.videoShareMaxPerDay"), 4);
    assert.equal(h.run('partners.find((p) => p.id === "yes").settings.videoSharingEnabled'), false);
    assert.equal(h.status.textContent, "不参与B站分享");
    const expectedIds = first === "reload" ? ["unset", "restored"] : ["unset"];
    assert.deepEqual(putBodies, [{ maxPerDay: 4, partnerIds: expectedIds }], "PUT使用前序GET合并后的草稿，同时保留旧伙伴的勾选和取消");
    assert.equal(h.run('partners.find((p) => p.id === "unset").settings.videoSharingEnabled'), true);
    if (first === "reload") assert.equal(h.run('partners.find((p) => p.id === "restored").settings.videoSharingEnabled'), true);
    assert.deepEqual(plain(h.run("videoShareDraft")), { maxPerDay: 4, partnerIds: expectedIds });
  }
});

test("GET登录状态分开显示有效、过期、未知、未登录与网络失败", async () => {
  for (const [status, hasLogin, storage, expected] of [
    ["loggedIn", true, "memory", /已登录.*本次运行/], ["loggedIn", true, "encrypted", /Windows系统加密保存在本机/],
    ["loggedIn", true, "local", /已加密保存在本机，下次打开不用重扫/],
    ["expired", false, "none", /凭据已过期/],
    ["unknown", false, "memory", /当前凭据仅本次运行保留/], ["unknown", false, "encrypted", /已加密保存的凭据会保留/],
    ["unknown", false, "local", /保存在本机的凭据会保留/],
    ["none", false, "none", /尚未登录/],
  ]) {
    const h = harness(async (method, path) => { assert.deepEqual([method, path], ["GET", "video/status"]); return { ok: true, status, hasLogin, storage }; });
    await h.run("refreshVideoStatus()"); assert.match(h.nodes["video-login-status"].textContent, expected);
  }
  const h = harness(async () => { throw new Error("private-token-url"); });
  await h.run("refreshVideoStatus()");
  assert.match(h.nodes["video-login-status"].textContent, /读取失败/);
  assert.doesNotMatch(h.nodes["video-login-status"].textContent, /过期|尚未登录|private-token-url/);
});

test("本地SVG展示，2秒串行轮询等待与已扫状态，成功停止并释放图片", async () => {
  const calls = []; const statuses = [
    { status: "waiting", hasLogin: false, storage: "none" },
    { status: "scanned", hasLogin: false, storage: "none" },
    { status: "loggedIn", hasLogin: true, storage: "encrypted" },
  ];
  const h = harness(async (...args) => { calls.push(plain(args)); return args[1].endsWith("start") ? qr() : { ok: true, ...statuses.shift() }; });
  await h.start(); assert.deepEqual(calls[0], ["POST", "video/qrcode/start", {}, 12000]);
  assert.equal(h.nodes["video-qrcode"].src, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr().svg)}`); assert.equal(h.timers.size, 1);
  assert.equal(h.countdowns.size, 1); assert.equal(h.nodes["video-qrcode-countdown"].hidden, false);
  assert.equal(h.nodes["video-qrcode-countdown"].textContent, "二维码剩余有效期：01:30");
  await h.tick(); assert.match(h.nodes["video-login-status"].textContent, /等待扫码/);
  await h.tick(); assert.match(h.nodes["video-login-status"].textContent, /已扫码/);
  await h.tickCountdown(); assert.equal(h.nodes["video-qrcode-countdown"].textContent, "二维码剩余有效期：01:25");
  await h.tick(); assert.match(h.nodes["video-login-status"].textContent, /已登录.*Windows系统加密保存在本机/);
  assert.equal(h.timers.size, 0); assert.equal(h.countdowns.size, 0); assert.equal(h.nodes["video-qrcode"].hidden, true);
  for (const call of calls.slice(1)) assert.deepEqual(call, ["POST", "video/qrcode/poll", { id: "test-qr" }, 30000]);
  assert.equal(h.nodes["video-qrcode"].src, undefined);
});

test("倒计时逐秒递减，二维码到期时清理倒计时、轮询和图片", async () => {
  const h = harness(async (method, path) => path.endsWith("start") ? qr() : { ok: true, status: "waiting" });
  await h.start();
  assert.equal(h.nodes["video-qrcode-countdown"].textContent, "二维码剩余有效期：01:30");
  await h.tickCountdown();
  assert.equal(h.nodes["video-qrcode-countdown"].textContent, "二维码剩余有效期：01:29");
  assert.equal(h.countdowns.size, 1);
  h.expire(); await h.tickCountdown();
  assert.match(h.nodes["video-login-status"].textContent, /二维码已过期/);
  assert.equal(h.nodes["video-qrcode"].hidden, true);
  assert.equal(h.nodes["video-qrcode"].src, undefined);
  assert.equal(h.nodes["video-qrcode-countdown"].hidden, true);
  assert.equal(h.nodes["video-qrcode-countdown"].textContent, "");
  assert.equal(h.timers.size, 0); assert.equal(h.countdowns.size, 0);
});

test("二维码显示后离页或隐藏会清理倒计时与轮询", async () => {
  for (const event of ["pagehide", "visibilitychange", "stopVideoQr"]) {
    const h = harness(async (method, path) => path.endsWith("start") ? qr() : { ok: true, status: "waiting" });
    await h.start();
    assert.equal(h.timers.size, 1); assert.equal(h.countdowns.size, 1);
    if (event === "visibilitychange") { h.doc.hidden = true; h.events[event](); }
    else if (event === "pagehide") h.events[event](); else h.run("stopVideoQr()");
    assert.equal(h.timers.size, 0); assert.equal(h.countdowns.size, 0);
    assert.equal(h.nodes["video-qrcode"].hidden, true);
    assert.equal(h.nodes["video-qrcode-countdown"].hidden, true);
  }
});

test("慢轮询不重叠，按钮外观稳定，期间点击刷新也不并发", async () => {
  let release; let calls = 0;
  const h = harness(async (method, path) => { calls++; return path.endsWith("start") ? qr() : new Promise((r) => { release = r; }); });
  await h.start(); const pending = h.tick();
  assert.equal(h.timers.size, 0);
  assert.equal(h.nodes["video-qrcode-refresh"].disabled, false);
  assert.equal(h.nodes["video-login-button"].disabled, false);
  await h.refresh(); assert.equal(calls, 2);
  release({ ok: true, status: "waiting" }); await pending; assert.equal(h.timers.size, 1);
});

test("服务端或本地过期停止；刷新换id且清理旧定时器", async () => {
  let id = 0; const calls = [];
  const h = harness(async (method, path, body) => { calls.push([path, plain(body)]); return path.endsWith("start") ? qr(`qr-${++id}`) : { ok: true, status: "expired" }; });
  await h.start(); await h.refresh(); assert.equal(h.timers.size, 1); assert.equal(h.countdowns.size, 1);
  await h.tick(); assert.deepEqual(calls.at(-1), ["video/qrcode/poll", { id: "qr-2" }]);
  assert.equal(h.timers.size, 0); assert.equal(h.countdowns.size, 0); assert.match(h.nodes["video-login-status"].textContent, /二维码已过期/);
  await h.refresh(); h.expire(); await h.tick(); assert.equal(calls.length, 4); assert.equal(h.timers.size, 0); assert.equal(h.countdowns.size, 0);
});

test("网络错误与异常回包不显示原错、不冒充过期，并允许重试", async () => {
  let fail = false;
  const h = harness(async (method, path) => { if (fail) throw new Error("private-token-url"); return path.endsWith("start") ? qr() : { ok: false, error: { message: "private-token-url" } }; });
  await h.start(); await h.tick();
  assert.match(h.nodes["video-login-status"].textContent, /读取失败/);
  assert.doesNotMatch(h.nodes["video-login-status"].textContent, /过期|private-token-url/);
  assert.equal(h.timers.size, 0); fail = true; await h.refresh();
  assert.match(h.nodes["video-login-status"].textContent, /生成失败/); assert.equal(h.nodes["video-login-button"].disabled, false);
});

for (const message of [
  "连接B站二维码接口失败，请检查网络权限或连接。",
  "B站二维码接口拒绝了请求，请稍后重试。",
  "B站返回的二维码格式暂不兼容。",
  "本地二维码编码失败。",
]) {
  test(`start受控失败精确显示：${message}`, async () => {
    let fail = true;
    const h = harness(async () => {
      if (fail) throw new Error(message);
      return qr();
    });
    await h.start();
    assert.equal(h.nodes["video-login-status"].textContent, message);
    assert.equal(h.timers.size, 0);
    assert.equal(h.nodes["video-qrcode"].src, undefined);
    assert.equal(h.nodes["video-qrcode"].hidden, true);
    assert.equal(h.nodes["video-login-button"].disabled, false);
    assert.equal(h.nodes["video-qrcode-refresh"].disabled, false);
    assert.doesNotMatch(h.nodes["video-login-status"].textContent, /过期|已登录/);
    fail = false;
    await h.refresh();
    assert.equal(h.timers.size, 1);
    assert.match(h.nodes["video-login-status"].textContent, /等待扫码/);
  });
}

test("start原始私密异常和白名单近似文案仍泛化，不泄漏异常", async () => {
  const privateText = "SESSDATA=private-token; https://passport.biligame.com/crossDomain?ticket=private-ticket";
  const controlled = [
    "连接B站二维码接口失败，请检查网络权限或连接。",
    "B站二维码接口拒绝了请求，请稍后重试。",
    "B站返回的二维码格式暂不兼容。",
    "本地二维码编码失败。",
  ];
  const messages = [privateText, "请求超时", "未能取得有效登录凭据，请重新扫码",
    ...controlled.flatMap((message) => [` ${message}`, `${message} ${privateText}`, message.slice(0, -1)])];
  for (const error of [...messages.map((message) => new Error(message)), null, privateText]) {
    const h = harness(async () => { throw error; });
    await h.start();
    assert.equal(h.nodes["video-login-status"].textContent, "二维码暂时生成失败，请检查连接后重试。");
    assert.doesNotMatch(h.nodes["video-login-status"].textContent, /SESSDATA|private-|ticket|https:|过期|已登录/);
    assert.equal(h.timers.size, 0);
    assert.equal(h.nodes["video-qrcode"].src, undefined);
    assert.equal(h.nodes["video-login-button"].disabled, false);
  }
});

test("仅精确受控凭据错误显示中性诊断提示，停止轮询且可刷新重试", async () => {
  const controlled = "未能取得有效登录凭据，请重新扫码";
  const expected = "扫码已确认，但未取得可用登录凭据，尚未登录成功。请先查看诊断结果，不必连续扫码。";
  const h = harness(async (method, path) => {
    if (path.endsWith("start")) return qr();
    throw new Error(controlled);
  });
  await h.start(); await h.tick();
  assert.equal(h.nodes["video-login-status"].textContent, expected);
  assert.doesNotMatch(h.nodes["video-login-status"].textContent, /宿主|Hana未能/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.nodes["video-qrcode"].src, undefined);
  assert.equal(h.nodes["video-qrcode"].hidden, true);
  assert.equal(h.nodes["video-qrcode-refresh"].hidden, false);
  assert.equal(h.nodes["video-qrcode-refresh"].disabled, false);
  assert.equal(h.nodes["video-login-button"].disabled, false);
  assert.doesNotMatch(h.nodes["video-login-status"].textContent, /过期|^已登录/);
  await h.refresh();
  assert.equal(h.timers.size, 1);
  assert.equal(h.nodes["video-qrcode"].hidden, false);
  assert.match(h.nodes["video-login-status"].textContent, /等待扫码/);
});

test("私密原始异常、相似错误与未映射失败回包都只显示泛化提示", async () => {
  const controlled = "未能取得有效登录凭据，请重新扫码";
  const privateText = "SESSDATA=private-token; https://passport.biligame.com/crossDomain?ticket=private-ticket";
  for (const message of [privateText, `${controlled}: ${privateText}`, ` ${controlled}`, `${controlled}。`, "请求超时"]) {
    const h = harness(async (method, path) => {
      if (path.endsWith("start")) return qr();
      throw new Error(message);
    });
    await h.start(); await h.tick();
    assert.equal(h.nodes["video-login-status"].textContent, "扫码状态读取失败，请检查连接后刷新二维码重试。");
    assert.doesNotMatch(h.nodes["video-login-status"].textContent, /SESSDATA|private-|ticket|https:|过期|扫码已确认|^已登录/);
    assert.equal(h.timers.size, 0);
    assert.equal(h.nodes["video-qrcode-refresh"].disabled, false);
  }
  const h = harness(async (method, path) => path.endsWith("start") ? qr() : { ok: false, error: { message: controlled } });
  await h.start(); await h.tick();
  assert.equal(h.nodes["video-login-status"].textContent, "扫码状态读取失败，请检查连接后刷新二维码重试。");
});

test("拒绝带脚本、外链SVG或无效到期时间，不加载外部二维码资源", async () => {
  for (const changed of [{ svg: '<svg><script>alert(1)</script></svg>' }, { svg: '<svg><image href="https://invalid.test/qr"/></svg>' }, { expiresAt: "invalid" }]) {
    const h = harness(async () => ({ ...qr(), ...changed })); await h.start();
    assert.equal(h.nodes["video-qrcode"].src, undefined); assert.equal(h.timers.size, 0);
    assert.match(h.nodes["video-login-status"].textContent, /生成失败/);
  }
});

test("离开页面或隐藏立即停止；旧在途回包不能恢复二维码或轮询", async () => {
  for (const event of ["pagehide", "visibilitychange", "stopVideoQr"]) {
    let release;
    const h = harness(async () => new Promise((r) => { release = r; }));
    const pending = h.start();
    if (event === "visibilitychange") { h.doc.hidden = true; h.events[event](); }
    else if (event === "pagehide") h.events[event](); else h.run("stopVideoQr()");
    release(qr()); await pending; assert.equal(h.timers.size, 0); assert.equal(h.nodes["video-qrcode"].src, undefined);
  }
  assert.match(client, /function setTab\(name\) \{\s*if \(name !== "proactive"\) stopVideoQr\(\)/);
  assert.match(client, /el.backToChat.addEventListener\("click", \(\) => \{\s*stopVideoQr\(\)/);
});

test("离开时的慢轮询终态不回写新界面", async () => {
  let release;
  const h = harness(async (method, path) => path.endsWith("start") ? qr() : new Promise((r) => { release = r; }));
  await h.start(); const pending = h.tick(); h.doc.hidden = true; h.events.visibilitychange();
  release({ ok: true, status: "loggedIn" }); await pending;
  assert.match(h.nodes["video-login-status"].textContent, /已暂停/); assert.equal(h.timers.size, 0);
});

test("伙伴页仅显示已保存参与状态，严格true，入口切到主设置卡片且不另行PUT", () => {
  for (const value of [undefined, false, "true", 1, true]) {
    const created = []; const tabs = []; let paints = 0;
    const card = element(); const save = element();
    const context = vm.createContext({ document: {
      createElement() { const node = element(); created.push(node); return node; },
      getElementById(id) { assert.ok(["video-share-card", "video-share-save"].includes(id)); return id === "video-share-card" ? card : save; },
    }, field(label, status) { const row = element(); row.appendChild(status); row.labelText = label; return row; },
    setTab: (name) => tabs.push(name), paintVideoSharing() { paints++; }, settings: { videoSharingEnabled: value } });
    vm.runInContext(partnerCode, context);
    const row = vm.runInContext('partnerVideoField("existing-partner", settings)', context);
    assert.equal(created[0].textContent, value === true ? "参与B站分享" : "不参与B站分享");
    assert.equal(created[0].dataset.videoPartnerId, "existing-partner");
    assert.equal(created[0].attrs.role, "status");
    assert.equal(row.children.length, 2);
    created[1].click();
    assert.deepEqual(tabs, ["proactive"]); assert.equal(paints, 1); assert.equal(card.scrolled, true); assert.equal(save.focused, true);
  }
  assert.doesNotMatch(partnerCode, /savePartner|saveGlobal|api\(|aria-checked|role", "switch|!== false/);
  assert.match(client, /contactCard.appendChild\(partnerVideoField\(agentId, s\)\)/);
});
