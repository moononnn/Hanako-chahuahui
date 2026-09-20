/**
 * 伙伴 ID 的形状校验。
 *
 * 这道闸是补出来的。原因：外部传进来的 agentId 会拼进文件路径（读人格、读头像、
 * 写账本、拼目录名），以前只做字符替换、而且把 `.` 留了下来，所以 `..` 能爬到
 * 目标伙伴的目录外面去。现在收成 allowlist。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PARTNER_ID_RE, isValidPartnerId, requirePartnerId, safePartnerId } from "../lib/partner-id.js";

test("伙伴 ID：正常 id 一律放行", () => {
  for (const id of ["hanako", "carol2", "local_abc", "a-b-c", "A1", "A".repeat(64)]) {
    assert.equal(isValidPartnerId(id), true, id);
  }
  assert.equal(PARTNER_ID_RE.test("hanako"), true);
});

test("伙伴 ID：路径与怪字符一律挡掉", () => {
  const bad = ["", "   ", "..", ".", "../x", "..\\x", "a/b", "a\\b", "C:", "a b", "中文", "a".repeat(65), "a.b", "__proto__", "constructor", "prototype", null, undefined];
  for (const id of bad) {
    assert.equal(isValidPartnerId(id), false, JSON.stringify(id));
  }
});

test("伙伴 ID：文件系统边界必须抛错，不能把非法值改名", () => {
  assert.equal(requirePartnerId("hanako"), "hanako");
  for (const id of ["a/b", "a_b/", "__proto__", "..", null]) {
    assert.throws(() => requirePartnerId(id), { code: "INVALID_PARTNER_ID" });
  }
  assert.equal(safePartnerId("hanako"), "hanako");
  assert.equal(safePartnerId(".."), "");
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

test("store：非法 id 直接拒绝，不会与合法 id 共用账本", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createStore } = await import("../lib/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-safeid-"));
  const store = createStore(dir);
  assert.throws(() => store.saveKnowing("..", { colors: [], derivatives: [], hobbies: {} }), { code: "INVALID_PARTNER_ID" });
  assert.throws(() => store.saveKnowing("a/b", { colors: [], derivatives: [], hobbies: {} }), { code: "INVALID_PARTNER_ID" });
  assert.ok(!fs.existsSync(path.join(dir, "v2", "partners", "a_b", "knowing.json")), "非法 id 不能撞进合法目录");
});
