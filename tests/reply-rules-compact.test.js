import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSystemPrompt, replyChoiceBlock, buildTeaseText, CHAT_HOUSE_STYLE } from "../lib/prompt.js";
import { bootChahuahui } from "./helpers/app-harness.js";

// 只验提示词保真、长度、试点接线和匿名验收题；假模型不能证明真实语义表现。
const input = {
  partnerName: "小花", userName: "阿舟",
  replyText: replyChoiceBlock({ userName: "阿舟" }),
  teaseText: buildTeaseText({ stage: 1 }),
};
const legacy = () => buildSystemPrompt(input);
const compact = (extra = {}) => buildSystemPrompt({ ...input, ruleProfile: "compact-v1", ...extra });

test("精简试点明确区分证据不足和讨好式认错，不禁止诚实的不确定", () => {
  assert.match(compact(), /只在记录本身确实缺失、无法核对时直说不确定/);
  assert.match(compact(), /‘我认’‘算我的’‘对不起呀’/);
  assert.match(compact(), /‘可能是我不对’/);
  assert.match(compact(), /先分清错没错，再决定要不要改/);
  assert.match(compact(), /温柔不等于顺从/);
  assert.match(compact(), /已确认事实.*道歉/);
  assert.match(compact(), /一半.*分开/);
  assert.match(compact(), /顶回去.*目的/);
});

test("精简试点保留喜好自主性、真实纠错和克制性格", () => {
  assert.match(compact(), /不懂.*不喜欢/);
  assert.match(compact(), /确有事实错误仍要改正/);
  assert.match(compact(), /不强迫对方也喜欢/);
  assert.match(compact(), /克制.*简短/);
  assert.match(compact(), /多解释.*少提.*顶回去/);
  assert.match(compact(), /用白话补上好玩在哪/);
});

test("出处边界集中到查证块，接梗不自证，追问不能编造", () => {
  const prompt = compact();
  assert.match(prompt, /不能编来源、经历或已查证的结论/);
  assert.match(prompt, /没被追问.*不.*免责声明/);
  assert.match(prompt, /确实查过.*没查到/);
  assert.match(prompt, /查询计划.*联网通道/);
  assert.match(prompt, /不让.*换说法.*催/);
});

test("互损保留许可与边界，不能改回等对方先开火", () => {
  assert.match(compact(), /不用先掂量/);
  assert.match(compact(), /损的是那件事，不是她这个人/);
  assert.match(compact(), /别忍着装大度/);
  assert.match(compact(), /认真或难受.*收住/);
  assert.match(compact(), /她划的线/);
  assert.match(compact(), /不.*硬演/);
  assert.doesNotMatch(compact(), /等她先开火|只有她先骂/);
});

test("来源未齐的聊天风格、解释纪律、回应出口与关系档位不删改", () => {
  const prompt = compact();
  assert.ok(prompt.startsWith(CHAT_HOUSE_STYLE));
  assert.ok(prompt.includes(input.replyText));
  assert.ok(prompt.includes(input.teaseText));
  assert.match(prompt, /先回看原句和上下文/);
  assert.match(prompt, /明确标成推测/);
  assert.match(prompt, /不替自己补一个确定动机/);
  assert.match(prompt, /不能自行拼成叫醒你的因果/);
});

test("人格、记忆和全部动态块原文不裁剪，规则始终先于人格参考", () => {
  const fields = ["personaText", "memoryText", "knowingText", "adaptationText", "stickerText", "wakeText", "passText", "timeText", "daybookText", "todoDoneText", "workfeedText", "searchText", "discoveryText", "userRhythmText", "stanceText", "note"];
  const extra = Object.fromEntries(fields.map((key) => [key, `证据-${key}-${"资料".repeat(30)}`]));
  const prompt = compact(extra);
  for (const field of fields) assert.ok(prompt.includes(extra[field]), `${field} 不得被精简裁剪`);
  assert.ok(prompt.indexOf("温柔不等于顺从") < prompt.indexOf(extra.personaText));
});

test("固定规则明显减量，默认与未知档位仍走旧版", () => {
  assert.ok(compact().length <= legacy().length * 0.9, "固定规则至少缩短一成，不能只换标题");
  assert.equal(buildSystemPrompt({ ...input, ruleProfile: "legacy" }), legacy());
  assert.equal(buildSystemPrompt({ ...input, ruleProfile: "unknown" }), legacy());
});

test("本地试点只在普通回复接入，发布剥离后无默认试点伙伴", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /let compactReplyPilotId = ""/);
  assert.match(source, /ruleProfile: agentId === compactReplyPilotId \? "compact-v1" : "legacy"/);
  const start = source.indexOf("async function composeReply(");
  const end = source.indexOf("async function", start + 30);
  assert.ok(source.slice(start, end > start ? end : undefined).includes("compactReplyPilotId"));
  const stripped = source.replace(/^[ \t]*\/\/ __CHAHUAHUI_DEV_ONLY__[\s\S]*?^[ \t]*\/\/ __CHAHUAHUI_DEV_ONLY_END__[^\r\n]*/gm, "");
  assert.doesNotMatch(stripped, /compactReplyPilotId = "[^"]+"/);
  assert.match(stripped, /let compactReplyPilotId = ""/);
});

test("公开源码即使只关闭DEV_TOOLS、不剥整块，也不能启用本地试点", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  // 发布副本已整块剥掉哨兵，哨兵标记不存在，本用例验的“只关开关不剥块”源码形态不成立；
  // 副本形态该验的是剥块后 pilot 为空，上面那条已经验了。这里如实跳过，不假装通过。
  if (!source.includes("// __CHAHUAHUI_DEV_ONLY_END__")) return;
  const start = source.indexOf('let compactReplyPilotId = ""');
  // 只执行本用例要验证的开关与试点赋值；后面的本机ESM钩子含import.meta/顶层await，不能交给Function。
  const hooks = source.indexOf("\nlet localDevHooks =", start);
  const end = hooks >= 0 ? hooks : source.indexOf("// __CHAHUAHUI_DEV_ONLY_END__", start);
  const block = source.slice(start, end);
  const enabled = block.replace(/const DEV_TOOLS = (?:true|false)/, "const DEV_TOOLS = true");
  assert.equal(new Function(`${enabled}\nreturn compactReplyPilotId;`)(), "hanako");
  assert.equal(new Function(`${enabled.replace("const DEV_TOOLS = true", "const DEV_TOOLS = false")}\nreturn compactReplyPilotId;`)(), "");
});

test("十个匿名验收题结构有效，历史改编与构造材料区分清楚", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./reply-rule-cases.json", import.meta.url), "utf8"));
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.notice, /searchText 均为构造材料/);
  assert.ok(fixture.cases.length >= 10);
  assert.equal(new Set(fixture.cases.map((row) => row.id)).size, fixture.cases.length);
  for (const row of fixture.cases) {
    assert.ok(["history-adapted", "log-adapted", "synthetic-control"].includes(row.evidence));
    assert.ok(row.expect.length > 0 && row.preserve.length > 0);
    assert.ok(row.messages.length > 0 && row.messages.at(-1).role === "user");
    assert.ok(row.messages.every((message) => ["user", "assistant"].includes(message.role) && message.text));
    assert.ok(row.origin);
  }
  assert.equal(fixture.cases.find((row) => row.id === "search-result").evidence, "log-adapted");
});

for (const id of ["hanako", "nova"]) {
  test(`真实apply的假宿主接线：${id === "hanako" ? "本地试点" : "非试点"}不串范围、不加模型请求`, async () => {
    const app = await bootChahuahui({ seed(store, ctx) {
      store.setGlobalSettings({ proactiveEnabled: false });
      store.setPartnerSettings(id, {
        phone: { holding: true, untilMs: Date.now() + 3600000 },
        rhythm: { readMinMs: 1, readMaxMs: 2, typingMinMs: 1, gapMinMs: 1, speed: 1 },
        voice: { enabled: false },
      });
      const partner = { id, name: "小花", description: "测试伙伴" };
      ctx.bus.request = async (type) => type === "agent:list" ? { agents: [partner] } : type === "agent:profile" ? { agent: partner } : {};
    } });
    try {
      const sent = await app.request("POST", "/turns", { json: { agentId: id, watching: true, text: "你刚才那句话是什么意思", clientMessageId: `compact_${id}_00001` } });
      assert.equal(sent.status, 200);
      const call = await app.models.waitForCall(0);
      const localPilotEnabled = /const DEV_TOOLS = true/.test(fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
      assert.equal(call.request.systemPrompt.includes("只在记录本身确实缺失、无法核对时直说不确定"), id === "hanako" && localPilotEnabled);
      assert.match(call.request.systemPrompt, /先回看原句和上下文/);
      app.models.release(0, "我说的是刚才那个例子");
      const until = Date.now() + 5000;
      let done;
      do {
        done = await app.request("GET", `/turns/${sent.body.turnId}`);
        if (done.body.status === "ready") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < until);
      assert.ok(done.body.replyMessageId);
      assert.equal(app.models.calls.length, 1);
      assert.equal(app.net.calls.length, 0);
    } finally {
      for (let i = 0; i < app.models.calls.length; i += 1) app.models.release(i, "测试结束");
      fs.rmSync(app.dataDir, { recursive: true, force: true });
    }
  });
}
