import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_TOOL,
  IMAGE_TOOL_NAME,
  formatImageMatches,
  parseImageTime,
  pickImageMessages,
  resolveImageRange,
} from "../lib/image-tool.js";

const at = (iso) => new Date(iso).getTime();

test("工具声明的名字和参数得对得上，别让模型猜字段", () => {
  assert.equal(IMAGE_TOOL.name, IMAGE_TOOL_NAME);
  assert.deepEqual(Object.keys(IMAGE_TOOL.parameters.properties).sort(), ["keyword", "since", "until"]);
  assert.deepEqual(IMAGE_TOOL.parameters.required, []);
});

test("时间只认年月日这种写法，自然语言不猜", () => {
  assert.equal(parseImageTime("2026-10-26"), at("2026-10-26T00:00:00"));
  assert.equal(parseImageTime("2026-10-26 17:00"), at("2026-10-26T17:00:00"));
  assert.equal(parseImageTime("2026-10-26T17:30:00.000Z"), Number.isFinite(parseImageTime("2026-10-26T17:30:00.000Z")) ? parseImageTime("2026-10-26T17:30:00.000Z") : 0);
  // 「昨天五点」这种话由 ta 自己换算成日期；收到原话就当没填，不瞎猜。
  assert.equal(parseImageTime("昨天五点"), null);
  assert.equal(parseImageTime(""), null);
  assert.equal(parseImageTime(null), null);
});

test("只给一头也能翻：没写的这头不会把范围挡没", () => {
  const now = at("2026-10-27T09:00:00");
  const both = resolveImageRange({ since: "2026-10-26 17:00", until: "2026-10-26 18:00" }, now);
  assert.equal(both.from, at("2026-10-26T17:00:00"));
  assert.equal(both.to, at("2026-10-26T18:00:00"));
  const onlySince = resolveImageRange({ since: "2026-10-26" }, now);
  assert.equal(onlySince.from, at("2026-10-26T00:00:00"));
  assert.equal(onlySince.to, now);
  const empty = resolveImageRange({}, now);
  assert.equal(empty.from, 0);
  assert.equal(empty.to, now);
});

const thread = [
  { role: "user", at: "2026-10-26T17:00:00", attachment: { id: "img_a" }, text: "这段报错你看" },
  { role: "assistant", at: "2026-10-26T17:01:00", text: "我看看" },
  { role: "user", at: "2026-10-26T17:32:00", attachment: { id: "img_b" }, text: "还有这张" },
  { role: "user", at: "2026-10-26T18:00:00", text: "没有图的一条" },
  { role: "user", at: "2026-10-27T09:00:00", attachment: { id: "img_c" }, text: "早上这张" },
];
const metaOf = (id) => ({
  img_a: { title: "Python 报错截图", description: "一段 KeyError 堆栈" },
  img_b: { title: "另一张截图", description: "浏览器页面" },
  img_c: { title: "晨光", description: "窗外的天" },
}[id] ?? null);

test("按那一小时翻，五点那张和五点半那张分得开", () => {
  const five = pickImageMessages(thread, { from: at("2026-10-26T17:00:00"), to: at("2026-10-26T17:00:00") + 60_000 - 1 }, metaOf);
  assert.deepEqual(five.map((row) => row.attachmentId), ["img_a"]);
  const halfPast = pickImageMessages(thread, { from: at("2026-10-26T17:30:00"), to: at("2026-10-26T17:59:59") }, metaOf);
  assert.deepEqual(halfPast.map((row) => row.attachmentId), ["img_b"]);
});

test("时间按消息算，不按图片算：同一张图发两次就是两个时刻", () => {
  const twice = [
    { role: "user", at: "2026-10-26T17:00:00", attachment: { id: "img_same" }, text: "你看" },
    { role: "user", at: "2026-10-26T17:32:00", attachment: { id: "img_same" }, text: "还是这张" },
  ];
  const rows = pickImageMessages(twice, resolveImageRange({}), () => null);
  assert.equal(rows.length, 2, "两次发送是两条记录，不能因为图是同一张就合成一条");
  assert.deepEqual(rows.map((row) => row.at), [at("2026-10-26T17:00:00"), at("2026-10-26T17:32:00")]);
});

test("关键词在图、她的话、描述里都找", () => {
  const all = resolveImageRange({});
  assert.deepEqual(pickImageMessages(thread, { ...all, keyword: "报错" }, metaOf).map((r) => r.attachmentId), ["img_a"]);
  assert.deepEqual(pickImageMessages(thread, { ...all, keyword: "浏览器" }, metaOf).map((r) => r.attachmentId), ["img_b"]);
  assert.deepEqual(pickImageMessages(thread, { ...all, keyword: "早上" }, metaOf).map((r) => r.attachmentId), ["img_c"]);
  assert.equal(pickImageMessages(thread, { ...all, keyword: "不存在的词" }, metaOf).length, 0);
});

test("结果按时间旧到新，每条带上她当时那句话", () => {
  const rows = pickImageMessages(thread, resolveImageRange({}), metaOf);
  assert.deepEqual(rows.map((row) => row.attachmentId), ["img_a", "img_b", "img_c"]);
  const text = formatImageMatches(rows);
  assert.match(text, /共 3 张/u);
  assert.match(text, /她说「这段报错你看」/u);
  assert.match(text, /Python 报错截图/u);
  // 没说话那条不能编一句出来。
  assert.match(formatImageMatches([{ at: at("2026-10-26T18:00:00"), said: "", title: "图", description: "描述" }]), /她当时没说话/u);
});

test("翻不到就给空，别拿一句废话充数", () => {
  assert.equal(formatImageMatches([]), "");
  assert.equal(formatImageMatches(null), "");
});
