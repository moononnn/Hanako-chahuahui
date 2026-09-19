/**
 * 爱好生长的纯逻辑测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GROW_MIN_GAP_DAYS,
  bornHobbySpec,
  canGrow,
  nativeInterestSeed,
  needsBorn,
  parseHobbyLine,
  parseHobbyReply,
  parseNativeHobbyReply,
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

test("原生兴趣只把人格当注意方式，并要求具体对象和小别扭", () => {
  const seed = nativeInterestSeed({ surface: { tags: ["细腻"], signals: ["会留意小变化"] }, inner: { tags: ["克制"], signals: ["不喜欢夸张"] } });
  const spec = bornHobbySpec({ partnerName: "小七", userName: "阿舟", personalityText: seed });
  assert.match(spec.systemPrompt, /用户不是兴趣来源/);
  assert.match(spec.systemPrompt, /具体对象/);
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
