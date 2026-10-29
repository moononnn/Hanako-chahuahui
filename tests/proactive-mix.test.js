import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIX_GROUPS,
  MIX_WINDOW,
  groupsFromMessages,
  nonRelationalStreak,
  normalizeMixGroup,
  noteSentSource,
  planSourceMix,
  readSourceBook,
  recentMixGroups,
  sourceGroupOf,
} from "../lib/proactive-mix.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");
const { PROACTIVE_MIX } = await import("../index.js");

// 交错这条线要治的是「连着几条都是同一类来源」：素材、种子、关系式轮着上。
// 账上只记内容轮，机动（待办、睡前收尾、跟进、节日天气）不参与。

test("交错：没有发送记录时照旧排队，不额外指定来源", () => {
  assert.equal(planSourceMix({ recent: [], material: true, interest: true }), null);
});

test("交错：上一轮是素材，这一轮先给种子", () => {
  const plan = planSourceMix({ recent: ["material"], material: true, interest: true });
  assert.equal(plan?.prefer, "interest");
  assert.equal(nonRelationalStreak(["material"]), 1, "只发过一轮素材，还没到该让关系式的时候");
});

test("交错：上一轮是种子，这一轮先给素材", () => {
  const plan = planSourceMix({ recent: ["interest"], material: true, interest: true });
  assert.equal(plan?.prefer, "material");
});

test("交错：连着两轮素材或种子，这一轮让给关系式", () => {
  assert.equal(planSourceMix({ recent: ["material", "material"], material: true, interest: true })?.prefer, "relational");
  // 素材和种子交替着发也算连着：那一头始终没开口。
  assert.equal(planSourceMix({ recent: ["material", "interest"], material: true, interest: true })?.prefer, "relational");
  assert.equal(planSourceMix({ recent: ["interest", "material"], material: true, interest: true })?.prefer, "relational");
});

test("交错：刚发过关系式，回到原来的排队", () => {
  assert.equal(planSourceMix({ recent: ["relational", "interest", "material"], material: true, interest: true }), null);
});

test("交错：另一头没货时，宁可让关系式试一轮，也不连着发同一类", () => {
  assert.equal(planSourceMix({ recent: ["material"], material: true, interest: false })?.prefer, "relational");
  assert.equal(planSourceMix({ recent: ["interest"], material: false, interest: true })?.prefer, "relational");
  // 两头都没货就没有可挑的，交回原来的排队（那一轮会被待办、跟进或招呼占掉）。
  assert.equal(planSourceMix({ recent: ["material"], material: false, interest: false })?.prefer, "relational");
});

test("交错账：新的在前，只留最近几轮，认不出来的行丢掉", () => {
  let book = [];
  for (const group of ["material", "interest", "relational", "material"]) {
    book = noteSentSource(book, group, new Date(2026, 9, 29, 9, book.length));
  }
  assert.deepEqual(recentMixGroups(book), ["material", "relational", "interest", "material"]);
  assert.equal(book.length, 4);
  assert.equal(book.at(-1).group, "material", "账面按发送顺序存，新的在尾部");

  const dirty = readSourceBook([
    { group: "material", at: "2026-10-29T01:00:00.000Z" },
    { group: "没这一类", at: "2026-10-29T02:00:00.000Z" },
    { group: "interest" },
    { group: "relational", at: "看不懂的时间" },
  ]);
  assert.deepEqual(dirty.map((row) => row.group), ["material"]);

  let full = [];
  for (let i = 0; i < MIX_WINDOW + 4; i += 1) {
    full = noteSentSource(full, MIX_GROUPS[i % MIX_GROUPS.length], new Date(Date.UTC(2026, 9, 29, 0, i)));
  }
  assert.equal(full.length, MIX_WINDOW, "只留最近几轮");
  assert.equal(noteSentSource(book, "没这一类").length, 4, "认不出来的类目不记账");
});

test("交错账：连着一类记几次就记几次，不合并", () => {
  let book = [];
  for (let i = 0; i < 3; i += 1) book = noteSentSource(book, "interest", new Date(Date.UTC(2026, 9, 29, 1, i)));
  assert.deepEqual(recentMixGroups(book), ["interest", "interest", "interest"]);
  assert.equal(nonRelationalStreak(recentMixGroups(book)), 3);
  assert.equal(planSourceMix({ recent: recentMixGroups(book), material: true, interest: true })?.prefer, "relational");
});

test("来源归类：素材、种子、关系式分得清，机动不记账", () => {
  assert.equal(sourceGroupOf({ video: { id: "BV1" } }), "material");
  assert.equal(sourceGroupOf({ news: { id: "n1" } }), "material");
  assert.equal(sourceGroupOf({ seed: { id: "seed_1" } }), "interest");
  assert.equal(sourceGroupOf({ discovery: { id: "d1" } }), "interest");
  assert.equal(sourceGroupOf({ reason: { kind: "affection" } }), "relational");
  assert.equal(sourceGroupOf({ reason: { kind: "interest" } }), "interest");
  assert.equal(sourceGroupOf({ reason: { kind: "weather" }, routine: true }), null);
  assert.equal(sourceGroupOf({ video: { id: "BV1" }, routine: true }), null, "机动占着的那一轮不算素材轮");
  assert.equal(sourceGroupOf({}), null);
});

test("来源归类：认不出的类目一律当没有", () => {
  assert.equal(normalizeMixGroup("material"), "material");
  assert.equal(normalizeMixGroup("Material"), null);
  assert.equal(normalizeMixGroup(""), null);
});

test("兜底：交错账还空的时候，从聊天账读出最近几轮内容类目", () => {
  const messages = [
    { role: "assistant", proactive: true, videoId: "BV1" },
    { role: "assistant", proactive: true, seedId: "seed_1" },
    { role: "assistant", proactive: true, proactiveKind: "proactive", proactiveContext: { kind: "read-followup" } },
    { role: "assistant", proactive: true, proactiveContext: { kind: "reason", reason: { kind: "affection" } } },
    { role: "assistant", proactive: true, proactiveKind: "farewell" },
    { role: "user", text: "嗯" },
  ];
  // 新的在前；跟进、睡前收尾、用户那几句话都不算内容轮。
  assert.deepEqual(groupsFromMessages(messages), ["relational", "interest", "material"]);
  assert.deepEqual(groupsFromMessages(messages, { limit: 2 }), ["relational", "interest"]);
  assert.deepEqual(groupsFromMessages([]), []);
});

test("接线：交错决定要压在种子优先之前，关系式那一档要确认有由头才让", () => {
  assert.equal(typeof PROACTIVE_MIX, "boolean", "交错得有一个能一行关掉的开关");
  assert.match(app, /const mixPlan = !PROACTIVE_MIX \? null : planSourceMix\(\{/, "开关关掉就不算交错，回到原来的排队");
  const planAt = app.indexOf("planSourceMix({\n        // 交错账还是空的时候拿聊天账兜底");
  const seedAt = app.indexOf("const seedPriority = mixPlan?.prefer === \"interest\"");
  const seedFirstAt = app.indexOf("const seedFirst = Boolean(seedPriority && seedCandidate && interestRoom);");
  assert.ok(planAt > 0 && seedAt > planAt && seedFirstAt > seedAt, "先算交错，再决定种子优不优先");

  assert.match(app, /const candidateSeed = !seedCandidate\s*\? null\s*: mixPlan\?\.prefer === "material"\s*\? null/,
    "这一轮定的是素材时，种子整份让开，新闻才有落点");

  assert.match(app, /if \(mixPlan\?\.prefer === "relational"\) \{[\s\S]{0,900}?if \(!mixBlocked && mixProbe\?\.reason\) \{[\s\S]{0,200}?video = null/,
    "轮到关系式时，先把素材和种子让出来");
  assert.match(app, /interestAvailable: false,\s*hasContext: Boolean\(sceneEcho\) \|\| workActivity\.active === true,/,
    "探针要跟 pickReason 用同一组输入，只是不把兴趣算进来");

  assert.match(app, /mixPlan\?\.prefer === "interest" && \(seed \|\| discovery\)\s*\? \{ reason: \{ kind: "interest" \}/,
    "定的是兴趣时直接钉住由头，别让关系式抢走再吞掉种子");

  assert.match(app, /proactiveSources: noteSentSource\(store\.getProactiveState\(agentId\)\.proactiveSources, sentGroup, sent\.sentAt\)/,
    "发出去之后才记账");
  assert.match(app, /routine: Boolean\(publicEvent \|\| todoHere \|\| farewellSend \|\| wakeEcho \|\| followup \|\| greetingOnly \|\| videoLoginNotice\)/,
    "机动不参与交错");
});
