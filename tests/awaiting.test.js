import test from "node:test";
import assert from "node:assert/strict";

import {
  AWAITING_MIN_RATIO,
  AWAITING_PESTER_RATIO,
  MAX_NUDGES,
  awaitingSince,
  awaitingStage,
  hasOpenThread,
  nudgeDelay,
  nudgeSpec,
  parseNudgeChoice,
  planNudge,
  temperamentOf,
} from "../lib/awaiting.js";

const MIN = 60_000;

test("等回音提示词会带入相处理解", () => {
  const spec = nudgeSpec({
    partnerName: "小花",
    userName: "阿舟",
    stage: "ask",
    waitedMinutes: 20,
    adaptationText: "【你们相处出来的理解】\\n偏好：先接具体话头，不要空问候",
  });
  assert.match(spec.systemPrompt, /你们相处出来的理解/);
  assert.match(spec.systemPrompt, /先接具体话头/);
});

test("催的力度按熟悉度分三档：不熟不催，熟了才能连发", () => {
  assert.equal(awaitingStage(0), "off");
  assert.equal(awaitingStage(AWAITING_MIN_RATIO - 0.01), "off");
  assert.equal(awaitingStage(AWAITING_MIN_RATIO), "ask");
  assert.equal(awaitingStage(AWAITING_PESTER_RATIO - 0.01), "ask");
  assert.equal(awaitingStage(AWAITING_PESTER_RATIO), "pester");
  assert.equal(awaitingStage(null), "off");
  assert.equal(awaitingStage("不是数"), "off");
});

test("性子也算数：藏不住的还不太熟也会先开口，憋得住的熟了也未必", () => {
  assert.equal(awaitingStage(0.05, "outgoing"), "ask", "性子藏不住，不熟也能先问一句");
  assert.equal(awaitingStage(AWAITING_PESTER_RATIO, "outgoing"), "pester");
  assert.equal(awaitingStage(AWAITING_PESTER_RATIO, "reserved"), "ask", "憋得住的，熟了也顶多轻轻问一句");
  assert.equal(awaitingStage(0.05, "reserved"), "off");
  assert.equal(awaitingStage(0.05, "neutral"), "off");
});

test("性子从ta的性格标签里读，读不到就算中性、走熟度那条线", () => {
  assert.equal(temperamentOf({ surface: { tags: ["俏皮"] } }), "outgoing");
  assert.equal(temperamentOf({ inner: { tags: ["热情"] } }), "outgoing");
  assert.equal(temperamentOf({ surface: { tags: ["安静"] } }), "reserved");
  assert.equal(temperamentOf({ inner: { tags: ["有分寸"] } }), "reserved");
  assert.equal(temperamentOf({ surface: { tags: ["温柔"] } }), "neutral");
  assert.equal(temperamentOf(null), "neutral");
  assert.equal(temperamentOf({}), "neutral");
});

test("等到什么时候：第一回比催过之后短，急的那档更短", () => {
  const fixed = () => 0.5;
  assert.ok(
    nudgeDelay({ stage: "pester", nudges: 0, rnd: fixed }) < nudgeDelay({ stage: "ask", nudges: 0, rnd: fixed }),
    "熟了的那档等得短一点",
  );
  assert.ok(
    nudgeDelay({ stage: "pester", nudges: 0, rnd: fixed }) < nudgeDelay({ stage: "pester", nudges: 1, rnd: fixed }),
    "催过一次之后隔得久一点，别追着问",
  );
  assert.ok(nudgeDelay({ stage: "ask", nudges: 0, rnd: fixed }) >= 40 * MIN);
});

test("只有留下开放话头的回复，才算在等她回", () => {
  const t = 1_700_000_000_000;
  const iso = (value) => new Date(value).toISOString();
  assert.equal(awaitingSince([]), 0);
  assert.equal(hasOpenThread("没啥特指，海豹本人都不知道自己咋来的😂"), false);
  assert.equal(hasOpenThread("吃饭了吗？"), false, "封闭式礼貌问句不应单独启动等回音");
  assert.equal(hasOpenThread("你还要继续说吗？"), true);
  assert.equal(awaitingSince([{ role: "assistant", text: "在", at: iso(t) }]), 0, "只有ta说过话，没有她的，不算");
  assert.equal(awaitingSince([{ role: "user", text: "在吗", at: iso(t) }]), 0, "她说了ta还没回，那是在走异步那条路");
  assert.equal(
    awaitingSince([{ role: "user", text: "在吗", at: iso(t) }, { role: "assistant", text: "你还要继续说吗？", at: iso(t + 5000) }]),
    t + 5000,
    "从ta最后开口那一刻算起，不是从她说话算起",
  );
  assert.equal(
    awaitingSince([
      { role: "user", text: "旧", at: iso(t - 5000) },
      { role: "assistant", text: "在", at: iso(t - 4000) },
      { role: "user", text: "新", at: iso(t) },
      { role: "assistant", text: "嗯，你还想接着说吗？", at: iso(t + 2000) },
    ]),
    t + 2000,
  );
  assert.equal(
    awaitingSince([
      { role: "user", text: "海豹？啥海豹？", at: iso(t) },
      { role: "assistant", text: "没啥特指，海豹本人都不知道自己咋来的😂", at: iso(t + 2000) },
    ]),
    0,
    "明确收束的话题不应再进入等回音",
  );
  assert.equal(
    awaitingSince([
      { role: "user", text: "在吗", at: iso(t) },
      { role: "assistant", text: "我突然想起个事，你还记得吗？", proactive: true, at: iso(t + 2000) },
    ]),
    0,
    "主动找话题的消息不是对用户的接话，不应启动等回音",
  );
  assert.equal(
    awaitingSince([
      { role: "user", kind: "action", text: "戳", at: iso(t) },
      { role: "assistant", kind: "action", text: "回戳", at: iso(t + 2000) },
    ]),
    0,
    "只有动作互动时不把ta当成在等一句话",
  );
});

test("生产里的 ISO 时间戳也能进入等回音", () => {
  const now = 1_700_000_000_000;
  const history = [
    { role: "user", text: "你回我一下", at: new Date(now - 60 * MIN).toISOString() },
    { role: "assistant", text: "回了嘛，你还要接着说吗？", at: new Date(now - 55 * MIN).toISOString() },
  ];
  assert.equal(planNudge({ history, now, ratio: 0.2, rnd: () => 0.5 }).due, true);
});

test("等回音共用主动关系策略：none 不催，more 比 less 更早到点", () => {
  const now = 1_700_000_000_000;
  const since = now - 35 * MIN;
  const history = [
    { role: "user", text: "我去倒杯水", at: new Date(since - MIN).toISOString() },
    { role: "assistant", text: "要得，你回来还想接着说吗？", at: new Date(since).toISOString() },
  ];
  assert.equal(planNudge({ history, now, ratio: 0.4, contactPolicy: { allowed: false, intervalFactor: 1 } }).reason, "relationship-denied");
  assert.equal(planNudge({ history, now, ratio: 0.4, rnd: () => 0.5, contactPolicy: { allowed: true, intervalFactor: 0.75 } }).due, true);
  assert.equal(planNudge({ history, now, ratio: 0.4, rnd: () => 0.5, contactPolicy: { allowed: true, intervalFactor: 1.5 } }).due, false);
});

test("该不该催：不熟、催满了、没在等、时间没到，都不催", () => {
  const now = 1_700_000_000_000;
  const iso = (value) => new Date(value).toISOString();
  const history = [
    { role: "user", text: "在吗", at: iso(now - 60 * MIN) },
    { role: "assistant", text: "在，你还想接着说吗？", at: iso(now - 55 * MIN) },
  ];
  const base = { history, now, rnd: () => 0.5 };

  assert.equal(planNudge({ ...base, ratio: 0.05 }).reason, "not-close-enough");
  assert.equal(planNudge({ ...base, ratio: 0.2, nudges: MAX_NUDGES }).reason, "gave-up");
  assert.equal(
    planNudge({ ...base, ratio: 0.2, history: [{ role: "user", text: "在吗", at: iso(now) }] }).reason,
    "nothing-to-wait-for",
  );
  assert.equal(planNudge({ ...base, ratio: 0.2, now: now - 30 * MIN }).reason, "not-yet");
  assert.equal(
    planNudge({
      ...base,
      ratio: 0.2,
      history: [
        { role: "user", text: "在吗", at: iso(now - 20 * 60 * MIN) },
        { role: "assistant", text: "在，你还想接着说吗？", at: iso(now - 19 * 60 * MIN) },
      ],
    }).reason,
    "too-late",
    "隔了一天多就别提了，那是主动那套的活",
  );

  const due = planNudge({ ...base, ratio: 0.2 });
  assert.equal(due.due, true);
  assert.equal(due.stage, "ask");
  assert.ok(due.waitedMs >= 55 * MIN, "算的是从ta那句话开始的等待");
});

test("ta这一回打算怎么办：[等]、[戳]、或者说话", () => {
  assert.equal(parseNudgeChoice("").kind, "wait");
  assert.equal(parseNudgeChoice("   ").kind, "wait");
  assert.equal(parseNudgeChoice("[等]").kind, "wait");
  assert.equal(parseNudgeChoice("[戳]").kind, "poke");
  const words = parseNudgeChoice("人呢？\n？？\n别装死");
  assert.equal(words.kind, "words");
  assert.equal(words.text, "人呢？\n？？\n别装死");
  assert.equal(parseNudgeChoice("我不等[等]了").kind, "words", "标记混在话里就不算标记");
});

test("催的提示词：处境说清楚，档位不同尺度不同", () => {
  const ask = nudgeSpec({
    partnerName: "小七",
    userName: "阿舟",
    stage: "ask",
    waitedMinutes: 40,
    lastAssistantText: "在",
    lastUserText: "抱抱",
  });
  assert.match(ask.systemPrompt, /小七/);
  assert.match(ask.systemPrompt, /40 分钟/);
  assert.match(ask.systemPrompt, /最多一句/);
  assert.doesNotMatch(ask.systemPrompt, /别装死/, "还没到能连发那一档，别给连发的范例");
  assert.match(ask.systemPrompt, /\[等\]/);
  assert.match(ask.systemPrompt, /\[戳\]/);
  assert.match(ask.systemPrompt, /不是每条消息的开场标签/);
  assert.match(ask.systemPrompt, /不要无缘无故用她的名字起句/);

  const pester = nudgeSpec({
    partnerName: "小花",
    userName: "阿舟",
    stage: "pester",
    waitedMinutes: 90,
    lastAssistantText: "在",
    lastUserText: "抱抱",
  });
  assert.match(pester.systemPrompt, /连着发几条/);
  assert.match(pester.systemPrompt, /不要每次都从‘人呢’或她的名字开头/);
  assert.doesNotMatch(pester.systemPrompt, /别装死/);

  const outgoing = nudgeSpec({
    partnerName: "小七",
    userName: "阿舟",
    stage: "ask",
    temperament: "outgoing",
    waitedMinutes: 30,
    lastAssistantText: "在",
    lastUserText: "抱抱",
  });
  assert.match(outgoing.systemPrompt, /藏不住的性子/, "不熟但藏不住的，也该说清ta可以直接问");
  assert.match(outgoing.systemPrompt, /别连发/, "这个阶段还得收着点");
});
