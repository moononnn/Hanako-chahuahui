import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

const sayAt = source.indexOf('app.post("/co-create/:agentId/say"');
const commitAt = source.indexOf('app.post("/co-create/:agentId/commit"');
const dropAt = source.indexOf('app.post("/co-create/:agentId/drop"');

test("对谈捏人的入口都在", () => {
  assert.match(source, /app\.get\("\/co-create\/:agentId"/);
  assert.match(source, /app\.post\("\/co-create\/:agentId\/open"/);
  assert.ok(sayAt > 0);
  assert.ok(commitAt > sayAt);
  assert.ok(dropAt > commitAt);
});

test("伙伴级路由白名单认得 co-create，不会漏掉 agentId 校验", () => {
  assert.match(source, /recognition\|persona-review\|adaptation\|co-create\)/);
});

test("协商期不落画像：只有「成型」那条路写 palette", () => {
  const commit = source.slice(commitAt, dropAt);
  assert.match(commit, /commitChange\(/);
  assert.match(commit, /store\.saveKnowing\(/);
  assert.match(commit, /store\.clearCoCreateSession\(/);
  // 写之前先存旧版，退得回来
  assert.match(commit, /commitChange\(knowing, \{ \.\.\.knowing, palette \}/);

  // 说一句这条路一个字都不许写 knowing
  const say = source.slice(sayAt, commitAt);
  assert.doesNotMatch(say, /saveKnowing/);
  assert.doesNotMatch(say, /commitChange/);
});

test("一轮读不出来时不动手上那份草稿", () => {
  const say = source.slice(sayAt, commitAt);
  assert.match(say, /turn\.draft \? mergeDraft\(withSay\.draft, turn\.draft\) : withSay\.draft/);
  assert.match(say, /store\.saveCoCreateSession\(agentId, next\)/);
});

test("对谈的模型调用给了宽输出预算", () => {
  // 要交整份草稿，额度给窄了会被思考模型吃光、正文空着回来
  assert.match(source, /askRecognition\(spec\.systemPrompt, spec\.userText, 2400\)/);
});

test("过期的会话当没开过，不假装还能接着聊", () => {
  assert.match(source, /const readCoCreate = \(agentId\) => \{[\s\S]*?coCreateExpired\(session\)[\s\S]*?return null;/);
  assert.match(source, /code: "session-gone"/);
});
