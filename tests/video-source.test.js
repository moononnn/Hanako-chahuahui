import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");

import { createVideoLogin } from "../lib/video-login.js";
import {
  VIDEO_ALLOWED_HOSTS,
  clearVideoCredential,
  collectVideoMaterials,
  fetchDanmaku,
  fetchPopularVideos,
  fetchSubtitle,
  fetchTopReplies,
  fetchVideoMeta,
  isAllowedVideoUrl,
  readVideoCredential,
  searchVideos,
  videoGet,
  writeVideoCredential,
} from "../lib/video-source.js";

// ── 只读守卫 ───────────────────────────────────────────────────

test("只放行白名单里的 https 域名", () => {
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/web-interface/view?bvid=BV1").ok, true);
  assert.equal(isAllowedVideoUrl("https://aisubtitle.hdslb.com/bfs/ai_subtitle/x").ok, true);
  assert.equal(isAllowedVideoUrl("https://comment.bilibili.com/123.xml").ok, true);
});

test("拒绝非白名单域名", () => {
  const r = isAllowedVideoUrl("https://evil.example.com/steal");
  assert.equal(r.ok, false);
  assert.match(r.reason, /白名单/);
});

test("拒绝 http", () => {
  assert.equal(isAllowedVideoUrl("http://api.bilibili.com/x").ok, false);
});

test("拒绝写接口路径，即使方法被改成 GET 也要挡", () => {
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/reply/add").ok, false);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/reply/del").ok, false);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/dm").ok, false);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/coin/add").ok, false);
});

test("评论读取路径放行，只挡写动作", () => {
  // 评论只读是这份设计允许的（fetchTopReplies 靠它）。
  // 旧规则把 /x/v2/reply 整段挡了，等于评论功能从来没跑通过。
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/reply?type=1&oid=1").ok, true);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/reply").ok, true);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/player/v2?bvid=BV1").ok, true);
});

test("弹幕发送接口仍然挡着", () => {
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/dm").ok, false);
  assert.equal(isAllowedVideoUrl("https://api.bilibili.com/x/v2/dm/web").ok, false);
});

test("白名单里没有写接口域名的漏洞：bilibili 主域仍被路径守卫覆盖", () => {
  const r = isAllowedVideoUrl("https://www.bilibili.com/like/coin");
  assert.equal(r.ok, false);
});

test("videoGet 硬编码 GET，调用方传别的也没用", async () => {
  let seen;
  const res = await videoGet(async (url, options) => {
    seen = options;
    return { ok: true, async json() { return { code: 0 }; } };
  }, "https://api.bilibili.com/x/web-interface/nav");
  assert.equal(res.ok, true);
  assert.equal(seen.method, "GET");
});

test("videoGet 拿到 cookie 时才带 cookie 头", async () => {
  let seen;
  const make = async (url, options) => {
    seen = options;
    return { ok: true, async json() { return { code: 0 }; } };
  };
  await videoGet(make, "https://api.bilibili.com/x/web-interface/nav", { cookie: "SESSDATA=abc" });
  assert.equal(seen.headers.Cookie, "SESSDATA=abc");
  await videoGet(make, "https://api.bilibili.com/x/web-interface/nav", { cookie: "" });
  assert.equal(seen.headers.Cookie, undefined);
});

test("videoGet 遇到白名单外直接拒绝，不发请求", async () => {
  let called = false;
  const res = await videoGet(async () => {
    called = true;
    return { ok: true };
  }, "https://evil.example.com/x");
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test("网络能力缺失时如实失败", async () => {
  const res = await videoGet(null, "https://api.bilibili.com/x");
  assert.equal(res.ok, false);
  assert.match(res.reason, /网络能力/);
});

// ── 凭证 ───────────────────────────────────────────────────────

test("凭证写入后能读回，明文不落盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-"));
  try {
    const write = await writeVideoCredential(dir, { sessdata: "SECRETVALUE123", biliJct: "jct", dedeUserId: "1" });
    assert.equal(write.ok, true);
    const file = path.join(dir, "v2", "video-credential.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("SECRETVALUE123"), false, "明文不应出现在磁盘上");
    const read = await readVideoCredential(dir);
    assert.equal(read.ok, true);
    assert.equal(read.encrypted, true, "只有DPAPI解密成功才标记为已加密凭据");
    assert.equal(read.cookie, "SESSDATA=SECRETVALUE123");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DPAPI凭据在新Node进程中恢复并重新nav验证", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-reload-"));
  try {
    const secret = "RELOAD_TEST_TOKEN";
    const expectedCookie = `SESSDATA=${secret}`;
    const write = await writeVideoCredential(dir, { sessdata: secret });
    assert.equal(write.ok, true);
    const sourceUrl = (name) => JSON.stringify(pathToFileURL(path.join(LIB_DIR, name)).href);
    const script = `
      import { readVideoCredential } from ${sourceUrl("video-source.js")};
      import { createVideoLogin } from ${sourceUrl("video-login.js")};
      let navCookieMatches = false;
      const login = createVideoLogin({
        loadCredential: () => readVideoCredential(process.env.CHAH_TEST_DIR),
        fetcher: async (_url, options) => {
          navCookieMatches = options.headers.Cookie === process.env.CHAH_EXPECTED_COOKIE;
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { isLogin: true } }) };
        },
      });
      const status = await login.status();
      const cookie = await login.getCookie();
      process.stdout.write(JSON.stringify({ status: status.status, storage: status.storage, hasLogin: status.hasLogin,
        navCookieMatches, matches: cookie === process.env.CHAH_EXPECTED_COOKIE }));
    `;
    const { stdout, stderr } = await execFileP(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CHAH_TEST_DIR: dir, CHAH_EXPECTED_COOKIE: expectedCookie },
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(String(stdout).includes(secret), false, "子进程stdout不得打印合成凭据");
    assert.equal(String(stderr).includes(secret), false, "子进程stderr不得打印合成凭据");
    assert.deepEqual(JSON.parse(String(stdout).trim() || "{}"), {
      status: "loggedIn", storage: "encrypted", hasLogin: true, navCookieMatches: true, matches: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DPAPI显式限制为当前Windows用户范围", () => {
  const cryptoSource = fs.readFileSync(new URL("../lib/crypto.js", import.meta.url), "utf8");
  assert.ok(cryptoSource.includes("ProtectedData]::Protect($b, $null, 'CurrentUser')"));
  assert.ok(cryptoSource.includes("ProtectedData]::Unprotect($b, $null, 'CurrentUser')"));
});

test("没有凭证时如实说没有", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-"));
  try {
    const read = await readVideoCredential(dir);
    assert.equal(read.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("空 SESSDATA 不写入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-"));
  try {
    assert.equal((await writeVideoCredential(dir, { sessdata: "  " })).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("清除凭证后读不到", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-"));
  try {
    await writeVideoCredential(dir, { sessdata: "ABCDEFGHIJ" });
    assert.equal(clearVideoCredential(dir).ok, true);
    assert.equal((await readVideoCredential(dir)).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 登录态缺失时的降级 ─────────────────────────────────────────

const SAMPLE_VIDEO = {
  bvid: "BV1n7JU69EQA",
  aid: 117446333699628,
  cid: 42774892143,
  duration: 104,
  title: "手工制作实木菜板",
  tname: "手工",
  desc: "做一个实木菜板",
  link: "https://www.bilibili.com/video/BV1n7JU69EQA",
};

test("没有登录态时字幕如实失败并标明档位 none", async () => {
  const res = await fetchSubtitle(async () => ({ ok: true, async json() { return { code: 0 }; } }), SAMPLE_VIDEO, { cookie: "" });
  assert.equal(res.ok, false);
  assert.equal(res.readKind, "none");
});

test("没有登录态时弹幕如实失败", async () => {
  const res = await fetchDanmaku(async () => ({ ok: true, async text() { return ""; } }), SAMPLE_VIDEO, { cookie: "" });
  assert.equal(res.ok, false);
  assert.deepEqual(res.rows, []);
});

test("时间轴对得上但主题无关的字幕被拒", async () => {
  // 模拟“搬运错配”的真实形态：字幕跨度跟视频一样长，但讲的是另一件事。
  // 早先版本靠编号位数比对，这类会漏；现在靠主题词拦住。
  const fetcher = async (url) => {
    if (url.includes("player/v2")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/12345678901234567890abc?auth_key=x" },
                ],
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        // 字幕正文接口直接返回 { body: [...] }，不包 data
        return { body: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "今天我们来聊聊股票和基金市场" })) };
      },
    };
  };
  const res = await fetchSubtitle(fetcher, { ...SAMPLE_VIDEO, title: "手工制作实木菜板", tname: "手工", desc: "做菜板" }, { cookie: "SESSDATA=x" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /主题/);
});

test("主题对得上且跨度正常的字幕被接受", async () => {
  const fetcher = async (url) => {
    if (url.includes("player/v2")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/11744633369962842774892143d4f10f137d363622f32eb1f102a0728c?auth_key=x" },
                ],
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        // 字幕正文接口直接返回 { body: [...] }，不包 data
        // 段数要过最小门槛（8 段），且时间轴要盖住整个视频
        return {
          body: Array.from({ length: 12 }, (_, i) => ({
            from: 1 + i * 8,
            to: 8 + i * 8,
            content: `实木菜板手工制作第${i}步，乌檀木`,
          })),
        };
      },
    };
  };
  const res = await fetchSubtitle(fetcher, SAMPLE_VIDEO, { cookie: "SESSDATA=x" });
  assert.equal(res.ok, true);
  assert.equal(res.readKind, "subtitle");
  assert.ok(res.segments.length >= 1);
});

test("第二次取字幕失败时不能把第一次当作两次一致", async () => {
  let calls = 0;
  const fetcher = async (url) => {
    if (url.includes("player/v2")) {
      calls += 1;
      if (calls > 1) return { ok: false, status: 503 };
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles: [
        { lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/test" },
      ] } } }; } };
    }
    return { ok: true, async json() { return { body: Array.from({ length: 12 }, (_, i) => ({
      from: i * 8, to: i * 8 + 8, content: "实木菜板手工制作",
    })) }; } };
  };
  const result = await fetchSubtitle(fetcher, SAMPLE_VIDEO, { cookie: "SESSDATA=mock", delayMs: 0 });
  assert.equal(calls, 4, "最多四拍；只有一拍成功就凑不出两票，只能算失败");
  assert.equal(result.ok, false);
  assert.equal(result.readKind, "none");
  assert.match(result.reason, /复核/);
});

test("搜索空词直接拒绝，不发请求", async () => {
  let called = false;
  const res = await searchVideos(async () => {
    called = true;
    return { ok: true, async json() { return { code: 0, data: { result: [] } }; } };
  }, "   ");
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

// ── 热门入口与发布时间区间 ─────────────────────────────────────

/** 搜索要两次请求：先取 wbi 密钥，再取结果。searchJson 可以换掉搜索那次的返回形状。 */
function wbiFetcher(onUrl, searchJson) {
  return async (url, options) => {
    onUrl?.(url, options);
    if (url.includes("/x/web-interface/nav")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/aaa.png", sub_url: "https://i0.hdslb.com/bfs/wbi/bbb.png" } },
          };
        },
      };
    }
    return { ok: true, async json() { return searchJson ?? { code: 0, data: { result: [] } }; } };
  };
}

test("热门入口只读 GET，字段规范到与搜索相近的一组", async () => {
  let seenUrl = "";
  let seenMethod = "";
  const res = await fetchPopularVideos(async (url, options) => {
    seenUrl = String(url);
    seenMethod = options?.method;
    return {
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            list: [
              {
                bvid: "BV1n7JU69EQA",
                title: "<em class=\"keyword\">实木</em>菜板修复",
                desc: "把开裂的菜板重新刨平",
                owner: { name: "木作阿青" },
                duration: 214,
                stat: { view: 320000 },
                pubdate: 1710000000,
                tname: "手工",
              },
              { bvid: "不是BV号", title: "形状不对的条目", duration: 10 },
            ],
          },
        };
      },
    };
  });
  assert.equal(res.ok, true);
  assert.equal(seenMethod, "GET");
  assert.match(seenUrl, /^https:\/\/api\.bilibili\.com\/x\/web-interface\/popular\?pn=1&ps=20$/u);
  assert.equal(res.results.length, 1, "bvid 不合规的条目不进结果");
  const row = res.results[0];
  assert.equal(row.bvid, "BV1n7JU69EQA");
  assert.equal(row.title, "实木菜板修复", "标题里的高亮标签要剥掉");
  assert.equal(row.desc, "把开裂的菜板重新刨平");
  assert.equal(row.author, "木作阿青");
  assert.equal(row.duration, 214, "时长是秒");
  assert.equal(row.play, 320000);
  assert.equal(row.pubdate, 1710000000);
  assert.equal(row.tname, "手工");
});

test("热门接口空形状与错误码都拒绝，不返回半截数据", async () => {
  const empty = await fetchPopularVideos(async () => ({
    ok: true,
    async json() { return { code: 0, data: {} }; },
  }));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /没有可用/u);

  const bad = await fetchPopularVideos(async () => ({
    ok: true,
    async json() { return { code: -412, message: "搜索被拦截" }; },
  }));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /-412/u);
});

test("热门每页条数最多 50，页码从 1 起", async () => {
  let seenUrl = "";
  await fetchPopularVideos(async (url) => {
    seenUrl = String(url);
    return { ok: true, async json() { return { code: 0, data: { list: [{
      bvid: "BV1n7JU69EQA", title: "一条", duration: 100, stat: { view: 1 }, pubdate: 1, tname: "手工", owner: { name: "A" },
    }] } }; } };
  }, { page: 0, pageSize: 200 });
  assert.match(seenUrl, /pn=1&ps=50$/u);
});

test("搜索返回坏形状时拒绝，不把另一条取材路一起带崩", async () => {
  const broken = await searchVideos(wbiFetcher(null, { code: 0, data: { result: "不是数组" } }), "手作");
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.results, []);
  assert.match(broken.reason, /形状/u);

  const missing = await searchVideos(wbiFetcher(null, { code: 0, data: {} }), "手作");
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.results, []);

  // 形状对的空结果仍然是「取到了但没有」，不能当成失败。
  const empty = await searchVideos(wbiFetcher(), "手作");
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.results, []);
});

// 2026-10-21 实测：pubtime_begin / pubtime_end（不带 _s）不生效，order=click 返回 20 条全是陈年。
// 正确的参数名是 pubtime_begin_s / pubtime_end_s（秒），参照 searxng 的 B 站引擎实现；
// 真的认不认，由主线程拿真接口核。

test("搜索带发布时间区间时带 pubtime_begin_s / pubtime_end_s，不带时保持原来的样子", async () => {
  const urls = [];
  await searchVideos(wbiFetcher((url) => urls.push(String(url))), "手作", {
    publishedAfter: 1700000000, publishedBefore: 1710000000,
  });
  const searchUrl = urls.find((url) => url.includes("wbi/search/type"));
  assert.ok(searchUrl, "要发出搜索请求");
  assert.match(searchUrl, /pubtime_begin_s=1700000000/u);
  assert.match(searchUrl, /pubtime_end_s=1710000000/u);
  assert.doesNotMatch(searchUrl, /pubtime_begin=|pubtime_end=/u, "不带 _s 的旧参数名不发了");

  const plain = [];
  await searchVideos(wbiFetcher((url) => plain.push(String(url))), "手作");
  const plainUrl = plain.find((url) => url.includes("wbi/search/type"));
  assert.ok(plainUrl);
  assert.doesNotMatch(plainUrl, /pubtime/u, "不给区间就不带这两个参数");
});

test("白名单常量里没有评论、点赞类域名", () => {
  for (const host of VIDEO_ALLOWED_HOSTS) {
    assert.doesNotMatch(host, /comment-api|passport|ticket|write/i);
  }
});

// ── 材料汇总的降级路径 ─────────────────────────────────────────

test("取不齐材料时仍返回视频本身，并如实标明读到哪一档", async () => {
  const fetcher = async (url) => {
    if (url.includes("/view?")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              bvid: "BV1n7JU69EQA",
              aid: 117446333699628,
              cid: 42774892143,
              title: "手工制作实木菜板",
              desc: "做个菜板",
              duration: 104,
              owner: { name: "某UP", mid: 1 },
              stat: { view: 100 },
              tags: [{ tag_name: "木工" }],
            },
          };
        },
      };
    }
    return { ok: false, status: 0 };
  };
  const res = await collectVideoMaterials(fetcher, "BV1n7JU69EQA", { cookie: "" });
  assert.equal(res.ok, true);
  // 字幕和弹幕都拿不到，只能是 title-only——绝不能假装读过
  assert.equal(res.readKind, "title-only");
  assert.equal(res.subtitle.length, 0);
  assert.equal(res.shareable, false);
});

// ── 分 P ───────────────────────────────────────────────────────

const MULTI_P_VIEW = {
  code: 0,
  data: {
    bvid: "BV1n7JU69EQA",
    aid: 117446333699628,
    // B 站 view 常规形状：顶层 cid 就是 P1 的 cid，duration 是全片总长。
    cid: 900001,
    title: "分P合集",
    desc: "分P合集",
    duration: 1000,
    owner: { name: "某UP", mid: 1 },
    stat: { view: 10 },
    tags: [{ tag_name: "手工" }],
    pages: [
      { page: 1, cid: 900001, duration: 100, part: "第一章" },
      { page: 2, cid: 900002, duration: 600, part: "第二章" },
      { page: 3, cid: 900003, duration: 300, part: "第三章" },
    ],
  },
};

const SINGLE_P_VIEW = {
  code: 0,
  data: {
    bvid: "BV1n7JU69EQA",
    aid: 117446333699628,
    cid: 42774892143,
    title: "手工制作实木菜板",
    desc: "做个菜板",
    duration: 104,
    owner: { name: "某UP", mid: 1 },
    stat: { view: 100 },
    tags: [{ tag_name: "木工" }],
    pages: [{ page: 1, cid: 42774892143, duration: 104, part: "手工制作实木菜板" }],
  },
};

/** 只服务 /view?，其它路径一律 404 并记录，方便断言「不该发的请求没发」。 */
function metaFetcher(view, seen = []) {
  return async (url) => {
    seen.push(url);
    if (url.includes("/view?")) return { ok: true, async json() { return view; } };
    return { ok: false, status: 404 };
  };
}

test("分P取指定页的 cid 与时长，链接带 p", async () => {
  const seen = [];
  const r = await fetchVideoMeta(metaFetcher(MULTI_P_VIEW, seen), "BV1n7JU69EQA", { page: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.video.cid, 900002);
  assert.equal(r.video.duration, 600);
  assert.equal(r.video.page, 2);
  assert.equal(r.video.pages, 3);
  assert.match(r.video.link, /\?p=2$/);
  assert.ok(seen[0].includes("p=2"), seen[0]);
});

test("不传分P号时默认为 1，链接依然稳定带 p", async () => {
  const r = await fetchVideoMeta(metaFetcher(SINGLE_P_VIEW), "BV1n7JU69EQA");
  assert.equal(r.video.page, 1);
  assert.equal(r.video.cid, 42774892143);
  assert.equal(r.video.duration, 104);
  assert.match(r.video.link, /\?p=1$/);
});

test("分P越界被拒，且不再取字幕", async () => {
  const seen = [];
  const r = await fetchVideoMeta(metaFetcher(MULTI_P_VIEW, seen), "BV1n7JU69EQA", { page: 4 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /分P/);
  assert.equal(seen.filter((u) => u.includes("player/v2")).length, 0);
});

test("分P号非法时连 view 都不发", async () => {
  for (const page of [0, -1, 1.5, "abc", NaN]) {
    const seen = [];
    const r = await fetchVideoMeta(metaFetcher(MULTI_P_VIEW, seen), "BV1n7JU69EQA", { page });
    assert.equal(r.ok, false, `page=${page} 应当被拒`);
    assert.equal(seen.length, 0);
  }
});

test("数字字符串形式的分P号按数字接受", async () => {
  const r = await fetchVideoMeta(metaFetcher(MULTI_P_VIEW), "BV1n7JU69EQA", { page: "2" });
  assert.equal(r.ok, true);
  assert.equal(r.video.page, 2);
});

test("响应 bvid 与请求不一致时拒", async () => {
  const view = { code: 0, data: { ...SINGLE_P_VIEW.data, bvid: "BV1ZZZZZZZZ" } };
  const r = await fetchVideoMeta(metaFetcher(view), "BV1n7JU69EQA");
  assert.equal(r.ok, false);
  assert.match(r.reason, /bvid|不一致/);
});

test("多P视频顶层 cid 指 P1 时，选 P2 不能被误拒", async () => {
  const seen = [];
  const r = await fetchVideoMeta(metaFetcher(MULTI_P_VIEW, seen), "BV1n7JU69EQA", { page: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.video.cid, 900002, "应以 pages 所选那一页为权威");
  assert.equal(r.video.duration, 600, "不能用全片总长当单页时长");
  assert.equal(r.video.page, 2);
  assert.match(r.video.link, /\?p=2$/);
});

test("选 P1 时顶层 cid 仍要对照", async () => {
  const view = { code: 0, data: { ...MULTI_P_VIEW.data, cid: 999999 } };
  const r = await fetchVideoMeta(metaFetcher(view), "BV1n7JU69EQA", { page: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cid|不一致/);
});

test("pages 页码与请求的页不一致时拒", async () => {
  const view = {
    code: 0,
    data: { ...MULTI_P_VIEW.data, pages: [{ page: 1, cid: 900001, duration: 100, part: "一" }, { page: 5, cid: 900002, duration: 600, part: "二" }] },
  };
  const r = await fetchVideoMeta(metaFetcher(view), "BV1n7JU69EQA", { page: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /页码|不一致/);
});

test("缺 cid 或 aid 时拒", async () => {
  const noCid = { code: 0, data: { ...SINGLE_P_VIEW.data, cid: 0, pages: [{ page: 1, cid: 0, duration: 104, part: "x" }] } };
  assert.equal((await fetchVideoMeta(metaFetcher(noCid), "BV1n7JU69EQA")).ok, false);
  const noAid = { code: 0, data: { ...SINGLE_P_VIEW.data, aid: undefined } };
  assert.equal((await fetchVideoMeta(metaFetcher(noAid), "BV1n7JU69EQA")).ok, false);
});

// ── 选轨：显式中文优先，不拿外语兵底 ─────────────────────────────

const GOOD_BODY = {
  body: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: `实木菜板手工制作第${i}步` })),
};

const AI_URL = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/aaa";
const HUMAN_URL = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/bbb";

/** tracks / bodies 传数组则按轮次变化，传单值则两轮相同。 */
function scriptedFetcher({ tracks, bodies = [GOOD_BODY, GOOD_BODY] }) {
  let round = 0;
  // tracks 传 [[...],[...]] 表示逐轮不同，传单个数组则两轮相同。
  const listAt = (list) => (Array.isArray(list) && Array.isArray(list[0]) ? (list[round] ?? list[0]) : list);
  return async (url) => {
    if (url.includes("player/v2")) {
      const snapshot = listAt(tracks);
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles: snapshot } } }; } };
    }
    const body = Array.isArray(bodies) ? (bodies[round] ?? bodies[0]) : bodies;
    round += 1;
    return { ok: true, async json() { return body; } };
  };
}

const AI_TRACK = { lan: "ai-zh", id: "111", subtitle_url: AI_URL };
const HUMAN_TRACK = { lan: "zh-CN", id: "222", subtitle_url: HUMAN_URL };

test("中文轨显式优先，数组顺序不影响结论", async () => {
  const a = await fetchSubtitle(scriptedFetcher({ tracks: [[AI_TRACK, HUMAN_TRACK]] }), SAMPLE_VIDEO, { cookie: "c" });
  const b = await fetchSubtitle(scriptedFetcher({ tracks: [[HUMAN_TRACK, AI_TRACK]] }), SAMPLE_VIDEO, { cookie: "c" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.lan, "zh-CN");
  assert.equal(b.lan, "zh-CN");
});

test("zh-Hans 也算中文轨优先", async () => {
  const hans = { lan: "zh-Hans", id: "333", subtitle_url: HUMAN_URL };
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[AI_TRACK, hans]] }), SAMPLE_VIDEO, { cookie: "c" });
  assert.equal(r.lan, "zh-Hans");
});

test("只有 AI 中字时用它——这是本项目的目标，不降档", async () => {
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[AI_TRACK]] }), SAMPLE_VIDEO, { cookie: "c" });
  assert.equal(r.ok, true);
  assert.equal(r.lan, "ai-zh");
});

test("只有外语轨时不兵底，直接失败", async () => {
  const en = { lan: "en-US", id: "444", subtitle_url: HUMAN_URL };
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[en]] }), SAMPLE_VIDEO, { cookie: "c" });
  assert.equal(r.ok, false);
  assert.equal(r.readKind, "none");
  assert.match(r.reason, /外语|没有可用/);
});

test("轨 ID 每次不同但语言与正文一致：按同一份字幕接受", async () => {
  const r1 = { lan: "ai-zh", id: "1601673000137251328", subtitle_url: AI_URL };
  const r2 = { lan: "ai-zh", id: "1818937776897706496", subtitle_url: AI_URL };
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[r1], [r2]] }), SAMPLE_VIDEO, { cookie: "c" });
  assert.equal(r.ok, true, "B站 每次请求重发临时轨 ID，正文相同就不该判成两份");
  assert.equal(r.trackChanged, true);
  assert.equal(r.readKind, "subtitle");
});

test("第一拍字幕地址为空、下一拍正常：补一拍凑齐两轮", async () => {
  const empty = { lan: "ai-zh", id: "111", subtitle_url: "" };
  let playerCalls = 0;
  const fetcher = async (url) => {
    if (url.includes("player/v2")) {
      playerCalls += 1;
      const tracks = playerCalls === 1 ? [empty] : [AI_TRACK];
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles: tracks } } }; } };
    }
    return { ok: true, async json() { return GOOD_BODY; } };
  };
  const r = await fetchSubtitle(fetcher, SAMPLE_VIDEO, { cookie: "c", delayMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.readKind, "subtitle");
  assert.equal(playerCalls, 3, "空地址只该被当“这一拍没成”，不该整份作废");
});

test("四拍四份互不相同的正文：凑不出两票就丢弃", async () => {
  const bodies = [
    GOOD_BODY,
    { body: [{ from: 0, to: 4, content: "完全不同的另一份字幕" }] },
    { body: [{ from: 0, to: 4, content: "第三份又不一样" }] },
    { body: [{ from: 0, to: 4, content: "第四份还是不同" }] },
  ];
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[AI_TRACK]], bodies }), SAMPLE_VIDEO, { cookie: "c", delayMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.unstable, true);
  assert.equal(r.attempts, 4);
});

test("前两拍不同、后两拍一致：按两票采用，不浪费后面那两拍", async () => {
  const stray = { body: [{ from: 0, to: 4, content: "串到别的视频的占位字幕" }] };
  const r = await fetchSubtitle(scriptedFetcher({ tracks: [[AI_TRACK]], bodies: [stray, GOOD_BODY, GOOD_BODY] }), SAMPLE_VIDEO, { cookie: "c", delayMs: 0 });
  assert.equal(r.ok, true, "一轮错配不该把整份正确字幕拖下水");
  assert.ok(r.segments.length > 0);
});

test("复核轮数没有可绕过的开关：传 attempts 也要两轮", async () => {
  let playerCalls = 0;
  const fetcher = async (url) => {
    if (url.includes("player/v2")) {
      playerCalls += 1;
      if (playerCalls > 1) return { ok: false, status: 503 };
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles: [AI_TRACK] } } }; } };
    }
    return { ok: true, async json() { return GOOD_BODY; } };
  };
  const r = await fetchSubtitle(fetcher, SAMPLE_VIDEO, { cookie: "c", attempts: 1 });
  assert.equal(playerCalls, 4, "attempts 不得把复核降成一次；最多四拍直到凑齐两票");
  assert.equal(r.ok, false);
});

// ── 凭据边界 ───────────────────────────────────────────────────

test("Cookie 只发 api.bilibili.com，字幕 CDN 与弹幕不带登录凭据", async () => {
  const seenHeaders = [];
  const fetcher = async (url, options) => {
    seenHeaders.push([url, options?.headers ?? {}]);
    if (url.includes("player/v2")) {
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles: [AI_TRACK] } } }; } };
    }
    if (url.includes("comment.bilibili.com")) return { ok: true, async text() { return "<i></i>"; } };
    return { ok: true, async json() { return GOOD_BODY; } };
  };
  const video = { ...SAMPLE_VIDEO, cid: 42774892143 };
  await fetchSubtitle(fetcher, video, { cookie: "SESSDATA=fake-for-test" });
  await fetchDanmaku(fetcher, video, { cookie: "SESSDATA=fake-for-test" });
  assert.ok(seenHeaders.some(([u]) => u.includes("aisubtitle.hdslb.com")));
  assert.ok(seenHeaders.some(([u]) => u.includes("comment.bilibili.com")));
  for (const [url, headers] of seenHeaders) {
    if (url.includes("api.bilibili.com")) assert.equal(headers.Cookie, "SESSDATA=fake-for-test", url);
    else assert.equal(headers.Cookie, undefined, `不该带凭据：${url}`);
  }
});

test("响应落在白名单外一律拒绝", async () => {
  const r = await videoGet(
    async () => ({ ok: true, url: "https://evil.example.com/x", async json() { return {}; } }),
    "https://api.bilibili.com/x/web-interface/nav",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /白名单/);
});

test("异常里的 auth_key 与地址不会被回显", async () => {
  const r = await videoGet(
    async () => { throw new Error("failed https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1?auth_key=SECRET-TOKEN-1234"); },
    "https://api.bilibili.com/x/web-interface/nav",
  );
  assert.equal(r.ok, false);
  const dump = JSON.stringify(r);
  assert.equal(dump.includes("SECRET-TOKEN-1234"), false);
  assert.equal(dump.includes("auth_key"), false);
});

test("评论读取路径真的能跑通（路径守卫放行后）", async () => {
  const r = await fetchTopReplies(
    async () => ({ ok: true, async json() { return { code: 0, data: { replies: [{ content: { message: "好看" }, like: 3, up_mid: { mid: 1 } }] } }; } }),
    SAMPLE_VIDEO,
    { cookie: "c" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.replies.length, 1);
});

test("磁盘上是明文时拒绝使用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-plain-"));
  try {
    fs.mkdirSync(path.join(dir, "v2"), { recursive: true });
    // encrypted 标记写着 true，但没有 dpapi: 前缀——标记不能当保证。
    fs.writeFileSync(
      path.join(dir, "v2", "video-credential.json"),
      JSON.stringify({ savedAt: "2026-10-16T00:00:00.000Z", sessdata: "PLAINTEXT_ON_DISK", encrypted: true }),
    );
    const r = await readVideoCredential(dir);
    assert.equal(r.ok, false);
    assert.equal(r.cookie, undefined);
    assert.equal(JSON.stringify(r).includes("PLAINTEXT_ON_DISK"), false, "拒绝时不能回显凭据内容");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("加密标记造假但解不出内容时拒绝", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-fake-"));
  try {
    fs.mkdirSync(path.join(dir, "v2"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "v2", "video-credential.json"),
      JSON.stringify({ savedAt: "x", sessdata: `dpapi:${Buffer.from("not-a-real-ciphertext").toString("base64")}`, encrypted: true }),
    );
    const r = await readVideoCredential(dir);
    assert.equal(r.ok, false);
    assert.equal(r.cookie, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证文件里不再存用不到的字段", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-min-"));
  try {
    await writeVideoCredential(dir, { sessdata: "SECRETVALUE123" });
    const raw = fs.readFileSync(path.join(dir, "v2", "video-credential.json"), "utf8");
    assert.equal(raw.includes("biliJct"), false);
    assert.equal(raw.includes("dedeUserId"), false);
    assert.equal(raw.includes("SECRETVALUE123"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("系统加密用不上时退回本机锁，仍然不落盘明文", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-enc-"));
  try {
    // 不动 crypto 公共模块：用子进程把 PATH 清空，让系统加密调用必然失败。
    const script = `
      import { writeVideoCredential } from ${JSON.stringify(pathToFileURL(LIB_DIR + "/video-source.js").href)};
      const r = await writeVideoCredential(process.env.CHAH_TEST_DIR, { sessdata: "LOCAL_SHOULD_NEVER_BE_PLAIN" });
      process.stdout.write(JSON.stringify(r));
    `;
    const { stdout } = await execFileP(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PATH: "", CHAH_TEST_DIR: dir },
      windowsHide: true,
    });
    const result = JSON.parse(String(stdout).trim() || "{}");
    assert.equal(result.ok, true, "系统锁拿不到也不能拒绝保存，否则每次都得重扫");
    assert.equal(result.storage, "local");
    assert.equal(result.encrypted, false);
    const file = path.join(dir, "v2", "video-credential.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("LOCAL_SHOULD_NEVER_BE_PLAIN"), false, "本机锁也是真加密，不许落明文");
    assert.match(JSON.parse(raw).sessdata, /^local1:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("本机锁凭据能读回，密文改动后拒绝使用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chah-vid-local-"));
  const previous = process.env.CHAHU_CREDENTIAL_MODE;
  process.env.CHAHU_CREDENTIAL_MODE = "local";
  try {
    const write = await writeVideoCredential(dir, { sessdata: "LOCAL_ROUNDTRIP" });
    assert.equal(write.ok, true);
    assert.equal(write.storage, "local");
    const file = path.join(dir, "v2", "video-credential.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.match(JSON.parse(raw).sessdata, /^local1:/);
    const read = await readVideoCredential(dir);
    assert.equal(read.ok, true);
    assert.equal(read.storage, "local");
    assert.equal(read.encrypted, false);
    assert.equal(read.cookie, "SESSDATA=LOCAL_ROUNDTRIP");

    const tampered = JSON.parse(raw);
    tampered.sessdata = tampered.sessdata.slice(0, -6) + "AAAAAA";
    fs.writeFileSync(file, JSON.stringify(tampered));
    const broken = await readVideoCredential(dir);
    assert.equal(broken.ok, false);
    assert.equal(broken.cookie, undefined);
  } finally {
    if (previous === undefined) delete process.env.CHAHU_CREDENTIAL_MODE;
    else process.env.CHAHU_CREDENTIAL_MODE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 取材料：时长闸前置与可分享判定 ─────────────────────────────

function collectFetcher({ duration = 104, subtitles = [AI_TRACK], danmaku = '<i><d p="1,1,25,16777215,1717171711,0,abc,0">笑死我了</d></i>' } = {}) {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url.includes("/view?")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              bvid: "BV1n7JU69EQA", aid: 117446333699628, cid: 42774892143,
              title: "手工制作实木菜板", desc: "做个菜板", duration,
              owner: { name: "某UP", mid: 1 }, stat: { view: 1 }, tags: [],
              pages: [{ page: 1, cid: 42774892143, duration, part: "手工制作实木菜板" }],
            },
          };
        },
      };
    }
    if (url.includes("player/v2")) {
      return { ok: true, async json() { return { code: 0, data: { subtitle: { subtitles } } }; } };
    }
    if (url.includes("comment.bilibili.com")) return { ok: true, async text() { return danmaku; } };
    if (url.includes("/x/v2/reply")) return { ok: true, async json() { return { code: 0, data: { replies: [] } }; } };
    return { ok: true, async json() { return GOOD_BODY; } };
  };
  return { fetcher, seen };
}

test("超过 15 分钟的视频连字幕都不取", async () => {
  const { fetcher, seen } = collectFetcher({ duration: 4000 });
  const r = await collectVideoMaterials(fetcher, "BV1n7JU69EQA", { cookie: "c" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /分钟|上限/);
  assert.equal(seen.filter((u) => u.includes("player/v2")).length, 0);
  assert.equal(seen.filter((u) => u.includes("comment.bilibili.com")).length, 0);
});

test("requireSubtitle 时只取字幕，不额外花弹幕和评论的钱", async () => {
  const { fetcher, seen } = collectFetcher();
  const r = await collectVideoMaterials(fetcher, "BV1n7JU69EQA", { cookie: "c", requireSubtitle: true });
  assert.equal(r.ok, true);
  assert.equal(r.readKind, "subtitle");
  assert.equal(r.shareable, true);
  assert.equal(seen.filter((u) => u.includes("comment.bilibili.com")).length, 0);
  assert.equal(seen.filter((u) => u.includes("/x/v2/reply")).length, 0);
});

test("requireSubtitle 时没有字幕就失败，不拿弹幕档顶替", async () => {
  const { fetcher } = collectFetcher({ subtitles: [] });
  const r = await collectVideoMaterials(fetcher, "BV1n7JU69EQA", { cookie: "c", requireSubtitle: true });
  assert.equal(r.ok, false);
  assert.equal(r.shareable, false);
});

test("默认档位下弹幕档拿得到，2026-10-20 起也算可分享", async () => {
  const { fetcher } = collectFetcher({ subtitles: [] });
  const r = await collectVideoMaterials(fetcher, "BV1n7JU69EQA", { cookie: "c" });
  assert.equal(r.ok, true);
  assert.equal(r.readKind, "danmaku");
  // 旧口径：只要字幕，弹幕不算；新口径：弹幕档也收（只标题仍不收）。
  assert.equal(r.shareable, true);
});
