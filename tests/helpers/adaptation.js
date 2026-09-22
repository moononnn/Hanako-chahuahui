export function canonicalGuide({
  id = "guide-test",
  meaning = "测试偏好",
  kind = "preference",
  scope = "relationship",
  duration = "persistent",
  origin = "explicit",
  sourceMessageIds = ["message-test"],
  claims = [],
  createdAt = "2026-09-22T00:00:00.000Z",
  updatedAt = createdAt,
  ...extra
} = {}) {
  return {
    id,
    meaning,
    kind,
    scope,
    duration,
    origin,
    sourceMessageIds,
    claims,
    createdAt,
    updatedAt,
    ...extra,
  };
}

export function closeRelationship() {
  return {
    familiarity: { turns: 120, activeDays: 24 },
    intimacy: { score: 72, signalCount: 18, signalDays: 12 },
  };
}
