/**
 * 表情包缩略图：网格慢的根因是「为了五十像素的格子去驮一兆多的原图」。
 * 这一层负责把原图缩到 256 并缓存下来，认不出的格式老实退回原图。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import omggif from "../lib/vendor/omggif.cjs";
import { decodePng, encodePng, resizeRgba } from "../lib/png-codec.js";
import {
  THUMB_MAX_SIZE,
  buildStickerThumb,
  ensureStickerThumb,
  hasThumb,
  missingThumbKeys,
  readCachedThumb,
  sniffImageType,
  startThumbWarmup,
  thumbKeyFor,
} from "../lib/sticker-thumb.js";
import { makeBaselineJpeg } from "./helpers/sample-jpeg.js";

const { GifWriter } = omggif;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-thumb-"));
}

/** 一张 w×h 的图，故意带噪声：纯渐变 PNG 压得太狠，测不出体积差。 */
async function makePng(w, h, seed = 1) {
  const rgba = Buffer.alloc(w * h * 4);
  let mix = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mix = (mix * 1103515245 + 12345) & 0x7fffffff;
      const i = (y * w + x) * 4;
      rgba[i] = (mix + x) & 0xff;
      rgba[i + 1] = (mix + y) & 0xff;
      rgba[i + 2] = (mix >> 8) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

/** 最小可用的两帧 GIF（四色调色板，像素值就是调色板下标）。 */
function makeGif(w, h) {
  const buf = Buffer.alloc(w * h * 3 * 2);
  for (let i = 0; i < w * h * 2; i++) buf[i] = i % 4;
  const palette = [0x102030, 0xff8040, 0x40c080, 0xf0f0f0];
  const writer = new GifWriter(buf, w, h, { loop: 0 });
  writer.addFrame(0, 0, w, h, buf.subarray(0, w * h), { palette, delay: 10 });
  writer.addFrame(0, 0, w, h, buf.subarray(w * h, w * h * 2), { palette, delay: 10 });
  return Buffer.from(buf.subarray(0, writer.end()));
}

test("PNG 编解码对得上：编出来的再解回去还是那些像素", async () => {
  const original = await makePng(37, 21);
  const decoded = decodePng(original);
  assert.ok(decoded, "自家编的 PNG 必须能解开");
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 21);
  assert.equal(decoded.data.length, 37 * 21 * 4);
  assert.deepEqual(
    Array.from(decoded.data.subarray(0, 8)),
    Array.from(decodePng(await makePng(37, 21)).data.subarray(0, 8)),
    "解出来的像素要跟编进去的一致",
  );
  for (let i = 0; i < decoded.data.length; i += 4) {
    assert.equal(decoded.data[i + 3], 255, "不透明通道得是实的");
    if (i > 200) break;
  }
});

test("解不了的老实说解不了：非 PNG、截断、像素过大都不猜", async () => {
  assert.equal(decodePng(Buffer.from("not an image at all")), null);
  // 像素上限同时是内存红线：超了不硬解，那不是表情包，是壁纸
  const small = await makePng(4, 4);
  const huge = Buffer.from(small);
  huge.writeUInt32BE(99_999, 16); // IHDR 里的宽
  huge.writeUInt32BE(99_999, 20); // 和高
  assert.equal(decodePng(huge), null, "改大尺寸就该当场拒绝，而不是先展开再发现");
});

test("缩放等比缩到上限以内，已经够小的原样不动", async () => {
  const src = await makePng(1000, 500);
  const decoded = decodePng(src);
  const small = resizeRgba(decoded.data, decoded.width, decoded.height, 256);
  assert.equal(small.width, 256);
  assert.equal(small.height, 128);
  const tiny = resizeRgba(decoded.data, decoded.width, decoded.height, 4096);
  assert.equal(tiny.data, decoded.data, "不用重建本来就够小的图");
});

test("PNG 缩略图：最大边到 256，体积掉一个数量级", async () => {
  const png = await makePng(900, 900);
  const thumb = await buildStickerThumb(png, "image/png");
  assert.ok(thumb, "PNG 必须能缩");
  const decoded = decodePng(thumb);
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
  assert.ok(thumb.length * 5 < png.length, `缩略图 ${thumb.length} 字节不该跟原图 ${png.length} 字节一个量级`);
  assert.equal(THUMB_MAX_SIZE, 256);
});

test("GIF 取第一帧：网格里它就是个静态小图", async () => {
  const thumb = await buildStickerThumb(makeGif(40, 24), "image/gif");
  assert.ok(thumb);
  const decoded = decodePng(thumb);
  assert.equal(decoded.width, 40);
  assert.equal(decoded.height, 24);
});

test("认不出的格式退回 null，让路由去发原图", async () => {
  assert.equal(await buildStickerThumb(Buffer.from("fake"), "image/jpeg"), null);
  assert.equal(await buildStickerThumb(Buffer.alloc(0), "image/png"), null);
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0])), "image/jpeg", "看得出是 JPEG，但解不出完整数据");
  assert.equal(sniffImageType(Buffer.from("RIFF____WEBPVP8 ")), null, "webp 这份解码器不认");
});

test("JPEG 也要能缩：图库里绝大多数是 JPEG，不认它就等于没优化", async () => {
  const jpeg = makeBaselineJpeg();
  assert.equal(sniffImageType(jpeg), "image/jpeg");
  const thumb = await buildStickerThumb(jpeg, "image/jpeg");
  assert.ok(thumb, "基线 JPEG 必须能缩");
  const decoded = decodePng(thumb);
  assert.equal(decoded.width, 16, "本来就够小的不该被放大");
  assert.equal(decoded.height, 8);
});

test("认图看文件头不看后缀：后缀写着 jpeg 的 PNG 也要缩", async () => {
  const png = await makePng(400, 300);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(makeGif(8, 8)), "image/gif");
  // 明说自己是 jpeg，内容却是 PNG：按内容认，才缩得下来
  const thumb = await buildStickerThumb(png, "image/jpeg");
  assert.ok(thumb, "不能因为后缀写错就放弃这一张");
  assert.equal(decodePng(thumb).width, 256);
});

test("缓存键：库里有 sha256 就用它，没有就拿文件路径顶", () => {
  const sha = "a".repeat(64);
  assert.equal(thumbKeyFor({ sha256: sha, file: "stickers/x.png" }), sha);
  const byPath = thumbKeyFor({ file: "stickers/x.png" });
  assert.equal(byPath.length, 64);
  assert.notEqual(byPath, thumbKeyFor({ file: "stickers/y.png" }));
});

test("现算一次存下来，之后直接读小文件，原图不再动", async () => {
  const dir = tempDir();
  const png = await makePng(600, 400);
  const row = { sha256: "b".repeat(64), file: "stickers/local_x.png" };
  let loads = 0;
  const load = async () => { loads++; return { bytes: png, contentType: "image/png" }; };

  const first = await ensureStickerThumb(dir, row, load);
  assert.ok(first);
  assert.equal(loads, 1);
  assert.deepEqual(readCachedThumb(dir, thumbKeyFor(row)), first, "算完要落盘");

  const second = await ensureStickerThumb(dir, row, load);
  assert.deepEqual(second, first);
  assert.equal(loads, 1, "命中缓存就不该再去读那张大图");
});

test("原图读不出来就不写缓存，下次还能重试", async () => {
  const dir = tempDir();
  const row = { sha256: "c".repeat(64), file: "stickers/missing.png" };
  assert.equal(await ensureStickerThumb(dir, row, async () => null), null);
  assert.deepEqual(missingThumbKeys(dir, [row]), [{ row, key: thumbKeyFor(row) }]);
});

test("后台补图：常见格式都试一遍，缩不出来的老实跳过", async () => {
  const dir = tempDir();
  const png = await makePng(300, 300);
  const rows = [
    { sha256: "d".repeat(64), file: "stickers/one.png" },
    { sha256: "e".repeat(64), file: "stickers/two.jpg" },
    { sha256: "f".repeat(64), file: "stickers/three.webp" },
  ];
  const seen = [];
  const load = async (row) => {
    seen.push(row.file);
    return { bytes: png, contentType: "image/png" };
  };

  const scope = `t-${Date.now()}-${Math.random()}`;
  const made = await startThumbWarmup(dir, rows, load, { idleMs: 0, scope });
  assert.equal(made, 2, "png 和 jpg 都得给机会；webp 缩不出来，不该白读一遍");
  assert.deepEqual(seen, ["stickers/one.png", "stickers/two.jpg"]);
  assert.ok(readCachedThumb(dir, thumbKeyFor(rows[0])));
  assert.equal(missingThumbKeys(dir, rows).length, 1, "剩下的只有那张缩不出来的");
});

test("以后新加的图也会被补上：每次调用都重新扫一遍", async () => {
  const dir = tempDir();
  const png = await makePng(300, 300);
  const scope = `t-${Date.now()}-${Math.random()}`;
  const load = async () => ({ bytes: png, contentType: "image/png" });

  const first = [{ sha256: "1".repeat(64), file: "stickers/old.png" }];
  assert.equal(await startThumbWarmup(dir, first, load, { idleMs: 0, scope }), 1);
  assert.equal(await startThumbWarmup(dir, first, load, { idleMs: 0, scope }), 0, "补齐之后不该再去读原图");

  // 她明天又导了几张进来
  const grown = [...first, { sha256: "2".repeat(64), file: "stickers/new.png" }];
  assert.equal(await startThumbWarmup(dir, grown, load, { idleMs: 0, scope }), 1, "新图得被补上");
  assert.ok(hasThumb(dir, thumbKeyFor(grown[1])));
  assert.equal(missingThumbKeys(dir, grown).length, 0);
});

/**
 * 一张坏图不许把预热卡死。
 *
 * 2026-10-19 独立审包发现：预热循环里没包 try，解码抛一次就把整个循环打断，
 * `warming.delete(slot)` 也跟着跳掉，那个槽位永久卡住——
 * 以后新加的表情包再也补不上缩略图，而且她那边一声不响。
 */
test("一张坏图缩不出来，不能把后面的图和下一次预热一起废掉", async () => {
  const dir = tempDir();
  const scope = `坏图-${Math.random()}`;
  const good = await makePng(12, 12, 7);
  const rows = [
    { sha256: "a".repeat(64), file: "stickers/broken.jpg" },
    { sha256: "b".repeat(64), file: "stickers/good.png" },
  ];
  const load = async (row) => (row.file.endsWith(".png")
    ? { bytes: good, contentType: "image/png" }
    // 一段长度只容得下 1 个 spec 的 DQT，precision 却写着 1（每项 2 字节）：
    // 旧代码会闷头连读 64 项，直接越界抛 RangeError（实测 offset 15 > 13）。
    : { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x0b, 0x10]), Buffer.alloc(8)]), contentType: "image/jpeg" });

  assert.equal(await startThumbWarmup(dir, rows, load, { idleMs: 0, scope }), 1, "坏的那张跳过，好的那张照样补上");
  assert.ok(hasThumb(dir, thumbKeyFor(rows[1])), "好的那张要有缩略图");
  assert.equal(hasThumb(dir, thumbKeyFor(rows[0])), false);

  // 槽位必须放开：把坏的那张换掉再来一次，得能真补
  const fixed = [
    { sha256: "c".repeat(64), file: "stickers/good2.png" },
  ];
  assert.equal(await startThumbWarmup(dir, fixed, async () => ({ bytes: good, contentType: "image/png" }), { idleMs: 0, scope }), 1, "槽位没卡住才补得动");
  assert.ok(hasThumb(dir, thumbKeyFor(fixed[0])));
});

test("IHDR 段太短时不读越界，老实返回 null", () => {
  // PNG 签名 + 一个声明长度 8 的 IHDR：readUInt32BE(4) 会抛 ERR_OUT_OF_RANGE。
  // 现在只有 buildStickerThumb 一个调用点且在 try 里，但解码器不该指望上游兜。
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const short = Buffer.concat([
    sig,
    Buffer.from([0, 0, 0, 8]),           // length = 8
    Buffer.from("IHDR", "ascii"),
    Buffer.alloc(8),
    Buffer.alloc(4),                      // 假装有个 CRC
  ]);
  assert.doesNotThrow(() => decodePng(short));
  assert.equal(decodePng(short), null);

  // 长度 0 也一样
  const zero = Buffer.concat([
    sig,
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("IHDR", "ascii"),
    Buffer.alloc(4),
  ]);
  assert.doesNotThrow(() => decodePng(zero));
  assert.equal(decodePng(zero), null);
});
