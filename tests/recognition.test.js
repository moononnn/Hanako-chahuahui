import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOGNITION_QUESTIONS,
  applyRecognitionAnswer,
  applyRecognitionDraft,
  emptyRecognition,
  isRecognitionComplete,
  normalizeRecognition,
  parseRecognitionSuggestions,
  recognitionSuggestionSpec,
  recognitionForResume,
  recognitionToText,
  sanitizeSuggestions,
} from "../lib/recognition.js";

test("认识 ta：多选、自由修正和原话都能保留", () => {
  let state = emptyRecognition(new Date("2026-09-14T10:00:00+08:00"));
  state = applyRecognitionAnswer(state, "relationship", {
    selected: ["friend", "old_friend", "bad-id"],
    note: "我要朋友和认识挺久，但只要能随口聊天这部分",
    text: "不要写成固定关系标签",
  });
  assert.deepEqual(state.answers.relationship.selected, ["friend", "old_friend"]);
  assert.equal(state.answers.relationship.note, "我要朋友和认识挺久，但只要能随口聊天这部分");
  assert.equal(state.answers.relationship.text, "不要写成固定关系标签");
});

test("认识 ta：空回答不会伪造答案，重复回答可覆盖", () => {
  let state = applyRecognitionAnswer(emptyRecognition(), "traits", { selected: ["notice"] });
  assert.equal(state.answers.traits.selected[0], "notice");
  assert.equal(state.answers.traits.origin, "user");
  state = applyRecognitionAnswer(state, "traits", { selected: [], note: "只要注意变化，不要过度解读" });
  assert.deepEqual(state.answers.traits.selected, []);
  assert.equal(state.answers.traits.note, "只要注意变化，不要过度解读");
  state = applyRecognitionAnswer(state, "traits", {});
  assert.equal(state.answers.traits, undefined);
});

test("认识 ta：完成全部问题才进入完成态", () => {
  let state = emptyRecognition();
  for (const question of RECOGNITION_QUESTIONS) {
    state = applyRecognitionAnswer(state, question.id, { selected: [question.options[0].id] });
  }
  assert.equal(isRecognitionComplete(state), true);
  assert.equal(state.current, null);
  assert.equal(state.status, "complete");
});

test("认识 ta：没有现成回答时也能正常生成具体场景", () => {
  const spec = recognitionSuggestionSpec({
    question: RECOGNITION_QUESTIONS.find((question) => question.id === "traits"),
    recognition: undefined,
    partnerName: "小七",
  });
  assert.match(spec.systemPrompt, /假设场景/);
  assert.match(spec.systemPrompt, /不要声称这些事真的发生过/);
  assert.doesNotThrow(() => recognitionSuggestionSpec({ question: RECOGNITION_QUESTIONS[0] }));
});

test("认识 ta：禁区题明确生成不能做的行为", () => {
  const spec = recognitionSuggestionSpec({
    question: RECOGNITION_QUESTIONS.find((question) => question.id === "boundaries"),
    partnerName: "小花",
  });
  assert.match(spec.systemPrompt, /这是禁区题/);
  assert.match(spec.systemPrompt, /绝对不能采取的行为/);
  assert.match(spec.userText, /不是在选 ta 应该怎么回应/);
});

test("认识 ta：反问题按“最不该被演成的样子”生成和渲染", () => {
  const question = RECOGNITION_QUESTIONS.find((item) => item.id === "misreadings");
  assert.equal(question.intent, "avoid");
  const spec = recognitionSuggestionSpec({ question, partnerName: "小花" });
  assert.match(spec.systemPrompt, /这是反向题/);
  assert.match(spec.systemPrompt, /千万不要演成的样子/);
  assert.doesNotMatch(spec.systemPrompt, /这是行为理解题/);
  assert.match(spec.userText, /ta 最不该出现的表现/);
  assert.doesNotMatch(spec.userText, /ta在这件事里会怎么表现/);
  const text = recognitionToText(applyRecognitionAnswer(emptyRecognition(), "misreadings", {
    selected: ["客服", "sweet"],
    scenarios: [{ scene: "你随口说一件事", reaction: "句句都在询问需求，像在走流程" }],
    text: "不要写成在派活",
  }));
  assert.match(text, /｜要避开的/);
  assert.match(text, /要避开：一开口就像客服/);
  assert.match(text, /场景：你随口说一件事；不要：句句都在询问需求/);
  assert.doesNotMatch(text, /ta的反应：句句都在询问需求/);
});

test("认识 ta：场景建议只给可修改的假设，不把草稿当事实", () => {
  const spec = recognitionSuggestionSpec({
    question: RECOGNITION_QUESTIONS.find((question) => question.id === "traits"),
    recognition: { answers: { traits: { selected: ["notice"], text: "我想不到具体例子" } } },
    partnerName: "小七",
  });
  assert.match(spec.systemPrompt, /只输出 JSON/);
  assert.match(spec.systemPrompt, /主角必须是伙伴 ta/);
  assert.match(spec.systemPrompt, /不能把用户写成场景里的主要行动者/);
  assert.match(spec.systemPrompt, /当前问题若是打字风格/);
  assert.match(spec.systemPrompt, /用户会自己挑、改或否掉/);
  assert.match(spec.userText, /我想不到具体例子/);
  assert.match(spec.userText, /小七/);
  assert.doesNotMatch(spec.userText, /朋友/);
  assert.deepEqual(parseRecognitionSuggestions([
    "```json",
    "{\"scenarios\":[{\"scene\":\"你忙了一天，回消息只剩几个字\",\"reactions\":[\"先问你是不是累了，不逼你展开\",\"故意损你一句，再换个轻松话题\"]},{\"scene\":\"你因为小失误开始骂自己\",\"reactions\":[\"直接指出问题，但不让你把失误当成人格\"]}]}",
    "```",
  ].join("\\n")), [
    { scene: "你忙了一天，回消息只剩几个字", reactions: ["先问你是不是累了，不逼你展开", "故意损你一句，再换个轻松话题"] },
    { scene: "你因为小失误开始骂自己", reactions: ["直接指出问题，但不让你把失误当成人格"] },
  ]);
  assert.deepEqual(parseRecognitionSuggestions("这次没有 JSON"), []);
});

test("认识 ta：坏时间戳不会让保存链路炸掉", () => {
  const state = normalizeRecognition({
    updatedAt: "这不是时间",
    completedAt: "也不是时间",
    answers: { traits: { selected: ["notice"], updatedAt: "坏时间" } },
  }, new Date("2026-09-18T08:00:00.000Z"));
  assert.equal(state.updatedAt, "2026-09-18T08:00:00.000Z");
  assert.equal(state.answers.traits.updatedAt, "2026-09-18T08:00:00.000Z");
  assert.equal(state.completedAt, null);
});

test("认识 ta：坏数据归一化且渲染成给模型看的材料", () => {
  const state = normalizeRecognition({
    current: "traits",
    answers: {
      traits: { selected: ["notice", "nope"], note: "只要这一部分" },
      unknown: { selected: ["x"], text: "不该进入" },
    },
  });
  assert.deepEqual(state.answers.traits.selected, ["notice"]);
  const text = recognitionToText(state);
  assert.match(text, /只要这一部分/);
  assert.doesNotMatch(text, /不该进入/);
});

test("认识 ta：做到一半的当前题草稿保留当前题号", () => {
  const state = applyRecognitionDraft(emptyRecognition(), "relationship", {
    selected: ["friend", "companion"],
  });
  assert.deepEqual(state.answers.relationship.selected, ["friend", "companion"]);
  assert.equal(state.current, "relationship");
  assert.equal(state.answers.relationship.draft, true);
  assert.equal(state.status, "draft");
  assert.equal(normalizeRecognition({ ...state, current: "relationship" }).current, "relationship");
});

test("认识 ta：旧 current 落在第一题时按已保存答案跳到第一道未完成题", () => {
  const state = normalizeRecognition({
    current: "relationship",
    answers: {
      relationship: { selected: ["friend"] },
      traits: { selected: ["notice"] },
      occasions: { selected: ["daily"] },
    },
  });
  assert.equal(state.current, "response");
});

test("认识 ta：完整档案回头改一题还是「认识好了」，不再留断点", () => {
  let state = emptyRecognition();
  for (const question of RECOGNITION_QUESTIONS) {
    state = applyRecognitionAnswer(state, question.id, { selected: [question.options[0].id] });
  }
  assert.equal(state.status, "complete");
  const completedAt = state.completedAt;
  state = applyRecognitionAnswer(state, "relationship", { selected: ["old_friend"] });
  assert.equal(state.status, "complete", "答完过的档案回看修改不该变回「没做完」");
  assert.equal(state.current, null, "不再留断点");
  assert.equal(state.completedAt, completedAt, "完成时间不重刷");
  assert.equal(state.answers.relationship.selected[0], "old_friend");
});

test("认识 ta：认识好过一遍的档案重开时从第一题看起", () => {
  const state = recognitionForResume({
    status: "complete",
    current: null,
    answers: Object.fromEntries(RECOGNITION_QUESTIONS.map((question, index) => [question.id, {
      selected: [question.options[0].id],
      updatedAt: new Date(Date.UTC(2026, 8, 19, 7, index)).toISOString(),
    }])),
  });
  assert.equal(state.status, "complete");
  assert.equal(state.current, null, "完成后不再把人扔到最后一题");
});

test("认识 ta：认识好过一遍以后，回看时的临时保存不会把完成态打回去", () => {
  let state = emptyRecognition();
  for (const question of RECOGNITION_QUESTIONS) {
    state = applyRecognitionAnswer(state, question.id, { selected: [question.options[0].id] });
  }
  const completedAt = state.completedAt;
  const after = applyRecognitionDraft(state, "relationship", {
    selected: ["old_friend"],
    text: "改一句看看",
  });
  assert.equal(after.status, "complete");
  assert.equal(after.current, null);
  assert.equal(after.completedAt, completedAt);
  assert.equal(after.answers.relationship.draft, undefined, "完成过的档案不打草稿标记");
  assert.equal(after.answers.relationship.text, "改一句看看", "改的内容照存，别弄丢她刚写的");
});

test("认识 ta：提交当前题时保留之前已经选过的题目", () => {
  let state = applyRecognitionAnswer(emptyRecognition(), "relationship", {
    selected: ["friend", "old_friend"],
  });
  state = applyRecognitionAnswer(state, "speech", {
    selected: ["short"],
    scenarios: [{ scene: "伙伴看到一条很长的消息", reaction: "先用短句接住重点，再慢慢补充" }],
  });
  assert.deepEqual(state.answers.relationship.selected, ["friend", "old_friend"]);
  assert.deepEqual(state.answers.speech.selected, ["short"]);
  assert.equal(state.answers.speech.scenarios.length, 1);
});

test("认识 ta：多个场景方向和自由补充分开保存", () => {
  const state = applyRecognitionAnswer(emptyRecognition(), "traits", {
    selected: ["notice"],
    scenarios: [
      { scene: "她因为小失误开始骂自己", reaction: "先指出问题，但不让她把失误当成人格" },
      { scene: "她半夜发来一条很长的抱怨", reaction: "先陪她缓一缓，再一起看问题" },
    ],
    text: "补充：语气可以更轻一点",
  });
  assert.equal(state.answers.traits.scenarios.length, 2);
  assert.equal(state.answers.traits.text, "补充：语气可以更轻一点");
  assert.match(recognitionToText(state), /场景：她因为小失误开始骂自己；ta 会：先指出问题/);
  assert.match(recognitionToText(state), /场景：她半夜发来一条很长的抱怨；ta 会：先陪她缓一缓/);
  assert.match(recognitionToText(state), /自己说：补充：语气可以更轻一点/);
});

test("认识 ta：旧的场景草稿仍按原规则兼容", () => {
  const state = applyRecognitionAnswer(emptyRecognition(), "traits", {
    selected: ["notice"],
    scenario: { scene: "她因为小失误开始骂自己", reaction: "先指出问题，但不让她把失误当成人格" },
    origin: "scenario",
  });
  assert.equal(state.answers.traits.origin, "scenario");
  assert.equal(state.answers.traits.scenarios.length, 1);
  assert.match(recognitionToText(state), /下面是设想的情境，不是真实经历/);
});

test("认识 ta：禁区题混进来的「推荐做法」会被质检筛掉", () => {
  const question = RECOGNITION_QUESTIONS.find((item) => item.id === "boundaries");
  const rows = sanitizeSuggestions(question, [{
    scene: "她发来一条没头没尾的抱怨",
    reactions: [
      "先顺着情绪接一句「听起来今天挺消耗的」，再问她想聊还是想静一静",
      "不能立刻把零散抱怨拆成原因、对策和待办清单，像在做问题诊断",
      "不能连续追问细节、要求她交代前因后果",
    ],
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reactions.length, 2);
  assert.doesNotMatch(rows[0].reactions.join(""), /先顺着情绪接一句/);
});

test("认识 ta：反问题里的推荐式说法也筛掉，正向题不动", () => {
  const avoidQuestion = RECOGNITION_QUESTIONS.find((item) => item.id === "misreadings");
  const avoidRows = sanitizeSuggestions(avoidQuestion, [{
    scene: "她随口问一句要不要一起去",
    reactions: ["可以先替她把行程排好、把票买好", "一开口就像客服，连续追问「请问您更倾向哪种方案呢」"],
  }]);
  assert.equal(avoidRows[0].reactions.length, 1);
  assert.match(avoidRows[0].reactions[0], /客服/);

  const openQuestion = RECOGNITION_QUESTIONS.find((item) => item.id === "traits");
  const openRows = sanitizeSuggestions(openQuestion, [{
    scene: "她情绪低下来但没展开说",
    reactions: ["先顺着她的情绪接一句，不急着给建议", "故意从别的角度岔开，逗她一句"],
  }]);
  assert.equal(openRows[0].reactions.length, 2, "正向题的「先…」是好反应，不该被筛");
});

test("认识 ta：同一个场景写好几遍会被收成一条", () => {
  const question = RECOGNITION_QUESTIONS.find((item) => item.id === "traits");
  const rows = sanitizeSuggestions(question, [
    { scene: "群里有人把轻松的话改成了句号，气氛忽然静下来", reactions: ["她不急着热场，先把前后几句摆出来"] },
    { scene: "群里有人把轻松的话改成了句号，气氛忽然静了下来", reactions: ["她会先看大家到底在误会什么"] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reactions.length, 2);
});

test("认识 ta：一条题最多挑两个", () => {
  const state = applyRecognitionAnswer(emptyRecognition(), "traits", {
    selected: ["notice", "tease", "boundary"],
  });
  assert.deepEqual(state.answers.traits.selected, ["notice", "tease"]);
  assert.equal(RECOGNITION_QUESTIONS.find((item) => item.id === "traits").maxSelect, 2);
});

test("认识 ta：场景方向一个场景只留一条、总数不超过六条", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    scene: "她一个人闷头收拾桌子",
    reaction: `第 ${i} 种完全不同的反应写法，各不一样`,
  }));
  const same = applyRecognitionAnswer(emptyRecognition(), "traits", { scenarios: many });
  assert.equal(same.answers.traits.scenarios.length, 1, "同一个场景只留一条，两条会让模型不知道该听哪条");

  const spread = Array.from({ length: 8 }, (_, i) => ({
    scene: `第 ${i} 个完全不同的生活场景，发生在不同地方`,
    reaction: `对应的第 ${i} 种反应，写得各不相同`,
  }));
  const capped = applyRecognitionAnswer(emptyRecognition(), "traits", { scenarios: spread });
  assert.equal(capped.answers.traits.scenarios.length, 6, "总数封在六条");
});

test("认识 ta：场景和反应都有长度上限，防的是小作文", () => {
  const long = "她".repeat(120);
  const state = applyRecognitionAnswer(emptyRecognition(), "traits", {
    scenarios: [{ scene: long, reaction: long }],
  });
  const row = state.answers.traits.scenarios[0];
  assert.equal(row.scene.length, 50);
  assert.equal(row.reaction.length, 70);
});

test("认识 ta：贴进来的原话会被当成语料样本交给模型", () => {
  const state = applyRecognitionAnswer(emptyRecognition(), "speech", {
    selected: ["short", "colloquial"],
    text: "要得要得\n那你先忙嘛\n我等到你哈",
  });
  const text = recognitionToText(state);
  assert.match(text, /语料样本/);
  assert.match(text, /原话样本/);
  assert.match(text, /那你先忙嘛/);
});

test("认识 ta：空白草稿不落盘，完成态不会被摸回「没做完」", () => {
  let state = emptyRecognition();
  for (const question of RECOGNITION_QUESTIONS) {
    state = applyRecognitionAnswer(state, question.id, { selected: [question.options[0].id] });
  }
  const after = applyRecognitionDraft(state, "relationship", { selected: [], note: "", text: "", scenarios: [] });
  assert.equal(after.status, "complete", "空白草稿不该把完成态改成没做完");
  assert.ok(after.answers.relationship, "旧答案也不该被空白草稿删掉");
  assert.equal(after.answers.relationship.selected.length, 1);
});

test("认识 ta：禁区描述不带「不能」两个字也照样留得住", () => {
  const question = RECOGNITION_QUESTIONS.find((item) => item.id === "boundaries");
  const rows = sanitizeSuggestions(question, [{
    scene: "她半夜发来一段没头没尾的抱怨",
    reactions: [
      "把聊天拆成待办清单，逐项追问进度",
      "先顺着情绪接一句，再问她想不想一起想办法",
    ],
  }]);
  assert.deepEqual(rows[0].reactions, ["把聊天拆成待办清单，逐项追问进度"]);
});

test("认识 ta：候选不再在前四条就被砍掉", () => {
  const scenarios = Array.from({ length: 6 }, (_, index) => ({
    scene: `第 ${index + 1} 个场景，写得够长了`,
    reactions: [`第 ${index + 1} 种反应方向，也够长`],
  }));
  const parsed = parseRecognitionSuggestions(JSON.stringify({ scenarios }));
  assert.equal(parsed.length, 6, "前几条不合格时，后面的还得有机会进质检");
});

test("认识 ta：认识好过一遍的痕要留得住，重做也不掉", () => {
  let state = emptyRecognition();
  assert.equal(state.everCompleted, false);
  for (const question of RECOGNITION_QUESTIONS) {
    state = applyRecognitionAnswer(state, question.id, { selected: [question.options[0].id] });
  }
  assert.equal(normalizeRecognition(state).everCompleted, true);
  const cleared = normalizeRecognition({ ...emptyRecognition(), everCompleted: true });
  assert.equal(cleared.status, "draft");
  assert.equal(cleared.everCompleted, true, "清空后这条痕还在，入住资格不会跟着掉");
});
