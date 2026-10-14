// 便携配置：只含相对路径，任何本机痕迹都在加载期就被拒绝。
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * 本机痕迹的“形态”：盘符、UNC、POSIX 家目录、Users 目录。
 * 刻意不含任何私名字面量 —— 本模块要进公开仓库，工作台名之类的一律走词表传入。
 * 盘符必须独立于词字符，否则 `https://` 里的 `s:/` 会被误判（这是实测踩到的）。
 */
export const MACHINE_PATH_PATTERNS = [
  /(?<![\w])[A-Za-z]:[\\/]/,
  /\\\\[^\\]/,
  /(?<![\w.\-])^\/(?:Users|home)\//,
  /(?<![\w.\-])[\\/]Users[\\/]/,
];

export function findMachinePath(value, where = '') {
  if (typeof value !== 'string') return null;
  for (const p of MACHINE_PATH_PATTERNS) if (p.test(value)) return { pattern: String(p), where };
  return null;
}

function walk(node, trail) {
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${trail}[${i}]`));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, trail ? `${trail}.${k}` : k);
    return out;
  }
  return node;
}

/**
 * config.json 本身不含红线私名；词表只留在本机项目配置，默认不配置 CI secret。
 * 因此红线由调用方（CLI 参数 / 环境变量）传入，见 pack.mjs 的 resolveRedline。
 */
export function assertPortable(cfg) {
  const problems = [];
  const scan = walk(cfg, '');
  const visit = (node, trail) => {
    if (typeof node === 'string') {
      const hit = findMachinePath(node, trail);
      if (hit) problems.push(`${trail} 含本机路径（${hit.pattern}）`);
    } else if (Array.isArray(node)) node.forEach((v, i) => visit(v, `${trail}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) visit(v, trail ? `${trail}.${k}` : k);
    }
  };
  visit(scan, '');

  if (typeof cfg?.source?.roots !== 'object' || !cfg.source.roots.length) {
    problems.push('source.roots 必须是非空数组');
  }
  for (const r of cfg?.source?.roots ?? []) {
    if (isAbsolute(r)) problems.push(`source.roots 含绝对路径：${r}`);
  }
  for (const key of ['src', 'repo', 'outDir', 'notesDir']) {
    if (cfg?.[key]) problems.push(`配置不该带本机键 ${key}`);
  }
  if (problems.length) throw new Error(`便携配置检查未通过：\n  - ${problems.join('\n  - ')}`);
  return true;
}

const REQUIRED = ['project.id', 'project.version', 'package.entry', 'privacy', 'toolchain.pin'];

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function loadConfig(configDir) {
  const path = join(configDir, 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`读不了 ${path}：${err.message}（先跑 node cloud/gen-config.mjs 生成）`);
  }
  const missing = REQUIRED.filter((k) => get(cfg, k) == null);
  if (missing.length) throw new Error(`config.json 缺字段：${missing.join('、')}`);
  assertPortable(cfg);
  return cfg;
}