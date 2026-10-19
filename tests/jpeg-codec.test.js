/**
 * JPEG 解码器：表情包图库里绝大多数是 JPEG，不认它这个优化就等于没做。
 *
 * 夹具是手工拼的最小基线 JPEG，另经系统解码器（GDI+）核对过，两边一致
 * 才拿来当基准（见 tests/helpers/sample-jpeg.js）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeJpeg } from "../lib/jpeg-codec.js";
import { makeBaselineJpeg } from "./helpers/sample-jpeg.js";

test("基线 JPEG 解得对：两个 MCU 的亮度要跟系统解码器一致", () => {
  const decoded = decodeJpeg(makeBaselineJpeg());
  assert.ok(decoded, "自己拼的合法 JPEG 必须能解开");
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 8);
  // 参考值由 GDI+ 解同一份字节得出（128 / 129），别改成"差不多"
  assert.equal(decoded.data[(4 * 16 + 2) * 4], 128, "左边那块");
  assert.equal(decoded.data[(4 * 16 + 14) * 4], 129, "右边那块");
  assert.equal(decoded.data[(4 * 16 + 14) * 4 + 3], 255, "不透明");
});

test("DC 差分跟着量化表走", () => {
  const plain = decodeJpeg(makeBaselineJpeg({ dcDiff: 0 }));
  assert.equal(plain.data[(4 * 16 + 2) * 4], 128);
  assert.equal(plain.data[(4 * 16 + 14) * 4], 128, "差分 0 → 两块一样亮");
  // 同一个夹具把量化步长调大，右边那块就该更亮（40 是 6 类差分，夹具有）
  const bright = decodeJpeg(makeBaselineJpeg({ dcDiff: 40, quantValue: 8 }));
  assert.equal(bright.data[(4 * 16 + 14) * 4], 168, "40×8/8 + 128");
  const dark = decodeJpeg(makeBaselineJpeg({ dcDiff: -40, quantValue: 8 }));
  assert.equal(dark.data[(4 * 16 + 14) * 4], 88, "-40×8/8 + 128");
});

test("通道不许越界：Buffer 赋值是按 256 取模的，255.6 会变成 0", () => {
  // 量化步长拉满：右边那块算出来远超 255 / 远低于 0，都必须钳住
  const bright = decodeJpeg(makeBaselineJpeg({ dcDiff: 63, quantValue: 255 }));
  const dark = decodeJpeg(makeBaselineJpeg({ dcDiff: -32, quantValue: 255 }));
  for (const decoded of [bright, dark]) {
    for (let i = 0; i < decoded.data.length; i++) {
      assert.ok(decoded.data[i] >= 0 && decoded.data[i] <= 255, `第 ${i} 个字节越界了`);
    }
  }
  assert.equal(bright.data[(4 * 16 + 14) * 4], 255, "亮的一块不能被回绕成暗的");
  assert.equal(dark.data[(4 * 16 + 14) * 4], 0, "暗的一块不能被回绕成亮的");
});

test("解不了的老实说解不了，交给路由退回原图", () => {
  assert.equal(decodeJpeg(Buffer.from("not a jpeg at all")), null);
  assert.equal(decodeJpeg(makeBaselineJpeg().subarray(0, 20)), null, "截断的");
  assert.equal(decodeJpeg(makeBaselineJpeg({ sofMarker: 0xc2 })), null, "渐进式这份解码器不认");
});

/**
 * 段被截断的 JPEG 不许抛异常。
 *
 * 2026-10-19 独立审包发现：DQT 分支只判了 `p < end` 就闷头连读 64 项，
 * 一张尾部截断的 JPEG 会让 readUInt16BE 抛 RangeError。走路由那条有 try/catch，
 * 只坏一张图；但后台预热那条一抛就把循环打断，预热槽位永久卡死，
 * 以后新加的图再也补不上缩略图，而且一声不响。
 */
test("段被截断时老实返回 null，不往外抛", () => {
  const whole = makeBaselineJpeg();
  // 从尾部逐字节切，任何一处都不许抛
  for (let cut = 4; cut < whole.length; cut++) {
    let decoded;
    assert.doesNotThrow(() => {
      decoded = decodeJpeg(whole.subarray(0, cut));
    }, `切到第 ${cut} 字节时抛了`);
    if (decoded) assert.ok(decoded.data.length > 0);
  }
  // 段长写小了但后面还有数据：DQT 声明放不下 64 项，也不能读出去
  const lying = Buffer.from(whole);
  const dqtAt = lying.indexOf(Buffer.from([0xff, 0xdb]));
  assert.ok(dqtAt > 0, "夹具里应该有 DQT 段");
  lying.writeUInt16BE(4, dqtAt + 2); // 声明长度 4，实际要 67
  assert.equal(decodeJpeg(lying), null, "段长不够就得当场说解不了");
});

test("SOS 扫描头不够长时也不读出去", () => {
  const whole = makeBaselineJpeg();
  const sosAt = whole.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(sosAt > 0, "夹具里应该有 SOS 段");

  // 把 SOS 的段长改成只放得下 Ns + Ss/Se/AhAl，放不下分量选择子。
  // 旧代码不看段尾，会把 dataStart 算到段外，熵解码拿到的全是空数据。
  const lying = Buffer.from(whole);
  lying.writeUInt16BE(5, sosAt + 2); // 声明长度 5：Ns(1) + 3，够不到每分量的 2 字节
  assert.equal(decodeJpeg(lying), null, "分量选择子放不下就得当场说解不了");

  // 段长连 Ns 都放不下
  const empty = Buffer.from(whole);
  empty.writeUInt16BE(2, sosAt + 2);
  assert.doesNotThrow(() => decodeJpeg(empty));
  assert.equal(decodeJpeg(empty), null);

  // 合法素材照旧能解，不能因为加了守卫就误杀
  assert.ok(decodeJpeg(whole), "正常 JPEG 必须还能解开");
});
