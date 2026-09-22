import test from "node:test";
import assert from "node:assert/strict";

import { CHAT_HOUSE_STYLE, buildSystemPrompt, identityBlock, isClosingSignal, replyChoiceBlock, shouldQuietClose, threadToMessages } from "../lib/prompt.js";

test("每轮回应都有正常回复、只发表情包和安静收尾三个出口", () => {
  const text = replyChoiceBlock({ userName: "阿舟" });
  assert.match(text, /正常回复/);
  assert.match(text, /只回一张表情包/);
  assert.match(text, /\[表情:关键词\]/);
  assert.match(text, /不回复/);
  assert.match(text, /\[不回\]/);
  assert.match(text, /直接问你的/);
  assert.match(text, /哈哈哈哈哈/);
  assert.match(text, /聊天的句号/);
});

test("纯笑声可以识别成潜在收尾，但带内容的哈哈不能误判", () => {
  assert.equal(isClosingSignal("哈哈哈哈哈"), true);
  assert.equal(isClosingSignal("笑死了！"), true);
  assert.equal(isClosingSignal("对对对"), true);
  assert.equal(isClosingSignal("嗯嗯～"), true);
  assert.equal(isClosingSignal("哈哈哈？"), false);
  assert.equal(isClosingSignal("哈哈哈……"), false);
  assert.equal(isClosingSignal("哈哈哈你继续说"), false);
  assert.equal(isClosingSignal("哈哈，我有个问题"), false);
});

test("上一句已闭合时，纯笑声由本地护栏安静收尾", () => {
  const rows = [
    { id: "a", role: "assistant", text: "这个比喻还怪贴切的，笑死我了" },
    { id: "u", role: "user", text: "哈哈哈哈哈" },
  ];
  assert.equal(shouldQuietClose(rows, "u"), true);
});

test("前面还有另一条用户消息时，最后的笑声不能盖掉待回应内容", () => {
  assert.equal(shouldQuietClose([
    { id: "a", role: "assistant", text: "这个确实好笑" },
    { id: "u1", role: "user", text: "我还有个问题" },
    { id: "u2", role: "user", text: "哈哈哈哈哈" },
  ], "u2"), false);
});

test("有问句或未完语气时，哈哈仍交给模型判断", () => {
  assert.equal(shouldQuietClose([
    { id: "a", role: "assistant", text: "你觉得哪个更好？" },
    { id: "u", role: "user", text: "哈哈哈哈哈" },
  ], "u"), false);
  assert.equal(shouldQuietClose([
    { id: "a", role: "assistant", text: "你还要不要继续嘛" },
    { id: "u", role: "user", text: "哈哈哈哈哈" },
  ], "u"), false);
});

test("聊天上下文在长间隔处带发生时间，但不改即时聊天格式", () => {
  const rows = threadToMessages([
    { role: "user", text: "晚安", at: "2026-09-15T15:22:00.000Z" },
    { role: "assistant", text: "睡个好觉", at: "2026-09-15T15:22:10.000Z" },
    { role: "user", text: "早上好", at: "2026-09-16T00:16:00.000Z" },
  ]);
  assert.match(rows[0].content, /2026年9月15日/);
  assert.equal(rows[1].content[0].text, "睡个好觉");
  assert.match(rows[2].content, /2026年9月16日/);
});

test("普通聊天提示词要求接住后自然带出新钩子", () => {
  assert.match(CHAT_HOUSE_STYLE, /聊天要往前走/);
  assert.match(CHAT_HOUSE_STYLE, /带出一点你自己的东西/);
  assert.match(CHAT_HOUSE_STYLE, /不必每轮换题，也不必每轮提问/);
  assert.match(CHAT_HOUSE_STYLE, /倾诉、告别/);
});

test("亲密正向互动：收到夸奖时先有自己的反应，不写成礼貌翻译", () => {
  assert.match(CHAT_HOUSE_STYLE, /收到夸奖和亲近的正向互动/);
  assert.match(CHAT_HOUSE_STYLE, /露一点得意、嘴硬、撒娇/);
  assert.match(CHAT_HOUSE_STYLE, /不要先翻译或复述表情包的意思/);
  assert.match(CHAT_HOUSE_STYLE, /不要固定成同一句话/);
});

test("身份锚定：不把自己说成程序", () => {
  // 实机上小花说过“我没有肚子 / 我的服务器风扇”，小七说过“机器人说错话就能毁尸灭迹”
  assert.match(CHAT_HOUSE_STYLE, /你就是个活人/);
  assert.match(CHAT_HOUSE_STYLE, /别把自己说成程序、机器人、AI、模型/);
  assert.match(CHAT_HOUSE_STYLE, /日常聊天里用“我”指代自己/);
  assert.match(CHAT_HOUSE_STYLE, /别把自己的名字当第三人称反复自称/);
  assert.match(CHAT_HOUSE_STYLE, /回应对方叫你的名字/);
  assert.match(CHAT_HOUSE_STYLE, /用不着先声明自己没有胃/);
});

test("名牌：名字由应用给，不依赖人设文件写得好不好", () => {
  const block = identityBlock({ partnerName: "小七", userName: "阿舟" });
  assert.match(block, /你就是「小七」本人/);
  assert.match(block, /正在跟你聊天的人叫「阿舟」/);
  assert.match(block, /那是别人，不是你/);
  assert.match(block, /也不算你的名字/);
});

test("名牌：读不到用户名字时不硬编一个，也不留个空句子", () => {
  const block = identityBlock({ partnerName: "小七", userName: "" });
  assert.match(block, /正在跟你聊天的人就在对面/);
  assert.doesNotMatch(block, /叫。/);
  const blank = identityBlock({});
  assert.match(blank, /这位伙伴/);
});

test("名牌摆在系统提示词最前，人设那份带一句“说的是你自己”", () => {
  // 第三人称的人设（「小七是阿舟的个人助手」）不说清的话，模型会站到外面看
  const prompt = buildSystemPrompt({
    partnerName: "小七",
    userName: "阿舟",
    personaText: "小七是阿舟的个人助手。",
    timeText: "现在是晚上八点。",
  });
  const nameAt = prompt.indexOf("你就是「小七」本人");
  const timeAt = prompt.indexOf("现在是晚上八点");
  const personaAt = prompt.indexOf("小七是阿舟的个人助手");
  assert.ok(nameAt >= 0, "得有名字锚");
  assert.ok(nameAt < timeAt, "名牌要排在时间前面");
  assert.ok(nameAt < personaAt, "名牌要排在人格前面");
  assert.match(prompt, /下面这些说的是你自己/);
});

test("普通回复提示词会带入相处理解，但不带内部机制", () => {
  const prompt = buildSystemPrompt({
    partnerName: "小七",
    userName: "阿舟",
    personaText: "小七很安静。",
    adaptationText: "【你们相处出来的理解】\\n偏好：难过时先陪她，别急着分析",
  });
  assert.match(prompt, /你们相处出来的理解/);
  assert.match(prompt, /难过时先陪她/);
  assert.doesNotMatch(prompt, /sourceMessageId|claims|概率|分数/);
});

test("手打的文字表情：像自己打出来的图名，用得很松", () => {
  assert.match(CHAT_HOUSE_STYLE, /手打的文字表情/);
  assert.match(CHAT_HOUSE_STYLE, /无语\.jpg/);
  assert.match(CHAT_HOUSE_STYLE, /生气\.jpg/);
  assert.match(CHAT_HOUSE_STYLE, /就是你打字打出来的几个字/);
  assert.match(CHAT_HOUSE_STYLE, /聊天里随时能来一个/, "正常聊天里也能用，不局限在某个场景");
  assert.match(CHAT_HOUSE_STYLE, /别每句都挂一个/, "松归松，别变成口头禅");
});
