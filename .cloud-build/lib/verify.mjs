// 官方包验包：结构、身份、哈希、隐私四类门禁。
// 与本地 Test-ReleasePackage 的差别只有一处是有意的：官方包无顶层目录，所以顶层检查反过来做。
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { readZip, readEntry, readEntryText } from './zip.mjs';
import { extOf, findMachinePaths, findPrivateTerms, isTextFile } from './privacy.mjs';

export const FORBIDDEN_RE = /(?:^|\/)(?:tests|\.git|_stage|node_modules)(?:\/|$)|(?:^|\/)(?:PENDING_CHANGES|PUBLISHING|PROJECT_LOG|TESTING)\.md$|(?:^|\/)(?:DESIGN-|PLAN-)|(?:^|\/)(?:data|preferences|probe-result)\.json$|\.corrupt-/;

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 顶层目录检查：官方包必须「无顶层目录」，即不能所有条目都挂在同一个目录前缀下。 */
export function assertFlat(names, topLevel) {
  const prefix = `${topLevel}/`;
  const allUnder = names.length > 0 && names.every((n) => n.startsWith(prefix));
  if (allUnder) throw new Error(`官方包出现了顶层目录 ${prefix}：官方结构是无顶层目录`);
}

export function checkZipStructure(names) {
  const v = [];
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) v.push(`zip 含重复条目：${[...new Set(dupes)].join('、')}`);
  const traversal = names.filter((n) => /(^|\/)\.\.?(\/|$)/.test(n) || n.startsWith('./'));
  if (traversal.length) v.push(`zip 含路径穿越条目：${traversal.join('、')}`);
  const forbidden = names.filter((n) => FORBIDDEN_RE.test(n));
  if (forbidden.length) v.push(`zip 含禁止文件：${forbidden.join('、')}`);
  return v;
}

/** 官方 entry.json 必须与实际归档字节对得上，且保留 {{BASE_URL}} 占位。 */
export function checkEntryJson(entry, { zipSha, zipSize, cfg }) {
  const v = [];
  const need = ['kind', 'id', 'name', 'publisher', 'version', 'archive'];
  for (const k of need) if (entry?.[k] == null) v.push(`entry.json 缺字段：${k}`);
  if (entry) {
    if (entry.kind !== cfg.project.kind) v.push(`entry.kind=${entry.kind}，期望 ${cfg.project.kind}`);
    if (entry.id !== cfg.project.id) v.push(`entry.id=${entry.id}，期望 ${cfg.project.id}`);
    if (entry.version !== cfg.project.version) v.push(`entry.version=${entry.version}，期望 ${cfg.project.version}`);
    if (entry.publisher !== cfg.publisher) v.push('entry.publisher 与配置不一致');
    const a = entry.archive ?? {};
    if (a.format !== 'zip') v.push(`entry.archive.format=${a.format}，期望 zip`);
    if (a.sha256 && a.sha256.toLowerCase() !== zipSha.toLowerCase()) v.push('entry.archive.sha256 与实际归档不符');
    if (a.size != null && a.size !== zipSize) v.push(`entry.archive.size=${a.size}，实际 ${zipSize}`);
    if (typeof a.url === 'string' && !a.url.includes('{{BASE_URL}}')) {
      v.push(`entry.archive.url=${a.url}，缺 {{BASE_URL}} 占位（占位由建索引那步替换）`);
    }
  }
  return v;
}

/** 解出 entry 做语法检查，用一次性目录，不留痕。 */
export function checkEntrySyntax(zipBuf, entryRel) {
  const zip = readZip(zipBuf);
  const item = zip.byName.get(entryRel);
  if (!item) return [`包内缺少入口文件：${entryRel}`];
  const code = readEntry(zipBuf, item);
  const dir = mkdtempSync(join(tmpdir(), 'cloud-check-'));
  try {
    const f = join(dir, basename(entryRel) || 'entry.js');
    writeFileSync(f, code);
    const res = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (res.status !== 0) return [`官方包 ${entryRel} 语法检查失败：${(res.stderr || '').trim()}`];
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 云端构建的定论。它不是发布许可，只是“这份产物到了哪一步”的机读说法。
 *
 * releasable 永远是 false —— 即使隐私扫描跑满了，full 也只等于“扫过了”，
 * 不等于审查过、装得上、真实宿主装过。把这两件事分开，才不会有人拿 job 绿当发布许可。
 */
export function buildVerdict({ privacyMode, privacyClean }) {
  return {
    candidateOnly: true,
    privacyProven: privacyMode === 'full' && privacyClean,
    releasable: false,
    note: '云端只产出候选包。审查、实机安装、真实宿主升级、准确提交 CI、Release、市场登记都在本机由主引擎按发布契约执行；私名扫描也在本机用本地词表做。',
  };
}

/**
 * 全量验包。
 * @returns {{checks:string[], violations:string[], privacy:object, verdict:object}}
 */
export function verifyOfficialPackage({ zipPath, entryPath, cfg, redline, privateTerms, machinePathPattern }) {
  const zipBuf = readFileSync(zipPath);
  const zipSha = createHash('sha256').update(zipBuf).digest('hex');
  const zipSize = zipBuf.length;
  const { names } = readZip(zipBuf);
  const checks = [];
  const violations = [];

  try {
    assertFlat(names, cfg.package.topLevel);
    checks.push(`no-top-level-directory (${names.length} entries)`);
  } catch (err) {
    violations.push(err.message);
  }

  violations.push(...checkZipStructure(names));
  if (!violations.length) checks.push('structure: no duplicate / traversal / forbidden entries');

  const entryRel = cfg.package.entry;
  const entryViolations = checkEntrySyntax(zipBuf, entryRel);
  violations.push(...entryViolations);
  if (!entryViolations.length) checks.push(`entry syntax: node --check ${entryRel}`);

  // manifest 版本与身份
  const zip = readZip(zipBuf);
  const mf = zip.byName.get(cfg.resources?.manifestFile ?? 'manifest.json');
  if (!mf) violations.push('包内缺少 manifest.json');
  else {
    const manifest = JSON.parse(readEntryText(zipBuf, mf));
    if (manifest.version !== cfg.project.version) {
      violations.push(`包内 manifest 版本是 ${manifest.version}，期望 ${cfg.project.version}`);
    } else checks.push(`manifest version = ${manifest.version}`);
    if (manifest.id !== cfg.project.id) violations.push(`包内 manifest.id=${manifest.id}，期望 ${cfg.project.id}`);
  }

  // 隐私：对最终包里的文本条目再扫一遍（暂存树扫过不等于包里没有）
  const exts = cfg.privacy?.textExtensions;
  const pv = [];
  const re = machinePathPattern ? new RegExp(machinePathPattern, 'i') : undefined;
  for (const name of names) {
    if (!isTextFile(name, exts)) continue;
    const text = readEntry(zipBuf, zip.byName.get(name)).toString('utf8');
    const paths = findMachinePaths(text, re);
    if (paths.length) pv.push(`${name}: 本机路径 ${[...new Set(paths)].join(' ')}`);
    if (redline) {
      const hit = new RegExp(redline, 'i').exec(text);
      if (hit) pv.push(`${name}: 外传红线命中 ${hit[0]}`);
    }
    const named = findPrivateTerms(text, privateTerms ?? []);
    if (named.length) pv.push(`${name}: 私名 ${named.join(' ')}`);
  }
  violations.push(...pv);
  const privacy = { mode: redline ? 'full' : 'degraded', violations: pv };
  checks.push(`privacy scan (${privacy.mode})`);

  const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
  const ev = checkEntryJson(entry, { zipSha, zipSize, cfg });
  violations.push(...ev);
  if (!ev.length) checks.push(`entry.json <-> archive: sha256 ${zipSha.slice(0, 12)}… size ${zipSize}`);

  return {
    zipPath, entryPath, zipSha, zipSize, entryCount: names.length,
    checks, violations, privacy,
    verdict: buildVerdict({ privacyMode: privacy.mode, privacyClean: pv.length === 0 }),
  };
}

export function entryFileName(cfg) {
  return `${cfg.output.archiveBaseName ?? `app-${cfg.project.id}-${cfg.project.version}`}.entry.json`;
}

export { extOf };