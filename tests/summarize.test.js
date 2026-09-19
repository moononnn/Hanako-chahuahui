import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanSummary,
  dailySpec,
  isUsableSummary,
  profileSpec,
  isProfileIdentitySafe,
  runSummary,
  segmentSpec,
} from "../lib/summarize.js";

const msg = (role, text) => ({ role, text, at: "2026-09-12T01:00:00.000Z" });

test("洗掉「摘要：」这类前缀", () => {
  assert.equal(cleanSummary("摘要：聊了插件的事"), "聊了插件的事");
  assert.equal(cleanSummary("总结:她有点累"), "她有点累");
  assert.equal(cleanSummary("更新后的完整档案：她叫我小花"), "她叫我小花");
});

test("洗掉引号和 markdown 装饰", () => {
  assert.equal(cleanSummary("「她说想做个聊天应用」"), "她说想做个聊天应用");
  assert.equal(cleanSummary("- 第一件事\n- 第二件事"), "第一件事 第二件事");
  assert.equal(cleanSummary("**重点**：她累了"), "重点：她累了");
  assert.equal(cleanSummary("## 标题\n正文"), "标题 正文");
});

test("摘要和日账折成一行，档案允许分段", () => {
  assert.equal(cleanSummary("第一句。\n第二句。", "segment"), "第一句。 第二句。");
  assert.equal(cleanSummary("第一段\n\n第二段", "profile"), "第一段\n\n第二段");
});

test("超长会截断并带上省略号", () => {
  const long = "字".repeat(400);
  const out = cleanSummary(long, "segment");
  assert.equal(out.length, 240);
  assert.ok(out.endsWith("…"));
});

test("太短或空的当没写出来", () => {
  assert.equal(cleanSummary(""), "");
  assert.equal(cleanSummary("   "), "");
  assert.equal(isUsableSummary(""), false);
  assert.equal(isUsableSummary("好"), false);
  assert.equal(isUsableSummary("聊了插件的事"), true);
  // 档案门槛更高
  assert.equal(isUsableSummary("挺好", "profile"), false);
  assert.equal(isUsableSummary("她叫我小花，喜欢薄荷绿。", "profile"), true);
});

test("段落摘要取材里带上双方的话", () => {
  const spec = segmentSpec([msg("user", "在吗"), msg("assistant", "在呢")], "阿舟");
  assert.equal(spec.kind, "segment");
  assert.match(spec.userText, /阿舟：在吗/);
  assert.match(spec.userText, /我：在呢/);
});

test("日账 prompt 里带上日期标签", () => {
  const spec = dailySpec([msg("user", "今天好累")], "2026-09-12", "阿舟");
  assert.match(spec.userText, /9月12日/);
  assert.match(spec.userText, /今天好累/);
});

test("档案 prompt 空档案时说清是第一版", () => {
  const spec = profileSpec("", [msg("user", "我喜欢螺蛳粉")], "阿舟", "", "小七");
  assert.match(spec.userText, /第一版/);
  assert.match(spec.userText, /当前伙伴：小七/);
  assert.match(spec.userText, /阿舟：我喜欢螺蛳粉/);
  const spec2 = profileSpec("她叫我小花", [msg("user", "加一句话")], "阿舟", "", "小七");
  assert.match(spec2.userText, /现在的档案：\n她叫我小花/);
});

test("profile 摘要明确区分用户自称和伙伴身份", () => {
  const spec = profileSpec("", [msg("user", "我叫小花"), msg("assistant", "你好")], "阿舟", "", "小七");
  assert.match(spec.systemPrompt, /用户说「我叫……」时，那是用户在说自己/);
  assert.match(spec.userText, /阿舟：我叫小花/);
  assert.match(spec.userText, /小七：你好/);
});

test("profile 身份校验只拦错误的伙伴自称", () => {
  assert.equal(isProfileIdentitySafe("我叫小七，喜欢安静。", "小七"), true);
  assert.equal(isProfileIdentitySafe("我叫小花，喜欢安静。", "小七"), false);
  assert.equal(isProfileIdentitySafe("我是小花，喜欢安静。", "小七"), false);
  assert.equal(isProfileIdentitySafe("她叫我小花。", "小七"), true);
  assert.equal(isProfileIdentitySafe("她说：我叫小花。", "小七"), true);
});

test("档案 prompt 会把主对话框那边记着的「关于她的事」也带进来", () => {
  const spec = profileSpec("", [], "阿舟", "阿舟是独立开发者，喜欢像素艺术。");
  assert.match(spec.userText, /主对话框那边一直记着的/);
  assert.match(spec.userText, /喜欢像素艺术/);
  assert.match(spec.userText, /还没怎么聊过/, "这边没聊过也要能起一版底稿");
  const without = profileSpec("", [msg("user", "在吗")], "阿舟");
  assert.doesNotMatch(without.userText, /主对话框那边一直记着的/, "那边没料就不摆这一块");
  assert.match(without.userText, /最近在茶话会里聊过的/);
});

test("runSummary 拿到好结果就返回洗过的文本", async () => {
  const ask = async () => "摘要：聊了插件的事，她有点累。";
  const result = await runSummary(ask, segmentSpec([msg("user", "累")]));
  assert.equal(result.ok, true);
  assert.equal(result.text, "聊了插件的事，她有点累。");
});

test("runSummary 遇到空回不算成功，也不写空账", async () => {
  const result = await runSummary(async () => "   ", segmentSpec([msg("user", "x")]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-short");
});

test("runSummary 模型报错不抛出，只回报失败", async () => {
  const result = await runSummary(async () => {
    throw new Error("模型炸了");
  }, segmentSpec([msg("user", "x")]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "threw");
  assert.equal(result.error, "模型炸了");
});

test("没有 spec 直接返回失败，不发请求", async () => {
  let called = false;
  const result = await runSummary(async () => {
    called = true;
    return "x";
  }, null);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});
