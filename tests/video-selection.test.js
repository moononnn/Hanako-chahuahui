import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVideoResults, makeVideoCandidate, normalizeVideoBook } from '../lib/video-sharing.js';

const now = new Date('2026-10-21T01:00:00Z');
const second = now.getTime() / 1000;
const row = (n, play, age = 1, duration = '02:00') => ({ bvid: `BV1abcdefg${String(n).padStart(2, '0')}`, play, pubdate: second - age * 86400, duration });

test('兴趣优先近30天高播放，不被刚发布的低热度或陈年热门挤走', () => {
  const latest = row(1, 10, 0.1), hot = row(2, 100000, 4), old = row(3, 9000000, 60);
  assert.deepEqual(selectVideoResults([latest, old, hot], { now }).map(x => x.bvid), [hot.bvid, latest.bvid]);
});

test('兴趣的近30天过滤拒绝未知、无效与未来日期，坏重复不遮住有效项', () => {
  const valid = row(1, 100);
  assert.deepEqual(selectVideoResults([
    { ...valid, pubdate: undefined }, { ...row(2, 200), pubdate: 'bad' },
    { ...row(3, 300), pubdate: second + 86400 }, valid,
  ], { now }).map(x => x.bvid), [valid.bvid]);
});

test('两路都去重与预筛长视频，热门保留榜序而非再按最新重排', () => {
  const first = row(1, 10, 8, 100), secondRow = row(2, 999, 1), long = row(3, 100, 1, '16:00');
  assert.deepEqual(selectVideoResults([first, secondRow, first, long, { bvid: 'bad' }], { source: 'popular', now }).map(x => x.bvid), [first.bvid, secondRow.bvid]);
  assert.deepEqual(selectVideoResults([first, secondRow], { seen: new Set([`${first.bvid}:1`]), now }).map(x => x.bvid), [secondRow.bvid]);
  assert.equal(selectVideoResults(Array.from({ length: 10 }, (_, i) => row(i, i)), { now }).length, 5);
});

test('热门候选重读仍保留真实来源，不伪造长期兴趣；旧记录兼容', () => {
  const video = { bvid: row(1, 1).bvid, cid: 123, page: 1, duration: 100, title: '好玩的事情', link: `https://www.bilibili.com/video/${row(1, 1).bvid}` };
  const candidate = makeVideoCandidate({ video, readKind: 'subtitle', subtitle: [{ content: '一个有意思的事情' }] }, { source: 'popular' }, now);
  assert.equal(candidate.source, 'popular');
  assert.equal(candidate.interestId, '');
  const saved = normalizeVideoBook({ pending: [candidate], shares: [] }, now).pending[0];
  assert.equal(saved.source, 'popular');
  delete candidate.source;
  assert.equal(normalizeVideoBook({ pending: [candidate] }, now).pending[0].source, 'interest');
});
