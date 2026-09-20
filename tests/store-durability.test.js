/**
 * 落盘耐久性：账本写坏/读坏时，数据不能被静默销毁。
 *
 * 这两条是补出来的。以前：临时文件名固定（都叫 `x.json.tmp`），两次写碰巧撞上会互相踩；
 * JSON 读坏就默默当「没有数据」，下一次普通操作把整本账覆成空——不可逆。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.js";
import { readJsonDurable } from "../lib/persistence.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-durability-"));
  return { dir, store: createStore(dir) };
}

test("JSON 持久化：只有 ENOENT 才返回默认值，其他读取错误必须抛出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-read-errors-"));
  const missing = path.join(dir, "missing.json");
  assert.deepEqual(readJsonDurable(missing, { empty: true }), { empty: true });
  const directory = path.join(dir, "directory.json");
  fs.mkdirSync(directory);
  assert.throws(() => readJsonDurable(directory, {}), (error) => ["EISDIR", "EPERM", "EACCES"].includes(error?.code));
});

test("JSON 读坏时挪一份留档、原处腾空（下一次写才不会静默覆掉它）", () => {
  const { dir, store } = tmpStore();
  const file = path.join(dir, "v2", "partners", "hanako", "memory.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 这不是合法 JSON", "utf8");

  const memory = store.readMemory("hanako");
  assert.ok(memory && typeof memory === "object", "坏数据当没调过，不能炸");

  const siblings = fs.readdirSync(path.dirname(file));
  assert.equal(siblings.filter((n) => n.includes("corrupt")).length, 1, "坏文件要留一份");
  assert.ok(!fs.existsSync(file), "原处要腾空，否则下一次写会盖掉它");
  assert.equal(store.takeCorruptLog().length, 1, "要留记录给诊断");
});

test("账本文件不存在是正常的，不该留 corrupt 记录", () => {
  const { store } = tmpStore();
  const memory = store.readMemory("never-seen");
  assert.ok(memory && typeof memory === "object");
  assert.equal(store.takeCorruptLog().length, 0);
});

test("读坏账本会留一条提示给界面，取走即空", () => {
  const { dir, store } = tmpStore();
  assert.equal(store.getCorruptNotice(), null, "新建的账本不该带着上一条提示");

  const file = path.join(dir, "v2", "partners", "hanako", "memory.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 坏", "utf8");
  store.readMemory("hanako");

  const notice = store.getCorruptNotice();
  assert.ok(notice, "要留一条给界面");
  assert.match(notice.file, /memory\.json/, "提示要指到哪份文件");
  assert.equal(store.getCorruptNotice(), null, "取走即空，不反复提示");
});

test("JSON 损坏且无法隔离时拒绝继续写入", async () => {
  const { dir } = tmpStore();
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, "{坏", "utf8");
  const persistence = await import("../lib/persistence.js");
  const original = fs.renameSync;
  fs.renameSync = () => { const error = new Error("locked"); error.code = "EPERM"; throw error; };
  try {
    assert.throws(() => persistence.readJsonDurable(file, {}), /损坏账本无法留档/);
  } finally {
    fs.renameSync = original;
  }
});

test("写入是原子的：写完不留下临时文件", () => {
  const { dir, store } = tmpStore();
  store.setGlobalSettings({ userNameOverride: "阿舟" });
  const v2 = fs.readdirSync(path.join(dir, "v2"));
  assert.equal(v2.filter((n) => n.endsWith(".tmp")).length, 0, "不许留临时件");
});

test("诊断日志脱掉原文，只留长度", async () => {
  const { createDiagnostics } = await import("../lib/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-diag-"));
  const log = createDiagnostics(dir);
  log({ event: "reply.tail", tail: "这是伙伴说的原文", sessionPath: "C:/x/y" });
  const file = path.join(dir, "v2", "diagnostics.jsonl");
  const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(row.tail, undefined, "原文不该进日志");
  assert.equal(row.tailChars, 8, "只留长度");
  assert.equal(row.event, "reply.tail", "事件名要留");
  assert.equal(row.sessionPath, "C:/x/y", "路径还留（本地诊断要看）");
});
