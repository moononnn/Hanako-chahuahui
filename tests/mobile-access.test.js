import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MOBILE_PORT,
  MIN_PASSWORD_LENGTH,
  createMobileAccess,
  generateMobilePassword,
  getMobileAccess,
  isValidMobilePort,
  localAddresses,
  readMobileConfig,
  snapshotSignature,
  writeMobileConfig,
} from "../lib/mobile-access.js";

/**
 * 这一组只验管理层自己的行为：配置、密码、启停、探测。
 * 网关进程一律用假货（createGateway 注入），所以不 spawn、不开端口、不碰真账本。
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-mobile-access-"));
}

/** 假网关：记下创建参数、push 过什么、被 dispose 过几次。 */
function createFakeGateways() {
  const created = [];
  const factory = (options) => {
    const instance = {
      options,
      pushes: [],
      states: [],
      starts: 0,
      disposes: 0,
      push(event) {
        instance.pushes.push(event);
        return true;
      },
      start() {
        instance.starts += 1;
        options.onState({ running: true, port: options.port, pid: 4000 + created.length });
        return true;
      },
      async dispose() {
        instance.disposes += 1;
        options.onState({ running: false, reason: "disposed" });
      },
    };
    created.push(instance);
    return instance;
  };
  return { factory, created };
}

/** 假网关：dispose 故意不马上结束，模拟它在等 shutdown/kill 后 exit（最多 3 秒）。 */
function createDeferredGateways() {
  const created = [];
  const releases = [];
  const factory = (options) => {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    releases.push(release);
    const instance = {
      options,
      starts: 0,
      disposes: 0,
      push: () => true,
      start() {
        instance.starts += 1;
        options.onState({ running: true, port: options.port, pid: 5000 + created.length });
        return true;
      },
      async dispose() {
        instance.disposes += 1;
        await gate;
        options.onState({ running: false, reason: "disposed" });
      },
    };
    created.push(instance);
    return instance;
  };
  return { factory, created, releases };
}

function headlessOptions(dir, factory, extra = {}) {
  return {
    dataDir: dir,
    execPath: "node",
    handler: async () => null,
    listPartnerIds: async () => ["nova"],
    threadSnapshot: () => null,
    createGateway: factory,
    probeIntervalMs: 60 * 60 * 1000,
    watchRefreshMs: 60 * 60 * 1000,
    ...extra,
  };
}

function build({ dir = tempDir(), snapshots = () => null, partnerIds = async () => ["nova"], ...rest } = {}) {
  const fake = createFakeGateways();
  const access = createMobileAccess({
    dataDir: dir,
    execPath: "node",
    handler: async (op) => ({ op }),
    listPartnerIds: partnerIds,
    threadSnapshot: snapshots,
    createGateway: fake.factory,
    probeIntervalMs: 1000 * 60 * 60,
    watchRefreshMs: 1000 * 60 * 60,
    ...rest,
  });
  return { dir, access, gateways: fake.created };
}

test("默认关着：没有配置文件就不建网关，也不顺手写一份出来", async () => {
  const { dir, access, gateways } = build();
  const loaded = access.load();
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.configFile.status, "missing");
  assert.equal(loaded.hasPassword, false);

  const applied = await access.apply();
  assert.equal(gateways.length, 0, "默认关着的时候不该 spawn 任何进程");
  assert.equal(applied.running, false);
  assert.equal(applied.reason, "disabled");
  assert.equal(fs.existsSync(path.join(dir, "mobile-gateway.json")), false, "没有显式保存过就不该凭空落盘");
});

test("老配置没有 enabled 字段一律当关着（升级不偷偷把手机口子打开）", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "mobile-gateway.json"), JSON.stringify({ port: 18090, password: "123456" }), "utf8");
  const { access, gateways } = build({ dir });
  const loaded = access.load();
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.port, 18090);
  await access.apply();
  assert.equal(gateways.length, 0);
});

test("配置读坏了：不覆盖原文件，禁用并报出来；显式保存才能恢复", async () => {
  const dir = tempDir();
  const file = path.join(dir, "mobile-gateway.json");
  const broken = "{ 这不是 JSON";
  fs.writeFileSync(file, broken, "utf8");

  const { access, gateways } = build({ dir });
  const loaded = access.load();
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.configFile.status, "corrupt");
  assert.ok(loaded.configFile.error.length > 0, "损坏要带一句能看懂的原因");
  await access.apply();
  assert.equal(gateways.length, 0, "配置读不懂就不该去起进程");
  assert.equal(fs.readFileSync(file, "utf8"), broken, "读坏的时候一个字都不许动原文件");

  // 显式保存是恢复的路：就算开的还是「关」，也该把那份坏文件换掉
  const saved = await access.setConfig({ enabled: false, port: 18100 });
  assert.equal(saved.ok, true);
  assert.equal(saved.configFile.status, "ok");
  assert.equal(saved.port, 18100);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.port, 18100);
  assert.equal(parsed.enabled, false);
});

test("端口非法直接拒绝，配置文件与内存里的那份都不变", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: false, port: 18090, password: "" });
  const { access } = build({ dir });
  access.load();

  for (const port of [0, -1, 65536, 18.5, "abc"]) {
    const result = await access.setConfig({ enabled: false, port });
    assert.equal(result.ok, false, `端口 ${JSON.stringify(port)} 该被拒`);
    assert.match(result.error, /端口/);
  }
  assert.equal(access.status().port, 18090);
  assert.equal(readMobileConfig(dir).config.port, 18090);
  // 输入框清空就当「没改」，不能因为一个空字符串把端口拗成 0
  const blank = await access.setConfig({ enabled: false, port: "" });
  assert.equal(blank.ok, true);
  assert.equal(blank.port, 18090);
  assert.equal(isValidMobilePort("18090"), true, "字符串形式的合法端口还是认的");
  assert.equal(isValidMobilePort(65535), true);
  assert.equal(isValidMobilePort(1), true);
});

test("配置存不下去就不启用：进程一个都不起，内存里也不改成没落盘的值", async () => {
  const dir = tempDir();
  // 拿目录占住配置文件的名字：读是 EISDIR，写（改名覆盖）也必然失败
  fs.mkdirSync(path.join(dir, "mobile-gateway.json"));
  const { access, gateways } = build({ dir });
  const loaded = access.load();
  assert.equal(loaded.configFile.status, "corrupt");

  const result = await access.setConfig({ enabled: true, port: 18090 });
  assert.equal(result.ok, false);
  assert.match(result.error, /没写成|没有生效/);
  assert.equal(gateways.length, 0, "配置没存下来就不该用这份去起网关");
  assert.equal(access.status().enabled, false);
});

test("显式开启时把旧六位密码换掉：长度够、落盘、旧密码不再认", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: false, port: 18090, password: "123456" });
  const { access, gateways } = build({ dir });
  access.load();
  assert.equal(access.status().passwordNeedsUpgrade, true);

  const result = await access.setConfig({ enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.enabled, true);
  assert.equal(result.running, true);
  assert.ok(result.passwordLength >= MIN_PASSWORD_LENGTH, `密码至少 ${MIN_PASSWORD_LENGTH} 位，实际 ${result.passwordLength}`);
  assert.ok(result.notice.includes("旧密码"), "要提示旧登录已失效");

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "mobile-gateway.json"), "utf8"));
  assert.equal(onDisk.enabled, true);
  assert.notEqual(onDisk.password, "123456");
  assert.ok(onDisk.password.length >= MIN_PASSWORD_LENGTH);

  assert.equal(gateways.length, 1);
  assert.equal(gateways[0].options.password, onDisk.password, "网关拿到的是升级后的那份");
  assert.equal(JSON.stringify(access.status()).includes(onDisk.password), false, "状态回包里不许带密码");
});

test("启动幂等：连着 apply 几次也只有一个网关实例", async () => {
  const dir = tempDir();
  const password = generateMobilePassword();
  writeMobileConfig(dir, { enabled: true, port: 18090, password });
  const { access, gateways } = build({ dir });
  access.load();
  await access.apply();
  await access.apply();
  await access.apply();
  assert.equal(gateways.length, 1);
  assert.equal(gateways[0].starts, 1);
  assert.equal(access.status().running, true);
});

test("改端口要换实例：旧的那个先收干净，新的按新端口起", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  const { access, gateways } = build({ dir });
  access.load();
  await access.apply();
  assert.equal(gateways.length, 1);

  const result = await access.setConfig({ enabled: true, port: 18123 });
  assert.equal(result.ok, true);
  assert.equal(result.port, 18123);
  assert.equal(gateways.length, 2);
  assert.equal(gateways[0].disposes, 1, "旧实例必须 dispose，不能两个一起占端口");
  assert.equal(gateways[1].options.port, 18123);
  assert.equal(access.status().running, true);
});

test("停用：断开网关、停掉探测，之后账本再变也不再推", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  let snapshot = { tail: [{ id: "m1" }] };
  const { access, gateways } = build({
    dir,
    snapshots: () => snapshot,
    probeIntervalMs: 10,
    watchRefreshMs: 60 * 60 * 1000,
  });
  access.load();
  await access.apply();
  await access.refreshWatched();
  access.probeOnce();
  snapshot = { tail: [{ id: "m2" }] };
  access.probeOnce();
  assert.equal(gateways[0].pushes.length, 1);

  const stopped = await access.setConfig({ enabled: false });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.reason, "disabled");
  assert.equal(gateways[0].disposes, 1);

  snapshot = { tail: [{ id: "m3" }] };
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(gateways[0].pushes.length, 1, "停掉之后探测定时器不该还在跑");
  assert.equal(gateways.length, 1);
});

test("内容指纹：改稿、撤回、语音状态、已读、设置变了都要推一次；没变不推", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  let snapshot = {
    thread: { updatedAt: "t1", total: 1, tail: [{ id: "m1", textHash: "a", recalled: false, voice: "pending", readAt: "" }] },
    skin: { meSkin: "plain", showAvatars: false },
  };
  const { access, gateways } = build({ dir, snapshots: () => snapshot });
  access.load();
  await access.apply();
  await access.refreshWatched();
  access.probeOnce(); // 打底

  const bump = () => {
    access.probeOnce();
    return gateways[0].pushes.length;
  };

  assert.equal(bump(), 0, "什么都没变不该推");
  assert.equal(bump(), 0, "连着问两次也不该推");

  snapshot = { thread: { updatedAt: "t2", total: 1, tail: [{ id: "m1", textHash: "b", recalled: false, voice: "pending", readAt: "" }] }, skin: { meSkin: "plain", showAvatars: false } };
  assert.equal(bump(), 1, "改稿要推（id 没变）");

  snapshot = { ...snapshot, thread: { ...snapshot.thread, tail: [{ id: "m1", textHash: "b", recalled: true, voice: "pending", readAt: "" }] } };
  assert.equal(bump(), 2, "撤回要推");

  snapshot = { ...snapshot, thread: { ...snapshot.thread, tail: [{ id: "m1", textHash: "b", recalled: true, voice: "ready", readAt: "" }] } };
  assert.equal(bump(), 3, "语音从「在说」变「能听」要推");

  snapshot = { ...snapshot, thread: { ...snapshot.thread, tail: [{ id: "m1", textHash: "b", recalled: true, voice: "ready", readAt: "2026-10-30T08:00:00.000Z" }] } };
  assert.equal(bump(), 4, "已读状态变了要推");

  snapshot = { ...snapshot, thread: { ...snapshot.thread, total: 0, tail: [] } };
  assert.equal(bump(), 5, "消息被删要推");

  snapshot = { ...snapshot, skin: { meSkin: "plain", showAvatars: true } };
  assert.equal(bump(), 6, "显示设置变了要推");
  assert.equal(gateways[0].pushes.at(-1).type, "threads");
});

test("同一个 dataDir 重新建一次：旧实例先收干净，不会有两条探测", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  const first = build({ dir });
  first.access.load();
  await first.access.apply();
  assert.equal(first.gateways.length, 1);

  const second = build({ dir });
  second.access.load();
  await second.access.apply();
  assert.equal(first.gateways[0].disposes, 1, "旧的必须被 dispose");
  assert.equal(second.gateways.length, 1);
  assert.equal(getMobileAccess(dir), second.access);
});

test("重新 apply 同一个 dataDir：旧网关没退干净之前，新实例不许抢同一个端口", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });

  const old = createDeferredGateways();
  const first = createMobileAccess(headlessOptions(dir, old.factory));
  first.load();
  await first.apply();
  assert.equal(old.created.length, 1);

  const fresh = createDeferredGateways();
  const second = createMobileAccess(headlessOptions(dir, fresh.factory));
  second.load();
  const applying = second.apply();

  // 旧实例的 dispose 还没结束（在等进程退出）：新的一个都不许建
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fresh.created.length, 0, "旧进程还没退就 spawn，会抢同一个端口");
  assert.equal(old.created[0].disposes, 1, "旧实例应该已经在收尾了");

  old.releases.forEach((release) => release());
  const applied = await applying;
  assert.equal(fresh.created.length, 1);
  assert.equal(applied.running, true);
  assert.equal(applied.port, 18090);
});

test("改端口/重置密码也要等旧网关退出，否则新进程抢同一个端口", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  const fake = createDeferredGateways();
  const access = createMobileAccess(headlessOptions(dir, fake.factory));
  access.load();
  await access.apply();
  assert.equal(fake.created.length, 1);

  const changing = access.setConfig({ enabled: true, port: 18111 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.created.length, 1, "旧的还没退，新的不许起");
  assert.equal(fake.created[0].disposes, 1);
  fake.releases[0]();
  const changed = await changing;
  assert.equal(changed.ok, true);
  assert.equal(changed.port, 18111);
  assert.equal(fake.created.length, 2);
  assert.equal(fake.created[1].options.port, 18111, "新实例拿的是新端口");

  const resetting = access.password("reset");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.created.length, 2, "重置也是一样：旧的没退就不起");
  assert.equal(fake.created[1].disposes, 1);
  fake.releases[1]();
  const reset = await resetting;
  assert.equal(reset.restarted, true);
  assert.equal(fake.created.length, 3);
  assert.equal(fake.created[2].options.password, reset.password, "新实例拿的是新密码，旧 token 才会失效");
});

test("配置坏着的时候不许重置密码：原文件一字不动，corrupt 警告也不清", async () => {
  const dir = tempDir();
  const broken = "{ 这不是 JSON secret";
  fs.writeFileSync(path.join(dir, "mobile-gateway.json"), broken, "utf8");
  const { access } = build({ dir });
  const loaded = access.load();
  assert.equal(loaded.configFile.status, "corrupt");

  const result = await access.password("reset");
  assert.equal(result.ok, false);
  assert.match(result.error, /保存|修/);
  assert.equal(fs.readFileSync(path.join(dir, "mobile-gateway.json"), "utf8"), broken, "原文件一个字都不许动");
  const after = access.status();
  assert.equal(after.configFile.status, "corrupt", "没成功的重置不能把警告清掉");
  assert.equal(after.enabled, false);
  assert.equal(after.port, DEFAULT_MOBILE_PORT);
  assert.equal(after.hasPassword, false);
  // 修的路还是显式保存：存一次之后才能重置
  const saved = await access.setConfig({ enabled: false, port: 18095 });
  assert.equal(saved.ok, true);
  assert.equal(saved.configFile.status, "ok");
  const reset = await access.password("reset");
  assert.equal(reset.ok, true);
  assert.ok(reset.password.length >= MIN_PASSWORD_LENGTH);
});

test("相邻两个写操作串行：等旧实例退出的空窗里不会又建一个实例，最终配置与实例一致", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  const fake = createDeferredGateways();
  const access = createMobileAccess(headlessOptions(dir, fake.factory));
  access.load();
  await access.apply();
  assert.equal(fake.created.length, 1);

  // 先改密码（会 await 旧 dispose），紧接着改端口
  const resetting = access.password("reset");
  const saving = access.setConfig({ enabled: true, port: 18111 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.created.length, 1, "第一个写操作还在等旧实例退出，第二个不许抢先建实例");

  fake.releases[0]();
  const reset = await resetting;
  assert.equal(reset.ok, true);
  assert.equal(fake.created.length, 2);
  assert.equal(fake.created[1].options.port, 18090);
  assert.equal(fake.created[1].options.password, reset.password);

  fake.releases[1]();
  const saved = await saving;
  assert.equal(saved.ok, true);
  assert.equal(saved.port, 18111);
  assert.equal(fake.created.length, 3, "两次写操作就换两次实例，不多建");
  assert.equal(fake.created[2].options.port, 18111, "最终实例拿的是后一份配置");
  assert.equal(fake.created[2].options.password, reset.password, "密码没被前一份盖回去");
  assert.deepEqual(fake.created.slice(0, 2).map((row) => row.disposes), [1, 1], "旧的两个都收干净了");

  const onDisk = readMobileConfig(dir).config;
  assert.equal(onDisk.port, 18111);
  assert.equal(onDisk.password, reset.password);
  assert.equal(access.status().port, 18111);
  assert.equal(access.status().running, true);
});

test("密码：show 只给本机看；reset 会换新、断开旧会话，且旧密码不再认", async () => {
  const dir = tempDir();
  const original = generateMobilePassword();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: original });
  const { access, gateways } = build({ dir });
  access.load();
  await access.apply();

  const shown = await access.password("show");
  assert.equal(shown.ok, true);
  assert.equal(shown.password, original);
  assert.equal(shown.restarted, false);
  assert.equal(shown.running, true);

  const reset = await access.password("reset");
  assert.equal(reset.ok, true);
  assert.notEqual(reset.password, original);
  assert.ok(reset.password.length >= MIN_PASSWORD_LENGTH);
  assert.equal(reset.restarted, true, "开着的时候重置必须重起，旧 token 才会失效");
  assert.equal(gateways.length, 2);
  assert.equal(gateways[0].disposes, 1);
  assert.equal(gateways[1].options.password, reset.password);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "mobile-gateway.json"), "utf8")).password, reset.password);
  assert.equal((await access.password("show")).password, reset.password);

  // 关着的时候重置不重起，只换文件里那份
  await access.setConfig({ enabled: false });
  const before = gateways.length;
  const quietReset = await access.password("reset");
  assert.equal(quietReset.ok, true);
  assert.equal(quietReset.restarted, false);
  assert.equal(gateways.length, before);

  assert.equal((await access.password("delete")).ok, false, "不认识的动作要拒");
});

test("关着的时候 show 说明还没密码；开启时才生成", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: false, port: 18090, password: "" });
  const { access } = build({ dir });
  access.load();
  assert.equal((await access.password("show")).ok, false);
  const enabled = await access.setConfig({ enabled: true });
  assert.equal(enabled.ok, true);
  assert.ok(enabled.passwordLength >= MIN_PASSWORD_LENGTH);
  assert.match(enabled.notice, /旧密码/);
});

test("状态里分得清「存下来了」和「真在跑」，起不来就报起不来", async () => {
  const dir = tempDir();
  writeMobileConfig(dir, { enabled: true, port: 18090, password: generateMobilePassword() });
  const created = [];
  const access = createMobileAccess({
    dataDir: dir,
    execPath: "node",
    handler: async () => null,
    listPartnerIds: async () => [],
    threadSnapshot: () => null,
    // 一个永远起不来的网关：只报失败，不说自己就绪
    createGateway: (options) => {
      const instance = {
        options,
        push: () => false,
        start() {
          options.onState({ running: false, reason: "ERR_ACCESS_DENIED" });
          return false;
        },
        async dispose() {},
      };
      created.push(instance);
      return instance;
    },
  });
  access.load();
  const applied = await access.apply();
  assert.equal(applied.enabled, true, "存下来的仍是「开」");
  assert.equal(applied.running, false, "但实际没起来就不能报已启动");
  assert.equal(applied.reason, "ERR_ACCESS_DENIED");
  assert.equal(created.length, 1);
  assert.deepEqual(applied.addresses.map((row) => row.address).length, applied.addresses.length);
  for (const row of applied.addresses) assert.match(row.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
});

test("手机那条路只转发注入的 handler，管理面三个 op 不在里面", async () => {
  const seen = [];
  const { access } = build({
    handler: async (op, payload) => {
      seen.push({ op, payload });
      if (op === "mobile.password") throw new Error(`unknown op: ${op}`);
      return { ok: true };
    },
  });
  assert.deepEqual(await access.dispatch("mobile.partners.list", {}), { ok: true });
  assert.equal(seen[0].op, "mobile.partners.list");
  await assert.rejects(() => access.dispatch("mobile.password", { action: "show" }), /unknown op/);
  await assert.rejects(() => access.dispatch("", {}), /no_op/);
});

test("地址/密码/指纹这些小件本身是稳的", () => {
  const rows = localAddresses(18090, {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth: [{ family: "IPv4", address: "192.168.1.7", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
  });
  assert.deepEqual(rows, [{ name: "eth", address: "192.168.1.7", url: "http://192.168.1.7:18090" }]);

  const a = generateMobilePassword();
  const b = generateMobilePassword();
  assert.ok(a.length >= MIN_PASSWORD_LENGTH);
  assert.notEqual(a, b);
  assert.match(a, /^[a-z2-9]+$/, "别混进容易认错的字符");

  assert.equal(snapshotSignature({ a: 1 }), snapshotSignature({ a: 1 }));
  assert.notEqual(snapshotSignature({ a: 1 }), snapshotSignature({ a: 2 }));
  assert.equal(snapshotSignature(undefined), snapshotSignature(null));

  assert.equal(DEFAULT_MOBILE_PORT, 18090);
});

