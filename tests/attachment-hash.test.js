import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, isReusableAttachment, touchAttachmentMeta } from "../lib/attachment-hash.js";

const A = Buffer.from("同一张图的字节");
const B = Buffer.from("另一张图的字节");

test("内容指纹：同一份文件永远同一串，差一个字节就是另一串", () => {
  assert.equal(contentHash(A), contentHash(Buffer.from(A)));
  assert.notEqual(contentHash(A), contentHash(B));
  assert.match(contentHash(A), /^[0-9a-f]{64}$/);
});

test("只有同一位伙伴的同一份文件才算命中", () => {
  const hash = contentHash(A);
  const meta = { id: "img_1", agentId: "hanako", mimeType: "image/png", hash };
  assert.equal(isReusableAttachment(meta, { hash, agentId: "hanako", mimeType: "image/png" }), true);
  // 换个伙伴不算：各存各的，删一位伙伴时才不会带走别人还在用的那份。
  assert.equal(isReusableAttachment(meta, { hash, agentId: "other-partner", mimeType: "image/png" }), false);
  // 内容或类型不同都不算。
  assert.equal(isReusableAttachment(meta, { hash: contentHash(B), agentId: "hanako", mimeType: "image/png" }), false);
  assert.equal(isReusableAttachment(meta, { hash, agentId: "hanako", mimeType: "image/jpeg" }), false);
});

test("老图没有指纹就当没命中，不拿它去糊弄新图", () => {
  const hash = contentHash(A);
  assert.equal(isReusableAttachment({ id: "img_old", agentId: "hanako", mimeType: "image/png" }, { hash, agentId: "hanako", mimeType: "image/png" }), false);
  assert.equal(isReusableAttachment(null, { hash, agentId: "hanako", mimeType: "image/png" }), false);
  assert.equal(isReusableAttachment({ agentId: "hanako", hash }, {}), false);
});

test("再发一次只动时间和次数，身份不变", () => {
  const meta = { id: "img_1", agentId: "hanako", hash: "h", occurrences: 1, at: "2026-10-26T09:00:00.000Z", lastSeenAt: "2026-10-26T09:00:00.000Z" };
  const next = touchAttachmentMeta(meta, "2026-10-27T09:00:00.000Z");
  assert.equal(next.occurrences, 2);
  assert.equal(next.lastSeenAt, "2026-10-27T09:00:00.000Z");
  assert.equal(next.at, "2026-10-26T09:00:00.000Z", "第一次见到它的时间不能被盖掉");
  assert.equal(next.id, meta.id);
  assert.equal(next.hash, meta.hash);
  // 没有次数的旧记录也按第一次算，不会变成 NaN。
  assert.equal(touchAttachmentMeta({ id: "x" }, "2026-10-27T09:00:00.000Z").occurrences, 2);
});
