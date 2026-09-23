const MAX_FEED_ITEMS = 32;

function cleanEmoji(value) {
  return String(value ?? "").trim().slice(0, 16);
}

function cleanCount(value) {
  return Math.max(1, Math.min(999, Math.floor(Number(value) || 1)));
}

export function normalizeFeed(value) {
  const source = value && typeof value === "object" ? value : {};
  const legacy = source.emoji ? [{ emoji: source.emoji, count: 1, at: source.at }] : [];
  const rawItems = Array.isArray(source.items) ? source.items : legacy;
  const items = [];
  const byEmoji = new Map();
  for (const raw of rawItems) {
    const emoji = cleanEmoji(raw?.emoji);
    if (!emoji) continue;
    const existing = byEmoji.get(emoji);
    if (existing) {
      existing.count = cleanCount(existing.count + cleanCount(raw?.count));
      existing.at = raw?.at || existing.at;
      continue;
    }
    const item = {
      emoji,
      count: cleanCount(raw?.count),
      ...(raw?.at ? { at: String(raw.at) } : {}),
    };
    byEmoji.set(emoji, item);
    items.push(item);
    if (items.length >= MAX_FEED_ITEMS) break;
  }
  return { items };
}

export function addFeed(value, emoji, at = new Date().toISOString()) {
  const feed = normalizeFeed(value);
  const target = cleanEmoji(emoji);
  if (!target) return feed;
  const item = feed.items.find((row) => row.emoji === target);
  if (item) {
    item.count = cleanCount(item.count + 1);
    item.at = String(at);
  } else {
    feed.items.push({ emoji: target, count: 1, at: String(at) });
  }
  return feed;
}

export function feedItems(value) {
  return normalizeFeed(value).items;
}

export function formatFeed(value) {
  return feedItems(value).map((row) => `${row.emoji}${row.count > 1 ? `×${row.count}` : ""}`).join(" ");
}
