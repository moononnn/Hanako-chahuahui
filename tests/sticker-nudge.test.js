import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_SILENCE_LIMIT,
  SILENCE_ROUNDS,
  buildStickerNudge,
  bumpNudgeState,
  isStickerMessage,
  latestUserSignal,
  nudgeStateForToday,
  stickerSilenceRounds,
} from "../lib/sticker-nudge.js";

const user = (text, extra = {}) => ({ role: "user", text, ...extra });
const bot = (text, extra = {}) => ({ role: "assistant", text, ...extra });

test("认出带图的消息：落库记号与 attachment 两种写法", () => {
  assert.equal(isStickerMessage(bot("要得\n[表情]")), true);
  assert.equal(isStickerMessage(bot("[表情]")), true);
  assert.equal(isStickerMessage(user("哈哈", { attachment: { kind: "sticker", stickerId: "stk_001" } })), true);
  // 正文里聊到「[表情]」这三个字不算发过图
  assert.equal(isStickerMessage(bot("你那个 [表情] 标记没生效")), false);
  assert.equal(isStickerMessage(bot("")), false);
  assert.equal(isStickerMessage(null), false);
});

test("沉默轮次只数伙伴说话的回复，碰到发过图的那条就停", () => {
  const rows = [
    bot("在的", {}),
    user("嗯"),
    bot("[表情]"),
    user("然后呢"),
    bot("刚看完"),
    user("哦"),
    bot("确实"),
  ];
  assert.equal(stickerSilenceRounds(rows), 2);
});

test("用户消息、动作消息、召回的空壳都不占轮次", () => {
  const rows = [
    bot("[表情]"),
    { role: "assistant", kind: "action", text: "戳了戳你的肚皮" },
    { role: "assistant", text: "被撤回的那句", recalled: true },
    user("哈哈"),
    user("真的"),
    bot("是嘛"),
  ];
  assert.equal(stickerSilenceRounds(rows), 1);
});

test("一直没发过图时按实际回复条数算，没有回复就是 0", () => {
  assert.equal(stickerSilenceRounds([user("在吗")]), 0);
  assert.equal(stickerSilenceRounds([user("在吗"), bot("在"), user("哦"), bot("咋啦")]), 2);
  assert.equal(stickerSilenceRounds([]), 0);
});

test("她的信号：笑完落地、甩图过来、带内容的哈哈都不算信号", () => {
  assert.equal(latestUserSignal([user("哈哈哈哈哈")]), "closing");
  assert.equal(latestUserSignal([user("笑死")]), "closing");
  assert.equal(latestUserSignal([user("嗯嗯")]), "closing");
  assert.equal(latestUserSignal([user("[表情]", { attachment: { kind: "sticker", stickerId: "stk_001" } })]), "sticker");
  // 后面还挂着具体事，就不是落地信号
  assert.equal(latestUserSignal([user("哈哈哈哈这个 bug 你看了吗？")]), "");
  assert.equal(latestUserSignal([user("我那个需求改完了")]), "");
  assert.equal(latestUserSignal([bot("在的")]), "");
});

test("信号优先于沉默兜底，同一轮只出一条", () => {
  const nudge = buildStickerNudge({ signal: "sticker", silenceRounds: 99, nudgesToday: 0 });
  assert.equal(nudge.kind, "sticker");
  assert.match(nudge.text, /递了张图/);

  const closing = buildStickerNudge({ signal: "closing", silenceRounds: 99, nudgesToday: 0 });
  assert.equal(closing.kind, "closing");
  assert.match(closing.text, /只用一张图收尾/);
});

test("沉默够久才提醒，不足阈值什么都不说", () => {
  assert.equal(buildStickerNudge({ silenceRounds: SILENCE_ROUNDS - 1 }).kind, "");
  const hit = buildStickerNudge({ silenceRounds: SILENCE_ROUNDS });
  assert.equal(hit.kind, "silence");
  assert.match(hit.text, new RegExp(`连着 ${SILENCE_ROUNDS} 轮`));
  // 提醒是放行，不是派活
  assert.match(hit.text, /不是要你补一张/);
});

test("沉默兜底一天只提一次，提过了就不再提", () => {
  assert.equal(buildStickerNudge({ silenceRounds: 12, nudgesToday: DAILY_SILENCE_LIMIT }).kind, "");
  assert.equal(buildStickerNudge({ silenceRounds: 12, nudgesToday: 0 }).kind, "silence");
});

test("沉默账按生活日归零，提过一次就加一", () => {
  assert.deepEqual(nudgeStateForToday(null, "2026-10-26"), { lifeDay: "2026-10-26", count: 0 });
  assert.deepEqual(nudgeStateForToday({ lifeDay: "2026-10-25", count: 3 }, "2026-10-26"), { lifeDay: "2026-10-26", count: 0 });
  assert.deepEqual(nudgeStateForToday({ lifeDay: "2026-10-26", count: 1 }, "2026-10-26"), { lifeDay: "2026-10-26", count: 1 });
  assert.deepEqual(bumpNudgeState({ lifeDay: "2026-10-26", count: 0 }, "2026-10-26"), { lifeDay: "2026-10-26", count: 1 });
  assert.deepEqual(bumpNudgeState({ lifeDay: "2026-10-25", count: 9 }, "2026-10-26"), { lifeDay: "2026-10-26", count: 1 });
});
