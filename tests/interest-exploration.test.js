import test from "node:test";
import assert from "node:assert/strict";
import {
  addDiscovery,
  DISCOVERY_TTL_MS,
  curiosityLevel,
  explorationDue,
  explorationSpec,
  heldDiscoveryText,
  markDiscoveryOffered,
  markDiscoveryShared,
  mentionsDiscovery,
  nextDiscovery,
  offerableDiscovery,
  discoveryForProactiveMessage,
  MAX_EXPLORATION_HISTORY,
  parseExplorationPlan,
  pickInterestForExploration,
  readInterestLearning,
  scheduleExploration,
} from "../lib/interest-exploration.js";

const at = new Date("2026-09-25T00:00:00.000Z");
const hobby = { id: "hotpot", name: "火锅蘸料", object: "各地蘸料配法", preference: "偏爱对照地方差异" };
const result = { title: "川渝火锅蘸料各有讲究", snippet: "报道介绍了不同地区常见的蘸料搭配。", url: "https://example.test/article", publishedAt: "2026-09-24" };

test("好奇心在随机时间窗内逐渐累积，没到阈值不探索", () => {
  const book = scheduleExploration({}, at, () => 0.5);
  assert.equal(book.curiosity.thresholdMs, 27 * 60 * 60 * 1000);
  assert.equal(curiosityLevel(book, new Date(at.getTime() + 13.5 * 60 * 60 * 1000)), 0.5);
  assert.equal(explorationDue(book, new Date(at.getTime() + 26 * 60 * 60 * 1000)), false);
  assert.equal(explorationDue(book, new Date(at.getTime() + 27 * 60 * 60 * 1000)), true);
});

test("模型探索计划只接收合法 JSON 查询，不接受空或坏回包", () => {
  assert.deepEqual(parseExplorationPlan('{"focus":"火锅蘸料的地方差异","searchQuery":"火锅 蘸料 地方"}'), {
    focus: "火锅蘸料的地方差异",
    searchQuery: "火锅 蘸料 地方",
  });
  assert.equal(parseExplorationPlan("{}"), null);
  assert.equal(parseExplorationPlan("not json"), null);
});

test("探索提示词保留长期兴趣与完整角度索引，不带对话原文或固定分享句式", () => {
  const spec = explorationSpec({
    interest: hobby,
    book: { history: [{ interestId: "hotpot", interestName: "火锅蘸料", focus: "不同地区蘸料差异", at: at.toISOString() }] },
    recentMessages: [{ proactive: true, text: "我最近又在讲不同地方的蘸料搭配" }],
    now: at,
  });
  assert.match(spec.userText, /长期兴趣：火锅蘸料/u);
  assert.doesNotMatch(spec.userText, /各地蘸料配法|偏爱对照地方差异/u, "探索不需要伙伴的个人细节");
  assert.match(spec.userText, /不同地区蘸料差异/u);
  assert.doesNotMatch(spec.userText, /不同地方的蘸料搭配/u);
  assert.match(spec.systemPrompt, /同一个核心问题换同义词/u);
  assert.doesNotMatch(spec.systemPrompt, /闺闺|我刚刷到/u);
});

test("探索计划完全不读取任何对话原文，避免将私聊信息送进搜索", () => {
  const spec = explorationSpec({
    interest: hobby,
    book: {},
    recentMessages: [
      { role: "user", text: "这条只属于用户的私人对话" },
      { role: "assistant", proactive: true, text: "我之前分享过一条火锅小知识" },
    ],
    now: at,
  });
  assert.doesNotMatch(spec.userText, /我之前分享过一条火锅小知识|这条只属于用户的私人对话/u);
});

test("角度索引保留最近 60 条，给语义避重留足窗口", () => {
  const history = Array.from({ length: 65 }, (_, index) => ({
    interestId: `interest-${index}`,
    interestName: `兴趣${index}`,
    focus: `主题角度${index}`,
    at: new Date(at.getTime() + index * 1000).toISOString(),
  }));
  const normalized = readInterestLearning({ history }, at);
  assert.equal(MAX_EXPLORATION_HISTORY, 60);
  assert.equal(normalized.history.length, 60);
  assert.equal(normalized.history[0].interestId, "interest-5");
});

test("夜间例外不绑定兴趣发现，避免发送后错误消耗待分享记录", () => {
  const discovery = { id: "learn-1", focus: "地方蘸料差异" };
  assert.equal(discoveryForProactiveMessage(discovery, { exception: true }), null);
  assert.equal(discoveryForProactiveMessage(discovery), discovery);
  assert.equal(discoveryForProactiveMessage(null), null);
});

test("同一伙伴最近探索过的兴趣会让位给其他长期兴趣", () => {
  const hobbies = [hobby, { id: "game", name: "游戏动作" }];
  const book = { history: [{ interestId: "hotpot", interestName: hobby.name, focus: "汤底差异", at: at.toISOString() }] };
  assert.equal(pickInterestForExploration(hobbies, book, { rnd: () => 0, now: at }).id, "game");
});

test("发现只存真实搜索结果，设短期有效期，并屏蔽同一核心角度重复", () => {
  const first = addDiscovery({}, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "火锅蘸料" }, results: [result] }, at);
  assert.equal(first.added, true);
  assert.equal(Date.parse(first.item.expiresAt) - at.getTime(), DISCOVERY_TTL_MS);
  assert.equal(first.item.results[0].url, result.url);
  const duplicate = addDiscovery(first.book, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "地方蘸料" }, results: [result] }, new Date(at.getTime() + 1000));
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(nextDiscovery(first.book, at).id, first.item.id);
});

test("同一核心意思即使换措辞，也不会作为新探索重复入账", () => {
  const game = { id: "game", name: "游戏动作" };
  const first = addDiscovery({}, {
    interest: game,
    plan: { focus: "游戏角色收刀动作细节", searchQuery: "角色 收刀" },
    results: [result],
  }, at);
  assert.equal(first.added, true);
  const duplicate = addDiscovery(first.book, {
    interest: game,
    plan: { focus: "角色收刀时的动作", searchQuery: "收刀动作" },
    results: [result],
  }, new Date(at.getTime() + 1000));
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, "duplicate");
});

test("学习账有容量上限，超量时先丢最老的发现", () => {
  let book = {};
  for (let i = 0; i < 5; i += 1) {
    const added = addDiscovery(book, {
      interest: { id: `interest-${i}`, name: `兴趣${i}` },
      plan: { focus: `不同方向${i}`, searchQuery: `查询${i}` },
      results: [result],
    }, new Date(at.getTime() + i * 1000));
    assert.equal(added.added, true);
    book = added.book;
  }
  assert.deepEqual(book.discoveries.map((row) => row.interestId), ["interest-1", "interest-2", "interest-3", "interest-4"]);
});

test("已分享发现会记下实际角度，后续不再待发；过期发现自动清掉", () => {
  const first = addDiscovery({}, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "火锅蘸料" }, results: [result] }, at);
  const shared = markDiscoveryShared(first.book, first.item.id, "原来各地蘸料搭配差异这么大", new Date(at.getTime() + 60_000));
  assert.equal(nextDiscovery(shared, new Date(at.getTime() + 60_001)), null);
  const expired = readInterestLearning(first.book, new Date(at.getTime() + DISCOVERY_TTL_MS + 1));
  assert.equal(expired.discoveries.length, 0);
});

test("手里没讲过的发现可以直接端出来，端过了要等冷却期", () => {
  const first = addDiscovery({}, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "火锅蘸料" }, results: [result] }, at);
  assert.equal(offerableDiscovery(first.book, { now: new Date(at.getTime() + 60_000) })?.id, first.item.id, "没讲过就该能端");
  const offered = markDiscoveryOffered(first.book, first.item.id, new Date(at.getTime() + 60_000));
  assert.equal(offerableDiscovery(offered, { now: new Date(at.getTime() + 5 * 60 * 60 * 1000) }), null, "刚端过别连环追问");
  assert.equal(offerableDiscovery(offered, { now: new Date(at.getTime() + 7 * 60 * 60 * 1000) })?.id, first.item.id, "过一阵可以再给一次机会");
  const shared = markDiscoveryShared(offered, first.item.id, "各地蘸料搭配差异挺大", new Date(at.getTime() + 7 * 60 * 60 * 1000));
  assert.equal(offerableDiscovery(shared, { now: new Date(at.getTime() + 30 * 60 * 60 * 1000) }), null, "讲过就不再端");
});

test("只有真的说出口才标已讲；没提就留着", () => {
  const first = addDiscovery({}, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "火锅蘸料" }, results: [result] }, at);
  const said = mentionsDiscovery("我刚扒到个事儿，各地火锅蘸料搭配差得挺多，麻辣区还得现磨香油", first.item);
  assert.equal(said, true, "讲到了就得算数");
  assert.equal(mentionsDiscovery("哈哈哈你好可爱，圆宝又拆家了", first.item), false, "闲聊不算讲过");
  assert.equal(mentionsDiscovery("今天天气不错", first.item), false, "太短不算");  assert.equal(mentionsDiscovery("随便说点啥", null), false, "没有发现时不会误判");
});

test("手里那份东西写成能直接用的语气，不是一块结构化数据", () => {
  const first = addDiscovery({}, { interest: hobby, plan: { focus: "地方蘸料搭配", searchQuery: "火锅蘸料" }, results: [result] }, at);
  const text = heldDiscoveryText(first.item);
  assert.match(text, /还没讲过/);
  assert.match(text, /川渝火锅蘸料各有讲究/u, "标题摘要要带进去");
  assert.match(text, /别当定论/u);
  assert.match(text, /不可信数据/u, "外部材料的注入防护不能丢");
  assert.equal(heldDiscoveryText(null), "");
});
