/**
 * 日子账本联动测试。
 *
 * 守三件事：① 只取本伙伴那一份做册（别人的日子不许串味）；② 拾光记没装 / 快照坏了要静默降级；
 * ③ 日子按天说一遍，跨天或内容变了才重新露。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DAYBOOK_SCHEMA_VERSION,
  buildAmbientContextText,
  buildDaybookText,
  daybookEntry,
  daybookHash,
  readDaybook,
  shouldRevealDaybook,
  __clearDaybookCache,
} from "../lib/daybook.js";
import { buildSystemPrompt, CHAT_HOUSE_STYLE } from "../lib/prompt.js";

const SNAPSHOT = {
  schemaVersion: DAYBOOK_SCHEMA_VERSION,
  generatedAt: "2026-09-13T04:51:00.000Z",
  dataRev: 42,
  today: {
    date: "2026-09-13",
    weekday: "日",
    festivals: ["中秋节"],
    events: ["在一起第 500 天"],
    workday: true,
    todos: ["给圆宝买狗粮"],
    period: true,
  },
  weather: { place: "成都 武侯区", line: "窗外阴着，风不大", temp: 24 },
  summaries: {
    hanako: [{ date: "2026-09-12", text: "和小花一起把茶话会接上了拾光记" }],
    carol: [{ date: "2026-09-12", text: "和小七聊了一晚上剧本" }],
  },
};

function tmpHana() {
  const hana = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-daybook-"));
  const dataDir = path.join(hana, "plugin-data", "chahuahui");
  fs.mkdirSync(dataDir, { recursive: true });
  return { hana, dataDir };
}

function fakeCtx(dataDir, { throwOnRead = false, raw = undefined } = {}) {
  return {
    dataDir,
    resources: {
      // 真按路径读盘：路径拼错也会在这里暴露出来
      read: async (ref) => {
        if (throwOnRead) throw new Error("read failed");
        if (raw !== undefined) return { content: raw };
        return { content: fs.readFileSync(ref.path, "utf-8") };
      },
    },
  };
}

function writeSnapshot(hana, snapshot) {
  const dir = path.join(hana, "plugin-data", "shiguangji");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "public-today.json"), JSON.stringify(snapshot), "utf-8");
}

// ── 取哪一份 ──

test("取本伙伴那一份：别人的做册一个字都不带进来", () => {
  const mine = daybookEntry(SNAPSHOT, "hanako");
  assert.equal(mine.recap.length, 1);
  assert.ok(mine.recap[0].text.includes("小花"));

  const text = buildDaybookText(SNAPSHOT, "hanako", { userName: "阿舟" });
  assert.ok(text.includes("和小花一起把茶话会接上了拾光记"));
  assert.ok(!text.includes("小七"), "别人的日子不许出现在给这位伙伴的提示里");
});

test("快照里没有这位伙伴时：今天照说，做册那段不硬凑", () => {
  const text = buildDaybookText(SNAPSHOT, "meilin", { userName: "阿舟" });
  assert.ok(text.includes("中秋节"));
  assert.ok(!text.includes("【你们的日子】"));
});

// ── 拼出来的那段 ──

test("主动消息只取共享天气，不重复搬整段日子账本", () => {
  const text = buildAmbientContextText(SNAPSHOT);
  assert.ok(text.includes("窗外阴着，风不大"));
  assert.ok(text.includes("24°C"));
  assert.ok(!text.includes("给圆宝买狗粮"));
  assert.equal(buildAmbientContextText({ schemaVersion: DAYBOOK_SCHEMA_VERSION, weather: null }), "");
});

test("今天这一段：节日、纪念日、调休、待办、身体不适、天气都写到了", () => {
  const text = buildDaybookText(SNAPSHOT, "hanako", { userName: "阿舟" });
  assert.ok(text.startsWith("【今天】"));
  assert.ok(text.includes("中秋节"));
  assert.ok(text.includes("在一起第 500 天"));
  assert.ok(text.includes("调休上班日"));
  assert.ok(text.includes("给圆宝买狗粮"));
  assert.ok(text.includes("身体不太舒服"));
  assert.ok(text.includes("窗外阴着，风不大"));
  assert.ok(text.includes("24°C"));
  assert.ok(text.includes("别主动报出来"), "要有收口，免得ta每轮念叨");
});

test("做册那一段：带日期、带底子说明、并且明说不是她刚说的话", () => {
  const text = buildDaybookText(SNAPSHOT, "hanako", { userName: "阿舟" });
  assert.ok(text.includes("【你们的日子】"));
  assert.ok(text.includes("2026-09-12："));
  assert.ok(text.includes("别一条条念"));
});

test("今天真的没什么可说的：返回空串，什么也不提", () => {
  const empty = {
    schemaVersion: DAYBOOK_SCHEMA_VERSION,
    today: { date: "2026-09-13", weekday: "日", festivals: [], events: [], workday: false, todos: [], period: false },
    weather: null,
    summaries: {},
  };
  assert.equal(buildDaybookText(empty, "hanako"), "");
  assert.equal(daybookEntry(empty, "hanako"), null);
  assert.equal(buildDaybookText(null, "hanako"), "");
});

test("脏文本被洗过，超长做册被截", () => {
  const dirty = {
    schemaVersion: DAYBOOK_SCHEMA_VERSION,
    today: { festivals: [`中秋\u0000节`], events: [], workday: false, todos: ["  长".repeat(100)], period: false },
    weather: { line: "  窗外  " },
    summaries: { hanako: [{ date: "2026-09-12", text: "字".repeat(3000) }] },
  };
  const entry = daybookEntry(dirty, "hanako");
  assert.equal(entry.specials[0], "中秋节");
  assert.ok(entry.recap[0].text.length <= 1800);
});

// ── 读盘与降级 ──

test("读快照：正常读得到", async () => {
  __clearDaybookCache();
  const { hana, dataDir } = tmpHana();
  writeSnapshot(hana, SNAPSHOT);
  const got = await readDaybook(fakeCtx(dataDir));
  assert.equal(got.dataRev, 42);
});

test("读快照：没装拾光记 / 版本对不上 / 读崩了，一律安静给 null", async () => {
  __clearDaybookCache();
  const { hana, dataDir } = tmpHana();

  assert.equal(await readDaybook(fakeCtx(dataDir)), null, "文件不存在应给 null");

  writeSnapshot(hana, { schemaVersion: 99, today: {} });
  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx(dataDir)), null, "版本对不上应给 null");

  writeSnapshot(hana, SNAPSHOT);
  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx(dataDir, { throwOnRead: true })), null, "读崩了应给 null");

  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx("", { raw: null })), null, "没有 dataDir 应给 null");
  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx(dataDir, { raw: "{ 不是 json" })), null, "坏 JSON 应给 null");
});

// ── 按天说一遍 ──

test("指纹：同一段话稳定，变了就变", () => {
  assert.equal(daybookHash("abc"), daybookHash("abc"));
  assert.notEqual(daybookHash("abc"), daybookHash("abd"));
  assert.ok(daybookHash("").length > 0);
});

test("露不露：没记过就露；同天同内容不再露；跨天或内容变了要重露", () => {
  const mark = { lifeDay: "2026-09-13", hash: "abc" };
  assert.equal(shouldRevealDaybook(null, { lifeDay: "2026-09-13", hash: "abc" }), true);
  assert.equal(shouldRevealDaybook(undefined, {}), true);
  assert.equal(shouldRevealDaybook(mark, { lifeDay: "2026-09-13", hash: "abc" }), false);
  assert.equal(shouldRevealDaybook(mark, { lifeDay: "2026-09-14", hash: "abc" }), true);
  assert.equal(shouldRevealDaybook(mark, { lifeDay: "2026-09-13", hash: "zzz" }), true);
  assert.equal(shouldRevealDaybook({ 乱七八糟: 1 }, { lifeDay: "2026-09-13", hash: "abc" }), true);
});

// ── 接进系统提示 ──

test("系统提示：日子那段跟在时间后面、人格前面，没料时不占位", () => {
  const daybookText = buildDaybookText(SNAPSHOT, "hanako", { userName: "阿舟" });
  const withDaybook = buildSystemPrompt({
    partnerName: "小花",
    partnerId: "hanako",
    personaText: "人格设定正文",
    userName: "阿舟",
    timeText: "【现在】\n2026 年 9 月 13 日，周日。",
    daybookText,
  });
  assert.ok(withDaybook.includes("【今天】"));
  assert.ok(withDaybook.indexOf("【现在】") < withDaybook.indexOf("【今天】"));
  assert.ok(withDaybook.indexOf("【今天】") < withDaybook.indexOf("人格设定正文"));
  // 名牌搬到了最前面（名字是上下文里最容易被别的名字带走的东西），时间/日子仍在人格前
  assert.ok(withDaybook.indexOf("你就是「小花」本人") < withDaybook.indexOf("【现在】"));
  assert.ok(withDaybook.indexOf("你就是「小花」本人") < withDaybook.indexOf("人格设定正文"));

  const without = buildSystemPrompt({
    partnerName: "小花",
    partnerId: "hanako",
    personaText: "人格设定正文",
    userName: "阿舟",
    daybookText: "",
  });
  assert.ok(!without.includes("【今天】"));
  assert.ok(without.startsWith(CHAT_HOUSE_STYLE));
});
