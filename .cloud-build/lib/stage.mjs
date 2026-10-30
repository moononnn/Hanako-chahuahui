// 本地与云端共用的发布副本行尾规则。只改 stage，不改源码；二进制保持原字节。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTS = new Set('.js .mjs .cjs .jsx .ts .tsx .json .md .html .htm .css .scss .txt .yml .yaml .ps1 .py .svg .xml .csv .toml .ini .sh .bash .cmd .bat'.split(' '));
const TEXT_NAMES = new Set(['LICENSE', '.gitignore', '.gitattributes', '.editorconfig']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function getStagePolicy(source, files) {
  const paths = files.map((p) => {
    const rel = p.replaceAll('\\', '/');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((x) => x === '..' || !x)) throw new Error('发布副本路径必须在源目录内');
    return rel;
  });
  const attrs = new Map();
  const git = spawnSync('git', ['-C', source, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim() === 'true' && paths.length) {
    // 本机 info 属性不随提交到云端；有实际规则时必须先搬到可追踪的属性文件。
    const info = spawnSync('git', ['-C', source, 'rev-parse', '--git-path', 'info/attributes'], { encoding: 'utf8' });
    if (info.status !== 0 || !info.stdout.trim()) throw new Error('无法核查本机 Git info/attributes');
    const infoPath = resolve(source, info.stdout.trim());
    if (existsSync(infoPath) && readFileSync(infoPath, 'utf8').split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith('#'))) {
      throw new Error('本机 Git info/attributes 不随提交共享，无法证明本地与云端规则一致');
    }
    // 不借本机全局 attributes 制造云端没有的隐含规则。
    const res = spawnSync('git', ['-C', source, '-c', 'core.attributesFile=', 'check-attr', '-z', '--stdin', 'text', 'eol', 'working-tree-encoding', 'filter'], {
      input: paths.join('\0') + '\0', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) throw new Error('无法核查发布副本 Git 属性');
    const values = res.stdout.split('\0');
    for (let i = 0; i + 2 < values.length; i += 3) {
      const [path, name, value] = values.slice(i, i + 3);
      if (!attrs.has(path)) attrs.set(path, {});
      attrs.get(path)[name] = value;
    }
  } else {
    // 非 Git 源目录不能假装已经解释了 .gitattributes。
    const dirs = new Set(['.']);
    for (const path of paths) { let dir = dirname(path); while (dir !== '.') { dirs.add(dir); dir = dirname(dir); } }
    if ([...dirs].some((dir) => existsSync(join(source, dir, '.gitattributes')))) throw new Error('存在 .gitattributes 但源目录不在 Git 工作树内，无法证明行尾规则');
  }
  return paths.map((path) => {
    const a = attrs.get(path) ?? {};
    for (const name of ['working-tree-encoding', 'filter']) {
      if (a[name] && !['unspecified', 'unset'].includes(a[name])) throw new Error(`发布副本暂不支持 Git ${name}：${path}，请先核对检出变换`);
    }
    if (a.text && !['unspecified', 'unset', 'set', 'auto'].includes(a.text)) throw new Error(`无法识别文本属性：${path}`);
    if (a.eol && !['unspecified', 'unset', 'lf', 'crlf'].includes(a.eol)) throw new Error(`无法识别行尾属性：${path}`);
    const forced = a.text === 'set' || a.eol === 'lf' || a.eol === 'crlf';
    const text = a.text !== 'unset' && (forced || a.text === 'auto' || TEXT_EXTS.has(extname(path).toLowerCase()) || TEXT_NAMES.has(basename(path)));
    return { path, text, forced, eol: a.eol === 'crlf' ? 'crlf' : 'lf' };
  });
}

export function applyStagePolicy(stage, policy) {
  const changed = [];
  for (const row of policy) {
    if (!row.text) continue;
    const file = resolve(stage, row.path);
    if (!file.startsWith(resolve(stage) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('发布副本路径越界');
    const bytes = readFileSync(file);
    let text;
    try { text = decoder.decode(bytes); } catch {
      if (row.forced) throw new Error(`显式文本不是有效 UTF-8：${row.path}`);
      continue;
    }
    if (text.includes('\0')) {
      if (row.forced) throw new Error(`显式文本含二进制 NUL：${row.path}`);
      continue;
    }
    const canonical = row.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
    const output = Buffer.from(canonical, 'utf8');
    if (!output.equals(bytes)) { writeFileSync(file, output); changed.push(row.path); }
  }
  return changed;
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const result = process.argv.includes('--policy') ? getStagePolicy(input.source, input.files) : applyStagePolicy(input.stage, input.policy);
    console.log(JSON.stringify(result));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
