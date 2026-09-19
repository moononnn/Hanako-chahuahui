import test from "node:test";
import assert from "node:assert/strict";

import {
  BACK_JITTER_MAX_MS,
  DOZE_NOTICE_MAX_MS,
  DOZE_NOTICE_MIN_MS,
  HEARD_MAX_MS,
  HEARD_MIN_MS,
  HERE_MAX_MS,
  HERE_MIN_MS,
  mergeDueAt,
  planReply,
} from "../lib/reply.js";

const MIN = 60 * 1000;
const at = (h, m = 0) => new Date(2026, 8, 12, h, m, 0, 0);
const fixed = (value) => () => value;
/** 依次返回给定的随机数（用完了就重复最后一个）。 */
const seq = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

/** ta正拿着手机：这一段要到下午两点半才结束。 */
const holding = { holding: true, untilMs: at(14).getTime() + 30 * MIN };
/** 手机放在一边了：得二十多分钟才拿起来。 */
const off = { holding: false, untilMs: at(14).getTime() + 20 * MIN };

test("手机在手就是面对面：几秒到二十秒", () => {
  const plan = planReply({ phone: holding, now: at(14), rnd: fixed(0) });
  assert.equal(plan.mode, "hand");
  assert.equal(plan.skip, undefined);
  assert.equal(plan.delayMs, HERE_MIN_MS);
  assert.equal(plan.phone.holding, true, "推进后的状态要还回去存着");

  const slow = planReply({ phone: holding, now: at(14), rnd: fixed(0.999) });
  assert.ok(slow.delayMs > HERE_MIN_MS && slow.delayMs <= HERE_MAX_MS);
});

test("手机不在手：多数情况ta听得见——摸一下手机就看到了，最多三两分钟", () => {
  const plan = planReply({ phone: off, now: at(14), rnd: fixed(0.5) });
  assert.equal(plan.mode, "away");
  assert.equal(plan.heard, true);
  assert.equal(plan.skip, undefined, "skip 这个概念取消了：把「看到」和「回不回」捏成一个骰子是错的");
  assert.equal(plan.delayMs, HEARD_MIN_MS + Math.round(0.5 * (HEARD_MAX_MS - HEARD_MIN_MS)));
  assert.ok(plan.delayMs <= HEARD_MAX_MS, "听见了就很快，不该让她等一顿饭");
});

test("偶尔没听见：那一次按ta自己的节奏，等ta自己拿起手机", () => {
  // 头一个随机数决定听不听得见（0.9 > 0.75，没听见），第二个决定缓多久
  const plan = planReply({ phone: off, now: at(14), rnd: seq(0.9, 0.5) });
  assert.equal(plan.mode, "away");
  assert.equal(plan.heard, false);
  assert.equal(plan.delayMs, 20 * MIN + Math.round(0.5 * BACK_JITTER_MAX_MS));
  assert.ok(plan.delayMs > 20 * MIN, "没听见就得等ta自己拿起来");
});

test("不管随机数是多少，醒了就是接：不靠掷骰子决定理不理", () => {
  for (const value of [0, 0.05, 0.17, 0.5, 0.99]) {
    const plan = planReply({ phone: holding, now: at(14), rnd: fixed(value) });
    assert.equal(plan.skip, undefined, `随机数 ${value} 也不该跳过`);
    assert.equal(plan.mode, "hand");
    assert.ok(plan.delayMs >= HERE_MIN_MS && plan.delayMs <= HERE_MAX_MS);
  }
  // 手机放下也一样：拿起来就是全看到了（以前这里有 18% 不提，已删）
  for (const value of [0, 0.17, 0.5, 0.99]) {
    const plan = planReply({ phone: off, now: at(14), rnd: fixed(value) });
    assert.equal(plan.mode, "away");
    assert.equal(plan.skip, undefined);
    assert.ok(plan.delayMs >= HEARD_MIN_MS, "总得让ta先摸到手机");
    assert.ok(plan.delayMs <= 20 * MIN + BACK_JITTER_MAX_MS, "再没听见也不会让她等过二十分钟");
  }
});

test("ta到底醒着没：看ta自己的作息，不看她的全局静默", () => {
  const sleep = { start: "01:00", hours: 6 };
  const away = planReply({ phone: holding, now: at(3), sleep, rnd: fixed(0) });
  assert.equal(away.mode, "dozing", "三点正是ta的觉");

  // ta醒着、但恰好落在她的安静时段（默认 23:00-08:00）里：这是她自个儿发消息，不该被当成"ta在睡"
  const latePhone = { holding: true, untilMs: at(23, 59).getTime() };
  const night = planReply({ phone: latePhone, now: at(23, 30), sleep, rnd: fixed(0) });
  assert.equal(night.mode, "hand", "全局静默管的是主动来找，不管她发出去的话");
});

test("合并排期：取更早的那个，不往后推", () => {
  assert.equal(mergeDueAt(0, 0), 0);
  assert.equal(mergeDueAt(null, 500), 500);
  assert.equal(mergeDueAt(500, null), 500);
  assert.equal(mergeDueAt(900, 500), 500, "她在接着说，就该早点接，不往后拖");
  assert.equal(mergeDueAt(500, 900), 500);
});

test("ta在睡：不等ta醒，只是半天才摸到手机——拿没拿着都一样", () => {
  const sleep = { start: "01:00", hours: 6 };
  const plan = planReply({ phone: holding, now: at(2), sleep, rnd: fixed(0) });
  assert.equal(plan.mode, "dozing", "睡着了不排到天亮，是慢回");
  assert.equal(plan.kind, "main");
  assert.equal(plan.skip, undefined);
  assert.ok(
    plan.delayMs >= DOZE_NOTICE_MIN_MS && plan.delayMs <= DOZE_NOTICE_MAX_MS,
    `慢慢摸手机那段时间不对：${plan.delayMs}`,
  );
  assert.ok(plan.delayMs > HERE_MAX_MS * 2, "得明显比醒着慢");

  const away = planReply({ phone: off, now: at(2), sleep, rnd: fixed(0) });
  assert.equal(away.mode, "dozing", "睡着那条不看手机在不在手");
  assert.equal(away.skip, undefined, "睡着也不许不理她");
});

test("午觉里也一样：只是回得慢，不是等ta醒", () => {
  const sleep = { start: "01:00", hours: 6, nap: { start: "13:30", minutes: 40 } };
  // 哪一天睡午觉跟日期有关，顺着找一天
  const day = Array.from({ length: 40 }, (_, i) => new Date(2026, 8, 1 + i, 15, 0)).find(
    (d) => planReply({ phone: holding, now: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 45), sleep, rnd: fixed(0) }).mode === "dozing",
  );
  assert.ok(day, "四十天里总该有几天睡午觉");
  const plan = planReply({
    phone: holding,
    now: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 13, 45),
    sleep,
    rnd: fixed(0),
  });
  assert.equal(plan.mode, "dozing");
  assert.equal(plan.kind, "nap");
  assert.ok(plan.window, "要把睡的那一觉一并带出去，好记这一觉被吵醒几次");
});

test("睡醒了就照旧：手机在手就是面对面", () => {
  const sleep = { start: "01:00", hours: 5 };
  const plan = planReply({ phone: holding, now: at(9), sleep, rnd: fixed(0) });
  assert.equal(plan.mode, "hand");
  assert.ok(plan.delayMs >= HERE_MIN_MS && plan.delayMs <= HERE_MAX_MS);

  const noSleep = planReply({
    phone: { holding: true, untilMs: at(16).getTime() },
    now: at(15),
    sleep: null,
    rnd: fixed(0),
  });
  assert.equal(noSleep.mode, "hand", "本来就没定过作息的话，白天照旧面对面");
});

test("全局安静时段不再是回复的门：她自己发消息不算被打扰", () => {
  const sleep = { start: "01:00", hours: 4.5 };
  // 晚上十点：她的全局静默（默认 23:00-08:00）还没到，ta在醒着
  const plan = planReply({
    phone: { holding: true, untilMs: at(23, 59).getTime() },
    now: at(22),
    sleep,
    rnd: fixed(0),
  });
  assert.equal(plan.mode, "hand");
});
