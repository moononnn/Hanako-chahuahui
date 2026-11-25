/**
 * 设置页这一轮拍板的改动（2026-11-25）：
 *
 * 1. 辅助识图全局唯一：聊天模型自己看得懂图的照旧；看不懂图的和生成后审图用全局那一份；
 *    伙伴页不再有单独的识图控件，只留「ta 说话用哪个模型」。
 * 2. B站分享只在主设置里管：伙伴页的跳转和那句回写都没了；主设置显示实际生效上限。
 * 3. 「给你递小东西」集中到主设置「主动联系」，伙伴页只留一句指路的话。
 * 4. 语音：伙伴页写清全局总闸关了不会自动发，手动点播照旧。
 * 5. 照片：全局与单伙伴的额度、备稿的审图门槛都写清楚。
 *
 * 只读源码，不跑页面、不连服务。
 */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const imageSettings = fs.readFileSync(new URL("../ui/assets/image-settings.js", import.meta.url), "utf8");

test("辅助识图全局唯一：原生能看图的照旧，辅助与审图用这一份", () => {
  // 全局那张卡：说明写清了三种用法。
  const card = settings.slice(settings.indexOf('id="global-vision-host"') - 800, settings.indexOf('id="global-vision-host"'));
  assert.match(card, /全局辅助识图/);
  assert.match(card, /聊天模型自己看得懂图片的照旧用它自己的/);
  assert.match(card, /看不懂图的那几位、还有生成之后审图/);
  // 全局测试按钮留着。
  assert.match(settings, /id="global-vision-test"/);
  // 伙伴页不再有单独的识图控件：那张卡、那个下拉、那次伙伴自己的测试都没了。
  assert.doesNotMatch(settings, /ta 的识图模型/);
  assert.doesNotMatch(settings, /buildVisionSelect\(visionKeyOf\(s\.vision\)/);
  assert.doesNotMatch(settings, /vision\/test", \{ agentId, model: s\.vision\.model \}/);
  // 伙伴页只留说话用的模型。
  assert.match(settings, /ta 说话用哪个模型/);
  assert.match(settings, /ta 自己的模型能看图时照旧能看；看不清图、或者生成之后要审图，用的是全局那一份辅助识图/);
});

test("目录里那一行改叫「聊天模型」", () => {
  assert.match(settings, /\["model", "聊天模型"\]/);
  assert.doesNotMatch(settings, /\["model", "模型与识图"\]/);
});

test("B站只在主设置里管：伙伴页的跳转和过时回写都没了", () => {
  assert.doesNotMatch(settings, /function partnerVideoField\(/);
  assert.doesNotMatch(settings, /前往主设置管理B站分享/);
  assert.doesNotMatch(settings, /data-video-partner-id/);
  assert.doesNotMatch(settings, /video-partner-note/);
  // 主设置那张卡自己管名单。
  assert.match(settings, /id="video-share-card"/);
  assert.match(settings, /id="video-share-partners"/);
});

test("主设置显示实际生效上限：读不到就说读不到，不拿0顶替", () => {
  assert.match(settings, /id="video-share-effective"/);
  assert.match(settings, /globalSettings\.videoShareEffectiveMaxPerDay/);
  assert.match(settings, /实际生效上限还没读到/);
  assert.match(settings, /现在实际生效：所有参与伙伴合计一天最多\$\{effective\}条/);
  // 暂停是一种状态，不等于“没读到”。
  assert.match(settings, /现在实际生效：已暂停，参与名单还留着/);
});

test("给你递小东西集中到主设置「主动联系」，伙伴页只留指路的话", () => {
  assert.match(settings, /id="partner-feed-card"/);
  assert.match(settings, /id="partner-feed-partners"/);
  assert.match(settings, /id="partner-feed-save"/);
  assert.match(settings, /api\("PUT", "settings\/partner-feed", \{ partnerIds: \[\.\.\.partnerFeedDraft\] \}\)/);
  // 伙伴页那个开关没了。
  assert.doesNotMatch(settings, /const feedSw = document\.createElement\("button"\)/);
  assert.doesNotMatch(settings, /savePartner\(agentId, \{ partnerFeedEnabled: next \}/);
  assert.match(settings, /在主设置的「主动联系」里统一管/);
  // 不新增总开关，也没有“都不递”的假象。
  assert.doesNotMatch(settings, /partner-feed-switch/);
  assert.match(settings, /伙伴名单还没读到，这里先空着——不是“都不递”。/);
});

test("语音：伙伴页写清全局总闸关了不会自动发，手动点播照旧", () => {
  assert.match(settings, /全局「语音」总闸关着时，ta 不会自动发语音，这里开着也没用；手动点播的规则照旧/);
  assert.match(settings, /全局「语音」总闸现在是关着的：ta 不会自动发语音（手动点播照旧）/);
  assert.match(settings, /全局「语音」总闸现在是开着的：ta 才会自己发语音（手动点播照旧）/);
});

test("照片：全局与单伙伴的额度、备稿的审图门槛都写清了", () => {
  // 全局：生效上限按现有生效态算出来，不让她自己换算。
  assert.match(settings, /id="image-global-tier-note"/);
  assert.match(settings, /const limit = \{ off: 0, less: 4, normal: 8, more: 32 \}\[globalSettings\.imageTier \|\| "off"\]/);
  assert.match(settings, /现在生效：关闭，所有伙伴都不发聊天照片/);
  assert.match(settings, /这是全体共用的一份额度；每位伙伴自己还有一档，两边都要有余额才出图/);
  // 审图用全局那一份。
  assert.match(settings, /复核用「模型 → 全局辅助识图」那一份（全局只有这一份）/);
  // 备稿的门槛。
  assert.match(settings, /备稿走的是生图那份额度，也要过生成后审图那一关/);
  // 伙伴自己那一档。
  assert.match(imageSettings, /这是这位伙伴自己的一档，全局总上限（照片与表情那页）关着时，这里留着也不发/);
  assert.match(imageSettings, /审不过就不发，审图那头用不了时也不发，只留文字/);
});
