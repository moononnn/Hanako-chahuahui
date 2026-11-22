import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectStickerImage, extForAttachment } from "../lib/sticker-collect.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-collect-")); }

function storeOf(bytes, meta = {}) {
  return { data: bytes, mimeType: meta.mimeType || "image/png", name: meta.name || "a.png" };
}

function collect({ dir, bytes, readAttachment, forward, importBytes }) {
  const imported = [];
  const Recorded = importBytes || ((dataDir, source, data, groups) => {
    imported.push({ source, data, groups });
    return { sticker: { id: "local_1" }, duplicate: false };
  });
  return collectStickerImage({
    dataDir: dir,
    agentId: "p1",
    attachment: "img_1",
    readAttachment: readAttachment || ((id, agentId) => (id === "img_1" && agentId === "p1" ? storeOf(bytes) : null)),
    forward: forward || (async () => ({ ok: true, id: "stk_001" })),
    importBytes: Recorded,
  }).then((result) => ({ result, imported }));
}

test("后缀：先认 MIME，再认文件名，都不认回 png", () => {
  assert.equal(extForAttachment({ mimeType: "image/jpeg" }), "jpg");
  assert.equal(extForAttachment({ mimeType: "image/webp" }), "webp");
  assert.equal(extForAttachment({ name: "x.gif" }), "gif");
  assert.equal(extForAttachment({ name: "x.bin", mimeType: "application/octet-stream" }), "png");
  assert.equal(extForAttachment({}), "png");
});

test("装了表情包：递过去，茶话会自己也留一张，临时文件递完就删", async () => {
  const dir = tempDir();
  const bytes = Buffer.from("same-image");
  const calls = [];
  const { result, imported } = await collect({
    dir,
    bytes,
    forward: async (tmp, meta) => { calls.push({ tmp, name: meta.name }); return { ok: true, id: "stk_001" }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.forwardedOk, true);
  assert.equal(result.sticker.id, "local_1");
  assert.equal(calls.length, 1, "只递一次");
  assert.ok(path.isAbsolute(calls[0].tmp), "递的是本机绝对路径");
  assert.equal(fs.existsSync(calls[0].tmp), false, "临时文件不能留在盘上");
  assert.equal(imported.length, 1, "茶话会自己也要有一张");
  assert.equal(imported[0].data.toString(), "same-image");
  assert.equal(imported[0].source.emotion.length, 0, "标签由表情包那边认，茶话会先不编");
});

test("递不过去（没装 / 没启用 / 超时）：茶话会这张照样留下，不算失败", async () => {
  const dir = tempDir();
  const { result, imported } = await collect({
    dir,
    bytes: Buffer.from("only-local"),
    forward: async () => { throw new Error("服务未注册"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.forwardedOk, false);
  assert.equal(imported.length, 1, "本地这张必须留下");
});

test("对方明确拒收：也算没递成，本地照留", async () => {
  const dir = tempDir();
  const { result, imported } = await collect({
    dir,
    bytes: Buffer.from("refused"),
    forward: async () => ({ ok: false, error: "图库太大了" }),
  });
  assert.equal(result.forwardedOk, false);
  assert.match(result.forwarded.error, /图库太大了/);
  assert.equal(imported.length, 1);
});

test("图已经不在了 / 不属于这位伙伴：不递也不导入", async () => {
  const dir = tempDir();
  const calls = [];
  const { result, imported } = await collect({
    dir,
    bytes: Buffer.from("gone"),
    readAttachment: () => null,
    forward: async (tmp) => { calls.push(tmp); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "attachment-missing");
  assert.equal(calls.length, 0, "图没了就别去麻烦表情包");
  assert.equal(imported.length, 0);
});
