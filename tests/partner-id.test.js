/**
 * 伙伴 ID 的形状校验。
 *
 * 这道闸是补出来的。原因：外部传进来的 agentId 会拼进文件路径（读人格、读头像、
 * 写账本、拼目录名），以前只做字符替换、而且把 `.` 留了下来，所以 `..` 能爬到
 * 目标伙伴的目录外面去。现在收成 allowlist。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PARTNER_ID_RE, isValidPartnerId, safePartnerId } from "../lib/partner-id.js";

test("伙伴 ID：正常 id 一律放行", () => {
  for (const id of ["hanako", "carol2", "local_abc", "a-b-c", "A1", "A".repeat(64)]) {
    assert.equal(isValidPartnerId(id), true, id);
  }
  assert.equal(PARTNER_ID_RE.test("hanako"), true);
});

test("伙伴 ID：路径与怪字符一律挡掉", () => {
  const bad = ["", "   ", "..", ".", "../x", "..\\x", "a/b", "a\\b", "C:", "a b", "中文", "a".repeat(65), "a.b", null, undefined];
  for (const id of bad) {
    assert.equal(isValidPartnerId(id), false, JSON.stringify(id));
  }
});

test("safePartnerId：不合法一律返回空串，由调用方去拒", () => {
  assert.equal(safePartnerId("hanako"), "hanako");
  assert.equal(safePartnerId(".."), "");
  assert.equal(safePartnerId("../hanako"), "");
  assert.equal(safePartnerId(null), "");
});

test("loadPersona 碰到不合法 id 时压根不去读盘", async () => {
  const { loadPersona } = await import("../lib/persona.js");
  let touched = false;
  const ctx = {
    resources: {
      read: async () => {
        touched = true;
        return { content: "" };
      },
    },
  };
  const out = await loadPersona(ctx, { agentsRoot: "C:/fake/agents", agentId: "../.." });
  assert.equal(touched, false, "不合法 id 不该碰资源接口");
  assert.equal(out.errors.id, "invalid-agent-id");
  assert.deepEqual(out.files, {});
});

test("store：带 .. 的 id 不会被写到 partners 目录外面", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createStore } = await import("../lib/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-safeid-"));
  const store = createStore(dir);
  store.saveKnowing("..", { colors: [], derivatives: [], hobbies: {} });
  assert.ok(!fs.existsSync(path.join(dir, "v2", "knowing.json")), "不能爬到 v2 根目录");
  assert.ok(
    fs.existsSync(path.join(dir, "v2", "partners", "__", "knowing.json")),
    "落点被削成安全名字，留在 partners 里",
  );
});
