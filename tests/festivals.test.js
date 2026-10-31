/**
 * 内置节日表测试。
 *
 * 守一件事：公历表里该有的日子别漏——漏了茶话会当天就认不出来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getBuiltinFestivals, getMonthFestivals } from "../lib/festivals.js";

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

const namesOf = (date) => getBuiltinFestivals(date).map((row) => row.name);

test("公历节日：十月最后一天是万圣节", () => {
  assert.deepEqual(namesOf(at(2026, 10, 31)), ["万圣节"]);
  assert.deepEqual(namesOf(at(2027, 10, 31)), ["万圣节"]);
  assert.deepEqual(namesOf(at(2030, 10, 31)), ["万圣节"]);
});

test("万圣节按公历报，带南瓜图标", () => {
  const [row] = getBuiltinFestivals(at(2026, 10, 31));
  assert.equal(row.kind, "solar");
  assert.equal(row.source, "公历");
  assert.equal(row.emoji, "🎃");
});

test("万圣节不越界：前一天和后一天都不报", () => {
  assert.deepEqual(namesOf(at(2026, 10, 30)), []);
  assert.deepEqual(namesOf(at(2026, 11, 1)), []);
});

test("月视图里十月能看见万圣节", () => {
  const october = getMonthFestivals(2026, 10);
  assert.equal(october.get("2026-10-31")?.[0]?.name, "万圣节");
});
