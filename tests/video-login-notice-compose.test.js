import test from 'node:test';
import assert from 'node:assert/strict';
import { proactiveSpec } from '../lib/compose.js';

test('登录提醒保留人格与自主拒绝，不混兴趣库存或上一轮问题承接指令', () => {
  const spec = proactiveSpec({ partnerName: '阿岚', userName: '阿舟', personaText: '性格克制，不卖萌',
    videoLoginNotice: { status: 'expired', episodeId: 'test-expiry' },
    seed: { hook: '污染种子', angle: '污染角度' }, discovery: { focus: '污染发现' },
    hobby: { preference: '污染喜好' }, searchContext: '污染搜索',
    sceneEcho: { userText: '这个问题你怎么看？', assistantText: '稍等' }, reason: { kind: 'affection' },
  });
  assert.match(spec.systemPrompt, /性格克制/);
  assert.match(spec.userText, /登录这一步被挡住了/);
  assert.match(spec.userText, /茶话会设置里重新扫码/);
  assert.match(spec.userText, /\[不回\]/);
  assert.doesNotMatch(spec.userText, /污染|把那件事接住|这个问题你怎么看|没有可用的种子或新发现/);
  assert.doesNotMatch(spec.systemPrompt, /主动消息必须落到至少一个|有具体内容的主动话题必须扎根/);
});
