import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_BUDGET } from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");
const docPath = path.join(here, "..", "EXPERIMENT-daily-budget-20261028.md");

test("配比实验：四类配额都写在同一个常量块里，改一行就能改配比", () => {
  assert.equal(typeof LAB_BUDGET.enabled, "boolean");
  for (const key of ["video", "news", "interest"]) {
    assert.ok(Number.isInteger(LAB_BUDGET[key]) && LAB_BUDGET[key] >= 0, `${key} 应是非负整数`);
  }
  assert.equal(LAB_BUDGET.video < 5, true, "视频要比原配额 5 低，否则实验没有意义");
  assert.equal(LAB_BUDGET.news < 4, true, "新闻要比原配额 4 低");
  assert.equal(LAB_BUDGET.interest > 1, true, "兴趣要从原来的每天 1 条抬上去");
});

test("配比实验：视频与新闻的配额取用户设置和配比表里较小的那个", () => {
  assert.match(app, /function videoQuota\(now = new Date\(\)\) \{\s*const shared = videoShareLimit\(store\.getGlobalSettings\(\)\.videoShareMaxPerDay\);/,
    "视频配额先读用户设置");
  assert.match(app, /const limit = LAB_BUDGET\.enabled \? Math\.min\(shared, LAB_BUDGET\.video\) : shared;/,
    "实验开着才压上限，她自己调低照样生效");
  assert.match(app, /const shared = newsShareLimit\(store\.getGlobalSettings\(\)\.newsShareMaxPerDay\);/,
    "新闻配额同样以用户设置为准");
  assert.match(app, /const limit = LAB_BUDGET\.enabled \? Math\.min\(shared, LAB_BUDGET\.news\) : shared;/,
    "新闻的压法跟视频一致");
});

test("配比实验：关掉开关就回到原配比，不需要改别的行", () => {
  assert.match(app, /const OBSERVATION_MAX_PER_DAY = LAB_BUDGET\.enabled \? LAB_BUDGET\.interest : 1;/,
    "观察式上限跟着开关走，关掉回到 1");
  // 2026-10-29 来源交错接进来之后，种子优先先看交错指派，没指派时回到这个开关。
  assert.match(app, /const seedPriority = [\s\S]{0,320}?Boolean\(LAB_BUDGET\.enabled && LAB_BUDGET\.seedFirst\);/,
    "没有交错指派时，种子优先仍然挂在实验开关上");
  assert.match(app, /const seedFirst = Boolean\(seedPriority && seedCandidate && interestRoom\);/, "种子优先最后还要过当天的兴趣配额");
});

test("配比实验：种子真的占住那一轮时，新闻不再挤进来", () => {
  assert.match(app, /const candidateNews = followup\?\.read \|\| candidateVideo \|\| cappedSeed \|\| !newsQuota\(now\)/,
    "一类素材只带一份；用闸后的 cappedSeed，观察式发满时新闻不被一个上不了的候选挤掉");
});

test("配比实验：回滚文档写清了三步，不许只留下代码", (t) => {
  // 回滚文档是本机实验记录，不进发布包。副本测试里没有这份文档，就如实跳过这一条，
  // 不能假装读过；源码树里它在，这条照常跑。
  if (!fs.existsSync(docPath)) {
    t.skip("发布副本不带本机实验文档（EXPERIMENT-*.md 不进包），这条按发布形态跳过");
    return;
  }
  const doc = fs.readFileSync(docPath, "utf8");
  assert.match(doc, /## 怎么回滚/, "文档必须有回滚段");
  assert.match(doc, /改成 `false`/, "最快的回滚是改一行开关");
  assert.match(doc, /before\\/, "文档要指向改动前的备份目录");
});
