/**
 * 世界领域 + 新闻主动消息（2026-10-20）
 *
 * 这一轮要挡住三个回归：
 * 1. 世界领域层坏了会连累旧兴趣点（两份数据必须分开存）；
 * 2. 新闻路径会重复推同一条、推过期新闻、或者一天刷超过两条；
 * 3. 视频降级候选会把「只看过弹幕」说成「读过字幕」。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WORLD_INTERESTS,
  MIN_WORLD_INTERESTS,
  isSameWorldSpot,
  needsWorldInterests,
  normalizeWorldInterests,
  parseWorldInterestReply,
  replaceWorldInterests,
  validateWorldInterests,
  worldInterestId,
  worldInterestSpec,
} from "../lib/world-interests.js";
import {
  NEWS_MAX_PER_DAY,
  addNewsItems,
  markNewsFetched,
  markNewsOffered,
  markNewsShared,
  newsFetchDue,
  newsQuotaAvailable,
  newsQueryFor,
  newsShareLimit,
  newsText,
  newsTopicFor,
  nextNewsItem,
  normalizeNewsBook,
  noteNewsSent,
  pickDomainForNews,
  rejectNewsItem,
} from "../lib/news-feed.js";
import { makeVideoCandidate } from "../lib/video-sharing.js";
import { parseSeedReply } from "../lib/topic-seeds.js";
import { readFileSync } from "node:fs";

const now = new Date("2026-10-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const GOSSIP = { id: "wi_娱乐圈八卦", name: "娱乐圈八卦", domains: ["娱乐圈八卦", "综艺争议"], sources: ["微博", "豆瓣"], note: "" };
const TECH = { id: "wi_数码更新", name: "数码更新", domains: ["数码与模型更新"], sources: ["科技媒体"], note: "" };
const ROWS = [
  { title: "某剧组片场吵翻，主创当场回应", snippet: "现场视频流出，双方说法不一。", url: "https://example.com/a", publishedAt: "2026-10-19" },
  { title: "新开源模型把推理成本压到三成", snippet: "官方给了完整基准，第三方还没复现。", url: "https://example.com/b", publishedAt: "2026-10-18" },
];

/* ── 世界领域 ── */

/**
 * 2026-10-21 实机踩过：index.js 用了 searchWeb，忘了写进 import。
 * 单元测试全绿、语法检查也过，但真跑起来每一轮取料都报 ReferenceError，
 * 后台账本里只有 news.fetch.failed，人看不见。
 * 这里直接钉住“用到的名字真的 import 了”这件事。
 */
test("取料用的 searchWeb 真被 import 了，而且三处调用都在", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const block = source.match(/import \{([\s\S]*?)\} from "\.\/lib\/search-engine\.js";/u);
  assert.ok(block, "search-engine 那份 import 块还在");
  assert.match(block[1], /\bsearchWeb\b/u, "searchWeb 必须在这份 import 里，不然真跑就是 ReferenceError");
  // 三处：新闻取料、兴趣探索、伙伴自己发起的搜索工具（2026-10-21）。
  assert.equal((source.match(/await searchWeb\(/gu) ?? []).length, 3, "新闻取料、兴趣探索、工具三处都用它，少一处说明接线断了");
});

test("世界领域与母题/癖好分开存放，互不顶替", () => {
  const list = normalizeWorldInterests([
    { name: "娱乐圈八卦", domains: ["娱乐圈八卦", "综艺争议"], sources: ["微博"] },
  ], now);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, worldInterestId("娱乐圈八卦"));
  assert.deepEqual(list[0].domains, ["娱乐圈八卦", "综艺争议"]);
  assert.equal(list[0].muted, false);
});

test("没有具体内容的领域不收（只剩名字等于没定方向）", () => {
  assert.deepEqual(normalizeWorldInterests([{ name: "八卦", domains: [], sources: ["微博"] }], now), []);
  assert.deepEqual(normalizeWorldInterests([{ name: "", domains: ["x"] }], now), []);
});

test("领域数量封顶，重复名字只留一条", () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ name: `领域${index}`, domains: [`东西${index}`] }));
  const dup = [...many, { name: "领域0", domains: ["另一种说法"] }];
  const list = normalizeWorldInterests(dup, now);
  assert.equal(list.length, MAX_WORLD_INTERESTS);
  assert.equal(list.filter((row) => row.name === "领域0").length, 1);
});

test("太泛的领域名、蹭到她名字的、跟别人撞衫的，都过不了生成门禁", () => {
  const rows = validateWorldInterests([
    { name: "科技", domains: ["芯片"], sources: ["某站"] },
    { name: "娱乐圈八卦", domains: ["和阿岚一起看八卦"], sources: ["微博"] },
    { name: "书影音", domains: ["老片重映"], sources: ["豆瓣"] },
  ], { userName: "阿岚", takenNames: ["书影音"] });
  assert.deepEqual(rows.map((row) => row.name), []);
});

test("正常领域能过门禁，撞衫判定能认出换皮", () => {
  const rows = validateWorldInterests([
    { name: "书影音", domains: ["老片重映"], sources: ["豆瓣"] },
    { name: "手作与旧物", domains: ["木工小改造"], sources: ["B站"] },
  ], { userName: "阿岚", takenNames: [] });
  assert.deepEqual(rows.map((row) => row.name), ["书影音", "手作与旧物"]);
  assert.equal(isSameWorldSpot("书影音", "书影音"), true);
  assert.equal(isSameWorldSpot("数码更新", "今天天气不错"), false);
});

test("不够两条就该再生成一批", () => {
  assert.equal(needsWorldInterests([]), true);
  assert.equal(needsWorldInterests([GOSSIP]), true);
  assert.equal(needsWorldInterests([GOSSIP, TECH]), false);
  assert.equal(needsWorldInterests([GOSSIP, { ...TECH, domains: [] }]), true);
});

test("整批替换时保留 createdAt 和静音状态", () => {
  const before = normalizeWorldInterests([
    { ...GOSSIP, muted: true, createdAt: "2026-10-01T00:00:00.000Z" },
    TECH,
  ], now);
  const after = replaceWorldInterests(before, [
    { name: "娱乐圈八卦", domains: ["娱乐圈八卦"], sources: ["微博"] },
    { name: "街头文化", domains: ["潮牌与街头摄影"], sources: ["小红书"] },
  ], now);
  assert.equal(after.length, 2);
  const kept = after.find((row) => row.name === "娱乐圈八卦");
  assert.equal(kept.muted, true, "她手动关掉的领域不能因为重摇一批就自己回来");
  assert.equal(kept.createdAt, "2026-10-01T00:00:00.000Z");
  assert.equal(after.some((row) => row.name === "数码更新"), false, "这一轮没给的方向就真的没有");
});

test("解析只认结构对的行，坏 JSON 返回空而不是整份丢进库里", () => {
  const rows = parseWorldInterestReply('{"worldInterests":[{"name":"八卦","domains":["娱乐圈"],"sources":["微博"]}]}');
  assert.equal(rows.length, 1);
  assert.deepEqual(parseWorldInterestReply("这不是 JSON"), []);
  assert.deepEqual(parseWorldInterestReply('{"worldInterests":[{"name":"没有方向"}]}'), []);
  assert.equal(parseWorldInterestReply('{"worldInterests":[{"name":"数码","domains":["新模型"],"sources":[]}]}').length, 1);
});

test("生成提示词不把她的名字当领域来源", () => {
  const spec = worldInterestSpec({ partnerName: "小花", personalityText: "偏好结构：俏皮、爱损" });
  assert.match(spec.systemPrompt, /worldInterests/);
  assert.ok(spec.userText.includes("小花"));
  assert.equal(spec.userText.includes("阿岚"), false);
});

/* ── 新闻路径 ── */

test("查询词由领域确定性拼出来，会按日期换角度，不靠模型现编", () => {
  const first = newsQueryFor(GOSSIP, { now: new Date("2026-10-20T12:00:00.000Z") });
  const later = newsQueryFor(GOSSIP, { now: new Date("2026-10-21T12:00:00.000Z") });
  assert.match(first, /娱乐圈八卦/);
  assert.notEqual(first, later);
  assert.equal(newsQueryFor({ name: "", domains: [] }), "");
});

test("视频搜索用的是领域本身，不是“最新消息”那种问法", () => {
  assert.equal(newsTopicFor(GOSSIP), "娱乐圈八卦");
  assert.equal(newsTopicFor({ name: "只有名字" }), "只有名字");
  assert.equal(newsTopicFor(null), "");
});

test("取料按领域轮换：刚取过的排后面，静音的不取", () => {
  const book = markNewsFetched({ lastFetchAt: "2026-10-20T11:00:00.000Z", lastDomainId: GOSSIP.id }, GOSSIP.id, now);
  assert.equal(pickDomainForNews([GOSSIP, TECH], book, { now }).id, TECH.id);
  const muted = { ...TECH, muted: true };
  assert.equal(pickDomainForNews([GOSSIP, muted], book, { now }).id, GOSSIP.id, "她关掉的领域不该被抽中");
  assert.equal(pickDomainForNews([], book, { now }), null);
});

test("到点才取料：有货就等久一点，池子空了才补得快", () => {
  const stocked = markNewsFetched(
    addNewsItems({}, { domain: GOSSIP, query: "娱乐圈八卦 最新消息", results: ROWS }, now).book, GOSSIP.id, now,
  );
  assert.equal(newsFetchDue(stocked, new Date("2026-10-20T14:00:00.000Z")), false, "两小时前刚取过，还有货");
  assert.equal(newsFetchDue(stocked, new Date("2026-10-20T17:00:00.000Z")), false, "还有货就不急着再搜（5 小时）");
  assert.equal(newsFetchDue(stocked, new Date("2026-10-20T20:00:00.000Z")), true, "隔了 8 小时无论如何补一趟");
  const first = addNewsItems({}, { domain: GOSSIP, query: "q", results: ROWS }, now).book;
  assert.equal(newsFetchDue(first, now), true, "没记过取料时间，第一次当然要取");
  const empty = markNewsFetched({ items: [] }, "", new Date("2026-10-20T19:00:00.000Z"));
  assert.equal(newsFetchDue(empty, new Date("2026-10-20T20:00:00.000Z")), false, "才过一小时");
  assert.equal(newsFetchDue(empty, new Date("2026-10-20T22:00:00.000Z")), true, "池子空了，3 小时就补");
});

test("入池的去重、时效和数量都对：同标题不重复、太老的不算这阵子的事", () => {
  const stale = { title: "三个月前的旧闻", snippet: "摘要", publishedAt: "2026-06-01" };
  const again = { title: "某剧组片场吵翻，主创当场回应", snippet: "同一条", publishedAt: "2026-10-19" };
  const added = addNewsItems({}, { domain: GOSSIP, query: "q", results: [...ROWS, stale, again] }, now);
  assert.equal(added.added, 2);
  assert.deepEqual(added.book.items.map((row) => row.title), [ROWS[0].title, ROWS[1].title]);
  assert.equal(added.book.items.every((row) => row.domainId === GOSSIP.id), true);
  assert.equal(added.book.items.every((row) => row.expiresAt), true);
});

test("她看不懂的结果不进池：日语、纯外文标题、只有一个词的那种", () => {
  const jp = { title: "かわいすぎる「Muse」…Metaの新AIエージェントに賛否両論の理由", snippet: "Metaが発表した新しいAIエージェント", publishedAt: "2026-10-19" };
  const it = { title: "Il problema di voler ottimizzare tutto", snippet: "Gli agenti di AI sono promossi come la soluzione", publishedAt: "2026-10-19" };
  const oneWord = { title: "Perplexity", snippet: "## Meta暂停Muse AI人工礼宾服务 …", publishedAt: "2026-10-19" };
  const english = { title: "Meta pauses human concierge for Muse after complaint", snippet: "snippet", publishedAt: "2026-10-19" };
  const good = { title: "某家手机把耳机孔又塞回来了", snippet: "新款把 3.5mm 接口装回去了，评论区在吵。", publishedAt: "2026-10-19" };
  const added = addNewsItems({}, { domain: TECH, query: "q", results: [jp, it, oneWord, english, good] }, now);
  assert.equal(added.added, 1, "只留看得懂的那一条");
  assert.equal(added.book.items[0].title, good.title);
});

test("摘要过长会被截短：摘要不是把搜回来的全文往提示词里塞", () => {
  const long = { title: "某部剧的拍摄现场出了点事", snippet: "字".repeat(900), publishedAt: "2026-10-19" };
  const added = addNewsItems({}, { domain: GOSSIP, query: "q", results: [long] }, now);
  assert.equal(added.book.items[0].snippet.length, 300);
});

test("没日期的结果照收：有的引擎根本不给日期，不能因此一条都没有", () => {
  const added = addNewsItems({}, { domain: GOSSIP, query: "q", results: [{ title: "只有标题", snippet: "只有摘要" }] }, now);
  assert.equal(added.added, 1);
});

test("讲过没接住会先冷却，冷却过了还能再给一次；讲过就换成历史", () => {
  const book = addNewsItems({}, { domain: GOSSIP, query: "q", results: ROWS }, now).book;
  const first = nextNewsItem(book, now);
  assert.equal(first.title, ROWS[0].title);
  const offered = markNewsOffered(book, first.id, now);
  const secondRow = nextNewsItem(offered, now);
  assert.equal(secondRow.title, ROWS[1].title, "刚端出去的那条进入冷却，先端池子里另一条");
  assert.equal(nextNewsItem(offered, new Date(now.getTime() + 2 * 60 * 60 * 1000)).title, ROWS[1].title);
  const shared = markNewsOffered(offered, secondRow.id, now);
  const done = markNewsShared(shared, secondRow.id, "我刷到个事", now);
  assert.equal(nextNewsItem(done, now), null, "两条都刚端过，这一轮先不硬塞");
  assert.equal(nextNewsItem(done, new Date(now.getTime() + 7 * 60 * 60 * 1000)).id, first.id,
    "冷却过了再给一次机会，不至于一次不中就永不再提");
  assert.equal(done.history.length, 1);
  assert.equal(done.items.find((row) => row.id === secondRow.id).sharedText, "我刷到个事");
});

test("被否掉的这条不再端第二次", () => {
  const book = addNewsItems({}, { domain: GOSSIP, query: "q", results: ROWS }, now).book;
  const first = nextNewsItem(book, now);
  const rejected = rejectNewsItem(book, first.id, "只是自己的心情", now);
  assert.equal(nextNewsItem(rejected, new Date(now.getTime() + 10 * 60 * 60 * 1000)).title, ROWS[1].title);
  assert.equal(rejected.items.find((row) => row.id === first.id).rejectionReason, "只是自己的心情");
});

test("过期条目在归一化时就被清掉，不会端出一条十几天前的旧事", () => {
  const book = addNewsItems({}, { domain: GOSSIP, query: "q", results: ROWS }, now).book;
  const later = normalizeNewsBook(book, new Date(now.getTime() + 30 * DAY));
  assert.equal(later.items.length, 0);
});

test("一天四条封顶，配额归零就是真的关掉", () => {
  assert.equal(newsShareLimit(undefined), NEWS_MAX_PER_DAY);
  assert.equal(newsShareLimit(0), 0);
  assert.equal(newsShareLimit(99), 0);
  let runtime = null;
  for (let sent = 0; sent < NEWS_MAX_PER_DAY; sent += 1) {
    assert.equal(newsQuotaAvailable(runtime, undefined, "2026-10-20"), true, `第 ${sent + 1} 条还在配额里`);
    runtime = noteNewsSent(runtime, "2026-10-20");
  }
  assert.equal(newsQuotaAvailable(runtime, undefined, "2026-10-20"), false, "满了就不再发");
  assert.equal(newsQuotaAvailable(runtime, undefined, "2026-10-21"), true, "换一天就恢复");
});

test("给伙伴的材料块说清这是外面在发生的一件事，并保留外部内容边界", () => {
  const item = addNewsItems({}, { domain: GOSSIP, query: "q", results: ROWS }, now).book.items[0];
  const text = newsText(item, { partnerName: "小花" });
  assert.match(text, /你刚刷到的一条消息/);
  assert.match(text, new RegExp(item.title));
  assert.match(text, /外部文本/);
  assert.match(text, /不要问「你怎么看」/);
  // 2026-10-21：说法不一就让伙伴按自己判断讲，不要求先声明不确定。
  assert.match(text, /照样按自己的判断讲/);
  assert.doesNotMatch(text, /轻轻说不确定/);
  assert.equal(text.includes("https://example.com/a"), false, "链接由系统处理，不让它照抄");
  assert.equal(newsText(null), "");
});

/* ── 视频降级候选 ── */

const VIDEO = {
  bvid: "BV1n7JU69EQA", cid: 12345, page: 1, duration: 104,
  title: "实木菜板修复", author: "木作阿青", link: "https://www.bilibili.com/video/BV1n7JU69EQA", desc: "",
};

test("只看标题和弹幕也算真看过：能收成候选，但必须标明没读字幕", () => {
  const danmakuOnly = {
    video: VIDEO, readKind: "danmaku", subtitle: [],
    danmakuHot: [{ text: "这也能修", count: 4 }], replies: [],
  };
  const item = makeVideoCandidate(danmakuOnly, { interest: { id: "wi_x", name: "手作" }, plan: { focus: "旧物修复" } }, now);
  assert.ok(item, "字幕不可信时不该整条作废——那是 10-20 一整天没出货的原因");
  assert.equal(item.readKind, "danmaku");
  assert.match(item.context, /你没读过字幕/);
  assert.match(item.context, /这也能修/);
});

test("只有标题仍然不算可分享：那等于什么都没读", () => {
  const titleOnly = { video: VIDEO, readKind: "title-only", subtitle: [], danmakuHot: [], replies: [] };
  assert.equal(makeVideoCandidate(titleOnly, {}, now), null);
});

test("字幕档照旧标明读过字幕，两档不能串", () => {
  const subtitle = {
    video: VIDEO, readKind: "subtitle",
    subtitle: [{ from: 0, to: 5, content: "先清理旧胶，再慢慢补。" }],
    danmakuHot: [], replies: [],
  };
  const item = makeVideoCandidate(subtitle, {}, now);
  assert.equal(item.readKind, "subtitle");
  assert.match(item.context, /你已经读过字幕/);
  assert.equal(item.context.includes("你没读过字幕"), false);
});

/* ── 种子题面配额 ── */

test("求解和交换一类一条批次只收一条，其余留给不逼人选边的类型", () => {
  const reply = [
    "求解｜该不该把奖金拆成两期发｜我怕拆了就没气氛了",
    "求解｜该不该拆成两期｜我更怕一次给完就散了",
    "交换｜各自怎么收自己的小奖状｜我贴便利贴她画小人",
    "交换｜交换怎么分家务｜我按人头她按分钟",
    "自曝｜我给一件事颁奖时最爱现编奖名｜上回临时叫它拖延终结奖",
    "站队｜短奖状该正式还是熟人盖章｜我偏熟人盖章",
    "好奇｜奖状到底该写多长｜我总觉得三行就够",
  ].join("\n");
  const rows = parseSeedReply(reply);
  const kinds = rows.map((row) => row.kind);
  assert.equal(kinds.filter((kind) => kind === "ask").length, 1);
  assert.equal(kinds.filter((kind) => kind === "exchange").length, 1);
  assert.ok(rows.length >= 4, "压配额不是把一批砍没了");
});

test("没有问句型的那一批照旧全收", () => {
  const reply = [
    "自曝｜我浇水必失败三次才记住｜第三次才算出量",
    "站队｜旧物该修还是该换｜我偏修",
    "好奇｜旧标签撕下来还有粘性吗｜我撕过一半就后悔",
    "自曝｜我给小事颁奖会现编奖名｜上回叫它拖延终结奖",
  ].join("\n");
  assert.equal(parseSeedReply(reply).length, 4);
});
