import test from "node:test";
import assert from "node:assert/strict";

import {
  addVideoCandidate,
  applyVideoFeedback,
  arrangeShareBubbles,
  hasVideoShareLink,
  makeVideoCandidate,
  matchVideoStop,
  nextVideoCandidate,
  normalizeVideoBook,
  noteVideoSent,
  offerVideoCandidate,
  recordVideoShare,
  removeVideoSource,
  selectVideoShares,
  videoCognitions,
  videoQuotaAvailable,
  videoRecallText,
  videoShareLimit,
} from "../lib/video-sharing.js";
import { extractMemoryFeedback } from "../lib/longterm.js";

const now = new Date("2026-10-16T10:00:00.000Z");
const VIDEO = {
  bvid: "BV1n7JU69EQA", cid: 12345, page: 1, duration: 104,
  title: "实木菜板修复", author: "木作阿青", link: "https://www.bilibili.com/video/BV1n7JU69EQA",
  desc: "不会保存这个简介", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/secret?token=private",
};
const MATERIALS = {
  video: VIDEO, readKind: "subtitle",
  subtitle: [
    { from: 0, to: 5, content: "这块实木菜板边缘开裂了，先清理旧胶。" },
    { from: 6, to: 12, content: "木作阿青用夹具固定，再慢慢补胶打磨。" },
  ],
  danmakuHot: [{ text: "这也能修", count: 4 }],
  replies: [{ text: "最后的打磨步骤挺细" }],
  cookie: "SESSDATA=must-not-persist",
};
const candidate = (at = now, materials = MATERIALS, extra = {}) => makeVideoCandidate(
  materials, { interest: { id: "i-wood", name: "木作" }, plan: { focus: "旧物修复" }, ...extra }, at,
);
const shareBook = () => {
  const item = candidate();
  return recordVideoShare(
    addVideoCandidate({ pending: [], shares: [] }, item, now), item,
    { id: "share-1", role: "assistant", text: `这个修复过程挺妙的：${item.video.link}` }, now,
  );
};

test("candidate only accepts usable subtitle materials and stores the packed context, not raw credentials", () => {
  const item = candidate();
  assert.ok(item);
  assert.equal(item.id, "BV1n7JU69EQA:1");
  assert.equal(item.context.length <= 2400, true);
  assert.match(item.context, /已经读过字幕/);
  assert.match(item.context, /旧胶/);
  assert.equal(JSON.stringify(item).includes("SESSDATA"), false);
  assert.equal(JSON.stringify(item).includes("aisubtitle.hdslb.com"), false);
  assert.equal(item.cognition.kind, "event");
  assert.match(item.cognition.id, /^video_/u);
  assert.ok(item.cognition.text.length <= 360);
  assert.match(item.cognition.text, /尚未确认分享/u);
  assert.doesNotMatch(item.cognition.text, /我分享过/u);
  assert.deepEqual(item.cognition.sourceIds, []);
  assert.equal(item.expiresAt, new Date(now.getTime() + 7 * 86400000).toISOString());

  // 2026-10-20：以前字幕不可信就整条作废，于是 10-20 那天三条候选全灭、一整天没出货。
  // 现在退一档也收：弹幕档是“真看过弹幕”，只是上下文里必须写明没读字幕。
  const danmakuOnly = candidate(now, { ...MATERIALS, readKind: "danmaku" });
  assert.ok(danmakuOnly, "字幕不可信时不该整条作废");
  assert.equal(danmakuOnly.readKind, "danmaku");
  assert.match(danmakuOnly.context, /你没读过字幕/);
  assert.equal(danmakuOnly.context.includes("你已经读过字幕"), false);
  assert.equal(candidate(now, { ...MATERIALS, subtitle: [] }), null);
  assert.equal(candidate(now, { ...MATERIALS, subtitle: [{ content: "  " }] }), null);
  assert.equal(candidate(now, { ...MATERIALS, readKind: "title-only" }), null, "只标题等于什么都没读，仍不收");
  for (const bad of [
    { ...VIDEO, bvid: "not-a-bvid" }, { ...VIDEO, cid: 0 }, { ...VIDEO, page: 0 },
    { ...VIDEO, duration: 0 }, { ...VIDEO, link: "http://www.bilibili.com/video/BV1n7JU69EQA" },
    { ...VIDEO, link: "https://example.com/video/BV1n7JU69EQA" },
    { ...VIDEO, link: "https://www.bilibili.com/video/BV1n7JU69EQA?token=signed" },
  ]) assert.equal(candidate(now, { ...MATERIALS, video: bad }), null);
});

test("normalization expires pending at seven days, keeps only two, and never FIFO-caps shares", () => {
  const rows = Array.from({ length: 4 }, (_, i) => {
    const bvid = `BV${String(i).padStart(10, "0")}`;
    return candidate(new Date(now.getTime() + i * 1000), {
      ...MATERIALS, video: { ...VIDEO, bvid, link: `https://www.bilibili.com/video/${bvid}` },
    });
  });
  const pending = normalizeVideoBook({ pending: rows, extra: "discard", shares: [] }, now).pending;
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, rows[2].id);
  assert.equal(pending[1].id, rows[3].id);
  assert.deepEqual(Object.keys(normalizeVideoBook({}, now)).sort(), ["pending", "shares"]);

  const book = { pending: [], shares: [] };
  for (let i = 0; i < 4; i += 1) {
    const bvid = `BV${String(i).padStart(10, "0")}`;
    const item = candidate(now, { ...MATERIALS, video: { ...VIDEO, bvid, link: `https://www.bilibili.com/video/${bvid}` } });
    const recorded = recordVideoShare(book, item, { id: `s${i}`, role: "assistant", text: item.video.link }, now);
    book.shares.push(...recorded.shares);
  }
  assert.equal(normalizeVideoBook(book, now).shares.length, 4);
  assert.deepEqual(normalizeVideoBook({ pending: [rows[0]], shares: [] }, new Date(now.getTime() + 8 * 86400000)), { pending: [], shares: [] });
});

test("add deduplicates same bvid/page; next and offer use six-hour cooldown", () => {
  const item = candidate();
  const first = addVideoCandidate({ pending: [], shares: [] }, item, now);
  assert.equal(addVideoCandidate(first, item, now).pending.length, 1);
  assert.equal(nextVideoCandidate(first, now).id, item.id);
  const offered = offerVideoCandidate(first, item.id, now);
  assert.equal(offered.pending[0].offeredAt, now.toISOString());
  assert.equal(nextVideoCandidate(offered, new Date(now.getTime() + 6 * 3600000 - 1)), null);
  assert.equal(nextVideoCandidate(offered, new Date(now.getTime() + 6 * 3600000)).id, item.id);
  assert.deepEqual(offerVideoCandidate(first, "missing", now), first);

  const page2 = candidate(now, { ...MATERIALS, video: {
    ...VIDEO, page: 2, link: "https://www.bilibili.com/video/BV1n7JU69EQA?p=2",
  } });
  assert.equal(addVideoCandidate(first, page2, now).pending.length, 2);
  assert.equal(addVideoCandidate({ ...first, pending: [] , shares: [{ ...recordVideoShare(first, item, { id: "s1", role: "assistant", text: item.video.link }, now).shares[0] }] }, item, now).pending.length, 0);
});

test("recording requires an actual assistant message with the complete link and deduplicates shares", () => {
  const item = candidate();
  const base = addVideoCandidate({ pending: [], shares: [] }, item, now);
  assert.deepEqual(recordVideoShare(base, item, { id: "u1", role: "user", text: item.video.link }, now), base);
  assert.deepEqual(recordVideoShare(base, item, { id: "a1", role: "assistant", text: "我发了这个" }, now), base);
  const sent = recordVideoShare(base, item, { id: "a1", role: "assistant", text: `看这个 ${item.video.link}` }, now);
  assert.equal(sent.pending.length, 0);
  assert.equal(sent.shares.length, 1);
  assert.deepEqual(sent.shares[0].sourceIds, ["a1"]);
  assert.equal(sent.shares[0].messageId, "a1");
  assert.equal(sent.shares[0].sharedText, `看这个 ${item.video.link}`);
  assert.match(sent.shares[0].cognition.text, /^我分享过/u);
  assert.match(sent.shares[0].cognition.text, /仅读到字幕资料，未看画面/u);
  assert.equal(recordVideoShare(sent, item, { id: "a2", role: "assistant", text: item.video.link }, now).shares.length, 1);
});

test("video cognition uses the longterm shape; recall includes complete boundaries without partial rows", () => {
  const book = shareBook();
  const cognitions = videoCognitions(book.shares);
  assert.equal(cognitions.length, 1);
  assert.deepEqual(Object.keys(cognitions[0]).sort(), [
    "id", "kind", "title", "text", "keys", "sourceIds", "at", "updatedAt", "certainty", "note", "feedbackSourceIds", "resultMessageIds",
  ].sort());
  assert.equal(cognitions[0].sourceIds[0], "share-1");

  const recalled = selectVideoShares(book, "菜板修复");
  assert.equal(recalled.length, 1);
  const text = videoRecallText(recalled);
  assert.match(text, /原链接：https:\/\/www\.bilibili\.com\/video\/BV1n7JU69EQA/u);
  assert.match(text, /实木菜板修复/u);
  assert.match(text, /只读到字幕资料，没有看视频画面/u);
  assert.match(text, /边缘开裂/u);
  assert.match(text, /当时实际发出/u);
  assert.ok(text.length <= 3000);
  assert.deepEqual(selectVideoShares(book, "完全无关"), []);
  assert.equal(selectVideoShares(book, "完全无关", { recentMessageIds: ["share-1"] }).length, 1);

  const huge = { ...book.shares[0], context: "材料".repeat(2400) };
  assert.equal(videoRecallText([huge]), "");
  assert.deepEqual(selectVideoShares({ pending: [], shares: [huge] }, "", { recentMessageIds: ["share-1"] }), []);
});

function withSubtitleMarker(book) {
  return { ...book, shares: book.shares.map((row) => ({
    ...row, context: `${row.context}\n\n【字幕资料】${MATERIALS.subtitle.map((item) => item.content).join(" / ")}`,
  })) };
}
function feedbackFor(book, { quote, sourceId = "u-feedback", decision = "hold", note = "我自己再想想" } = {}) {
  const selected = videoCognitions(book.shares);
  const payload = `<memory-update>${JSON.stringify({ updates: [{
    id: selected[0].id, decision, note, sourceId, quote,
  }] })}</memory-update>`;
  const messages = [{ id: sourceId, role: "user", text: quote }];
  return { updates: extractMemoryFeedback(payload, selected, messages).updates, messages };
}

test("feedback needs current literal user source, current assistant result, and matching snapshot; concrete mention renews idempotently", () => {
  const book = withSubtitleMarker(shareBook());
  const quote = "夹具固定之后补胶打磨的步骤我记住了。";
  const { updates, messages } = feedbackFor(book, { quote });
  const window = [...messages, { id: "reply-1", role: "assistant", text: "嗯，我也记得。" }];
  const updated = applyVideoFeedback(book, updates, { messages: window, resultMessageId: "reply-1", now });
  assert.equal(updated.shares[0].renewals.length, 1);
  assert.deepEqual(updated.shares[0].renewals[0], {
    kind: "user", sourceId: "u-feedback", resultMessageId: "reply-1", quote, at: now.toISOString(),
  });
  assert.equal(updated.shares[0].expiresAt, new Date(now.getTime() + 7 * 86400000).toISOString());
  assert.match(videoRecallText(updated.shares), /当前伙伴认知/u);
  assert.match(videoRecallText(updated.shares), /伙伴自己的备注：我自己再想想/u);
  assert.deepEqual(applyVideoFeedback(updated, updates, { messages: window, resultMessageId: "reply-1", now }), updated);

  assert.deepEqual(applyVideoFeedback(book, updates, { messages, resultMessageId: "missing", now }), book);
  assert.deepEqual(applyVideoFeedback(book, [{ ...updates[0], expectedText: "stale snapshot" }], {
    messages: window, resultMessageId: "reply-1", now,
  }), book);
  assert.deepEqual(applyVideoFeedback(book, updates, {
    messages: [...messages, { id: "reply-1", role: "user", text: "not assistant" }], resultMessageId: "reply-1", now,
  }), book);
  assert.deepEqual(applyVideoFeedback(book, updates, {
    messages: [{ ...messages[0], recalled: true }, ...window.slice(1)], resultMessageId: "reply-1", now,
  }), book);

  const generic = "别用固定句型说口味啦，我知道你是想分享。";
  const genericFeedback = feedbackFor(book, { quote: generic, sourceId: "u-generic" });
  const genericResult = applyVideoFeedback(book, genericFeedback.updates, {
    messages: [...genericFeedback.messages, { id: "r-generic", role: "assistant", text: "好。" }], resultMessageId: "r-generic", now,
  });
  assert.equal(genericResult.shares[0].renewals.length, 0);
});

test("removing a share, feedback source, or result dependency removes that share", () => {
  const book = shareBook();
  const quote = "实木菜板修复我记得。";
  const { updates, messages } = feedbackFor(book, { quote });
  const updated = applyVideoFeedback(book, updates, {
    messages: [...messages, { id: "reply-1", role: "assistant", text: "嗯。" }], resultMessageId: "reply-1", now,
  });
  for (const id of ["share-1", "u-feedback", "reply-1"]) assert.deepEqual(removeVideoSource(updated, id, now), { pending: [], shares: [] });
  assert.deepEqual(removeVideoSource(updated, "other", now), updated);
});

test("global quota is independent and stop matching requires an explicit global request", () => {
  for (const value of [0, 1, 2, 3, 4, 5, "2"]) assert.equal(Number.isInteger(videoShareLimit(value)), true);
  for (const value of [-1, 6, 1.5, "no", null, true]) assert.equal(videoShareLimit(value), 0);
  assert.equal(videoQuotaAvailable({ day: "d1", count: 1, unrelated: true }, 2, "d1"), true);
  assert.equal(videoQuotaAvailable({ day: "d1", count: 2 }, 2, "d1"), false);
  assert.equal(videoQuotaAvailable({ day: "d0", count: 5 }, 2, "d1"), true);
  assert.equal(videoQuotaAvailable({}, 0, "d1"), false);
  assert.deepEqual(noteVideoSent({ day: "d1", count: 2, unrelated: true }, "d1"), { day: "d1", count: 3 });
  assert.deepEqual(noteVideoSent({ day: "d0", count: 4 }, "d1"), { day: "d1", count: 1 });

  for (const value of [
    "以后别给我发视频", "不要再给我分享视频了", "停止视频分享", "全局关闭视频分享",
    "气死我了，别再给我分享视频", "烦死了，以后别给我发视频了",
  ]) assert.equal(matchVideoStop(value), true, value);
  for (const value of [
    "别再给我发这种视频", "以后不要再分享恐怖视频", "气死我了", "烦死了这些视频",
    "这个视频不好看", "我现在很烦",
  ]) assert.equal(matchVideoStop(value), false, value);
});

test("分享卡片有时在前有时在后，模型自己写的长链接不重复", () => {
  // 2026-10-22：以前固定「先两句理解，再挂链接」，看久了像模板。
  const video = {
    link: "https://www.bilibili.com/video/BV1n7JU69EQA",
    shareLink: "https://b23.tv/BV1n7JU69EQA",
    shareText: "【实木菜板修复-哔哩哔哩】 https://b23.tv/BV1n7JU69EQA",
  };
  const bubbles = ["这菜板修得我服", "看这个 https://www.bilibili.com/video/BV1n7JU69EQA"];
  assert.deepEqual(arrangeShareBubbles(bubbles, video, { linkFirst: false }),
    ["这菜板修得我服", "看这个", video.shareText], "内容先、链接后");
  assert.deepEqual(arrangeShareBubbles(bubbles, video, { linkFirst: true }),
    [video.shareText, "这菜板修得我服", "看这个"], "卡片先、内容后");
  // 两种顺序下正文都还认得出这条分享
  for (const linkFirst of [false, true]) {
    const merged = arrangeShareBubbles(bubbles, video, { linkFirst });
    assert.equal(hasVideoShareLink(merged.join("\n"), video), true);
  }
  // 模型本来就只写了一句时也不会截空
  assert.deepEqual(arrangeShareBubbles(["卡片先来"], video, { linkFirst: true }), [video.shareText, "卡片先来"]);
});

test("分享文案照 B 站客户端的样：标题 + 官方短链", () => {
  const item = candidate();
  assert.equal(item.video.shareLink, "https://b23.tv/BV1n7JU69EQA");
  assert.equal(item.video.shareText, "【实木菜板修复-哔哩哔哩】 https://b23.tv/BV1n7JU69EQA");
});

test("长标题在分享文案里截断，分P视频用带 p 的长链接", () => {
  const long = {
    ...MATERIALS,
    video: { ...VIDEO, title: "夏天阳台种菜笔记".repeat(6), page: 2, link: "https://www.bilibili.com/video/BV1n7JU69EQA?p=2" },
  };
  const item = makeVideoCandidate(long, { interest: { id: "i-wood", name: "木作" }, plan: { focus: "旧物修复" } }, now);
  assert.match(item.video.shareText, /…-哔哩哔哩】 /u);
  assert.match(item.video.shareText, /\?p=2$/u, "分P 短链会跳回第一页，只能给长链接");
});

test("hasVideoShareLink 短链长链都认，脏文本不认", () => {
  const item = candidate();
  assert.equal(hasVideoShareLink(`看看这个 ${item.video.shareLink}`, item.video), true);
  assert.equal(hasVideoShareLink(`旧记录 ${item.video.link}`, item.video), true);
  assert.equal(hasVideoShareLink("只是聊聊天", item.video), false);
  assert.equal(hasVideoShareLink("", item.video), false);
});
