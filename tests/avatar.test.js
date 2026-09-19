import test from "node:test";
import assert from "node:assert/strict";

import { AVATAR_TYPES, YUAN_AVATAR_FILES, createAvatarReader, defaultAvatarDirs, looksLikeImage, toBytes } from "../lib/avatar.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

// ── 认图片头 ──

test("认得 PNG / JPEG / GIF / WebP，别的都不认", () => {
  assert.equal(looksLikeImage(PNG), true);
  assert.equal(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(9)])), true);
  assert.equal(looksLikeImage(Buffer.from("GIF89a" + "\0".repeat(6))), true);
  assert.equal(looksLikeImage(Buffer.from("RIFF....WEBP" + "\0".repeat(4))), true);
  assert.equal(looksLikeImage(Buffer.from("这不是图片，是一段文字而已")), false);
  assert.equal(looksLikeImage(Buffer.alloc(4)), false); // 太短
  assert.equal(looksLikeImage(null), false);
  assert.equal(looksLikeImage(undefined), false);
});

// ── 资源回来形状不止一种 ──

test("资源内容照单收：Uint8Array / ArrayBuffer / base64 串 / {content}", () => {
  assert.deepEqual(toBytes(PNG), PNG);
  assert.deepEqual(toBytes({ content: PNG }), PNG);
  assert.deepEqual(toBytes(new Uint8Array(PNG)), PNG);
  assert.deepEqual(toBytes(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength)), PNG);
  assert.deepEqual(toBytes({ content: PNG.toString("base64") }), PNG);
  assert.deepEqual(toBytes({ data: { content: PNG } }), null); // 太深的嵌套不猜
  assert.equal(toBytes(null), null);
  assert.equal(toBytes({ content: "" }), null);
  assert.equal(toBytes({ content: "   " }), null);
});

// ── 读：顺序、兜底、缓存、只读 ──

function makeCtx(files) {
  const asked = [];
  return {
    asked,
    resources: {
      async read(ref, options) {
        asked.push(ref.path);
        const hit = files[ref.path.replace(/\\/g, "/")];
        if (!hit) throw new Error("ENOENT");
        assert.equal(options?.encoding, "base64", "必须按 base64 读，不然二进制会被当文本");
        return { content: hit };
      },
    },
  };
}

const ROOT = "C:/hana";
const reader = (ctx, opts = {}) =>
  createAvatarReader({
    ctx,
    agentsRoot: `${ROOT}/agents`,
    userRoot: `${ROOT}/user`,
    ...opts,
  });

test("按 png → jpg → … 的顺序找，找到就用", () => {
  const ctx = makeCtx({ [`${ROOT}/agents/mio/avatars/agent.jpg`]: PNG });
  return reader(ctx)
    .getAvatar("agent", "mio")
    .then((hit) => {
      assert.equal(hit.contentType, "image/jpeg");
      assert.deepEqual(hit.bytes, PNG);
      assert.ok(ctx.asked[0].endsWith("agent.png"));
    });
});

test("一张都没有就返回 null，不编一张假的", async () => {
  const ctx = makeCtx({});
  assert.equal(await reader(ctx).getAvatar("agent", "dora"), null);
});

test("读到的东西不像图（比如被当文本读了）就当作没读到", async () => {
  const ctx = makeCtx({ [`${ROOT}/agents/mio/avatars/agent.png`]: Buffer.from("这不是图").toString("base64") });
  assert.equal(await reader(ctx).getAvatar("agent", "mio"), null);
});

test("读了就缓存，一小会儿里不再去敲", async () => {
  const ctx = makeCtx({ [`${ROOT}/agents/mio/avatars/agent.png`]: PNG });
  const r = reader(ctx);
  await r.getAvatar("agent", "mio");
  const first = ctx.asked.length;
  await r.getAvatar("agent", "mio");
  assert.equal(ctx.asked.length, first, "第二次不该再发请求");
});

test("缓存过期后会重新读", async () => {
  const ctx = makeCtx({ [`${ROOT}/agents/mio/avatars/agent.png`]: PNG });
  const r = reader(ctx, { ttlMs: 0 });
  await r.getAvatar("agent", "mio");
  const first = ctx.asked.length;
  await r.getAvatar("agent", "mio");
  assert.ok(ctx.asked.length > first, "ttl 过了就该重读");
});

test("她自己的头像走 user 目录，用 user 这个名字", async () => {
  const ctx = makeCtx({ [`${ROOT}/user/avatars/user.png`]: PNG });
  const hit = await reader(ctx).getAvatar("user", null);
  assert.equal(hit.contentType, "image/png");
  assert.ok(ctx.asked[0].replace(/\\/g, "/").startsWith(`${ROOT}/user/avatars/user.`));
});

test("扩展名表跟宿主一致（png 打头）", () => {
  assert.deepEqual(AVATAR_TYPES.map(([ext]) => ext), ["png", "jpg", "jpeg", "webp", "gif"]);
});

// ── 没配头像：退到宿主自带的那张默认脸 ──

const ASSETS = "D:/hana-resources/assets";

const withAssets = (ctx) => reader(ctx, { defaultDirs: () => [ASSETS] });

/** 把候选目录里的路径找出来（比较时统一成斜杠，平台不分家）。 */
const askedPaths = (ctx) => ctx.asked.map((p) => p.replace(/\\/g, "/"));

test("伙伴自己没配头像，就用宿主自带的那张（按「缘」选）", async () => {
  const ctx = makeCtx({ [`${ASSETS}/Hanako.png`]: PNG });
  const hit = await withAssets(ctx).getAvatar("agent", "carol", "hanako");
  assert.ok(hit, "自己的那份没有，就该拿默认那张顶上");
  assert.equal(hit.contentType, "image/png");
  assert.ok(askedPaths(ctx)[0].endsWith("/agents/carol/avatars/agent.png"), "先找ta自己配的那份");
  assert.ok(askedPaths(ctx).includes(`${ASSETS}/Hanako.png`), "没有才去找默认那张");
});

test("自己配了头像就不去动默认那张", async () => {
  const ctx = makeCtx({ [`${ROOT}/agents/mio/avatars/agent.png`]: PNG, [`${ASSETS}/Hanako.png`]: PNG });
  assert.ok(await withAssets(ctx).getAvatar("agent", "mio", "hanako"));
  assert.equal(askedPaths(ctx).some((p) => p.startsWith(ASSETS)), false, "不能拿默认那张盖过她自己配的");
});

test("认不出这个「缘」就不猜，宁可退回首字", async () => {
  const ctx = makeCtx({ [`${ASSETS}/Hanako.png`]: PNG });
  const r = withAssets(ctx);
  assert.equal(await r.getAvatar("agent", "who", null), null);
  assert.equal(await r.getAvatar("agent", "who", "unknown-yuan"), null);
});

test("四个缘各对应宿主自己的那张文件名", () => {
  assert.deepEqual(YUAN_AVATAR_FILES, { hanako: "Hanako", butter: "Butter", ming: "Ming", kong: "Kong" });
});

test("默认脸的候选目录先认环境变量，再按平台给默认位置", () => {
  const win = defaultAvatarDirs({ platform: "win32", env: { HANA_AGENT_RESOURCES: "X:/hana" } });
  assert.equal(win[0].replace(/\\/g, "/"), "X:/hana/assets");
  assert.ok(win.some((p) => p.includes("Program Files")), "装到默认位置时得找得到");
  const mac = defaultAvatarDirs({ platform: "darwin", env: {} });
  assert.ok(mac.some((p) => p.includes("HanaAgent.app")));
  const linux = defaultAvatarDirs({ platform: "linux", env: {} });
  assert.ok(linux.length > 0);
});

test("默认脸读不到也不报错，就是没有", async () => {
  const ctx = makeCtx({});
  assert.equal(await withAssets(ctx).getAvatar("agent", "carol", "hanako"), null);
});

test("换了个缘就是另一张脸，缓存的键跟着变", async () => {
  const ctx = makeCtx({ [`${ASSETS}/Butter.png`]: PNG });
  const r = withAssets(ctx);
  assert.equal(await r.getAvatar("agent", "a", "hanako"), null, "这个缘在盘上没有");
  assert.ok(await r.getAvatar("agent", "a", "butter"), "换成这个缘就该重新找，不吃上一个缘的缓存");
});
