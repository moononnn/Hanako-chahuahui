import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootChahuahui } from './helpers/app-harness.js';

test('同步先预览，只有含义仍吻合的确认才转交精确表情 ID 和用法', async t => {
  const calls = [];
  let receiverOk = true;
  const meaning = '猫咪生气炸毛时的叫声';
  const stickerId = 'stk_fixture';
  const index = { schemaVersion: 1, stickers: [{ id: stickerId, file: 'images/test.png' }] };
  const app = await bootChahuahui({
    resources: { read: async target => String(target?.path).endsWith('public-index.json') ? { content: JSON.stringify(index) } : null },
    seed(store, ctx) {
      store.writeMemory('nova', { ...store.readMemory('nova'), stickerCorrections: [{ id: stickerId, meaning, messageId: 'private-message' }] });
      const request = ctx.bus.request;
      ctx.bus.request = async (target, payload, options) => {
        if (!target.endsWith('/sticker/adopt-usage')) return request(target, payload, options);
        calls.push({ target, payload });
        return receiverOk ? { ok: true } : { ok: false, error: '图库没有这张图' };
      };
    },
  });
  t.after(() => fs.rmSync(app.dataDir, { recursive: true, force: true }));
  const send = extra => app.request('POST', '/library/sticker-correction', { json: { agentId: 'nova', stickerId, ...extra } });
  assert.equal((await send({})).body.meaning, meaning);
  assert.equal((await send({ expectedMeaning: '撒娇' })).status, 409);
  assert.equal((await send({ stickerId: 'stk_other', expectedMeaning: meaning })).status, 404);
  assert.deepEqual(calls, []);
  assert.equal((await send({ expectedMeaning: meaning })).body.ok, true);
  assert.deepEqual(calls, [{ target: 'app:biaoqingbao-app/sticker/adopt-usage', payload: { stickerId, meaning } }]);
  receiverOk = false;
  assert.equal((await send({ expectedMeaning: meaning })).status, 502);
});
