import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_BADGES, badgeGuide, badgeText, fallbackBadge, normalizeBadge, parseBadgeMarker } from "../lib/badges.js";

test("常见状态徽章只接受白名单，并保留统一形状", () => {
  assert.equal(COMMON_BADGES.some((row) => row.id === "sleeping"), true);
  assert.deepEqual(normalizeBadge({ type: "common", id: "online" }), {
    type: "common", id: "online", label: "在线", description: "正在这里，手边有手机。", updatedAt: null,
  });
  assert.equal(normalizeBadge({ type: "common", id: "not-real" }), null);
});

test("自定义徽章会裁剪长度并拒绝空标题", () => {
  const badge = normalizeBadge({ type: "custom", title: "  夜行猫  ", description: "晚上才有精神" });
  assert.equal(badge.title, "夜行猫");
  assert.equal(badge.description, "晚上才有精神");
  assert.equal(normalizeBadge({ type: "custom", title: "   " }), null);
});

test("伙伴回复里的徽章标记可被剥掉，正文不带控制语法", () => {
  const common = parseBadgeMarker("今天有点困 [徽章:睡着了]");
  assert.equal(common.badge.id, "sleeping");
  assert.equal(common.before, "今天有点困");
  assert.equal(common.after, "");

  const custom = parseBadgeMarker("我今晚想安静一点\n[徽章:自定义|夜行猫|晚上才有精神]");
  assert.equal(custom.badge.type, "custom");
  assert.equal(custom.badge.title, "夜行猫");
  assert.equal(custom.badge.description, "晚上才有精神");
  assert.equal(custom.before, "我今晚想安静一点");
});

test("没有伙伴自主表达时，徽章由真实运行状态提供只读兜底", () => {
  assert.equal(fallbackBadge({ sleeping: true }).id, "sleeping");
  assert.equal(fallbackBadge({ awaiting: true }).id, "awaiting");
  assert.equal(fallbackBadge({ busy: true }).id, "busy");
  assert.equal(fallbackBadge({ unread: 1 }).id, "new");
  assert.equal(fallbackBadge({ lastMessage: { role: "assistant", at: new Date(Date.now() - 30 * 60_000).toISOString() } }).id, "recent");
  assert.equal(fallbackBadge({ holdingPhone: false }).id, "away");
  assert.equal(fallbackBadge({ holdingPhone: true, lastMessage: { role: "assistant", at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } }).id, "idle");
});

test("短暂状态优先于长期兜底状态", () => {
  const recent = { role: "assistant", at: new Date(Date.now() - 10 * 60_000).toISOString() };
  assert.equal(fallbackBadge({ unread: 1, lastMessage: recent, holdingPhone: false }).id, "new");
  assert.equal(fallbackBadge({ busy: true, unread: 1, lastMessage: recent }).id, "busy");
  assert.equal(fallbackBadge({ sleeping: true, busy: true, unread: 1 }).id, "sleeping");
});

test("一个字都没说过的 ta 不给徽章：没数据就别拿默认值冒充 ta 的状态", () => {
  // 实机：某位伙伴聊天记录为空，界面上照样显示「摸鱼中」，像 ta 已经在过日子了。
  assert.equal(fallbackBadge({ hasHistory: false }), null);
  // 但只要有一句真实对话，兜底就照常工作。
  assert.equal(fallbackBadge({ hasHistory: true, holdingPhone: true }).id, "idle");
});

test("badgeText 遇到空徽章返回空串，界面上不显示", () => {
  assert.equal(badgeText(null), "");
  assert.equal(badgeText(normalizeBadge({ type: "common", id: "idle" })), "摸鱼中");
});

test("徽章说明要报出当前佩戴结果，ta 才有参照物判断该不该换", () => {
  const worn = badgeGuide({ current: { type: "common", id: "busy" } });
  assert.match(worn, /你现在佩戴的是「忙碌中」/, "得告诉 ta 现在戴着什么");
  assert.match(worn, /隐藏标记/, "换的时候仍然要教写法");
  // 已经戴着的，别催着每轮都改。
  assert.match(worn, /不要每轮都换/);

  // 自定义徽章也照报标题。
  assert.match(badgeGuide({ current: { type: "custom", title: "夜行猫" } }), /你现在佩戴的是「夜行猫」/);
});

test("还没戴过徽章的 ta：门槛降到「现在就定一个」，并说清那一栏不是自己挑的", () => {
  const fresh = badgeGuide({ current: null });
  assert.match(fresh, /还没有自己的状态徽章/);
  assert.match(fresh, /不是你自己挑的/, "得说清界面上那个是系统推的默认值");
  assert.match(fresh, /顺手定一个/, "首次要给出明确动作");
  assert.match(fresh, /\[徽章:/, "仍然要教标记写法");
  assert.doesNotMatch(fresh, /你现在佩戴的是/, "没戴过就不该说有佩戴结果");
});

