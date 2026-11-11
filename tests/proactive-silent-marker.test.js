import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// [不回] 是模型和程序之间的安静收尾协议。提示词里每个主动由头都可能要求它
// 「只想得出旧话就只输出[不回]」，所以发送路线必须不分由头地认这个标记。
// 2026-11-05 实机：shared 由头生成出 [不回]，因为只拦了 followup 那一条，
// 四个字当正文被存进聊天记录，还推了通知。
test("主动开口的每条由头都吞掉安静收尾标记", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = src.indexOf("async function deliverProactive(");
  const end = src.indexOf("const composed = await composeBubbles", start);
  assert.ok(start > 0 && end > start, "能找到 deliverProactive 这一段");
  const flow = src.slice(start, end);

  const markerAt = flow.indexOf('reason: "no-reply-marker"');
  assert.ok(markerAt > 0, "通用静默拦截得在发送路线上");
  assert.match(flow.slice(Math.max(0, markerAt - 260), markerAt), /if \(isNoReply\(text\)\)/);

  // 视频与登录提醒各有自己的收尾记账，不能被通用拦截抢在前面
  const videoAt = flow.indexOf("if (shareableVideo && isNoReply(text))");
  const loginAt = flow.indexOf("if (videoLoginNotice && isNoReply(text))");
  assert.ok(videoAt > 0 && videoAt < markerAt, "视频分支先跑，候选择冷却");
  assert.ok(loginAt > 0 && loginAt < markerAt, "登录提醒分支先跑，提醒记账不丢");

  // 拦在长度关之前：标记本身四个字符，够 isUsableVoice 的门槛
  const usableAt = flow.indexOf("if (!isUsableVoice(text) && !marker.keyword");
  assert.ok(usableAt > markerAt, "静默标记要在可用性检查之前被拦下");

  // followup 那条保留自己的原因，诊断才分得清是哪种静默
  assert.match(flow, /if \(followup\?\.read && isNoReply\(String\(raw \?\? ""\)\.trim\(\)\)\) \{\n\s+diagnostics\(\{ event: "proactive\.silent", agentId, reason: "read-followup" \}\);/);
});
