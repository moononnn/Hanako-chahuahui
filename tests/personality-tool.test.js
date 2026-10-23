import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { normalizePalette } from "../lib/palette.js";
import { createPersonalityHandler, registerPersonalityTool, PERSONALITY_PARAMETERS } from "../lib/personality-tool.js";

const palette = () => normalizePalette({
  colors: [{ id: "c1", name: "温润", role: "base", evidence: [1, 2] }],
  derivatives: [{ id: "d1", colorId: "c1", text: "对方难受时先听一听。", on: true }],
  portrait: [], corpus: [],
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tea-personality-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realStore = createStore(dir);
  realStore.saveKnowing("p1", { ...realStore.getKnowing("p1"), palette: palette() });
  realStore.saveKnowing("p2", { ...realStore.getKnowing("p2"), palette: palette() });
  let clock = Date.parse("2026-10-23T10:00:00Z");
  let writes = 0;
  const store = { getKnowing: (...args) => realStore.getKnowing(...args), saveKnowing: (...args) => { writes++; return realStore.saveKnowing(...args); } };
  const handle = createPersonalityHandler({ store, listPartners: async () => [{ id: "p1" }, { id: "p2" }], now: () => clock });
  return { dir, realStore, store, handle, writes: () => writes, advance: (ms) => { clock += ms; } };
}
async function preview(f, patch = { colors: [{ id: "c1", name: "直率", role: "base" }] }, agentId = "p1") {
  const read = await f.handle({ action: "read", agentId });
  return f.handle({ action: "preview", agentId, baseRevision: read.revision, patch });
}
const apply = (f, p, extra = {}) => f.handle({ action: "apply", agentId: "p1", token: p.token, confirm: true, ...extra });

test("read只投影性格档案及生效口径，无写入和隐藏字段", async (t) => {
  const f = fixture(t);
  const r = await f.handle({ action: "read", agentId: "p1" });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ["action", "agentId", "effectiveText", "note", "ok", "palette", "revision", "warnings"].sort());
  assert.match(r.effectiveText, /温润/);
  assert.equal(f.writes(), 0);
  assert.equal(PERSONALITY_PARAMETERS.additionalProperties, false);
});

test("preview展示精确前后，不落盘；apply旧版入历史、保留未改区段和其余档案", async (t) => {
  const f = fixture(t);
  const before = f.realStore.getKnowing("p1");
  const other = f.realStore.getKnowing("p2");
  const p = await preview(f);
  assert.equal(p.ok, true);
  assert.equal(p.saved, false);
  assert.deepEqual(p.changedFields, ["colors"]);
  assert.deepEqual(f.realStore.getKnowing("p1"), before);
  assert.equal(f.writes(), 0);
  const r = await apply(f, p);
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.revision, before.revision + 1);
  assert.equal(r.palette.colors[0].name, "直率");
  assert.deepEqual(r.palette.colors[0].evidence, [], "改名不能保留旧色的证据编号");
  const after = f.realStore.getKnowing("p1");
  assert.deepEqual(after.history[0].snapshot.palette, before.palette);
  for (const key of Object.keys(before).filter((key) => !["palette", "history", "revision"].includes(key))) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.palette.derivatives, before.palette.derivatives);
  assert.deepEqual(f.realStore.getKnowing("p2"), other);
});

test("行为、语料和自画像可组合修改，原样读回且确实进入表达块", async (t) => {
  const f = fixture(t);
  const p = await preview(f, {
    derivatives: [{ id: "d1", colorId: "c1", text: "意见不同时先讲理由，没有新依据也不急着改口。" }],
    portrait: [{ title: "有话直说", text: "亲近对方，也有自己的意见。" }],
    corpus: [{ scene: "被打趣犟", lines: ["你还没把我说服嘛。"] }],
  });
  assert.equal(p.ok, true);
  const r = await apply(f, p);
  assert.equal(r.ok, true);
  assert.equal(r.palette.derivatives[0].origin, "user");
  assert.deepEqual(r.palette.colors[0].evidence, [1, 2]);
  assert.match(r.effectiveText, /你还没把我说服嘛/);
  assert.match(r.effectiveText, /有话直说/);
});

test("重复及并发apply幂等，不再写盘或挤掉历史", async (t) => {
  const f = fixture(t);
  const p = await preview(f);
  const results = await Promise.all([apply(f, p), apply(f, p)]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.filter((r) => r.alreadyApplied).length, 1);
  const r = await apply(f, p);
  assert.equal(r.alreadyApplied, true);
  assert.equal(f.writes(), 1);
});

test("版本变化与改回原文都拒绝旧预览", async (t) => {
  const f = fixture(t);
  const p = await preview(f);
  const knowing = f.realStore.getKnowing("p1");
  f.realStore.saveKnowing("p1", knowing);
  const r = await apply(f, p);
  assert.equal(r.code, "revision-changed");
  assert.equal(f.writes(), 0);
});

test("即使版本戳不变，内容指纹变化也阻断覆盖", async (t) => {
  const f = fixture(t);
  let knowing = f.realStore.getKnowing("p1");
  let writes = 0;
  const handle = createPersonalityHandler({ store: { getKnowing: () => structuredClone(knowing), saveKnowing() { writes++; } }, listPartners: async () => [{ id: "p1" }] });
  const p = await handle({ action: "preview", agentId: "p1", baseRevision: knowing.revision, patch: { colors: [{ id: "c1", name: "直率", role: "base" }] } });
  knowing.palette.colors[0].name = "较真";
  const r = await handle({ action: "apply", agentId: "p1", token: p.token, confirm: true });
  assert.equal(r.code, "revision-changed");
  assert.equal(writes, 0);
});

test("过期、重载、跨伙伴、缺确认或无预览都不写", async (t) => {
  const f = fixture(t);
  const p = await preview(f);
  assert.equal((await apply(f, p, { agentId: "p2" })).code, "preview-expired");
  assert.equal((await apply(f, p, { confirm: false })).code, "confirmation-required");
  const fresh = createPersonalityHandler({ store: f.store, listPartners: async () => [{ id: "p1" }] });
  assert.equal((await fresh({ action: "apply", agentId: "p1", token: p.token, confirm: true })).code, "preview-expired");
  f.advance(30 * 60_000);
  assert.equal((await apply(f, p)).code, "preview-expired");
  assert.equal(f.writes(), 0);
});

test("预览版本必填且禁止捎带写入字段", async (t) => {
  const f = fixture(t);
  assert.equal((await f.handle({ action: "preview", agentId: "p1", patch: { corpus: [] } })).code, "revision-changed");
  assert.equal((await f.handle({ action: "read", agentId: "p1", patch: {} })).code, "invalid-input");
  assert.equal((await apply(f, {}, { patch: { corpus: [] } })).code, "invalid-input");
});

for (const [label, patch] of [
  ["隐藏兴趣", { hobbies: [] }],
  ["采访", { recognition: {} }],
  ["路径", { path: "outside" }],
  ["超长色名", { colors: [{ name: "123456789", role: "base" }] }],
  ["超长行为", { derivatives: [{ colorId: "c1", text: "长".repeat(121) }] }],
  ["重复色名", { colors: [{ id: "a", name: "直率", role: "base" }, { id: "b", name: "直率", role: "main" }] }],
  ["重复编号", { colors: [{ id: "a", name: "直率", role: "base" }, { id: "a", name: "较真", role: "main" }] }],
  ["位置超额", { colors: [{ id: "a", name: "直率", role: "base" }, { id: "b", name: "较真", role: "base" }] }],
  ["悬空行为", { derivatives: [{ colorId: "missing", text: "一句行为" }] }],
  ["删色但留行为", { colors: [] }],
  ["全清空", { colors: [], derivatives: [], portrait: [] }],
  ["伪造证据", { colors: [{ id: "c1", name: "直率", role: "base", evidence: [999] }] }],
  ["冒充自动来源", { derivatives: [{ colorId: "c1", text: "一句行为", origin: "model" }] }],
  ["活行为被静默裁掉", { derivatives: Array.from({ length: 4 }, (_, i) => ({ colorId: "c1", text: `第${i}条行为` })) }],
  ["语料超行数", { corpus: [{ scene: "场景", lines: Array(6).fill("一句") }] }],
  ["语料超长", { corpus: [{ scene: "场景", lines: ["长".repeat(61)] }] }],
  ["空语料", { corpus: [{ scene: "场景", lines: [] }] }],
  ["多行文本", { portrait: [{ title: "标题", text: "一行\n二行" }] }],
]) test(`严格拒绝${label}，不靠归一化静默吞内容`, async (t) => {
  const f = fixture(t);
  const r = await preview(f, patch);
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid-input");
  assert.equal(f.writes(), 0);
});

test("无改动拒绝，未知伙伴及路径穿越不自动创建档案", async (t) => {
  const f = fixture(t);
  assert.equal((await preview(f, { corpus: [] })).code, "no-change");
  for (const agentId of ["../p1", "__proto__", "absent", ""]) {
    assert.equal((await f.handle({ action: "read", agentId })).ok, false);
  }
  assert.equal(f.writes(), 0);
});

test("写盘失败保留原token可重试，不泄露异常详情", async (t) => {
  const f = fixture(t);
  let broken = true;
  const save = f.store.saveKnowing;
  f.store.saveKnowing = (...args) => { if (broken) throw new Error("private-path-and-secret"); return save(...args); };
  const p = await preview(f);
  const failed = await apply(f, p);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /private-path-and-secret/);
  broken = false;
  assert.equal((await apply(f, p)).ok, true);
});

test("写入已完成但返回抛错，原token回查成功且不重复写", async (t) => {
  const f = fixture(t);
  const save = f.store.saveKnowing;
  f.store.saveKnowing = (...args) => { save(...args); throw new Error("reply-failed"); };
  const p = await preview(f);
  assert.equal((await apply(f, p)).ok, false);
  const retried = await apply(f, p);
  assert.equal(retried.ok, true);
  assert.equal(retried.alreadyApplied, true);
  assert.equal(f.writes(), 1);
});

test("后台关系等无关写盘推进版本后，原token仍能确认已保存而不重复写", async (t) => {
  const f = fixture(t);
  const p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  f.realStore.saveKnowing("p1", f.realStore.getKnowing("p1"));
  const r = await apply(f, p);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyApplied, true);
  assert.equal(f.writes(), 1);
});

test("色可按任意角色顺序提交，预览与落盘均按底主点顺序且不丢项", async (t) => {
  const f = fixture(t);
  const p = await preview(f, {
    colors: [{ id: "c3", name: "较劲", role: "accent" }, { id: "c1", name: "温润", role: "base" }, { id: "c2", name: "直率", role: "main" }],
    derivatives: [{ id: "d1", colorId: "c1", text: "难受时听一听。" }, { colorId: "c2", text: "不同意时讲理由。" }, { colorId: "c3", text: "被逗时回嘴。" }],
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.after.colors.map((row) => row.role), ["base", "main", "accent"]);
  const r = await apply(f, p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.palette, p.after);
});

test("旧档活行为超限及空壳色在只改颜色时也明确提示，不静默宣称全生效", async (t) => {
  const f = fixture(t);
  const knowing = f.realStore.getKnowing("p1");
  knowing.palette.derivatives = Array.from({ length: 4 }, (_, i) => ({ ...knowing.palette.derivatives[0], id: `d${i}`, text: `第${i}条行为` }));
  f.realStore.saveKnowing("p1", knowing);
  const p = await preview(f, { colors: [{ id: "c1", name: "直率", role: "base" }, { id: "c2", name: "较劲", role: "accent" }] });
  assert.equal(p.ok, true);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings.join(" "), /仅前3条/);
  assert.match(p.warnings.join(" "), /没有生效行为/);
  assert.doesNotMatch(p.effectiveText, /第3条行为/);
});

test("回读不一致不能报保存成功", async (t) => {
  const f = fixture(t);
  f.store.saveKnowing = () => {};
  const p = await preview(f);
  const r = await apply(f, p);
  assert.equal(r.ok, false);
  assert.equal(r.code, "verification-failed");
});

test("正式工具经过真实云构建剥离后保留，调试入口及外部备份能力仍剥掉", async (t) => {
  const configUrl = new URL("../.cloud-build/config.json", import.meta.url);
  if (!fs.existsSync(configUrl)) { t.skip("当前副本不含云构建源码，不能冒称已验证剥离"); return; }
  const { stripDevOnly } = await import("../.cloud-build/lib/strip.mjs");
  const config = JSON.parse(fs.readFileSync(configUrl, "utf8"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tea-personality-strip-"));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  for (const rel of [...config.devOnly.targets, "manifest.json"]) {
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(new URL(`../${rel}`, import.meta.url), to);
  }
  stripDevOnly(stage, config.devOnly);
  const src = fs.readFileSync(path.join(stage, "index.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
  assert.match(src, /registerPersonalityTool\(ctx, \{ store, listPartners \}\)/);
  assert.doesNotMatch(src, /chahuahui_thread_range_admin|chahuahui_tool_probe|DEV_TOOLS/);
  assert.ok(manifest.capabilities.includes("app/tools.expose-to-model"));
  assert.ok(!manifest.capabilities.includes("app/resources.write"));
});

test("工具注册无受保护读取；结构化错误正确标记", async () => {
  let tool;
  registerPersonalityTool({ tools: { register: (value) => { tool = value; } } }, { store: {}, listPartners: async () => [] });
  assert.equal(tool.name, "chahuahui_personality");
  const r = await tool.execute({ action: "read", agentId: "p1", context: { privateHostMetadata: "must-not-escape" } });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).code, "unknown-partner");
  assert.doesNotMatch(JSON.stringify(r), /must-not-escape|privateHostMetadata/);
  const extra = await tool.execute({ action: "read", agentId: "p1", hobbies: [] });
  assert.equal(JSON.parse(extra.content[0].text).code, "invalid-input");
});
