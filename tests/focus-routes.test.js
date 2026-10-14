import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootChahuahui, reopenThread } from './helpers/app-harness.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(check) {
  const until = Date.now() + 4000;
  while (!check()) { if (Date.now() > until) throw new Error('等待落盘超时'); await wait(10); }
}

test('真apply联动：选中伙伴人格、暂停普通主动、向另一伙伴发言提醒但不泄露正文、结束恢复', async () => {
  const handlers = {};
  let active = { id: 'focus-route-1', phase: 'focus', startedAt: new Date().toISOString(),
    targetAt: new Date(Date.now() + 30 * 60_000).toISOString(), plannedMinutes: 30,
    taskTitle: '读书', companionId: 'nova', companionName: '小花' };
  let peer;
  const app = await bootChahuahui({ seed(store, ctx) {
    store.saveKnowing('nova', { ...store.getKnowing('nova'), personality: { surface: { tags: ['俏皮', '爱损'], signals: [] }, inner: { tags: [], signals: [] } } });
    for (let i = 0; i < 8; i++) store.appendMessage('nova', { role: i % 2 ? 'assistant' : 'user',
      text: `own-history-${i}-` + 'x'.repeat(400) + 'truncated-tail-secret',
      attachment: { name: 'attachment-metadata-secret' }, quote: { text: 'quote-metadata-secret' } });
    peer = store.createLocalPartner({ name: '另一个伙伴', description: '克制但爱开玩笑的普通朋友' });
    store.saveKnowing(peer.id, { ...store.getKnowing(peer.id), personality: { surface: { tags: ['克制', '俏皮'], signals: [] }, inner: { tags: [], signals: [] } } });
    store.setPartnerSettings(peer.id, { phone: { holding: true, untilMs: Date.now() + 60 * 60_000 },
      rhythm: { readMinMs: 5, readMaxMs: 10, typingMinMs: 1, gapMinMs: 1, speed: 1 }, voice: { enabled: false } });
    const original = ctx.bus.request;
    ctx.bus.handle = (name, fn, options) => { handlers[name] = { fn, options }; };
    ctx.bus.request = async (name, payload) => name === 'app:shiguangji-app/focus/state'
      ? { ok: true, active, session: !active && payload?.sessionId ? { id: payload.sessionId, status: 'interrupted', endedAt: new Date().toISOString() } : null }
      : original(name, payload);
  } });
  const caller = { callerAppId: 'shiguangji-app' };
  const partners = await handlers['focus/partners'].fn({}, caller);
  assert.ok(partners.partners.some(row => row.id === 'nova'));
  assert.ok(partners.partners.some(row => row.id === peer.id));
  await handlers['focus/sync'].fn({}, caller);
  const start = await app.models.waitForCall(0);
  assert.match(start.request.systemPrompt, /俏皮|爱损/);
  assert.match(JSON.stringify(start.request.messages), /读书/);
  assert.equal(start.request.messages.length, 1, '开场只给场景背景，不带上一轮的聊天正文');
  assert.match(start.request.messages[0].content, /场景背景，非对方发言/);
  assert.doesNotMatch(JSON.stringify(start.request.messages), /own-history-0-|own-history-1-|truncated-tail-secret|attachment-metadata-secret|quote-metadata-secret/);
  assert.ok(start.request.messages.slice(1).every(row => row.content.length < 400), '每条原文<=300字，额外只允许时间标记');
  assert.match(start.request.systemPrompt, /目标和时长是背景/);
  assert.doesNotMatch(JSON.stringify(start.request.messages), /接下约定|提醒开始/);
  app.models.release(0, '书翻开，我先不找你聊。');
  await waitUntil(() => reopenThread(app.dataDir, 'nova').some(row => row.focusReminder?.kind === 'start'));
  const tick = await app.request('POST', '/proactive/tick', { json: {} });
  assert.equal(tick.body.result?.reason, 'focus');
  assert.equal(app.models.calls.length, 1);
  const message = await app.request('POST', '/turns', { json: { agentId: peer.id, text: '私聊机密关键词测试', watching: true, clientMessageId: 'focus_peer_msg_01' } });
  assert.equal(message.body.ok, true);
  const peerReply = await app.models.waitForCall(1);
  assert.match(peerReply.request.systemPrompt, /此刻的专注状态/);
  assert.match(peerReply.request.systemPrompt, /读书/);
  assert.match(peerReply.request.systemPrompt, /克制|俏皮/);
  assert.match(peerReply.request.systemPrompt, /性格与关系/);
  assert.match(peerReply.request.systemPrompt, /状态要实际参与回应/);
  assert.doesNotMatch(peerReply.request.systemPrompt, /小花/);
  assert.match(JSON.stringify(peerReply.request.messages), /私聊机密关键词测试/);
  app.models.release(1, '[quote]来啦[/quote]\n[/quote]\n先回去读一页 再来摆。');
  await waitUntil(() => reopenThread(app.dataDir, peer.id).some(row => row.role === 'assistant'));
  assert.doesNotMatch(JSON.stringify(reopenThread(app.dataDir, peer.id).filter(row => row.role === 'assistant')), /\[\/?quote\]/);
  const reminder = await app.models.waitForCall(2);
  assert.doesNotMatch(JSON.stringify(reminder.request), /私聊机密关键词测试|另一个伙伴/);
  assert.match(JSON.stringify(reminder.request.messages), /主动招呼/);
  // 走神提醒只给场面话，不带上一轮自己的正文（它的场景话本就声明“不知道聊天内容”）。
  assert.equal(reminder.request.messages.length, 1, '走神提醒只有一条场景背景');
  app.models.release(2, '才读几分钟，先回去读这一页。');
  await waitUntil(() => reopenThread(app.dataDir, 'nova').some(row => row.focusReminder?.kind === 'distracted'));
  const self = await app.request('POST', '/turns', { json: { agentId: 'nova', text: '嘿嘿，好好读书！', watching: true, clientMessageId: 'focus_self_msg_01' } });
  assert.equal(self.body.mode, 'focus');
  const ownReply = await app.models.waitForCall(3);
  assert.match(ownReply.request.systemPrompt, /先接住对方实际说的这句话/);
  assert.match(ownReply.request.messages.at(-1).content, /嘿嘿，好好读书！/);
  assert.doesNotMatch(JSON.stringify(ownReply.request), /私聊机密关键词测试|另一个伙伴|attachment-metadata-secret|quote-metadata-secret/);
  app.models.release(3, '跟到读嘛，我也不闹你咯。');
  await waitUntil(() => reopenThread(app.dataDir, 'nova').some(row => row.focusReminder?.kind === 'reply' && row.repliedTo === self.body.messageId));
  assert.ok(reopenThread(app.dataDir, 'nova').find(row => row.id === self.body.messageId).readAt, '成功回应才标记自己的话已读');
  assert.equal(app.models.calls.length, 4, '冷却内自己的确认仍接住，只发一条陪读回应、不另生成普通闲聊');
  active = null;
  const stopped = await handlers['focus/sync'].fn({}, caller);
  assert.equal(stopped.running, false);
  await app.models.waitForCall(4);
  app.models.release(4, '这一段先收起来，之后再继续。');
  await waitUntil(() => reopenThread(app.dataDir, 'nova').some(row => row.focusReminder?.kind === 'end'));
  assert.equal(app.models.calls.length, 5);
  const normal = await app.request('POST', '/turns', { json: { agentId: peer.id, text: '现在来聊聊你吧', watching: true, clientMessageId: 'focus_peer_msg_02' } });
  assert.equal(normal.body.ok, true);
  const normalReply = await app.models.waitForCall(5);
  assert.doesNotMatch(normalReply.request.systemPrompt, /【此刻的专注状态】/);
  app.models.release(5, '要聊啥嘛');
  await waitUntil(() => reopenThread(app.dataDir, peer.id).some(row => row.repliedTo === normal.body.messageId));
});

test('陪读自身回应生成中撤回：旧稿不投递、不标失败、不额外盖已读', async () => {
  const handlers = {};
  const active = { id: 'focus-recall', phase: 'focus', startedAt: new Date().toISOString(),
    targetAt: new Date(Date.now() + 30 * 60_000).toISOString(), plannedMinutes: 30, taskTitle: '读书', companionId: 'nova' };
  const app = await bootChahuahui({ seed(store, ctx) {
    store.saveKnowing('nova', { ...store.getKnowing('nova'), personality: { surface: { tags: ['俏皮'], signals: [] }, inner: { tags: [], signals: [] } } });
    const original = ctx.bus.request;
    ctx.bus.handle = (name, fn) => { handlers[name] = fn; };
    ctx.bus.request = async (name, payload) => name === 'app:shiguangji-app/focus/state'
      ? { ok: true, active } : original(name, payload);
  } });
  assert.ok((await handlers['focus/partners']({}, { callerAppId: 'shiguangji-app' })).partners.some(row => row.id === 'nova'), '测试伙伴应已完成入住');
  await handlers['focus/sync']({}, { callerAppId: 'shiguangji-app' });
  await app.models.waitForCall(0);
  app.models.release(0, '先翻书嘛，我陪你。');
  await waitUntil(() => reopenThread(app.dataDir, 'nova').some(row => row.focusReminder?.kind === 'start'));
  const self = await app.request('POST', '/turns', { json: { agentId: 'nova', text: '好好读书！', watching: true, clientMessageId: 'focus_recall_own' } });
  assert.equal(self.body.mode, 'focus');
  await app.models.waitForCall(1);
  const recall = await app.request('POST', `/thread/nova/retract/${self.body.messageId}`, { json: {} });
  assert.equal(recall.body.ok, true);
  const readAtBeforeOldReply = reopenThread(app.dataDir, 'nova').find(row => row.id === self.body.messageId).readAt;
  app.models.release(1, '这份旧话已经撤回，不该出现。');
  await waitUntil(() => JSON.parse(fs.readFileSync(path.join(app.dataDir, 'v2', 'focus-companion.json'), 'utf8')).claims['focus-recall:distracted-1'] === 'stale');
  const rows = reopenThread(app.dataDir, 'nova');
  assert.ok(rows.find(row => row.id === self.body.messageId).recalled);
  assert.equal(rows.find(row => row.id === self.body.messageId).readAt, readAtBeforeOldReply, '既有主动查看可能已读，失效回应不能再盖已读');
  assert.ok(!rows.some(row => row.repliedTo === self.body.messageId));
  assert.doesNotMatch(JSON.stringify(rows), /这份旧话已经撤回，不该出现/);
  const status = await handlers['focus/partners']({}, { callerAppId: 'shiguangji-app' });
  assert.equal(status.reminderStatus.failed, false);
});
