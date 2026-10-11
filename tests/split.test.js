import test from "node:test";
import assert from "node:assert/strict";

import { splitReply, stripTimeHeader } from "../lib/split.js";

test("按标点切分成多条气泡", () => {
  const out = splitReply("今天下雨了。你带伞没？我带了两把！");
  assert.deepEqual(out, ["今天下雨了", "你带伞没？", "我带了两把！"]);
});

test("结尾没有标点的残句不能丢", () => {
  const out = splitReply("我想说的是。其实还行");
  assert.deepEqual(out, ["我想说的是", "其实还行"]);
});

test("成对符号内部不断句", () => {
  const out = splitReply("他说的（其实我也没听懂。真的）。你信吗？");
  assert.equal(out.length, 2);
  assert.match(out[0], /其实我也没听懂。真的/);
});

test("代码块整体不拆", () => {
  const raw = "看这个\n```\nconst a = 1;\nconst b = 2;\n```\n完了";
  const out = splitReply(raw);
  assert.equal(out.length, 1);
  assert.match(out[0], /const a = 1/);
});

test("句末逗号句号被吃掉，问号叹号波浪号保留", () => {
  const out = splitReply("随便啦，。真的~你说呢？");
  assert.deepEqual(out, ["随便啦", "真的~", "你说呢？"]);
});

test("连续的标点跟着上一条一起走（？！不拆散）", () => {
  const out = splitReply("真的吗？！那就这样吧。");
  assert.deepEqual(out, ["真的吗？！", "那就这样吧"]);
});

test("一个字的回复可以单独成条", () => {
  const out = splitReply("我先走了。嗯");
  assert.deepEqual(out, ["我先走了", "嗯"]);
});

test("条数超上限时并尾巴", () => {
  const out = splitReply("一。二。三。四。五。六。七。八。", { maxBubbles: 3 });
  assert.equal(out.length, 3);
});

test("空输入返回空数组", () => {
  assert.deepEqual(splitReply("   "), []);
  assert.deepEqual(splitReply(null), []);
});

test("一个问号、一个感叹号能单独成条（催人的时候就这样）", () => {
  assert.deepEqual(splitReply("？\n？"), ["？", "？"]);
  assert.deepEqual(splitReply("人呢？\n？\n？\n别装死"), ["人呢？", "？", "？", "别装死"]);
  // 省略号这种还是不成条（真人不会单独发一个「……」）：滤完没剩什么，就整段当一条交回去
  assert.deepEqual(splitReply("真的。……"), ["真的。……"]);
});

test("没有标点的长句也会成为一条", () => {
  const out = splitReply("就是随口说两句没什么大事");
  assert.deepEqual(out, ["就是随口说两句没什么大事"]);
});

test("正文顶上那个时间戳标题先摘掉（deepseek-flash 实机每条都带）", () => {
  const out = splitReply("【2026年10月10日 15:00】\n睡得还行就行，这条先翻过去。");
  assert.deepEqual(out, ["睡得还行就行，这条先翻过去"]);
  assert.deepEqual(splitReply("【2026-10-10 15:01】怕我憋坏，还是自己想得慌"), ["怕我憋坏，还是自己想得慌"]);
  assert.deepEqual(stripTimeHeader("【现在】\n【15:00】\n下午 3 点 06 分。"), "下午 3 点 06 分。");
  // 整段只有一个标题：没话可说，交回空数组让上层按空回复处理
  assert.deepEqual(splitReply("【2026年10月10日 15:00】"), []);
});

test("当情绪用的方括号不动，剥壳只认死形状", () => {
  assert.deepEqual(splitReply("【生气】你今天话真多"), ["【生气】你今天话真多"]);
  assert.deepEqual(splitReply("【明天见】早点睡"), ["【明天见】早点睡"]);
  assert.deepEqual(stripTimeHeader("【小声】这事别往外说。"), "【小声】这事别往外说。");
  // 不是开头也不剥：正文中提到日期是人家聊天的一部分
  assert.deepEqual(splitReply("你昨天不是说 15:00 见面吗"), ["你昨天不是说 15:00 见面吗"]);
});
