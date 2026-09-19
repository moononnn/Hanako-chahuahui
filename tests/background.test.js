import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BACKGROUND_TONES,
  DEFAULT_OPACITY,
  detectImageType,
  isOwnBackgroundFile,
  listBackgrounds,
  normalizeBackground,
  normalizeBackgroundOpacityMap,
  normalizeOpacity,
  normalizeTone,
  readBackgroundBytes,
  removeBackgroundFile,
  writeBackground,
} from "../lib/background.js";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(64)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(64),
]);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-bg-"));
}

function filesIn(dir) {
  try {
    return fs.readdirSync(path.join(dir, "backgrounds"));
  } catch {
    return [];
  }
}

// ── 认图片头 ──

test("认得 PNG / JPEG / GIF / WebP，别的都不认", () => {
  assert.equal(detectImageType(PNG), "image/png");
  assert.equal(detectImageType(JPEG), "image/jpeg");
  assert.equal(detectImageType(GIF), "image/gif");
  assert.equal(detectImageType(WEBP), "image/webp");
  // 改了后缀的文本文件不能混进来
  assert.equal(detectImageType(Buffer.from("这其实是个文本文件.jpg")), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(null), null);
});

// ── 浓度归一化 ──

test("浓度只认那三档，别的一律回到默认", () => {
  for (const tone of BACKGROUND_TONES) assert.equal(normalizeTone(tone), tone);
  assert.equal(normalizeTone("ultra"), "medium");
  assert.equal(normalizeTone(undefined), "medium");
  assert.equal(normalizeTone(null), "medium");
});

// ── 落盘与读取 ──

test("写进去读得回来；文件名不是拿 agentId 直接拼的", () => {
  const dir = tempDir();
  const written = writeBackground(dir, "huahua", PNG);
  assert.equal(written.type, "image/png");
  assert.match(written.file, /^[a-f0-9]{16}\.png$/);
  assert.ok(!written.file.includes("huahua"), "文件名不该带原 id，免得斜杠点号爬出目录");
  assert.deepEqual(readBackgroundBytes(dir, written.file), PNG);
});

test("共享图库：不同伙伴上传同一张图只保留一份", () => {
  const dir = tempDir();
  const first = writeBackground(dir, "huahua", PNG);
  const second = writeBackground(dir, "yuyue", PNG);
  assert.equal(first.file, second.file);
  assert.equal(filesIn(dir).length, 1);
  assert.equal(listBackgrounds(dir).length, 1);
});

test("不是图片不收，超大的也不收", () => {
  const dir = tempDir();
  assert.throws(() => writeBackground(dir, "huahua", Buffer.from("不是图")), /不是图片/);
  assert.throws(() => writeBackground(dir, "huahua", Buffer.alloc(0)), /空的/);
  const huge = Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(12 * 1024 * 1024)]);
  assert.throws(() => writeBackground(dir, "huahua", huge), /太大/);
  assert.equal(filesIn(dir).length, 0, "被拒的那几次不该留下半张图");
});

test("清掉背景：文件没了，之后再读就是读不到", () => {
  const dir = tempDir();
  const written = writeBackground(dir, "huahua", PNG);
  assert.equal(removeBackgroundFile(dir, written.file), true);
  assert.equal(filesIn(dir).length, 0);
  assert.equal(readBackgroundBytes(dir, written.file), null);
  // 本来就没有的话，返回 false 不报错
  assert.equal(removeBackgroundFile(dir, written.file), false);
});

// ── 文件名归属 ──

test("只认自己的文件名：别人的、爬目录的、格式不对的全挡掉", () => {
  const dir = tempDir();
  const mine = writeBackground(dir, "huahua", PNG);
  assert.equal(isOwnBackgroundFile("huahua", mine.file), true);
  assert.equal(isOwnBackgroundFile("yuyue", mine.file), true, "共享图库里的图可被其他伙伴使用");
  assert.equal(isOwnBackgroundFile("huahua", "../../secret.png"), false);
  assert.equal(isOwnBackgroundFile("huahua", "huahua.png"), false);
  assert.equal(isOwnBackgroundFile("huahua", ""), false);
});

// ── 设置归一化 ──

test("设置里指向一张不在了的图，就当没设过", () => {
  const dir = tempDir();
  const written = writeBackground(dir, "huahua", PNG);
  const good = normalizeBackground({ ...written, tone: "heavy", at: "2026-09-15T00:00:00.000Z" }, "huahua", dir);
  assert.equal(good.tone, "heavy");
  assert.equal(good.opacity, 76);
  assert.equal(good.file, written.file);

  // 图被删了（她手动清了目录、或者换了台机器）——不该记着一个指向空图的设置
  removeBackgroundFile(dir, written.file);
  assert.equal(normalizeBackground({ ...written, tone: "heavy" }, "huahua", dir), null);

  // 只剩一个形状不对的脏值
  assert.equal(normalizeBackground(null, "huahua", dir), null);
  assert.equal(normalizeBackground({ file: "../../x.png" }, "huahua", dir), null);
  assert.equal(normalizeBackground("heavy", "huahua", dir), null);
});

test("每张背景图的透明度账本只保留合法文件名并归一化数值", () => {
  assert.deepEqual(normalizeBackgroundOpacityMap({
    "0123456789abcdef.png": 18.6,
    "fedcba9876543210.jpg": 130,
    "../../secret.png": 99,
    nope: 40,
  }), {
    "0123456789abcdef.png": 19,
    "fedcba9876543210.jpg": 100,
  });
  assert.deepEqual(normalizeBackgroundOpacityMap(null), {});
});

test("透明度会被收进 0 到 100，旧浓度能换算成默认值", () => {
  assert.equal(normalizeOpacity(-5), 0);
  assert.equal(normalizeOpacity(130), 100);
  assert.equal(normalizeOpacity(undefined, "light"), 34);
  assert.equal(normalizeOpacity(undefined, "heavy"), 76);
  assert.equal(normalizeOpacity(undefined), DEFAULT_OPACITY);
});

test("浓度脏值读出来会归到默认档，不会一路带进界面", () => {
  const dir = tempDir();
  const written = writeBackground(dir, "huahua", PNG);
  const back = normalizeBackground({ ...written, tone: "特别浓" }, "huahua", dir);
  assert.equal(back.tone, "medium");
  assert.equal(back.opacity, 52);
});
