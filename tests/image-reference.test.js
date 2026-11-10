import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createImageReferences, REFERENCE_MAX_BYTES } from "../lib/image-reference.js";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhAAAAABJRU5ErkJggg==", "base64");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-reference-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, refs: createImageReferences(dir) };
}
test("参考照默认空，上传与生成都是候选，明确选定才改变当前照", t => {
  const { refs, dir } = setup(t);
  assert.deepEqual(refs.view("one"), { currentId: null, history: [] });
  const first = refs.add("one", { bytes: PNG }).history[0];
  assert.equal(refs.current("one"), null);
  refs.select("one", first.id);
  const second = refs.add("one", { bytes: PNG, source: "generated", prompt: "头发长一点" }).history[0];
  assert.equal(refs.current("one").id, first.id);
  assert.deepEqual(refs.view("one").history.map(row => row.id), [second.id, first.id]);
  assert.equal(createImageReferences(dir).current("one").id, first.id);
  assert.deepEqual(refs.read("one", second.id).bytes, PNG);
  assert.match(refs.resolve("one", first.id).path, /\.png$/);
  assert.equal(JSON.stringify(refs.view("one")).includes(dir), false);
});
test("参考照拒绝串伙伴、越界ID与任意路径", t => {
  const { refs } = setup(t);
  const id = refs.add("one", { bytes: PNG }).history[0].id;
  assert.throws(() => refs.resolve("two", id), /不属于/);
  assert.throws(() => refs.select("one", "../index.json"), /不存在/);
  assert.throws(() => refs.view("../outside"), /ID/);
});
test("参考照按真实字节判图，拒绝非图与过大文件", t => {
  const { refs } = setup(t);
  assert.throws(() => refs.add("one", { bytes: Buffer.from("<html>not image</html>") }), /10MB/);
  const large = Buffer.alloc(REFERENCE_MAX_BYTES + 1); PNG.copy(large);
  assert.throws(() => refs.add("one", { bytes: large }), /10MB/);
});
test("参考照账本损坏不伪装成空照，也不覆盖旧图", t => {
  const { refs, dir } = setup(t);
  const id = refs.add("one", { bytes: PNG }).history[0].id;
  const photoPath = refs.resolve("one", id).path;
  fs.writeFileSync(path.join(dir, "v2", "image-references", "one", "index.json"), "{");
  assert.throws(() => refs.view("one"), /账本损坏/);
  assert.throws(() => refs.view("one"), /账本损坏/);
  assert.equal(fs.existsSync(photoPath), true);
});
test("选用失效文件不会改变当前照", t => {
  const { refs } = setup(t);
  const first = refs.add("one", { bytes: PNG }).history[0].id;
  const second = refs.add("one", { bytes: PNG }).history[0].id;
  refs.select("one", first);
  fs.unlinkSync(refs.resolve("one", second).path);
  assert.throws(() => refs.select("one", second), /不在/);
  assert.equal(refs.view("one").currentId, first);
});
