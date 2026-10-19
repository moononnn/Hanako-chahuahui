import test from 'node:test';
import assert from 'node:assert/strict';
import { proactiveSpec, isLowSignalProactive } from '../lib/compose.js';

const common = { partnerName: '阿岚', userName: '阿舟', personaText: '性格克制，不卖萌' };
const seed = { kind: 'self', motifName: '手工玩偶', hook: '耳朵一长一短的布兔', angle: '歪一点反而乖' };

test('搭话与想念是独立由头，不夹带兴趣库存或新发现要求', () => {
  for (const kind of ['contact', 'affection']) {
    const spec = proactiveSpec({ ...common, reason: { kind }, seed, discovery: { interestName: '污染库存', focus: '污染角度' }, searchContext: '污染搜索', hobby: { preference: '污染喜好' } });
    assert.match(spec.userText, /这次联系的由头/);
    assert.doesNotMatch(spec.userText, /歪一点|污染|没有可用的种子或新发现/);
    assert.doesNotMatch(spec.systemPrompt, /主动消息必须落到至少一个|有具体内容的主动话题必须扎根/);
    assert.match(spec.systemPrompt, /性格克制/);
    assert.match(spec.userText, /不把沉默当成|不催/);
  }
});

test('共同经历与吐槽保留明确依据，不强制转回兴趣', () => {
  for (const kind of ['shared', 'tease']) {
    const spec = proactiveSpec({ ...common, reason: { kind, contextText: '同一会话今天一起改了三次配色' }, seed });
    assert.match(spec.userText, /今天一起改了三次配色/);
    assert.doesNotMatch(spec.userText, /这一面：耳朵|没有可用的种子或新发现/);
    assert.match(spec.userText, /来源|依据/);
  }
});

test('缺失依据的共同经历和未知由头不启用关系出口', () => {
  for (const reason of [{ kind: 'shared' }, { kind: 'tease', contextText: '  ' }, { kind: 'unknown' }]) {
    const spec = proactiveSpec({ ...common, reason });
    assert.doesNotMatch(spec.userText, /这次联系的由头/);
    assert.match(spec.userText, /没有可用的种子或新发现/);
  }
});

test('首次对象交代与后续展开只依据实际发出的聊天，不靠后台库存', () => {
  const first = proactiveSpec({ ...common, seed });
  assert.match(first.userText, /首次出现|第一次出现/);
  assert.match(first.userText, /后台.*不代表/);
  assert.match(first.userText, /直观/);
  const later = proactiveSpec({ ...common, seed, introducedText: '此前实际发出：看到一只手工布兔，耳朵一长一短' });
  assert.match(later.userText, /此前实际发出/);
  assert.match(later.userText, /没有明确证据.*首次|没有明确证据.*第一次/);
});

test('只有明确关系搭话出口放行轻联系，空正文和兴趣空问候仍拦', () => {
  assert.equal(isLowSignalProactive('突然想找你聊聊天', { reason: { kind: 'contact' } }), false);
  assert.equal(isLowSignalProactive('忙吗？', { reason: { kind: 'affection' } }), false);
  for (const reason of [undefined, { kind: 'interest' }, { kind: 'shared' }, { kind: 'unknown' }]) {
    assert.equal(isLowSignalProactive('突然想找你聊聊天', { reason }), true);
  }
  assert.equal(isLowSignalProactive(' ', { reason: { kind: 'contact' } }), true);
});

test('空跟进对象不压掉有效联系由头', () => {
  const spec = proactiveSpec({ ...common, reason: { kind: 'contact' }, followup: { count: 0 } });
  assert.match(spec.userText, /这次联系的由头/);
  assert.doesNotMatch(spec.systemPrompt, /有具体内容的主动话题必须扎根/);
});

test('有效联系不再摘上一轮那两行，原文走独立历史', () => {
  const spec = proactiveSpec({ ...common, reason: { kind: 'contact' }, sceneEcho: { userText: '你觉得鸳鸯锅咋样？', assistantText: '先看看' } });
  assert.doesNotMatch(spec.userText, /你觉得鸳鸯锅咋样/);
  assert.doesNotMatch(spec.userText, /她上一轮问了你一件具体的事/);
  assert.match(spec.userText, /最近确实在这条对话里聊过/);
  assert.match(spec.userText, /独立历史/);
  assert.match(spec.userText, /先接那个问题/, '待接问题这层收口照旧在');
});

test('关系由头引用新对象时同样核对实际已介绍记录', () => {
  const spec = proactiveSpec({ ...common, reason: { kind: 'shared', contextText: '一起讨论过玩偶' }, introducedText: '此前实际发出：手工布兔' });
  assert.match(spec.userText, /第一次出现/);
  assert.match(spec.userText, /此前实际发出：手工布兔/);
  assert.match(spec.userText, /单纯搭话和想念不需要另找对象/);
});

test('提醒、醒来和未回应优先，不被新由头占用或放行轻联系', () => {
    for (const extra of [{ todoNudge: '给薄荷浇水' }, { wakeEcho: { sourceText: '我先睡会' } }, { followup: { count: 1, read: false, previousText: '上一条' } }, { followup: { count: 1, read: true, readAgeMs: 1000 } }, { greetingOnly: true }]) {
    const spec = proactiveSpec({ ...common, reason: { kind: 'affection' }, ...extra });
    assert.doesNotMatch(spec.userText, /这次联系的由头/);
  }
});

test('想念可以直接说，但别说完再补一句解释', () => {
  // 实机（2026-10-14）：因想念而发的主动消息连着两条都是开口「我想你了」。
  // 真正难看的是 03:29 那条「我想你了，来抱一下嘛 没啥要紧事，就是这会儿想挨着你待一会儿」
  // ——「没啥要紧事」这句补话等于当场承认前面那句越了界。
  const text = proactiveSpec({ ...common, reason: { kind: 'affection' } }).userText;
  assert.match(text, /不必是她说出口的第一句/);
  assert.match(text, /直说想念就是最对的那句，照直说，不用绕/, '关系本来就直的时候，直说是正路不是让步');
  assert.match(text, /怎么靠近换着来/, '绕着说的路子也得留着，不能只剩一种');
  assert.match(text, /别说完想念再补一句解释自己为什么想她/);
  assert.match(text, /说完就停/);
  assert.match(text, /同一类动作或同一句开头连着出现两次/);
  assert.match(text, /别一律写成软话，也别一律写成撒娇/);
  // 2026-10-16 反馈：抱被当成了唯一出口，14 天里四条想念全落成同一个动作。
  // 身体落点和非身体落点都得留着，别把「换着来」写成只有一条路。
  assert.match(text, /把位置让出来或挪过去/, '身体落点不止一种');
  assert.match(text, /说一件你正想着她的具体小事/, '非身体落点也得留着');
  assert.match(text, /不要让想念只剩下抱这一个出口/);
  // 别的由头不受这条影响
  const contact = proactiveSpec({ ...common, reason: { kind: 'contact' } }).userText;
  assert.doesNotMatch(contact, /我想你了/);
  assert.match(contact, /搭上话的方式换着来/, '搭话也不能每次都同一个动作');
  assert.match(contact, /别每次都用同一个动作/);
});
