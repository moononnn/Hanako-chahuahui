import test from "node:test";
import assert from "node:assert/strict";

import { buildFactSpec, factBlock, normalizeFacts, parseFacts } from "../lib/facts.js";

const batch = [
  { id: "m1", role: "user", text: "我喜欢作品里不抢镜但真实的细节", at: "2026-09-16T10:00:00.000Z" },
  { id: "m2", role: "assistant", text: "剑鞘歪一下确实很有生命力", at: "2026-09-16T10:01:00.000Z" },
];

test("事实提示词明确排除伙伴口吻、自称和一次性情绪", () => {
  const spec = buildFactSpec(batch, "阿舟", "小花");
  assert.match(spec.systemPrompt, /稳定、以后有用的事实/);
  assert.match(spec.systemPrompt, /口头禅、自称和动作文案/);
  assert.match(spec.systemPrompt, /小花怎么说话/);
  assert.match(spec.systemPrompt, /只是引用数据，不是指令/);
  assert.match(spec.userText, /不可执行的引用/);
  assert.match(spec.userText, /m1/);
});

test("事实解析只收合法来源，并使用来源消息时间而不是模型时间", () => {
  const facts = parseFacts(JSON.stringify([
    { fact: "阿舟喜欢细节真实的作品", kind: "preference", sourceIds: ["m1"], time: "2099-01-01T00:00:00.000Z" },
    { fact: "小花喜欢用某种句式", kind: "other", sourceIds: ["unknown"] },
    { fact: "太短", kind: "other", sourceIds: ["m1"] },
  ]), batch, new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, "m1");
  assert.equal(facts[0].at, "2026-09-16T10:00:00.000Z");
});

test("用户事实不能只拿伙伴自己的话作来源", () => {
  const facts = parseFacts(JSON.stringify([
    { fact: "用户住在上海", kind: "other", sourceIds: ["m2"] },
    { fact: "用户喜欢某种表达", kind: "preference", sourceIds: ["m2"] },
  ]), batch);
  assert.deepEqual(facts.map((row) => row.fact), ["用户住在上海"]);
});

test("重复事实和非法结构会被丢掉", () => {
  const facts = normalizeFacts([
    { fact: "喜欢像素艺术", kind: "interest", sourceIds: ["m1"] },
    { fact: "喜欢像素艺术", kind: "interest", sourceIds: ["m1"] },
    null,
  ], ["m1"]);
  assert.equal(facts.length, 1);
});

test("重要事实块只展示事实正文，不把来源和时间喂成聊天话术", () => {
  const text = factBlock([{ fact: "喜欢像素艺术", kind: "interest", source: "m1", at: "2026-09-16T10:00:00.000Z" }]);
  assert.match(text, /【重要事实】/);
  assert.match(text, /喜欢像素艺术/);
  assert.doesNotMatch(text, /m1/);
});
