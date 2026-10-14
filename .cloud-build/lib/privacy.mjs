// 隐私门禁：外传红线 + 本机绝对路径。
// 与本地 Test-ReleasePackage 同源并加强：本地只对入口文件查绝对路径、只对 8 种后缀查红线，
// 这里对所有入选文本文件查两者，并额外覆盖 .ps1 / .mjs（本地漏掉这两种后缀）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TEXT_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml', '.ps1',
];

/**
 * 本机绝对路径 = 能认出作者机器的那一类：用户目录、POSIX 家目录。
 *
 * 三条约束都是实测逼出来的：
 *  - 不拦裸盘符：界面提示里的示例路径（盘符 + 任意目录）不是泄露。
 *  - 盘符不能紧跟词字符，否则 URL 里的 `s://` 会被当成盘符。
 *  - 正斜杠形式要看前一个字符，否则域名里的用户目录段会误报；
 *    反斜杠形式不看（Windows 上不存在 `盘符+词+用户目录段` 这种真路径）。
 *  - 关键词后面必须跟一段像样的目录名（≥2 个词字符），否则检测器自己的
 *    正则源码会被判成泄露。
 *  - 关键词后面的分隔符允许重复：JSON/HTML/YAML 里是单反斜杠，
 *    而 JS 源码里同一个路径会被写成双反斜杠，两边都得抓住。
 *
 * 本文件要随 workflow 进公开仓库，所以：
 *  - 不含任何私名字面量，一律走 redline / 词表传入（见 findPrivateTerms）
 *  - 注释里不写路径示例字面量，否则检测器会把自己判成泄露
 */
export const MACHINE_PATH_RE = /(?<![\w])[A-Za-z]:[\\/]+Users[\\/]+[\w.-]{2,}|\\Users\\[\w.-]{2,}|(?<![\w.\-])\/(?:Users|home)\/[\w.-]{2,}/;

/**
 * 私名词表的字面匹配。词表由调用方从本地项目配置的 redline 拆出来传入：
 * 那串名字不进仓库，也不该硬编码在任何会被发布的文件里。
 * @param {string} text 待查文本
 * @param {string[]} terms 私名词表
 */
export function findPrivateTerms(text, terms = []) {
  const lower = text.toLowerCase();
  return terms.filter((t) => t && lower.includes(t.toLowerCase()));
}

export function extOf(rel) {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i).toLowerCase();
}

export function isTextFile(rel, exts = DEFAULT_TEXT_EXTENSIONS) {
  return exts.includes(extOf(rel));
}

/** 找出文本里的本机绝对路径；返回命中片段便于定位（不回显整行，避免把私名再抄一遍）。 */
export function findMachinePaths(text, re = MACHINE_PATH_RE) {
  const hits = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    hits.push(m[0]);
  }
  return hits;
}

/**
 * 扫暂存目录。
 * @param {{root:string, files:string[], privacy:object, redline?:string|null}} opts
 * @returns {{mode:'full'|'degraded', violations:Array, scanned:number}}
 */
export function scanTree({ root, files, privacy = {}, redline, privateTerms }) {
  const exts = privacy.textExtensions ?? DEFAULT_TEXT_EXTENSIONS;
  const violations = [];
  let scanned = 0;

  for (const rel of files) {
    if (!isTextFile(rel, exts)) continue;
    scanned += 1;
    const text = readFileSync(join(root, rel), 'utf8');

    const paths = findMachinePaths(text, privacy.machinePathPattern
      ? new RegExp(privacy.machinePathPattern, 'i') : MACHINE_PATH_RE);
    if (paths.length) {
      violations.push({ file: rel, kind: 'machine-path', detail: [...new Set(paths)].join(' ') });
    }
    if (redline) {
      const hit = new RegExp(redline, 'i').exec(text);
      if (hit) violations.push({ file: rel, kind: 'redline', detail: String(hit[0]) });
    }
    const named = findPrivateTerms(text, privateTerms ?? []);
    if (named.length) {
      violations.push({ file: rel, kind: 'private-name', detail: named.join(' ') });
    }
  }

  // 没有红线就是降级：绝对路径照样查，但「私名是否漏出去」这一项没有被证明。
  return { mode: redline ? 'full' : 'degraded', violations, scanned };
}

/**
 * 允许外传的署名白名单。作者工具链要求 publisher 非空，而 publisher 会进 entry.json
 * 并最终进公开市场索引，所以它只能是白名单里的名字。
 */
export function checkPublisher(publisher, allowed) {
  if (typeof publisher !== 'string' || !publisher.trim()) {
    return { ok: false, reason: 'publisher 必填，不能为空（索引 schema 要求非空，官方打包器无隐式默认值）' };
  }
  const parts = publisher.split(/[&、,/]/).map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !allowed.some((a) => a.toLowerCase() === p.toLowerCase()));
  return {
    ok: bad.length === 0,
    reason: bad.length ? `publisher 含白名单外的名字：${bad.join('、')}` : null,
    parts,
  };
}