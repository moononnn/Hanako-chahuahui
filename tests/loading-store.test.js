import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-loading-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStore(dir), file: path.join(dir, "v2", "threads", "nova.json") };
}

function countReads(t, file) {
  let count = 0;
  const original = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (String(target) === file) count += 1;
    return original.call(this, target, ...args);
  };
  t.after(() => { fs.readFileSync = original; });
  return () => count;
}

test("聊天加载：未变化的账本多次读取只读一次正文，返回值彼此隔离", (t) => {
  const { store, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "原话", voice: { status: "ready" } });
  const reads = countReads(t, file);
  const first = store.getThread("nova");
  first.messages[0].text = "没有落盘的改动";
  first.messages[0].voice.status = "changed";
  for (let i = 0; i < 20; i += 1) {
    const next = store.getThread("nova");
    assert.equal(next.messages[0].text, "原话");
    assert.equal(next.messages[0].voice.status, "ready");
  }
  assert.equal(reads(), 1, "冷读一次后应复用未变化的账本，不重复读取 JSON");
});

test("聊天加载：写消息、已读、清空和重开实例都立即看到落盘结果", (t) => {
  const { store, dir } = fixture(t);
  const first = store.appendMessage("nova", { role: "assistant", text: "第一句" });
  store.getThread("nova");
  assert.equal(store.unreadCount("nova"), 1);
  store.markRead("nova", { throughId: first.id });
  assert.equal(store.unreadCount("nova"), 0);
  const second = store.appendMessage("nova", { role: "assistant", text: "第二句" });
  assert.equal(store.getThread("nova").messages.at(-1).id, second.id);
  assert.equal(createStore(dir).getThread("nova").messages.length, 2);
  store.clearThread("nova");
  assert.equal(store.getThread("nova").messages.length, 0);
});

test("聊天加载：另一个实例写入或文件被删除，旧缓存不能回带历史", (t) => {
  const { store, dir, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "第一句" });
  store.getThread("nova");
  createStore(dir).appendMessage("nova", { role: "assistant", text: "外部写入" });
  assert.equal(store.getThread("nova").messages.at(-1).text, "外部写入");
  fs.unlinkSync(file);
  assert.deepEqual(store.getThread("nova").messages, []);
  store.appendMessage("nova", { role: "user", text: "新聊天" });
  assert.equal(store.getThread("nova").messages.length, 1);
});

test("聊天加载：同大小、恢复原修改时间的外部编辑仍刷新", (t) => {
  const { store, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "第一句" });
  store.getThread("nova");
  const before = fs.statSync(file);
  const raw = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, raw.replace("第一句", "第二句"), "utf8");
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(store.getThread("nova").messages[0].text, "第二句");
});

test("聊天加载：从缓存过的聊天彻底删除伙伴后不会恢复旧记录", (t) => {
  const { store } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "应被清掉" });
  store.getThread("nova");
  store.purgePartner("nova");
  assert.equal(store.getThread("nova").messages.length, 0);
  store.appendMessage("nova", { role: "user", text: "重新认识" });
  assert.equal(store.getThread("nova").messages.length, 1);
});

test("聊天加载：没聊过的伙伴只检查文件是否存在，不再尝试读取空文件", (t) => {
  const { store, file } = fixture(t);
  const reads = countReads(t, file);
  assert.equal(store.getThread("nova").messages.length, 0);
  assert.equal(store.getThread("nova").messages.length, 0);
  assert.equal(reads(), 0);
});

test("聊天加载：外部改成坏账本仍隔离并提示，不因缓存吞掉损坏", (t) => {
  const { store, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "第一句" });
  store.getThread("nova");
  fs.writeFileSync(file, "{坏账本", "utf8");
  assert.equal(store.getThread("nova").messages.length, 0);
  assert.match(store.getCorruptNotice()?.file ?? "", /nova\.json/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes("corrupt")).length, 1);
});

test("聊天加载：读取权限失败不能被旧缓存伪装成成功", (t) => {
  const { store, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "第一句" });
  store.getThread("nova");
  const original = fs.statSync;
  fs.statSync = function (target, ...args) {
    if (String(target) === file) {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    }
    return original.call(this, target, ...args);
  };
  t.after(() => { fs.statSync = original; });
  assert.throws(() => store.getThread("nova"), (error) => error?.code === "EACCES");
});

test("聊天加载：未读可以复用已读出的同一份快照，不再读第二次正文", (t) => {
  const { store, file } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "第一句" });
  const snapshot = store.getThread("nova");
  const reads = countReads(t, file);
  assert.equal(store.unreadCount("nova", snapshot), 1);
  assert.equal(reads(), 0);
});

test("聊天加载：缓存有上限，较早的伙伴被淘汰后仍从文件正确读取", (t) => {
  const { store, file, dir } = fixture(t);
  store.appendMessage("nova", { role: "assistant", text: "仍然保留在账本" });
  const reads = countReads(t, file);
  store.getThread("nova");
  for (let i = 0; i < 32; i += 1) {
    const id = `p${i}`;
    fs.writeFileSync(path.join(dir, "v2", "threads", `${id}.json`), JSON.stringify({ messages: [] }));
    store.getThread(id);
  }
  assert.equal(store.getThread("nova").messages[0].text, "仍然保留在账本");
  assert.equal(reads(), 2, "超过32位时应淘汰较早的缓存，而非无限保留");
});

test("聊天加载：连续轮询同一伙伴不反复写全局设置，切换仍保存", (t) => {
  const { store, dir } = fixture(t);
  const file = path.join(dir, "v2", "state.json");
  const original = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function (target, ...args) {
    if (String(target).startsWith(file + ".")) writes += 1;
    return original.call(this, target, ...args);
  };
  t.after(() => { fs.writeFileSync = original; });
  store.setLastPartner("nova");
  for (let i = 0; i < 20; i += 1) store.setLastPartner("nova");
  assert.equal(writes, 1);
  store.setLastPartner("sora");
  assert.equal(writes, 2);
  assert.equal(createStore(dir).getLastPartner(), "sora");
});
