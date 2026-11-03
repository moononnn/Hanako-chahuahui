import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonDurable, writeJsonAtomic } from "./persistence.js";

const VERSION = 1;
const FILE_NAME = "sticker-library.json";
const IMAGE_DIR = "stickers";

function cleanText(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function normalizeGroupIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 30);
}

function emptyLibrary() {
  return { version: VERSION, groups: [], stickers: [], order: [] };
}

function filePath(dataDir) { return path.join(dataDir, FILE_NAME); }
function imagePath(dataDir, file) {
  const root = path.resolve(dataDir, IMAGE_DIR);
  const target = path.resolve(root, String(file || ""));
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

export function readStickerLibrary(dataDir) {
  const raw = readJsonDurable(filePath(dataDir), emptyLibrary());
  const groups = Array.isArray(raw?.groups)
    ? raw.groups.filter((group) => group && group.id && group.name).map((group) => ({ id: cleanText(group.id, 80), name: cleanText(group.name, 40) }))
    : [];
  const stickers = Array.isArray(raw?.stickers)
    ? raw.stickers.filter((row) => row && row.id && row.file).map((row) => ({
      id: cleanText(row.id, 120), sourceId: cleanText(row.sourceId, 120), file: cleanText(row.file, 180),
      sha256: cleanText(row.sha256, 64), description: cleanText(row.description, 80),
      emotion: Array.isArray(row.emotion) ? row.emotion.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 5) : [],
      scene: Array.isArray(row.scene) ? row.scene.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 5) : [],
      keywords: Array.isArray(row.keywords) ? row.keywords.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 8) : [],
      groupIds: normalizeGroupIds(row.groupIds),
    }))
    : [];
  /*
   * order 是她自己排出来的摆放顺序（前→后）。只认库里还有的图：
   * 删掉的那张不该在顺序里留个洞，后来重新导也当新的摆最前。
   */
  const order = Array.isArray(raw?.order) ? raw.order.map((id) => cleanText(id, 120)).filter(Boolean) : [];
  return { version: VERSION, groups, stickers, order };
}

/** 图库总量闸：导图是一次几百张的批量活，不设上限能把数据目录塞满。 */
const STICKER_TOTAL_BYTES = 500 * 1024 * 1024;

function saveStickerLibrary(dataDir, library) {
  writeJsonAtomic(filePath(dataDir), library);
}

/**
 * 界面上的摆放顺序，只算这一份。
 *
 * 两段拼起来：她亲手排过的按 order 走，没排过位置的（新导入的）永远排最前——
 * 她加完图第一件事就是想看一眼刚加的那几张。
 */
function orderedStickers(library) {
  const listed = Array.isArray(library.order) ? library.order : [];
  const byId = new Map(library.stickers.map((row) => [row.id, row]));
  const placed = [];
  const seen = new Set();
  for (const id of listed) {
    const row = byId.get(id);
    if (!row || seen.has(id)) continue;
    seen.add(id);
    placed.push(row);
  }
  const fresh = [];
  // 库里存的是导入顺序（越靠后越新），反过来才是新到旧
  for (let at = library.stickers.length - 1; at >= 0; at -= 1) {
    const row = library.stickers[at];
    if (!seen.has(row.id)) fresh.push(row);
  }
  return [...fresh, ...placed];
}

/** 给界面看的图库列表。 */
export function listStickerLibrary(dataDir) {
  const library = readStickerLibrary(dataDir);
  return {
    groups: library.groups,
    stickers: orderedStickers(library).map(({ file, sha256, ...row }) => row),
  };
}

/**
 * 把一张图挪到最前或最后。返回整份新顺序，界面照着摆就行。
 * @returns {{ ok: boolean, order: string[] }}
 */
export function moveStickerToEdge(dataDir, stickerId, position = "top") {
  const id = cleanText(stickerId, 120);
  const library = readStickerLibrary(dataDir);
  const current = orderedStickers(library).map((row) => row.id);
  if (!id || !current.includes(id)) return { ok: false, order: current };
  const rest = current.filter((rowId) => rowId !== id);
  const order = position === "bottom" ? [...rest, id] : [id, ...rest];
  if (order.join("\u0000") === current.join("\u0000")) return { ok: true, order };
  saveStickerLibrary(dataDir, { ...library, order });
  return { ok: true, order };
}

/**
 * 拖动排序。传进来的是「这一屏新排好的顺序」，可能只是图库的一小截。
 *
 * 只把这些图挪回它们原来占的那几个位置，别的图原地不动——
 * 不然在一个分组里拖一下，会把「全部」里别的图全挤走位。
 * @returns {{ order: string[], changed: boolean }}
 */
export function reorderStickers(dataDir, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => cleanText(id, 120)).filter(Boolean))];
  const library = readStickerLibrary(dataDir);
  const current = orderedStickers(library).map((row) => row.id);
  if (wanted.length < 2) return { order: current, changed: false };
  const known = new Set(current);
  const moving = wanted.filter((id) => known.has(id));
  if (moving.length < 2) return { order: current, changed: false };
  const waiting = new Set(moving);
  const slots = [];
  current.forEach((id, index) => { if (waiting.has(id)) slots.push(index); });
  const byId = new Map(library.stickers.map((row) => [row.id, row]));
  const order = current.slice();
  slots.forEach((slot, at) => { order[slot] = moving[at]; });
  const changed = order.join("\u0000") !== current.join("\u0000");
  if (changed) saveStickerLibrary(dataDir, { ...library, order: order.filter((id) => byId.has(id)) });
  return { order, changed };
}

export function createStickerGroup(dataDir, name) {
  const label = cleanText(name, 40);
  if (!label) throw new Error("分组名不能为空");
  const library = readStickerLibrary(dataDir);
  const duplicate = library.groups.find((group) => group.name === label);
  if (duplicate) return duplicate;
  const group = { id: `grp_${crypto.randomUUID()}`, name: label };
  library.groups.push(group);
  saveStickerLibrary(dataDir, library);
  return group;
}

export function importStickerBytes(dataDir, source, bytes, groupIds = []) {
  const buffer = Buffer.from(bytes);
  if (!buffer.length) throw new Error("图片为空");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const library = readStickerLibrary(dataDir);
  const existing = library.stickers.find((row) => row.sha256 === sha256);
  if (existing) {
    const next = new Set([...existing.groupIds, ...normalizeGroupIds(groupIds)]);
    existing.groupIds = [...next];
    saveStickerLibrary(dataDir, library);
    return { sticker: existing, duplicate: true };
  }
  const id = `local_${sha256.slice(0, 20)}`;
  const extension = String(source?.contentType || "image/jpeg").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
  const file = `${id}.${extension}`;
  const target = imagePath(dataDir, file);
  if (!target) throw new Error("图片路径不合法");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 单张管住了，总量也得管。超了只拒新的，不偷偷删她已经导进去的。
  const stickerDir = path.dirname(target);
  let usedBytes = 0;
  try {
    for (const name of fs.readdirSync(stickerDir)) {
      try { usedBytes += fs.statSync(path.join(stickerDir, name)).size; } catch { /* 读不到的跳过 */ }
    }
  } catch { /* 目录还没建 */ }
  if (usedBytes + buffer.length > STICKER_TOTAL_BYTES) {
    throw new Error(`图库太大了（已用约 ${Math.round(usedBytes / 1048576)} MB），先删掉一些不用的表情包再导`);
  }
  fs.writeFileSync(target, buffer);
  const sticker = {
    id, sourceId: cleanText(source?.id, 120), file, sha256,
    description: cleanText(source?.description, 80),
    emotion: Array.isArray(source?.emotion) ? source.emotion.slice(0, 5).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    scene: Array.isArray(source?.scene) ? source.scene.slice(0, 5).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    keywords: Array.isArray(source?.keywords) ? source.keywords.slice(0, 8).map((x) => cleanText(x, 24)).filter(Boolean) : [],
    groupIds: normalizeGroupIds(groupIds),
  };
  library.stickers.push(sticker);
  saveStickerLibrary(dataDir, library);
  return { sticker, duplicate: false };
}

/** 图库里那一行（连文件位置一起）。给只想拿元数据、不想读图片字节的调用方用。 */
export function readStickerRow(dataDir, stickerId) {
  const id = cleanText(stickerId, 120);
  if (!id) return null;
  return readStickerLibrary(dataDir).stickers.find((sticker) => sticker.id === id) ?? null;
}

/** 已经拿着行了，只去把图片字节读出来。 */
export function readStickerBytesOf(dataDir, row) {
  if (!row?.file) return null;
  const file = imagePath(dataDir, row.file);
  if (!file || !fs.existsSync(file)) return null;
  return { bytes: fs.readFileSync(file), contentType: `image/${path.extname(file).slice(1) || "jpeg"}` };
}

export function readOwnSticker(dataDir, stickerId) {
  const row = readStickerRow(dataDir, stickerId);
  if (!row) return null;
  const found = readStickerBytesOf(dataDir, row);
  return found ? { row, ...found } : null;
}

/**
 * 从图库移除一张。
 * 图片文件故意留着：她以前发出去的那条消息还得看得见。
 * @returns {boolean} 有没有真的移除
 */
export function removeSticker(dataDir, stickerId) {
  const id = cleanText(stickerId, 120);
  if (!id) return false;
  const library = readStickerLibrary(dataDir);
  const stickers = library.stickers.filter((row) => row.id !== id);
  if (stickers.length === library.stickers.length) return false;
  // 顺序里也不给删掉的那张留个坑：不然同一份图再导回来，会被拽回老位置
  const order = (Array.isArray(library.order) ? library.order : []).filter((rowId) => rowId !== id);
  saveStickerLibrary(dataDir, { ...library, stickers, order });
  return true;
}

/**
 * 删一个分组。组里的图不跟着删，只是退回「全部」。
 * @returns {boolean} 有没有真的删掉
 */
export function removeStickerGroup(dataDir, groupId) {
  const id = cleanText(groupId, 80);
  if (!id) return false;
  const library = readStickerLibrary(dataDir);
  const groups = library.groups.filter((group) => group.id !== id);
  if (groups.length === library.groups.length) return false;
  const stickers = library.stickers.map((row) => (
    row.groupIds.includes(id) ? { ...row, groupIds: row.groupIds.filter((g) => g !== id) } : row
  ));
  saveStickerLibrary(dataDir, { ...library, groups, stickers });
  return true;
}

/**
 * 改分组名。id 不动，组里的图也不用重新归位。
 * 撞名一律报错，不像建组那样静默返回那个同名的旧组——那会让她以为改成了自己那个。
 * @throws {Error} 名字空、撞名、分组不在，都说人话
 */
export function renameStickerGroup(dataDir, groupId, name) {
  const id = cleanText(groupId, 80);
  const label = cleanText(name, 40);
  if (!id) throw new Error("分组没找到");
  if (!label) throw new Error("分组名不能为空");
  const library = readStickerLibrary(dataDir);
  const group = library.groups.find((row) => row.id === id);
  if (!group) throw new Error("分组没找到");
  if (library.groups.some((row) => row.id !== id && row.name === label)) {
    throw new Error(`已经有叫「${label}」的分组了`);
  }
  if (group.name === label) return group;
  group.name = label;
  saveStickerLibrary(dataDir, library);
  return group;
}

