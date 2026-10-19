/**
 * 测试用的最小基线 JPEG。
 *
 * 项目里没有 JPEG 编码器可用，所以按规范一段段写字节。拼出来的样本另经
 * 系统解码器（GDI+）核对过——同一份字节，两边解出来都是左边 128、右边 129，
 * 才拿来当解码器的基准。
 *
 * 单独放一个文件，是给 jpeg-codec 和 sticker-thumb 两组用例共用一份夹具。
 */

function segment(marker, payload) {
  const head = Buffer.from([0xff, marker]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([head, len, payload]);
}

/** 按长度把位串摆正：高位在前。 */
function bitsOf(value, length) {
  const out = [];
  for (let i = length - 1; i >= 0; i--) out.push((value >> i) & 1);
  return out;
}

/**
 * DC 表给三个符号：0（差分 0）、3、6（各再读 3 位 / 6 位）。
 * 码长 1 只容得下一个码字，第二个必须是码长 2，第三个码长 3。
 * 覆盖 ±63 的差分，够夹具用了。
 */
const DC_CODES = [[0], [1, 0], [1, 1, 0]];
/** 类别 → 第几个码字。符号 0/3/6 各占一个，不能用类别减一去推。 */
const CATEGORY_INDEX = { 0: 0, 3: 1, 6: 2 };

function makeDctTable() {
  const table = Buffer.alloc(20);
  table[0] = 0x00;
  table[1] = 1;
  table[2] = 1;
  table[3] = 1;
  table[17] = 0;
  table[18] = 3;
  table[19] = 6;
  return table;
}

/** 差分写成规范码：值 0 就是 '0'，其余按位长选码字。 */
function encodeDc(value) {
  if (value === 0) return DC_CODES[0];
  let category = 0;
  for (let v = Math.abs(value); v > 0; v >>= 1) category++;
  const index = CATEGORY_INDEX[category];
  if (index === undefined) throw new Error(`夹具不支持 ${category} 类的 DC 差分`);
  const payload = value < 0 ? value + (1 << category) - 1 : value;
  return [...DC_CODES[index], ...bitsOf(payload, category)];
}

/**
 * 灰度 16×8、两个 MCU 的最小基线 JPEG。
 * 左边一块恒为 128，右边一块是 128 + dcDiff×quantValue/8（会被 IDCT 四舍五入）。
 */
export function makeBaselineJpeg({ sofMarker = 0xc0, dcDiff = 5, quantValue = 1 } = {}) {
  const quant = Buffer.alloc(65);
  quant[0] = 0x00;
  quant.fill(quantValue, 1);

  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(8, 1);
  sof.writeUInt16BE(16, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;

  const dcTable = makeDctTable();

  const acTable = Buffer.alloc(18);
  acTable[0] = 0x10;
  acTable[1] = 1;
  acTable[17] = 0x00; // EOB → 码字 '0'

  const sos = Buffer.alloc(6);
  sos[0] = 1;
  sos[1] = 1;
  sos[2] = 0x00;
  sos[3] = 0;
  sos[4] = 63;
  sos[5] = 0;

  const bits = [
    ...encodeDc(0), 0, // MCU0：DC 差分 0 + EOB
    ...encodeDc(dcDiff), 0, // MCU1：DC 差分 + EOB
  ];
  while (bits.length % 8 !== 0) bits.push(1); // 末尾补 1，是 JPEG 的规矩
  const scan = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => { scan[i >> 3] |= bit << (7 - (i & 7)); });

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, quant),
    segment(sofMarker, sof),
    segment(0xc4, dcTable),
    segment(0xc4, acTable),
    segment(0xda, sos),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}
