/**
 * 最小可用的 JPEG 解码器（基线与扩展顺序 DCT，SOF0/SOF1）。
 *
 * 为什么自己写：宿主没有缩图接口，图库又不可能预装什么图像库。
 * 而表情包图库里绝大多数是 JPEG —— 不认 JPEG，这个优化对大部分用户等于没做。
 *
 * 认不出的老实返回 null，让调用方退回原图：
 * 渐进式（SOF2）、无损、算术编码、冷门采样一律不猜。
 * 宁可慢一点，也不能给她一张颜色错掉的图。
 *
 * 精度说明：IDCT 用浮点两趟分离实现，跟浏览器/系统解码器有 ±1~2 的舍入差，
 * 缩到几百像素之后肉眼不可见。
 */
import { MAX_DECODE_PIXELS } from "./png-codec.js";

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** IDCT 用的余弦表：COS[x][u] = cos((2x+1)uπ/16)。 */
const COS = (() => {
  const table = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      table[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

const SCALE = [Math.SQRT1_2, 1, 1, 1, 1, 1, 1, 1];

function buildHuffmanTable(counts, values) {
  // 规范 Huffman：按码长从小到大排，长度相同按值递增
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      table.set(`${length}:${code}`, values[k++]);
      code++;
    }
    code <<= 1;
  }
  return table;
}

class BitReader {
  constructor(buffer, start, end) {
    this.buffer = buffer;
    this.pos = start;
    this.end = end;
    this.value = 0;
    this.count = 0;
    this.marker = 0;
  }

  bit() {
    if (this.count === 0) {
      if (this.pos >= this.end) return null;
      let byte = this.buffer[this.pos++];
      if (byte === 0xff) {
        const next = this.buffer[this.pos];
        if (next === 0x00) {
          this.pos++;
        } else if (next >= 0xd0 && next <= 0xd7) {
          // 重启标记交给外层处理，这里先跳过
          this.marker = next;
          this.pos++;
          byte = this.buffer[this.pos++];
        } else {
          // 撞上真正的标记：这段数据到此为止
          this.marker = next;
          this.pos--;
          return null;
        }
      }
      if (byte === undefined) return null;
      this.value = byte;
      this.count = 8;
    }
    this.count--;
    return (this.value >> this.count) & 1;
  }

  bits(n) {
    let out = 0;
    for (let i = 0; i < n; i++) {
      const b = this.bit();
      if (b === null) return null;
      out = (out << 1) | b;
    }
    return out;
  }

  decode(table) {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      const b = this.bit();
      if (b === null) return null;
      code = (code << 1) | b;
      const value = table.get(`${length}:${code}`);
      if (value !== undefined) return value;
    }
    return null;
  }

  /** 熵编码数据后面跟着下一个标记，从那儿接着解析。 */
  skipToMarker() {
    while (this.pos < this.buffer.length - 1) {
      if (this.buffer[this.pos] === 0xff) {
        const next = this.buffer[this.pos + 1];
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) return this.pos;
      }
      this.pos++;
    }
    return this.buffer.length;
  }
}

function extend(value, length) {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

const BLOCK = new Float32Array(64);
const ROW = new Float32Array(64);

function idct(coeff, quant, out) {
  // 第一趟：行
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += SCALE[u] * coeff[y * 8 + u] * COS[x * 8 + u];
      ROW[y * 8 + x] = sum * 0.5;
    }
  }
  // 第二趟：列
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += SCALE[v] * ROW[v * 8 + x] * COS[y * 8 + v];
      const value = Math.round(sum * 0.5) + 128;
      out[y * 8 + x] = value < 0 ? 0 : (value > 255 ? 255 : value);
    }
  }
}

function decodeBlock(reader, component, quantTables, dcTable, acTable, previousDc) {
  BLOCK.fill(0);
  const quant = quantTables[component.quantId];
  const t = reader.decode(dcTable);
  if (t === null) return null;
  const diff = t === 0 ? 0 : extend(reader.bits(t) ?? 0, t);
  const dc = previousDc + diff;
  previousDc = dc;
  BLOCK[0] = dc * (quant ? quant[0] : 1);

  let k = 1;
  while (k < 64) {
    const rs = reader.decode(acTable);
    if (rs === null) return null;
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r < 15) break;
      k += 16;
      continue;
    }
    k += r;
    if (k > 63) {
      // 位置越界算坏数据，但该读的位还得读：不吃掉它，后面的块全错
      if (reader.bits(s) === null) return null;
      break;
    }
    const size = reader.bits(s);
    if (size === null) return null;
    // quant 是自然序，k 是之字序，得先换算过去
    BLOCK[ZIGZAG[k]] = extend(size, s) * (quant ? quant[ZIGZAG[k]] : 1);
    k++;
  }
  return dc;
}

function decodeScan(buffer, start, end, frame, tables) {
  const { quantTables, huffDC, huffAC, components } = frame;
  const reader = new BitReader(buffer, start, end);
  const maxH = frame.maxH;
  const maxV = frame.maxV;
  const mcusPerLine = Math.ceil(frame.width / (8 * maxH));
  const mcusPerColumn = Math.ceil(frame.height / (8 * maxV));
  const dc = new Int32Array(components.length);
  let mcu = 0;
  const total = mcusPerLine * mcusPerColumn;

  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    component.blocksPerLine = mcusPerLine * component.h;
    component.blocksPerColumn = mcusPerColumn * component.v;
    component.samplesPerLine = component.blocksPerLine * 8;
    component.samplesPerColumn = component.blocksPerColumn * 8;
    component.plane = new Uint8ClampedArray(component.samplesPerLine * component.samplesPerColumn);
    component.pixels = new Uint8Array(64);
    dc[i] = 0;
  }

  const restartInterval = frame.restartInterval || total;
  while (mcu < total) {
    if (frame.restartInterval && mcu > 0 && mcu % frame.restartInterval === 0) {
      reader.skipToMarker();
      for (let i = 0; i < components.length; i++) dc[i] = 0;
      // 对齐到下一个标记之后
      while (reader.pos < buffer.length - 1 && !(buffer[reader.pos] === 0xff && buffer[reader.pos + 1] >= 0xd0 && buffer[reader.pos + 1] <= 0xd7)) {
        reader.pos++;
      }
      reader.pos += 2;
    }
    const row = Math.floor(mcu / mcusPerLine);
    const col = mcu % mcusPerLine;
    mcu++;

    for (let ci = 0; ci < components.length; ci++) {
      const component = components[ci];
      const dcTable = huffDC[component.dcId];
      const acTable = huffAC[component.acId];
      if (!dcTable || !acTable) return null;
      for (let v = 0; v < component.v; v++) {
        for (let h = 0; h < component.h; h++) {
          const value = decodeBlock(reader, component, quantTables, dcTable, acTable, dc[ci]);
          if (value === null) return null;
          dc[ci] = value;
          idct(BLOCK, quantTables[component.quantId], component.pixels);
          const originX = (col * component.h + h) * 8;
          const originY = (row * component.v + v) * 8;
          for (let y = 0; y < 8; y++) {
            const target = (originY + y) * component.samplesPerLine + originX;
            component.plane.set(component.pixels.subarray(y * 8, y * 8 + 8), target);
          }
        }
      }
    }
    void restartInterval;
  }
  frame.scanned = true;
  return reader.skipToMarker();
}

/**
 * 取一个分量的采样值。
 * 分量比全尺寸小时（4:2:0 里的色度）用双线性插值：直接最近邻会在颜色边缘错开半个像素，
 * 缩略图上看得见。
 */
function sampleComponent(component, x, y, maxH, maxV) {
  const line = component.samplesPerLine;
  if (component.h === maxH && component.v === maxV) {
    return component.plane[y * line + x];
  }
  const clampX = (v) => (v < 0 ? 0 : (v > component.samplesPerLine - 1 ? component.samplesPerLine - 1 : v));
  const clampY = (v) => (v < 0 ? 0 : (v > component.samplesPerColumn - 1 ? component.samplesPerColumn - 1 : v));
  const sx = (x + 0.5) * component.h / maxH - 0.5;
  const sy = (y + 0.5) * component.v / maxV - 0.5;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const ax = clampX(x0);
  const bx = clampX(x0 + 1);
  const ay = clampY(y0);
  const by = clampY(y0 + 1);
  const top = component.plane[ay * line + ax] + (component.plane[ay * line + bx] - component.plane[ay * line + ax]) * fx;
  const bottom = component.plane[by * line + ax] + (component.plane[by * line + bx] - component.plane[by * line + ax]) * fx;
  return top + (bottom - top) * fy;
}

function toRgba(frame) {
  const { width, height, components } = frame;
  const out = Buffer.alloc(width * height * 4);
  const [y, cb, cr] = components;
  // 必须先钳位：往 Buffer 里直接写小数是按 256 取模的，
  // 255.6 会变成 0、-3 会变成 253——单个像素某一个通道整个翻掉，还很难看出是哪里坏了。
  const clamp = (value) => (value < 0 ? 0 : (value > 255 ? 255 : value | 0));
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const d = (row * width + col) * 4;
      if (components.length === 1) {
        const value = sampleComponent(y, col, row, frame.maxH, frame.maxV);
        out[d] = out[d + 1] = out[d + 2] = clamp(value);
        out[d + 3] = 255;
        continue;
      }
      const yy = sampleComponent(y, col, row, frame.maxH, frame.maxV);
      const cbb = sampleComponent(cb, col, row, frame.maxH, frame.maxV) - 128;
      const crr = sampleComponent(cr, col, row, frame.maxH, frame.maxV) - 128;
      out[d] = clamp(yy + 1.402 * crr);
      out[d + 1] = clamp(yy - 0.344136 * cbb - 0.714136 * crr);
      out[d + 2] = clamp(yy + 1.772 * cbb);
      out[d + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * 解一张 JPEG。
 * @returns {{width: number, height: number, data: Buffer}|null} data 是 RGBA
 */
export function decodeJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  const quantTables = {};
  const huffDC = {};
  const huffAC = {};
  let frame = null;
  let restartInterval = 0;
  let offset = 2;

  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    const start = offset + 4;
    const end = offset + 2 + length;
    if (end > buffer.length) return null;

    if (marker === 0xdb) {
      let p = start;
      while (p < end) {
        const spec = buffer[p++];
        const precision = spec >> 4;
        const id = spec & 15;
        const table = new Uint16Array(64);
        const raw = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          raw[i] = precision ? buffer.readUInt16BE(p) : buffer[p];
          p += precision ? 2 : 1;
        }
        // DQT 里是之字序。先把第 i 个值放到它的自然位置上去；
        // 反过来写（table[i] = raw[ZIGZAG[i]]）会让 DC 恰好蒙对、AC 全错。
        for (let i = 0; i < 64; i++) table[ZIGZAG[i]] = raw[i];
        quantTables[id] = table;
      }
    } else if (marker === 0xc4) {
      let p = start;
      while (p < end) {
        const spec = buffer[p++];
        const counts = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          counts.push(buffer[p + i]);
          total += buffer[p + i];
        }
        p += 16;
        const values = buffer.subarray(p, p + total);
        p += total;
        const table = buildHuffmanTable(counts, values);
        if (spec >> 4) huffAC[spec & 15] = table;
        else huffDC[spec & 15] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = buffer.readUInt16BE(start);
    } else if (marker === 0xc0 || marker === 0xc1) {
      const precision = buffer[start];
      const height = buffer.readUInt16BE(start + 1);
      const width = buffer.readUInt16BE(start + 3);
      const count = buffer[start + 5];
      // 采样精度是 8（基线 JPEG 几乎都是 8），不是 0
      if (precision === 8 && width && height && width * height <= MAX_DECODE_PIXELS && count >= 1 && count <= 3) {
        const components = [];
        for (let i = 0; i < count; i++) {
          const p = start + 6 + i * 3;
          components.push({
            id: buffer[p],
            h: buffer[p + 1] >> 4,
            v: buffer[p + 1] & 15,
            quantId: buffer[p + 2],
          });
        }
        if (components.every((c) => c.h >= 1 && c.h <= 4 && c.v >= 1 && c.v <= 4)) {
          frame = {
            width,
            height,
            components,
            maxH: Math.max(...components.map((c) => c.h)),
            maxV: Math.max(...components.map((c) => c.v)),
            restartInterval,
            quantTables,
            huffDC,
            huffAC,
          };
        }
      }
      if (!frame) return null;
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // 渐进式、无损、算术编码、分层：这份解码器不认，老实退回原图
      return null;
    } else if (marker === 0xda) {
      if (!frame) return null;
      frame.restartInterval = restartInterval;
      /*
       * SOS 头里才有「哪个分量用哪两张哈夫曼表」，
       * 漏了这段就等于每张表都查不到，只能干瞪眼返回 null。
       */
      const scanCount = buffer[start];
      for (let i = 0; i < scanCount; i++) {
        const p = start + 1 + i * 2;
        const selector = buffer[p];
        const specs = buffer[p + 1];
        const component = frame.components.find((c) => c.id === selector);
        if (!component) return null;
        component.dcId = specs >> 4;
        component.acId = specs & 15;
      }
      /*
       * 熵编码数据从 SOS 头之后才开始：Ns(1) + 每分量 2 字节 + Ss/Se/AhAl(3)。
       * 把段头也当数据喂进去，位流从第一字节就错位，解出来全是噪点。
       * 它有多长头里不写，要一直读到下一个标记为止，所以上限给到整个文件，
       * 由 BitReader 撞到标记时自己收。
       */
      const dataStart = start + 1 + scanCount * 2 + 3;
      const next = decodeScan(buffer, dataStart, buffer.length, frame);
      if (next === null) return null;
      offset = next;
      continue;
    }
    offset = end;
  }

  if (!frame || !frame.scanned) return null;
  return toRgba(frame);
}
