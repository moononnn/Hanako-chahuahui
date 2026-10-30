// 哨兵剥离：与 ReleaseKit.ps1 的 Remove-DevOnlyBlocks 同规则。
// 哨兵必须成对、各自独占一行（前面只允许缩进）；不配对或剥不干净一律抛错，不做「尽力而为」。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { match, toSlash } from './ps.mjs';

/**
 * 历史文档：叙述性正文，允许出现 residue 词（CHANGELOG 里写「内测过」「DEV_TOOLS」是事实记录）。
 * 与本地一致的是「只豁免残留检查」，隐私/本机路径/红线那道门照走不误。
 *
 * 只认精确根文件名：backend/CHANGELOG.md、docs/CHANGELOG.md 都不算历史文档。
 */
export const HISTORICAL_DOCS = new Set(['changelog.md']); // 一律小写：isHistoricalDoc 做大小写不敏感比对

/** 精确根 CHANGELOG.md 才享受历史文档语义，其余一律按源码/配置查残留。
 * 大小写不敏感：PowerShell -eq 与 Windows 文件名都不分大小写。 */
export function isHistoricalDoc(rel) {
  return typeof rel === 'string' && HISTORICAL_DOCS.has(toSlash(rel).toLowerCase());
}

/**
 * 替换值自撞预检：rep.to 自己就命中 residue 的，写进去必然被随后的残留检查拦下。
 * 开工前就说清楚，免得写了一半才发现配置自相矛盾。
 * 历史文档豁免外，只查非历史文档的替换目标。
 */
export function assertNoSelfCollision(dev = {}) {
  const residue = dev.residue ?? [];
  if (!residue.length) return true;
  const bad = [];
  for (const rep of dev.replacements ?? []) {
    if (!rep || isHistoricalDoc(rep.file)) continue;
    const to = String(rep.to ?? '');
    for (const needle of residue) {
      if (needle && match(to, needle)) bad.push(`${rep.file} 的替换值「${to}」命中残留词「${needle}」`);
    }
  }
  if (bad.length) {
    throw new Error(`替换值会自撞残留规则（写了就等于制造残留）：\n  - ${bad.join('\n  - ')}`);
  }
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripBlocks(text, { startMark, endMark }) {
  const pattern = new RegExp(
    `^[ \\t]*${escapeRe(startMark)}[ \\t]*\\r?\\n` +
      `[\\s\\S]*?` +
      `^[ \\t]*${escapeRe(endMark)}[ \\t]*\\r?\\n`,
    'gm',
  );
  const startCount = (text.match(new RegExp(escapeRe(startMark), 'g')) ?? []).length;
  const endCount = (text.match(new RegExp(escapeRe(endMark), 'g')) ?? []).length;
  if (startCount === 0 || startCount !== endCount) {
    throw new Error(`内测哨兵不配对：START=${startCount} END=${endCount}（哨兵必须成对，且各自独处一行）`);
  }
  const stripped = text.replace(pattern, '');
  if (stripped.includes(startMark)) {
    throw new Error('有内测哨兵没被剥掉：哨兵必须独占一行（前面只允许缩进）');
  }
  return { text: stripped, blocks: startCount };
}

/** 残留检查。action 说明是「剥完」还是「替换后」，报错时能直接看出是哪一步漏的。 */
function assertNoResidue(rel, text, residue, action) {
  const leaks = (residue ?? []).filter((needle) => needle && match(text, needle));
  if (leaks.length) throw new Error(`${rel} ${action}仍残留内测痕迹：${leaks.join('、')}`);
}

/**
 * 就地剥离暂存目录里的内测块，并做残留检查。
 * 残留检查覆盖两处：哨兵剥完之后、replacement 写完之后。历史文档只跳过这一项。
 * @param {string} stageRoot 暂存目录
 * @param {{targets?:string[],startMark?:string,endMark?:string,residue?:string[],replacements?:Array}} dev
 */
export function stripDevOnly(stageRoot, dev = {}) {
  assertNoSelfCollision(dev); // 一个字节都还没写，就把配置里的自相矛盾摊开
  const report = [];
  for (const rel of dev.targets ?? []) {
    const file = join(stageRoot, rel);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`内测剥离目标不存在：${rel}`);
    }
    const { text: stripped, blocks } = stripBlocks(text, { startMark: dev.startMark, endMark: dev.endMark });

    if (!isHistoricalDoc(rel)) assertNoResidue(rel, stripped, dev.residue, '剥完');

    writeFileSync(file, stripped, 'utf8');
    report.push({ file: rel, blocks });
  }

  for (const rep of dev.replacements ?? []) {
    // 历史文档不做同义替换：旧配置里那条 CHANGELOG 替换直接跳过，保持原字节，
    // 而不是写进去再拿残留检查豁免（那样历史已经被改写了，豁免也救不回来）。
    if (rep && isHistoricalDoc(rep.file)) {
      report.push({ file: rep.file, replaced: false, skipped: 'historical-doc（精确根 CHANGELOG.md 不做同义替换，保持原字节）' });
      continue;
    }
    const file = join(stageRoot, rep.file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // 与本地一致：替换目标不存在就跳过
    }
    const next = text.split(rep.from).join(rep.to);
    // 替换是写盘动作，不是豁免：非历史文档写完照样核残留，防的是「替换把词换个名字塞回来」
    if (!isHistoricalDoc(rep.file)) assertNoResidue(rep.file, next, dev.residue, '替换后');
    writeFileSync(file, next, 'utf8');
    report.push({ file: rep.file, replaced: true, hits: text.split(rep.from).length - 1 });
  }
  return report;
}