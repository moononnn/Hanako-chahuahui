// 官方工具链接入：只调用宿主官方 scripts/extension-pack.mjs 生成 zip 与 entry.json，
// 任何情况下都不自己造 entry —— 自造就等于造一个市场装不上的不兼容物。
//
// 契约依据（宿主 APPS.md，均已实查）：
//  - 「Hana Server 分发目录携带 scripts/extension-pack.mjs … 在其他环境运行 Creator 时，
//     将 HANA_APP_TOOLS_ROOT 设为已安装 Server 的版本目录。显式指定的目录无效时会报错，
//     不会静默换另一份安装。」
//  - 「生成确定性 zip（固定文件顺序、mtime 归零——同一个目录打两次字节完全一致）与配套的
//     <kind>-<id>-<version>.entry.json（MarketItemV2 形状，archive.url 留占位 {{BASE_URL}}）」
//  - 「官方 pack:extension 对 App 在打包前及最终 ZIP 上执行静态校验，错误时不交付新的安装包。」
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PACK_SCRIPT = join('scripts', 'extension-pack.mjs');

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 定位官方打包器并核对它属于 pin 住的版本。
 * 显式给的目录无效就报错，不回退去猜另一份安装 —— 这是官方明确的契约。
 */
export function resolveToolchain({ toolsRoot, pin }) {
  const root = resolve(toolsRoot);
  const script = join(root, PACK_SCRIPT);
  if (!existsSync(script)) {
    throw new Error(`官方工具链无效：${root} 下没有 ${PACK_SCRIPT}。` +
      `按宿主契约应指向已安装 Server 的版本目录（CI 里解包官方 server 分发目录后指向它）。`);
  }
  const verifiedPath = join(root, '.verified');
  let verified = null;
  if (existsSync(verifiedPath)) {
    try {
      verified = JSON.parse(readFileSync(verifiedPath, 'utf8'));
    } catch {
      verified = null;
    }
  }
  if (pin?.sha256) {
    const actual = verified?.sha256 ?? null;
    // .verified 里的 sha256 是官方分发包的 sha256，和公开 channel manifest 对得上；
    // 对不上说明拿到的是另一份安装，必须停。
    if (actual && actual.toLowerCase() !== pin.sha256.toLowerCase()) {
      throw new Error(`工具链版本不匹配：目录声明 ${actual}，配置 pin 的是 ${pin.sha256}。拒绝静默换用另一份安装。`);
    }
    if (!actual) {
      throw new Error(`工具链目录缺少 .verified，无法证明它是 pin 住的官方分发包（期望 sha256=${pin.sha256}）。`);
    }
  }
  return {
    root,
    script,
    version: verified?.version ?? null,
    platformArch: verified?.platformArch ?? null,
    distributionSha256: verified?.sha256 ?? null,
    scriptSha256: sha256(readFileSync(script)),
  };
}

/**
 * 调官方打包器。stageDir 必须是「以 id 命名的暂存目录」。
 * 失败一律非零退出并把官方输出原样带出，不做任何本地补救式打包。
 */
export function packWithOfficial({ toolchain, kind, stageDir, publisher, outDir, cwd }) {
  if (!statSync(stageDir).isDirectory()) throw new Error(`暂存目录不存在：${stageDir}`);
  const args = [
    toolchain.script,
    '--kind', kind,
    '--dir', stageDir,
    '--publisher', publisher,
    '--out', outDir,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HANA_APP_TOOLS_ROOT: toolchain.root },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (res.status !== 0) {
    throw new Error(`官方 extension-pack 失败（exit ${res.status}）：\n${stdout}\n${stderr}`.trim());
  }
  // 官方把静态校验的 warning 写到 stderr 且退出码仍是 0；这类 warning 必须原样上报，不能吞。
  return { stdout, stderr, exitCode: res.status };
}

/**
 * 从官方公开源取 pin 住的固定版本分发包。
 * 只下载、只读公开源、只往 dest 写：不上传任何东西。
 * 先写 dest.part，sha256/size 都对上才改名到 dest —— 校验不过不留半个文件在 dest 上。
 */
export async function downloadPinned({ url, dest, pin, fetchImpl = fetch, timeoutMs = 600000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const part = `${dest}.part`;
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    if (!res.body) throw new Error(`下载没有响应体：${url}`);

    const hash = createHash('sha256');
    let bytes = 0;
    const src = Readable.fromWeb(res.body);
    src.on('data', (c) => { hash.update(c); bytes += c.length; });
    await pipeline(src, createWriteStream(part));

    const actual = hash.digest('hex');
    if (pin?.sha256 && actual.toLowerCase() !== pin.sha256.toLowerCase()) {
      throw new Error(`分发包 sha256 不符：实际 ${actual}，pin ${pin.sha256}`);
    }
    if (pin?.size != null && bytes !== pin.size) {
      throw new Error(`分发包大小不符：实际 ${bytes}，pin ${pin.size}`);
    }
    renameSync(part, dest);
    return { dest, bytes, sha256: actual };
  } catch (err) {
    try { unlinkSync(part); } catch { /* 本来就没有 */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}