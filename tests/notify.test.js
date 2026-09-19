import test from "node:test";
import assert from "node:assert/strict";

import {
  activePanelSeenAt,
  applyPresence,
  BATCH_TTL_MS,
  PANEL_OPEN_MS,
  bannerText,
  isQuietNow,
  mergeBatch,
  shouldAnnounce,
} from "../lib/notify.js";

const at = (h, m = 0) => new Date(2026, 8, 12, h, m);
const QUIET = { start: "23:00", end: "08:00" };

test("合并批次：新来一条就起一批", () => {
  const batch = mergeBatch(null, { agentId: "a", name: "阿昭" }, at(15));
  assert.equal(batch.count, 1);
  assert.deepEqual(batch.partners, [{ agentId: "a", name: "阿昭" }]);
  assert.equal(batch.latestAt, at(15).toISOString());
});

test("合并批次：同一个人连发只把那一位往前挪，条数照加", () => {
  const first = mergeBatch(null, { agentId: "a", name: "阿昭" }, at(15));
  const second = mergeBatch(first, { agentId: "a", name: "阿昭" }, at(15, 1));
  assert.equal(second.count, 2);
  assert.deepEqual(second.partners, [{ agentId: "a", name: "阿昭" }]);
});

test("合并批次：两个人就是两位，不并成一条", () => {
  const first = mergeBatch(null, { agentId: "a", name: "阿昭" }, at(15));
  const second = mergeBatch(first, { agentId: "b", name: "沈叙" }, at(15, 2));
  assert.equal(second.count, 2);
  assert.deepEqual(second.partners.map((row) => row.name), ["阿昭", "沈叙"]);
});

test("合并批次：搁过夜了就不跟旧账并成一批", () => {
  const old = mergeBatch(null, { agentId: "a", name: "阿昭" }, at(15));
  const later = new Date(at(15).getTime() + BATCH_TTL_MS + 1000);
  const batch = mergeBatch(old, { agentId: "b", name: "沈叙" }, later);
  assert.equal(batch.count, 1);
  assert.deepEqual(batch.partners.map((row) => row.name), ["沈叙"]);
});

test("在场租约：旧序号的 active 回包不能复活页面", () => {
  const leases = new Map();
  const sequences = new Map();
  assert.equal(applyPresence(leases, sequences, { token: "a", active: true, seq: 1, now: 100 }), true);
  assert.equal(applyPresence(leases, sequences, { token: "a", active: false, seq: 2, now: 110 }), true);
  assert.equal(applyPresence(leases, sequences, { token: "a", active: true, seq: 1, now: 120 }), false);
  assert.equal(activePanelSeenAt(leases, 120), 0);
});

test("在场租约：多个页面互不清掉，过期租约才清理", () => {
  const leases = new Map();
  const sequences = new Map();
  applyPresence(leases, sequences, { token: "a", active: true, seq: 0, now: 100 });
  applyPresence(leases, sequences, { token: "b", active: true, seq: 0, now: 120 });
  applyPresence(leases, sequences, { token: "a", active: false, seq: 1, now: 130 });
  assert.equal(activePanelSeenAt(leases, 130, 75), 120);
  assert.deepEqual([...leases.keys()], ["b"]);
  assert.equal(activePanelSeenAt(leases, 200, 75), 0);
});

test("横幅文案：只说谁找她，绝不带消息内容", () => {
  assert.equal(bannerText({ partners: [{ agentId: "a", name: "阿昭" }], count: 1 }), "🌸 阿昭 找你说说话");
  assert.equal(bannerText({ partners: [{ agentId: "a", name: "阿昭" }], count: 3 }), "🌸 阿昭 找你说说话 · 3 条");
  assert.equal(
    bannerText({ partners: [{ name: "阿昭" }, { name: "沈叙" }], count: 2 }),
    "🌸 阿昭、沈叙 找你说说话",
  );
  assert.equal(
    bannerText({ partners: [{ name: "阿昭" }, { name: "沈叙" }, { name: "林晚" }], count: 3 }),
    "🌸 阿昭、沈叙 等 3 位 找你说说话",
  );
  assert.equal(bannerText(null), "");
});

test("闸门：她在哪间屋都还没定下来，就别冒", () => {
  const batch = { partners: [{ name: "阿昭" }], count: 1 };
  assert.deepEqual(
    shouldAnnounce({ now: at(15), quiet: QUIET, panelOpen: false, batch, activeSessionPath: null }),
    { ok: false, reason: "no-active-window" },
  );
});

test("闸门：人已经在茶话会里了就不喊了", () => {
  const batch = { partners: [{ name: "阿昭" }], count: 1 };
  assert.equal(
    shouldAnnounce({ now: at(15), quiet: QUIET, panelOpen: true, batch, activeSessionPath: "/s/a" }).reason,
    "panel-open",
  );
});

test("闸门：静默时段只累计，不出条", () => {
  const batch = { partners: [{ name: "阿昭" }], count: 1 };
  assert.equal(
    shouldAnnounce({ now: at(2), quiet: QUIET, panelOpen: false, batch, activeSessionPath: "/s/a" }).reason,
    "quiet",
  );
});

test("闸门：该冒的时候冒", () => {
  const batch = { partners: [{ name: "阿昭" }], count: 1 };
  assert.equal(
    shouldAnnounce({ now: at(15), quiet: QUIET, panelOpen: false, batch, activeSessionPath: "/s/a" }).ok,
    true,
  );
});

test("静默判断支持跨零点", () => {
  assert.equal(isQuietNow(at(23, 30), QUIET), true);
  assert.equal(isQuietNow(at(3), QUIET), true);
  assert.equal(isQuietNow(at(7, 59), QUIET), true);
  assert.equal(isQuietNow(at(8), QUIET), false);
  assert.equal(isQuietNow(at(15), QUIET), false);
  assert.equal(isQuietNow(at(15), null), false);
});

test("在场窗口是给卡片心跳留的余量，不能是零", () => {
  assert.ok(PANEL_OPEN_MS >= 60 * 1000);
});
