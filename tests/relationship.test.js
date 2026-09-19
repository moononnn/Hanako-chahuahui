/**
 * 关系账本的纯逻辑测试：只喂时间和文本，不碰文件、不碰模型。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceRelationship,
  classifySignals,
  closeSeed,
  createRelationship,
  describeStage,
  disclosureRatio,
  getStage,
  materialSize,
  mergeRelationship,
  normalizeRelationship,
  normalizeSeed,
  relationshipNote,
  seedByPick,
  seedFromTrace,
  SEED_PICK_TIERS,
  stageLabel,
  traceSizeFromFiles,
  zeroSeed,
} from "../lib/relationship.js";

/** 本地时间造点，避免时区把日子挪走 */
const localTime = (y, m, d, h = 10, min = 0) => new Date(y, m - 1, d, h, min, 0);

test("新建的账本是空的", () => {
  const rel = createRelationship(localTime(2026, 9, 12));
  assert.equal(rel.familiarity.turns, 0);
  assert.equal(rel.familiarity.activeDays, 0);
  assert.equal(rel.intimacy.score, 0);
  assert.deepEqual(rel.events, []);
  assert.equal(rel.stage, 0);
});

test("闲聊不算信号，但回合数要算上", () => {
  const { relationship, signals } = advanceRelationship(createRelationship(), {
    text: "今天天气还挺好的",
    now: localTime(2026, 9, 12, 10),
  });
  assert.deepEqual(signals, []);
  assert.equal(relationship.familiarity.turns, 1);
  assert.equal(relationship.familiarity.activeDays, 1);
  assert.equal(relationship.intimacy.score, 0);
});

test("认得出有分量的那几类话，也不乱认", () => {
  assert.deepEqual(classifySignals("谢谢你").map((s) => s.type), ["appreciation"]);
  assert.deepEqual(classifySignals("我最近有点累").map((s) => s.type), ["self-disclosure"]);
  assert.deepEqual(classifySignals("你觉得呢").map((s) => s.type), ["curiosity"]);
  assert.deepEqual(classifySignals("对不起").map((s) => s.type), ["repair"]);
  assert.deepEqual(classifySignals("嗯嗯好的"), []);
  assert.deepEqual(classifySignals(""), []);
});

test("自然亲近和日常陪伴也能被认出来，但分量不同", () => {
  assert.deepEqual(classifySignals("想你了，晚安，抱抱").map((s) => s.type), ["affection"]);
  assert.deepEqual(classifySignals("今天吃了涮鱼").map((s) => s.type), ["self-disclosure", "daily-sharing"]);
  assert.deepEqual(classifySignals("这个想法很乖，夸夸小花").map((s) => s.type), ["appreciation", "affection"]);
});

test("表情包标签能参与亲密度判断", () => {
  const result = advanceRelationship(createRelationship(), {
    text: "[表情]",
    stickerText: "撒娇、得意、求夸奖、卖萌",
    now: localTime(2026, 9, 12, 10),
  });
  assert.deepEqual(result.signals.map((s) => s.type), ["appreciation", "affection"]);
  assert.equal(result.relationship.intimacy.score, 4);
});

test("一天最多涨四分，同类信号一天只算一次", () => {
  const day = localTime(2026, 9, 12, 10);
  const first = advanceRelationship(createRelationship(day), {
    text: "谢谢你，我最近有点累，你觉得我该怎么办",
    now: day,
  });
  // 道谢 2 + 分享 2 刚好把当天额度用掉，问ta那条被挡在外面
  assert.equal(first.relationship.intimacy.score, 4);
  assert.equal(first.relationship.intimacy.daily.types.length, 2);

  const again = advanceRelationship(first.relationship, {
    text: "谢谢你",
    now: localTime(2026, 9, 12, 20),
  });
  assert.deepEqual(again.signals, []);
  assert.equal(again.relationship.intimacy.score, 4);
});

test("跨过一天，额度重算，活跃天加一", () => {
  const day1 = localTime(2026, 9, 12, 10);
  const day2 = localTime(2026, 9, 13, 10);
  const first = advanceRelationship(createRelationship(day1), { text: "谢谢你", now: day1 });
  const second = advanceRelationship(first.relationship, { text: "谢谢你", now: day2 });
  assert.equal(second.relationship.familiarity.activeDays, 2);
  assert.equal(second.relationship.intimacy.score, 4);
  assert.equal(second.relationship.intimacy.signalDays, 2);
});

test("凌晨四点前算前一天，通宵不劈成两天", () => {
  const late = localTime(2026, 9, 13, 3, 30);
  const { relationship } = advanceRelationship(createRelationship(), { text: "在吗", now: late });
  assert.equal(relationship.familiarity.lastActiveDay, "2026-09-12");
});

test("单日猛聊跨不过台阶，得跨日加证据", () => {
  let rel = createRelationship();
  const day = localTime(2026, 9, 12, 10);
  for (let i = 0; i < 20; i += 1) {
    rel = advanceRelationship(rel, {
      text: "谢谢你",
      now: new Date(day.getTime() + i * 60000),
    }).relationship;
  }
  assert.equal(rel.familiarity.turns, 20);
  assert.equal(rel.familiarity.activeDays, 1);
  // 同一种信号一天只算一次，二十句「谢谢你」也还是 2 分
  assert.equal(rel.intimacy.score, 2);
  assert.equal(getStage(rel), 0);
  assert.equal(stageLabel(0), "初识");
});

test("跨够日子、攒够证据才升到逐渐熟悉，升级那一步会标出来", () => {
  let rel = createRelationship();
  let crossed = false;
  for (let d = 0; d < 5; d += 1) {
    for (let t = 0; t < 2; t += 1) {
      const step = advanceRelationship(rel, {
        text: t === 0 ? "谢谢你" : "我最近在忙插件",
        now: localTime(2026, 9, 12 + d, 10 + t),
      });
      rel = step.relationship;
      if (step.stageChanged) crossed = true;
    }
  }
  assert.equal(rel.familiarity.activeDays, 5);
  assert.equal(rel.familiarity.turns, 10);
  assert.equal(rel.intimacy.score, 20);
  assert.equal(rel.intimacy.signalDays, 5);
  assert.equal(getStage(rel), 1);
  assert.equal(stageLabel(1), "逐渐熟悉");
  assert.equal(crossed, true);
});

test("分数封顶，涨到头就不再涨", () => {
  let rel = createRelationship();
  for (let d = 0; d < 40; d += 1) {
    rel = advanceRelationship(rel, {
      text: "谢谢你，我最近挺好的",
      now: localTime(2026, 9, 1 + d, 10),
    }).relationship;
  }
  assert.equal(rel.intimacy.score, 100);
  assert.equal(getStage(rel), 2);
  assert.equal(stageLabel(2), "亲近");
});

test("盘上读到坏数据也不炸，收成能用的账", () => {
  const rel = normalizeRelationship({ familiarity: "坏的", intimacy: null, events: "x" });
  assert.equal(rel.familiarity.turns, 0);
  assert.equal(rel.intimacy.score, 0);
  assert.deepEqual(rel.events, []);
  assert.equal(normalizeRelationship(null).stage, 0);
  assert.equal(normalizeRelationship(undefined).familiarity.activeDays, 0);
});

test("给模型看的是人话，不带分数", () => {
  assert.match(describeStage(0), /认识彼此/);
  assert.match(describeStage(1), /慢慢熟悉/);
  assert.match(describeStage(2), /亲近/);
  assert.doesNotMatch(describeStage(1), /\d/);
});

// ── 披露系数：跟 stage 不同，是一条一直往上爬的坡 ──

const ratioOf = (turns, activeDays, score) => disclosureRatio({
  familiarity: { turns, activeDays },
  intimacy: { score },
});

test("披露系数：什么都没发生就是零，两轨都满了就到头", () => {
  assert.equal(ratioOf(0, 0, 0), 0);
  assert.equal(disclosureRatio(null), 0);
  assert.equal(disclosureRatio({}), 0);
  assert.ok(ratioOf(200, 120, 100) > 0.99);
  assert.ok(ratioOf(200, 120, 100) <= 1);
});

test("披露系数是单调的：多聊一天、多攒一分，都不会往下掉", () => {
  const base = ratioOf(10, 6, 14);
  assert.ok(ratioOf(11, 6, 14) > base);
  assert.ok(ratioOf(10, 7, 14) > base);
  assert.ok(ratioOf(10, 6, 15) > base);
});

test("披露系数按坡走，不是台阶：中间有大量不同的值", () => {
  const seen = new Set();
  for (let turns = 0; turns <= 60; turns += 2) seen.add(ratioOf(turns, turns / 2, turns).toFixed(3));
  assert.ok(seen.size > 20, `坡上应该有很多不同的位置，实际只有 ${seen.size} 个`);
});

test("老台阶的两个门槛，在坡上大致落在同一位置附近", () => {
  // stage 1 的账：跨 5 天、8 回合、12 分上下
  const atStage1 = ratioOf(8, 5, 14);
  assert.ok(atStage1 > 0.25, `stage1 附近应该过里层门槛，实际 ${atStage1}`);
  // stage 2 的账：跨 14 天、20 回合、35 分
  const atStage2 = ratioOf(22, 15, 37);
  assert.ok(atStage2 > 0.7, `stage2 附近应该过爱好门槛，实际 ${atStage2}`);
  assert.ok(atStage2 < 0.95);
});

test("每天聊一点比堆在同一天更算数（跨日是灵魂）", () => {
  const spread = ratioOf(12, 12, 20);
  const crammed = ratioOf(12, 1, 20);
  assert.ok(spread > crammed);
});

test("起跑线：只量痕迹的份量，只抬相处史，亲近度一个字不动", () => {
  // 被截断过的材料，认尾巴上那句「原文 N 字」（人格与记忆那边就是这么截的）
  assert.equal(materialSize("abc\n…（后略，原文 22983 字）"), 22983);
  assert.equal(materialSize("abc"), 3);
  assert.equal(materialSize(null), 0);
  assert.equal(
    traceSizeFromFiles({ identity: "x".repeat(9999), pinned: "a".repeat(9000), facts: "", experience: null }),
    9000,
    "人格设定不算——那是她配的，不是相处出来的",
  );

  // 分档：痕量太少就不给起点
  assert.equal(seedFromTrace(399), null);
  assert.equal(seedFromTrace(400).turns, 12);
  assert.equal(seedFromTrace(2000).label, "聊过一阵");
  assert.equal(seedFromTrace(9000).turns, 80);
  assert.equal(seedFromTrace(999999).turns, 80, "再厚也就最高那档");
  assert.equal(seedFromTrace(9000).source, "auto");
  assert.equal(seedFromTrace(9000).pick, "auto", "自动那份自己说明白是自动量的");
  assert.equal(closeSeed(9000).source, "manual", "「很熟」那份要说清是她说很熟的");
  assert.equal(closeSeed(9000).pick, "close");
  assert.equal(closeSeed(9000).turns, 80, "「很熟」就是最高那档");
});

test("起跑线：她自己锁一档，跟自动那三档同一套名字", () => {
  assert.equal(seedByPick("chatty").turns, 40);
  assert.equal(seedByPick("chatty").label, seedFromTrace(2000).label, "锁的和自动量的同一档要同一个词");
  assert.equal(seedByPick("starting").activeDays, 4);
  assert.equal(seedByPick("chatty").source, "manual");
  assert.equal(seedByPick("chatty").pick, "chatty");
  assert.equal(seedByPick("根本没这档"), null, "不认识的档不硬造");
  assert.deepEqual(
    SEED_PICK_TIERS.map((row) => row.id),
    ["chatty", "close"],
    "界面上的手动档从低到高，而且不摆跟「从这儿开始」体感重样的最低那档",
  );

  // 「从这儿开始」：清掉起点，但这是她选的，得存得住、认得出
  const zero = normalizeSeed(zeroSeed());
  assert.ok(zero, "选了「从这儿开始」不能等同于「没量出来」");
  assert.equal(zero.pick, "zero");
  assert.equal(zero.source, "manual");
  assert.equal(zero.turns, 0);
  assert.equal(mergeRelationship(createRelationship(), zero).familiarity.turns, 0, "从零就是没起点");
  assert.equal(relationshipNote(createRelationship(), zero), "", "从零不该冒出「不是第一天认识」那句");
});

test("开口那句话：有起跑线就不装初次见面，但也不说成熟透了", () => {
  const own = createRelationship();
  const seed = seedFromTrace(9000);
  assert.equal(relationshipNote(own, null), "", "刚开姑认识就不添那一句，别先替天说你们不熟");
  // 没起跑线但在茶话会里真聊熟了，也得说一声
  const warm = { ...own, familiarity: { ...own.familiarity, turns: 12, activeDays: 6 },
    intimacy: { ...own.intimacy, score: 14, signalDays: 3, signalCount: 3 } };
  assert.match(relationshipNote(warm, null), /慢慢熟悉/, "关系真走到这儿了，不能一句话不说");
  const note = relationshipNote(mergeRelationship(own, seed), seed);
  assert.match(note, /不是第一天认识/, "熟人不能开口像初次搭讪");
  assert.match(note, /不用重新自我介绍/);
  assert.match(note, /更私下的那面还要慢慢来/, "认识很久不等于什么都能说，这一句不能省");
  assert.doesNotMatch(note, /还在认识彼此/, "不能既说不是第一天认识又说还在认识彼此");
  // 在这儿也真的处深了，尾巴就换一种说法
  const deep = {
    ...mergeRelationship(own, seed),
    familiarity: { ...own.familiarity, turns: 24, activeDays: 20 },
    intimacy: { ...own.intimacy, score: 40, signalDays: 5, signalCount: 6 },
  };
  assert.match(relationshipNote(deep, seed), /处得挺深/);

  // 起点低的时候，那句重话说不得：才打过照面就说「相处很久」是错话
  const lightSeed = seedFromTrace(400);
  const light = relationshipNote(mergeRelationship(own, lightSeed), lightSeed);
  assert.match(light, /打过照面/);
  assert.doesNotMatch(light, /相处很久|不用重新自我介绍/, "最低那档配不上这么重的说法");
  const midSeed = seedFromTrace(2000);
  const mid = relationshipNote(mergeRelationship(own, midSeed), midSeed);
  assert.match(mid, /认识一阵子/);
  assert.doesNotMatch(mid, /相处很久/, "中档也不该说「很久」");
});

test("起跑线合并：账本自己不动，台阶也不跟着跳", () => {
  const own = createRelationship();
  const seed = seedFromTrace(9000);
  const merged = mergeRelationship(own, seed);
  assert.equal(merged.familiarity.turns, own.familiarity.turns + 80);
  assert.equal(merged.familiarity.activeDays, own.familiarity.activeDays + 30);
  assert.deepEqual(merged.intimacy, own.intimacy, "親近度没被动过");
  assert.equal(merged.stage, 0, "親近度是零，台阶照样不跳，爱好也解锁不了");
  assert.ok(disclosureRatio(merged) > 0.3 && disclosureRatio(merged) < 0.4, "落点在“里层刚渗一点”那一段");
  assert.equal(own.familiarity.turns, 0, "账本本身一点没被写脏");

  // 没起点就是原来那份；起来后也是只加不覆
  assert.deepEqual(mergeRelationship(own, null).familiarity, normalizeRelationship(own).familiarity);
  const chatting = advanceRelationship(merged, { text: "今天有点累，想抱一下" }).relationship;
  assert.ok(chatting.familiarity.turns > merged.familiarity.turns, "带起跑线也能继续往前挪");

  // 盘上读回来收一手
  assert.equal(normalizeSeed({ turns: 0, activeDays: 0 }), null);
  assert.equal(normalizeSeed({ turns: "12", activeDays: 4, source: "乱写" }).source, "auto");
  assert.equal(normalizeSeed("坏数据"), null);
  // 老数据没有 pick：手动那份以前只有「很熟」一档，回推成 close；没写来历的当自动
  assert.equal(normalizeSeed({ turns: 80, activeDays: 30, label: "很熟了", source: "manual" }).pick, "close");
  assert.equal(normalizeSeed({ turns: 12, activeDays: 4, label: "刚开始熟" }).pick, "auto");
});
