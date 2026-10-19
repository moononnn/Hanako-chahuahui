/**
 * PNG 编解码 + 缩放。
 *
 * 表情包网格的缩略图靠它做：一次请求驮一张 1~6 MB 的原图铺在五十像素的格子里，
 * 二百多张铺满一屏就是几百 MB，把宿主拖住。把图先缩到几百像素再发，
 * 网格才转得起来。
 *
 * 只认桌面截图最常见的那几种：8 位深、不交错、灰度/RGB/灰度+Alpha/调色板/RGBA。
 * 认不出来的老实返回 null，让调用方退回原图——宁可慢一点，也不能给她一张错图。
 * 动图抽帧那边（gif-frames）也用同一份编码器，两边只留一份实现。
 */
import { deflate, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 表情包桌面截图一张两百万像素；再大的先别硬解，那不是表情包，是壁纸。
 *  这条同时是内存红线：解码会短暂开出一份 RGBA（每像素 4 字节），
 *  上限定太高的话，一口气进来几张大图就能把进程顶穿。 */
export const MAX_DECODE_PIXELS = 8_000_000;

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

/** RGBA（每像素 4 字节，Uint8Array 或 Buffer）编成 PNG。 */
export async function encodePng(width, height, rgba) {
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

/** 逐行去掉 PNG 的五种行滤波。 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const value = line[x];
      switch (filter) {
        case 0: cur[x] = value; break;
        case 1: cur[x] = value + a; break;
        case 2: cur[x] = value + b; break;
        case 3: cur[x] = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          cur[x] = value + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: return null;
      }
    }
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解一张 PNG。
 * @returns {{width: number, height: number, data: Buffer}|null} data 是 RGBA
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;

  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return null;
    const data = buffer.subarray(start, end);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }

  if (!header || !idat.length) return null;
  const { width, height, depth, color, compression, filter, interlace } = header;
  if (!width || !height || depth !== 8 || interlace !== 0 || compression !== 0 || filter !== 0) return null;
  if (!CHANNELS[color]) return null;
  if (width * height > MAX_DECODE_PIXELS) return null;
  if (color === 3 && !palette) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const bpp = CHANNELS[color];
  const planes = unfilter(raw, width, height, bpp);
  if (!planes) return null;

  const data = Buffer.alloc(width * height * 4);
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (color === 0 || color === 4) {
      data[d] = data[d + 1] = data[d + 2] = planes[s];
      data[d + 3] = color === 4 ? planes[s + 1] : 255;
    } else if (color === 2) {
      data[d] = planes[s];
      data[d + 1] = planes[s + 1];
      data[d + 2] = planes[s + 2];
      data[d + 3] = 255;
    } else if (color === 6) {
      data[d] = planes[s];
      data[d + 1] = planes[s + 1];
      data[d + 2] = planes[s + 2];
      data[d + 3] = planes[s + 3];
    } else {
      const index = planes[s];
      const p = index * 3;
      if (p + 2 >= palette.length) return null;
      data[d] = palette[p];
      data[d + 1] = palette[p + 1];
      data[d + 2] = palette[p + 2];
      data[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, data };
}

/**
 * 等比缩到最长边不超过 maxSize（框面积取平均，缩完不会一片糊）。
 * 已经够小的原样返回，不做无谓的重建。
 */
export function resizeRgba(source, srcWidth, srcHeight, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(srcWidth, srcHeight));
  if (scale >= 1) return { width: srcWidth, height: srcHeight, data: source };
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * srcHeight) / height);
    const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.floor(((y + 1) * srcHeight) / height)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * srcWidth) / width);
      const x1 = Math.min(srcWidth, Math.max(x0 + 1, Math.floor(((x + 1) * srcWidth) / width)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * srcWidth + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += source[i];
          g += source[i + 1];
          b += source[i + 2];
          a += source[i + 3];
          n++;
        }
      }
      const d = (y * width + x) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}
