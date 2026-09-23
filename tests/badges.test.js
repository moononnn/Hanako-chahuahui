import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_BADGES, fallbackBadge, normalizeBadge, parseBadgeMarker } from "../lib/badges.js";

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

