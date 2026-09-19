import test from "node:test";
import assert from "node:assert/strict";
import {
  canUnderstandImages,
  effectiveVisionConfig,
  imageBytesMatchMime,
  isStrictBase64,
  modelSupportsImage,
  normalizeVisionConfig,
} from "../lib/vision.js";

test("视觉配置没有模型时一律未验证", () => {
  assert.deepEqual(normalizeVisionConfig({ status: "verified" }), {
    model: null,
    status: "unverified",
    testedAt: null,
    error: null,
  });
});

test("伙伴视觉配置覆盖全局，未验证时不放行", () => {
  const global = { model: { provider: "gemini", model: "gemini-flash-latest" }, status: "verified" };
  const partner = { model: { provider: "x", model: "y" }, status: "unverified" };
  assert.equal(effectiveVisionConfig(global, partner).source, "partner");
  assert.equal(canUnderstandImages(global, partner), false);
});

test("没有伙伴配置时使用已验证的全局模型", () => {
  const global = { model: { provider: "gemini", model: "gemini-flash-latest" }, status: "verified" };
  assert.equal(effectiveVisionConfig(global, null).source, "global");
  assert.equal(canUnderstandImages(global, null), true);
});

test("图片数据必须是真实文件头且 base64 严格合法", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]);
  const encoded = png.toString("base64");
  assert.equal(isStrictBase64(encoded), true);
  assert.equal(isStrictBase64(`${encoded}!`), false);
  assert.equal(imageBytesMatchMime(png, "image/png"), true);
  assert.equal(imageBytesMatchMime(Buffer.from("not-an-image"), "image/png"), false);
  assert.equal(imageBytesMatchMime(png, "image/jpeg"), false);
});

test("模型目录只把明确接收图片的模型列为视觉模型", () => {
  assert.equal(modelSupportsImage({ input: ["text", "image"] }), true);
  assert.equal(modelSupportsImage({ input: ["text"] }), false);
  assert.equal(modelSupportsImage({ image: true }), true);
  assert.equal(modelSupportsImage({ visionCapabilities: {} }), true);
});
