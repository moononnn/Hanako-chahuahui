import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-refs-"));
  return { dir, store: createStore(dir), threads: path.join(dir, "v2", "threads") };
}

test("正常账本里的附件照旧算有人认领", () => {
  const { store } = tmpStore();
  store.appendMessage("hanako", { role: "user", text: "看图", attachment: { id: "img_live" } });
  assert.ok(store.referencedAttachmentIds().has("img_live"));
});

test("读坏改名留档后，完整留档里的引用也要算", () => {
  // 账本读坏会被改名成 xxx.json.corrupt-<时间戳>。留档里还在引用那张图，
  // 不认它的话，下次点清理就会把只被留档引用的图当孤儿删掉。
  const { dir, threads } = tmpStore();
  const backup = path.join(threads, "hanako.json.corrupt-2026-10-28T00-12-00-000Z");
  fs.writeFileSync(backup, JSON.stringify({ messages: [{ role: "user", attachment: { id: "img_backup" } }] }));
  const store = createStore(dir);
  assert.ok(store.referencedAttachmentIds().has("img_backup"));
});

test("留档只剩半截 JSON 时按 id 字样兜底，宁可多留也不误删", () => {
  const { dir, threads } = tmpStore();
  // 模拟写到一半断掉：解析不了，但图 id 还在文本里。
  fs.writeFileSync(path.join(threads, "hanako.json.corrupt-2026-10-28T00-13-00-000Z"), '{"messages":[{"attachment":{"id":"img_half');
  const store = createStore(dir);
  assert.ok(store.referencedAttachmentIds().has("img_half"));
});

test("正常账本读坏时，扫描既不丢引用也不把它再改名", () => {
  const { dir, threads } = tmpStore();
  const live = path.join(threads, "hanako.json");
  fs.writeFileSync(live, '{"messages":[{"attachment":{"id":"img_live_corrupt');
  const store = createStore(dir);
  const ids = store.referencedAttachmentIds();
  assert.ok(ids.has("img_live_corrupt"));
  assert.ok(fs.existsSync(live), "扫描不该顺手把坏账改名");
});

test("别的文件不算引用", () => {
  const { store, threads } = tmpStore();
  fs.writeFileSync(path.join(threads, "notes.txt"), "img_not_a_thread");
  fs.writeFileSync(path.join(threads, "hanako.json.bak"), '{"attachment":{"id":"img_bak"}}');
  assert.equal(store.referencedAttachmentIds().has("img_not_a_thread"), false);
  assert.equal(store.referencedAttachmentIds().has("img_bak"), false);
});
