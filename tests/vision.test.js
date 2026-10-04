import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canUnderstandImages,
  classifyVisionFailure,
  effectiveVisionConfig,
  imageBytesMatchMime,
  isStrictBase64,
  modelSupportsImage,
  normalizeVisionConfig,
  partnerOfflineNotice,
  shouldTryVisionFallback,
  visionUnavailableNotice,
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

test("识图预算给的是「思考 + 描述」，空正文在同路加预算重试一次", () => {
  // 踩过的坑（2026-10-03 / 10-04）：MiniMax M3.1 Flash 这类思考很重的模型，
  // 500（动图 900、测试 40）会被思考吃光，正文一个字不剩，表现为超时或没说明。
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /maxTokens:\s*40\b/);
  assert.doesNotMatch(source, /maxTokens:\s*prepared\.animated\s*\?\s*900\s*:\s*500/);
  assert.match(source, /const base = prepared\.animated \? 3600 : 2400;/);
  // 首选路与备用通道都不再拿 500/900 去撞思考
  assert.doesNotMatch(source, /maxTokens: prepared\.animated \? 900 : 500/);
  // 空正文重试只用新编号、不换模型不换通道，预算翻倍，最多两次
  assert.match(source, /maxTokens: attempt === 0 \? base : base \* 2/);
  assert.match(source, /chahuahui_image_\$\{Date\.now\(\)\.toString\(36\)\}/);
  assert.match(source, /vision\.retry\.empty/);
  // 测试识图同样要给足预算，别再让 40 去撞思考
  assert.match(source, /maxTokens: 800/);
});

test("识图挂了就换备用通道，但只在真挂时换", () => {
  // 配额、凭据、provider：不会自己好，备用通道该顶就顶
  assert.equal(shouldTryVisionFallback("quota"), true);
  assert.equal(shouldTryVisionFallback("provider"), true);
  // 超时、断网：首选视觉多半还在等，换眼睛会让 ta 在两套描述之间晃
  assert.equal(shouldTryVisionFallback("transient"), false);
  assert.equal(shouldTryVisionFallback("别的"), false);
});

test("备用通道能不能识图：不许拿目录里的宿主焦点模型当答案", () => {
  // 实测（2026-10-02）：目录里 isCurrent 的是 codex/gpt-6.1-sol，
  // 而 utility 通道实际走 MiniMax。拿 isCurrent 去推断 utility 用哪个模型，
  // 会直接把这条例路封死（实测就是被判成「备用通道看不了图」）。
  const source = fs.readFileSync(new URL("../lib/vision.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /visionFallbackModel|pickFromCatalog/);
  assert.doesNotMatch(source, /备用通道模型看不了图/);
});

test("识图失败按原因分类：配额、连接、其他分开", () => {
  assert.equal(classifyVisionFailure(new Error("You've hit your usage limit. Try again later.")), "quota");
  assert.equal(classifyVisionFailure({ status: 429, message: "rate limit exceeded" }), "quota");
  assert.equal(classifyVisionFailure(new Error("fetch failed")), "network");
  assert.equal(classifyVisionFailure(new Error("read ECONNRESET")), "network");
  assert.equal(classifyVisionFailure(new Error("模型没有返回图片说明")), "unknown");
  assert.equal(classifyVisionFailure(null), "unknown");
});

test("提示文案说清三件事：谁接不上、为什么、发出去的还在", () => {
  const quota = visionUnavailableNotice("quota", "沈叙");
  assert.match(quota, /^沈叙这会儿接不上话了/);
  assert.match(quota, /额度/);
  assert.match(quota, /存下来/);
  // 不许说「ta 会自己来接上」：没人排回复，这句是空承诺。
  // 得指一条她真能做的事——额度回来再发一次。
  assert.match(quota, /再发一次/);
  assert.doesNotMatch(quota, /自己来接上/);
  const network = visionUnavailableNotice("network", "沈叙");
  assert.match(network, /没连上/);
  assert.match(network, /再发一次/);
  assert.doesNotMatch(network, /额度/);
  const unknown = visionUnavailableNotice("unknown", "");
  assert.match(unknown, /^ta这会儿/);
  assert.match(unknown, /再发一次/);
  // 认不出具体原因时得给个能对号的方向，不能只说“没能看清”
  assert.match(unknown, /多半是模型或网络/);
  assert.doesNotMatch(unknown, /它/);
});

test("ta 接不上话时的那条：说清谁、为什么、发出去的在", () => {
  const quota = partnerOfflineNotice("quota", "沈叙", { random: () => 0 });
  assert.match(quota, /^沈叙这会儿也说不出话/);
  assert.match(quota, /额度用完/);
  assert.match(quota, /存着|记着/);
  assert.match(quota, /不用重发|自然会接|会自己来接上/);
  const provider = partnerOfflineNotice("provider", "沈叙", { random: () => 0 });
  assert.match(provider, /模型那边用不了/);
  // 这一条不是 ta 说的话（ta 一个字都没说出来），所以不许写成 ta 的自述
  assert.doesNotMatch(provider, /不是沈叙不想理你|我这会儿发不出声/);
  const transient = partnerOfflineNotice("transient", "", { random: () => 0 });
  assert.match(transient, /^ta这会儿接不上话/);
  assert.doesNotMatch(transient, /它/);
  // 认不出来的 kind 走临时那档，不空、不报错
  assert.match(partnerOfflineNotice("别的", "沈叙", { random: () => 0 }), /沈叙/);
  // 备选句挑得到，不至于永远同一句
  assert.notEqual(partnerOfflineNotice("quota", "沈叙", { random: () => 0.99 }), quota);
});
