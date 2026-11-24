// 表情用法自动同步：默认关、只认共享图、只推这一条新消息、同步失败不谎报。
//
// 两条腿：
//   1. 纯逻辑（lib/sticker-usage-sync.js）：拒绝同步的说法、可同步的条件、同张并发。
//   2. 真路由（tests/helpers/app-harness.js 起真应用）：走 POST /turns 与设置接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createUsageSyncer,
  isSyncableCorrection,
  mentionsLocalOnly,
  USAGE_SYNC_TARGET,
} from '../lib/sticker-usage-sync.js';
import { encodeStickerBubble } from '../lib/stickers.js';
import { bootChahuahui } from './helpers/app-harness.js';

const SHARED_ID = 'stk_shared';
const MEANING = '被朋友夸了之后假装不在意';
const CORRECTION_TEXT = `这张表情用错啦，就是${MEANING}`;

const wait = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

test('她明说「只留这里 / 不要同步」时，这轮不推', () => {
  for (const text of [
    '这张用错啦，就是被夸了之后假装不在意，只留这里别同步',
    '这张用错啦，就是被夸了之后假装不在意，不要同步',
    '这张用错啦，就是被夸了之后假装不在意，不用同步过去',
    '这张用错啦，就是被夸了之后假装在意，别传出去',
    '这张用错啦，就是被夸了之后假装在意，别告诉图库',
    '这张用错啦，就是被夸了之后假装在意，不用告诉图库',
  ]) {
    assert.equal(mentionsLocalOnly(text), true, `该拦住：${text}`);
  }
  // 普通纠正不能被误伤。
  for (const text of [
    CORRECTION_TEXT,
    '这张不是卖萌，就是被夸了之后假装不在意',
    '今天天气不错',
  ]) {
    assert.equal(mentionsLocalOnly(text), false, `不该拦：${text}`);
  }
});

test('能同步的纠正：定位到确切那一张 + 用法说得清楚', () => {
  assert.equal(isSyncableCorrection({ id: SHARED_ID, meaning: MEANING }), true);
  assert.equal(isSyncableCorrection({ id: '', meaning: MEANING }), false, '没有编号不行');
  assert.equal(isSyncableCorrection({ id: SHARED_ID, meaning: '' }), false, '空用法不行');
  assert.equal(isSyncableCorrection({ id: SHARED_ID, meaning: '啊' }), false, '一个字不算说清楚');
  assert.equal(isSyncableCorrection({ id: SHARED_ID, meaning: '啊'.repeat(61) }), false, '太长对方会拒');
  assert.equal(isSyncableCorrection(null), false);
});

test('同张并发：后到的说法排在前面那趟之后，落地的是最后那句', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const syncer = createUsageSyncer({
    request: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) await gate;
      return { ok: true };
    },
  });

  const first = syncer.sync({ stickerId: SHARED_ID, meaning: '第一句' });
  await Promise.resolve();
  const second = await syncer.sync({ stickerId: SHARED_ID, meaning: '第二句' });
  assert.equal(second.status, 'queued', '同一张图在跑时，后到的只能排队');
  release();
  assert.equal((await first).status, 'synced');
  await wait(() => calls.length >= 2);
  assert.equal(calls.length, 2, '同张图不该连着发三趟');
  assert.deepEqual(calls[1], { stickerId: SHARED_ID, meaning: '第二句' }, '落地的是最后那句');
  assert.equal(syncer.inflightCount(), 0);
});

test('对方不认 / 通道报错：都不谎报成功', async () => {
  const refused = createUsageSyncer({ request: async () => ({ ok: false, error: '图库里没有这张图' }) });
  const result = await refused.sync({ stickerId: SHARED_ID, meaning: MEANING });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /图库里没有这张图/);

  const broken = createUsageSyncer({ request: async () => { throw new Error('总线断了'); } });
  const failed = await broken.sync({ stickerId: SHARED_ID, meaning: MEANING });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /总线断了/);

  const ok = createUsageSyncer({ request: async () => ({ ok: true }) });
  assert.equal((await ok.sync({ stickerId: SHARED_ID, meaning: MEANING })).status, 'synced');
});

// ─────────────────────────── 真路由 ───────────────────────────

function sharedIndex() {
  return { schemaVersion: 1, stickers: [{ id: SHARED_ID, file: 'images/shared.png', description: '一只猫', emotion: ['得意'], scene: [], keywords: [] }] };
}

async function bootWithSticker({ seedExtra = null } = {}) {
  const calls = [];
  let receiver = { ok: true };
  const app = await bootChahuahui({
    resources: {
      read: async (target) => (String(target?.path).endsWith('public-index.json') ? { content: JSON.stringify(sharedIndex()) } : null),
    },
    seed(store, ctx) {
      // 上一轮她发过一张共享表情：纠正要能定位到它。
      store.appendMessage('nova', { role: 'assistant', text: '', bubbles: [encodeStickerBubble(SHARED_ID)] });
      const request = ctx.bus.request;
      ctx.bus.request = async (target, payload, options) => {
        if (target !== USAGE_SYNC_TARGET) return request(target, payload, options);
        calls.push({ target, payload });
        return receiver;
      };
      if (seedExtra) seedExtra(store, ctx);
    },
  });
  return { app, calls, setReceiver: (value) => { receiver = value; } };
}

test('默认关：她纠正了也不推', async (t) => {
  const { app, calls } = await bootWithSticker();
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const sent = await app.request('POST', '/turns', { json: { agentId: 'nova', text: CORRECTION_TEXT } });
  assert.equal(sent.status, 200);
  await wait(() => calls.length > 0, 300);
  assert.deepEqual(calls, [], '没开开关就不该推');
});

test('开了开关：只推这一条新纠正，只带编号和用法', async (t) => {
  const { app, calls } = await bootWithSticker();
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const saved = await app.request('PUT', '/settings/global', { json: { stickerUsageSyncEnabled: true } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.global.stickerUsageSyncEnabled, true);

  const sent = await app.request('POST', '/turns', { json: { agentId: 'nova', text: CORRECTION_TEXT } });
  assert.equal(sent.status, 200);
  assert.equal(await wait(() => calls.length > 0), true, '该推出去一趟');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, USAGE_SYNC_TARGET);
  assert.deepEqual(calls[0].payload, { stickerId: SHARED_ID, meaning: MEANING });
});

test('开了开关但她明说只留这里：不推', async (t) => {
  const { app, calls } = await bootWithSticker();
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  await app.request('PUT', '/settings/global', { json: { stickerUsageSyncEnabled: true } });
  const sent = await app.request('POST', '/turns', { json: { agentId: 'nova', text: `${CORRECTION_TEXT}，只留这里别同步` } });
  assert.equal(sent.status, 200);
  await wait(() => calls.length > 0, 300);
  assert.deepEqual(calls, [], '她说了只留这里，就不该推');
});

test('推失败：不谎报，本地纠正和手动入口都还在', async (t) => {
  const { app, calls, setReceiver } = await bootWithSticker();
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  await app.request('PUT', '/settings/global', { json: { stickerUsageSyncEnabled: true } });
  setReceiver({ ok: false, error: '图库里没有这张图' });

  const sent = await app.request('POST', '/turns', { json: { agentId: 'nova', text: CORRECTION_TEXT } });
  assert.equal(sent.status, 200, '同步失败不该影响她这句话被收下');
  assert.equal(await wait(() => calls.length > 0), true);
  assert.equal(calls.length, 1);

  // 本地照样记得这条纠正：手动入口还能读出用法、还能自己再推一次。
  const manual = await app.request('POST', '/library/sticker-correction', { json: { agentId: 'nova', stickerId: SHARED_ID } });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.meaning, MEANING, '本地纠正必须还在');
});

test('普通聊天和普通照片：不推', async (t) => {
  const { app, calls } = await bootWithSticker();
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  await app.request('PUT', '/settings/global', { json: { stickerUsageSyncEnabled: true } });
  await app.request('POST', '/turns', { json: { agentId: 'nova', text: '今天加班累死了' } });
  await app.request('POST', '/turns', { json: { agentId: 'nova', text: '这张图片用错啦，就是被夸了之后假装不在意' } });
  await wait(() => calls.length > 0, 300);
  assert.deepEqual(calls, [], '没有共享图可定位，就不该推');
});
