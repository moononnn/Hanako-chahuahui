import test from "node:test";
import assert from "node:assert/strict";
import { addFeed, formatFeed, normalizeFeed } from "../lib/feed.js";

test("同类投喂累加，不同类投喂并存", () => {
  const once = addFeed(null, "🧋", "2026-09-23T12:00:00.000Z");
  const twice = addFeed(once, "🧋", "2026-09-23T12:01:00.000Z");
  const mixed = addFeed(twice, "🍰", "2026-09-23T12:02:00.000Z");

  assert.deepEqual(mixed.items.map(({ emoji, count }) => ({ emoji, count })), [
    { emoji: "🧋", count: 2 },
    { emoji: "🍰", count: 1 },
  ]);
  assert.equal(formatFeed(mixed), "🧋×2 🍰");
});

test("兼容旧版单个投喂记录，并合并重复条目", () => {
  const feed = normalizeFeed({
    emoji: "☕",
    items: [{ emoji: "☕", count: 2 }, { emoji: "🍪", count: 1 }],
  });
  assert.deepEqual(feed.items.map(({ emoji, count }) => ({ emoji, count })), [
    { emoji: "☕", count: 2 },
    { emoji: "🍪", count: 1 },
  ]);
});
