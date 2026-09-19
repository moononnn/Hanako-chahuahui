import test from "node:test";
import assert from "node:assert/strict";

import { canAnswerPoke, pokeStreak } from "../lib/poke.js";
import { threadToMessages } from "../lib/prompt.js";
import { encodeStickerBubble } from "../lib/stickers.js";

// 文案部分全在 lib/actions.js，这里只管**闭环**：
// 她做了一个动作，伙伴只用动作回（还一个，或不回）；不许拿话去接，也不许硬找话题。

const poke = (from) => ({ kind: "poke", from });
const action = (from, actionId = "hug") => ({ kind: "action", actionId, from });
const word = (role) => ({ role, text: "说了句话" });

test("数末尾连着几条动作（新旧两种记号都算）", () => {
  assert.equal(pokeStreak([]), 0);
  assert.equal(pokeStreak([word("user"), poke("partner")]), 1);
  assert.equal(pokeStreak([poke("partner"), action("user")]), 2);
  assert.equal(pokeStreak([action("partner"), poke("user"), action("partner")]), 3);
  assert.equal(pokeStreak([poke("partner"), poke("user"), word("user")]), 0);
});

test("中间夹了正经话，就重新算一轮", () => {
  assert.equal(pokeStreak([poke("partner"), poke("user"), action("partner"), word("user")]), 0);
});

test("来回两轮之后就不许再接了（以戳对戳收场）", () => {
  assert.equal(canAnswerPoke([action("partner")]), true);
  assert.equal(canAnswerPoke([action("partner"), action("user")]), true);
  assert.equal(canAnswerPoke([action("partner"), action("user"), action("partner")]), false);
  assert.equal(canAnswerPoke([poke("partner"), poke("user"), poke("partner")]), false);
  assert.equal(canAnswerPoke([poke("partner"), poke("user"), action("partner"), word("user")]), true);
});

test("动作不进上下文：它不是话，塞进去只会被接住或被模仿", () => {
  const rows = threadToMessages([
    { role: "user", text: "在干嘛呀" },
    { role: "user", kind: "action", text: "阿舟戳了戳你的杯沿，凉掉的茶面轻轻晃了一圈" },
    { role: "assistant", kind: "poke", text: "小花戳了戳你的肚皮" },
    { role: "user", text: "小花？" },
  ]);
  const flat = rows.map((r) => (r.role === "user" ? r.content : r.content[0].text));
  assert.deepEqual(flat, ["在干嘛呀", "小花？"], "正经话留着，动作两条都不进");
  assert.equal(threadToMessages([{ role: "user", kind: "action", text: "戳了一下" }]).length, 0);
});

// 她发的表情包在上下文里不能只剩"[表情]"两个字。
// 标签从本地图库查，不靠看图，没配视觉模型也读得懂。
test("表情包进上下文：靠本地标签翻成人话，不靠看图", () => {
  const labels = new Map([["local_ab", "委屈、墙角"]]);
  const sticker = (id) => ({ kind: "sticker", text: "[表情]", bubbles: [encodeStickerBubble(id)] });
  const rows = threadToMessages(
    [
      { role: "user", text: "在吗" },
      { role: "user", ...sticker("local_ab") },
      { role: "assistant", ...sticker("stk_9") },
    ],
    24,
    { userName: "阿舟", describeSticker: (id) => labels.get(id) ?? null },
  );
  assert.equal(rows[0].content, "在吗");
  assert.equal(rows[1].content, "［阿舟发来一张表情包，是「委屈、墙角」的意思］");
  assert.equal(
    rows[2].content[0].text,
    "[表情]",
    "查不到标签就退回原样，不自己编一个意思出来",
  );
});

test("文字和表情包一起发时，模型上下文保留两者", () => {
  const rows = threadToMessages([
    {
      role: "user",
      kind: "sticker",
      text: "我错了我错了",
      bubbles: ["我错了我错了", encodeStickerBubble("local_ab")],
    },
  ], 24, { userName: "阿舟", describeSticker: (id) => id === "local_ab" ? "委屈" : null });
  assert.equal(rows[0].content, "我错了我错了\n［阿舟发来一张表情包，是「委屈」的意思］");
});

test("图片说明与文字之间是真换行，不把反斜杠 n 喂给模型", () => {
  const rows = threadToMessages([{ role: "user", text: "你看这个", visionNote: "一只圆宝" }]);
  assert.equal(rows[0].content, "你看这个\n［图片说明：一只圆宝］");
});

test("表情包进上下文：没传查标签的口子时，行为跟以前一样", () => {
  const rows = threadToMessages([
    { role: "user", kind: "sticker", text: "[表情]", bubbles: [encodeStickerBubble("local_ab")] },
  ]);
  assert.equal(rows[0].content, "[表情]");
});
