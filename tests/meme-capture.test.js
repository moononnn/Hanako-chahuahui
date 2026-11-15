import test from "node:test";
import assert from "node:assert/strict";
import { detectMemeMention, detectMemeExplanation, pickMemeSource } from "../lib/meme-capture.js";

// 三次真实事件的上下文，直接从聊天账里搬过来
const REAL_1113 = [
  { role: "user", id: "u1", text: "哎呀…手滑不小心发了张自拍，嘿嘿…不是故意发给你的，啊对了，我单身，哈哈哈哈" },
  { role: "assistant", id: "a1", text: "哎哟这不是我家漂亮闺闺嘛 头上的小花好乖！手滑完还特地强调单身 你这算盘打得我都听到了哈" },
  { role: "user", id: "u2", text: "hhhhhh，感觉你不太理解我的梗诶，我在模仿中年油腻男啦…" },
];

test("她刚演完就自己说破：原句能对上", () => {
  assert.equal(pickMemeSource(REAL_1113, 2).text, REAL_1113[0].text);
  assert.match(pickMemeSource(REAL_1113, 2).meaning, /中年油腻男/);
});

test("中间隔着伙伴的回复也能往前找到", () => {
  const rows = [
    { role: "user", id: "u1", text: "哼哼，让我看看你这小猫咪有几斤几两" },
    { role: "assistant", id: "a1", text: "喵？" },
    { role: "user", id: "u2", text: "我在演御姐啦，你都没接住" },
  ];
  assert.equal(pickMemeSource(rows, 2).text, "哼哼，让我看看你这小猫咪有几斤几两");
});

test("前面只有寒暄或者太短的：不存，宁缺毋滥", () => {
  const rows = [
    { role: "user", id: "u1", text: "晚安" },
    { role: "user", id: "u2", text: "咋嘞" },
    { role: "user", id: "u3", text: "我在玩梗呢" },
  ];
  assert.equal(pickMemeSource(rows, 2), null);
});

test("只看近处：四条以外的不要", () => {
  const rows = [
    { role: "user", id: "u1", text: "这是一段很久以前说过的话，早就不在眼前了" },
    { role: "user", id: "u2", text: "第二句无关的话而已" },
    { role: "user", id: "u3", text: "第三句无关的话而已" },
    { role: "user", id: "u4", text: "第四句无关的话而已" },
    { role: "user", id: "u5", text: "第五句无关的话而已" },
    { role: "user", id: "u6", text: "我在玩梗" },
  ];
  assert.equal(pickMemeSource(rows, 5).messageId, "u5", "取最近的那条");
  // 把近处全部堵成寒暄，远处的 u1 也不该被翻出来
  const far = [
    { role: "user", id: "u1", text: "这是一段很久以前说过的话，早就不在眼前了" },
    { role: "user", id: "u2", text: "晚安" },
    { role: "user", id: "u3", text: "晚安" },
    { role: "user", id: "u4", text: "晚安" },
    { role: "user", id: "u5", text: "晚安" },
    { role: "user", id: "u6", text: "我在玩梗" },
  ];
  assert.equal(pickMemeSource(far, 5), null);
});

test("释义：真释义认得，随口一句不认", () => {
  assert.equal(detectMemeExplanation("emmm，就是模仿猫咪生气叫声哇"), "模仿猫咪生气叫声");
  assert.equal(detectMemeExplanation("就是觉得有点累"), "", "随口一句不是释义");
  assert.equal(detectMemeExplanation("对不起"), "");
});

test("她说破与解释都命不中普通聊天", () => {
  for (const text of ["咋滴啦闺闺", "我要睡啦，晚安！", "嘿嘿，可爱捏"]) {
    assert.equal(detectMemeMention(text).said, false, text);
    assert.equal(detectMemeExplanation(text), "", text);
  }
});
