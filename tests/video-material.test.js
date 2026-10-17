import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptSubtitle,
  aggregateDanmaku,
  formatDanmakuContext,
  isNoiseDanmaku,
  MIN_SUBTITLE_SEGMENTS,
  normalizeDanmaku,
  parseDanmakuXml,
  parseSubtitleId,
  subtitleCoverage,
  subtitleFingerprint,
  subtitleTimestamps,
  topicOverlap,
  verifySubtitleIdentity,
} from "../lib/video-material.js";

// 2026-10-16 实机数据。
//
// 半岛铁盒这条是关键教训：字幕覆盖率 100%、内容完全对应「半岛铁盒」这个主题，
// 但 subtitle_url 里的数字前缀是 27 位，而 aid(15)+cid(11) 只有 26 位。
// 早先版本按位数硬拆去比对，把这类正常视频全判成错配（实测误杀 88%）。
// 所以可信度判据改成「时间轴覆盖 + 主题词重合」，不看编号位数。
const OK_CASE = {
  video: { aid: 115014627237823, cid: 31642550476, duration: 537, title: "零基础DIY教程 | 半岛铁盒", tname: "手工DIY", desc: "一起来制作一个独一无二的半岛铁盒" },
  subtitle: {
    lan: "ai-zh",
    subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/113271793256318262006374574b4ef9bff0284b?auth_key=1792113345-1",
  },
  body: {
    body: [
      { from: 0, to: 4, content: "想知道如何制作一个这样的半岛铁盒吗" },
      { from: 4, to: 8, content: "来吧跟着我的视频" },
      { from: 530, to: 536, content: "你想制作一片属于自己的山海吗" },
    ],
  },
};

// 真实错配案例：582 秒的木工技巧视频，字幕是另一个视频的（跨度 223%）
const MISMATCH_CASE = {
  video: { aid: 117447759762909, cid: 42778429527, duration: 582, title: "10个人惊叹的木工技巧和窍门", tname: "手工", desc: "木工技巧" },
  subtitle: {
    lan: "ai-zh",
    subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/11323125950239926091129167fb879befde0283a51066be61f59aeb9f?auth_key=x",
  },
  body: {
    body: [
      { from: 0, to: 2.4, content: "你是不是很虚啊" },
      { from: 1291.8, to: 1292.1, content: "Take care" },
    ],
  },
};

// 跨度不足：1169 秒视频只有 210 秒字幕
const SHORT_CASE = {
  video: { aid: 117447692654126, cid: 42778168822, duration: 1169, title: "重返五年前亲手建造的木屋", tname: "户外", desc: "木屋" },
  subtitle: {
    lan: "ai-zh",
    subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/113383059752423264988299519abc6147dc42edc1a09306845e085a10?auth_key=x",
  },
  body: { body: [{ from: 0.7, to: 210.4, content: "哇擦一下啊 擦一下桌子哦" }] },
};

// ── 可信度判据 ─────────────────────────────────────────────────

test("字幕标识仍能解析出来，供日志用", () => {
  const parsed = parseSubtitleId(OK_CASE.subtitle.subtitle_url);
  assert.equal(parsed.form, "prod");
});

test("verifySubtitleIdentity 不再作判据，返回 null 而不是误杀", () => {
  const r = verifySubtitleIdentity(OK_CASE.video, OK_CASE.subtitle);
  assert.equal(r.ok, null, "编号长度不固定，不能按位数判生死");
});

test("时间轴：覆盖率 100% 视为吻合", () => {
  assert.equal(subtitleCoverage(OK_CASE.body, 537).ok, true);
  assert.equal(subtitleCoverage(OK_CASE.body, 537).coverage > 0.95, true);
});

test("时间轴：223% 与 18% 都判为异常", () => {
  assert.equal(subtitleCoverage(MISMATCH_CASE.body, 582).ok, false);
  assert.equal(subtitleCoverage(SHORT_CASE.body, 1169).ok, false);
});

test("主题词重合：半岛铁盒的字幕里确实谈到了半岛铁盒", () => {
  const r = topicOverlap(OK_CASE.body, OK_CASE.video);
  assert.equal(r.ok, true);
  assert.ok(r.hits >= 2);
});

test("主题词重合：完全不相干的字幕判为不重合", () => {
  const r = topicOverlap(MISMATCH_CASE.body, MISMATCH_CASE.video);
  assert.equal(r.ok, false);
});

test("主题词重合：空字幕不通过", () => {
  assert.equal(topicOverlap({ body: [] }, OK_CASE.video).ok, false);
});

test("可信视频通过：跨度与主题都对且段数够", () => {
  const body = {
    body: Array.from({ length: 20 }, (_, i) => ({ from: i * 26, to: i * 26 + 25, content: `半岛铁盒 DIY 教程 第${i}步` })),
  };
  const r = acceptSubtitle({ ...OK_CASE, body });
  assert.equal(r.accepted, true);
});

test("段数不足的真实案例会被拦下", () => {
  assert.equal(acceptSubtitle(OK_CASE).accepted, false);
});

test("跨度错配被拦下", () => {
  assert.equal(acceptSubtitle(MISMATCH_CASE).accepted, false);
  assert.equal(acceptSubtitle(SHORT_CASE).accepted, false);
});

test("时间轴对但主题完全无关时被拦下（时长骗不了人）", () => {
  const r = acceptSubtitle({
    video: { duration: 100, title: "手工菜板制作", tname: "手工", desc: "实木菜板" },
    subtitle: { subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abc123" },
    body: { body: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "今天天气不错我们聊聊股票基金" })) },
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /主题/);
});

test("字幕内容为空时拒绝", () => {
  assert.equal(acceptSubtitle({ ...OK_CASE, body: { body: [] } }).accepted, false);
});

test("拒绝时不泄露字幕原文，只说理由", () => {
  const r = acceptSubtitle(MISMATCH_CASE);
  assert.equal(r.body, undefined);
  assert.equal(JSON.stringify(r).includes("你是不是很虚"), false);
});

// ── 对抗接口不稳定 ─────────────────────────────────────────────
// 2026-10-16 实测：同一视频连续请求，player/v2 返回的字幕条数在 1/6/2/6 之间跳，
// 正文段数 235/223/1/223。第 3 次只给 1 段，看着是完整 JSON，内容只有一句。
// 拿这种残缺字幕去讲，伙伴会讲出一个断断续续的视频，而且看起来是真的。

test("指纹能分辨完整与残缺", () => {
  const full = { body: Array.from({ length: 20 }, (_, i) => ({ from: i, content: `第${i}句内容` })) };
  const partial = { body: [{ from: 0, content: "只有一句" }] };
  assert.notEqual(subtitleFingerprint(full), subtitleFingerprint(partial));
});

test("内容一致时指纹相同", () => {
  const a = { body: [{ from: 0, content: "甲" }, { from: 1, content: "乙" }, { from: 2, content: "丙" }] };
  const b = { body: [{ from: 0, content: "甲" }, { from: 1, content: "乙" }, { from: 2, content: "丙" }] };
  assert.equal(subtitleFingerprint(a), subtitleFingerprint(b));
});

test("段数太少直接拒，不给模型看", () => {
  const r = acceptSubtitle({
    video: { duration: 100, title: "手工菜板", desc: "菜板" },
    subtitle: { subtitle_url: "https://x/prod/1" },
    body: { body: [{ from: 0, to: 99, content: "今天我们来聊聊股票" }] },
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /残缺/);
});

test("两次内容不一致时整份丢弃", () => {
  const r = acceptSubtitle({
    video: OK_CASE.video,
    subtitle: OK_CASE.subtitle,
    body: { body: Array.from({ length: 20 }, (_, i) => ({ from: i * 26, to: i * 26 + 25, content: `半岛铁盒制作第${i}步` })) },
    fingerprint: "20#abc#def",
    referenceFingerprint: "20#完全不同的内容#另一头",
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /不一致/);
});

test("两次一致时正常通过", () => {
  const r = acceptSubtitle({
    video: OK_CASE.video,
    subtitle: OK_CASE.subtitle,
    body: { body: Array.from({ length: 20 }, (_, i) => ({ from: i * 26, to: i * 26 + 25, content: `半岛铁盒制作第${i}步` })) },
    fingerprint: "same",
    referenceFingerprint: "same",
  });
  assert.equal(r.accepted, true);
});

test("最小段数常量确实拦得住一句话", () => {
  assert.equal(MIN_SUBTITLE_SEGMENTS > 5, true);
});

// ── 主题词：降低通用二字词造成的误放行 ─────────────────────────

test("通用二字词不再计入命中", () => {
  // 旧规则会把「视频」「我们」「这个」这类高频二字词算进候选，
  // 任何中文口语都几乎必然命中两条，于是这道闸形同虚设。
  const body = { body: [{ content: "视频" }, { content: "我们" }, { content: "这个" }] };
  const r = topicOverlap(body, { title: "这个视频", tname: "生活", desc: "我们的日常" });
  assert.equal(r.hits, 0);
  assert.equal(r.ok, false);
});

test("候选词不再包含二字词", () => {
  const r = topicOverlap(
    { body: [{ content: "手工制" }, { content: "实木菜" }] },
    { title: "手工制作实木菜板", tname: "手工DIY", desc: "零基础教程" },
  );
  assert.ok(r.words.every((w) => w.length >= 3), `候选里混进了二字词：${r.words.join(",")}`);
});

test("主题词命中来自三字以上才算数", () => {
  const r = topicOverlap(
    { body: [{ content: "半岛铁盒" }, { content: "半岛铁" }] },
    { title: "零基础DIY教程 | 半岛铁盒", tname: "手工DIY", desc: "一起来制作一个独一无二的半岛铁盒" },
  );
  assert.ok(r.hits >= 2);
  assert.equal(r.ok, true);
});

test("主题词是启发式，不是身份保证：命中情况如实报出来", () => {
  const r = topicOverlap(OK_CASE.body, OK_CASE.video);
  assert.equal(typeof r.checked, "number");
  assert.equal(typeof r.hits, "number");
  assert.ok(r.checked > 0);
});

// ── 时间戳：逐条有限、非负、不超出时长 ─────────────────────────

const TS_OK = {
  body: [
    { from: 0, to: 4, content: "第一句" },
    { from: 4, to: 9.5, content: "第二句" },
    { from: 10, to: 12, content: "第三句" },
  ],
};

test("时间戳逐条正常时通过", () => {
  assert.equal(subtitleTimestamps(TS_OK, 12).ok, true);
});

test("时间戳超出视频时长加容差时拒", () => {
  const body = { body: [{ from: 0, to: 30, content: "越界" }] };
  const r = subtitleTimestamps(body, 12);
  assert.equal(r.ok, false);
  assert.match(r.reason, /时长/);
});

test("时间戳落在容差内仍接受", () => {
  const body = { body: [{ from: 0, to: 13.5, content: "略微超出" }] };
  assert.equal(subtitleTimestamps(body, 12, { toleranceSec: 2 }).ok, true);
});

test("to 不大于 from 的段落被拒", () => {
  const body = { body: [{ from: 0, to: 0, content: "零长" }, { from: 5, to: 4, content: "倒序" }] };
  const r = subtitleTimestamps(body, 12);
  assert.equal(r.ok, false);
  assert.match(r.reason, /结束时间/);
});

test("负数与非有限时间戳被拒", () => {
  assert.equal(subtitleTimestamps({ body: [{ from: -1, to: 3, content: "负" }] }, 12).ok, false);
  assert.equal(subtitleTimestamps({ body: [{ from: Number.NaN, to: 3, content: "非数" }] }, 12).ok, false);
});

test("时长未知时时间戳无法校验，如实说不行", () => {
  const r = subtitleTimestamps(TS_OK, 0);
  assert.equal(r.ok, false);
});

test("时间戳拒绝时不回显字幕正文", () => {
  const body = { body: [{ from: 0, to: 30, content: "敏感正文不该出现" }] };
  assert.equal(JSON.stringify(subtitleTimestamps(body, 12)).includes("敏感正文"), false);
});

// ── 全文指纹：替代只看头尾 ───────────────────────────────────────

test("全文指纹：只有结尾一段不同也判为不同", () => {
  const a = { body: [{ from: 0, to: 1, content: "甲" }, { from: 1, to: 2, content: "乙" }, { from: 2, to: 3, content: "丙" }] };
  const b = { body: [{ from: 0, to: 1, content: "甲" }, { from: 1, to: 2, content: "乙" }, { from: 2, to: 3, content: "改" }] };
  assert.notEqual(subtitleFingerprint(a), subtitleFingerprint(b));
});

test("全文指纹：中间一段不同也判为不同", () => {
  const a = { body: [{ from: 0, to: 1, content: "甲" }, { from: 1, to: 2, content: "乙" }, { from: 2, to: 3, content: "丙" }] };
  const b = { body: [{ from: 0, to: 1, content: "甲" }, { from: 1, to: 2, content: "改" }, { from: 2, to: 3, content: "丙" }] };
  assert.notEqual(subtitleFingerprint(a), subtitleFingerprint(b));
});

test("全文指纹：时间戳不同判为不同，正文相同也不行", () => {
  const a = { body: [{ from: 0, to: 4, content: "甲" }] };
  const b = { body: [{ from: 0, to: 5, content: "甲" }] };
  assert.notEqual(subtitleFingerprint(a), subtitleFingerprint(b));
});

test("全文指纹：段数不同判为不同", () => {
  const a = { body: [{ from: 0, to: 4, content: "甲" }, { from: 4, to: 8, content: "乙" }] };
  const b = { body: [{ from: 0, to: 4, content: "甲" }] };
  assert.notEqual(subtitleFingerprint(a), subtitleFingerprint(b));
});

test("acceptSubtitle 把时间戳纳入判定", () => {
  const r = acceptSubtitle({
    video: { duration: 100, title: "手工菜板制作", tname: "手工", desc: "实木菜板" },
    subtitle: { subtitle_url: "https://x/prod/1" },
    body: {
      body: Array.from({ length: 12 }, (_, i) => ({ from: i * 8, to: i * 8 + 8, content: "实木菜板手工制作" })).slice(0, 11)
        .concat([{ from: 88, to: 400, content: "实木菜板手工制作" }]),
    },
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /时间轴|时长/);
});

// ── 弹幕聚合 ───────────────────────────────────────────────────

test("弹幕：解析 xml 取出正文", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><i>
<chatserver>chat.bilibili.com</chatserver>
<d p="1,1,25,16777215,1717171717,0,abcd,0">哈哈哈哈哈</d>
<d p="1,1,25,16777215,1717171717,0,abcd,0">笑不活了&amp;好逗</d>
<d p="1,1,25,16777215,1717171717,0,abcd,0"></d>
</i>`;
  const rows = parseDanmakuXml(xml);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].text, "笑不活了&好逗");
});

test("弹幕：归一化去掉表情、空白和标点", () => {
  assert.equal(normalizeDanmaku("  前摇过长！！！ "), "前摇过长");
  assert.equal(normalizeDanmaku("哈哈😂😂😂"), "哈哈");
});

test("弹幕：单字和纯数字算噪声", () => {
  assert.equal(isNoiseDanmaku(normalizeDanmaku("6")), true);
  assert.equal(isNoiseDanmaku(normalizeDanmaku("66666")), true);
  assert.equal(isNoiseDanmaku(normalizeDanmaku("笑死")), false);
});

test("弹幕：只保留重复三次以上的", () => {
  const rows = [
    { text: "对不起总裁，刚才没有认出你" },
    { text: "对不起总裁刚才没有认出你" },
    { text: "对不起总裁，刚才没有认出你 " },
    { text: "牛逼" },
    { text: "我人傻了" },
    { text: "我人傻了" },
    { text: "我人傻了" },
  ];
  const picked = aggregateDanmaku(rows, { minRepeat: 3, limit: 5 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].count, 3);
  assert.equal(picked[1].count, 3);
});

test("弹幕：出现次数压过句子长度", () => {
  const rows = [
    { text: "这是一句很长很长的弹幕内容用来测试" },
    { text: "这是一句很长很长的弹幕内容用来测试" },
    { text: "这是一句很长很长的弹幕内容用来测试" },
    { text: "好好笑" },
    { text: "好好笑" },
    { text: "好好笑" },
    { text: "好好笑" },
    { text: "好好笑" },
  ];
  assert.equal(aggregateDanmaku(rows, { minRepeat: 3 })[0].text, "好好笑");
});

test("弹幕：没有高频项时返回空，不硬凑", () => {
  const rows = [{ text: "牛逼" }, { text: "前摇过长" }, { text: "好看" }];
  assert.deepEqual(aggregateDanmaku(rows, { minRepeat: 3 }), []);
  assert.equal(formatDanmakuContext(rows), "");
});

test("弹幕：有高频项时给出可读摘要并标出次数", () => {
  const rows = [
    { text: "对不起总裁，刚才没有认出你" },
    { text: "对不起总裁刚才没有认出你" },
    { text: "对不起总裁，刚才没有认出你！" },
  ];
  const text = formatDanmakuContext(rows);
  assert.match(text, /观众反复刷/);
  assert.match(text, /3 次/);
});

test("弹幕：写法不同但同义的不强行合并，宁可不给", () => {
  const rows = [
    { text: "对不起总裁，刚才没有认出你" },
    { text: "对不起总裁刚才没有认出你" },
    { text: "对不起总裁刚才没认出你" },
  ];
  assert.deepEqual(aggregateDanmaku(rows, { minRepeat: 3 }), []);
});
