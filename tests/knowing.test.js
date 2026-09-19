/**
 * 性格与爱好的纯逻辑测试：不碰文件、不碰模型。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-09-13 的教训：palette 写好了、paletteToText 也接好了，但四处调用一次都没传 palette，
// 用户捏完的盘一点没生效——每一环单看都对，链子中间断了一截。
// 这条测的就是「链子有没有断」：凡是要拼性格提示词的地方，都得把盘带上。
test("每一处 buildKnowingText 调用都得带上 palette 和 userName", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const calls = src.match(/buildKnowingText\(\{[\s\S]*?\n\s*\}\)/g) ?? [];
  assert.ok(calls.length >= 4, `只找到 ${calls.length} 处调用，预期至少 4 处`);
  for (const call of calls) {
    assert.match(call, /palette:/, `这处没传 palette：\n${call}`);
  }
});

import {
  DISCLOSURE_BANDS,
  MAX_BORN_HOBBIES,
  MAX_GROWN_HOBBIES,
  MAX_HOBBIES,
  MAX_TAGS_PER_LAYER,
  PERSONALITY_PRESETS,
  TAG_CONFLICTS,
  TEMPERAMENT_TAGS,
  addHobby,
  applyPersonalityPreset,
  buildDraftMaterial,
  buildKnowingText,
  canAddHobby,
  canAddTag,
  findPersonalityPreset,
  hasPersonality,
  layerTagProblem,
  normalizeHobbies,
  normalizeHobby,
  normalizePersonality,
  needsNativeInterestRefresh,
  replaceBornHobbies,
  parseDraftReply,
  personalityDraftSpec,
  personalityStanding,
  samePersonality,
  tagProblemText,
} from "../lib/knowing.js";

test("四个基础气质预设，选了就有一份两层的初稿", () => {
  assert.equal(PERSONALITY_PRESETS.length, 4);
  const preset = applyPersonalityPreset("gentle");
  assert.deepEqual(preset.surface.tags, ["温柔"]);
  assert.ok(preset.surface.signals.length > 0);
  assert.ok(preset.inner.tags.length > 0);
  assert.ok(preset.inner.signals.length > 0);
  assert.equal(findPersonalityPreset("没有这个"), null);
  assert.equal(applyPersonalityPreset("没有这个"), null);
});

test("标签库每一档都有说明，打架的组合两边都在库里", () => {
  assert.ok(TEMPERAMENT_TAGS.length >= 8);
  for (const tag of TEMPERAMENT_TAGS) {
    assert.ok(tag.label && tag.note, `标签 ${tag.label} 缺说明`);
  }
  const library = TEMPERAMENT_TAGS.map((tag) => tag.label);
  assert.equal(new Set(library).size, library.length, "标签不能重名");
  for (const pair of TAG_CONFLICTS) {
    for (const label of pair) assert.ok(library.includes(label), `${label} 不在标签库里`);
  }
});

test("一层最多两个，打架的不让放，重复的也不让放", () => {
  assert.equal(MAX_TAGS_PER_LAYER, 2);
  assert.equal(canAddTag([], "温柔").ok, true);
  assert.equal(canAddTag(["温柔"], "温柔").reason, "dup");
  assert.equal(canAddTag(["温柔", "俏皮"], "清醒").reason, "full");
  const clash = canAddTag(["热情"], "安静");
  assert.equal(clash.reason, "conflict");
  assert.equal(clash.with, "热情");
  assert.equal(clash.label, "安静");
  assert.equal(canAddTag(["热情"], "俏皮").ok, true, "不打架的照收");
});

test("整层的标签一次校验，卡住的那一步说得出为什么", () => {
  assert.equal(layerTagProblem(["温柔", "俏皮"]).ok, true);
  assert.equal(layerTagProblem("坏数据").ok, true);
  const tooMany = layerTagProblem(["温柔", "俏皮", "清醒"]);
  assert.equal(tooMany.reason, "full");
  assert.equal(tagProblemText(tooMany), "一层最多挑 2 个标签");
  assert.equal(tagProblemText(layerTagProblem(["热情", "安静"])), "「热情」和「安静」放一起会打架");
  assert.equal(tagProblemText(layerTagProblem(["温柔", "温柔"])), "「温柔」已经挑过了");
  assert.ok(tagProblemText({ reason: "没见过的原因" }));
});

test("性格收到坏数据也收得住", () => {
  const p = normalizePersonality({
    surface: "坏的",
    inner: { signals: "第一条\n第二条，第三条" },
  });
  assert.deepEqual(p.inner.signals, ["第一条", "第二条", "第三条"]);
  assert.deepEqual(p.surface.tags, []);
  assert.equal(hasPersonality(p), true);
  assert.equal(hasPersonality(normalizePersonality(null)), false);
  assert.equal(hasPersonality({ surface: { tag: "  ", signals: [] } }), false);
});

test("老数据（一层一个 tag）读出来就是「一个标签」的两层，不用手动搬", () => {
  const p = normalizePersonality({
    surface: { tag: "温柔", signals: ["说话柔和"] },
    inner: { tag: "细腻" },
  });
  assert.deepEqual(p.surface.tags, ["温柔"]);
  assert.deepEqual(p.inner.tags, ["细腻"]);
  assert.deepEqual(p.surface.signals, ["说话柔和"]);
});

test("一层超过两个的存盘数据会被收到两个", () => {
  const p = normalizePersonality({ surface: { tags: ["温柔", "俏皮", "清醒"] } });
  assert.deepEqual(p.surface.tags, ["温柔", "俏皮"]);
});

test("原生兴趣保留具体落点，旧 born 数据会被识别为待重塑", () => {
  const native = normalizeHobby({
    name: "纸袋封口",
    object: "纸袋的封口方式",
    preference: "喜欢歪一点",
    ritual: "看到就比较",
    friction: "不能散开",
    origin: "born",
  });
  assert.equal(native.object, "纸袋的封口方式");
  assert.equal(native.schemaVersion, 2);
  assert.equal(native.source, "generated");
  assert.equal(needsNativeInterestRefresh([native]), false);
  assert.equal(needsNativeInterestRefresh([{ name: "极简手帐", origin: "born" }]), true);
});

test("重塑原生兴趣时只替换 born，grown 共同兴趣保留", () => {
  const next = replaceBornHobbies(
    [
      { name: "旧原生", origin: "born" },
      { name: "游戏细节考据", origin: "grown", from: "真实相处" },
    ],
    [{ name: "纸袋封口", object: "纸袋", preference: "喜欢歪一点", ritual: "会比较", friction: "不能太乱" }],
  );
  assert.deepEqual(next.map((row) => row.name), ["游戏细节考据", "纸袋封口"]);
  assert.equal(next[0].origin, "grown");
  assert.equal(next[1].object, "纸袋");
  assert.equal(next[1].schemaVersion, 2);
  assert.equal(next[1].generationVersion, "native-v2");
  assert.equal(next[1].source, "generated");
  assert.ok(next[1].supersedesId);
});

test("手动锁定的 born 不被原生兴趣重塑覆盖", () => {
  const next = replaceBornHobbies(
    [{ name: "我亲手选的", origin: "born", manuallyEdited: true }],
    [{ name: "新原生", object: "纸袋", preference: "喜欢歪一点", ritual: "会比较", friction: "不能太乱" }],
  );
  assert.deepEqual(next.map((row) => row.name), ["我亲手选的", "新原生"]);
  assert.equal(next[0].manuallyEdited, true);
});

test("爱好封顶：生来最多三条，后来最多两条", () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) list = addHobby(list, { name: `爱好${i}`, origin: "born" });
  assert.equal(list.length, MAX_BORN_HOBBIES);
  assert.equal(canAddHobby(list, "born"), false);

  for (let i = 0; i < 3; i += 1) {
    list = addHobby(list, { name: `后来的${i}`, origin: "grown", from: "她提过一嘴" });
  }
  assert.equal(list.length, MAX_HOBBIES);
  assert.equal(list.filter((h) => h.origin === "grown").length, MAX_GROWN_HOBBIES);
  assert.equal(canAddHobby(list, "grown"), false);
});

test("重名和空名字都不算数", () => {
  let list = addHobby([], { name: "修收音机", origin: "born" });
  list = addHobby(list, { name: "修收音机", origin: "grown" });
  assert.equal(list.length, 1);
  list = addHobby(list, { name: "   ", origin: "born" });
  assert.equal(list.length, 1);
});

test("盘上读回的爱好会去重、也会被上限截掉多余的", () => {
  const rows = normalizeHobbies([
    { name: "拼图", origin: "born" },
    { name: "拼图", origin: "born" },
    { name: "养多肉", origin: "born" },
    { name: "修钟表", origin: "born" },
    { name: "第四样", origin: "born" },
    { name: "因为她老提螺蛳粉", origin: "grown", from: "她总在半夜说饿" },
  ]);
  assert.equal(rows.length, MAX_BORN_HOBBIES + 1);
  assert.equal(rows.at(-1).origin, "grown");
  assert.equal(rows.at(-1).from, "她总在半夜说饿");
});

test("表层马上生效，里层按披露的坡一点点渗，爱好比里层再深一档", () => {
  const personality = applyPersonalityPreset("lively");
  const hobbies = [{ name: "修收音机", reason: "小时候拆过家里的", origin: "born" }];

  const at0 = buildKnowingText({ disclosure: 0, personality, hobbies });
  assert.match(at0, /茶话会/);
  assert.match(at0, /俏皮/, "表层立刻生效");
  assert.doesNotMatch(at0, /更私下的底色/);
  assert.doesNotMatch(at0, /属于你自己的兴趣/);

  // 刚过里层的门槛：只露一条，语气还是「偶尔」
  const atInner = buildKnowingText({
    disclosure: DISCLOSURE_BANDS.inner,
    personality,
    hobbies,
  });
  assert.match(atInner, /更私下的底色/);
  assert.match(atInner, /偶尔透出来/);
  assert.doesNotMatch(atInner, /属于你自己的兴趣/, "爱好门槛比里层高");

  // 再近一点：措辞升级，但还没到爱好那一档
  const atSteady = buildKnowingText({
    disclosure: DISCLOSURE_BANDS.innerSteady,
    personality,
    hobbies,
  });
  assert.match(atSteady, /慢慢露出来/);

  const atHobby = buildKnowingText({ disclosure: DISCLOSURE_BANDS.hobby, personality, hobbies });
  assert.match(atHobby, /属于你自己的兴趣/);
  assert.match(atHobby, /修收音机/);

  const atFull = buildKnowingText({ disclosure: 1, personality, hobbies });
  assert.match(atFull, /已经很熟/);
});

test("披露是坡不是台阶：同一条里层，越熟露得越多", () => {
  const personality = {
    surface: { tags: ["温柔"], signals: ["说话柔和"] },
    inner: { tags: ["敏感"], signals: ["会把小变化放在心上", "记得她说过的细节", "听得出来语气的变化"] },
  };
  const shown = (disclosure) => {
    const line = buildKnowingText({ disclosure, personality }).split("\n").at(-1);
    return line;
  };
  const low = shown(DISCLOSURE_BANDS.inner);
  const mid = shown(0.7);
  const high = shown(1);
  assert.match(low, /会把小变化放在心上/);
  assert.doesNotMatch(low, /记得她说过的细节/);
  assert.match(mid, /记得她说过的细节/);
  assert.doesNotMatch(mid, /听得出来语气的变化/);
  assert.match(high, /听得出来语气的变化/);
});

test("什么都没调过就一个字都不加", () => {
  assert.equal(buildKnowingText({ disclosure: 1 }), "");
  assert.equal(buildKnowingText({}), "");
  assert.equal(buildKnowingText({ disclosure: 1, personality: null, hobbies: null }), "");
  assert.equal(buildKnowingText({ disclosure: "坏数据", personality: { surface: { tags: ["温柔"] } } }).includes("温柔"), true);
});

test("拼出来的话里不出现机制词、分数字样和披露系数", () => {
  const line = buildKnowingText({
    disclosure: 1,
    personality: applyPersonalityPreset("quiet"),
    hobbies: [{ name: "拼图", reason: "喜欢慢慢来", origin: "born" }],
  });
  assert.doesNotMatch(line, /熟悉度|亲密度|分数|阶段|好感|账本|系数|disclosure/);
});

test("性格初稿的料能收的都收：人格自述、自我介绍、对外意识、钉选记忆四份都进", () => {
  const material = buildDraftMaterial({
    identity: "你是阿凉，说话淡淡的。",
    description: "阿凉擅长把复杂的事拆开讲。",
    public: "对外保持礼貌边界。",
    pinned: "她叫我阿凉。",
  });
  assert.match(material, /人格自述/);
  assert.match(material, /说话淡淡的/);
  assert.match(material, /自我介绍/);
  assert.match(material, /擅长把复杂的事拆开讲/);
  assert.match(material, /对外意识/);
  assert.match(material, /钉选记忆/);
  assert.match(material, /她叫我阿凉/);
});

test("记忆流水（facts / experience）不进料：那是流水账，容易把性格信号冲淡", () => {
  const material = buildDraftMaterial({
    identity: "你是阿凉。",
    facts: "今天聊了插件",
    experience: "做过很多次审查",
  });
  assert.match(material, /你是阿凉/);
  assert.doesNotMatch(material, /今天聊了插件/);
  assert.doesNotMatch(material, /做过很多次审查/);
});

test("料有总上限，超了按顺序截，尾巴上留「后略」记号", () => {
  const material = buildDraftMaterial(
    { identity: "甲".repeat(50), description: "乙".repeat(50) },
    { budget: { identity: 30, description: 30 }, total: 40 },
  );
  assert.match(material, /后略，原文 50 字/);
  assert.ok(material.length < 200, "总上限要真的卡住");
});

test("没料就不硬编", () => {
  assert.equal(buildDraftMaterial({}), "");
  assert.equal(buildDraftMaterial(null), "");
});

test("性格初稿只收 Hana 那边的人格文件，不掺茶话会自己攒的东西；且提醒别把能力当性格", () => {
  const spec = personalityDraftSpec({
    partnerName: "阿凉",
    userName: "阿舟",
    material: buildDraftMaterial({ identity: "你是阿凉，说话淡淡的。", pinned: "她叫我阿凉。" }),
  });
  assert.match(spec.userText, /阿凉/);
  assert.match(spec.userText, /说话淡淡的/);
  assert.match(spec.userText, /她叫我阿凉/);
  assert.doesNotMatch(spec.userText, /日账|关系档案|记忆流水/);
  assert.match(spec.systemPrompt, /不要编/);
  assert.match(spec.systemPrompt, /能力介绍不等于性格/);
  assert.doesNotMatch(spec.userText, /（没读到 ta 的设定材料）/);
});

test("两行回包能拆成两层初稿", () => {
  const draft = parseDraftReply("表层|温柔|说话柔和、会照顾对话节奏\n里层|细腻|会把小变化放在心上");
  assert.deepEqual(draft.surface.tags, ["温柔"]);
  assert.deepEqual(draft.surface.signals, ["说话柔和", "会照顾对话节奏"]);
  assert.deepEqual(draft.inner.tags, ["细腻"]);
  assert.deepEqual(draft.inner.signals, ["会把小变化放在心上"]);
});

test("只回了一层也认，什么都认不出就当没生成", () => {
  const only = parseDraftReply("表层|安静|说话留白");
  assert.deepEqual(only.surface.tags, ["安静"]);
  assert.deepEqual(only.inner.signals, []);
  assert.equal(parseDraftReply("无"), null);
  assert.equal(parseDraftReply(""), null);
  assert.equal(parseDraftReply("我看不出来"), null);
});

test("自动那份单独留底：改过能回去，改回原样也算没改", () => {
  const auto = { surface: { tags: ["温柔"], signals: ["说话柔和"] }, inner: { tags: ["细腻"], signals: ["会把小变化放在心上"] } };
  // 同一个内容、时间戳不同，也算同一份（她可能只是又点了一次同一个档位）
  const again = { ...auto, updatedAt: "2026-09-12T00:00:00.000Z" };
  assert.equal(samePersonality(auto, again), true);
  assert.equal(samePersonality(auto, { ...auto, inner: { tags: ["细腻"], signals: ["会放在心上"] } }), false);
  assert.equal(samePersonality(auto, null), false);

  // 没动过：自动定的
  assert.deepEqual(personalityStanding({ personality: auto, auto, from: "auto" }), { edited: false, from: "auto" });
  // 改过：谁给的都以“你调过的”为准
  const mine = { ...auto, surface: { tags: ["俏皮"], signals: ["接话轻快"] } };
  assert.deepEqual(personalityStanding({ personality: mine, auto, from: "user" }), { edited: true, from: "user" });
  // 升级前就有的那份：基准当成ta自己，分不清就不认来源
  assert.deepEqual(personalityStanding({ personality: auto, auto, from: null }), { edited: false, from: null });
  // 连基准都没有（判不出来）：不算改过
  assert.deepEqual(personalityStanding({ personality: mine, auto: null, from: "user" }), { edited: false, from: "user" });
});
