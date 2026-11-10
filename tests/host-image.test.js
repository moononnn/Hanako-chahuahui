import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_IMAGE_QUALITIES,
  HOST_IMAGE_RATIOS,
  generateViaHost,
  listHostImageProviders,
  mimeOfImageBytes,
  readHostImageBytes,
  submitHostImage,
  waitForHostImage,
} from "../lib/host-image.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

/** 一个假 ctx：总线记下请求；媒体任务按队列依次回答。 */
function fakeCtx({ submit = null, tasks = [], resources = [], bytes = PNG } = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    ctx: {
      bus: {
        request: async (type, payload, options) => {
          calls.push({ type, payload, options });
          if (submit) return submit;
          return { ok: true, tasks: [{ taskId: "t1", providerId: "openai-codex-oauth", modelId: "gpt-image-2.5-flare" }], batchId: "b1" };
        },
      },
      media: {
        getTask: async (taskId) => {
          const row = tasks[Math.min(index, tasks.length - 1)];
          index += 1;
          return row ?? null;
        },
        getTaskResources: async () => ({ resources }),
      },
      resources: {
        read: async () => ({ content: bytes.toString("base64") }),
      },
    },
  };
}

// ── 提交 ──

test("提交：App 范围必须用 response 投递，不能落任何会话", async () => {
  const { ctx, calls } = fakeCtx();
  await submitHostImage(ctx, { prompt: "一只猫" });
  assert.equal(calls[0].type, "media:generate-image");
  assert.equal(calls[0].payload.scope, "app");
  assert.deepEqual(calls[0].payload.delivery, { mode: "response" });
  assert.equal(calls[0].payload.input.prompt, "一只猫");
  assert.equal(calls[0].payload.input.count, 1);
});

test("提交：有参考图就转成 local-file 引用，并明确说是「改这张」", async () => {
  const { ctx, calls } = fakeCtx();
  await submitHostImage(ctx, { prompt: "头发留长一点", referencePaths: ["D:/data/ref.png"] });
  assert.deepEqual(calls[0].payload.input.referenceImages, [{ kind: "local-file", path: "D:/data/ref.png" }]);
  assert.equal(calls[0].payload.input.imageIntent, "edit");
});

test("提交：没有参考图就不带那些字段，也不写 imageIntent", async () => {
  const { ctx, calls } = fakeCtx();
  await submitHostImage(ctx, { prompt: "一只猫" });
  assert.equal("referenceImages" in calls[0].payload.input, false);
  assert.equal("imageIntent" in calls[0].payload.input, false);
});

test("提交：比例与画质只收宿主认的那几档，其余回默认", async () => {
  const { ctx, calls } = fakeCtx();
  await submitHostImage(ctx, { prompt: "猫", ratio: "16:9", quality: "high" });
  assert.equal(calls[0].payload.input.ratio, "16:9");
  assert.equal(calls[0].payload.input.quality, "high");
  await submitHostImage(ctx, { prompt: "猫", ratio: "7:3", quality: "ultra" });
  assert.equal(calls[1].payload.input.ratio, "1:1");
  assert.equal(calls[1].payload.input.quality, "auto");
  assert.deepEqual(HOST_IMAGE_RATIOS.includes("21:9"), true);
  assert.deepEqual(HOST_IMAGE_QUALITIES.includes("auto"), true);
});

test("提交：不指定 provider/model 时整条省略，跟着宿主默认走", async () => {
  const { ctx, calls } = fakeCtx();
  await submitHostImage(ctx, { prompt: "猫" });
  assert.equal("provider" in calls[0].payload.input, false);
  assert.equal("model" in calls[0].payload.input, false);
  await submitHostImage(ctx, { prompt: "猫", provider: "openai-codex-oauth", model: "gpt-image-2.5-sunburst" });
  assert.equal(calls[1].payload.input.provider, "openai-codex-oauth");
  assert.equal(calls[1].payload.input.model, "gpt-image-2.5-sunburst");
});

test("提交：空提示词当场拒绝", async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(submitHostImage(ctx, { prompt: "  " }), /提示词是空的/);
  await assert.rejects(submitHostImage(ctx, {}), /提示词是空的/);
});

test("提交：宿主没回任务号就说清是没排上", async () => {
  const { ctx } = fakeCtx({ submit: { ok: false, message: "permission denied" } });
  await assert.rejects(submitHostImage(ctx, { prompt: "猫" }), /没有排上.*permission denied/);
});

test("提交：缺总线接口时明说，不去拆一个假任务号", async () => {
  await assert.rejects(submitHostImage({}, { prompt: "猫" }), /尚未提供总线接口/);
});

// ── 等 ──

test("等：跑到完成就停，不白等满超时", async () => {
  const waits = [];
  const { ctx } = fakeCtx({ tasks: [{ taskId: "t1", status: "running" }, { taskId: "t1", status: "completed" }] });
  let clock = 0;
  const task = await waitForHostImage(ctx, "t1", {
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  assert.equal(task.status, "completed");
  assert.equal(waits.length, 1);
});

test("等：超过上限就把最后一次看到的原样交回去，由上层说清楚", async () => {
  const { ctx } = fakeCtx({ tasks: [{ taskId: "t1", status: "running" }] });
  let clock = 0;
  const task = await waitForHostImage(ctx, "t1", {
    timeoutMs: 3000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(task.status, "running");
});

test("等：任务查不到就返回 null", async () => {
  const { ctx } = fakeCtx({ tasks: [null] });
  const task = await waitForHostImage(ctx, "gone", { sleep: async () => {} });
  assert.equal(task, null);
});

test("等：认得出的终态不止一种写法", async () => {
  for (const status of ["completed", "done", "ready", "success", "succeeded", "finished"]) {
    const { ctx } = fakeCtx({ tasks: [{ taskId: "t1", status }] });
    const task = await waitForHostImage(ctx, "t1", { sleep: async () => {} });
    assert.equal(task.status, status);
  }
});

// ── 取图 ──

test("取图：把产出读成字节", async () => {
  const { ctx } = fakeCtx({ resources: [{ name: "a.png", resource: { kind: "local-file", path: "D:/g/a.png" } }] });
  const result = await readHostImageBytes(ctx, "t1");
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.count, 1);
});

test("取图：没有产出文件时说清楚", async () => {
  const { ctx } = fakeCtx({ resources: [] });
  await assert.rejects(readHostImageBytes(ctx, "t1"), /没有产出文件/);
});

// ── 端到端 ──

test("端到端：提交、等完、取图，一路带回 provider 与模型", async () => {
  const { ctx, calls } = fakeCtx({
    tasks: [{ taskId: "t1", status: "completed", providerId: "openai-codex-oauth", modelId: "gpt-image-2.5-flare" }],
    resources: [{ name: "a.png", resource: { kind: "local-file", path: "D:/g/a.png" } }],
  });
  const result = await generateViaHost(ctx, { prompt: "一只猫", sleep: async () => {} });
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.provider, "openai-codex-oauth");
  assert.equal(result.model, "gpt-image-2.5-flare");
  assert.equal(result.taskId, "t1");
  assert.equal(calls[0].type, "media:generate-image");
});

test("端到端：任务失败时把它的 failReason 原样带出来", async () => {
  const { ctx } = fakeCtx({ tasks: [{ taskId: "t1", status: "failed", failReason: "quota exceeded 配额用完" }] });
  await assert.rejects(generateViaHost(ctx, { prompt: "猫", sleep: async () => {} }), /quota exceeded/);
});

test("端到端：等到超时还在跑时，不能装作成功", async () => {
  const { ctx } = fakeCtx({ tasks: [{ taskId: "t1", status: "running" }] });
  await assert.rejects(
    generateViaHost(ctx, { prompt: "猫", timeoutMs: 2000, now: (() => { let c = 0; return () => { c += 1000; return c; }; })(), sleep: async () => {} }),
    /还在跑/,
  );
});

// ── 目录与格式 ──

test("目录：原样问宿主 image_generation 这一格", async () => {
  const calls = [];
  const ctx = { bus: { request: async (type, payload) => { calls.push({ type, payload }); return { providers: {}, selection: null }; } } };
  await listHostImageProviders(ctx);
  assert.equal(calls[0].type, "provider:media-providers");
  assert.deepEqual(calls[0].payload, { capability: "image_generation" });
});

test("格式：按魔数认，认不出的一律当 png", () => {
  assert.equal(mimeOfImageBytes(PNG), "image/png");
  assert.equal(mimeOfImageBytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12)])), "image/jpeg");
  assert.equal(mimeOfImageBytes(Buffer.from("GIF89a" + "\0".repeat(8))), "image/gif");
  assert.equal(mimeOfImageBytes(Buffer.concat([Buffer.from("RIFF....WEBP"), Buffer.alloc(4)])), "image/webp");
  assert.equal(mimeOfImageBytes(Buffer.alloc(4)), "image/png");
  assert.equal(mimeOfImageBytes(null), "image/png");
});
