import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readUsageBook, recordUsageCall, usageBookPath, usageIndex } from "../lib/usage-book.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-usage-book-"));
}

const row = (change = {}) => ({
  requestId: "chahuahui_stream_1_abc",
  at: "2026-10-25T20:00:00.000Z",
  agentId: "hanako",
  kind: "chat",
  ...change,
});

test("记一笔身份，读回来还在", () => {
  const dir = tempDir();
  const result = recordUsageCall(dir, row());
  assert.equal(result.ok, true);
  assert.equal(result.rows, 1);
  const rows = readUsageBook(dir);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("没有 requestId 或时间是坏的不收，也不写盘", () => {
  const dir = tempDir();
  assert.equal(recordUsageCall(dir, row({ requestId: "" })).ok, false);
  assert.equal(recordUsageCall(dir, row({ at: "not-a-time" })).ok, false);
  assert.equal(readUsageBook(dir).length, 0);
  assert.equal(fs.existsSync(usageBookPath(dir)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("伙伴与用途可以留空，不会因此整条丢掉", () => {
  const dir = tempDir();
  recordUsageCall(dir, row({ agentId: null, kind: null }));
  const [only] = readUsageBook(dir);
  assert.equal(only.agentId, null);
  assert.equal(only.kind, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("超过 31 天的旧账读的时候就被裁掉", () => {
  const dir = tempDir();
  const now = Date.parse("2026-10-25T21:00:00.000Z");
  recordUsageCall(dir, row({ requestId: "old", at: "2026-08-01T00:00:00.000Z" }), now);
  recordUsageCall(dir, row({ requestId: "fresh", at: "2026-10-25T20:00:00.000Z" }), now);
  const rows = readUsageBook(dir, now);
  assert.deepEqual(rows.map((entry) => entry.requestId), ["fresh"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("索引按 requestId 查得到身份", () => {
  const dir = tempDir();
  recordUsageCall(dir, row());
  recordUsageCall(dir, row({ requestId: "chahuahui_stream_2_def", agentId: "beta", kind: "proactive" }));
  const index = usageIndex(readUsageBook(dir));
  assert.equal(index.get("chahuahui_stream_1_abc").agentId, "hanako");
  assert.equal(index.get("chahuahui_stream_2_def").kind, "proactive");
  assert.equal(index.get("不存在"), undefined);
});

test("账本坏了当空账读，不炸聊天", () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(usageBookPath(dir), "{ 半截", "utf8");
  assert.deepEqual(readUsageBook(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
