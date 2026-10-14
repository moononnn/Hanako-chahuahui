// 文件筛选：与 ReleaseKit.ps1 的 Test-Excluded / Test-Whitelisted 同规则。
// 排除项带「/」按相对路径算，不带「/」按名字算；白名单非空时只放行列出的本体或子路径。
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { like, likeAny, toSlash, baseName, segments } from './ps.mjs';

export function isExcluded(rel, pkg = {}) {
  const slash = toSlash(rel);
  const name = baseName(rel);
  const segs = segments(rel);
  for (const d of pkg.excludeDirs ?? []) {
    if (d.includes('/')) {
      if (slash === d || like(slash, `${d}/*`)) return true;
    } else if (segs.some((s) => s.toLowerCase() === d.toLowerCase())) return true;
  }
  for (const f of pkg.excludeFiles ?? []) {
    if (f.includes('/')) {
      if (slash === f) return true;
    } else if (name.toLowerCase() === f.toLowerCase()) return true;
  }
  for (const g of pkg.excludeGlobs ?? []) {
    if (likeAny(name, [g]) || likeAny(slash, [g])) return true;
  }
  return false;
}

export function isWhitelisted(rel, pkg = {}) {
  const inc = pkg.include ?? [];
  if (!inc.length) return true;
  const slash = toSlash(rel);
  const name = baseName(rel);
  return inc.some((i) => slash === i || like(slash, `${i}/*`) || name === i);
}

/** 递归列文件（不跟随符号链接），返回按 slash 路径排序的相对路径数组，保证可复现。 */
export function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else out.push(toSlash(relative(root, full)));
    }
  };
  visit(root);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 本次构建要进包的相对路径：先排排除，再过白名单。 */
export function selectFiles(root, pkg) {
  return walkFiles(root).filter((rel) => !isExcluded(rel, pkg) && isWhitelisted(rel, pkg));
}