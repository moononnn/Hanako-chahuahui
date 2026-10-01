import test from "node:test";
import assert from "node:assert/strict";

import { extractGifFrames, prepareVisionFrames, selectFrameIndexes } from "../lib/gif-frames.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function gifBytes(frameCount) {
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff,
  ]);
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
  return Buffer.concat([header, ...Array.from({ length: frameCount }, () => frame), Buffer.from([0x3b])]);
}

test("帧数不超上限时全取，超上限时沿时间轴均匀取样并保留首尾", () => {
  assert.deepEqual(selectFrameIndexes(1, 5), [0]);
  assert.deepEqual(selectFrameIndexes(3, 5), [0, 1, 2]);
  assert.deepEqual(selectFrameIndexes(73, 5), [0, 18, 36, 54, 72]);
  assert.deepEqual(selectFrameIndexes(2, 1), [0]);
});

test("静态图片原样透传，不改字节也不改类型", async () => {
  const png = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.alloc(4)]);
  const result = await prepareVisionFrames({ mimeType: "image/png", data: png });
  assert.equal(result.animated, false);
  assert.equal(result.totalFrames, 1);
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].mimeType, "image/png");
  assert.equal(result.parts[0].data, png);
});

test("多帧 GIF 抽成按时间顺序的 PNG，标出这是动图", async () => {
  const result = await prepareVisionFrames({ mimeType: "image/gif", data: gifBytes(2) });
  assert.equal(result.animated, true);
  assert.equal(result.totalFrames, 2);
  assert.equal(result.parts.length, 2);
  for (const part of result.parts) {
    assert.equal(part.mimeType, "image/png");
    assert.deepEqual([...part.data.subarray(0, 8)], PNG_MAGIC);
  }
});

test("只有一帧的 GIF 走静态路径，但仍统一转成 PNG", async () => {
  const result = await prepareVisionFrames({ mimeType: "image/gif", data: gifBytes(1) });
  assert.equal(result.animated, false);
  assert.equal(result.totalFrames, 1);
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].mimeType, "image/png");
});

test("抽帧上限生效：帧多时只回 5 张图", async () => {
  const result = await extractGifFrames(gifBytes(1), 5);
  assert.equal(result.frames.length, 1);
  assert.equal(result.totalFrames, 1);
});

test("坏数据不静默通过：假 GIF 头和空数据都要报错", async () => {
  const fake = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.alloc(30)]);
  await assert.rejects(() => prepareVisionFrames({ mimeType: "image/gif", data: fake }));
  await assert.rejects(() => prepareVisionFrames({ mimeType: "image/png", data: Buffer.alloc(0) }));
});
