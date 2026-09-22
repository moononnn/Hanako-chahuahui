import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  listAdaptationForUser,
  revokeAdaptationGuide,
  parseAdaptationCorrection,
  applyAdaptationCorrection,
} from "../lib/adaptation-correction.js";

const appSource = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

const baseGuide = {
  id: "g-voice",
  meaning: "你喜欢我多发一点语音",
  kind: "preference",
  scope: "relationship",
  duration: "persistent",
  origin: "explicit",
  confidence: 1,
  sourceMessageIds: ["m-1"],
  evidenceQuote: "多发一点语音嘛",
  claims: [{ target: "voice.frequency", effect: "prefer", value: "more" }],
  status: "active",
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-20T08:00:00.000Z",
};

const book = (guide = baseGuide) => ({ revision: 4, guides: [guide], exceptions: [], feedbackEvents: [], habitChanges: [] });

test("查看相处理解只给轻量文案和作用范围，不泄露内部 schema 与数值", () => {
  const rows = listAdaptationForUser({ partnerBook: book(), userBook: book({ ...baseGuide, id: "g-wide", scope: "user-wide" }) });
  assert.deepEqual(rows.map((row) => Object.keys(row).sort()), [
    ["id", "kind", "meaning", "scope", "updatedAt"],
    ["id", "kind", "meaning", "scope", "updatedAt"],
  ]);
  assert.equal(JSON.stringify(rows).includes("confidence"), false);
  assert.equal(JSON.stringify(rows).includes("claims"), false);
  assert.equal(JSON.stringify(rows).includes("sourceMessageIds"), false);
});

test("忘掉只 revoke 目标 guide，并立即回退引用 habit，不物理删除历史", () => {
  const current = { ...book(), habitChanges: [{ id: "h-1", guideIds: ["g-voice"], state: "settled", updatedAt: baseGuide.updatedAt }] };
  const result = revokeAdaptationGuide(current, "g-voice", new Date("2026-09-22T12:00:00.000Z"));
  assert.equal(result.ok, true);
  assert.equal(result.book.guides.length, 1);
  assert.equal(result.book.guides[0].status, "revoked");
  assert.equal(result.book.habitChanges[0].state, "reverted");
});

test("纠错建议只接受同一目标与合法结构，表情许可不得扩大 subject", () => {
  const stickerGuide = { ...baseGuide, id: "g-sticker", kind: "permission", meaning: "这张表情可以用", claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:sticker-1" }] };
  const rawDeny = JSON.stringify({ meaning: "这张表情不要再用了", kind: "boundary", claims: [{ target: "sticker.permission", effect: "deny", value: "specific", subject: "source:sticker-1" }] });
  const parsed = parseAdaptationCorrection(rawDeny, {
    guide: stickerGuide,
    userInstruction: "这张以后不要再用了",
  });
  assert.equal(parseAdaptationCorrection(rawDeny, { guide: stickerGuide, userInstruction: "把文案改顺一点" }).ok, false, "敏感许可改向必须来自用户明确表达");
  assert.equal(parsed.ok, true);
  const expanded = parseAdaptationCorrection(JSON.stringify({ meaning: "所有表情都可以用", kind: "permission", claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:other" }] }), {
    guide: stickerGuide,
  });
  assert.equal(expanded.ok, false);
});

test("纠错路由用服务端临时建议与 revision 防旧建议覆盖，失败不会删除建议", () => {
  assert.match(appSource, /adaptationDrafts\.set\(draftId/);
  assert.match(appSource, /current\.revision !== expectedRevision/);
  assert.match(appSource, /applyAdaptationCorrection\(current, \{ guideId: draft\.guideId, baseRevision: draft\.baseRevision/);
  assert.match(appSource, /if \(!applied\.ok\)[\s\S]*?return c\.json[\s\S]*?adaptationDrafts\.delete\(draftId\)/, "只有确认写盘成功后才能删除建议");
});

test("应用纠错保留旧 guide 并 supersede；旧 revision 建议必须拒绝", () => {
  const proposal = { meaning: "你希望我少发一点语音", kind: "preference", claims: [{ target: "voice.frequency", effect: "prefer", value: "less" }] };
  const stale = applyAdaptationCorrection(book(), { guideId: "g-voice", baseRevision: 3, proposal, now: new Date("2026-09-22T12:00:00.000Z") });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");
  const applied = applyAdaptationCorrection(book(), { guideId: "g-voice", baseRevision: 4, proposal, now: new Date("2026-09-22T12:00:00.000Z") });
  assert.equal(applied.ok, true);
  assert.equal(applied.book.guides.find((guide) => guide.id === "g-voice").status, "superseded");
  assert.equal(applied.book.guides.at(-1).supersedesId, "g-voice");
  assert.equal(applied.book.guides.at(-1).sourceMessageIds[0], "m-1");
});
