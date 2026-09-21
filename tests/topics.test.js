import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceTopics,
  correctTopic,
  dropTopic,
  emptyTopicBook,
  existingTitles,
  fermentMsFor,
  isSameTopic,
  makeTopic,
  markTopicUsed,
  mergeTopics,
  normalizeTitle,
  parseTopics,
  normalizeFreshness,
  readBook,
  pickTopic,
  pruneTopics,
  readyTopics,
  refreshUsedTopics,
  isSameAngle,
  usedAnglesFor,
  topicSpec,
} from "../lib/topics.js";

const T0 = new Date("2026-09-12T10:00:00.000Z");
const at = (hours) => new Date(T0.getTime() + hours * 3600 * 1000);
const noJitter = { rnd: () => 0 };

test("刚提到的话题不马上够格，先发酵", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  assert.equal(book.topics.length, 1);
  assert.equal(book.topics[0].state, "fermenting");
  assert.equal(pickTopic(book, T0, noJitter), null);
});

test("发酵期是不规律的，不同题材长短不同", () => {
  const a = fermentMsFor("gossip", () => 0);
  const b = fermentMsFor("gossip", () => 1);
  assert.ok(b > a);
  // 心事要比八卦搁得久
  assert.ok(fermentMsFor("worry", () => 0) > fermentMsFor("gossip", () => 0));
});

test("到点之后才进 ready，能被挑中", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const later = at(24 * 5);
  const advanced = advanceTopics(book, later).book;
  assert.equal(advanced.topics[0].state, "ready");
  assert.ok(pickTopic(advanced, later, noJitter));
});

test("沉默追问时排除上一轮同一个 ready 话题", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "旧话题", kind: "other" }], T0).book;
  book = mergeTopics(book, [{ title: "新话题", kind: "other" }], T0).book;
  const later = at(24 * 3);
  book = advanceTopics(book, later).book;
  const oldId = book.topics.find((row) => row.title === "旧话题").id;
  const next = pickTopic(book, later, { ...noJitter, excludeId: oldId });
  assert.equal(next.title, "新话题");
});

test("同一件事只留一条，保留最早那次的时间", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const second = mergeTopics(book, [{ title: "化妆苦手", kind: "worry", note: "眼线画歪" }], at(5));
  assert.equal(second.added, 0);
  assert.equal(second.merged, 1);
  assert.equal(second.book.topics.length, 1);
  assert.equal(second.book.topics[0].note, "眼线画歪");
  assert.equal(second.book.topics[0].openedAt, T0.toISOString());
});

test("标题比对能认出同一件：相等或短的被含住", () => {
  assert.equal(isSameTopic("化妆苦手", "化妆苦手"), true);
  assert.equal(isSameTopic("她化妆苦手", "化妆苦手"), true);
  assert.equal(isSameTopic("她喜欢螺蛳粉", "她怕冷"), false);
  // 太短的词不算包含关系，免得把"猫"和"猫粮"混成一件
  assert.equal(isSameTopic("猫", "猫粮该买什么"), false);
  assert.equal(normalizeTitle("她喜欢螺蛳粉！"), "她喜欢螺蛳粉");
});

test("说过一次就进冷却，冷却期内不再够格", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  // 心事擞得最久也不过四天，取六天后确保已进 ready
  book = advanceTopics(book, at(24 * 6)).book;
  const target = pickTopic(book, at(24 * 6), noJitter);
  book = markTopicUsed(book, target.id, at(24 * 6));
  assert.equal(book.topics[0].state, "used");
  assert.equal(book.topics[0].usedCount, 1);
  assert.equal(pickTopic(book, at(24 * 7), noJitter), null);
});

test("冷却过了可以再提；聊过的面用光（四次）才彻底放下", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const id = book.topics[0].id;
  let clock = 24 * 6;
  for (let round = 1; round <= 3; round += 1) {
    book = advanceTopics(book, at(clock)).book;
    book = markTopicUsed(book, id, at(clock), { angle: `第${round}个面` });
    assert.equal(book.topics[0].usedCount, round);
    // 冷却期（心事 30 天）过了还能回来：聊过的面还没用光
    clock += 24 * 40;
    book = refreshUsedTopics(book, at(clock));
    assert.equal(book.topics[0].state, "fermenting");
  }
  // 第四次用完，再等冷却就放下了
  book = advanceTopics(book, at(clock)).book;
  book = markTopicUsed(book, id, at(clock), { angle: "第4个面" });
  assert.equal(book.topics[0].usedCount, 4);
  book = refreshUsedTopics(book, at(clock + 24 * 90));
  assert.equal(book.topics[0].state, "dropped");
});

test("搁太久的话题会被清掉", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她提过的电影", kind: "interest" }], T0).book;
  const later = at(24 * 60);
  assert.equal(pruneTopics(book, later).topics.length, 0);
});

test("手动放下的话题保留墓碑且不会再被挑中", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "不想再聊", kind: "other" }], T0).book;
  const id = book.topics[0].id;
  book = dropTopic(book, id, at(1));
  assert.equal(book.topics[0].state, "dropped");
  assert.equal(book.topics[0].dismissedAt, at(1).toISOString());
  assert.equal(pickTopic(book, at(24 * 5), noJitter), null);
  assert.ok(existingTitles(book).includes("不想再聊"));
});

test("用户纠正只改人话描述，不动话题排期", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "剑鞘细节", kind: "interest" }], T0).book;
  const id = book.topics[0].id;
  const corrected = correctTopic(book, id, "属于《黑神话：钟馗》，不是《黑神话：悟空》");
  assert.equal(corrected.topics[0].correction, "属于《黑神话：钟馗》，不是《黑神话：悟空》");
  assert.equal(corrected.topics[0].readyAt, book.topics[0].readyAt);
  assert.equal(correctTopic(book, id, "").topics[0].correction, "");
});

test("话题太多时先丢没用的，且守住上限", () => {
  let book = emptyTopicBook();
  for (let i = 0; i < 70; i += 1) {
    book = mergeTopics(book, [{ title: `话题第${i}号`, kind: "other" }], at(i)).book;
  }
  const pruned = pruneTopics(book, at(100), { max: 50 });
  assert.equal(pruned.topics.length, 50);
});

test("有具体落点的话题优先于只剩抽象标题的旧话题", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "旧主题", kind: "other" }], T0).book;
  book = mergeTopics(book, [{ title: "胶带搭配", anchor: "蓝灰胶带配米白页", kind: "other" }], at(1)).book;
  const later = at(24 * 3);
  book = advanceTopics(book, later).book;
  assert.equal(pickTopic(book, later, noJitter).title, "胶带搭配");
});

test("好几个都够格时，等得越久的越靠前", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "早点的八卦", kind: "gossip" }], T0).book;
  book = mergeTopics(book, [{ title: "晚点的八卦", kind: "gossip" }], at(24 * 3)).book;
  book = advanceTopics(book, at(24 * 10)).book;
  const ready = readyTopics(book, at(24 * 10), noJitter);
  assert.equal(ready.length, 2);
  assert.equal(ready[0].title, "早点的八卦");
});

test("本子里的标题能取出来给模型避重", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "甲", kind: "other" }, { title: "乙", kind: "other" }], T0).book;
  assert.deepEqual(existingTitles(book).sort(), ["乙", "甲"]);
});

test("空本子不出事", () => {
  assert.deepEqual(emptyTopicBook().topics, []);
  assert.equal(pickTopic(null, T0, noJitter), null);
  assert.deepEqual(pruneTopics(null, T0).topics, []);
  assert.deepEqual(existingTitles(null), []);
});

// ── 模型输出的洗法 ──

test("抠出 JSON 数组，无视解释文字和代码块", () => {
  const raw = '好的，这是结果：\n```json\n[{"title":"化妆苦手","kind":"worry","note":"眼线画不好"}]\n```';
  const out = parseTopics(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "化妆苦手");
  assert.equal(out[0].kind, "worry");
});

test("空数组和垃圾输入都返回空，不抛", () => {
  assert.deepEqual(parseTopics("[]"), []);
  assert.deepEqual(parseTopics("我觉得没什么好记的"), []);
  assert.deepEqual(parseTopics(""), []);
  assert.deepEqual(parseTopics(null), []);
  assert.deepEqual(parseTopics("[{不是合法json}]"), []);
});

test("非法 kind 归到 other，一次最多三条", () => {
  const raw = JSON.stringify([
    { title: "一", kind: "瞎写的" },
    { title: "二", kind: "gossip" },
    { title: "三", kind: "plan" },
    { title: "四", kind: "want" },
  ]);
  const out = parseTopics(raw);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, "other");
});

test("没有 title 的条目被丢掉", () => {
  const raw = JSON.stringify([{ kind: "gossip", note: "没标题" }, { title: "有标题" }]);
  const out = parseTopics(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "有标题");
});

test("读取旧话题本时会补齐时效字段，历史 gossip 不漏搜", () => {
  const book = readBook({ topics: [{ title: "旧八卦", kind: "gossip" }, { title: "旧兴趣", kind: "interest" }] });
  assert.equal(book.topics[0].freshness, "timely");
  assert.equal(book.topics[1].freshness, "evergreen");
});

test("八卦默认标成时效话题，普通兴趣默认常青", () => {
  const gossip = makeTopic({ title: "某人的新瓜", kind: "gossip" }, T0);
  const interest = makeTopic({ title: "她喜欢螺蛳粉", kind: "interest" }, T0);
  assert.equal(gossip.freshness, "timely");
  assert.equal(interest.freshness, "evergreen");
  assert.equal(normalizeFreshness(undefined, "gossip"), "timely");
});

test("话题抽取提示词要求具体落点而不是抽象主题", () => {
  const spec = topicSpec([], [], () => "她想买一卷蓝灰色纸胶带，考虑配米白色手帐页");
  assert.match(spec.systemPrompt, /具体可指认的对象、动作、款式、颜色、搭配、场景或二选一/);
  assert.match(spec.systemPrompt, /‘极简手帐’不行/);
  assert.match(spec.userText, /蓝灰色纸胶带/);
});

test("话题抽取只算她说的事，伙伴自己抛的不算", () => {
  const spec = topicSpec([], [], () => "用户：今天好冷\n小花：我偏心杯底那圈浅浅的磨痕");
  assert.match(spec.systemPrompt, /标着伙伴名字的那些行是伙伴自己在说/);
  assert.match(spec.systemPrompt, /伙伴自己抛出的兴趣、想法、小物件不算对方提过的话题/);
  assert.match(spec.systemPrompt, /一件事只有伙伴提过、对方没接话，就不要抽/);
  assert.match(spec.userText, /只抽用户名字那几行里的事/);
});

test("模型抽取能保留时效标记、搜索词和具体落点", () => {
  const out = parseTopics(JSON.stringify([
    { title: "某人的新瓜", kind: "gossip", freshness: "timely", searchQuery: "某人 最新进展", anchor: "发布会现场的一句话" },
    { title: "画眼线", kind: "interest", freshness: "evergreen" },
  ]));
  assert.equal(out[0].freshness, "timely");
  assert.equal(out[0].searchQuery, "某人 最新进展");
  assert.equal(out[0].anchor, "发布会现场的一句话");
  assert.equal(out[1].freshness, "evergreen");
});

test("makeTopic 挡住空标题，并保留具体落点", () => {
  assert.equal(makeTopic({ title: "  " }, T0), null);
  const topic = makeTopic({ title: "胶带搭配", anchor: "蓝灰胶带配米白页", kind: "plan" }, T0);
  assert.ok(Date.parse(topic.readyAt) > T0.getTime());
  assert.equal(topic.state, "fermenting");
  assert.equal(topic.anchor, "蓝灰胶带配米白页");
});

// 踩过的坑：调用方把几个函数的返回形状记混，写了 .book 去取一个直接返回本子的函数，
// 结果 saveTopicBook(undefined) 把整本话题洗成了空。这里把形状钉死。
test("返回形状钉住：谁包一层、谁直接给本子", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "一件事", kind: "other" }], T0).book;

  // 直接给本子（包一层 topics 字段）
  assert.ok(Array.isArray(refreshUsedTopics(book, T0).topics));
  assert.ok(Array.isArray(pruneTopics(book, T0).topics));

  // 包一层，本子在 .book 里
  assert.ok(Array.isArray(advanceTopics(book, T0).book.topics));
  assert.ok(Array.isArray(mergeTopics(book, [], T0).book.topics));
});

test("剪枝不会把活着的话题洗掉", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她想去云南", kind: "plan" }], T0).book;
  const pruned = pruneTopics(book, at(24 * 5));
  assert.equal(pruned.topics.length, 1);
  assert.equal(pruned.topics[0].title, "她想去云南");
});

// ── 角度账本（2026-09-15）：同一个由头可以再提，但每次得是新的延伸 ──

test("聊过的面记在话题上，下次回来得换个延伸", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const id = book.topics[0].id;
  book = markTopicUsed(book, id, at(1), { angle: "眼线手抖可以先用胶带定个边" });
  book = markTopicUsed(book, id, at(2), { angle: "她上次说想换一支细头的眼线笔" });
  assert.deepEqual(usedAnglesFor(book.topics[0]), [
    "她上次说想换一支细头的眼线笔",
    "眼线手抖可以先用胶带定个边",
  ]);
});

test("同一个面换个说法不重复记（话题能再聊，但不能念同一句）", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const id = book.topics[0].id;
  let next = markTopicUsed(book, id, at(1), { angle: "眼线手抖可以先用胶带定个边试试看" });
  next = markTopicUsed(next, id, at(2), { angle: "眼线手抖可以先用胶带定个边" });
  assert.equal(next.topics[0].angles.length, 1);
  assert.equal(isSameAngle("眼线手抖可以先用胶带定个边", "眼线手抖可以先用胶带定个边试试看"), true);
  assert.equal(isSameAngle("眼线手抖", "睫毛夹老是夹到眼皮"), false);
});

test("角度只留最近几条，老账不占地方", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const id = book.topics[0].id;
  for (let round = 1; round <= 6; round += 1) {
    book = markTopicUsed(book, id, at(round), { angle: `第${round}个面` });
  }
  assert.equal(book.topics[0].angles.length, 4);
  assert.equal(book.topics[0].angles[0].text, "第3个面");
});

test("没带角度就说过了：状态照旧，不凭空编一个面", () => {
  const book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  const next = markTopicUsed(book, book.topics[0].id, at(1));
  assert.equal(next.topics[0].usedCount, 1);
  assert.deepEqual(next.topics[0].angles, []);
});

test("自省说总缺由头时，冷却过半的话题能提前放回来", () => {
  let book = mergeTopics(emptyTopicBook(), [{ title: "她化妆苦手", kind: "worry" }], T0).book;
  book = markTopicUsed(book, book.topics[0].id, at(0), { angle: "一个面" });
  // 心事冷却 30 天：过了一半（15 天）才放回来
  assert.equal(refreshUsedTopics(book, at(24 * 10)).topics[0].state, "used");
  assert.equal(refreshUsedTopics(book, at(24 * 10), { eager: true }).topics[0].state, "used");
  assert.equal(refreshUsedTopics(book, at(24 * 16), { eager: true }).topics[0].state, "fermenting");
  assert.equal(refreshUsedTopics(book, at(24 * 16), { eager: false }).topics[0].state, "used");
});

test("老话题本没有角度那一栏也不炸", () => {
  const legacy = {
    topics: [
      {
        id: "tp_1",
        title: "旧话题",
        kind: "other",
        state: "ready",
        readyAt: T0.toISOString(),
        openedAt: T0.toISOString(),
        usedCount: 1,
      },
    ],
  };
  const book = readBook(legacy);
  assert.deepEqual(book.topics[0].angles, []);
  assert.deepEqual(usedAnglesFor(book.topics[0]), []);
  assert.deepEqual(usedAnglesFor(null), []);
});
