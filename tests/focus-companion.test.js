import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFocusCompanion, focusRunning, focusReminderSpec, focusChatText } from '../lib/focus-companion.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const startAt = Date.parse('2026-10-12T13:00:00Z');
const makeActive = () => ({ id: 'session-1', phase: 'focus', startedAt: new Date(startAt).toISOString(),
  targetAt: new Date(startAt + 30 * 60_000).toISOString(), plannedMinutes: 30, companionId: 'reader', companionName: '搭子', taskTitle: '读书' });
function fixture(send = async () => true, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-focus-'));
  const handlers = {};
  let value = { ok: true, active: makeActive(), session: null };
  let clock = startAt;
  const ctx = { dataDir: dir, bus: { handle(name, fn, options) { handlers[name] = { fn, options }; }, request: async () => value } };
  const options = { ctx, listPartners: async () => [{ id: 'reader', name: '搭子' }], send, now: () => clock, ...extra };
  let controller = createFocusCompanion(options);
  return { dir, handlers, get controller() { return controller; }, options,
    setValue(next) { value = next; }, setClock(next) { clock = next; },
    reopen() { controller.dispose(); controller = createFocusCompanion(options); },
    close() { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('专注有效期：暂停、休息、到点均解除主动暂停，未知时间不算有效', () => {
  assert.equal(focusRunning(makeActive(), startAt), true);
  assert.equal(focusRunning({ ...makeActive(), pausedAt: 'now' }, startAt), false);
  // 轮间休息不拦主动消息：那是她给自己留的空，不是在读（2026-10-14 定）。
  assert.equal(focusRunning({ ...makeActive(), phase: 'break' }, startAt), false);
  assert.equal(focusRunning(makeActive(), startAt + 30 * 60_000), false);
  assert.equal(focusRunning({ ...makeActive(), targetAt: 'bad' }, startAt), false);
  // 休息段也不该给普通回复挂“正在专注”的上下文。
  assert.equal(focusChatText({ active: { ...makeActive(), phase: 'break' }, agentId: 'other', userName: '阿舟', now: startAt }), '');
});

test('双向服务：调用方限定、跨App开放、开始提醒持久去重及重载不重发', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return true; });
  try {
    await assert.rejects(f.handlers['focus/partners'].fn({}, { callerAppId: 'other' }), /只接受/);
    assert.equal(f.handlers['focus/partners'].options.allowCrossApp, true);
    assert.equal(f.handlers['focus/sync'].options.allowCrossApp, true);
    assert.deepEqual((await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' })).partners, [{ id: 'reader', name: '搭子' }]);
    await f.controller.sync(); await f.controller.settled();
    await f.controller.sync(); await f.controller.settled();
    assert.deepEqual(sent, ['start']);
    f.reopen(); await f.controller.sync(); await f.controller.settled();
    assert.deepEqual(sent, ['start']);
  } finally { f.close(); }
});

test('任意伙伴发言只触发事件提醒：连发合并，持续聊天不重催，间隔90秒算新一阵', async () => {
  const sent = [];
  const f = fixture(async event => {
    sent.push(event);
    return event.kind !== 'distracted' || sent.filter(row => row.kind === 'distracted').length !== 5;
  });
  try {
    await f.controller.sync(); await f.controller.settled();
    await f.controller.userSpoke(); await f.controller.userSpoke();
    await pause(1550); await f.controller.settled();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].kind, 'distracted');
    assert.equal(sent[1].text, undefined);
    await f.controller.userSpoke(); await pause(1550); await f.controller.settled();
    assert.equal(sent.length, 2);
    // 每60秒说一句：总时长超过旧冷却，仍然只是同一阵聊天。
    for (let i = 1; i <= 4; i++) {
      f.setClock(startAt + i * 60_000);
      await f.controller.userSpoke();
    }
    await pause(1550); await f.controller.settled();
    assert.equal(sent.filter(row => row.kind === 'distracted').length, 1);
    f.reopen();
    f.setClock(startAt + 5 * 60_000);
    await f.controller.userSpoke(); await pause(1550); await f.controller.settled();
    assert.equal(sent.filter(row => row.kind === 'distracted').length, 1, '重载仍合并同一阵');
    for (let i = 1; i <= 4; i++) {
      f.setClock(startAt + 5 * 60_000 + i * 90_000);
      await f.controller.userSpoke(); await pause(1550); await f.controller.settled();
    }
    assert.equal(sent.filter(row => row.kind === 'distracted').length, 5, '新一阵都主动招呼，不受旧三次上限限制');
    const status = await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' });
    assert.equal(status.reminderStatus.failed, true, '超过旧三次上限的失败仍可见');
    f.setValue({ ok: true, active: null });
    await f.controller.sync(); await f.controller.settled();
    const ended = await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' });
    assert.equal(ended.reminderStatus.failed, true, '结束后仍保留上一段第五次失败状态');
  } finally { f.close(); }
});

test('暂停与恢复不重复开始，结束恢复并只收尾一次', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return true; });
  try {
    await f.controller.sync(); await f.controller.settled();
    f.setValue({ ok: true, active: { ...makeActive(), pausedAt: new Date(startAt).toISOString() } });
    await f.controller.sync(); assert.equal(f.controller.active(), null);
    f.setValue({ ok: true, active: makeActive() });
    await f.controller.sync(); await f.controller.settled();
    f.setValue({ ok: true, active: null, session: { id: 'session-1', status: 'interrupted', endedAt: new Date(startAt).toISOString() } });
    await f.controller.sync(); await f.controller.settled();
    await f.controller.sync(); await f.controller.settled();
    assert.equal(f.controller.active(), null);
    assert.deepEqual(sent, ['start', 'end']);
  } finally { f.close(); }
});

test('生成中结束：旧开始提醒失效；失败不自动重试，离线旧收尾不补发', async () => {
  let release;
  const f = fixture(async event => {
    if (event.kind === 'start') {
      await new Promise(resolve => { release = resolve; });
      return event.isCurrent();
    }
    return true;
  });
  try {
    await f.controller.sync(); await pause(1);
    f.setValue({ ok: true, active: null }); await f.controller.sync();
    release(); await f.controller.settled();
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2', 'focus-companion.json'), 'utf8'));
    assert.equal(disk.claims['session-1:start'], 'stale');
    f.setValue({ ok: true, active: makeActive() }); await f.controller.sync(); await f.controller.settled();
    f.setClock(startAt + 40 * 60_000);
    f.setValue({ ok: true, active: null, session: { status: 'completed', endedAt: makeActive().targetAt } });
    await f.controller.sync(); await f.controller.settled();
    assert.equal(f.controller.active(), null);
  } finally { f.close(); }
});

test('开始提醒生成迟到后不投递，显示过期而非模型失败', async () => {
  let entered, release;
  const begun = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const f = fixture(async event => { entered(); await hold; return event.isCurrent(); });
  try {
    await f.controller.sync(); await begun;
    f.setClock(startAt + 61_000); release(); await f.controller.settled();
    const state = await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' });
    assert.equal(state.reminderStatus.start, 'stale');
    assert.equal(state.reminderStatus.failed, false);
  } finally { release(); f.close(); }
});

test('跨实例原子认领：同一段同时同步只产生一次开始提醒', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return true; });
  const other = createFocusCompanion(f.options);
  try {
    await Promise.all([f.controller.sync(), other.sync()]);
    await Promise.all([f.controller.settled(), other.settled()]);
    assert.deepEqual(sent, ['start']);
  } finally { other.dispose(); f.close(); }
});

test('结束提醒失败留在已结束状态，缺开始认领的旧时段不补发开始', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return event.kind !== 'end'; });
  try {
    await f.controller.sync(); await f.controller.settled();
    f.setValue({ ok: true, active: null });
    await f.controller.sync(); await f.controller.settled();
    const state = await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' });
    assert.equal(state.reminderStatus.sessionId, 'session-1');
    assert.equal(state.reminderStatus.end, 'failed');
    assert.equal(state.reminderStatus.failed, true);
    f.setClock(startAt + 2 * 60_000);
    f.setValue({ ok: true, active: { ...makeActive(), id: 'old-session' } });
    await f.controller.sync(); await f.controller.settled();
    assert.deepEqual(sent, ['start', 'end']);
  } finally { f.close(); }
});

test('陪读头像：只向拾光记发名单内伙伴的真图，越界编号和超大连空', async () => {
  // 真实的 1×1 PNG，不是凑出来的魔数。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // 闸门抬到 6MB 后，1~2MB 的宿主头像要能过；这里用 7MB 验真正超限仍被挡。
  const big = Buffer.alloc(7 * 1024 * 1024, 1);
  const seen = [];
  const f = fixture(async () => true, {
    listPartners: async () => [{ id: 'reader', name: '搭子' }, { id: 'mid', name: '大图伙伴' }, { id: 'huge', name: '超大图伙伴' }],
    partnerAvatar: async (id) => { seen.push(id); return { bytes: id === 'huge' ? big : id === 'mid' ? Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024, 1)]) : png, contentType: 'image/png' }; },
  });
  try {
    await assert.rejects(f.handlers['focus/avatar'].fn({}, { callerAppId: 'other' }), /只接受/);
    assert.equal(f.handlers['focus/avatar'].options.allowCrossApp, true);
    const found = await f.handlers['focus/avatar'].fn({ agentId: 'reader' }, { callerAppId: 'shiguangji-app' });
    assert.equal(found.ok, true);
    assert.equal(found.avatar.contentType, 'image/png');
    assert.deepEqual(Buffer.from(found.avatar.base64, 'base64'), png);
    // 1~2MB 的宿主头像必须能过，否则界面又只剩首字。
    const mid = await f.handlers['focus/avatar'].fn({ agentId: 'mid' }, { callerAppId: 'shiguangji-app' });
    assert.equal(mid.avatar.contentType, 'image/png');
    assert.ok(Buffer.from(mid.avatar.base64, 'base64').length > 2 * 1024 * 1024);
    for (const agentId of ['', 'x'.repeat(65), '../secret', 'bad id', 'a/b', '__proto__', 'stranger', 'huge']) {
      const empty = await f.handlers['focus/avatar'].fn({ agentId }, { callerAppId: 'shiguangji-app' });
      assert.equal(empty.avatar, null, agentId);
    }
    // 名单外的编号连头像都不查，不给“猜一个编号就读一张图”的口子。
    assert.ok(!seen.includes('stranger') && !seen.includes('../secret') && !seen.includes('bad id'));
    assert.ok(!JSON.stringify(found).includes(f.dir));
  } finally { f.close(); }
});

test('陪读头像与页面共用同一份判定，规则只在 index 里写一次', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /async function resolvePartnerAvatar\(agentId\)/);
  assert.match(index, /await resolvePartnerAvatar\(raw\)/);
  assert.match(index, /partnerAvatar: async \(agentId\) =>/);
  assert.doesNotMatch(index, /getAvatar\("agent", kind === "user"/);
  // 编号闸跟页面那条路由同一个，不另写一份宽松的。
  const lib = fs.readFileSync(new URL('../lib/focus-companion.js', import.meta.url), 'utf8');
  assert.match(lib, /import \{ isValidPartnerId \} from '\.\/partner-id\.js'/);
  assert.match(lib, /if \(!isValidPartnerId\(agentId\)\) return \{ ok: true, avatar: null \}/);
});

test('陪读口径：按性格、不读取其他私聊、完成只说明计时，不常驻普通聊天', () => {
  const distracted = focusReminderSpec({ active: makeActive(), kind: 'distracted', userName: '阿舟' });
  assert.match(distracted.system, /嘴损|粗口/);
  assert.match(distracted.system, /不贬低/);
  assert.match(distracted.system, /不追问/);
  assert.match(distracted.user, /不知道其他聊天正文/);
  assert.match(distracted.user, /不知道聊天对象/);
  assert.match(distracted.user, /主动招呼/);
  const end = focusReminderSpec({ active: makeActive(), kind: 'end', session: { status: 'completed' } });
  assert.match(end.user, /没有证据证明/);
  assert.doesNotMatch(end.system, /这次开小差/);
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /await focusCompanion\.userSpoke\(\{ agentId, messageId: stored\.id \}\)/);
  assert.match(index, /message\.proactive \|\| message\.nudge/);
  assert.match(index, /if \(focusCompanion\.active\(\)\) return \{ ok: false, reason: 'focus'/);
  assert.match(index, /allowUtilityFallback: false/);
  assert.match(index, /if \(from === 'partner' && focusCompanion\.active\(\)\) return null;\s*const stored = store\.appendMessage/);
  assert.match(index, /if \(focusCompanion\.active\(\)\) \{ report\.push.*reason: 'focus'.*continue; \}\s*const fedAt/);
  assert.match(index, /if \(!action\) return \{ ok: false, reason: 'focus', gateBlocked: true \}/);
});

test('开始场景自然帮进入状态，自身确认按真话接住，不要求接单或逐项计时', () => {
  const start = focusReminderSpec({ active: makeActive(), kind: 'start', userName: '阿舟' });
  assert.match(start.user, /阿舟刚开始一段 30 分钟的专注/);
  assert.doesNotMatch(start.user, /接下约定|提醒开始|刚选你/);
  assert.match(start.system, /招呼对方进入新一轮的状态/);
  assert.match(start.system, /目标和时长是背景/);
  assert.doesNotMatch(start.system, /数落这次跑来聊天/);
  const reply = focusReminderSpec({ active: makeActive(), kind: 'reply', userName: '阿舟' });
  assert.match(reply.system, /先接住对方实际说的这句话/);
  assert.match(reply.system, /确认会回去专注/);
  assert.doesNotMatch(reply.user, /跑来茶话会闲聊了|不知道聊天对象/);
});

test('多轮口径：分得出第几轮、共几轮，轮次进提醒但不进普通聊天', () => {
  const plan = { ...makeActive(), setId: 'set-1', roundIndex: 2, totalRounds: 3 };
  const start = focusReminderSpec({ active: plan, kind: 'start', userName: '阿舟' });
  assert.match(start.user, /第 2 轮/);
  assert.match(start.user, /3 轮/);
  // 进度感是她的需求，不是可选修饰：得告诉还剩几轮，但不排成报菜名。
  assert.match(start.user, /还剩 1 轮/);
  assert.match(start.system, /轮数、时长、休息分钟数排成一串念出来|挑自然的地方提一两句/);
  assert.match(start.system, /别把轮数、时长、休息分钟数排成一串念出来/);
  assert.match(start.system, /像陪着数进度的人随口说一句/);
  // 中途收尾：还有下一轮，不能说成整组做完了，也不能催着立刻开下一轮。
  const mid = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'completed', roundIndex: 2, totalRounds: 3,
    breakKindAfter: 'short', shortBreakMinutes: 5, longBreakMinutes: 10 } });
  assert.match(mid.user, /第 2 轮（共 3 轮）/);
  assert.match(mid.user, /接下来是休息 5 分钟/);
  assert.match(mid.user, /之后还剩 1 轮/);
  assert.match(mid.user, /让她知道歇多久、还剩几轮/);
  assert.match(mid.user, /别把整组说成做完/);
  // 长休的分钟数不能拿短休的冒充。
  const longRest = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'completed', roundIndex: 2, totalRounds: 3,
    breakKindAfter: 'long', shortBreakMinutes: 5, longBreakMinutes: 10 } });
  assert.match(longRest.user, /接下来是长休息 10 分钟/);
  assert.doesNotMatch(longRest.user, /长休息 5 分钟/);
  // 提前结束也按剩下的轮数说，不当成完成。
  const cut = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'interrupted', roundIndex: 2, totalRounds: 3 } });
  assert.match(cut.user, /整组 3 轮里还剩 1 轮没做/);
  // 末轮没有“还有”，单轮老记录没有轮次字段，两种都不编数字。
  const last = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'completed', roundIndex: 3, totalRounds: 3 } });
  assert.doesNotMatch(last.user, /之后还剩/);
  const single = focusReminderSpec({ active: makeActive(), kind: 'end', session: { status: 'completed' } });
  assert.match(single.user, /约定的计时已到/);
  assert.doesNotMatch(single.user, /第 \d 轮/);
  assert.doesNotMatch(single.system, /像陪着数进度的人随口说一句/);
  // 轮次字段随同步进本地状态，但不因此把休息阶段当成进行中。
  assert.equal(focusRunning({ ...plan, phase: 'break' }, startAt), false);
});

test('休息结束自动开下一轮：开场得说清歇了多久，别只说“又一轮”', () => {
  const resumed = focusReminderSpec({ active: { ...makeActive(), setId: 'set-1', roundIndex: 2, totalRounds: 3,
    afterBreak: { minutes: 5, kind: 'short', roundIndex: 1 } }, kind: 'start', userName: '阿舟' });
  assert.match(resumed.user, /刚才的 5 分钟休息结束了/);
  assert.match(resumed.user, /现在开始第 2 轮（共 3 轮）/);
  // 单轮计划没有 afterBreak 时按原来那句写，不凭空造休息。
  const plain = focusReminderSpec({ active: makeActive(), kind: 'start', userName: '阿舟' });
  assert.doesNotMatch(plain.user, /休息结束/);
  const lib = fs.readFileSync(new URL('../lib/focus-companion.js', import.meta.url), 'utf8');
  assert.match(lib, /previous\?\.phase === 'break' && previous\.id !== next\?\.id/);
  assert.match(lib, /queue\('start', afterBreak \? \{ \.\.\.next, afterBreak \} : next\)/);
});

test('陪读提醒也拿钟点：早不说晚安，不拿钟点当素材，正文不出现【日期 时间】标题', () => {
  const spec = focusReminderSpec({ active: makeActive(), kind: 'start', userName: '阿舟' });
  assert.match(spec.system, /背景里的钟点只是让你知道现在几点/);
  assert.match(spec.system, /别拿它编消息里的时间/);
  assert.match(spec.system, /早上不要说晚安/);
  assert.match(spec.system, /正文第一行不许出现【日期 时间】这类标题/);
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /import \{ splitReply, stripTimeHeader \} from "\.\/lib\/split\.js"/);
  assert.match(index, /const timeText = timeBlock\(\{ now: new Date\(\), messages: ownMessages, userName: USER_NAME,/);
  assert.match(index, /const text = stripTimeHeader\(cleanVoice\(/);
});

test('整组结束与单轮结束是两件事（2026-10-14 实机：最后说“下一轮再说”）', () => {
  const plan = { ...makeActive(), setId: 'set-1', roundIndex: 3, totalRounds: 3 };
  const last = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'completed', roundIndex: 3, totalRounds: 3 } });
  // 最后一轮收完 = 整组走完，必须说清没有下一轮。
  assert.match(last.user, /第 3 轮（共 3 轮）的计时到了，这一整组专注到此全部结束/);
  assert.match(last.user, /没有下一轮了，这段约定已经完整走完/);
  assert.match(last.user, /回头看一眼这一组走过的几轮/);
  assert.match(last.user, /累不累、要不要起来、眼睛肩颈/);
  assert.match(last.system, /整组专注的终点/);
  assert.match(last.system, /让对方知道你一路陪到了这里/);
  assert.match(last.system, /不要说“下一轮”“下次再”/);
  // 收整组给多几句的余地，其余提醒仍然一两句。
  assert.match(last.system, /这一次可以比平时多说几句/);
  const distracted = focusReminderSpec({ active: makeActive(), kind: 'distracted', userName: '阿舟' });
  assert.match(distracted.system, /不追问、不开新话题/);
  assert.doesNotMatch(distracted.system, /这一次可以比平时多说几句/);
  // 最后一轮提前结束：整组到此为止，但不假装做完。
  const cut = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'interrupted', roundIndex: 3, totalRounds: 3 } });
  assert.match(cut.user, /这是整组的最后一轮，整组到此为止/);
  assert.match(cut.user, /没做完的部分别替他当成做完了/);
  assert.match(cut.system, /整组专注的终点/);
  // 中途轮次不受影响：仍短、仍报还剩几轮、仍不能说成做完。
  const mid = focusReminderSpec({ active: plan, kind: 'end', session: { status: 'completed', roundIndex: 2, totalRounds: 3,
    breakKindAfter: 'short', shortBreakMinutes: 5, longBreakMinutes: 10 } });
  assert.match(mid.user, /之后还剩 1 轮/);
  assert.doesNotMatch(mid.user, /到此全部结束/);
  assert.doesNotMatch(mid.system, /整组专注的终点/);
  // 单轮结束的旧口径不变。
  const single = focusReminderSpec({ active: makeActive(), kind: 'end', session: { status: 'completed' } });
  assert.match(single.user, /约定的计时已到/);
  assert.doesNotMatch(single.user, /到此全部结束/);
  const singleCut = focusReminderSpec({ active: makeActive(), kind: 'end', session: { status: 'interrupted' } });
  assert.doesNotMatch(singleCut.user, /整组的最后一轮/);
});

test('每条提醒只讲眼前这一件事：不接上一轮客套，不把没答的问题换个说法再问', () => {
  for (const kind of ['start', 'distracted', 'end']) {
    const spec = focusReminderSpec({ active: makeActive(), kind, session: { status: 'completed' }, userName: '阿舟' });
    assert.match(spec.user, /这一次只说眼前这一件事/, kind);
    assert.match(spec.user, /不要回应、感谢或重复上一轮说过的话/, kind);
    assert.match(spec.user, /她没答就当没这回事/, kind);
  }
  const reply = focusReminderSpec({ active: makeActive(), kind: 'reply', userName: '阿舟' });
  // 真在回她哪句时，这条约束也只在末尾，不许盖掉“先接住实际那句话”那条。
  assert.match(reply.system, /先接住对方实际说的这句话/);
  assert.match(reply.user, /这一次只说眼前这一件事/);
  assert.match(focusReminderSpec({ active: makeActive(), kind: 'start', userName: '阿舟' }).system, /不要先接上一轮的客套或夸奖/);
});

test('陪读消息也切气泡，且只有真在回她哪句时才带历史', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // 一坨一泡：界面上比普通回复粗一档（2026-10-14 实机）。
  assert.match(index, /const bubbles = splitReply\(text\);\s*if \(!bubbles\.length\) return false;/);
  assert.doesNotMatch(index, /role: 'assistant', text, bubbles: \[text\],\s*focusReminder/);
  // 开场、收尾、走神一律不带上一轮正文：收尾读到就会把刚聊完的话题再捡一遍（2026-10-14 实机）。
  assert.match(index, /const HISTORY_LIMIT = \{ start: 0, distracted: 0, end: 0 \}/);
  assert.match(index, /const replyEnd = ownMessageId \? visible\.findIndex/);
  assert.match(index, /const count = ownMessageId \? replyEnd : \(HISTORY_LIMIT\[kind\] \?\? 2\)/);
  assert.match(index, /const ownRows = \(count > 0 \? visible\.slice\(-count\) : \[\]\)/);
});

test('自己的话绕过外部闲聊冷却、连发合并最新ID，外部事件仍无正文和身份', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event); return true; });
  try {
    await f.controller.sync(); await f.controller.settled();
    await f.controller.userSpoke({ agentId: 'peer', messageId: 'peer-secret-id', text: 'peer-secret-text' });
    await pause(1550); await f.controller.settled();
    assert.equal(sent[1].kind, 'distracted');
    assert.equal(sent[1].ownMessageId, null);
    assert.doesNotMatch(JSON.stringify(sent[1]), /peer-secret/);
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-1' });
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-2' });
    await f.controller.userSpoke({ agentId: 'peer', messageId: 'peer-secret-id' });
    await pause(1550); await f.controller.settled();
    assert.equal(sent.length, 3);
    assert.equal(sent[2].kind, 'reply');
    assert.equal(sent[2].ownMessageId, 'own-2');
    assert.doesNotMatch(JSON.stringify(sent[2]), /peer-secret/);
  } finally { f.close(); }
});

test('自身确认不污染外部聊天阵次，稍后第一阵其他闲聊仍主动提醒', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return true; });
  try {
    await f.controller.sync(); await f.controller.settled();
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-1' });
    await pause(1550); await f.controller.settled();
    f.setClock(startAt + 30_000);
    await f.controller.userSpoke({ agentId: 'peer', messageId: 'peer-1' });
    await pause(1550); await f.controller.settled();
    assert.deepEqual(sent, ['start', 'reply', 'distracted']);
    for (let i = 1; i <= 3; i++) {
      f.setClock(startAt + 30_000 + i * 60_000);
      await f.controller.userSpoke({ agentId: 'peer', messageId: `peer-${i + 1}` });
    }
    await pause(1550); await f.controller.settled();
    assert.deepEqual(sent, ['start', 'reply', 'distracted'], '外部持续聊天仍只提醒一次');
  } finally { f.close(); }
});

test('自身回应排队超过90秒不补旧话，计数是认领流水号而非次数额度', async () => {
  let enter, release;
  const begun = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const sent = [];
  const f = fixture(async event => {
    if (event.kind === 'start') { enter(); await hold; }
    if (event.isCurrent()) { sent.push(event.kind); return true; }
    return false;
  });
  try {
    await f.controller.sync(); await begun;
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-old' });
    await pause(1550);
    f.setClock(startAt + 91_000);
    release(); await f.controller.settled();
    assert.deepEqual(sent, []);
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2', 'focus-companion.json'), 'utf8'));
    assert.equal(disk.claims['session-1:distracted-1'], 'stale');
    assert.equal((await f.handlers['focus/partners'].fn({}, { callerAppId: 'shiguangji-app' })).reminderStatus.failed, false);
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-new' });
    await pause(1550); await f.controller.settled();
    assert.deepEqual(sent, ['reply']);
  } finally { release(); f.close(); }
});

test('自身新话使在途旧稿失效，下一稿接最新消息而非再次发旧催促', async () => {
  let enter, release;
  const begun = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const sent = [];
  const f = fixture(async event => {
    if (event.ownMessageId === 'own-1') { enter(); await hold; }
    if (event.isCurrent()) { sent.push(event.ownMessageId || event.kind); return true; }
    return false;
  });
  try {
    await f.controller.sync(); await f.controller.settled();
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-1' });
    await begun;
    await f.controller.userSpoke({ agentId: 'reader', messageId: 'own-2' });
    await pause(1550);
    release(); await f.controller.settled();
    assert.deepEqual(sent, ['start', 'own-2']);
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2', 'focus-companion.json'), 'utf8'));
    assert.equal(disk.claims['session-1:distracted-1'], 'stale');
    assert.equal(disk.claims['session-1:distracted-2'], 'sent');
  } finally { release(); f.close(); }
});

test('其他伙伴只获当下目标，保留性格关系回应；不扩散陪读身份或其他私聊', () => {
  const active = { ...makeActive(), companionId: 'private-reader-id', companionName: 'private-reader-name', text: 'private-chat-secret' };
  const text = focusChatText({ active, agentId: 'peer', userName: '阿舟', now: startAt });
  assert.match(text, /读书/);
  assert.match(text, /阿舟正在专注/);
  assert.match(text, /性格与关系/);
  assert.match(text, /不必每轮都劝/);
  assert.match(text, /状态要实际参与回应/);
  assert.match(text, /无论劝回还是陪聊/);
  assert.match(text, /明确知道专注约定仍在/);
  assert.match(text, /知情地允许短聊/);
  assert.match(text, /主动找你而愿意偷偷破例/);
  assert.match(text, /不统一演宠溺或纵容/);
  assert.match(text, /不能让状态从回应里消失/);
  assert.match(text, /不机械播报专注状态/);
  assert.doesNotMatch(text, /private-reader-id|private-reader-name|private-chat-secret/);
  for (const value of [null, { ...active, pausedAt: 'now' }, { ...active, phase: 'break' }, { ...active, targetAt: 'bad' }]) {
    assert.equal(focusChatText({ active: value, agentId: 'peer', now: startAt }), '');
  }
  assert.equal(focusChatText({ active, agentId: active.companionId, now: startAt }), '');
  assert.equal(focusChatText({ active, agentId: 'peer', now: startAt + 30 * 60_000 }), '');
});

test('闲聊提醒生成中暂停再恢复或超过90秒，旧稿仍作废', async () => {
  for (const mode of ['resume', 'late']) {
    let entered, release;
    const begun = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const sent = [];
    const f = fixture(async event => {
      if (event.kind === 'distracted') { entered(); await hold; }
      if (!event.isCurrent()) return false;
      sent.push(event.kind); return true;
    });
    try {
      await f.controller.sync(); await f.controller.settled();
      await f.controller.userSpoke(); await begun;
      if (mode === 'resume') {
        f.setValue({ ok: true, active: { ...makeActive(), pausedAt: new Date(startAt).toISOString() } });
        await f.controller.sync();
        f.setValue({ ok: true, active: { ...makeActive(), targetAt: new Date(startAt + 31 * 60_000).toISOString() } });
        await f.controller.sync();
      } else f.setClock(startAt + 90_000);
      release(); await f.controller.settled();
      assert.deepEqual(sent, ['start']);
      const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2', 'focus-companion.json'), 'utf8'));
      assert.equal(disk.claims['session-1:distracted-1'], 'stale');
    } finally { release(); f.close(); }
  }
});

test('旧冷却账本升级保守合并；新专注段重置聊天阵次', async () => {
  const sent = [];
  const f = fixture(async event => { sent.push(event.kind); return true; });
  try {
    await f.controller.sync(); await f.controller.settled();
    const file = path.join(f.dir, 'v2', 'focus-companion.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.reminderAt = startAt; state.reminderCount = 1; delete state.lastSpokeAt;
    fs.writeFileSync(file, JSON.stringify(state));
    f.reopen(); f.setClock(startAt + 60_000);
    await f.controller.userSpoke(); await pause(1550); await f.controller.settled();
    assert.deepEqual(sent, ['start']);
    f.setValue({ ok: true, active: { ...makeActive(), id: 'session-2', startedAt: new Date(startAt + 60_000).toISOString() } });
    await f.controller.sync(); await f.controller.settled();
    await f.controller.userSpoke(); await pause(1550); await f.controller.settled();
    assert.deepEqual(sent, ['start', 'start', 'distracted']);
  } finally { f.close(); }
});

test('开场生成中暂停恢复不补旧开场；提醒排队超过90秒也不补发', async () => {
  for (const mode of ['start-resume', 'queued-late']) {
    let entered, release;
    const begun = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const attempted = [];
    const f = fixture(async event => {
      attempted.push(event.kind);
      if (event.kind === 'start') { entered(); await hold; }
      return event.isCurrent();
    });
    try {
      await f.controller.sync(); await begun;
      if (mode === 'start-resume') {
        f.setValue({ ok: true, active: { ...makeActive(), pausedAt: new Date(startAt).toISOString() } });
        await f.controller.sync();
        f.setValue({ ok: true, active: { ...makeActive(), targetAt: new Date(startAt + 31 * 60_000).toISOString() } });
        await f.controller.sync();
      } else {
        await f.controller.userSpoke(); await pause(1550);
        f.setClock(startAt + 90_000);
      }
      release(); await f.controller.settled();
      assert.deepEqual(attempted, ['start'], '过期排队提醒连模型都不请求');
      const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2', 'focus-companion.json'), 'utf8'));
      assert.equal(disk.claims['session-1:start'], 'stale');
      if (mode === 'queued-late') assert.equal(disk.claims['session-1:distracted-1'], 'stale');
      await f.controller.sync(); await f.controller.settled();
      assert.deepEqual(attempted, ['start'], '恢复或过期不重新认领开场');
    } finally { release(); f.close(); }
  }
});
