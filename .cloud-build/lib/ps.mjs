// PowerShell 的 -like / -match 语义移植。
// 本地引擎（ReleaseKit.ps1）用 -like 排排除项、用 -match 查残留与红线，
// 云端要得出同一结论，这两处必须逐字对齐：-like 大小写不敏感，且 `*` 能跨 `/`。

/** PowerShell -like 通配符 → RegExp（大小写不敏感）。 */
export function likeToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '`') {
      i += 1;
      if (i < pattern.length) out += escapeLiteral(pattern[i]);
      continue;
    }
    if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else if (ch === '[') {
      let j = i + 1;
      let cls = '[';
      if (pattern[j] === '!') { cls += '^'; j += 1; } else if (pattern[j] === ']') { cls += '\\]'; j += 1; }
      for (; j < pattern.length && pattern[j] !== ']'; j += 1) {
        cls += pattern[j] === '\\' || pattern[j] === ']' ? `\\${pattern[j]}` : pattern[j];
      }
      if (j >= pattern.length) { out += '\\['; continue; }
      out += `${cls}]`;
      i = j;
    } else out += escapeLiteral(ch);
  }
  return new RegExp(`^${out}$`, 'i');
}

function escapeLiteral(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

export function like(value, pattern) {
  return likeToRegExp(pattern).test(value);
}

export function likeAny(value, patterns) {
  return patterns.some((p) => like(value, p));
}

/** PowerShell -match（默认大小写不敏感）。非法正则直接抛，不降级成不匹配。 */
export function match(value, pattern) {
  return new RegExp(pattern, 'i').test(value);
}

/** Rel 是反斜杠相对路径时的分隔符归一，与 Test-Excluded 里的 $slash 对应。 */
export function toSlash(rel) {
  return rel.replace(/\\/g, '/');
}

export function baseName(rel) {
  const parts = toSlash(rel).split('/');
  return parts[parts.length - 1];
}

/** Test-Excluded 用的 $segs -contains $d：按路径分段、大小写不敏感。 */
export function segments(rel) {
  return toSlash(rel).split('/');
}