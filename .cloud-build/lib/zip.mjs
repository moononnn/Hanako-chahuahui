// 零依赖 zip 读取器：只用 Node 内建（fs / zlib）。
// 只读不解写，用来在门禁里独立检查官方打包器的产物。
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是 zip：找不到 EOCD 记录');
}

/**
 * 读出 zip 的条目表。只解析中央目录，不扫描本地头，条目顺序与中央目录一致。
 * @returns {{entries: Array, byName: Map, names: string[]}}
 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('不支持 ZIP64');
  if (off + count * 46 > buf.length) throw new Error('中央目录越界');

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new Error(`中央目录第 ${i} 项签名不对`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  return { entries, byName, names: entries.map((e) => e.name) };
}

/** 解出单个条目的字节；不支持的压缩方法直接抛，不静默跳过。 */
export function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== LFH_SIG) throw new Error(`条目本地头签名不对：${entry.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`条目 ${entry.name} 用了不支持的压缩方法 ${entry.method}`);
}

export function readEntryText(buf, entry) {
  return readEntry(buf, entry).toString('utf8');
}

export function readZipFile(path) {
  return readZip(readFileSync(path));
}