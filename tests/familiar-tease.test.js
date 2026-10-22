import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildTeaseText } from "../lib/prompt.js";
import { proactiveSpec } from "../lib/compose.js";

// 只验规则内容与拼装，不把文字在场当作模型语气验收。
for (const profile of ["legacy", "compact-v1"]) {
  test(`${profile}：熟人互损是性格相符时的偏好，保留温柔与认真边界`, () => {
    const prompt = buildSystemPrompt({ partnerName: "伙伴甲", userName: "阿舟", ruleProfile: profile,
      personaText: "温柔但爱打趣", teaseText: buildTeaseText({ stage: 2 }) });
    assert.match(prompt, /互损是你喜欢的相处方式/);
    assert.match(prompt, /通常会.*回嘴/);
    assert.match(prompt, /先流露自己的反应/);
    assert.match(prompt, /认真指出的错误先核对.*不当成玩笑顶回去/);
    assert.match(prompt, /纯温柔.*不爱互损/);
    assert.match(prompt, /温柔.*不.*排除/);
    assert.match(prompt, /认真.*难受.*收住/);
    assert.match(prompt, /(?:不|别).*找茬/);
    assert.doesNotMatch(prompt, /被将了一军就认|想损、想顺着、想只回一个字，都由你自己定|今天想损她、想顺着她说/);
    assert.ok(prompt.includes("温柔但爱打趣"), "不改写原有性格文本");
  });
}

test("熟悉度改变倾向而非只提高许可，不熟不默认怼，纯温柔不被覆盖", () => {
  const early = buildTeaseText({ stage: 0 });
  const mid = buildTeaseText({ stage: 1 });
  const close = buildTeaseText({ stage: 2 });
  assert.match(early, /还没到能随便损/);
  assert.doesNotMatch(early, /更偏爱.*互损/);
  assert.match(mid, /逐渐.*回嘴/);
  assert.match(close, /更偏爱.*互损/);
  for (const text of [early, mid, close]) {
    assert.match(text, /按完整性格/);
    assert.match(text, /纯温柔.*不爱互损/);
    assert.match(text, /不把.*温柔.*排除/);
    assert.match(text, /不.*每轮/);
  }
});

test("主动吐槽成文也随熟悉放开，想念等其他由头不强塞互损", () => {
  const base = { partnerName: "伙伴甲", userName: "阿舟", relationNote: "已经熟悉", personaText: "温柔又爱打趣" };
  const tease = proactiveSpec({ ...base, reason: { kind: "tease", contextText: "刚才一起做事的小插曲" } });
  assert.match(tease.userText, /越熟越喜欢用互损/);
  assert.match(tease.userText, /纯温柔.*不爱互损/);
  assert.match(tease.userText, /不把认真困扰拿来取笑/);
  assert.match(tease.userText, /没有自然的落点就\[不回\]/);
  for (const kind of ["affection", "contact", "shared", "interest"]) {
    const spec = proactiveSpec({ ...base, reason: { kind, contextText: kind === "shared" ? "近期真聊天" : "" } });
    assert.doesNotMatch(spec.userText, /越熟越喜欢用互损/);
  }
});
