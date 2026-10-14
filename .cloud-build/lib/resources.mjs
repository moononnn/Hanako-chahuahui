// 资源校验：manifest 里声明的图标 / 页面 / 图片必须真的在选中集合里。
// 官方打包器会做静态资源校验，但那是对最终包的；这里在打包前独立查一次暂存树，
// 目的是让「声明了却漏打包」在调用官方工具之前就失败，而不是让它变成一个警告。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 取 `a.b[].c` 形式的指针；返回全部命中（数组字段会展开）。 */
export function resolvePointer(node, pointer) {
  const steps = pointer.split('.');
  let cur = [node];
  for (const step of steps) {
    const m = /^([^[]*)\[(\d*)\]$/.exec(step);
    const key = m ? m[1] : step;
    const isAll = m && m[2] === '';
    const index = m && m[2] !== '' ? Number(m[2]) : null;
    const next = [];
    for (const n of cur) {
      if (n == null || typeof n !== 'object') continue;
      if (key && !(key in n)) continue;
      const v = key ? n[key] : n;
      if (Array.isArray(v)) {
        if (isAll) next.push(...v);
        else if (index != null && index < v.length) next.push(v[index]);
      } else if (!isAll && index == null) {
        next.push(v);
      }
    }
    cur = next;
  }
  return cur;
}

/** 声明的路径可能是 `/settings.html` 这种根相对写法，按 bases 依次试。 */
export function resolveCandidates(declared, bases) {
  const clean = String(declared).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return bases.map((b) => `${b}${clean}`);
}

/**
 * @param {{stageRoot:string, files:string[], resources:object}} opts
 * @returns {{declared:Array, missing:Array}}
 */
export function checkResources({ stageRoot, files, resources = {} }) {
  const manifestFile = resources.manifestFile ?? 'manifest.json';
  const bases = resources.bases ?? ['', 'ui/'];
  const pointers = resources.pointers ?? ['icon'];
  const manifestPath = join(stageRoot, manifestFile);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`读不到或解析不了 ${manifestFile}：${err.message}`);
  }

  const set = new Set(files);
  const declared = [];
  const missing = [];
  for (const pointer of pointers) {
    for (const value of resolvePointer(manifest, pointer)) {
      if (typeof value !== 'string' || !value) continue;
      const candidates = resolveCandidates(value, bases);
      const hit = candidates.find((c) => set.has(c));
      const row = { pointer, declared: value, candidates, found: hit ?? null };
      declared.push(row);
      if (!hit) missing.push(row);
    }
  }
  return { declared, missing };
}