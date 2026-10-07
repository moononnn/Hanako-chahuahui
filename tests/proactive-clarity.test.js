import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.js';
import { addDiscovery, nextDiscovery, offerableDiscovery } from '../lib/interest-exploration.js';
import { proactiveSpec } from '../lib/compose.js';
import { askUtility } from '../lib/model.js';
import { seedSpec, addSeeds, emptySeedBook, rejectSeed, usableSeeds, readSeedBook } from '../lib/topic-seeds.js';
import { reviewProactiveClarity, needsClarityReview, persistClarityRejection, CLARITY_SYSTEM } from '../lib/proactive-clarity.js';

const BAD = '我要是给阳台那盆薄荷挡雨，还是会顺着叶柄留一块完整干影，集中得像专门给它留了个小干燥角落，斜放虽然叶脉好看些，边会不会太散？你摆东西会选哪种';
const seed = { kind: 'exchange', hook: '用叶片挡雨时，顺着叶柄保住完整干影，还是斜放让叶脉和叶缘把水引开', angle: '偏好完整干影的集中感' };

test('准备话题与成文都允许轻分享，并要求不靠猜前提理解', () => {
  const s = seedSpec({ motif: { name: '雨后窗台的干燥小角' } });
  assert.match(s.systemPrompt, /轻分享/);
  assert.doesNotMatch(s.systemPrompt, /不算/);
  assert.match(s.systemPrompt, /微小差异/);
  const p = proactiveSpec({ partnerName: '伙伴', userName: '对方', seed });
  assert.match(p.systemPrompt, /不靠猜前提/);
  assert.match(p.systemPrompt, /轻分享/);
  assert.doesNotMatch(p.systemPrompt, /只能回一声.*别发/);
});

test('失败原文进入语义核查，源话题不合适时返回种子拒绝，不发改写消息', async () => {
  let calls = 0;
  const result = await reviewProactiveClarity({ text: BAD, seed, sharedContext: '对方说自己随便摆东西', ask: async (system, user, budget) => {
    calls++;
    assert.match(user, /完整干影/);
    assert.match(system, /微小差异/);
    assert.ok(budget >= 800);
    return '{"decision":"skip","scope":"seed","reason":"场景动作不清楚，微小摆法被硬做成选择题"}';
  } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.rejectSeed, true);
});

test('清楚的轻分享、无问句和有共同前情的专业细节都能放行', async () => {
  for (const text of ['雨停之后，窗台居然留了一小块没淋湿的地方，像给蚂蚁留的避雨棚', '你刚问的入口修好了，点击主页面就能进去']) {
    const result = await reviewProactiveClarity({ text, seed, ask: async (system) => {
      assert.match(system, /专业/);
      assert.match(system, /没有问句/);
      return '{"decision":"send"}';
    } });
    assert.equal(result.ok, true);
  }
});

test('核查异常、空正文、乱回包不发送，也不把未知当作坏种子', async () => {
  for (const reply of ['', 'send', '{"decision":"send","extra":1}', '{"decision":"skip"}', '{"decision":"send","scope":"seed"}']) {
    const result = await reviewProactiveClarity({ text: BAD, seed, ask: async () => reply });
    assert.equal(result.ok, false);
    assert.equal(result.rejectSeed, false);
  }
  const result = await reviewProactiveClarity({ text: BAD, ask: async () => { throw Error('timeout'); } });
  assert.equal(result.reason, 'review-failed');
});

test('只有普通主动兴趣内容核查，提醒、例外、已读关系反应等不被挡', () => {
  assert.equal(needsClarityReview({ seed }), true);
  assert.equal(needsClarityReview({ discovery: {} }), true);
  for (const extra of [{ todoNudge: '喝水' }, { exception: true }, { kind: 'farewell' }, { kind: 'stirred' }, { followup: { read: true } }, { firstOfDay: true }, { wakeEcho: { sourceId: 'wake' } }]) {
    assert.equal(needsClarityReview({ seed, ...extra }), false);
  }
  assert.equal(needsClarityReview({}), false);
});

test('拒绝种子持久化后不再被挑中，不伪记成已发送，不影响其他库存', () => {
  const now = new Date('2026-10-07T07:00:00Z');
  const book = addSeeds(emptySeedBook(), [seed, { kind: 'self', hook: '雨停后小角落很像避雨棚' }], { motif: { id: 'rain', name: '雨后窗台' }, now }).book;
  const rejected = rejectSeed(book, book.seeds[0].id, '题面过窄', now);
  const restored = readSeedBook(JSON.parse(JSON.stringify(rejected)), now);
  assert.equal(restored.seeds[0].usedAt, null);
  assert.ok(restored.seeds[0].rejectedAt);
  assert.equal(usableSeeds(restored, { now }).length, 1);
  assert.equal(restored.seeds.length, 2);
});

test('核查提示所有格式示例都能解析成合法JSON', () => {
  const examples = [...CLARITY_SYSTEM.matchAll(/\{[^\n{}]+\}/gu)].map(match => JSON.parse(match[0]));
  assert.equal(examples.length, 4);
  assert.deepEqual(examples.map(row => row.scope).filter(Boolean), ['message', 'seed', 'discovery']);
});

test('真实store集成：拒绝写运行账，重开后种子与探索均不再选，也不伪记已发送', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chahuahui-clarity-'));
  try {
    const now = new Date();
    const store = createStore(dir);
    const seeds = addSeeds(emptySeedBook(), [seed], { motif: { id: 'rain', name: '雨后' }, now }).book;
    const discoveries = addDiscovery(null, { interest: { id: 'rain', name: '雨后' },
      plan: { focus: '很窄的研究题', searchQuery: '水痕' }, results: [{ title: '水痕', snippet: '资料' }] }, now).book;
    store.setProactiveState('nova', { topicSeeds: seeds, interestLearning: discoveries });
    store.setPartnerSettings('nova', { proactiveEnabled: true });
    persistClarityRejection(store, 'nova', { rejectSeed: true, rejectDiscovery: true, reason: '题面不适合闲聊' },
      { seed: seeds.seeds[0], discovery: discoveries.discoveries[0] });
    const reopened = createStore(dir);
    const state = reopened.getProactiveState('nova');
    assert.equal(usableSeeds(state.topicSeeds).length, 0);
    assert.equal(nextDiscovery(state.interestLearning), null);
    assert.equal(offerableDiscovery(state.interestLearning), null);
    assert.equal(state.topicSeeds.seeds[0].usedAt, null);
    assert.equal(state.interestLearning.discoveries[0].sharedAt, null);
    assert.equal(reopened.getPartnerSettings('nova').topicSeeds, undefined);
    const before = JSON.stringify(state);
    persistClarityRejection(reopened, 'nova', { ok: false, rejectSeed: false, reason: 'review-failed' }, { seed: seeds.seeds[0] });
    assert.equal(JSON.stringify(reopened.getProactiveState('nova')), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MiniMax式思考占满正文：沿同一utility路径保留预算并有限重试，不静默换模型', async () => {
  const requests = [];
  const ctx = { models: {
    utility: async request => {
      requests.push(request);
      return requests.length === 1
        ? { text: '', reasoningTokens: 8192 }
        : { text: '{"decision":"send"}' };
    },
    cancel: async () => {},
  } };
  const result = await reviewProactiveClarity({ text: '这个小角落像避雨棚', seed,
    ask: (systemPrompt, userText, maxTokens, options) => askUtility(ctx, { systemPrompt, userText, maxTokens, ...options }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests.map(r => r.maxTokens), [8192, 16384]);
  assert.ok(requests.every(r => r.scope === 'app'));
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt);
});

test('真实发送路线在分气泡和朗读之前核查，失败立即停止', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function deliverProactive(');
  const end = src.indexOf('const composed = await composeBubbles', start);
  const flow = src.slice(start, end);
  assert.match(flow, /needsClarityReview/);
  assert.match(flow, /await reviewProactiveClarity/);
  assert.match(flow, /if \(!clarity.ok\)/);
  assert.match(flow, /persistClarityRejection\(store, agentId, clarity/);
  assert.match(flow, /!wakeEcho && !firstOfDay/);
  assert.match(flow, /shareableSeed = interestContent/);
  assert.match(flow, /shareableDiscovery = interestContent/);
});
