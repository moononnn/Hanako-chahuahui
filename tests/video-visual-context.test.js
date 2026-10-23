import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_VISUAL_SAMPLE_TIMES,
  MAX_VISUAL_SUMMARY_CHARS,
  VISUAL_CONTINUITY,
  VISUAL_SCOPES,
  isUsableVideoVisual,
  normalizeVideoVisual,
  videoVisualComposeLine,
  videoVisualDiscipline,
  videoVisualRecallBoundary,
  videoVisualScopeText,
  videoVisualSourceSentence,
  visualScope,
} from "../lib/video-visual-context.js";

const OBSERVED_AT = "2026-10-22T15:00:00.000Z";

/** 3 个跨片稀疏点 + 2.5 秒局部连续 6 帧 + 一张封面：总图 10 张。 */
function fullSample() {
  const clipTimes = [10, 10.5, 11, 11.5, 12, 12.5];
  return {
    status: "ok",
    summary: "他先把木板夹上台面，用刨子从左往右推，木屑卷着落下来。",
    model: { provider: "openai-codex-oauth", model: "gpt-5.6-luna" },
    imageCount: 10,
    coverSeen: true,
    sampleTimes: [2, 45, 88, ...clipTimes],
    clip: { from: 10, to: 12.5 },
    observedAt: OBSERVED_AT,
  };
}

/** 只有稀疏点，没有连续段。 */
function sparseOnly() {
  return { ...fullSample(), imageCount: 4, coverSeen: true, sampleTimes: [2, 45, 88], clip: null };
}

// ── 归一化与严格校验 ────────────────────────────────────────────

test("完整观察归一化：张数、去重排序后的时间、合格 clip 都对得上", () => {
  const visual = normalizeVideoVisual(fullSample());
  assert.equal(visual.imageCount, 10);
  assert.equal(visual.visibleFrames, 9);
  assert.equal(visual.sampleTimes.length, 9);
  assert.deepEqual(visual.clip, { from: 10, to: 12.5 });
  assert.equal(visual.clipTimes.length, 6);
  assert.equal(visual.coverSeen, true);
  assert.equal(visual.summaryTruncated, false);
});

test("张数与采样时刻必须对得上：封面算在 imageCount 里", () => {
  // 封面 + 9 帧 = 10 张，时刻 9 个 → 对得上
  assert.ok(normalizeVideoVisual(fullSample()));
  // 少给一个时刻，张数对不上
  assert.equal(normalizeVideoVisual({ ...fullSample(), sampleTimes: [2, 45, 88, 10, 10.5, 11, 11.5, 12] }), null);
  // 多给一个时刻
  assert.equal(normalizeVideoVisual({ ...fullSample(), sampleTimes: [2, 45, 88, 10, 10.5, 11, 11.5, 12, 12.5, 13] }), null);
  // coverSeen 为 true 但张数没给封面留位
  assert.equal(normalizeVideoVisual({ ...fullSample(), imageCount: 9 }), null);
});

test("null、布尔、空字符串不能冒充 0 秒", () => {
  for (const bad of [null, true, false, "", "10", {}]) {
    assert.equal(normalizeVideoVisual({ ...fullSample(), sampleTimes: [2, 45, bad, 10, 10.5, 11, 11.5, 12, 12.5] }), null, `sampleTimes 里的 ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeVideoVisual({ ...fullSample(), imageCount: "10" }), null);
  assert.equal(normalizeVideoVisual({ ...fullSample(), imageCount: true }), null);
  // clip 端点给 null 不能当成 0 秒：clip 丢掉，但整条仍算看过画面
  const nullClip = normalizeVideoVisual({ ...fullSample(), clip: { from: null, to: 3 } });
  assert.ok(nullClip);
  assert.equal(nullClip.clip, null);
});

test("重复时间被去掉后数量对不上就整条拒", () => {
  // 9 个时刻里有 1 个重复 → 去重后 8 ≠ 9
  assert.equal(normalizeVideoVisual({ ...fullSample(), sampleTimes: [2, 2, 45, 88, 10, 10.5, 11, 11.5, 12] }), null);
  // 乱序但无重复：排序后仍对得上，应通过
  const shuffled = normalizeVideoVisual({ ...fullSample(), sampleTimes: [88, 2, 12.5, 45, 10, 11.5, 10.5, 12, 11] });
  assert.ok(shuffled);
  assert.deepEqual(shuffled.sampleTimes, [2, 10, 10.5, 11, 11.5, 12, 12.5, 45, 88]);
});

test("采样时刻最多九个，非负", () => {
  const tooMany = Array.from({ length: MAX_VISUAL_SAMPLE_TIMES + 1 }, (_, i) => i);
  assert.equal(normalizeVideoVisual({ ...fullSample(), imageCount: 11, coverSeen: false, sampleTimes: tooMany }), null);
  assert.equal(normalizeVideoVisual({ ...fullSample(), sampleTimes: [2, 45, 88, 10, 10.5, 11, 11.5, 12, -1] }), null);
});

test("summary 超上限截断并留痕，二次归一化仍记得被截过", () => {
  const long = "画".repeat(MAX_VISUAL_SUMMARY_CHARS + 200);
  const first = normalizeVideoVisual({ ...fullSample(), summary: long });
  assert.equal(first.summary.length, MAX_VISUAL_SUMMARY_CHARS);
  assert.equal(first.summaryTruncated, true);
  const second = normalizeVideoVisual(first);
  assert.equal(second.summaryTruncated, true, "二次归一化不能把截断痕迹洗掉");
  assert.equal(second.summary.length, MAX_VISUAL_SUMMARY_CHARS);
});

test("status、模型、observedAt 不合规一律拒", () => {
  assert.equal(normalizeVideoVisual({ ...fullSample(), status: "failed" }), null);
  assert.equal(normalizeVideoVisual({ ...fullSample(), model: { provider: "", model: "x" } }), null);
  assert.equal(normalizeVideoVisual({ ...fullSample(), observedAt: "昨天下午" }), null);
  assert.equal(normalizeVideoVisual({ ...fullSample(), observedAt: undefined }), null);
  assert.equal(normalizeVideoVisual(null), null);
});

// ── clip 不能凭空声称连续 ──────────────────────────────────────

test("clip 与真实采样对不上就丢掉 clip，不许虚构连续段", () => {
  // 采样都在 10~12.5，却声称 1~3.5 秒连续
  const liar = normalizeVideoVisual({ ...fullSample(), clip: { from: 1, to: 3.5 } });
  assert.ok(liar);
  assert.equal(liar.clip, null);
  assert.deepEqual(liar.clipTimes, []);

  // 区间包住了采样，但边界离首末采样太远（把 3 张散图说成 2.5 秒连续）
  const loose = normalizeVideoVisual({ ...fullSample(), clip: { from: 9.5, to: 13.5 } });
  assert.equal(loose.clip, null);

  // 范围里只有一个采样
  const lonely = normalizeVideoVisual({ ...fullSample(), clip: { from: 44, to: 46 } });
  assert.equal(lonely.clip, null);
});

test("采样间隔超过一个步长就不算连续", () => {
  const gap = normalizeVideoVisual({
    ...fullSample(),
    imageCount: 4, coverSeen: false,
    sampleTimes: [2, 10, 11.5, 45],
    clip: { from: 10, to: 11.5 },
  });
  assert.ok(gap);
  assert.equal(gap.clip, null, "中间隔了 1.5 秒，不能称连续");
  assert.equal(visualScope(gap).continuity, VISUAL_CONTINUITY.SPARSE);
});

test("短视频可以只保留很短的一段连续", () => {
  const short = normalizeVideoVisual({
    ...fullSample(),
    imageCount: 3, coverSeen: false,
    sampleTimes: [0, 0.5, 1],
    clip: { from: 0, to: 1 },
  });
  assert.deepEqual(short.clip, { from: 0, to: 1 });
  assert.equal(short.clipTimes.length, 3);
});

// ── 范围判定 ────────────────────────────────────────────────────

test("至少两个不同正片时间点才算看过内容", () => {
  assert.equal(visualScope(fullSample()).scope, VISUAL_SCOPES.FRAMES);
  assert.equal(visualScope(sparseOnly()).scope, VISUAL_SCOPES.FRAMES, "稀疏但有两个以上真时间点，也算看过");
  // 封面 + 单张正片：不够
  assert.equal(visualScope({ ...fullSample(), imageCount: 2, coverSeen: true, sampleTimes: [10], clip: null }).scope, VISUAL_SCOPES.COVER_ONLY);
  // 只有封面
  assert.equal(visualScope({ ...fullSample(), imageCount: 1, coverSeen: true, sampleTimes: [], clip: null }).scope, VISUAL_SCOPES.COVER_ONLY);
  assert.equal(visualScope(null).scope, VISUAL_SCOPES.NONE);
  assert.equal(isUsableVideoVisual(sparseOnly()), true);
  assert.equal(isUsableVideoVisual({ ...fullSample(), imageCount: 2, coverSeen: true, sampleTimes: [10], clip: null }), false);
});

test("连续性分三档：合格 clip 才算连续，否则如实稀疏", () => {
  assert.equal(visualScope(fullSample()).continuity, VISUAL_CONTINUITY.CLIP);
  assert.equal(visualScope(sparseOnly()).continuity, VISUAL_CONTINUITY.SPARSE);
  const liar = visualScope({ ...fullSample(), clip: { from: 1, to: 3.5 } });
  assert.equal(liar.continuity, VISUAL_CONTINUITY.SPARSE, "clip 不合格就只能说稀疏");
  assert.equal(liar.clip, null);
  assert.equal(visualScope({ ...fullSample(), imageCount: 1, coverSeen: true, sampleTimes: [], clip: null }).continuity, VISUAL_CONTINUITY.NONE);
});

// ── 措辞：不许把全部帧塞进局部段 ────────────────────────────────

test("范围说法把封面、全片稀疏点、局部连续段分开讲", () => {
  const text = videoVisualScopeText(fullSample());
  assert.match(text, /全片 9 个时间点/);
  assert.match(text, /第 10 秒到第 12\.5 秒是局部连续画面（6 张）/);
  assert.match(text, /另有一张封面/);
  assert.match(text, /没有完整看过整片/);
  // 3 个跨片稀疏点不能被吃进局部段
  assert.equal(/9 张.*局部连续/.test(text), false);
});

test("稀疏档不说连续，也不提局部段", () => {
  const text = videoVisualScopeText(sparseOnly());
  assert.match(text, /全片 3 个时间点/);
  assert.match(text, /没有连续片段/);
  assert.equal(/局部连续/.test(text), false);
  const liar = videoVisualScopeText({ ...fullSample(), clip: { from: 1, to: 3.5 } });
  assert.equal(/局部连续/.test(liar), false);
});

test("封面档只说不算正片", () => {
  const text = videoVisualScopeText({ ...fullSample(), imageCount: 1, coverSeen: true, sampleTimes: [], clip: null });
  assert.match(text, /封面/);
  assert.match(text, /不算看过正片/);
  assert.equal(videoVisualScopeText(null), "");
});

test("纪律句区分连续段与单张，并声明无声", () => {
  const clipText = videoVisualDiscipline(fullSample()).join("\n");
  assert.match(clipText, /第 10 秒到第 12\.5 秒是连续画面（6 张）/);
  assert.match(clipText, /这段之外只有单张画面/);
  assert.match(clipText, /没有声音/);
  assert.match(clipText, /封面/);

  const sparseText = videoVisualDiscipline(sparseOnly()).join("\n");
  assert.match(sparseText, /没有连续片段/);
  assert.match(sparseText, /别推断中间怎么变/);
  assert.equal(/局部连续/.test(sparseText), false);

  const coverText = videoVisualDiscipline({ ...fullSample(), imageCount: 1, coverSeen: true, sampleTimes: [], clip: null }).join("\n");
  assert.match(coverText, /只有一张封面/);
});

// ── 来源、回忆、成文口径 ────────────────────────────────────────

test("来源句写明全片点数与局部段，不把稀疏抹掉", () => {
  const withClip = videoVisualSourceSentence(fullSample(), "subtitle");
  assert.match(withClip, /全片 9 个时间点/);
  assert.match(withClip, /10 到 12\.5 秒是局部连续画面（6 张）/);
  assert.match(withClip, /未完整看过/);
  const sparse = videoVisualSourceSentence(sparseOnly(), "title-only");
  assert.match(sparse, /全片 3 个时间点的单张画面/);
  assert.equal(/局部连续/.test(sparse), false);
});

test("弹幕与字幕的来源句不互相冒充", () => {
  assert.equal(videoVisualSourceSentence(null, "danmaku"), "只翻到标题和弹幕，没读字幕也没看画面");
  assert.equal(videoVisualSourceSentence(null, "subtitle"), "仅读到字幕资料，未看画面");
  assert.equal(videoVisualSourceSentence(null, "title-only"), "只知道标题，没读内容");
  assert.match(videoVisualSourceSentence(fullSample(), "danmaku"), /没读字幕/);
  assert.match(videoVisualSourceSentence(fullSample(), "subtitle"), /读到字幕资料/);
});

test("回忆边界与成文句都按真实范围写", () => {
  const recall = videoVisualRecallBoundary(fullSample(), "subtitle");
  assert.match(recall, /全片 9 个时间点/);
  assert.match(recall, /局部连续（6 张）/);
  assert.match(recall, /也读过字幕/);
  assert.equal(videoVisualRecallBoundary(null, "subtitle"), "只读到字幕资料，没有看视频画面");

  const line = videoVisualComposeLine(fullSample());
  assert.match(line, /第 10 秒到第 12\.5 秒是局部连续的一段（6 张）/);
  assert.match(line, /不把封面当成正片/);
  assert.match(line, /画面没有声音/);
  const sparseLine = videoVisualComposeLine(sparseOnly());
  assert.match(sparseLine, /只有几个时间点的单张画面/);
  assert.equal(/局部连续/.test(sparseLine), false);
  assert.equal(videoVisualComposeLine(null), "");
});
