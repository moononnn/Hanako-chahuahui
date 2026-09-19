import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt, passBlock } from "../lib/prompt.js";
import { MAX_PASS_PER_DAY, mayPassToday, notePass } from "../lib/reply.js";

test("「可以不回」那段给了退路，也把退路收窄", () => {
  const text = passBlock({ userName: "阿舟" });
  assert.match(text, /\[不回\]/, "得告诉ta怎么表示不回");
  assert.match(text, /必须回/, "重要的话不许拿这个当借口");
  assert.match(text, /大多数时候你还是会接的/, "不回是偶尔，不是固定姿势");
  assert.match(text, /阿舟/);
  assert.match(text, /不要解释/, "沉默就沉默，别配一段说明");
});

test("这段话只在非面对面那条路上出现", () => {
  const withPass = buildSystemPrompt({
    partnerName: "小七",
    userName: "阿舟",
    passText: passBlock({ userName: "阿舟" }),
  });
  assert.match(withPass, /这条你可以不回/);

  const without = buildSystemPrompt({ partnerName: "小七", userName: "阿舟" });
  assert.doesNotMatch(without, /这条你可以不回/, "面对面聊着不该演已读不回");
});

test("每天最多不回一次，隔天翻篇", () => {
  assert.equal(MAX_PASS_PER_DAY, 1);
  assert.equal(mayPassToday(null, "2026-09-13"), true);
  assert.equal(mayPassToday({ day: "2026-09-12", count: 3 }, "2026-09-13"), true, "昨天用过不算数");

  const once = notePass(null, "2026-09-13");
  assert.deepEqual(once, { day: "2026-09-13", count: 1 });
  assert.equal(mayPassToday(once, "2026-09-13"), false, "今天用过了，接下来必须接");
  assert.equal(notePass(once, "2026-09-13").count, 2);
});
