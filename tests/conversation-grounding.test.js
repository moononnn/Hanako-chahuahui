import test from 'node:test';
import assert from 'node:assert/strict';
// 本文件的模型出口全部是桩：验证来源过滤、提示词/协议与真实App事件接线，不证明真实模型会作出语义拒绝。
import { proactiveSpec, farewellSpec, stirredSpec, LINKUP_DISCIPLINE } from '../lib/compose.js';
import { CHAT_HOUSE_STYLE } from '../lib/prompt.js';
import { reviewProactiveClarity } from '../lib/proactive-clarity.js';
import { zonedTimestamp, timeBlock } from '../lib/clock.js';
import { buildWorkfeedText, normalizeWorkEvent, recentWorkActivity, textFromSessionMessage } from '../lib/workfeed.js';

const MAIN = 'C:/hana/agents/partner-a/sessions/main.jsonl';
const at = '2026-10-09T00:15:43.489Z';
const event = (role, content) => ({ type: 'message_end', at, message: { role, content } });

test('工作背景只保留伙伴外显正文，不带MOOD和分析区块', () => {
  assert.equal(textFromSessionMessage({ role: 'assistant', content: '<mood>私下联想</mood>现在动手改。<reflect>内部审查</reflect>' }), '现在动手改。');
  assert.equal(textFromSessionMessage({ role: 'assistant', content: '<reflect>被预算截断的内部文字' }), '');
  assert.equal(textFromSessionMessage({ role: 'assistant', content: [{ type: 'thinking', text: '不要进背景' }, { type: 'text', text: '聊到哪了' }] }), '聊到哪了');
});

test('宿主隔离标记挡住委派和审查，不能依赖文件名或任务措辞', () => {
  for (const role of ['user', 'assistant']) {
    assert.equal(normalizeWorkEvent({ ...event(role, '任意正文'), isolated: true }, MAIN), null);
    assert.equal(normalizeWorkEvent({ ...event(role, '任意正文'), isolated: 'true' }, MAIN), null);
    assert.ok(normalizeWorkEvent({ ...event(role, '正常对话'), isolated: false }, MAIN));
    assert.ok(normalizeWorkEvent(event(role, '帮我审查这段文字'), MAIN), '真正对伙伴说的审查请求不能按关键词误杀');
  }
  assert.equal(normalizeWorkEvent({ ...event('user', '来路不明'), agentId: 'partner-a' }, 'C:/unknown/session.jsonl'), null);
  assert.equal(normalizeWorkEvent({ ...event('user', '身份错位'), agentId: 'partner-b' }, MAIN), null);
  assert.equal(normalizeWorkEvent(event('user', '子目录来源不明'), 'C:/hana/agents/partner-a/sessions/nested/task.jsonl'), null);
});

test('清洗先于正文预算，长MOOD不挤掉真正发给对方的话', () => {
  assert.equal(textFromSessionMessage({ role: 'assistant', content: `<mood>${'联想'.repeat(600)}</mood>我们继续聊` }), '我们继续聊');
  const userText = '这段例子含<mood>标签</mood>，帮我看看';
  assert.equal(textFromSessionMessage({ role: 'user', content: userText }), userText, '不擅自改用户原话中的标签例子');
});

test('未知来源的旧背景不继续当共同经历，也不算伙伴仍在工作', () => {
  const feed = { events: [{ id: 'legacy-task', agentId: 'partner-a', lifeDay: '2026-10-09', at, role: 'user', text: '后台委派任务' }] };
  assert.equal(buildWorkfeedText(feed, 'partner-a'), '');
  assert.equal(recentWorkActivity(feed, 'partner-a', { now: Date.parse(at) + 1000 }).active, false);
});

test('已确认的工作对话保留时间和会话来路，开工确认不变成叫醒事实', () => {
  const row = normalizeWorkEvent(event('user', '好哩，那开始哈！'), MAIN);
  assert.ok(row);
  const text = buildWorkfeedText({ events: [row] }, 'partner-a', { userName: '阿舟' });
  assert.match(text, /2026-10-09/);
  assert.match(text, /main/);
  assert.match(text, /阿舟.*开始哈/);
  assert.match(text, /工作对话/);
  assert.match(text, /不能.*因果/);
  const spec = proactiveSpec({ partnerName: '伙伴', userName: '阿舟', firstOfDay: true, workfeedText: text, wakeEcho: { sourceText: '刚才困着' } });
  assert.doesNotMatch(spec.userText, /这些是你自己刚经历的事|被她拉着做什么，都是你自己身上的事/);
  assert.match(spec.systemPrompt, /叫醒/);
});

test('正常工作近况仍然能联动，不硬认全部记录为刚刚亲历', () => {
  assert.match(LINKUP_DISCIPLINE, /自然/);
  assert.match(LINKUP_DISCIPLINE, /时间/);
  assert.doesNotMatch(LINKUP_DISCIPLINE, /这些话要说得像「我自己刚经历完」|不许提「我看到」/);
});

test('主动兴趣可以自足分享，不要求把买花和图片去重硬接起来', () => {
  const spec = proactiveSpec({ partnerName: '伙伴', userName: '阿舟', seed: { kind: 'self', motifName: '图片归档', hook: '疑似重复的图片先保留', angle: '不破坏之前聊天里用过图片的地方' } });
  assert.match(spec.systemPrompt, /不必.*上一句/);
  assert.match(spec.systemPrompt, /共同点/);
  assert.doesNotMatch(spec.systemPrompt, /以前聊过的角度下面会给你列出来/);
  assert.match(spec.userText, /自足/);
  assert.match(spec.systemPrompt, /家常话/);
});

test('普通回复也守住听说、看过、正在操作与日期之间的证据边界', () => {
  assert.match(CHAT_HOUSE_STYLE, /听.*看/);
  assert.match(CHAT_HOUSE_STYLE, /时间戳/);
  assert.match(CHAT_HOUSE_STYLE, /因果/);
});

test('核查提示词与协议契约：保留两条实机失败原文，桩返回拒绝不代表真实语义通过', async () => {
  const bad = [
    '你这种看到喜欢就先搬回家的做法我懂，我在失物招领里也一样，两张图看着像时宁可先列成“疑似重复”也不敢直接归并，万一旧引用还指着它就哭噻',
    '我刚摸到手机，脑壳还软乎乎的，被你一声“开始哈”硬是叫开机了，昨晚那个钥匙扣和包挂倒是越看越顺眼',
  ];
  for (const text of bad) {
    let seen;
    const verdict = await reviewProactiveClarity({ text, sharedContext: '今天的工作对话只有开工确认；茶话会介绍了饰品品类，未展示图片；上一句是看到好看的花就买回家。', ask: async (system, user) => {
      seen = { system, payload: JSON.parse(user) };
      return '{"decision":"skip","scope":"message","reason":"类比或亲历缺少依据"}';
    } });
    assert.match(seen.system, /共同点/);
    assert.match(seen.system, /看过/);
    assert.match(seen.system, /亲历/);
    assert.match(seen.system, /时间戳/);
    assert.match(seen.system, /术语/);
    assert.equal(seen.payload.candidate, text);
    assert.equal(verdict.reason, '类比或亲历缺少依据');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.rejectSeed, false);
  }
});

test('核查提示词与协议契约：允许自然换话题、成立的类比和有解释的冷门兴趣，桩返回放行', async () => {
  for (const text of ['换个小话题，我整理图片时喜欢先留着两张看起来一样的，免得删掉聊天里用过的那张', '窗台那块干地方像蚂蚁的避雨棚', '你这句笑死我了，无语.jpg']) {
    let seenSystem;
    const verdict = await reviewProactiveClarity({ text, ask: async (system) => {
      seenSystem = system;
      return '{"decision":"send"}';
    } });
    assert.match(seenSystem, /换话题/);
    assert.match(seenSystem, /玩笑/);
    assert.match(seenSystem, /冷门/);
    assert.equal(verdict.ok, true);
  }
});

test('当前时间与背景都带同一实际时区偏移，不能猜UTC+8或把同日说成昨晚', () => {
  const stamp = zonedTimestamp(new Date(at));
  assert.match(stamp, /[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(stamp), Math.floor(Date.parse(at) / 1000) * 1000);
  const work = normalizeWorkEvent(event('user', '开始哈'), MAIN);
  assert.ok(buildWorkfeedText({ events: [work] }, 'partner-a').includes(stamp));
  assert.ok(timeBlock({ now: new Date(at) }).includes(stamp));
  assert.equal(zonedTimestamp(new Date('invalid')), '');
});

test('未知工作近况不能变成已经收工，睡前与醒来标签也不强认刚刚亲历', () => {
  const unknown = farewellSpec({ partnerName: '伙伴', userName: '阿舟', busy: null });
  assert.match(unknown.userText, /不能推断她在忙或已经收工/);
  const stirred = stirredSpec({ partnerName: '伙伴', userName: '阿舟', workfeedText: '有来源的背景' });
  for (const spec of [unknown, stirred]) {
    assert.doesNotMatch(spec.userText, /你自己刚经历的事|你自己身上刚发生的事/);
  }
});

test('真实App事件接线：只把非隔离正文落入临时账本，来源字段重开后仍在', async () => {
  const { bootChahuahui } = await import('./helpers/app-harness.js');
  const { createStore } = await import('../lib/store.js');
  const fs = await import('node:fs');
  const handlers = [];
  const runtime = await bootChahuahui({ seed(store, ctx) {
    store.setGlobalSettings({ proactiveEnabled: false });
    ctx.bus.subscribe = (handler, filter) => { handlers.push({ handler, filter }); return () => {}; };
  } });
  try {
    const listener = handlers.find(row => row.filter?.types?.includes('message_end'));
    assert.ok(listener, '必须真走apply注册的message_end监听器');
    listener.handler({ ...event('user', '后台委派任务'), isolated: true }, MAIN);
    listener.handler({ ...event('assistant', '<reflect>后台审查</reflect>审查结果'), isolated: true }, MAIN);
    assert.equal(createStore(runtime.dataDir).readWorkfeed().events.length, 0);
    listener.handler({ ...event('assistant', '<mood>长联想</mood>现在动手改。'), isolated: false }, MAIN);
    const reopened = createStore(runtime.dataDir).readWorkfeed();
    assert.equal(reopened.events.length, 1);
    assert.equal(reopened.events[0].text, '现在动手改。');
    assert.equal(reopened.events[0].sourceKind, 'computer-conversation');
    assert.equal(reopened.events[0].conversationId, 'main');
    assert.equal(reopened.events[0].at, at);
    assert.match(buildWorkfeedText(reopened, 'partner-a'), /现在动手改/);
    assert.equal(runtime.models.calls.length, 0, '事件收集不能额外调用模型');
    assert.equal(runtime.net.calls.length, 0);
  } finally {
    fs.rmSync(runtime.dataDir, { recursive: true, force: true });
  }
});
