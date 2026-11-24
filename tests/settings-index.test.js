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

test('城市与日常：生活城市那四张卡搬到这一页，天气与日常感知独立成小节', () => {
  const immersion = panelBody('immersion');
  const image = panelBody('image');
  for (const id of ['life-city-card', 'life-city-discoveries-card', 'life-city-illustrations-card', 'life-city-street-card']) {
    assert.match(immersion, new RegExp(`id="${id}"`), `${id} 得搬到城市与日常`);
    assert.doesNotMatch(image, new RegExp(`id="${id}"`), `${id} 不该还留在照片与表情`);
  }
  assert.match(immersion, /<h2>城市<\/h2>/);
  assert.match(immersion, /<h2>天气与日常感知<\/h2>/);
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
  assert.match(settings, /if \(name === "partners" && !currentId && partners\.length\) void openPartner\(partners\[0\]\.id\)/, '伙伴页照旧自己挑一位');
  assert.match(settings, /if \(name === "usage"\) void loadUsage\(\)/, '用量账本照旧进了再读');
  assert.match(settings, /if \(name === "mobile"\) void mobilePanel\?\.refresh\(\)/, '手机页照旧进了再刷');
  assert.match(settings, /setTab\("proactive"\)/, '伙伴页跳 B站分享那条老路还在');
  // 目录页与面板页来回切：目录藏起来、分类栏亮起来。
  assert.match(settings, /function showIndex\(\)/);
  assert.match(settings, /indexNode\.hidden = true;/);
  assert.match(settings, /indexBack\.addEventListener\("click", showIndex\)/);
  assert.match(settings, /showIndex\(\);/, '打开设置先落在目录上');
  assert.match(settings, /const UI_BUILD = "20261124\.2"/, '设置页版本戳要升，页面旧了才看得出来');
});

test('目录在窄窗仍是单列整行，子页不摆分类条', () => {
  assert.match(settingsCss, /\.index-list \{[^}]*display: grid;/s);
  assert.match(settingsCss, /\.index-list \.index-link \{[^}]*width: 100%;[^}]*min-height: 44px;/s);
  assert.doesNotMatch(settings, /<nav class="tabs"/);
});
