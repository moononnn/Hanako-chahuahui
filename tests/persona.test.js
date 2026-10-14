import test from "node:test";
import assert from "node:assert/strict";

import { extractDialectBlock, personaSeedText, renderPersona, readPersonaUsage, PERSONA_BUDGET } from "../lib/persona.js";

test("取料：identity 是正主，没有就往下退到自我介绍、对外那份、钉选", () => {
  assert.equal(personaSeedText({ identity: "我是 X" }).key, "identity");
  assert.equal(personaSeedText({ identity: "  ", description: "小介绍" }).key, "description");
  assert.equal(personaSeedText({ description: "", public: "公开自述" }).key, "public");
  assert.equal(personaSeedText({ public: null, pinned: "钉选" }).key, "pinned");
  assert.deepEqual(
    personaSeedText({ facts: "记忆", experience: "经验" }),
    { key: null, text: "" },
    "茶话会自己攒的 facts / experience 不算「这个人是谁」的料",
  );
  assert.deepEqual(personaSeedText(null), { key: null, text: "" });
});

test("方言口吻从 AGENTS.md 里单独捞，只取带标记那块，工作规则不跟着进来", () => {
  const raw = "# 人格定义\n- 涉及概念解释时必须全网搜索\n\n<!-- biaoqingbao-dialect:start -->\n你是四川人，打字带四川话味。\n<!-- biaoqingbao-dialect:end -->\n\n- 别的规则";
  const block = extractDialectBlock(raw);
  assert.match(block, /四川话味/);
  assert.doesNotMatch(block, /全网搜索|别的规则/, "工作规则不跟着进来");
  assert.equal(extractDialectBlock("没有标记"), null);
  assert.equal(extractDialectBlock(null), null);
});

test("对话用的参考段落：人格、说话口吻、钉选、记忆、经验；自我介绍与对外自述不进", () => {
  const text = renderPersona({
    files: {
      identity: "人格",
      dialect: "说话口吻",
      description: "介绍",
      public: "公开",
      pinned: "钉选",
      facts: "记忆",
      experience: "经验",
    },
  });
  assert.match(text, /【人格】/);
  assert.match(text, /【说话口吻】/);
  assert.match(text, /【钉选记忆】/);
  assert.match(text, /【记忆】/);
  assert.match(text, /【经验】/);
  assert.doesNotMatch(text, /介绍|公开/, "自我介绍和对外自述不往对话提示词里塞，只给性格初稿用");
});

test("没写过 identity 的伙伴：自我介绍兜底当「你是谁」，别让ta对自己一无所知", () => {
  // 小七这类只有 description.md 的伙伴，不兜底的话提示词里只剩一句“你是「小七」”，
  // ta对自己的认识薄得站不住，实机上能把别人的名字当成自己（2026-09-15）
  const text = renderPersona({
    files: { identity: null, description: "小七是阿舟的个人助手。", dialect: null, pinned: "钉选", facts: null, experience: null },
  });
  assert.match(text, /【你是谁】/);
  assert.match(text, /小七是阿舟的个人助手/);
  assert.match(text, /【钉选记忆】/);
});

test("两个都在时只留正主 identity，不重复渲染自我介绍", () => {
  const text = renderPersona({ files: { identity: "正主人格", description: "二手介绍" } });
  assert.match(text, /【人格】/);
  assert.doesNotMatch(text, /二手介绍/);
});

test("名字兜底：分享版里“只写了名字就装上”的伙伴也不能光着上场", () => {
  const bare = { files: { identity: null, description: null, dialect: null, pinned: "钉选", facts: null, experience: null } };
  assert.doesNotMatch(renderPersona(bare, { partnerName: "小七" }), /【你是谁】/, "不开开关时不插手");
  const text = renderPersona(bare, { partnerName: "小七", nameFallback: true });
  assert.match(text, /【你是谁】/);
  assert.match(text, /你就是「小七」/);
  assert.equal(renderPersona(bare, { nameFallback: true }), "【钉选记忆】\n钉选", "没名字就退了，不硬编");
});

test("模板占位符换成真名：{{agentName}} 没渲染过时不能拿空名字上场", () => {
  // 实机：小七的 AGENTS.public.md 整份就是 {{agentName}} / {{userName}} 未渲染的状态
  const text = renderPersona(
    { files: { identity: "你是{{agentName}}，{{userName}}的个人伙伴。" } },
    { partnerName: "小七", userName: "阿舟" },
  );
  assert.match(text, /你是小七，阿舟的个人伙伴/);
  assert.doesNotMatch(text, /\{\{/);
  const half = renderPersona({ files: { identity: "我是{{char}}" } }, { partnerName: "小七" });
  assert.match(half, /我是小七/);
});

/** 假 ctx：按相对路径回文件内容，读不到就报同一个错，跟真资源层一样。 */
function fakeCtx(files) {
  return {
    resources: {
      read: async ({ path: p }) => {
        const key = Object.keys(files).find((k) => p.endsWith(k.replace(/\\/g, "/")));
        if (!key) return { error: "not found" };
        return { content: files[key] };
      },
    },
  };
}

test("用量盘点：没超的照实报，超了的把砍掉多少和砍在哪儿一起报出来", async () => {
  const ctx = fakeCtx({
    "identity.md": "人".repeat(120),
    "AGENTS.md": `<!-- biaoqingbao-dialect:start -->${"话".repeat(30)}<!-- biaoqingbao-dialect:end -->`,
  });
  const usage = await readPersonaUsage(ctx, { agentsRoot: "/agents", agentId: "hanako" });
  const identity = usage.files.find((row) => row.key === "identity");
  assert.equal(identity.chars, 120);
  assert.equal(identity.budget, PERSONA_BUDGET.identity);
  assert.equal(identity.status, "ok");
  assert.equal(identity.dropped, 0);

  // 方言只算标记里那块，不拿整份 AGENTS.md 的长度吓人
  const dialect = usage.files.find((row) => row.key === "dialect");
  assert.equal(dialect.chars, 30);
  assert.equal(dialect.status, "ok");
});

test("用量盘点：超预算的那份标成 trimmed，并摘出被砍掉那段的开头", async () => {
  const limit = PERSONA_BUDGET.description;
  const head = "头".repeat(limit);
  const tail = "被砍掉的重点内容";
  const ctx = fakeCtx({ "description.md": head + tail });
  const usage = await readPersonaUsage(ctx, { agentsRoot: "/agents", agentId: "hanako" });
  const row = usage.files.find((item) => item.key === "description");
  assert.equal(row.status, "trimmed");
  assert.equal(row.dropped, tail.length);
  assert.equal(usage.trimmedCount, 1);
  assert.match(row.droppedHead, /^被砍掉的重点内容/);
});

test("用量盘点：没写的算空、读不到算读不到，不当成超了", async () => {
  const usage = await readPersonaUsage(fakeCtx({ "identity.md": "有人格" }), { agentsRoot: "/agents", agentId: "hanako" });
  const empty = usage.files.find((row) => row.key === "pinned");
  assert.equal(empty.status, "empty");
  assert.equal(empty.dropped, 0);
  // AGENTS.md 压根不存在时方言读不到，但其余照样盘得出来
  assert.equal(usage.files.length, 7);
  assert.equal(usage.files.filter((row) => row.status === "trimmed").length, 0);
});

test("用量盘点：编号不合法直接空盘，不去拼路径", async () => {
  const usage = await readPersonaUsage(fakeCtx({ "identity.md": "x" }), { agentsRoot: "/agents", agentId: "../etc" });
  assert.deepEqual(usage.files, []);
  assert.equal(usage.trimmedCount, 0);
});
