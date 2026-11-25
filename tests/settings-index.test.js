// 桌面设置页改版：首屏是九类目录，进去还是原来那些面板。
//
// 这份用例盯三件事：
//   1. 目录本身：九类都写清楚，分类按钮的 id / data-tab / 面板编号一处没改。
//   2. 搬家：城市那四张卡到「城市与日常」、图片存储到「数据与用量」、修整回复到「伙伴表达」。
//   3. 兼容：老入口、setTab 的副作用、窄窗不横溢，以及这一版只动前端。
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = fs.readFileSync(new URL('../ui/settings.html', import.meta.url), 'utf8');
const settingsCss = fs.readFileSync(new URL('../ui/assets/settings.css', import.meta.url), 'utf8');

/** 抠出某个面板的内容（到它的 </section> 为止）。 */
function panelBody(name) {
  const start = settings.indexOf(`id="panel-${name}"`);
  assert.ok(start > 0, `panel-${name} 得在`);
  const end = settings.indexOf('</section>', start);
  assert.ok(end > start, `panel-${name} 得有结尾`);
  return settings.slice(start, end);
}

test('首页三组九个整行入口，子页默认收起', () => {
  const index = settings.slice(settings.indexOf('id="settings-index"'), settings.indexOf('id="panel-chat"'));
  assert.deepEqual([...index.matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1]), ['聊天体验', '伙伴与日常', '应用管理']);
  assert.deepEqual([...index.matchAll(/data-tab-target="([a-z]+)"/g)].map(m => m[1]), ['chat', 'sound', 'partners', 'proactive', 'immersion', 'image', 'model', 'usage', 'mobile']);
  assert.doesNotMatch(index, /data-anchor|index-card|role="tablist"/);
  for (const tab of ['chat', 'sound', 'voice', 'image', 'immersion', 'model', 'usage', 'search', 'proactive', 'partners', 'mobile']) {
    assert.match(panelBody(tab), /data-settings-panel hidden/);
  }
});

test('天气与日常：公共页天气置顶，生活城市跟伙伴走', () => {
  const immersion = panelBody('immersion');
  // 公共页只留「我的天气 / 日常设置」，天气在最上面。
  assert.ok(immersion.indexOf('<h2>我的天气</h2>') > 0);
  assert.ok(immersion.indexOf('<h2>我的天气</h2>') < immersion.indexOf('<h2>日常设置</h2>'));
  assert.ok(immersion.indexOf('<h2>日常设置</h2>') < immersion.indexOf('id="daybook-switch"'));
  assert.match(immersion, /id="own-weather-save"/);
  // 城市端不再有全局按钮：四张城市卡搬到这位伙伴的「城市与日常」子页。
  assert.doesNotMatch(immersion, /life-city-(pick|clear|switch)/);
  for (const id of ['life-city-card', 'life-city-discoveries-card', 'life-city-illustrations-card', 'life-city-street-card']) {
    assert.match(settings, new RegExp(`"${id}"`), `${id} 得在伙伴的城市页上`);
  }
  assert.match(settings, /function mountPartnerCitySettings/);
});

test('伙伴目录：三组八行、分项不另摆返回，标题带伙伴名', () => {
  const start = settings.indexOf('const PARTNER_SECTIONS');
  assert.ok(start > 0, 'PARTNER_SECTIONS 得在');
  const sections = settings.slice(start, settings.indexOf('function partnerSectionLabel', start));
  const rows = [...sections.matchAll(/\["([a-z]+)", "([^"]+)"\]/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(rows)], ['contact', 'relation', 'action', 'city', 'room', 'model', 'memory', 'manage']);
  assert.deepEqual([...sections.matchAll(/group: "([^"]+)"/g)].map((m) => m[1]), ['怎么相处', '她的日常', '管理']);
  // 分项页里不另摆「返回」：退哪一层交给工具栏那一个返回。
  assert.doesNotMatch(settings, /className = "soft-button partner-back"/);
  assert.doesNotMatch(settingsCss, /partner-back/);
  assert.match(settings, /openPartner\(agentId, id, \{ focus: true \}\)/);
  assert.match(settings, /openPartner\(currentId, "directory", \{ focusSection: currentDetailTab \}\)/);
  // 标题能认出是哪位伙伴：目录页写名字，分项页写「名字 · 这一块」。
  assert.match(settings, /const who = partner\?\.name \|\| "伙伴设置";/);
  assert.match(settings, /`\$\{who\} · \$\{partnerSectionLabel\(detailTab\)\}`/);
  // 旧标签名（personality 这些）落回目录，不留空页。
  assert.match(settings, /if \(!PARTNER_SECTIONS\.some\(\(group\) => group\.rows\.some\(\(\[id\]\) => id === detailTab\)\)\) detailTab = "directory";/);
});

test('照片与表情：同一页分两组；图片存储搬到数据与用量', () => {
  const image = panelBody('image');
  assert.match(image, /<h2>照片<\/h2>/);
  assert.match(image, /<h2>表情<\/h2>/);
  assert.match(image, /id="sticker-inspiration-card"/, '表情灵感得单独一张卡，跟备稿分开');
  assert.match(image, /id="sticker-usage-sync-card"/);
  // 图片存储从模型那页搬到用量那页。
  assert.match(panelBody('usage'), /id="global-image-retention-host"/);
  assert.doesNotMatch(panelBody('model'), /id="global-image-retention-host"/);
});

test('修整伙伴回复挪到伙伴表达，外观与称呼只留显示', () => {
  assert.match(panelBody('partners'), /<h2>伙伴表达<\/h2>/);
  assert.match(panelBody('partners'), /id="msg-refine-switch"/);
  assert.doesNotMatch(panelBody('chat'), /id="msg-refine-switch"/);
  assert.match(panelBody('chat'), /id="user-name-override"/, '称呼还留在外观与称呼');
  assert.match(panelBody('chat'), /id="msg-avatars-switch"/);
});

test('目录只是导航：老入口、setTab 副作用和面板懒加载都还在', () => {
  assert.match(settings, /id="back-to-chat"/, '返回聊天那个入口没动');
  assert.match(settings, /function setTab\(name\)/);
  // 进「伙伴设置」只落到名单，不替她打开第一位。
  assert.match(settings, /if \(name === "partners"\) showPartnerList\(\);/);
  assert.doesNotMatch(settings, /void openPartner\(partners\[0\]\.id\)/);
  assert.match(settings, /if \(name === "usage"\) void loadUsage\(\)/, '用量账本照旧进了再读');
  assert.match(settings, /if \(name === "mobile"\) void mobilePanel\?\.refresh\(\)/, '手机页照旧进了再刷');
  assert.match(settings, /id="video-share-card"/, 'B站分享那张卡在主设置里');
  assert.doesNotMatch(settings, /前往主设置管理B站分享/, '伙伴页不再有跳B站分享那条老路');
  // 目录页与面板页来回切：目录藏起来、分类栏亮起来。
  assert.match(settings, /function showIndex\(\)/);
  assert.match(settings, /indexNode\.hidden = true;/);
  assert.match(settings, /showIndex\(\);/, '打开设置先落在目录上');
  assert.match(settings, /const UI_BUILD = "20261125\.4"/, '设置页版本戳要升，页面旧了才看得出来');
});

test('目录在窄窗仍是单列整行，子页不摆分类条', () => {
  assert.match(settingsCss, /\.index-list \{[^}]*display: grid;/s);
  assert.match(settingsCss, /\.index-list \.index-link \{[^}]*width: 100%;[^}]*min-height: 44px;/s);
  assert.doesNotMatch(settings, /<nav class="tabs"/);
  assert.equal([...settings.matchAll(/class="index-icon"[^>]*aria-hidden="true"/g)].length, 9);
  assert.match(settingsCss, /\.index-list \.index-link \{[^}]*font-weight: 400;/s);
});

test('磨砂只在设置打开时出现，且位于设置面板下方', () => {
  const panelCss = fs.readFileSync(new URL('../ui/assets/panel.css', import.meta.url), 'utf8');
  assert.match(panelCss, /\.shell:has\(> \.settings-view:not\(\[hidden\]\)\)::after \{[^}]*inset: 0;[^}]*z-index: 39;[^}]*backdrop-filter: blur\(/s);
  assert.match(panelCss, /\.settings-view \{[^}]*z-index: 40;/s);
});
