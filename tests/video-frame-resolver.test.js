import test from "node:test";
import assert from "node:assert/strict";
import { ffmpegCandidates, resolveVideoFfmpeg } from "../lib/video-frame-reader.js";

test("真实候选表超过64也不突破宿主请求上限", async () => {
  const calls = [];
  const candidates = ffmpegCandidates({ homedir: "example-home", env: { APPDATA: "example-appdata" } });
  assert.ok(candidates.length > 64);
  const result = await resolveVideoFfmpeg(async ({ candidates: batch }) => {
    assert.ok(batch.length >= 1 && batch.length <= 64);
    calls.push(batch);
    return null;
  }, { candidates });
  assert.equal(result, null);
  assert.deepEqual(calls.flat(), [...new Set(candidates)]);
  assert.equal(calls[0][0], "ffmpeg");
});

test("后批次安装位置仍能命中，不能简单截断64项", async () => {
  const candidates = Array.from({ length: 136 }, (_, n) => `candidate-${n}`);
  const calls = [];
  const result = await resolveVideoFfmpeg(async ({ candidates: batch }) => {
    calls.push(batch);
    return batch.includes("candidate-130") ? { path: "resolved-binary" } : null;
  }, { candidates });
  assert.equal(result.path, "resolved-binary");
  assert.deepEqual(calls.map(batch => batch.length), [64, 64, 8]);
});

test("首批找到即停，重复候选不再查第二遍", async () => {
  let calls = 0;
  await resolveVideoFfmpeg(async ({ candidates }) => {
    calls++;
    assert.deepEqual(candidates, ["ffmpeg", "other"]);
    return { path: "ffmpeg" };
  }, { candidates: ["ffmpeg", "ffmpeg", "other"] });
  assert.equal(calls, 1);
});

test("各批共享剩余预算，到点不再开始下一批", async () => {
  let left = 1000;
  let calls = 0;
  await assert.rejects(resolveVideoFfmpeg(async () => { calls++; left = 0; return null; }, {
    candidates: Array.from({ length: 70 }, (_, n) => `candidate-${n}`), remainingMs: () => left,
  }), /超时/u);
  assert.equal(calls, 1);
});

test("真实权限或schema错误不吞掉、不用其他通道绕过", async () => {
  const expected = Object.assign(new Error("denied"), { code: "APP_CAPABILITY_DENIED" });
  let calls = 0;
  await assert.rejects(resolveVideoFfmpeg(async () => { calls++; throw expected; }), error => error === expected);
  assert.equal(calls, 1);
});
