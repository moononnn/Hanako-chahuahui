// 公共事件：节日与天气由谁开口的规矩。
// 覆盖：读快照的失败路径、节日一人一条、天气一件事只归一人且当天定死、
// 事件过了点就不再提、亲密度加权真的偏向更亲的那位。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALERTS_KEY,
  claimWeatherOwner,
  dayOf,
  festivalOf,
  hourKeyOf,
  intimacyWeight,
  markWeatherReported,
  noteFestivalSent,
  noteWeatherAttempt,
  noteWeatherSent,
  pickWeatherEvent,
  readPublicAlerts,
  shouldSendFestival,
  weatherEventReported,
  weatherPendingFor,
  weatherRetryExhausted,
  MAX_WEATHER_PENDING_RETRY,
} from "../lib/public-events.js";

const NOW = new Date(2026, 9, 24, 7, 20); // 2026-10-24 07:20 本地
const DAY = "2026-10-24";

const ALERTS = {
  schemaVersion: 1,
  day: DAY,
  place: "成都 武侯区",
  reason: "ok",
  events: [
    {
      key: "2026-10-24#rise",
      kind: "rise",
      label: "要升温",
      dayLabel: "今天",
      slot: "今天下午",
      at: "2026-10-24T14",
      facts: ["今天下午会到 18°C，比现在高 9°C"],
      keywords: ["升温", "变暖", "薄"],
    },
    {
      key: "2026-10-25#rain",
      kind: "rain",
      label: "可能要下雨",
      dayLabel: "明天",
      slot: "明天上午",
      at: "2026-10-25T09",
      facts: ["明天上午降水概率 70%"],
      keywords: ["雨", "伞"],
    },
  ],
};

function ctxReturning(value, { throwIt = false } = {}) {
  return {
    publicData: {
      async get(request) {
        if (throwIt) throw new Error("denied");
        return { appId: request.appId, key: request.key, schemaVersion: 1, data: value };
      },
    },
  };
}

// ── 读快照 ──

test("公共事件：读拾光记摊出来的天气提醒事件", async () => {
  const alerts = await readPublicAlerts(ctxReturning(ALERTS));
  assert.equal(alerts.day, DAY);
  assert.equal(alerts.events.length, 2);
});

test("公共事件：没有 publicData、身份对不上、版本不对、形状坏了、抛错，一律 null", async () => {
  assert.equal(await readPublicAlerts({}), null);
  assert.equal(await readPublicAlerts(ctxReturning(ALERTS, { throwIt: true })), null);
  assert.equal(await readPublicAlerts({
    publicData: { async get() { return { appId: "other-app", key: ALERTS_KEY, schemaVersion: 1, data: ALERTS }; } },
  }), null);
  assert.equal(await readPublicAlerts({
    publicData: { async get() { return { appId: "shiguangji-app", key: ALERTS_KEY, schemaVersion: 2, data: ALERTS }; } },
  }), null);
  assert.equal(await readPublicAlerts(ctxReturning({ schemaVersion: 1, reason: "ok" })), null, "没有 events 数组不算数");
});

// ── 节日 ──

const SNAPSHOT = {
  today: { date: DAY, festivals: ["中秋节"], events: ["在一起第 500 天"] },
};

test("节日：认拾光记那份节日名单，个人纪念日不升格", () => {
  assert.equal(festivalOf(SNAPSHOT), "中秋节");
  assert.equal(festivalOf({ today: { festivals: ["在一起第 500 天"] } }), "");
  assert.equal(festivalOf({ today: { festivals: ["寒食节"] } }), "", "没有专属引导的节日不算");
  assert.equal(festivalOf({ today: { festivals: ["万圣节"] } }), "万圣节", "万圣节算；茶话会自己的表也认得它");
  assert.equal(festivalOf(null), "");
});

test("节日：一人一条，同一天同一节日说过就不再提；不同伙伴各说各的", () => {
  let state = null;
  assert.equal(shouldSendFestival({ festival: "中秋节", day: DAY, agentId: "hanako", state }), true);
  state = noteFestivalSent(state, { festival: "中秋节", day: DAY, agentId: "hanako", at: NOW });
  assert.equal(shouldSendFestival({ festival: "中秋节", day: DAY, agentId: "hanako", state }), false);
  assert.equal(shouldSendFestival({ festival: "中秋节", day: DAY, agentId: "beta", state }), true, "别人还没说");
  state = noteFestivalSent(state, { festival: "中秋节", day: DAY, agentId: "beta", at: NOW });
  assert.deepEqual(state.publicEvents.festival.sent, ["hanako", "beta"]);
});

test("节日：换一个节日、或跨到第二天，账重新算", () => {
  const state = noteFestivalSent(null, { festival: "中秋节", day: DAY, agentId: "hanako", at: NOW });
  assert.equal(shouldSendFestival({ festival: "重阳节", day: DAY, agentId: "hanako", state }), true);
  assert.equal(shouldSendFestival({ festival: "中秋节", day: "2026-10-25", agentId: "hanako", state }), true);
});

test("节日：同一个伙伴重复记账不会写两条", () => {
  let state = noteFestivalSent(null, { festival: "中秋节", day: DAY, agentId: "hanako", at: NOW });
  state = noteFestivalSent(state, { festival: "中秋节", day: DAY, agentId: "hanako", at: NOW });
  assert.deepEqual(state.publicEvents.festival.sent, ["hanako"]);
});

// ── 天气：挑哪一件 ──

test("天气：挑还没到点的那件，按时间先后", () => {
  const event = pickWeatherEvent(ALERTS, NOW);
  assert.equal(event.key, "2026-10-24#rise");
  assert.equal(event.facts[0], "今天下午会到 18°C，比现在高 9°C");
});

test("天气：说了不该说的那种情况一律不出声", () => {
  assert.equal(pickWeatherEvent(null, NOW), null);
  assert.equal(pickWeatherEvent({ ...ALERTS, reason: "stale" }, NOW), null, "预报过期就不提");
  assert.equal(pickWeatherEvent({ ...ALERTS, reason: "alert-off" }, NOW), null);
  assert.equal(pickWeatherEvent({ ...ALERTS, events: [] }, NOW), null);
});

test("天气：过了那个钟点就不再提，免得马后炮", () => {
  const later = new Date(2026, 9, 24, 16, 30); // 下午那件事已经过去
  const event = pickWeatherEvent(ALERTS, later);
  assert.equal(event.key, "2026-10-25#rain", "跳到下一件还没到点的");
  const evening = new Date(2026, 9, 25, 12, 0); // 两件都过了
  assert.equal(pickWeatherEvent(ALERTS, evening), null);
});

test("天气：整点那一刻还能提，过了宽限就不再提", () => {
  const justAfter = new Date(2026, 9, 24, 14, 10);
  assert.equal(pickWeatherEvent(ALERTS, justAfter).key, "2026-10-24#rise");
  const tooLate = new Date(2026, 9, 24, 14, 40);
  assert.notEqual(pickWeatherEvent(ALERTS, tooLate)?.key, "2026-10-24#rise");
});

// ── 天气：归谁 ──

const PARTNERS = [{ id: "hanako", name: "小花" }, { id: "beta", name: "乙" }, { id: "gamma", name: "丙" }];

test("天气：抽一位负责人，同一天同一件事不再重抽", () => {
  const first = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: null, now: NOW, rnd: () => 0.5,
  });
  assert.ok(PARTNERS.some((row) => row.id === first.ownerId));
  assert.equal(first.reused, false);

  const again = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: first.state, now: NOW, rnd: () => 0.01,
  });
  assert.equal(again.ownerId, first.ownerId, "抽过就定死，不因为换了随机数就换人");
  assert.equal(again.reused, true);
});

test("天气：换了一件新事、或跨天，重新抽", () => {
  const first = claimWeatherOwner({ day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, now: NOW, rnd: () => 0 });
  const other = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rain", partners: PARTNERS, state: first.state, now: NOW, rnd: () => 0,
  });
  assert.equal(other.reused, false);
  const nextDay = claimWeatherOwner({
    day: "2026-10-25", eventKey: "2026-10-24#rise", partners: PARTNERS, state: first.state, now: NOW, rnd: () => 0,
  });
  assert.equal(nextDay.reused, false);
});

test("天气：亲密度高的那位被抽中的次数明显更多", () => {
  const weights = {
    hanako: intimacyWeight({ familiarity: { turns: 80, activeDays: 30 }, intimacy: { score: 40 } }),
    beta: intimacyWeight({ familiarity: { turns: 4, activeDays: 2 }, intimacy: { score: 2 } }),
    gamma: intimacyWeight({ familiarity: { turns: 0, activeDays: 0 }, intimacy: { score: 0 } }),
  };
  assert.ok(weights.hanako > weights.beta);
  assert.ok(weights.beta >= weights.gamma, "垫底的也有地板，只是更低");

  let pickHanako = 0;
  const rounds = 600;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < rounds; i += 1) {
    const row = claimWeatherOwner({
      day: DAY, eventKey: `event-${i}`, partners: PARTNERS, weights, now: NOW, rnd,
    });
    if (row.ownerId === "hanako") pickHanako += 1;
  }
  assert.ok(pickHanako / rounds > 0.6, `最亲那位应该明显占多数，实际 ${pickHanako / rounds}`);
});

test("天气：没有伙伴就没人可归，安静返回空", () => {
  const row = claimWeatherOwner({ day: DAY, eventKey: "k", partners: [], now: NOW });
  assert.equal(row.ownerId, null);
  assert.equal(row.reused, false);
});

test("天气：只有负责人自己待发；说过了、或换人了都不算", () => {
  const claimed = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: null, now: NOW, rnd: () => 0,
  });
  const owner = claimed.ownerId;
  const other = PARTNERS.find((row) => row.id !== owner).id;

  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: owner, state: claimed.state }), true);
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: other, state: claimed.state }), false);
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rain", agentId: owner, state: claimed.state }), false);

  const sent = noteWeatherSent(claimed.state, { day: DAY, eventKey: "2026-10-24#rise", agentId: owner, at: NOW });
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: owner, state: sent }), false);
  assert.ok(sent.publicEvents.weather.sentAt);
});

test("天气：别人替我记账记不上，负责人不会被顶掉", () => {
  const claimed = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: null, now: NOW, rnd: () => 0,
  });
  const other = PARTNERS.find((row) => row.id !== claimed.ownerId).id;
  const attempted = noteWeatherSent(claimed.state, { day: DAY, eventKey: "2026-10-24#rise", agentId: other, at: NOW });
  assert.equal(attempted.publicEvents.weather.sentAt, undefined);
  assert.equal(attempted.publicEvents.weather.ownerId, claimed.ownerId);
});

test("天气：伙伴没提到这件事就补报一次，提到了才算说完", () => {
  const claimed = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: null, now: NOW, rnd: () => 0,
  });
  const owner = claimed.ownerId;
  // 第一次提了，但伙伴绕开了这个由头：这件事还得留在名单里。
  const missed = noteWeatherAttempt(claimed.state, { day: DAY, eventKey: "2026-10-24#rise", agentId: owner, mentioned: false, at: NOW });
  assert.equal(missed.publicEvents.weather.sentAt, undefined, "没提到就不算说完");
  assert.equal(missed.publicEvents.weather.pending.count, 1);
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: owner, state: missed }), true);
  assert.equal(weatherRetryExhausted(missed, "2026-10-24#rise"), false);

  // 第二次还是没提到：补报次数用完，接下来该放弃。
  const missed2 = noteWeatherAttempt(missed, { day: DAY, eventKey: "2026-10-24#rise", agentId: owner, mentioned: false, at: NOW });
  assert.equal(missed2.publicEvents.weather.pending.count, MAX_WEATHER_PENDING_RETRY);
  assert.equal(weatherRetryExhausted(missed2, "2026-10-24#rise"), true);

  // 说到了：这下才算说完，owner 当天不再提。
  const said = noteWeatherAttempt(missed2, { day: DAY, eventKey: "2026-10-24#rise", agentId: owner, mentioned: true, at: NOW });
  assert.ok(said.publicEvents.weather.sentAt);
  assert.equal(said.publicEvents.weather.pending, null);
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: owner, state: said }), false);
});

test("天气：放弃的那件事以后不再被挑起来", () => {
  const marked = markWeatherReported(null, { eventKey: "2026-10-24#rise", at: NOW });
  assert.equal(weatherEventReported(marked, "2026-10-24#rise"), true);
  const event = pickWeatherEvent(ALERTS, NOW, { isReported: (key) => weatherEventReported(marked, key) });
  assert.notEqual(event?.key, "2026-10-24#rise", "已放弃的那件不该再被挑中");
  // 换一件事时，已放弃的那几件不能被抹掉。
  const claimed = claimWeatherOwner({ day: DAY, eventKey: "2026-10-25#rain", partners: PARTNERS, state: marked, now: NOW, rnd: () => 0 });
  assert.equal(weatherEventReported(claimed.state, "2026-10-24#rise"), true);
});

test("天气：换一件事时上一件的「已说过」不能带过来", () => {
  // 回归用例（v0.15.0 审包挖出）：claimWeatherOwner 曾经把旧账整本带过来，
  // 上一件事的 sentAt 会让新事件被判成「已经说过」而静默丢掉；旧数据里残留的
  // sentAt 也会让升级当天的第一件事直接不提醒。
  const claimed = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: null, now: NOW, rnd: () => 0,
  });
  const owner = claimed.ownerId;
  const said = noteWeatherAttempt(claimed.state, { day: DAY, eventKey: "2026-10-24#rise", agentId: owner, mentioned: true, at: NOW });
  assert.ok(said.publicEvents.weather.sentAt, "提到过就该记下说完");

  // 同一天的第二件事：不能因为上一件说过就被丢掉。
  const second = claimWeatherOwner({
    day: DAY, eventKey: "2026-10-24#rain", partners: PARTNERS, state: said, now: NOW, rnd: () => 0,
  });
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rain", agentId: second.ownerId, state: second.state }), true);

  // 旧版本留下的账（别的 key + sentAt 在）：升级后当天第一件事仍要能提醒。
  const legacy = {
    publicEvents: {
      weather: { day: "2026-10-23", eventKey: "2026-10-23#rain", ownerId: owner, sentAt: "2026-10-23T08:00:00.000Z", reported: ["2026-10-23#rain"] },
    },
  };
  const fresh = claimWeatherOwner({ day: DAY, eventKey: "2026-10-24#rise", partners: PARTNERS, state: legacy, now: NOW, rnd: () => 0 });
  assert.equal(weatherPendingFor({ day: DAY, eventKey: "2026-10-24#rise", agentId: fresh.ownerId, state: fresh.state }), true);
  assert.equal(weatherEventReported(fresh.state, "2026-10-23#rain"), true, "已放弃的那几件还是要留着");
});

// ── 时间小工具 ──

test("时间键：本地日历日与小时键", () => {
  assert.equal(dayOf(new Date(2026, 9, 24, 23, 59)), "2026-10-24");
  assert.equal(dayOf(new Date(2026, 9, 25, 0, 1)), "2026-10-25");
  assert.equal(hourKeyOf(new Date(2026, 9, 24, 7, 20)), "2026-10-24T07");
});
