import test from "node:test";
import assert from "node:assert/strict";
import { fetchVideoMedia, normalizeVideoCover, videoDanmakuTimes } from "../lib/video-source.js";

const video = { bvid: "BV1Ex411R793", cid: 123, page: 1, duration: 40, link: "https://www.bilibili.com/video/BV1Ex411R793" };
const fake = (data, code = 0) => async () => ({ ok: true, json: async () => ({ code, data }) });

test("封面限 B站 archive CDN，无用户名、端口或外域", () => {
  assert.equal(normalizeVideoCover("//i0.hdslb.com/bfs/archive/cover.jpg"), "https://i0.hdslb.com/bfs/archive/cover.jpg");
  assert.equal(normalizeVideoCover("http://i2.hdslb.com/bfs/archive/cover.jpg"), "https://i2.hdslb.com/bfs/archive/cover.jpg");
  for (const url of ["https://hdslb.com.evil.test/bfs/archive/a.jpg", "https://i0.hdslb.com/elsewhere/a.jpg", "https://u:p@i0.hdslb.com/bfs/archive/a.jpg", "https://i0.hdslb.com:8443/bfs/archive/a.jpg", "file:///test.jpg"]) assert.equal(normalizeVideoCover(url), "");
});

test("只读 playurl 请求低清，API 可带既有凭据，返回地址不带凭据", async () => {
  let seen;
  const out = await fetchVideoMedia(async (url, options) => {
    seen = { url: new URL(url), options };
    return { ok: true, json: async () => ({ code: 0, data: { dash: { video: [
      { height: 360, bandwidth: 400000, baseUrl: "https://a.bilivideo.com/high.m4s" },
      { height: 360, bandwidth: 80000, base_url: "http://b.bilivideo.com/low.m4s?token=signed" },
      { height: 1080, bandwidth: 10, baseUrl: "https://a.bilivideo.com/oversize.m4s" },
    ] } } }) };
  }, video, { cookie: "SESSDATA=private" });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://b.bilivideo.com/low.m4s?token=signed");
  assert.equal(seen.options.method, "GET");
  assert.equal(seen.options.headers.Cookie, "SESSDATA=private");
  assert.equal(seen.url.pathname, "/x/player/playurl");
  assert.equal(seen.url.searchParams.get("qn"), "16");
  assert.equal(JSON.stringify(out).includes("private"), false);
});

test("未知视频标识不发请求", async () => {
  let calls = 0;
  for (const bad of [{ ...video, bvid: "bad" }, { ...video, cid: "123" }, { ...video, cid: -1 }]) {
    assert.equal((await fetchVideoMedia(async () => { calls++; }, bad)).ok, false);
  }
  assert.equal(calls, 0);
});

test("流地址拒绝外域、伪后缀、嵌入凭据和非https协议", async () => {
  for (const url of ["https://evil.test/a", "https://a.bilivideo.com.evil.test/a", "https://u:p@a.bilivideo.com/a", "https://a.bilivideo.com:8443/a", "file:///video.mp4"]) {
    const out = await fetchVideoMedia(fake({ dash: { video: [{ height: 360, bandwidth: 10, baseUrl: url }] } }), video);
    assert.equal(out.ok, false, url);
    assert.equal(JSON.stringify(out).includes(url), false);
  }
});

test("单段低清 mp4 可用，多段和超20MB拒绝，不偷看第一段冒充全片", async () => {
  const durl = [{ url: "https://a.bilivideo.com/movie.mp4", size: 1024 }];
  assert.equal((await fetchVideoMedia(fake({ durl }), video)).ok, true);
  assert.equal((await fetchVideoMedia(fake({ durl: [...durl, ...durl] }), video)).ok, false);
  assert.equal((await fetchVideoMedia(fake({ durl: [{ ...durl[0], size: 21 * 1024 * 1024 }] }), video)).ok, false);
});

test("API错误、异常JSON或网络错误只回不可用，不额外重试", async () => {
  assert.equal((await fetchVideoMedia(fake(null, -404), video)).ok, false);
  assert.equal((await fetchVideoMedia(async () => ({ ok: true, json: async () => { throw new Error("bad"); } }), video)).ok, false);
  assert.equal((await fetchVideoMedia(async () => { throw new Error("network"); }, video)).ok, false);
});

test("弹幕时间只取有效时间轴，支持两种引号，不把内容当控制或时间", () => {
  const xml = `<i><d p="1.5,1,25">哈哈</d><d p='20,1'>0</d><d p="-1,1">x</d><d p="NaN,1">x</d><d p="40,1">x</d><d p=",1">x</d><d>p="3"</d></i>`;
  assert.deepEqual(videoDanmakuTimes(xml, 40), [1.5, 20]);
  assert.equal(videoDanmakuTimes('<d p="1,1">x</d>'.repeat(1500), 40).length, 1200);
});
