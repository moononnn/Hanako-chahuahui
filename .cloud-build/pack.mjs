// 云端构建入口：从干净 checkout 产出最终官方 App zip（无顶层目录）+ 官方 entry.json。
//
// 这个脚本只做三件事：
//   1) 在调用官方工具之前，自己独立跑一遍发布门禁（筛选 / 哨兵剥离 / 资源 / 隐私 / 身份）
//   2) 调用宿主官方 scripts/extension-pack.mjs 生成 zip 与 MarketItemV2 entry
//   3) 对官方产物再独立验一遍包，写出可机读的 cloud-build.json
//
// 它不发布、不建 Release、不上传、不改远端。默认 workflow_dispatch，产物只落在工作目录里。
//
// 用法：
//   node cloud/pack.mjs --checkout <repo> --out <attempt-dir> --tools-root <server-dist-dir>
//                        [--redline-file <f> | --redline <re>] [--skip-tests]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { selectFiles } from './lib/select.mjs';
import { stripDevOnly } from './lib/strip.mjs';
import { checkResources } from './lib/resources.mjs';
import { scanTree, checkPublisher, findMachinePaths } from './lib/privacy.mjs';
import { resolveToolchain, packWithOfficial } from './lib/toolchain.mjs';
import { verifyOfficialPackage, buildVerdict } from './lib/verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const say = (m) => console.log(`  ${m}`);

/**
 * 红线私名不进仓库，所以按优先级从三处取：
 *   1) --redline-file / --redline（本地调试）
 *   2) TIGEXING_REDLINE（CI secret）
 *   3) 仓库侧 projects\<id>.json 的 redline（本地默认；这个文件本身是本地契约，不进公开仓库）
 * 都取不到就是降级模式：绝对路径照样查，私名这项不谎报通过。
 */
export function resolveRedline(cfg, kitRoot, opts = {}) {
  if (opts.redline) return { redline: opts.redline, from: 'cli' };
  if (opts.redlineFile) {
    return { redline: readFileSync(opts.redlineFile, 'utf8').trim(), from: `file:${basenameSafe(opts.redlineFile)}` };
  }
  if (process.env.TIGEXING_REDLINE) return { redline: process.env.TIGEXING_REDLINE.trim(), from: 'env:TIGEXING_REDLINE' };
  const local = join(kitRoot, 'projects', `${cfg.project.id}.json`);
  if (existsSync(local)) {
    const r = JSON.parse(readFileSync(local, 'utf8')).redline;
    if (r) return { redline: r, from: 'repo-side project config' };
  }
  return { redline: null, from: 'none', terms: [] };
}
const basenameSafe = (p) => p.replace(/\\/g, '/').split('/').pop();

/** 官方工具链根目录：显式参数 > HANA_APP_TOOLS_ROOT。无效目录由 resolveToolchain 报错，不猜。 */
export function resolveToolsRoot(opts) {
  const explicit = opts.toolsRoot ?? process.env.HANA_APP_TOOLS_ROOT ?? null;
  if (!explicit) {
    throw new Error('未指定官方工具链目录。用 --tools-root <Server 版本目录>，' +
      '或设 HANA_APP_TOOLS_ROOT（宿主契约：由 Server 分发目录携带 scripts/extension-pack.mjs）。');
  }
  return resolve(explicit);
}

/** 版本对账：manifest 是唯一版本源；镜像文件按 config.version.mirrors 逐条查。 */
export function assertVersionAlign(cfg, checkout) {
  const src = cfg.version?.source ?? { file: 'manifest.json', jsonKey: 'version' };
  const mf = JSON.parse(readFileSync(join(checkout, src.file), 'utf8'));
  const actual = src.jsonKey ? mf[src.jsonKey] : undefined;
  if (actual !== cfg.project.version) {
    throw new Error(`版本对账不过：${src.file} 的 ${src.jsonKey} 是 ${actual}，配置写的是 ${cfg.project.version}`);
  }
  const mirrors = [];
  for (const m of cfg.version?.mirrors ?? []) {
    const text = readFileSync(join(checkout, m.file), 'utf8');
    const hit = new RegExp(m.regex).exec(text);
    if (!hit) throw new Error(`版本镜像没匹配上：${m.file} / ${m.regex}`);
    if (hit[1] !== cfg.project.version) {
      throw new Error(`版本镜像不一致：${m.file} 是 ${hit[1]}，期望 ${cfg.project.version}`);
    }
    mirrors.push({ file: m.file, version: hit[1] });
  }
  return { version: actual, mirrors };
}

/**
 * 源码身份。commit 取 checkout 自己的 HEAD，不拿 GITHUB_SHA 顶替 ——
 * workflow 允许 inputs.ref 指定别的 ref，那个环境变量对不上实际构建的 commit。
 * 跟踪文件的脏状态开工前与收工后各查一次，不一致就说明构建期间有人动过源码。
 */
export function readSourceIdentity(checkout) {
  const git = (args) => {
    const r = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  if (existsSync(join(checkout, '.git')) !== true && git(['rev-parse', '--git-dir']) === null) {
    return { commit: null, trackedDirty: null, git: false };
  }
  const commit = git(['rev-parse', 'HEAD']);
  const dirty = git(['diff', 'HEAD', '--name-only']);
  return {
    commit,
    trackedDirty: dirty === null ? null : (dirty ? dirty.split(/\r?\n/).filter(Boolean) : []),
    git: true,
  };
}

export function assertSameDirty(before, after) {
  const b = JSON.stringify(before.trackedDirty ?? null);
  const a = JSON.stringify(after.trackedDirty ?? null);
  if (b !== a) throw new Error(`构建期间跟踪文件发生变化（开工前 ${b} → 收工后 ${a}），候选包作废`);
}

function runTestGates(cfg, checkout) {
  const cmds = cfg.checks?.testCommands ?? [];
  if (!cmds.length) {
    // 云端不重复业务测试。0 条命令当成 pass 就是假绿灯，必须如实写 not-run。
    return { steps: [{ command: '(none configured)', status: 'not-run' }], ran: 0 };
  }
  const steps = [];
  for (const cmd of cmds) {
    const [bin, ...args] = cmd;
    const res = spawnSync(bin, args, { cwd: checkout, encoding: 'utf8', shell: process.platform === 'win32' });
    if (res.status !== 0) {
      throw new Error(`测试门禁失败：${cmd.join(' ')}\n${(res.stdout || '').slice(-2000)}\n${(res.stderr || '').slice(-2000)}`);
    }
    steps.push({ command: cmd.join(' '), status: 'pass' });
  }
  return { steps, ran: cmds.length };
}

function copyStage(checkout, stageDir, files) {
  rmSync(stageDir, { recursive: true, force: true });
  for (const rel of files) {
    const dest = join(stageDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(checkout, rel), dest);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const configDir = resolve(arg('config', HERE));
  const cfg = loadConfig(configDir);
  const kitRoot = resolve(configDir, '..');
  const checkout = resolve(arg('checkout', process.cwd()));
  const outArg = arg('out');
  if (!outArg || !outArg.trim()) throw new Error('--out 必须给一个非空目录（不猜默认位置）');
  const outDir = resolve(outArg);
  const toolsRoot = resolveToolsRoot({ toolsRoot: arg('tools-root') });
  const skipTests = flag('skip-tests');

  // 本机目录可能是连接/联接（reparse point），解析后再用，避免同一份源码算出两个指纹。
  const checkoutReal = realpathSync(checkout);
  if (!existsSync(join(checkoutReal, cfg.resources?.manifestFile ?? 'manifest.json'))) {
    throw new Error(`checkout 里没有 ${cfg.resources?.manifestFile}：${checkoutReal}`);
  }
  if (existsSync(outDir) && realpathSync(outDir) === checkoutReal) {
    throw new Error('--out 不能就是 checkout：产物会污染源码目录');
  }

  const startedAt = new Date().toISOString();
  const steps = [];
  const violations = [];

  // 源码身份开工前先取一次，收工后再取一次比对
  const identityBefore = readSourceIdentity(checkoutReal);
  if (flag('require-commit') && !/^[0-9a-f]{40}$/.test(identityBefore.commit ?? '')) {
    throw new Error('--require-commit 已开，但拿不到 40 位 commit（checkout 不是 git 仓库，或没有 HEAD）');
  }
  say(`项目 ${cfg.project.id}@${cfg.project.version}  源 ${relative(process.cwd(), checkoutReal) || '.'}`);
  say(`源码 commit ${identityBefore.commit ?? '(无 git)'}${
    identityBefore.trackedDirty?.length ? `  未提交改动 ${identityBefore.trackedDirty.length} 个` : ''}`);

  // ── 1. 版本对账 ─────────────────────────────────────────────
  const align = assertVersionAlign(cfg, checkoutReal);
  steps.push({ step: 'versionAlign', result: align.version, mirrors: align.mirrors.length });
  say(`版本对账 ${align.version}（镜像 ${align.mirrors.length} 处）`);

  // ── 2. 测试门禁（默认不跑业务测试，如实写 not-run）──────────
  if (!skipTests) {
    const t = runTestGates(cfg, checkoutReal);
    steps.push({
      step: 'tests',
      result: t.ran ? 'pass' : 'not-run',
      commands: t.steps.map((x) => x.command),
      reason: t.ran ? null : '云端不重复业务测试；由现有 CI 与本地精确 verify 负责',
    });
    say(t.ran ? `测试门禁 ${t.ran} 条通过` : '业务测试未在云端跑（not-run）：由现有 CI 与本地精确 verify 负责');
  } else {
    steps.push({ step: 'tests', result: 'not-run', reason: '--skip-tests' });
    say('测试门禁未跑（not-run）：真发布不许跳');
  }

  // ── 3. 筛选 + 暂存副本（目录名必须是 id）───────────────────
  const files = selectFiles(checkout, cfg.package);
  const stageDir = join(outDir, 'stage', cfg.project.id);
  copyStage(checkoutReal, stageDir, files);
  steps.push({ step: 'stageCopy', result: 'pass', files: files.length });
  say(`暂存副本 ${files.length} 个文件 → stage/${cfg.project.id}`);

  // ── 4. 哨兵剥离 ─────────────────────────────────────────────
  const stripped = stripDevOnly(stageDir, cfg.devOnly);
  steps.push({ step: 'devOnlyStripped', result: 'pass', count: stripped.length });
  say(`哨兵剥离 ${stripped.length} 处`);

  // ── 5. 资源校验（manifest 声明的都要在包里）─────────────────
  const res = checkResources({ stageRoot: stageDir, files, resources: cfg.resources });
  if (res.missing.length) {
    violations.push(...res.missing.map((m) => `manifest 声明的资源不在包里：${m.declared}（试过 ${m.candidates.join('、')}）`));
  }
  steps.push({ step: 'resourceCheck', result: res.missing.length ? 'fail' : 'pass', declared: res.declared.length });
  say(`资源校验 声明 ${res.declared.length} 处，缺失 ${res.missing.length} 处`);

  // ── 6. 隐私与身份 ───────────────────────────────────────────
  const { redline, from, terms } = resolveRedline(cfg, kitRoot, {
    redline: arg('redline'), redlineFile: arg('redline-file'),
  });
  const scan = scanTree({ root: stageDir, files, privacy: cfg.privacy, redline, privateTerms: terms });
  violations.push(...scan.violations.map((v) => `${v.file}：${v.detail}`));
  const pub = checkPublisher(cfg.publisher, cfg.privacy.allowedNames ?? []);
  if (!pub.ok) violations.push(`publisher 不合规：${pub.reason}`);
  steps.push({ step: 'privacyScan', result: scan.mode, scanned: scan.scanned, violations: scan.violations.length });
  say(`隐私扫描 ${scan.mode} 模式，扫 ${scan.scanned} 个文本文件（红线来源：${from}）`);

  if (violations.length) {
    reportFailure(steps, violations, outDir, cfg, startedAt);
    return 1;
  }

  // ── 7. 官方打包器（唯一 entry 来源）──────────────────────────
  const toolchain = resolveToolchain({ toolsRoot, pin: cfg.toolchain.pin });
  const packDir = join(outDir, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packRes = packWithOfficial({
    toolchain, kind: cfg.project.kind, stageDir, publisher: cfg.publisher, outDir: packDir,
  });
  const zipPath = join(packDir, `app-${cfg.project.id}-${cfg.project.version}.zip`);
  const entryPath = join(packDir, `app-${cfg.project.id}-${cfg.project.version}.entry.json`);
  const zipSha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const entrySha256 = createHash('sha256').update(readFileSync(entryPath)).digest('hex');
  steps.push({ step: 'officialPack', result: 'pass', toolchainVersion: toolchain.version, exitCode: packRes.exitCode });
  say(`官方打包完成（工具链 ${toolchain.version}）`);
  if (packRes.stderr.trim()) {
    // 官方把静态校验 warning 写 stderr 但退出 0；转达，不吞。
    say(`官方工具 warning：${packRes.stderr.trim().split('\n')[0]}`);
    steps[steps.length - 1].warnings = packRes.stderr.trim().split('\n').filter(Boolean);
  }

  // ── 8. 对官方产物独立复验 ───────────────────────────────────
  const verify = verifyOfficialPackage({ zipPath, entryPath, cfg, redline, privateTerms: terms });
  violations.push(...verify.violations);
  const verdict = verify.verdict;

  // 源码身份收工复查：构建期间动了跟踪文件就作废
  const identityAfter = readSourceIdentity(checkoutReal);
  try {
    assertSameDirty(identityBefore, identityAfter);
    steps.push({ step: 'sourceStable', result: 'pass' });
  } catch (err) {
    violations.push(err.message);
    steps.push({ step: 'sourceStable', result: 'fail' });
  }
  if (identityBefore.commit !== identityAfter.commit) {
    violations.push(`构建期间 HEAD 变了：${identityBefore.commit} → ${identityAfter.commit}`);
    steps.push({ step: 'sourceStable', result: 'fail' });
  }

  steps.push({ step: 'verifyOfficialPackage', result: verify.violations.length ? 'fail' : 'pass', checks: verify.checks });
  if (!verify.violations.length) say(`验包 ${verify.checks.length} 项全过`);

  const evidence = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    startedAt,
    // 这三个字段是给下游看的硬结论，job 绿不改变它们。
    candidateOnly: true,
    privacyProven: verdict.privacyProven,
    releasable: false,
    verdictNote: verdict.note,
    project: cfg.project,
    publisher: cfg.publisher,
    source: {
      commit: identityBefore.commit,
      trackedDirty: identityBefore.trackedDirty,
      git: identityBefore.git,
      commitRequired: flag('require-commit'),
    },
    privacy: { mode: scan.mode, proven: verdict.privacyProven, redlineSource: from, scanned: scan.scanned, localOnly: true },
    // 工具链只记版本与哈希，绝不记本机目录
    toolchain: {
      version: toolchain.version,
      platformArch: toolchain.platformArch,
      distributionSha256: toolchain.distributionSha256,
      packScriptSha256: toolchain.scriptSha256,
      pin: cfg.toolchain.pin,
    },
    artifact: {
      zip: `pack/app-${cfg.project.id}-${cfg.project.version}.zip`,
      entry: `pack/app-${cfg.project.id}-${cfg.project.version}.entry.json`,
    },
    zip: {
      sha256: zipSha256,
      size: verify.zipSize,
      entries: verify.entryCount,
      topLevelDirectory: false,
      // 导入时要拿云端 entry 与官方包两边对账，所以 entry 的指纹也得在证据里
      entrySha256,
    },
    entry: { kind: cfg.project.kind, id: cfg.project.id, version: cfg.project.version, publisher: cfg.publisher },
    steps,
    violations,
    publishPolicy: 'cloud build only：不建 Release、不上传、不推 tag。产物是候选包。'
      + '发布仍由本地主引擎按发布契约执行，且必须在本地用本地词表完成私名扫描后才能冻结。',
    approvalNote: '平台审批 Builder 不能由构建流程自动代批准；需要审批的步骤一律停在这里等人。',
  };

  // 证据本身不允许带本机痕迹
  const leaked = findMachinePaths(JSON.stringify(evidence));
  if (leaked.length) violations.push(`证据文件含本机路径：${[...new Set(leaked)].join(' ')}`);

  writeFileSync(join(outDir, 'cloud-build.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  if (violations.length) {
    reportFailure(steps, violations, outDir, cfg, startedAt);
    return 1;
  }
  say(`产物 zip=${verify.zipSha.slice(0, 12)}… size=${verify.zipSize} entries=${verify.entryCount}`);
  say(`隐私扫描 ${scan.mode}：${verdict.privacyProven ? '云端已扫' : '云端未证明（无词表）'}，私名扫描必须回本机做`);
  say('这份产物只是候选：releasable=false，未审查、未装、未跑真实宿主。');
  say('证据 cloud-build.json');
  return 0;
}

function reportFailure(steps, violations, outDir, cfg, startedAt) {
  console.error('\n  门禁未通过：');
  for (const v of violations) console.error(`   - ${v}`);
  writeFileSync(join(outDir, 'cloud-build.json'), `${JSON.stringify({
    schema: 2, generatedAt: new Date().toISOString(), startedAt,
    candidateOnly: true, privacyProven: false, releasable: false,
    verdictNote: '门禁未过，没有可用的候选包。',
    project: cfg.project, steps, violations,
    publishPolicy: 'blocked before candidate',
  }, null, 2)}\n`, 'utf8');
}

const isMain = process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`\n  云端构建失败：${err.message}`);
    process.exitCode = 1;
  }
}