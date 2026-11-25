/**
 * 集中名单与实际上限（2026-11-25）。
 *
 * 1. 「给你递小东西」的集中名单：PUT /settings/partner-feed { partnerIds }
 *    一次落盘，不会一位改成了、一位没改；
 *    只写名单里、且现在还看得见的那些；没出现的、被移出的、不知道是谁的，一律保持原值。
 * 2. B站实际可用上限：global.videoShareEffectiveMaxPerDay。
 *    与真正执行同源（用户设置与配比表取小的），设置页看到的与发出去的必须是同一个数。
 */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui } from "./helpers/app-harness.js";
import { createStore } from "../lib/store.js";
import { LAB_BUDGET } from "../index.js";

const PARTNERS = [{ id: "alpha", name: "甲" }, { id: "beta", name: "乙" }];
/** 与实际执行同口径：用户设置与配比表取小的那个。 */
const expectedVideoLimit = (setting) => (LAB_BUDGET.enabled ? Math.min(setting, LAB_BUDGET.video) : setting);

async function boot(t, { feed = {} } = {}) {
  const app = await bootChahuahui({ partners: PARTNERS, seed(store) {
    store.setGlobalSettings({ videoShareMaxPerDay: 5 });
    for (const [id, value] of Object.entries(feed)) {
      store.setPartnerSettings(id, { partnerFeedEnabled: value });
    }
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return app;
}

/** 伙伴设置存在账本文件里：读盘上的那份，才看得出服务端到底写了什么。 */
const disk = (app) => createStore(app.dataDir);
const feedOf = (app, id) => disk(app).getPartnerSettings(id).partnerFeedEnabled !== false;

/* ── 集中名单：给你递小东西 ── */

test("集中名单：这份名单就是「谁会递小东西」，可见的伙伴照单改", async t => {
  const app = await boot(t, { feed: { alpha: false, beta: false } });
  const first = await app.request("PUT", "/settings/partner-feed", { json: { partnerIds: ["alpha"] } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.partners, [
    { id: "alpha", partnerFeedEnabled: true },
    { id: "beta", partnerFeedEnabled: false },
  ], "回的是当前可见伙伴的生效值");
  assert.equal(feedOf(app, "alpha"), true, "名单里的那位可以递小东西了");
  assert.equal(feedOf(app, "beta"), false, "没在名单里的那位不递");

  // 名单里再添一位：另一位也跟着开。
  const second = await app.request("PUT", "/settings/partner-feed", { json: { partnerIds: ["alpha", "beta"] } });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(feedOf(app, "beta"), true);
  // 再从名单里拿掉一位：那位就不递了（前端取消勾选要能存住）。
  const third = await app.request("PUT", "/settings/partner-feed", { json: { partnerIds: ["alpha"] } });
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(feedOf(app, "beta"), false, "从名单里拿掉就真不递了");
});

test("集中名单：被移出可见名单的伙伴保持原值", async t => {
  const app = await boot(t, { feed: { alpha: false, beta: false } });
  // 移出要走服务端那条路：隐藏名单是它自己账本里的。
  const hidden = await app.request("POST", "/settings/partner/beta/hide");
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  const res = await app.request("PUT", "/settings/partner-feed", { json: { partnerIds: ["beta"] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.partners.map((row) => row.id), ["alpha"], "回包里只有还看得见的伙伴");
  assert.equal(feedOf(app, "beta"), false, "移出的伙伴保持原值，不写也不报错");
});

test("集中名单：入参不合法当场拒绝，一个字也不写", async t => {
  const app = await boot(t, { feed: { alpha: false } });
  for (const body of [{ partnerIds: "alpha" }, { partnerIds: [123] }, { partnerIds: ["../x"] }, {}]) {
    const res = await app.request("PUT", "/settings/partner-feed", { json: body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应当被拒`);
    assert.equal(res.body.ok, false);
  }
  assert.equal(feedOf(app, "alpha"), false, "被拒的请求没有留下任何写入");
});

test("集中名单：不知道是谁的 id 整批拒绝，一个字也不写", async t => {
  const app = await boot(t, { feed: { alpha: false } });
  const res = await app.request("PUT", "/settings/partner-feed", { json: { partnerIds: ["nobody"] } });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.ok, false);
  assert.equal(feedOf(app, "alpha"), false, "不认识的 id 不产生写入，也不把别人打开");
});

/* ── B站实际上限 ── */

test("B站实际可用上限：与真正执行同源，设置页与发出去的是同一个数", async t => {
  const app = await boot(t);
  const initial = await app.request("GET", "/settings");
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.global.videoShareEffectiveMaxPerDay, expectedVideoLimit(5),
    "默认上限取用户设置与配比表里较小的那个");
  assert.equal(initial.body.global.videoShareMaxPerDay, 5, "她自己设的那档原样留着");

  // 她自己调低：生效上限跟着她走。
  const lowered = await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: 1 } });
  assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
  assert.equal(lowered.body.global.videoShareEffectiveMaxPerDay, expectedVideoLimit(1));
  assert.equal((await app.request("GET", "/settings")).body.global.videoShareEffectiveMaxPerDay, expectedVideoLimit(1));

  // 关掉：上限就是 0。
  const off = await app.request("PUT", "/settings/global", { json: { videoShareMaxPerDay: 0 } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.global.videoShareEffectiveMaxPerDay, 0);

  // B站那份名单存完，回包里的上限与设置页读到的同一个数。
  const saved = await app.request("PUT", "/settings/video-sharing", { json: { maxPerDay: 3, partnerIds: ["alpha"] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.global.videoShareMaxPerDay, 3, "她自己设的那档原样留着");
  assert.equal(saved.body.global.videoShareEffectiveMaxPerDay, expectedVideoLimit(3), "同源");
  assert.equal((await app.request("GET", "/settings")).body.global.videoShareEffectiveMaxPerDay, expectedVideoLimit(3),
    "保存回包与设置页读到的必须一致");
  assert.deepEqual(saved.body.partners, [
    { id: "alpha", videoSharingEnabled: true },
    { id: "beta", videoSharingEnabled: false },
  ], "参与名单照旧按可见名单落");
});
