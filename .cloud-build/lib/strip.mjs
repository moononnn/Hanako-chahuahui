// 哨兵剥离：与 ReleaseKit.ps1 的 Remove-DevOnlyBlocks 同规则。
// 哨兵必须成对、各自独占一行（前面只允许缩进）；不配对或剥不干净一律抛错，不做「尽力而为」。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { match } from './ps.mjs';

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

/**
 * 就地剥离暂存目录里的内测块，并做残留检查。
 * @param {string} stageRoot 暂存目录
 * @param {{targets?:string[],startMark?:string,endMark?:string,residue?:string[],replacements?:Array}} dev
 */
export function stripDevOnly(stageRoot, dev = {}) {
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

    const leaks = (dev.residue ?? []).filter((needle) => needle && match(stripped, needle));
    if (leaks.length) throw new Error(`${rel} 剥完仍残留内测痕迹：${leaks.join('、')}`);

    writeFileSync(file, stripped, 'utf8');
    report.push({ file: rel, blocks });
  }

  for (const rep of dev.replacements ?? []) {
    const file = join(stageRoot, rep.file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // 与本地一致：替换目标不存在就跳过
    }
    writeFileSync(file, text.split(rep.from).join(rep.to), 'utf8');
    report.push({ file: rep.file, replaced: true });
  }
  return report;
}