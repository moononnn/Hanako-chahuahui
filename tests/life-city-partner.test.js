/**
 * 伙伴各自的生活城市（2026-11-24）。
 *
 * 这一轮钉住：
 * 1. 伙伴没设过的，沿用旧的全局设置（兼容默认）；伙伴设过的，用自己的。
 * 2. 显式把 code 设成 null ＝ 这位伙伴没有生活城市，不回退全局。
 * 3. 改动只影响那位伙伴：别的小伙伴的提示、候选、备好的稿子都不动。
 * 4. API 校验行政代码与开关类型；旧的全局接口继续能用。
 * 5. 备稿的本地来源得是这位伙伴此刻的城，换城/关开之后旧来源不再参选。
 *
 * 集成部分全走确定的行为路径（聊天回复走 /turns，设置走两条设置接口 + 直接看队列），
 * 不靠主动巡检那套抽签；用例里的伙伴都是虚构的甲乙，不拿真实伙伴名当夹具。
 */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { bootChahuahui } from "./helpers/app-harness.js";
import { effectiveLifeCity, partnerCityOverride } from "../lib/life-city.js";
import { dropStalePendingShares, pickPendingShareSource } from "../lib/pending-shares.js";

const CHENGDU = "510104", HANGZHOU = "330102";
const HOUR = 3600_000;
const time = ms => new Date(Date.now() + ms).toISOString();
/** 两位虚构伙伴：甲、乙。 */
const PARTNERS = [{ id: "alpha", name: "甲" }, { id: "beta", name: "乙" }];
const USER_PLACE = "南京市";

/* ── 纯函数：生效的那份城市 ── */

test("没覆盖过的伙伴沿用全局：这是兼容默认", () => {
  const global = { lifeCity: "成都市", lifeCityCode: CHENGDU, lifeCityDiscoveries: true, lifeCityIllustrations: true, lifeCityStreetView: true };
  const eff = effectiveLifeCity({}, global);
  assert.equal(eff.city, "成都市");
  assert.equal(eff.code, CHENGDU);
  assert.equal(eff.discoveries, true);
  assert.equal(eff.illustrations, true);
  assert.equal(eff.streetView, true);
});

test("伙伴自己设过：用自己的城市，不受全局影响", () => {
  const global = { lifeCity: "成都市", lifeCityCode: CHENGDU, lifeCityDiscoveries: true };
  const eff = effectiveLifeCity({ lifeCity: "杭州市", lifeCityCode: HANGZHOU }, global);
  assert.equal(eff.city, "杭州市");
  assert.equal(eff.code, HANGZHOU);
  assert.equal(eff.discoveries, true, "没碰过的开关还是沿用全局");
});

test("显式清空（code=null）＝这位伙伴没有城市：不回退全局", () => {
  const global = { lifeCity: "成都市", lifeCityCode: CHENGDU, lifeCityDiscoveries: true };
  const eff = effectiveLifeCity({ lifeCity: "", lifeCityCode: null }, global);
  assert.equal(eff.city, "");
  assert.equal(eff.code, null);
  assert.equal(eff.cleared, true);
  assert.deepEqual(partnerCityOverride({ lifeCityCode: null }), { lifeCityCode: null });
});

test("只关一项开关：城市还在，那一项关掉", () => {
  const global = { lifeCity: "成都市", lifeCityCode: CHENGDU, lifeCityDiscoveries: true, lifeCityIllustrations: true };
  const eff = effectiveLifeCity({ lifeCityDiscoveries: false }, global);
  assert.equal(eff.city, "成都市");
  assert.equal(eff.discoveries, false);
  assert.equal(eff.illustrations, true);
});

/* ── 纯函数：备稿来源与旧稿清理 ── */

const SOURCE_URL = "https://example.org/a";
const LOCAL_ROW = {
  title: "成都街区的巷道与院落", snippet: "成都街区导览介绍了窄巷和青砖院落的布局。",
  url: SOURCE_URL, localCity: "成都市", localCityCode: CHENGDU, localKey: "epoch-1:成都市:" + CHENGDU,
};
const CITED_ROW = { title: "外地的一条消息", snippet: "别处的事", url: "https://example.org/other" };

test("本地来源要属于这位伙伴此刻的城：localKey 对不上就不参选", () => {
  const base = { city: "成都市", cityCode: CHENGDU, localKey: LOCAL_ROW.localKey };
  assert.equal(pickPendingShareSource({ items: [CITED_ROW, LOCAL_ROW], ...base }).sourceKind, "city-illustration");
  // 这个伙伴换了城（或者关开过一轮）：旧 localKey 的那条不算来源，退回引用来源。
  const stale = pickPendingShareSource({ items: [CITED_ROW, LOCAL_ROW], ...base, localKey: "epoch-2:成都市:" + CHENGDU });
  assert.equal(stale.sourceKind, "cited");
  assert.equal(stale.title, CITED_ROW.title);
  // 别的城的本地条目不能拿来当引用来源凑数。
  assert.equal(pickPendingShareSource({ items: [LOCAL_ROW], city: "杭州市", cityCode: HANGZHOU, localKey: base.localKey }), null);
});

test("同城发现或城市插画关着时，本地来源整批不参选", () => {
  const items = [CITED_ROW, LOCAL_ROW];
  assert.equal(pickPendingShareSource({ items, city: "成都市", cityCode: CHENGDU, localKey: LOCAL_ROW.localKey, allowLocal: false }).sourceKind, "cited");
  assert.equal(pickPendingShareSource({ items: [LOCAL_ROW], city: "成都市", cityCode: CHENGDU, localKey: LOCAL_ROW.localKey, allowLocal: false }), null);
});

test("旧本地历史没有 localKey：按城名 + 行政代码兼容", () => {
  const legacy = { ...LOCAL_ROW };
  delete legacy.localKey;
  assert.equal(pickPendingShareSource({ items: [legacy], city: "成都市", cityCode: CHENGDU, localKey: "epoch-9" }).sourceKind, "city-illustration");
  // 代码对不上：同名的另一座城（或者换过城），都不算。
  assert.equal(pickPendingShareSource({ items: [legacy], city: "成都市", cityCode: HANGZHOU, localKey: "epoch-9" }), null);
  // 连代码都没有的老条目：只按城名认。
  const bare = { ...legacy };
  delete bare.localCityCode;
  assert.equal(pickPendingShareSource({ items: [bare], city: "成都市", cityCode: HANGZHOU, localKey: "" }).sourceKind, "city-illustration");
});

test("关掉插画：城市插画旧稿作废，别的稿子不动；表情稿看的是源图状态", () => {
  const rows = [
    { id: "p1", kind: "photo", attachmentId: "img_city", cityCode: CHENGDU, sourceKind: "city-illustration" },
    { id: "p2", kind: "photo", attachmentId: "img_cited", cityCode: CHENGDU, sourceKind: "cited" },
    { id: "p3", kind: "sticker", attachmentId: "img_sticker", cityCode: CHENGDU, sourceKind: "self-made-sticker", sourceAttachmentId: "img_action" },
  ];
  const kept = dropStalePendingShares(rows, { cityCode: CHENGDU, cityIllustration: false, sourceStates: { img_action: { allowed: true } } });
  assert.deepEqual(kept.map((row) => row.id), ["p2", "p3"], "只作废城市插画旧稿，引用稿与表情稿都留着");
  // 设置页那条路一定要带 sourceStates：不带就会把表情稿当“源图不在手”误删。
  assert.deepEqual(dropStalePendingShares(rows, { cityCode: CHENGDU, cityIllustration: true, sourceStates: { img_action: { allowed: true } } }).map((row) => row.id),
    ["p1", "p2", "p3"]);
});

/* ── 集成 ── */

async function boot(t, { illustrations = true } = {}) {
  const app = await bootChahuahui({ partners: PARTNERS, seed(store) {
    const far = new Date(Date.now() + 7 * HOUR);
    const clock = hour => `${String(hour % 24).padStart(2, "0")}:${String(far.getMinutes()).padStart(2, "0")}`;
    store.setGlobalSettings({
      weatherEnabled: false, workfeedEnabled: false, rhythmEnabled: false,
      // 用户自己那边设的天气地点：伙伴各报各的城，但也得把这一条留着。
      weatherLocation: USER_PLACE,
      lifeCity: "成都市", lifeCityCode: CHENGDU, lifeCityDiscoveries: true, lifeCityIllustrations: illustrations,
    });
    for (const partner of PARTNERS) {
      store.setPartnerSettings(partner.id, {
        proactiveEnabled: false, tier: "sometimes", imageTier: "normal",
        // 手机在手、当场回：这是确定的那条回复路，不靠定时器也不靠抽签。
        phone: { holding: true, untilMs: Date.now() + 3600000 },
        model: { provider: "test-provider", model: "test-model" },
        sleep: { shape: 2, start: clock(far.getHours()), hours: 7, nap: { start: clock(far.getHours() + 1), minutes: 20 } },
        voice: { enabled: false },
      });
      const knowing = store.getKnowing(partner.id);
      store.saveKnowing(partner.id, { ...knowing,
        relationship: { ...knowing.relationship, familiarity: { ...knowing.relationship.familiarity, turns: 40, activeDays: 12 }, intimacy: { ...knowing.relationship.intimacy, score: 12 } } });
    }
  } });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  return app;
}

/** 走真回复那条路（composeReply），把这一次的系统提示词捞回来。 */
async function replySystemPrompt(app, agentId) {
  const from = app.models.calls.length;
  const started = await app.request("POST", "/turns", { json: { agentId, watching: true, text: "今天想喝热咖啡" } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // 只认这一轮新起的那些调用：前一位伙伴已经回过的请求还留在 stub 里。
  const deadline = Date.now() + 5000;
  let hit = null;
  while (!hit) {
    hit = app.models.calls.slice(from).find((entry) => String(entry.request?.systemPrompt ?? "").includes("【两边的生活地点】"));
    if (hit) break;
    if (Date.now() > deadline) throw new Error(`等待 ${agentId} 的聊天回复超时`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  app.models.release(hit, "嗯，那我也去冲一杯");
  return String(hit.request.systemPrompt ?? "");
}

/** 只截【两边的生活地点】那一段，免得别处的城名混进来。 */
function placesBlock(systemPrompt) {
  const text = String(systemPrompt ?? "");
  const at = text.indexOf("【两边的生活地点】");
  assert.ok(at >= 0, "提示里该有生活地点那一段");
  const rest = text.slice(at);
  const end = rest.indexOf("\n\n");
  return end < 0 ? rest : rest.slice(0, end);
}

test("两个伙伴各用各的城：回复里各报各的，用户的天气地点照样留着", async t => {
  const app = await boot(t);
  const changed = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: HANGZHOU } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.city?.city, "杭州市", "乙生效的城市是杭州");
  assert.equal(changed.body.city?.code, HANGZHOU);

  const alphaBlock = placesBlock(await replySystemPrompt(app, "alpha"));
  assert.match(alphaBlock, /成都市/u, "甲沿用全局那座城");
  assert.match(alphaBlock, new RegExp(USER_PLACE, "u"), "用户自己的天气地点不能被伙伴城市顶掉");
  assert.doesNotMatch(alphaBlock, /杭州市/u, "甲的提示里不该冒出乙的城");

  const betaBlock = placesBlock(await replySystemPrompt(app, "beta"));
  assert.match(betaBlock, /杭州市/u, "乙用自己那座城");
  assert.match(betaBlock, new RegExp(USER_PLACE, "u"), "乙这边也一样留着用户的天气地点");
  assert.doesNotMatch(betaBlock, /成都市/u, "全局那座城不该再落到乙的提示里");
});

test("显式清空：这位伙伴没有城市，也不回退全局；别人照旧", async t => {
  const app = await boot(t);
  await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: HANGZHOU } });
  const cleared = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: null } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.city?.city, "", "显式清空＝没有城市");
  assert.equal(cleared.body.city?.code, null);

  const betaBlock = placesBlock(await replySystemPrompt(app, "beta"));
  assert.match(betaBlock, /你的生活城市还没有设置/u);
  assert.doesNotMatch(betaBlock, /成都市|杭州市/u, "清空之后既不回退全局，也不留上一座城");

  const alphaBlock = placesBlock(await replySystemPrompt(app, "alpha"));
  assert.match(alphaBlock, /成都市/u, "甲还跟着全局走");
});

test("设置接口校验：城市代码只认列表里的，类型不对直接拒绝", async t => {
  const app = await boot(t);
  const unknown = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: "999999" } });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  const numeric = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: 330102 } });
  assert.equal(numeric.status, 400, JSON.stringify(numeric.body));
  const boolean = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: false } });
  assert.equal(boolean.status, 400, JSON.stringify(boolean.body));
  const wrongSwitch = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityIllustrations: "yes" } });
  assert.equal(wrongSwitch.status, 400, JSON.stringify(wrongSwitch.body));
  // 一次好的没写进去：她的城市还是跟着全局。
  assert.equal((await app.request("GET", "/settings/partner/beta")).body.city?.city, "成都市");
});

test("换城真的移除她对着旧城备的稿子；别人的稿子一件不动", async t => {
  const app = await boot(t);
  // 乙先有自己的城（杭州），对着杭州备了一件稿子。
  assert.equal((await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: HANGZHOU } })).status, 200);
  app.store.savePendingShares("beta", [{
    id: "pending_beta_hz", kind: "photo", attachmentId: "img_beta_hz", title: "杭州的巷子",
    description: "", sourceKind: "city-illustration", sourceTitle: "杭州的巷子", sourceUrl: SOURCE_URL,
    city: "杭州市", cityCode: HANGZHOU, referenceId: "", self: false, createdAt: time(0),
  }]);
  // 甲跟着全局（成都），也有一件对着成都备的稿子。
  app.store.savePendingShares("alpha", [{
    id: "pending_alpha_cd", kind: "photo", attachmentId: "img_alpha_cd", title: "成都的巷子",
    description: "", sourceKind: "city-illustration", sourceTitle: "成都的巷子", sourceUrl: SOURCE_URL,
    city: "成都市", cityCode: CHENGDU, referenceId: "", self: false, createdAt: time(0),
  }]);
  // 乙换到成都：她自己那件对不上新城的稿子当场作废。
  const moved = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: CHENGDU } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(app.store.getPendingShares("beta"), [], "换城之后，对着旧城的稿子不留");
  assert.deepEqual(app.store.getPendingShares("alpha").map((row) => row.id), ["pending_alpha_cd"], "甲的稿子不受影响");

  // 乙关掉城市插画：她自己的城市插画稿不再适用，引用来源的稿子照留。
  app.store.savePendingShares("beta", [
    { id: "pending_beta_city", kind: "photo", attachmentId: "img_beta_city", title: "成都的巷子",
      description: "", sourceKind: "city-illustration", sourceTitle: "成都的巷子", sourceUrl: SOURCE_URL,
      city: "成都市", cityCode: CHENGDU, referenceId: "", self: false, createdAt: time(0) },
    { id: "pending_beta_cited", kind: "photo", attachmentId: "img_beta_cited", title: "一条有出处的消息",
      description: "", sourceKind: "cited", sourceTitle: "一条有出处的消息", sourceUrl: "https://example.org/b",
      city: "成都市", cityCode: CHENGDU, referenceId: "", self: false, createdAt: time(0) },
  ]);
  const off = await app.request("PUT", "/settings/partner/beta", { json: { lifeCityIllustrations: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(app.store.getPendingShares("beta").map((row) => row.id), ["pending_beta_cited"], "只作废城市插画那一件");
  assert.deepEqual(app.store.getPendingShares("alpha").map((row) => row.id), ["pending_alpha_cd"], "甲这边开关没动，稿子照留");
});

test("改全局只撤跟着全局走的那些人：自己有城的伙伴不受影响", async t => {
  const app = await boot(t);
  assert.equal((await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: HANGZHOU } })).status, 200);
  app.store.savePendingShares("beta", [{
    id: "pending_beta_hz", kind: "photo", attachmentId: "img_beta_hz", title: "杭州的巷子",
    description: "", sourceKind: "city-illustration", sourceTitle: "杭州的巷子", sourceUrl: SOURCE_URL,
    city: "杭州市", cityCode: HANGZHOU, referenceId: "", self: false, createdAt: time(0),
  }]);
  app.store.savePendingShares("alpha", [{
    id: "pending_alpha_cd", kind: "photo", attachmentId: "img_alpha_cd", title: "成都的巷子",
    description: "", sourceKind: "city-illustration", sourceTitle: "成都的巷子", sourceUrl: SOURCE_URL,
    city: "成都市", cityCode: CHENGDU, referenceId: "", self: false, createdAt: time(0),
  }]);
  const changed = await app.request("PUT", "/settings/global", { json: { lifeCityCode: HANGZHOU } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(app.store.getPendingShares("alpha"), [], "甲跟着全局换了城，旧城的稿子作废");
  assert.deepEqual(app.store.getPendingShares("beta").map((row) => row.id), ["pending_beta_hz"],
    "乙自己有城，全局怎么改都不该动她的稿子");
});

test("旧的全局接口继续能用：没覆盖的伙伴跟着全局走", async t => {
  const app = await boot(t);
  const changed = await app.request("PUT", "/settings/global", { json: { lifeCityCode: HANGZHOU } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.global?.lifeCityCode, HANGZHOU);
  const view = await app.request("GET", "/settings/partner/alpha");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.city?.city, "杭州市", "没覆盖过的伙伴沿用全局");
  assert.deepEqual(view.body.override, {}, "她没覆盖过任何字段");
  // 改全局也不会把别人自己设的那座城顶掉。
  assert.equal((await app.request("PUT", "/settings/partner/beta", { json: { lifeCityCode: CHENGDU } })).status, 200);
  assert.equal((await app.request("PUT", "/settings/global", { json: { lifeCityCode: HANGZHOU } })).status, 200);
  assert.equal((await app.request("GET", "/settings/partner/beta")).body.city?.city, "成都市");
});
