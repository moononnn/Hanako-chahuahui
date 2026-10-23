import test from "node:test";
import assert from "node:assert/strict";

import {
  INBOUND_MAX_SECONDS,
  collectInboundVideo,
  extractVideoLink,
  pickInboundSource,
  resolveShortLink,
} from "../lib/video-inbound.js";
import { isAllowedVideoUrl } from "../lib/video-source.js";
import { packMaterials } from "../lib/video-materials.js";

/** 造一个只回固定结构的假网络层。videoGet 只用到 ok / url / json / text。 */
function jsonFetcher(payload, { url = "", ok = true, status = 200 } = {}) {
  const calls = [];
  const fetcher = async (href) => {
    calls.push(String(href));
    return {
      ok, status, url: url || String(href),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  fetcher.calls = calls;
  return fetcher;
}

// ── 认链接 ─────────────────────────────────────────────────────

test("标准视频链接能切出 BV 号", () => {
  const r = extractVideoLink("快看 https://www.bilibili.com/video/BV1GJ411x7h7 这个");
  assert.equal(r.kind, "video");
  assert.equal(r.bvid, "BV1GJ411x7h7");
  assert.equal(r.page, 1);
});

test("分P参数读得出，且越界值退回 1", () => {
  assert.equal(extractVideoLink("https://www.bilibili.com/video/BV1GJ411x7h7?p=3").page, 3);
  assert.equal(extractVideoLink("https://www.bilibili.com/video/BV1GJ411x7h7?p=0").page, 1);
  assert.equal(extractVideoLink("https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=x&p=2").page, 2);
});

test("b23.tv 后面直接跟 BV 号时不发请求，直接切", () => {
  const r = extractVideoLink("https://b23.tv/BV1GJ411x7h7");
  assert.equal(r.kind, "video");
  assert.equal(r.bvid, "BV1GJ411x7h7");
});

test("b23.tv 短码走解析分支", () => {
  const r = extractVideoLink("【某个视频-哔哩哔哩】 https://b23.tv/aB3dE9z");
  assert.equal(r.kind, "short");
  assert.equal(r.code, "aB3dE9z");
});

test("零宽字符不会把 BV 号拆成两截", () => {
  const r = extractVideoLink("https://www.bilibili.com/video/BV1GJ\u200b411x7h7");
  assert.equal(r.kind, "video");
  assert.equal(r.bvid, "BV1GJ411x7h7");
});

test("番剧链接认成不支持，不装看不见", () => {
  const r = extractVideoLink("https://www.bilibili.com/bangumi/play/ep123456");
  assert.equal(r.kind, "unsupported");
  assert.match(r.reason, /番剧/);
});

test("专栏与动态同样算不支持", () => {
  assert.equal(extractVideoLink("https://www.bilibili.com/read/cv123456").kind, "unsupported");
  assert.equal(extractVideoLink("https://www.bilibili.com/opus/123456").kind, "unsupported");
});

test("普通聊天文本不是链接", () => {
  assert.equal(extractVideoLink("今天好困啊"), null);
  assert.equal(extractVideoLink("https://example.com/video/BV1GJ411x7h7"), null);
  assert.equal(extractVideoLink(""), null);
  assert.equal(extractVideoLink(null), null);
});

// ── 短链接解析 ──────────────────────────────────────────────────

test("短码跳转后能从落地地址拿到 BV 号", { skip: "b23.tv 未进宿主白名单，落地请求会被本层守卫先拦下；白名单开启后改回普通用例" }, async () => {
  const fetcher = jsonFetcher({}, { url: "https://www.bilibili.com/video/BV1GJ411x7h7" });
  const r = await resolveShortLink(fetcher, "aB3dE9z");
  assert.equal(r.ok, true);
  assert.equal(r.bvid, "BV1GJ411x7h7");
  assert.equal(r.page, 1);
  assert.equal(fetcher.calls[0], "https://b23.tv/aB3dE9z");
});

test("b23.tv 目前不在白名单：短码直接报一句，不发注定被拒的请求", async () => {
  const fetcher = jsonFetcher({});
  const r = await collectInboundVideo(fetcher, "【某个视频-哔哩哔哩】 https://b23.tv/aB3dE9z");
  assert.equal(r.ok, false);
  assert.equal(r.shortLinkDisabled, true);
  assert.match(r.reason, /完整地址/);
  assert.equal(fetcher.calls.length, 0);
  // 本层守卫确实拦着，不是靠调用方自觉。
  assert.equal(isAllowedVideoUrl("https://b23.tv/aB3dE9z").ok, false);
});

test("落地地址带分P时一并读出来", { skip: "b23.tv 未进宿主白名单" }, async () => {
  const fetcher = jsonFetcher({}, { url: "https://www.bilibili.com/video/BV1GJ411x7h7?p=4" });
  const r = await resolveShortLink(fetcher, "aB3dE9z");
  assert.equal(r.page, 4);
});

test("落地地址里没有 BV 号就不猜", { skip: "b23.tv 未进宿主白名单" }, async () => {
  const fetcher = jsonFetcher({}, { url: "https://www.bilibili.com/" });
  const r = await resolveShortLink(fetcher, "aB3dE9z");
  assert.equal(r.ok, false);
  assert.match(r.reason, /BV/);
});

test("短码形状不对时连请求都不发", async () => {
  const fetcher = jsonFetcher({});
  const r = await resolveShortLink(fetcher, "a");
  assert.equal(r.ok, false);
  assert.equal(fetcher.calls.length, 0);
});

test("短链请求失败如实报原因", { skip: "b23.tv 未进宿主白名单" }, async () => {
  const fetcher = jsonFetcher({}, { ok: false, status: 503 });
  const r = await resolveShortLink(fetcher, "aB3dE9z");
  assert.equal(r.ok, false);
  assert.match(r.reason, /503/);
});

// ── 取材料 ─────────────────────────────────────────────────────

const VIDEO_REPLY = {
  code: 0,
  data: {
    bvid: "BV1GJ411x7h7",
    aid: 1001,
    cid: 2002,
    page: 1,
    pages: [{ cid: 2002, page: 1, duration: 120 }],
    title: "一个测试视频",
    pic: "https://i0.hdslb.com/bfs/archive/a.jpg",
    desc: "简介",
    owner: { name: "某UP", mid: 9 },
    duration: 120,
    pubdate: 1700000000,
    tname: "生活",
    stat: { view: 1000, like: 10, favorite: 2 },
    tags: [{ tag_name: "日常" }],
  },
};

test("文本里没链接时直接返回失败，不发请求", async () => {
  const fetcher = jsonFetcher({});
  const r = await collectInboundVideo(fetcher, "今天天气不错");
  assert.equal(r.ok, false);
  assert.equal(fetcher.calls.length, 0);
});

test("不支持的页面类型不往下走", async () => {
  const fetcher = jsonFetcher({});
  const r = await collectInboundVideo(fetcher, "https://www.bilibili.com/bangumi/play/ep1");
  assert.equal(r.ok, false);
  assert.equal(r.unsupported, true);
  assert.equal(fetcher.calls.length, 0);
});

test("没有网络能力时如实失败", async () => {
  const r = await collectInboundVideo(null, "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(r.ok, false);
});

test("正常一条：元信息到手，没登录就拿不到字幕但元信息仍在", async () => {
  const fetcher = jsonFetcher(VIDEO_REPLY);
  const r = await collectInboundVideo(fetcher, "看这个 https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(r.ok, true);
  assert.equal(r.materials.video.bvid, "BV1GJ411x7h7");
  assert.equal(r.materials.video.title, "一个测试视频");
});

test("超长视频不整条作废：退回标题档，让她至少知道是哪一个", async () => {
  const long = {
    code: 0,
    data: { ...VIDEO_REPLY.data, duration: INBOUND_MAX_SECONDS + 600, pages: null },
  };
  const fetcher = jsonFetcher(long);
  const r = await collectInboundVideo(fetcher, "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(r.ok, true);
  assert.equal(r.materials.readKind, "title-only");
  assert.equal(r.materials.video.title, "一个测试视频");
  assert.match(r.materials.reason, /分钟/);
});

test("视频不存在时返回失败并说明原因", async () => {
  const fetcher = jsonFetcher({ code: -404, message: "啥都木有" });
  const r = await collectInboundVideo(fetcher, "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(r.ok, false);
  assert.match(r.reason, /404/);
});

// ── 挑源文本 ──────────────────────────────────────────────────

const NOW = Date.parse("2026-10-23T01:57:33.000Z");
const msg = (id, minutesAgo, text, extra = {}) => ({
  id, role: "user", text,
  at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  ...extra,
});
const LINK = "https://www.bilibili.com/video/BV1kFgD6rEYr/?share_source=copy_web";

test("目标那句带链接：直接用目标，不用往回翻", () => {
  const messages = [msg("m1", 2, `看这个 ${LINK}`), msg("m2", 1, "再试试哈")];
  const r = pickInboundSource({ messages, replyTargetId: "m1", latestText: "再试试哈", now: NOW });
  assert.match(r, /BV1kFgD6rEYr/);
});

test("目标那句只是补话：往回翻到链接那条（实机踩过的形状）", () => {
  // 茶话会每轮都绑回复目标，目标往往是「再试试哈」这种不带链接的补话。
  const messages = [msg("m1", 2, `【标题】 ${LINK}`), msg("m2", 1, "再试试哈")];
  const r = pickInboundSource({ messages, replyTargetId: "m2", latestText: "再试试哈", now: NOW });
  assert.match(r, /BV1kFgD6rEYr/);
});

test("目标 id 在消息里找不到：也往回翻，不能返回空", () => {
  const messages = [msg("m1", 2, LINK), msg("m2", 1, "你看看")];
  const r = pickInboundSource({ messages, replyTargetId: "m_missing", latestText: "你看看", now: NOW });
  assert.match(r, /BV1kFgD6rEYr/);
});

test("窗口外的旧链接不再触发", () => {
  const messages = [msg("m1", 30, LINK), msg("m2", 1, "今天天气不错")];
  const r = pickInboundSource({ messages, latestText: "今天天气不错", now: NOW });
  assert.equal(r, "今天天气不错");
});

test("只往回翻三条，更早的链接不跟过来", () => {
  const messages = [
    msg("m1", 5, LINK),
    msg("m2", 4, "第一句"),
    msg("m3", 3, "第二句"),
    msg("m4", 2, "第三句"),
    msg("m5", 1, "第四句"),
  ];
  const r = pickInboundSource({ messages, latestText: "第四句", now: NOW });
  assert.equal(r, "第四句");
});

test("撤回的链接不算，戳一戳也不算", () => {
  const messages = [
    msg("m1", 2, LINK, { recalled: true }),
    msg("m2", 2, LINK, { kind: "poke" }),
    msg("m3", 1, "你看看"),
  ];
  const r = pickInboundSource({ messages, latestText: "你看看", now: NOW });
  assert.equal(r, "你看看");
});

// ── 材料方向 ───────────────────────────────────────────────────

const VIDEO_BASE = {
  bvid: "BV1GJ411x7h7", aid: 1001, cid: 2002, page: 1, pages: 1,
  title: "一个测试视频", author: "某UP", tname: "生活", duration: 120,
  link: "https://www.bilibili.com/video/BV1GJ411x7h7",
};

test("她自己刷到的那条，仍写着「你自己刷到的」", () => {
  const text = packMaterials({ video: VIDEO_BASE, readKind: "subtitle", subtitle: [{ from: 0, content: "内容" }] });
  assert.match(text, /你自己刷到的东西/);
  assert.match(text, /分享文案/);
  assert.match(text, /要不要分享/);
});

test("她递过来的那条，方向换成「她给你的」", () => {
  const text = packMaterials(
    { video: VIDEO_BASE, readKind: "subtitle", subtitle: [{ from: 0, content: "内容" }] },
    { origin: "user" },
  );
  assert.match(text, /她刚给你发了一个视频/);
  assert.match(text, /她想让你也看看/);
  assert.match(text, /不用猜她为什么发/);
  // 分享那套纪律不该跟着来：她发的东西不需要再决定要不要分享。
  assert.doesNotMatch(text, /要不要分享，取决于你自己想不想/);
  assert.doesNotMatch(text, /分享文案/);
});

test("两个方向都保留三档来源纪律，不串档", () => {
  for (const origin of ["self", "user"]) {
    const sub = packMaterials(
      { video: VIDEO_BASE, readKind: "subtitle", subtitle: [{ from: 0, content: "内容" }] },
      { origin },
    );
    // video-sharing.js 靠这个标记判断材料有没有真读到字幕，不能改。
    assert.match(sub, /【你已经读过字幕/);
    const only = packMaterials({ video: VIDEO_BASE, readKind: "title-only" }, { origin });
    assert.match(only, /【你只知道标题/);
    assert.match(only, /不要讲这个视频里发生了什么/);
  }
});
