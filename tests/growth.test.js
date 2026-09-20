/**
 * 爱好生长的纯逻辑测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GROW_MIN_GAP_DAYS,
  NATIVE_DETAIL_ATOMS,
  NATIVE_PASTIME_ATOMS,
  bornHobbySpec,
  canGrow,
  isSameSpot,
  nativeInterestSeed,
  needsBorn,
  parseHobbyLine,
  parseHobbyReply,
  parseNativeHobbyReply,
  sampleNativeAtoms,
  validateNativeHobbies,
} from "../lib/growth.js";
import { MAX_GROWN_HOBBIES } from "../lib/knowing.js";
import { normalizeRelationship } from "../lib/relationship.js";

/** 造一个刚好够到「逐渐熟悉」的账 */
function relationshipAtStage1() {
  return normalizeRelationship({
    familiarity: {
      turns: 10,
      activeDays: 5,
      lastActiveDay: "2026-09-12",
      lastInteractionAt: "2026-09-12T10:00:00Z",
    },
    intimacy: { score: 20, signalCount: 5, signalDays: 5, lastSignalDay: "2026-09-12" },
  });
}

test("没有人格材料时，原生兴趣提示词明确禁止凭常识生成", () => {
  const spec = bornHobbySpec({ partnerName: "小花", personalityText: "" });
  assert.match(spec.userText, /不能生成任何原生兴趣/);
  assert.match(spec.userText, /只回：无/);
});

test("原生兴趣只把人格当注意方式，并要求落点和小别扭", () => {
  const seed = nativeInterestSeed({ surface: { tags: ["细腻"], signals: ["会留意小变化"] }, inner: { tags: ["克制"], signals: ["不喜欢夸张"] } });
  const spec = bornHobbySpec({ partnerName: "小七", userName: "阿舟", personalityText: seed });
  assert.match(spec.systemPrompt, /用户不是兴趣来源/);
  assert.match(spec.systemPrompt, /落点/);
  assert.match(spec.systemPrompt, /小别扭/);
  assert.match(spec.userText, /注意方式：会留意小变化/);
  assert.match(spec.userText, /不是兴趣来源/);
});

test("原生兴趣解析保留对象、偏好、动作和边界", () => {
  const rows = parseNativeHobbyReply("纸袋封口|纸袋的封口方式|喜欢歪一点但不能散|看到就比较两下|贴得太正像流水线|会注意使用痕迹");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].object, "纸袋的封口方式");
  assert.match(rows[0].preference, /歪一点/);
  assert.match(rows[0].ritual, /比较/);
  assert.match(rows[0].friction, /流水线/);
  assert.equal(parseNativeHobbyReply("无").length, 0);
  assert.equal(validateNativeHobbies(rows, { userName: "阿舟" }).length, 1);
  assert.equal(validateNativeHobbies([{ ...rows[0], name: "哲学" }]).length, 0);
  assert.equal(validateNativeHobbies([{ ...rows[0], object: "" }]).length, 0);
});

test("原生兴趣的尺度示例每次只给一小把，而且不许照用", () => {
  const spec = bornHobbySpec({
    partnerName: "小花",
    personalityText: "注意方式：会留意小变化",
    sample: ["纸袋的封口方式", "杯底磨出来的痕迹"],
  });
  assert.match(spec.userText, /取景形状（往哪个方向找、具体到什么程度，不是候选也不是东西）：纸袋的封口方式、杯底磨出来的痕迹/);
  assert.match(spec.systemPrompt, /示例里的说法一个字都不用/);
  assert.doesNotMatch(spec.systemPrompt, /可以从这些对象里挑/, "旧版那句等于把池子当候选清单，模型会直接照抄");
});

test("尺度示例是抽样，不放回、条数受控", () => {
  let i = 0;
  const a = sampleNativeAtoms(() => {
    i += 1;
    return (i % 7) / 7;
  }, 5);
  assert.equal(a.length, 5);
  assert.equal(new Set(a).size, 5);
  const b = sampleNativeAtoms(() => 0, 5);
  assert.equal(new Set(b).size, 5, "同一个位置连抽也不能重复");
});

test("别家伙伴占过的落点会进提示词，也被门禁拦下", () => {
  const taken = ["旧物被修过的接缝（偏爱针脚不齐但牢靠的修补）"];
  const spec = bornHobbySpec({ partnerName: "小花", personalityText: "注意方式：看一眼", takenObjects: taken });
  assert.match(spec.userText, /已经有人占了/);
  assert.match(spec.userText, /旧物被修过的接缝/);
  const rows = [{
    name: "旧物被修过的接缝",
    object: "偏爱针脚不齐但牢靠、能看出耐心的修补",
    preference: "会先摸一遍",
    ritual: "数数哪几针松了",
    friction: "不喜欢打磨成新的",
  }];
  assert.equal(validateNativeHobbies(rows, { takenObjects: taken }).length, 0, "撞了别家的落点就不该覆盖旧数据");
  assert.equal(validateNativeHobbies(rows, { takenObjects: [] }).length, 1, "没人占过就放行");
});

test("撞车判定认得近似说法，但不会把不相干的算成撞", () => {
  assert.equal(isSameSpot("楼道里不同的脚步声", "楼道里的脚步声"), true);
  assert.equal(isSameSpot("杯底磨出来的痕迹", "玻璃杯上的水痕"), false);
});

test("原生兴趣要有层次：能聊的爱好 + 小细节癣好，俗雅都收", () => {
  const spec = bornHobbySpec({ partnerName: "小花", personalityText: "注意方式：看一眼" });
  assert.match(spec.systemPrompt, /至少一条是能撑起一场聊天的爱好/);
  assert.match(spec.systemPrompt, /至少一条是小细节癣好/);
  assert.match(spec.systemPrompt, /别只写「留意、观察、辨认」这类动作/);
  assert.match(spec.systemPrompt, /俗的和雅的都算数/);
  assert.match(spec.systemPrompt, /只爱听八九十年代某一路的歌/);
  assert.doesNotMatch(spec.systemPrompt, /不要写宏大领域/, "反例不该再是领域名，那会把具体的领域爱好一起误伤");
});

test("抽样两档各出半，不再清一色微物", () => {
  const picks = sampleNativeAtoms(() => 0.5, 6);
  assert.equal(picks.length, 6);
  assert.equal(new Set(picks).size, 6);
  assert.equal(NATIVE_DETAIL_ATOMS.filter((atom) => picks.includes(atom)).length, 3);
  assert.equal(NATIVE_PASTIME_ATOMS.filter((atom) => picks.includes(atom)).length, 3);
});

test("两档池子各管各的，不重叠", () => {
  const overlap = NATIVE_DETAIL_ATOMS.filter((atom) => NATIVE_PASTIME_ATOMS.includes(atom));
  assert.equal(overlap.length, 0);
});

test("池子给的是取景形状，不是可抄的成品爱好", () => {
  const pool = [...NATIVE_DETAIL_ATOMS, ...NATIVE_PASTIME_ATOMS];
  const hollow = pool.filter((atom) => /某|一类|一种|一样|一处|一段|一件|一个|那类/.test(atom));
  assert.equal(
    hollow.length,
    pool.length,
    `每条都得留空位（某个器物 / 某一类 X），否则退回成品清单，别人直接抄：${pool.filter((a) => !hollow.includes(a)).join("、")}`,
  );
  assert.ok(pool.length >= 30, "两档合起来要有够多取景方式，抽样才有意义");
});

test("一行能拆成名字、理由、由头", () => {
  const hobby = parseHobbyLine("修收音机|小时候拆过家里的老收音机|跟她那份细致是一路的");
  assert.equal(hobby.name, "修收音机");
  assert.match(hobby.reason, /老收音机/);
  assert.match(hobby.from, /细致/);
  assert.equal(parseHobbyLine("无"), null);
  assert.equal(parseHobbyLine("无。"), null);
  assert.equal(parseHobbyLine("   "), null);
  assert.equal(parseHobbyLine("- 拼图|喜欢慢慢来|耐得住").name, "拼图");
  assert.equal(parseHobbyLine("```\n拼图|喜欢慢慢来|耐得住\n```").name, "拼图");
});

test("一次回好几条就逐行拆，同名的只留一条", () => {
  const rows = parseHobbyReply("拼图|喜欢慢慢来|耐得住\n拼图|重复的|x\n养多肉|看着它慢慢长|y\n无");
  assert.deepEqual(rows.map((row) => row.name), ["拼图", "养多肉"]);
  assert.deepEqual(parseHobbyReply("无"), []);
  assert.deepEqual(parseHobbyReply(""), []);
  assert.deepEqual(parseHobbyReply('[{"name":"拼图","reason":"喜欢慢慢来","from":"耐得住"}]').map((row) => row.name), ["拼图"]);
});

test("后来长的爱好会保留模型给出的证据消息 id", () => {
  const row = parseHobbyLine("旧唱片的不同版本|偏爱现场录音|她反复提过同一首歌|m_123");
  assert.equal(row.sourceId, "m_123");
  assert.equal(parseHobbyReply("旧唱片的不同版本|偏爱现场录音|她反复提过同一首歌|m_123")[0].sourceId, "m_123");
});

test("生来的一条都没有，就该补一次", () => {
  assert.equal(needsBorn([]), true);
  assert.equal(needsBorn([{ name: "后来的", origin: "grown" }]), true);
  assert.equal(needsBorn([{ name: "拼图", origin: "born" }]), false);
});

test("关系还没到，就不长", () => {
  assert.equal(canGrow({ relationship: normalizeRelationship(null), hobbies: [] }), false);
});

test("关系够了才可能长，而且两次之间要隔几天", () => {
  const rel = relationshipAtStage1();
  assert.equal(canGrow({ relationship: rel, hobbies: [], today: "2026-09-12" }), true);

  const fresh = [{ name: "因为她老提螺蛳粉", origin: "grown", at: "2026-09-12T10:00:00" }];
  assert.equal(canGrow({ relationship: rel, hobbies: fresh, today: "2026-09-13" }), false);
  assert.equal(
    canGrow({ relationship: rel, hobbies: fresh, today: "2026-09-16" }),
    true,
    `隔够 ${GROW_MIN_GAP_DAYS} 天才再长`,
  );
});

test("后来那份有额度上限，长满了就不再长", () => {
  const full = [
    { name: "生来那条", origin: "born" },
    ...Array.from({ length: MAX_GROWN_HOBBIES }, (_, i) => ({
      name: `后来的${i}`,
      origin: "grown",
      at: `2026-08-0${i + 1}T10:00:00`,
    })),
  ];
  assert.equal(canGrow({ relationship: relationshipAtStage1(), hobbies: full, today: "2026-09-12" }), false);
});
