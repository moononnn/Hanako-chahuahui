import test from "node:test";
import assert from "node:assert/strict";

import { DAY_START_HOUR, dayKey, dayLabel, daysBetween } from "../lib/days.js";

test("一天从凌晨四点算：三点半算前一天", () => {
  assert.equal(dayKey(new Date(2026, 8, 12, 3, 30)), "2026-09-11");
  assert.equal(dayKey(new Date(2026, 8, 12, 3, 59)), "2026-09-11");
});

test("四点整开始算新的一天", () => {
  assert.equal(dayKey(new Date(2026, 8, 12, 4, 0)), "2026-09-12");
});

test("通宵那一场不会被劈成两天", () => {
  const night = [
    new Date(2026, 8, 11, 23, 10),
    new Date(2026, 8, 12, 1, 40),
    new Date(2026, 8, 12, 3, 55),
  ];
  const keys = new Set(night.map((d) => dayKey(d)));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], "2026-09-11");
});

test("白天和深夜同属一天", () => {
  assert.equal(dayKey(new Date(2026, 8, 12, 4, 0)), dayKey(new Date(2026, 8, 12, 23, 59)));
  assert.equal(dayKey(new Date(2026, 8, 12, 23, 59)), dayKey(new Date(2026, 8, 13, 2, 0)));
});

test("跨月跨年也对", () => {
  assert.equal(dayKey(new Date(2026, 0, 1, 1, 0)), "2025-12-31");
  assert.equal(dayKey(new Date(2026, 2, 1, 10, 0)), "2026-03-01");
});

test("起点小时可覆盖", () => {
  assert.equal(dayKey(new Date(2026, 8, 12, 3, 30), 0), "2026-09-12");
  assert.equal(DAY_START_HOUR, 4);
});

test("非法输入不炸", () => {
  assert.equal(dayKey("这不是日期"), null);
});

test("日期标签好读", () => {
  assert.equal(dayLabel("2026-09-12"), "9月12日");
  assert.equal(dayLabel("2026-01-05"), "1月5日");
  assert.equal(dayLabel("乱写"), "乱写");
});

test("算两个日子差几天", () => {
  assert.equal(daysBetween("2026-09-11", "2026-09-12"), 1);
  assert.equal(daysBetween("2026-09-12", "2026-09-12"), 0);
  assert.equal(daysBetween("2026-08-31", "2026-09-01"), 1);
  assert.equal(daysBetween("x", "2026-09-01"), null);
});
