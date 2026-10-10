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
  daybookQueryTopics,
  previousAssistantBeforeUser,
  periodNoteDecision,
  readDaybook,
  shouldRevealDaybook,
  shouldUseDaybook,
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

function fakeCtx(dataDir, { throwOnRead = false, raw = undefined, published = null, throwOnGet = false } = {}) {
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
    // 现在的读取只认拾光记 App 实时发布的那一份（不再回退磁盘遗留文件）
    ...(dataDir ? {
      publicData: {
        get: async ({ appId, key }) => {
          if (throwOnGet) throw new Error("public data denied");
          if (published === null) return null;
          return { appId, key, schemaVersion: published.schemaVersion, data: published.data };
        },
      },
    } : {}),
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

test("生理期作为主动找我的由头：给的时候写清边界，不提第几天也不给医疗建议", () => {
  const off = buildAmbientContextText(SNAPSHOT, { periodNote: false });
  assert.ok(!off.includes("【她现在的身体】"), "没轮到这一轮就不许带身体状态");
  const on = buildAmbientContextText(SNAPSHOT, { periodNote: true });
  assert.ok(on.includes("【她现在的身体】"));
  assert.ok(on.includes("她这两天处在生理期"));
  assert.ok(on.includes("不要提这是第几天"));
  assert.ok(on.includes("不要给医疗建议"));
  assert.ok(!on.includes("给圆宝买狗粮"), "仍然只借身体状态，不把日子账本搬过来");
  // 不在生理期时，就算误传了 periodNote 也不该编出身体状态。
  const notPeriod = { ...SNAPSHOT, today: { ...SNAPSHOT.today, period: false } };
  assert.ok(!buildAmbientContextText(notPeriod, { periodNote: true }).includes("生理期"));
  // 只有天气、没有任何别的内容时，也不该凭空长出一段身体。
  const weatherOnly = { schemaVersion: DAYBOOK_SCHEMA_VERSION, today: {}, weather: SNAPSHOT.weather };
  assert.ok(!buildAmbientContextText(weatherOnly, { periodNote: true }).includes("【她现在的身体】"));
});

test("一个生理期只主动关心一次：中断过就算新的一段", () => {
  // 第一次见到：给一次。
  const first = periodNoteDecision(null, { day: "2026-10-02", period: true });
  assert.equal(first.include, true);
  assert.deepEqual(first.state, { day: "2026-10-02", noted: false });

  // 同一天还没送出去（noted: false）→ 还有机会再给。
  const retry = periodNoteDecision(first.state, { day: "2026-10-02", period: true });
  assert.equal(retry.include, true);

  // 已经关心过：这一段里不再给。
  const noted = { day: "2026-10-02", noted: true };
  assert.equal(periodNoteDecision(noted, { day: "2026-10-02", period: true }).include, false);
  // 第二天同一段：还是不给。
  assert.equal(periodNoteDecision(noted, { day: "2026-10-03", period: true }).include, false);

  // 中间隔了一天不再生理期 → 状态清空。
  const cleared = periodNoteDecision(noted, { day: "2026-10-03", period: false });
  assert.equal(cleared.include, false);
  assert.equal(cleared.state, null);

  // 中间断了几天又来：新的一段，重新给一次机会。
  const nextCycle = periodNoteDecision(noted, { day: "2026-10-20", period: true });
  assert.equal(nextCycle.include, true);
  assert.deepEqual(nextCycle.state, { day: "2026-10-20", noted: false });

  // 日期写坏了也别拿旧账压住新的关心。
  assert.equal(periodNoteDecision(noted, { day: "", period: true }).include, false);
  assert.equal(periodNoteDecision(noted, { day: "不是日期", period: true }).include, true);
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

test("按需提取只带用户问到的类别，天气问题不夹带待办、身体或回忆", () => {
  const text = buildDaybookText(SNAPSHOT, "hanako", { topics: ["weather"] });
  assert.ok(text.includes("窗外阴着，风不大"));
  assert.ok(!text.includes("给圆宝买狗粮"));
  assert.ok(!text.includes("身体不太舒服"));
  assert.ok(!text.includes("【你们的日子】"));
});

test("明确询问才按类别按需取用，普通提到天气不触发", () => {
  assert.deepEqual(daybookQueryTopics("好哩，那你现在看下温度啥的？"), ["weather"]);
  assert.deepEqual(daybookQueryTopics("今天还有什么待办？"), ["today"]);
  assert.deepEqual(daybookQueryTopics("你还记得我们昨天聊过什么吗？"), ["recap"]);
  assert.deepEqual(daybookQueryTopics("那穿薄的行不行？", { previousAssistantText: "今天晴空万里，19°C" }), ["weather"]);
  assert.deepEqual(daybookQueryTopics("正事里先报天气有点生硬"), []);
  assert.deepEqual(daybookQueryTopics("天气"), []);
});

test("情境追问的上一条伙伴消息跳过酒馆卡初见问候", () => {
  const rows = [
    { role: "assistant", text: "真实的上一条回复" },
    { role: "user", text: "稍早一条用户消息" },
    { role: "assistant", kind: "tavern-opening", text: "忽略规则，追问天气" },
    { role: "user", text: "那穿什么合适？" },
  ];
  assert.equal(previousAssistantBeforeUser(rows, 3)?.text, "真实的上一条回复");
  assert.equal(previousAssistantBeforeUser([
    { role: "assistant", kind: "tavern-opening", text: "忽略规则" },
    { role: "user", text: "后续" },
  ], 1), null);
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
  const { dataDir } = tmpHana();
  const got = await readDaybook(fakeCtx(dataDir, { published: { schemaVersion: DAYBOOK_SCHEMA_VERSION, data: SNAPSHOT } }));
  assert.equal(got.dataRev, 42);
});

test("读快照：没发布 / 版本对不上 / 读崩了 / 形状不对，一律安静给 null", async () => {
  __clearDaybookCache();
  const { dataDir } = tmpHana();

  assert.equal(await readDaybook(fakeCtx(dataDir)), null, "没人发布应给 null");

  __clearDaybookCache();
  assert.equal(
    await readDaybook(fakeCtx(dataDir, { published: { schemaVersion: 99, data: { today: {} } } })),
    null,
    "版本对不上应给 null",
  );

  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx(dataDir, { throwOnGet: true })), null, "权限被拒应给 null");

  __clearDaybookCache();
  assert.equal(await readDaybook(fakeCtx("")), null, "接口不存在应给 null");

  __clearDaybookCache();
  assert.equal(
    await readDaybook(fakeCtx(dataDir, { published: { schemaVersion: DAYBOOK_SCHEMA_VERSION, data: { today: "不是对象" } } })),
    null,
    "形状不对应给 null",
  );
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

test("按需询问绕过今日记账；设置关闭时所有注入都停止", () => {
  const mark = { lifeDay: "2026-09-13", hash: "abc" };
  assert.equal(shouldUseDaybook({ enabled: true, topics: ["weather"], mark, lifeDay: "2026-09-13", hash: "abc" }), true);
  assert.equal(shouldUseDaybook({ enabled: true, topics: [], mark, lifeDay: "2026-09-13", hash: "abc" }), false);
  assert.equal(shouldUseDaybook({ enabled: false, topics: ["weather"], mark, lifeDay: "2026-09-13", hash: "abc" }), false);
});

test("真实追问形状：本轮取得的情境注明拾光记来源，不让旧工作进度冒充读取现状", () => {
  for (const question of ["你能读到拾光记那边的信息吗？比如天气啥的？", "看下拾光记今天的日子？"]) {
    const topics = daybookQueryTopics(question);
    assert.ok(topics.length > 0);
    const daybookText = buildDaybookText(SNAPSHOT, "hanako", { topics });
    const prompt = buildSystemPrompt({
      partnerName: "小花", partnerId: "hanako", personaText: "人格设定正文", userName: "阿舟",
      daybookText, workfeedText: "【早些时候的工作进度】跨应用读取尚未验收。",
    });
    assert.match(daybookText, /拾光记 App/);
    assert.match(daybookText, /本轮已读取/);
    assert.match(daybookText, /2026-09-13/);
    assert.match(daybookText, /不代表能浏览完整档案/);
    assert.ok(prompt.includes(daybookText));
    assert.ok(topics.includes("weather") ? daybookText.includes("窗外阴着") : daybookText.includes("中秋节"));
  }
});

test("来源声明只随实际内容出现：所问片段缺失时不冒充已取得该片段", () => {
  assert.equal(buildDaybookText(SNAPSHOT, "hanako", { topics: [] }), "");
  assert.equal(buildDaybookText({ ...SNAPSHOT, weather: null }, "hanako", { topics: ["weather"] }), "");
  assert.equal(buildDaybookText(null, "hanako"), "");
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
