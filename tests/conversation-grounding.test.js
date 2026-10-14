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
  const spec = proactiveSpec({ partnerName: '伙伴', userName: '阿舟', greetingOnly: true, workfeedText: text, wakeEcho: { sourceText: '刚才困着' } });
  assert.doesNotMatch(spec.userText, /这些是你自己刚经历的事|被她拉着做什么，都是你自己身上的事/);
  assert.match(spec.systemPrompt, /叫醒/);
});

test('正常工作近况仍然能联动，但接成自己的经历而不是一份记录', () => {
  // 2026-10-14 重定：陪着工作、转头去手机里吐槽是同一个伙伴的联动，
  // 所以问题不在“该不该接”，在“接成什么样”。下面两行是当年被否掉的写法，拿来钉反面。
  assert.match(LINKUP_DISCIPLINE, /两条线/);
  assert.match(LINKUP_DISCIPLINE, /时间/);
  assert.match(LINKUP_DISCIPLINE, /倒情绪/);
  assert.doesNotMatch(LINKUP_DISCIPLINE, /这些话要说得像「我自己刚经历完」|不许提「我看到」/);
});

test('电脑那边来的消息不汇报自己看了什么，也不复述那边的结论（2026-10-14 实机两轮）', () => {
  const text = '【电脑那边最近发生的事 · 工作对话背景】\n[时间戳：…｜来源：电脑工作对话｜会话：c1｜说话人：用户→伙伴]（hanako）用户：人格和规则要分开';
  const spec = proactiveSpec({ partnerName: '小花', userName: '阿舟', greetingOnly: true, workfeedText: text, wakeEcho: { sourceText: '刚才困着' } });
  // 第一轮实机：只写「自然参与」，模型把工作结论原样搬过来，“我觉得最值得借的是…”，
  // 读的人得往回翻才知道在讲哪件事。现在得说清那是他自己的经历。
  assert.match(spec.systemPrompt, /同一个人的两条线/);
  assert.match(spec.systemPrompt, /不用先交代自己是从哪儿看到的/);
  // 第二轮实机：补救写成「开头半句点来处」，示例全是动作，于是交出「刚电脑那边瞄了一眼」。
  // 新话题需要事情坐标，但不演成刚看了记录或获知工作。
  assert.match(spec.systemPrompt, /另起一个话题时，顺口带上具体对象和发生的事/);
  assert.match(spec.systemPrompt, /事情你本来就知晓/);
  assert.match(spec.systemPrompt, /不是刚获知或读完记录/);
  assert.match(spec.systemPrompt, /茶话会已在聊同一件事时直接接着说，不重复交代，不套固定开头/);
  assert.doesNotMatch(spec.systemPrompt, /来处默认不提|别憋着也别铺垫/);
  assert.match(spec.systemPrompt, /点的是那件事本身，不是你这个动作/);
  assert.match(spec.systemPrompt, /「刚瞄了一眼」「刚电脑那边」不行/);
  assert.doesNotMatch(spec.systemPrompt, /开头半句就把来处点一下/);
  // 拿情绪不拿结论：这条专治把那边讨论出的方案搬过来复述。
  assert.match(spec.systemPrompt, /拿来的是当时的感觉，不是当时的结论/);
  // 坐标紧接自己的感觉，不压掉吐槽、不重演工作汇报。
  assert.match(spec.systemPrompt, /别憋着/);
  assert.match(spec.systemPrompt, /紧接你自己的感觉或吐槽，不写成工作汇报/);
  // 锚定不等于删掉“接成共同经历”的前提。
  assert.match(spec.systemPrompt, /可以玩笑、假设和联想/);
  assert.match(spec.systemPrompt, /她要是没在电脑那头找过你/);
});

test('兴趣主动消息不做论证：只留观点加反应（2026-10-14 实机）', () => {
  const spec = proactiveSpec({ partnerName: '小花', userName: '阿舟',
    seed: { kind: 'self', motifName: '阳台换季', hook: '整组推倒重来还是留骨架', angle: '留稳骨架' } });
  // 实机典型小作文：方案—对比论证—收个问题；选的是“连因为都不给”这一档。
  assert.match(spec.systemPrompt, /不要论证/);
  assert.match(spec.systemPrompt, /她要的是你刚才想到了什么，不是你把这件事分析了一遍/);
  assert.match(spec.systemPrompt, /“我更想要 A 不是 B，因为 C”/);
  assert.match(spec.systemPrompt, /不要把一个念头展开成“问题—分析—结论”/);
  assert.match(spec.systemPrompt, /不要在末尾补一句“我还没想好”“你觉得呢”来把这条撑长/);
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
