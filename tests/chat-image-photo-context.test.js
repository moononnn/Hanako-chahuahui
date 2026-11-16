import test from "node:test";
import assert from "node:assert/strict";
import { recentSceneFor, PHOTO_SCENE_MAX_AGE_MS } from "../lib/proactive.js";
import { pickPhotoShare, photoShareBlockers, imageSceneExclusions, photoSharePrompt, PHOTO_SHARE_CHANCES } from "../lib/chat-image.js";

const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;

/** 最近一轮面对面聊天：用户一句、助手一句。 */
function chatPair({ userAt = NOW - 2 * HOUR, replyAt = NOW - 2 * HOUR + 1000 } = {}) {
  return [
    { id: "u1", at: iso(userAt), role: "user", text: "今天想喝热咖啡" },
    { id: "a1", at: iso(replyAt), role: "assistant", text: "我一会儿也去冲一杯" },
  ];
}

test("照片模式：中间发过主动消息，最近那轮面对面聊天仍然算数", () => {
  const rows = [
    ...chatPair(),
    { id: "p1", at: iso(NOW - HOUR), role: "assistant", proactive: true, text: "今天风挺大" },
    { id: "u2", at: iso(NOW - 30 * 60_000), role: "user", text: "你出门了吗" },
  ];
  // 普通模式：主动消息是边界，这一轮取不到（行为一个字没改）。
  assert.equal(recentSceneFor(rows, { now: NOW }), null);
  // 照片模式：主动消息不当边界，也不当user/reply。
  const scene = recentSceneFor(rows, { now: NOW, maxAgeMs: PHOTO_SCENE_MAX_AGE_MS, ignoreProactive: true });
  assert.equal(scene.userText, "今天想喝热咖啡");
  assert.equal(scene.assistantText, "我一会儿也去冲一杯");
  assert.equal(scene.at, iso(NOW - 2 * HOUR + 1000));
  assert.equal(scene.userId, "u1");
  assert.equal(scene.assistantId, "a1");
});

test("照片模式：主动消息本身不能当user或reply", () => {
  assert.equal(recentSceneFor([
    { id: "u1", at: iso(NOW - HOUR), role: "user", text: "在吗" },
    { id: "p1", at: iso(NOW - HOUR + 1000), role: "assistant", proactive: true, text: "我来找你了" },
  ], { now: NOW, ignoreProactive: true }), null);
  assert.equal(recentSceneFor([
    { id: "p1", at: iso(NOW - HOUR), role: "assistant", proactive: true, text: "我来找你了" },
    { id: "u1", at: iso(NOW - HOUR + 1000), role: "user", text: "在吗" },
  ], { now: NOW, ignoreProactive: true }), null);
});

test("照片模式：连续几条助手消息算同一轮回复，取最近完整的一问一答", () => {
  const scene = recentSceneFor([
    { id: "u1", at: iso(NOW - 3 * HOUR), role: "user", text: "今天想喝热咖啡" },
    { id: "a1", at: iso(NOW - 3 * HOUR + 1000), role: "assistant", text: "我一会儿也去冲一杯" },
    { id: "a2", at: iso(NOW - 3 * HOUR + 2000), role: "assistant", text: "不加糖对吧" },
  ], { now: NOW, ignoreProactive: true });
  assert.equal(scene.userText, "今天想喝热咖啡");
  assert.equal(scene.assistantText, "不加糖对吧");
});

test("照片模式：依据最多放24小时，过了就算；酒馆初见仍是边界，不穿过去捡旧对话", () => {
  const fresh = recentSceneFor(chatPair({ userAt: NOW - 23 * HOUR, replyAt: NOW - 23 * HOUR + 1000 }),
    { now: NOW, maxAgeMs: PHOTO_SCENE_MAX_AGE_MS, ignoreProactive: true });
  assert.ok(fresh, "24小时内仍算数");
  const stale = recentSceneFor(chatPair({ userAt: NOW - 25 * HOUR, replyAt: NOW - 25 * HOUR + 1000 }),
    { now: NOW, maxAgeMs: PHOTO_SCENE_MAX_AGE_MS, ignoreProactive: true });
  assert.equal(stale, null, "过了24小时就不算依据");
  const opened = recentSceneFor([
    ...chatPair({ userAt: NOW - 3 * HOUR, replyAt: NOW - 3 * HOUR + 1000 }),
    { id: "m_opening", at: iso(NOW - HOUR), role: "assistant", kind: "tavern-opening", text: "初次见面的招呼" },
  ], { now: NOW, maxAgeMs: PHOTO_SCENE_MAX_AGE_MS, ignoreProactive: true });
  assert.equal(opened, null, "新开场是边界，不能反着捡开场的旧对话");
});

test("照片依据不穿过撤回消息，且补充文本有长度上限", () => {
  const opts = { now: NOW, ignoreProactive: true };
  for (const index of [0, 1]) {
    const rows = chatPair();
    rows[index].recalled = true;
    assert.equal(recentSceneFor(rows, opts), null);
  }
  const rows = chatPair();
  rows[0].text = "甲".repeat(3000);
  rows[1].text = "乙".repeat(3000);
  const scene = recentSceneFor(rows, opts);
  assert.equal(scene.userText.length, 600);
  assert.equal(scene.assistantText.length, 600);
  assert.equal(recentSceneFor(rows, { now: NOW }).userText.length, 3000, "普通模式不变");
});

test("照片模式：撤回的原文与动作行不当作依据", () => {
  const rows = [
    { id: "u1", at: iso(NOW - 3 * HOUR), role: "user", text: "撤回的那句", recalled: true, recallMode: "hard" },
    { id: "a1", at: iso(NOW - 3 * HOUR + 1000), role: "assistant", text: "被撤回的回复", recalled: true, recallMode: "hard" },
    { id: "u2", at: iso(NOW - 2 * HOUR), role: "user", text: "现在这句" },
  ];
  assert.equal(recentSceneFor(rows, { now: NOW, ignoreProactive: true }), null, "撤回的一问一答不算依据");
  const withReply = [...rows, { id: "a2", at: iso(NOW - 2 * HOUR + 1000), role: "assistant", text: "这句还在" }];
  const scene = recentSceneFor(withReply, { now: NOW, ignoreProactive: true });
  assert.equal(scene.userText, "现在这句");
  assert.equal(scene.assistantText, "这句还在");
  const withAction = [
    { id: "u3", at: iso(NOW - HOUR), role: "user", kind: "action", text: "摸了一下" },
    { id: "a3", at: iso(NOW - HOUR + 1000), role: "assistant", text: "怎么啦" },
  ];
  assert.equal(recentSceneFor(withAction, { now: NOW, ignoreProactive: true }), null, "动作行不算说了话");
});

test("照片候选概率按档位直接取值，边界取等号时不选", () => {
  const base = { enabled: true, hasContext: true };
  assert.deepEqual(PHOTO_SHARE_CHANCES, { less: 0.25, normal: 0.5, more: 0.8 });
  assert.equal(pickPhotoShare({ ...base, tier: "less", random: () => 0.24 }), true);
  assert.equal(pickPhotoShare({ ...base, tier: "less", random: () => 0.25 }), false);
  assert.equal(pickPhotoShare({ ...base, tier: "normal", random: () => 0.49 }), true);
  assert.equal(pickPhotoShare({ ...base, tier: "normal", random: () => 0.5 }), false);
  assert.equal(pickPhotoShare({ ...base, tier: "more", random: () => 0.79 }), true);
  assert.equal(pickPhotoShare({ ...base, tier: "more", random: () => 0.8 }), false);
  for (const patch of [{ enabled: false }, { hasContext: false }, { blocked: true }, { recentPhoto: true }, { tier: "off" }]) {
    assert.equal(pickPhotoShare({ ...base, tier: "more", random: () => 0, ...patch }), false);
  }
});

test("照片被哪些门槛挡下只报标识，不带聊天内容", () => {
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: true }), []);
  assert.deepEqual(photoShareBlockers({ enabled: false, tier: "normal", hasContext: true }), ["image-unavailable"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "off", hasContext: true }), ["tier-off"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: false }), ["no-context"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: true, blocked: true }), ["blocked"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: true, recentPhoto: true }), ["recent-photo"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: true, sceneUsed: true }), ["scene-used"]);
  assert.deepEqual(photoShareBlockers({ enabled: true, tier: "normal", hasContext: true, recentPhoto: true, sceneUsed: true }), ["recent-photo", "scene-used"]);
  assert.deepEqual(imageSceneExclusions({}), []);
  assert.deepEqual(imageSceneExclusions({ exception: true, followup: true, wakeEcho: true, greetingOnly: true, todoNudge: "记得喝水", publicEvent: true, video: true, news: true, videoLoginNotice: true }),
    ["exception", "followup", "wake-echo", "greeting-only", "todo", "public-event", "video", "news", "video-login"]);
  assert.deepEqual(imageSceneExclusions({ todoNudge: "   " }), []);
});

test("照片提示词：给了依据就明写进去；候选不是硬指标，普通文字也算数", () => {
  const withContext = photoSharePrompt({ context: { userText: "今天想喝热咖啡", assistantText: "我一会儿也去冲一杯" } });
  assert.match(withContext, /今天想喝热咖啡/);
  assert.match(withContext, /我一会儿也去冲一杯/);
  assert.match(withContext, /不要求此刻正在发生/);
  assert.match(withContext, /不能把它说成自己刚刚才有的新经历/);
  assert.match(withContext, /直接写普通文字/);
  assert.match(withContext, /只输出\[不回\]/);
  assert.doesNotMatch(photoSharePrompt(), /今天想喝热咖啡/);
  const long = "咖啡".repeat(200);
  const trimmed = photoSharePrompt({ context: { userText: long, assistantText: long } });
  assert.ok(!trimmed.includes(long), "注入的原文要限长");
  assert.ok(trimmed.includes("咖啡".repeat(80)), "限长后仍留有依据");
});
