/**
 * 关系理解的收录规则（2026-11-25）。
 *
 * 这一轮钉住：
 * 1. 日常状态、行程、一次性事件不另学。
 * 2. 明确本轮/当天/截至日期的边界仍当下生效，但不泛化成长久。
 * 3. 缺少长期证据绝不能默认 persistent。
 * 4. 明确的长期偏好、许可、边界、约定，即使只说了一次也收；语境与 scope 照旧。
 * 5. meaning 必须能从原文里长出来；单个词不算数。
 * 6. 旧记录只做只读「建议复核」标记：原文写明了今天/这次/叫停却被记成长久的那些；
 *    不因为没写「以后」就怀疑长久边界，也不自动停用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyGuideOperation,
  guideEvidenceVerdict,
  guideGroundedIn,
  guideReviewReason,
  parseGuideReconcileResult,
} from "../lib/adaptation.js";
import { listAdaptationForUser } from "../lib/adaptation-correction.js";
import { bootChahuahui } from "./helpers/app-harness.js";

const now = new Date("2026-11-25T10:00:00+08:00");
const LIFE_DAY = "2026-11-25";

/** 走真解析：模型回一句 add/update，本地按原文证据判。 */
function parse(payload, message, extra = {}) {
  return parseGuideReconcileResult(JSON.stringify(payload), {
    sourceMessageId: "m-src", currentTurnId: "m-src", lifeDay: LIFE_DAY, message, now, ...extra,
  });
}
const add = (meaning, extra = {}) => ({ operation: "add", meaning, ...extra });

/* ── 1. 日常状态、行程、一次性事件不学 ── */

test("日常状态与行程不另学：今天累了、明天去医院、这周末去爬山", () => {
  for (const [message, meaning] of [
    ["我今天有点累", "用户今天很累"],
    ["明天要去医院体检", "用户明天去医院体检"],
    ["这周末去爬山，可能没空", "用户这周末去爬山"],
    ["刚吃完饭，先不聊了", "用户刚吃完饭不想聊"],
    ["加班到现在，困死了", "用户加班到现在很困"],
  ]) {
    const parsed = parse(add(meaning), message);
    assert.equal(parsed.ok, false, `${message} 不该被记成相处理解`);
    assert.match(parsed.reason, /daily-log|not-interaction|no-durable|not-in-message|stop-now/u, `${message}: ${parsed.reason}`);
  }
});

test("日常流水不因模型说“只是临时的”就放行", () => {
  for (const [message, meaning] of [
    ["我今天有点累", "用户今天很累"],
    ["明天要去医院体检", "用户明天去医院"],
    ["刚吃完饭，先不聊了", "用户先不聊"],
  ]) {
    const parsed = parse({ operation: "temporary", meaning, duration: "life-day" }, message);
    assert.equal(parsed.ok, false, `${message} 即使报成临时也不收`);
    assert.match(parsed.reason, /daily-log|not-interaction/u, `${message}: ${parsed.reason}`);
  }
  // 真在提要求的同一天边界，照旧当下生效。
  const boundary = parse({ operation: "temporary", meaning: "先陪我说话", duration: "life-day" }, "今天先别分析，先陪我说话");
  assert.equal(boundary.ok, true, boundary.reason);
  assert.equal(boundary.guide.duration, "life-day");
});

test("刚才那样我喜欢：算反馈，不算长久偏好", () => {
  const parsed = parse(add("继续刚才那样", { kind: "preference" }), "刚才那样我喜欢，继续");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "recent-feedback");
  // 说的是长久就不要紧。
  assert.equal(parse(add("别再分析我", { kind: "boundary" }), "以后别分析我了").ok, true);
});

test("叫停一下（别…了）不是长久边界", () => {
  const parsed = parse(add("不要再分析我了", { kind: "boundary" }), "别分析了");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "stop-now");
  // 说了“以后”的就是另一回事：那是真在立规矩。
  assert.equal(parse(add("别再分析我", { kind: "boundary" }), "以后别分析我了").ok, true);
});

/* ── 2. 明确边界：当下生效，不泛化 ── */

test("原文只说今天：按当天生效，不记成长久", () => {
  const parsed = parse(add("先陪我，别急着分析", { kind: "preference" }), "今天别急着分析，先陪我一会儿");
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.guide.duration, "life-day");
  assert.equal(parsed.guide.lifeDay, LIFE_DAY);
});

test("原文只说这一轮：只在这一轮里生效", () => {
  const parsed = parse(add("这一轮先别分析", { kind: "preference" }), "这一轮先别分析，让我缓缓");
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.guide.duration, "current-turn");
  assert.deepEqual(parsed.guide.sourceMessageIds, ["m-src"]);
});

test("原文给了截止日期：到那天为止，坏日期退回当天", () => {
  const until = parse(add("先别催我睡觉", { kind: "boundary", duration: "until", expiresAt: "2026-11-28T00:00:00+08:00" }), "到周五为止先别催我睡觉");
  assert.equal(until.ok, true, until.reason);
  assert.equal(until.guide.duration, "until");
  assert.equal(until.guide.expiresAt, "2026-11-27T16:00:00.000Z");

  const broken = parse(add("先别催我睡觉", { kind: "boundary", duration: "until", expiresAt: "到时候再说吧" }), "到周五为止先别催我睡觉");
  assert.equal(broken.ok, true, broken.reason);
  assert.equal(broken.guide.duration, "life-day", "边界说不清就退回当天，不猜成永久");
  assert.equal(broken.guide.lifeDay, LIFE_DAY);
});

/* ── 3. 缺少长期证据不能默认 persistent ── */

test("回包里没写 duration：没长期证据就不落成长久", () => {
  const vague = parse(add("用户最近在学吉他"), "我最近想学吉他");
  assert.equal(vague.ok, false);
  assert.equal(vague.reason, "not-interaction");

  const chatty = parse(add("用户觉得这个功能不错"), "这个功能不错");
  assert.equal(chatty.ok, false);
  assert.equal(chatty.reason, "not-interaction");

  const verdict = guideEvidenceVerdict({ message: "这个功能不错", meaning: "用户觉得这个功能不错", duration: "persistent" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-interaction");
});

test("指示词单独出现不算数：以后我再去医院、记住我今晚要出门", () => {
  for (const [message, meaning] of [
    ["以后我再去医院", "用户以后会去医院"],
    ["记住我今晚要出门", "用户今晚要出门"],
    ["你要不要一起去？", "用户问要不要一起去"],
    ["别人说我不够温柔", "别人说用户不够温柔"],
  ]) {
    const parsed = parse(add(meaning), message);
    assert.equal(parsed.ok, false, `${message} 不该被当成相处理解`);
    assert.match(parsed.reason, /daily-log|not-interaction|no-durable/u, `${message}: ${parsed.reason}`);
  }
});

test("这次别说以后：短期边界优先，不许直接记成长期", () => {
  const parsed = parse(add("这次先别提以后", { kind: "boundary" }), "这次别说以后，先聊眼前");
  assert.equal(parsed.ok, true, parsed.reason);
  assert.notEqual(parsed.guide.duration, "persistent", "一个只说这次的要求不能变成长久");
  assert.equal(parsed.guide.duration, "current-turn");
});

test("上下文明确分开的长久句：今天太累了，以后十点后别发消息", () => {
  const parsed = parse(add("晚上十点后别发消息", { kind: "boundary" }), "今天太累了，以后十点后别发消息");
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.guide.duration, "persistent", "后半句是在立长久的规矩");
});

test("日常状态自己说是长期也不行：kind 与有效期自相矛盾就不收", () => {
  const parsed = parse(add("用户今天很累", { kind: "temporary-state" }), "我今天有点累");
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /temporary-kind-not-persistent|daily-log/u, parsed.reason);
});

/* ── 4. 明确的长期偏好/许可/边界/约定：一次也收 ── */

test("明确的长期偏好、边界、许可、约定，说一次就收", () => {
  for (const [message, meaning] of [
    ["我喜欢你多发一点语音", "多发一点语音"],
    ["你别在半夜给我发消息", "别在半夜发消息"],
    ["你可以随时给我发语音", "随时可以发语音"],
    ["我们说好晚上十点后不谈工作", "晚上十点后不谈工作"],
    ["我对花生过敏", "用户对花生过敏"],
  ]) {
    const parsed = parse(add(meaning), message);
    assert.equal(parsed.ok, true, `${message}: ${parsed.reason}`);
    assert.equal(parsed.guide.duration, "persistent", `${message} 是长久的`);
  }
});

test("说了长久就照长久的来：今天只是起点，不缩成当天", () => {
  const parsed = parse(add("晚上十点后别发消息", { kind: "boundary" }), "从今天起，晚上十点后别发消息");
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.guide.duration, "persistent");
});

/* ── 5. 原文证据：meaning 得从原文里长出来 ── */

test("meaning 不能自己编：原文没有的，一个字也不落账", () => {
  const parsed = parse(add("用户讨厌被追问工作"), "我喜欢你多发一点语音");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "not-in-message");
  assert.equal(guideGroundedIn("我喜欢你多发一点语音", "用户讨厌被追问工作"), false);
  assert.equal(guideGroundedIn("我喜欢你多发一点语音", "多发一点语音"), true);
});

test("单个词不算充分证据：一句「今天」撑不起一条长久理解", () => {
  assert.equal(parse(add("用户不喜欢被分析", { kind: "preference" }), "今天").ok, false);
  assert.equal(guideEvidenceVerdict({ message: "以后", meaning: "用户不喜欢被分析", duration: "persistent" }).ok, false);
});

test("临时那几种仍按原文收：当下生效，过期即散", () => {
  const parsed = parseGuideReconcileResult(JSON.stringify({ operation: "temporary", meaning: "今天先别分析", duration: "life-day" }), {
    sourceMessageId: "m-src", currentTurnId: "m-src", lifeDay: LIFE_DAY, message: "今天先别分析", now,
  });
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.guide.duration, "life-day");
});

/* ── 6. 被拒的解析不碰账本；已说出的破例反馈不陪绑 ── */

test("被拒的解析不落账：原来的理解一条不动", () => {
  const book = { guides: [{ id: "g-keep", meaning: "我难过时先陪我", kind: "preference", scope: "relationship", status: "active", duration: "persistent" }] };
  const rejected = parse(add("用户今天很累"), "我今天有点累");
  assert.equal(rejected.ok, false);
  const next = applyGuideOperation(book, rejected, now);
  assert.deepEqual(next.guides.map((row) => [row.id, row.status]), [["g-keep", "active"]]);
});

test("更新被筛掉时，独立说出的破例反馈不该跟着丢", () => {
  const parsed = parse({
    operation: "add",
    meaning: "用户今天很累",
    feedback: { exceptionId: "reply.teasing|m-reply", type: "explicit-like", polarity: "positive" },
  }, "我今天有点累");
  assert.equal(parsed.ok, true, "整体不算失败，而是这轮只落反馈");
  assert.equal(parsed.operation, "none");
  assert.equal(parsed.guide, undefined);
  assert.equal(parsed.feedbackProposal.exceptionId, "reply.teasing|m-reply");
  assert.equal(parsed.filtered?.reason, "daily-log");
  // 没有反馈时才是真的失败。
  assert.equal(parse(add("用户今天很累"), "我今天有点累").ok, false);
});

/* ── 7. 旧记录的只读「建议复核」标记 ── */

const legacyGuide = (extra = {}) => ({
  id: "guide:relationship:m-old",
  meaning: "先陪我一会儿",
  kind: "preference",
  scope: "relationship",
  duration: "persistent",
  status: "active",
  origin: "explicit",
  evidenceQuote: "今天先别分析，先陪我一会儿",
  sourceMessageIds: ["m-old"],
  updatedAt: now.toISOString(),
  ...extra,
});

test("旧误判标出来：原文写着今天/这次/叫停，却被记成长久", () => {
  assert.equal(guideReviewReason(legacyGuide()), "temporary-evidence");
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "这次先这样吧" })), "temporary-evidence");
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "别分析了" })), "temporary-evidence");
});

test("没写「以后」的长久边界不许误标", () => {
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "别在半夜给我发消息" })), "");
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "我不吃香菜" })), "");
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "我对花生过敏" })), "");
  // 已经写明长久的，更不该标。
  assert.equal(guideReviewReason(legacyGuide({ evidenceQuote: "以后别在晚上十点后给我发消息" })), "");
  // 本来就不是长久的，以及已经不再生效的，都不标。
  assert.equal(guideReviewReason(legacyGuide({ duration: "life-day" })), "");
  assert.equal(guideReviewReason(legacyGuide({ status: "revoked" })), "");
});

test("列表里带着 duration，需要复核的才多一个 reviewReason", () => {
  const clean = legacyGuide({ id: "guide:relationship:m-clean", evidenceQuote: "我不吃香菜", meaning: "别给我点香菜" });
  const dirty = legacyGuide({ id: "guide:relationship:m-dirty" });
  const items = listAdaptationForUser({ partnerBook: { guides: [clean, dirty] }, userBook: { guides: [] } });
  assert.deepEqual(items.map((row) => row.id), ["guide:relationship:m-clean", "guide:relationship:m-dirty"]);
  assert.equal(items[0].duration, "persistent");
  assert.equal(items[0].reviewReason, undefined, "干净的记录不多长一个字段");
  assert.equal(items[1].duration, "persistent");
  assert.equal(items[1].reviewReason, "temporary-evidence");
  // 只读标记：原记录本身没有被改动，也没有被停用。
  assert.equal(dirty.status, "active");
  assert.equal(dirty.duration, "persistent");
});

/* ── 8. 接口层：UI 读到的东西就这几个字段 ── */

test("GET /adaptation 每条带 duration，需要复核的才多一个 reviewReason", async t => {
  const app = await bootChahuahui({ seed(store) {
    store.savePartnerAdaptation("nova", {
      guides: [
        legacyGuide({ id: "guide:relationship:m-clean", meaning: "别给我点香菜", evidenceQuote: "我不吃香菜" }),
        legacyGuide({ id: "guide:relationship:m-dirty" }),
      ],
      exceptions: [], feedbackEvents: [], habitChanges: [],
    });
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const res = await app.request("GET", "/adaptation/nova");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.revisions?.relationship, "number");
  const items = res.body.items;
  assert.deepEqual(items.map((row) => Object.keys(row).sort()), [
    ["duration", "id", "kind", "meaning", "scope", "updatedAt"],
    ["duration", "id", "kind", "meaning", "reviewReason", "scope", "updatedAt"],
  ]);
  assert.equal(items[0].duration, "persistent");
  assert.equal(items[1].reviewReason, "temporary-evidence");
});
