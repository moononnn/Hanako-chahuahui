import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_STICKER_USAGE_EVENTS,
  STICKER_USAGE_SCHEMA_VERSION,
  readStickerUsage,
  recordStickerUsage,
  stickerUsageFile,
} from "../lib/sticker-usage.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-sticker-usage-"));
}

test("标准 Hana dataDir 与插件读取契约指向同一文件", () => {
  const hanaHome = "C:/hana";
  assert.equal(
    stickerUsageFile(path.join(hanaHome, "plugin-data", "chahuahui")),
    path.join(hanaHome, "plugin-data", "chahuahui", "v2", "sticker-usage.json"),
  );
});

test("记录茶话会发送的表情包，字段最小且可重启读取", () => {
  const dir = tempDir();
  const result = recordStickerUsage(dir, {
    stickerId: " stk_001 ",
    partnerId: "hanako",
    sentAt: "2026-09-20T08:46:00.000Z",
    ignored: "不落盘",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(readStickerUsage(dir), {
    schemaVersion: STICKER_USAGE_SCHEMA_VERSION,
    events: [{
      stickerId: "stk_001",
      partnerId: "hanako",
      sentAt: "2026-09-20T08:46:00.000Z",
    }],
  });
  assert.equal(fs.existsSync(stickerUsageFile(dir)), true);
});

test("坏记录和空字段静默丢弃，不影响读取", () => {
  const dir = tempDir();
  fs.mkdirSync(path.dirname(stickerUsageFile(dir)), { recursive: true });
  fs.writeFileSync(stickerUsageFile(dir), JSON.stringify({
    schemaVersion: 99,
    events: [null, { stickerId: "", partnerId: "hanako" }, { stickerId: "stk_2", partnerId: "hanako" }],
  }));
  assert.deepEqual(readStickerUsage(dir).events.map((item) => item.stickerId), ["stk_2"]);
});

test("记录数量有上限，保留最新事件", () => {
  const dir = tempDir();
  for (let i = 0; i < MAX_STICKER_USAGE_EVENTS + 3; i += 1) {
    recordStickerUsage(dir, { stickerId: `stk_${i}`, partnerId: "hanako", sentAt: `2026-09-20T08:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }
  const events = readStickerUsage(dir).events;
  assert.equal(events.length, MAX_STICKER_USAGE_EVENTS);
  assert.equal(events[0].stickerId, "stk_3");
  assert.equal(events.at(-1).stickerId, `stk_${MAX_STICKER_USAGE_EVENTS + 2}`);
});
