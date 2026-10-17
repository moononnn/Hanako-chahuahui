import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chahuahui-video-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createStore(root), reopen: () => createStore(root) };
}

test('未设置和新伙伴默认不参与，明确的既有选择跨重开保留', (t) => {
  const f = fixture(t);
  assert.equal(f.store.getPartnerSettings('new_partner').videoSharingEnabled, false);
  f.store.setPartnerSettings('chosen', { videoSharingEnabled: true });
  f.store.setPartnerSettings('declined', { videoSharingEnabled: false });
  assert.equal(f.reopen().getPartnerSettings('chosen').videoSharingEnabled, true);
  assert.equal(f.reopen().getPartnerSettings('declined').videoSharingEnabled, false);
  assert.equal(f.reopen().getPartnerSettings('other').videoSharingEnabled, false);
});

test('名单与额度一次保存，复用原伙伴字段，不影响隐藏及其他设置', (t) => {
  const f = fixture(t);
  f.store.setPartnerSettings('a', { videoSharingEnabled: false, tier: 'often' });
  f.store.setPartnerSettings('b', { videoSharingEnabled: true });
  f.store.setPartnerSettings('hidden', { videoSharingEnabled: true });
  f.store.setGlobalSettings({ rhythmProactiveEnabled: false });
  const saved = f.store.setVideoSharingSettings({ maxPerDay: 2, partnerIds: ['a', 'a'] }, ['a', 'b']);
  assert.deepEqual(saved.partners, [{ id: 'a', videoSharingEnabled: true }, { id: 'b', videoSharingEnabled: false }]);
  const disk = f.reopen();
  assert.equal(disk.getGlobalSettings().videoShareMaxPerDay, 2);
  assert.equal(disk.getGlobalSettings().rhythmProactiveEnabled, false);
  assert.equal(disk.getPartnerSettings('a').videoSharingEnabled, true);
  assert.equal(disk.getPartnerSettings('a').tier, 'often');
  assert.equal(disk.getPartnerSettings('b').videoSharingEnabled, false);
  assert.equal(disk.getPartnerSettings('hidden').videoSharingEnabled, true);
});

test('0条保留参与名单，恢复次数不丢选择，旧伙伴入口仍改同一字段', (t) => {
  const f = fixture(t);
  f.store.setVideoSharingSettings({ maxPerDay: 0, partnerIds: ['a'] }, ['a', 'b']);
  assert.equal(f.reopen().getPartnerSettings('a').videoSharingEnabled, true);
  assert.equal(f.reopen().getGlobalSettings().videoShareMaxPerDay, 0);
  f.store.setGlobalSettings({ videoShareMaxPerDay: 3 });
  assert.equal(f.store.getPartnerSettings('a').videoSharingEnabled, true);
  f.store.setPartnerSettings('a', { videoSharingEnabled: false });
  assert.equal(f.reopen().getPartnerSettings('a').videoSharingEnabled, false);
  assert.equal(f.reopen().getGlobalSettings().videoShareMaxPerDay, 3);
});

test('空参与名单关闭可编辑伙伴，不改范围外伙伴', (t) => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'absent']) f.store.setPartnerSettings(id, { videoSharingEnabled: true });
  f.store.setVideoSharingSettings({ maxPerDay: 5, partnerIds: [] }, ['a', 'b']);
  assert.equal(f.reopen().getPartnerSettings('a').videoSharingEnabled, false);
  assert.equal(f.reopen().getPartnerSettings('b').videoSharingEnabled, false);
  assert.equal(f.reopen().getPartnerSettings('absent').videoSharingEnabled, true);
});

test('错误额度、名单或范围先拒绝，内存和磁盘均无部分修改', (t) => {
  const f = fixture(t);
  f.store.setVideoSharingSettings({ maxPerDay: 2, partnerIds: ['a'] }, ['a', 'b']);
  const file = path.join(f.root, 'v2', 'state.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const value of [
    { maxPerDay: 6, partnerIds: [] }, { maxPerDay: '2', partnerIds: [] },
    { maxPerDay: -1, partnerIds: [] }, { maxPerDay: 1.5, partnerIds: [] },
    { maxPerDay: 1, partnerIds: null }, { maxPerDay: 1 },
    { maxPerDay: 1, partnerIds: [42] }, { maxPerDay: 1, partnerIds: ['hidden'] },
    { maxPerDay: 1, partnerIds: ['__proto__'] },
  ]) {
    assert.throws(() => f.store.setVideoSharingSettings(value, ['a', 'b']));
    assert.equal(f.store.getGlobalSettings().videoShareMaxPerDay, 2);
    assert.equal(f.store.getPartnerSettings('a').videoSharingEnabled, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('保存失败时不更新运行内存或旧磁盘设置，仍可重试', (t) => {
  const f = fixture(t);
  f.store.setVideoSharingSettings({ maxPerDay: 2, partnerIds: ['a'] }, ['a', 'b']);
  const file = path.join(f.root, 'v2', 'state.json');
  const before = fs.readFileSync(file, 'utf8');
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('synthetic-write-failure'), { code: 'EIO' }); });
  assert.throws(() => f.store.setVideoSharingSettings({ maxPerDay: 0, partnerIds: ['b'] }, ['a', 'b']));
  assert.equal(f.store.getGlobalSettings().videoShareMaxPerDay, 2);
  assert.equal(f.store.getPartnerSettings('a').videoSharingEnabled, true);
  assert.equal(f.store.getPartnerSettings('b').videoSharingEnabled, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  mock.mock.restore();
  f.store.setVideoSharingSettings({ maxPerDay: 0, partnerIds: ['b'] }, ['a', 'b']);
  assert.equal(f.reopen().getPartnerSettings('b').videoSharingEnabled, true);
});
