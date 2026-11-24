import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStickerCorrections, stickerCorrectionFrom, normalizeStickerCorrections } from '../lib/sticker-corrections.js';
import { buildCatalog, encodeStickerBubble, pickSticker } from '../lib/stickers.js';

const at = '2026-11-18T12:00:00Z';
const sticker = (id, role, key = id) => ({ id: key, role, at, bubbles: [encodeStickerBubble(id)] });
const note = { id: 'note', role: 'user', at: '2026-11-18T12:01:00Z', text: '你理解错这个表情包的意思了？老吴老吴，就是猫咪生气炸毛时候的叫声啦' };
const options = { allowedIds: new Set(['stk_a', 'stk_b']), aliases: new Map([['local_a', 'stk_a']]) };

test('相邻的本地副本和原图绑定到同一张，旧标签退出选图', () => {
  const found = stickerCorrectionFrom(note, [sticker('local_a', 'user'), sticker('stk_a', 'assistant')], options);
  assert.deepEqual(found, { id: 'stk_a', meaning: '猫咪生气炸毛时候的叫声', messageId: 'note' });
  const catalog = buildCatalog({ stickers: [{ id: 'stk_a', emotion: ['撒娇'], description: '喊人' }] }, 'hanako');
  const updated = applyStickerCorrections(catalog, [found]);
  assert.equal(pickSticker(updated, { keyword: '炸毛' })?.id, 'stk_a');
  assert.equal(pickSticker(updated, { keyword: '撒娇' }), null);
  assert.equal(pickSticker(updated, { keyword: '喊人' }), null);
  assert.equal(pickSticker(catalog, { keyword: '撒娇' })?.id, 'stk_a');
});

test('两张不同的表情不猜，引用优先；普通纠正不入表情记忆', () => {
  const history = [sticker('stk_b', 'user'), sticker('stk_a', 'assistant')];
  assert.equal(stickerCorrectionFrom(note, history, options), null);
  assert.equal(stickerCorrectionFrom({ ...note, quote: { messageId: 'stk_b' } }, history, options)?.id, 'stk_b');
  assert.equal(stickerCorrectionFrom({ ...note, text: '理解错啦，就是太晚了' }, [history[1]], options), null);
  assert.equal(stickerCorrectionFrom({ ...note, text: '这张用错啦' }, [history[1]], options), null);
  assert.equal(stickerCorrectionFrom({ ...note, recalled: true }, [history[1]], options), null);
});

test('同一张图重复纠正时保留新说法', () => {
  const rows = [{ id: 'stk_a', meaning: '旧用法', messageId: 'm1' }, { id: 'stk_a', meaning: '炸毛', messageId: 'm2' }];
  assert.deepEqual(normalizeStickerCorrections(rows), [rows[1]]);
});
