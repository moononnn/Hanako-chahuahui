import test from "node:test";
import assert from "node:assert/strict";

import { ECHO_MIN_STREAK, buildStanceText, echoStreak, hobbyInPlay, isEchoReply, stanceAnchors } from "../lib/stance.js";

// ── 太顺：什么算「纯顺着对方接」 ──

test("纯附和算顺，带自己判断的不算", () => {
  assert.equal(isEchoReply("对对对"), true);
  assert.equal(isEchoReply("嗯嗯，我知道啦"), true);
  assert.equal(isEchoReply("哈哈哈哈哈"), true);
  assert.equal(isEchoReply("好嘛，听你的"), true);
  assert.equal(isEchoReply("确实"), true);
  // 有自己的判断：不算顺
  assert.equal(isEchoReply("我觉得这样不太行"), false);
  assert.equal(isEchoReply("这家店其实很一般"), false);
  assert.equal(isEchoReply("别急，先看看再说"), false);
  // 反问和提问算互动，不算顺
  assert.equal(isEchoReply("你今天吃饭了吗？"), false);
  // 正常长度的接话也不算顺
  assert.equal(isEchoReply("那家串串我上周才去过，排了四十分钟"), false);
  assert.equal(isEchoReply(""), false);
});

test("顺着接要连着数，断一条就归零", () => {
  const rows = [
    { role: "assistant", text: "我觉得这事得慢点来" },
    { role: "user", text: "嗯" },
    { role: "assistant", text: "好嘛" },
    { role: "assistant", text: "对对对" },
    { role: "assistant", text: "哈哈哈哈哈" },
  ];
  assert.equal(echoStreak(rows), 3);
  assert.equal(echoStreak([...rows, { role: "assistant", text: "我觉得你误会了" }]), 0);
  // 动作和撤回不算说过话
  assert.equal(echoStreak([{ role: "assistant", kind: "action", text: "戳了戳你" }, { role: "assistant", text: "好嘛" }]), 1);
  assert.equal(ECHO_MIN_STREAK, 3);
});

// ── 立场锚：把伙伴自己说过的判断还给它 ──

test("立场锚只认它自己发的、带判断词的整句", () => {
  const rows = [
    { role: "user", text: "我觉得你该去睡了吧" },
    { role: "assistant", text: "这家店其实很一般，我不太想去。回头换一家。" },
    { role: "assistant", text: "好嘛" },
    { role: "assistant", text: "我还是喜欢老城区那家，味道正。" },
  ];
  const anchors = stanceAnchors(rows, { limit: 3 });
  assert.equal(anchors.length, 2);
  assert.match(anchors[0], /这家店其实很一般/);
  assert.match(anchors[1], /我还是喜欢老城区那家/);
  // 对方说的不进锚
  assert.ok(!anchors.some((row) => row.includes("你该去睡了")));
});

test("立场锚丢掉太短、太长和带标记的", () => {
  const rows = [
    { role: "assistant", text: "其实" },
    { role: "assistant", text: `其实${"很长".repeat(40)}` },
    { role: "assistant", text: "其实我不想说这个 [表情:无语]" },
    { role: "assistant", text: "其实我更想聊别的" },
  ];
  const anchors = stanceAnchors(rows);
  assert.deepEqual(anchors, ["其实我更想聊别的"]);
});

// ── 认出「现在正踩在哪个兴趣上」 ──

test("正聊到哪个兴趣：优先认上一条自己挂的兴趣，其次退回词面命中", () => {
  const hobbies = [
    { id: "h1", name: "游戏细节考据", object: "", friction: "不喜欢把游戏里的错处说得比玩起来还重要" },
    { id: "h2", name: "旧物修补", object: "木器", friction: "不愿为了好看把原来的痕磨掉" },
  ];
  // 主动分享那条挂着兴趣，最准
  const byId = hobbyInPlay({
    messages: [{ role: "user", text: "没玩过" }, { role: "assistant", text: "苦力怕那段来历没找到出处", interestId: "h1" }],
    hobbies,
    text: "不懂这个梗",
  });
  assert.equal(byId?.id, "h1");
  // 旧账没有兴趣字段，退回词面
  const byWord = hobbyInPlay({ messages: [], hobbies, text: "我昨天修了个木器，掉漆了" });
  assert.equal(byWord?.id, "h2");
  // 两种都认不出来就什么都不给
  assert.equal(hobbyInPlay({ messages: [], hobbies, text: "今天天气不错" }), null);
  assert.equal(hobbyInPlay({ messages: [], hobbies: [], text: "随便" }), null);
});

// ── 拼成给模型看的那段 ──

test("立场料三段各自只在有料时出现", () => {
  const hobbies = [{ id: "h1", name: "游戏细节考据", object: "", friction: "不喜欢把游戏里的错处说得比玩起来还重要" }];
  const inPlay = hobbyInPlay({ messages: [], hobbies, text: "游戏细节考据" });
  const full = buildStanceText({ inPlay, anchors: ["其实我更想聊别的"], echo: 4 });
  assert.match(full, /【你现在正踩在自己在意的东西上】/);
  assert.match(full, /不喜欢把游戏里的错处说得比玩起来还重要/);
  assert.match(full, /不许把你自己刚讲过的东西判成说错了或者串了题/);
  assert.match(full, /【你自己最近是这么说的】/);
  assert.match(full, /这些是你自己的判断，不是对方说的/);
  assert.match(full, /【这一阵你有点太顺】/);
  assert.match(full, /不是因为她说了/, "提醒归提醒，不许它为了显得有脾气去顶嘴");

  assert.equal(buildStanceText({}), "");
  assert.equal(buildStanceText({ echo: 2 }), "", "没到门槛就不提");
  assert.equal(buildStanceText({ inPlay: { name: "无线电", friction: "" } }), "", "没有 friction 就没这段");
});
