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

/** 目录那一段。 */
function indexBody() {
  const start = settings.indexOf('id="settings-index"');
  assert.ok(start > 0, '目录得在');
  const end = settings.indexOf('</section>', start);
  return settings.slice(start, end);
}

test('首屏是九类目录，每类都写清楚', () => {
  assert.match(settings, /id="settings-index"/, '首屏得是目录');
  assert.match(settings, /<h2 id="settings-index-title">设置目录<\/h2>/);
  const groups = [...indexBody().matchAll(/data-group="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['appearance', 'sound', 'partners', 'proactive', 'immersion', 'image', 'model', 'usage', 'mobile']);
  for (const title of ['外观与称呼', '声音', '伙伴', '主动联系', '城市与日常', '照片与表情', '模型与服务', '数据与用量', '手机']) {
    assert.match(indexBody(), new RegExp(`<h3>${title}</h3>`), `${title} 这一类要写清楚`);
  }
  // 目录里不摆侧栏，也不自己造路由。
  assert.doesNotMatch(indexBody(), /<aside|role="navigation"/);
});

test('分类按钮的 id、data-tab 与面板编号一处没改', () => {
  for (const [tab, label] of [['chat', '聊天显示'], ['sound', '提示音'], ['voice', '语音'], ['image', '生图'], ['immersion', '沉浸感'], ['model', '模型'], ['usage', '用量'], ['search', '搜索'], ['proactive', '主动联系'], ['partners', '伙伴'], ['mobile', '手机']]) {
    assert.match(settings, new RegExp(`id="tab-${tab}" data-tab="${tab}"`), `${tab} 分类按钮得还在`);
    assert.match(settings, new RegExp(`>${label}<`), `${label} 这一栏的名字没改`);
    assert.match(settings, new RegExp(`id="panel-${tab}"`), `${tab} 面板编号没改`);
  }
  // 面板跟分类栏一一对应，除第一栏外都默认收着。
  for (const tab of ['voice', 'immersion', 'model', 'proactive', 'partners']) {
    assert.match(settings, new RegExp(`id="panel-${tab}"[^>]*hidden`), `${tab} 面板默认要收着`);
  }
});

test('目录里的每一条都指得到真的面板和真的那一项', () => {
  const links = [...indexBody().matchAll(/data-tab-target="([a-z]+)"(?: data-anchor="([a-z0-9-]+)")?/g)];
  assert.ok(links.length >= 25, `目录条目太少：${links.length}`);
  for (const [, tab, anchor] of links) {
    assert.match(settings, new RegExp(`id="panel-${tab}"`), `${tab} 面板得在`);
    if (anchor) assert.match(panelBody(tab), new RegExp(`id="${anchor}"`), `${anchor} 这一项得在 ${tab}`);
  }
  // 目录只带「去哪一栏、哪一项」，不夹带别的动作。
  assert.doesNotMatch(indexBody(), /api\(|apiWith\(|fetch\(|saveGlobal/);
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
  assert.match(image, /<h2>照片与生图<\/h2>/);
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
  assert.match(settings, /if \(indexNode\) indexNode\.hidden = true;/);
  assert.match(settings, /if \(tabsNode\) tabsNode\.hidden = false;/);
  assert.match(settings, /showIndex\(\);/, '打开设置先落在目录上');
  assert.match(settings, /const UI_BUILD = "20261124\.1"/, '设置页版本戳要升，页面旧了才看得出来');
});

test('窄窗不横溢：451px 一级的窗口排得下', () => {
  assert.match(settingsCss, /\.index-grid \{[^}]*repeat\(auto-fit, minmax\(200px, 1fr\)\)/s);
  assert.match(settingsCss, /@media \(max-width: 520px\) \{[^@]*\.index-grid \{ grid-template-columns: 1fr; \}/s, '520px 以下目录排成一列');
  assert.match(settingsCss, /\.index-link \{[^}]*overflow-wrap: anywhere;/s, '长词自己折，不横着顶出去');
  assert.match(settingsCss, /\.tabs \{[^}]*flex-wrap: wrap;/s, '分类栏自己换行');
  assert.match(settingsCss, /html, body \{[^}]*overflow-x: clip;/s);
});
