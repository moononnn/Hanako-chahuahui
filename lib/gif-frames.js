/**
 * 动图抽帧：GIF 在交给识图模型之前先在本地拆成几张静态 PNG，
 * 否则模型只会解码出第一帧，"动起来"的那部分永远读不到。
 * 借的是表情包插件那套已经跑稳的做法（omggif 解帧 + 手工 PNG 编码），
 * 这边只按宿主 ctx.models.stream 的 { mimeType, data } 结构返回，不带 data URL。
 */
import { deflate } from "node:zlib";
import omggif from "./vendor/omggif.cjs";

const { GifReader } = omggif;
const MAX_GIF_PIXELS = 4_000_000;
const MAX_FRAMES = 5;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function deflateAsync(buffer) {
  return new Promise((resolve, reject) => {
    deflate(buffer, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = await deflateAsync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 帧数超上限时沿时间轴均匀取样，首尾各留一张。 */
export function selectFrameIndexes(total, maxFrames = MAX_FRAMES) {
  if (total <= 0) return [];
  if (maxFrames <= 1) return [0];
  if (total <= maxFrames) return Array.from({ length: total }, (_, index) => index);
  const indexes = [];
  for (let i = 0; i < maxFrames; i++) {
    indexes.push(Math.round((i * (total - 1)) / (maxFrames - 1)));
  }
  return [...new Set(indexes)];
}

function clearFrameRect(canvas, canvasWidth, info) {
  for (let y = info.y; y < info.y + info.height; y++) {
    const start = (y * canvasWidth + info.x) * 4;
    canvas.fill(0, start, start + info.width * 4);
  }
}

export async function extractGifFrames(buffer, maxFrames = MAX_FRAMES) {
  const reader = new GifReader(buffer);
  const width = reader.width;
  const height = reader.height;
  const totalFrames = reader.numFrames();
  if (!width || !height || !totalFrames) throw new Error("GIF 中没有可读取的画面");
  if (width * height > MAX_GIF_PIXELS) throw new Error("GIF 画面尺寸过大，暂不支持识图");

  const wanted = new Set(selectFrameIndexes(totalFrames, maxFrames));
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let previousInfo = null;
  let restoreSnapshot = null;

  for (let index = 0; index < totalFrames; index++) {
    // 合成必须按顺序走：disposal 决定这一帧画在哪张"底"上。
    if (previousInfo?.disposal === 2) clearFrameRect(canvas, width, previousInfo);
    else if (previousInfo?.disposal === 3 && restoreSnapshot) canvas.set(restoreSnapshot);

    const info = reader.frameInfo(index);
    restoreSnapshot = info.disposal === 3 ? canvas.slice() : null;
    reader.decodeAndBlitFrameRGBA(index, canvas);

    if (wanted.has(index)) frames.push(await encodePng(width, height, canvas));
    previousInfo = info;
    // 大 GIF 一帧一帧解会让发送按钮一直转，每 8 帧把主线程还回去一次。
    if (index % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
  }

  return { frames, totalFrames, width, height };
}

/**
 * 把一张附件整理成识图请求里的图片部分。
 * 静态图原样带过去；GIF 抽成最多 5 张 PNG，并标出这是同一个动画的连续画面。
 */
export async function prepareVisionFrames(attachment, maxFrames = MAX_FRAMES) {
  if (!attachment?.data?.length) throw new Error("图片数据为空");
  if (attachment.mimeType !== "image/gif") {
    return { parts: [{ mimeType: attachment.mimeType, data: attachment.data }], animated: false, totalFrames: 1 };
  }
  const result = await extractGifFrames(attachment.data, maxFrames);
  return {
    parts: result.frames.map((data) => ({ mimeType: "image/png", data })),
    animated: result.totalFrames > 1,
    totalFrames: result.totalFrames,
  };
}
