import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStickerGroup,
  importStickerBytes,
  listStickerLibrary,
  readOwnSticker,
  readStickerLibrary,
  removeSticker,
  removeStickerGroup,
} from "../lib/sticker-library.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-library-")); }

test("茶话会图库：坏 JSON 会隔离，后续新建分组不能覆盖原件", () => {
  const dir = tempDir();
  const file = path.join(dir, "sticker-library.json");
  fs.writeFileSync(file, "{坏图库", "utf8");
  assert.deepEqual(readStickerLibrary(dir), { version: 1, groups: [], stickers: [] });
  const siblings = fs.readdirSync(dir);
  assert.equal(siblings.filter((name) => name.startsWith("sticker-library.json.corrupt-")).length, 1);
  assert.ok(!fs.existsSync(file));
  createStickerGroup(dir, "新分组");
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("sticker-library.json.corrupt-")).length, 1);
});

test("茶话会图库：导入图片、分组和读取都落在自己的目录", () => {
  const dir = tempDir();
  const group = createStickerGroup(dir, "猫猫");
  const source = { id: "stk_source", contentType: "image/png", description: "一只猫", emotion: ["开心"] };
  const first = importStickerBytes(dir, source, Buffer.from("image-bytes"), [group.id]);
  assert.equal(first.duplicate, false);
  assert.equal(listStickerLibrary(dir).stickers[0].groupIds[0], group.id);
  const own = readOwnSticker(dir, first.sticker.id);
  assert.equal(own.bytes.toString(), "image-bytes");
  assert.equal(own.contentType, "image/png");
});

test("茶话会图库：同一图片重复导入只补分组，不复制文件", () => {
  const dir = tempDir();
  const a = createStickerGroup(dir, "A");
  const b = createStickerGroup(dir, "B");
  const source = { id: "stk_source", contentType: "image/jpeg" };
  const first = importStickerBytes(dir, source, Buffer.from("same"), [a.id]);
  const second = importStickerBytes(dir, source, Buffer.from("same"), [b.id]);
  assert.equal(second.duplicate, true);
  const library = listStickerLibrary(dir);
  assert.equal(library.stickers.length, 1);
  assert.deepEqual(new Set(library.stickers[0].groupIds), new Set([a.id, b.id]));
});

// 她说得很清楚：不喜欢就直接删；但以前发出去的那条消息得还在。
// 所以删的只是图库里的那一条，图片文件留在盘上。
test("茶话会图库：删图只拿掉图库里的记录，图片文件留着（老消息还看得见）", () => {
  const dir = tempDir();
  const imported = importStickerBytes(dir, { id: "s1", contentType: "image/png" }, Buffer.from("keep-me"), []);
  const file = path.join(dir, "stickers", readStickerLibrary(dir).stickers[0].file);
  assert.ok(fs.existsSync(file));

  assert.equal(removeSticker(dir, imported.sticker.id), true);
  assert.equal(listStickerLibrary(dir).stickers.length, 0);
  assert.ok(fs.existsSync(file), "文件得留着，不然她以前发出去的那张图就成破图了");
  assert.equal(readOwnSticker(dir, imported.sticker.id), null, "图库里没了就不该再读得到");

  // 幂等：已经没了再删一次不报错，只是什么都不做
  assert.equal(removeSticker(dir, imported.sticker.id), false);
  assert.equal(removeSticker(dir, ""), false);
});

test("茶话会图库：删分组不删组里的图，那些图退回「全部」", () => {
  const dir = tempDir();
  const cats = createStickerGroup(dir, "猫猫");
  const dogs = createStickerGroup(dir, "狗狗");
  const both = importStickerBytes(dir, { id: "s2", contentType: "image/png" }, Buffer.from("a"), [cats.id, dogs.id]);
  const onlyCats = importStickerBytes(dir, { id: "s4", contentType: "image/png" }, Buffer.from("c"), [cats.id]);
  importStickerBytes(dir, { id: "s3", contentType: "image/png" }, Buffer.from("b"), [dogs.id]);

  assert.equal(removeStickerGroup(dir, cats.id), true);
  const library = listStickerLibrary(dir);
  assert.deepEqual(library.groups.map((g) => g.name), ["狗狗"]);
  assert.equal(library.stickers.length, 3, "图一张都不该少");
  assert.deepEqual(library.stickers.find((row) => row.id === both.sticker.id).groupIds, [dogs.id], "另一个分组还在");
  assert.deepEqual(library.stickers.find((row) => row.id === onlyCats.sticker.id).groupIds, [], "只属于被删分组的那张退回全部");

  assert.equal(removeStickerGroup(dir, cats.id), false);
});
