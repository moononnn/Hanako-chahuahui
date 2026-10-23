import test from "node:test";
import assert from "node:assert/strict";

import {
  READ_VIDEO_TOOL,
  READ_VIDEO_TOOL_NAME,
  VIDEO_TOOL_EMPTY_TEXT,
  VIDEO_TOOL_UNSUPPORTED_TEXT,
  formatVideoShelf,
  listVideoShelf,
} from "../lib/video-tool.js";

const NOW = Date.parse("2026-10-23T02:00:00.000Z");
const msg = (minutesAgo, text, extra = {}) => ({
  id: `m${minutesAgo}`,
  role: "user",
  text,
  at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  ...extra,
});
const LINK_A = "【疯狂屠杀，真案改编！万字细嗦《悬案》第二案（P1）】 https://www.bilibili.com/video/BV1kFgD6rEYr/?share_source=copy_web";
const LINK_B = "【DSH 插件下载榜横评！】 https://www.bilibili.com/video/BV1nkJ66vEP7/";

// ── 工具声明 ───────────────────────────────────────────────────

test("工具声明按宿主契约来：有名字、有 url 参数、必填", () => {
  assert.equal(READ_VIDEO_TOOL.name, READ_VIDEO_TOOL_NAME);
  assert.equal(READ_VIDEO_TOOL.parameters.type, "object");
  assert.deepEqual(READ_VIDEO_TOOL.parameters.required, ["url"]);
  assert.equal(READ_VIDEO_TOOL.parameters.additionalProperties, false);
  // 描述里得说清边界：只认 B 站普通视频，别让人以为番剧也能读。
  assert.match(READ_VIDEO_TOOL.description, /B 站/);
  assert.match(READ_VIDEO_TOOL.description, /番剧/);
});

test("失败文案不暴露内部步骤", () => {
  for (const text of [VIDEO_TOOL_EMPTY_TEXT, VIDEO_TOOL_UNSUPPORTED_TEXT]) {
    assert.doesNotMatch(text, /接口|请求|网络|缓存/);
  }
});

// ── 手边清单 ───────────────────────────────────────────────────

test("列出她发过的视频，标题从分享文案里抠出来", () => {
  const rows = listVideoShelf({ messages: [msg(30, LINK_A)], now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bvid, "BV1kFgD6rEYr");
  assert.match(rows[0].title, /悬案/);
  assert.equal(rows[0].page, 1);
});

test("从新往旧，最多三条", () => {
  const messages = [
    msg(300, "https://www.bilibili.com/video/BV1aaaaaaaaa"),
    msg(200, "https://www.bilibili.com/video/BV1bbbbbbbbb"),
    msg(100, "https://www.bilibili.com/video/BV1cccccccccc"),
    msg(10, LINK_A),
  ];
  const rows = listVideoShelf({ messages, now: NOW });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].bvid, "BV1kFgD6rEYr");
  assert.equal(rows[2].bvid, "BV1bbbbbbbbb");
});

test("同一个视频重复发只列一次", () => {
  const messages = [msg(50, LINK_A), msg(10, LINK_A)];
  const rows = listVideoShelf({ messages, now: NOW });
  assert.equal(rows.length, 1);
});

test("超过一天的不再列出来", () => {
  const rows = listVideoShelf({ messages: [msg(25 * 60, LINK_A)], now: NOW });
  assert.equal(rows.length, 0);
});

test("她说的和别人说的分得清：只认她发的", () => {
  const messages = [
    { id: "a1", role: "assistant", text: LINK_A, at: new Date(NOW - 60_000).toISOString() },
    msg(30, "这个好看"),
  ];
  assert.equal(listVideoShelf({ messages, now: NOW }).length, 0);
});

test("撤回的不算，番剧不算，短码先不算", () => {
  const messages = [
    msg(40, LINK_A, { recalled: true }),
    msg(30, "https://www.bilibili.com/bangumi/play/ep123456"),
    msg(20, "【某个视频】 https://b23.tv/aB3dE9z"),
    msg(10, "今天好累"),
  ];
  assert.equal(listVideoShelf({ messages, now: NOW }).length, 0);
});

test("只发裸 BV 号也认", () => {
  const rows = listVideoShelf({ messages: [msg(10, "BV1kFgD6rEYr 这个你看了没")], now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "");
});

// ── 清单文案 ───────────────────────────────────────────────────

test("空清单返回空串，不占提示词位置", () => {
  assert.equal(formatVideoShelf([]), "");
  assert.equal(formatVideoShelf(null), "");
});

test("清单里写清「看不看随你」，不写成任务", () => {
  const text = formatVideoShelf(listVideoShelf({ messages: [msg(30, LINK_A)], now: NOW }));
  assert.match(text, /你随时可以点开看/);
  assert.match(text, /也可以不看/);
  assert.match(text, /BV1kFgD6rEYr/);
  assert.match(text, new RegExp(READ_VIDEO_TOOL_NAME));
  // 不能出现「你应该」「记得去看」这类下命令的口气。
  assert.doesNotMatch(text, /你应该|必须|记得去/);
});

test("没标题时如实说没标题，不编一个", () => {
  const text = formatVideoShelf(listVideoShelf({ messages: [msg(30, "BV1kFgD6rEYr")], now: NOW }));
  assert.match(text, /没写标题/);
});

test("分P要在清单里标出来", () => {
  const text = formatVideoShelf(
    listVideoShelf({ messages: [msg(30, "https://www.bilibili.com/video/BV1kFgD6rEYr?p=4")], now: NOW }),
  );
  assert.match(text, /（P4）/);
});
