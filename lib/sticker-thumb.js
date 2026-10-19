/**
 * 表情包缩略图。
 *
 * 图库里的图动辄一两兆，GIF 能到六兆；网格的格子只有五十来像素，
 * 却要为了显示它把整张原图搬进 webview。几百张铺下来就是几百 MB，
 * 表现出来就是「打开表情包半天转不出来，还一堆空格子」。
 *
 * 这里的做法：按图片内容哈希把缩略图缓存到数据目录，第一次现算，之后直接读小文件。
 * 算不出来的格式（这里只剩 JPEG 和 WebP）老实返回 null，由调用方退回原图，
 * 宁可慢一点，也不能给她一张错图或者空白。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import omggif from "./vendor/omggif.cjs";
import { decodeJpeg } from "./jpeg-codec.js";
import { MAX_DECODE_PIXELS, decodePng, encodePng, resizeRgba } from "./png-codec.js";

const { GifReader } = omggif;

const DIR_NAME = "sticker-thumbs";
/**
 * 预热时读哪些：能真的缩下来的那几种。
 * webp 不在里头——读一遍也缩不出来，只是白拉一兆多。
 * 真有后缀写错的（例如 PNG 叫成 .gif），缩略图请求那次会按文件头认出来，照样能缩。
 */
const SHRINKABLE_RE = /\.(png|gif|jpe?g)$/i;
/**
 * 最长边 256：格子里是五十到一百像素，悬浮大预览是 168，
 * 256 留够了高分屏的余量，再大只是白费带宽。
 */
export const THUMB_MAX_SIZE = 256;

/** 缓存键：优先用图库自带的 sha256；来源图库那份快照没带哈希，就拿文件路径顶。 */
export function thumbKeyFor(row) {
  const sha = String(row?.sha256 ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(sha)) return sha;
  return crypto.createHash("sha256").update(`path:${String(row?.file ?? "")}`).digest("hex");
}

function thumbFile(dataDir, key) {
  return path.join(String(dataDir ?? ""), DIR_NAME, `${key}.png`);
}

/** 命中缓存就连原图都不读。返回 null 表示还没生成过，或者生成失败。 */
export function readCachedThumb(dataDir, key) {
  try {
    const bytes = fs.readFileSync(thumbFile(dataDir, key));
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** 只想知道有没有缓存时用它：只看文件在不在，不用把几十 KB 读进来。 */
export function hasThumb(dataDir, key) {
  try {
    return fs.statSync(thumbFile(dataDir, key)).size > 0;
  } catch {
    return false;
  }
}

function saveThumb(dataDir, key, bytes) {
  const target = thumbFile(dataDir, key);
  // 先写临时文件再改名：写成一半就崩（磁盘满、掉电）时，
  // 那个半张 PNG 会留在缓存里、而且 hasThumb 只看大小 > 0 就当命中，永远不会自愈。
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch {
    /* 缓存写不进去不算错：这一张慢一点而已，下回再存 */
    try { fs.unlinkSync(tmp); } catch { /* 临时文件本来就没建起来 */ }
  }
}

/** 动图只取第一帧：网格里它就是个静态小图，没必要把动画解完。 */
function gifFirstFrame(bytes) {
  let reader;
  try {
    reader = new GifReader(bytes);
  } catch {
    return null;
  }
  const { width, height } = reader;
  if (!width || !height || width * height > MAX_DECODE_PIXELS) return null;
  const canvas = new Uint8Array(width * height * 4);
  try {
    reader.decodeAndBlitFrameRGBA(0, canvas);
  } catch {
    return null;
  }
  return { width, height, data: Buffer.from(canvas.buffer, canvas.byteOffset, canvas.length) };
}

/**
 * 看图片头认格式，不看后缀。
 * 她图库里就有一张后缀写着 .jpeg、内容其实是 PNG 的；
 * 认错一次的后果是那张图永远缩不下来。
 * @returns {"image/png"|"image/gif"|"image/jpeg"|null}
 */
export function sniffImageType(bytes) {
  if (!bytes?.length) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.length > 6 ? bytes.toString("ascii", 0, 6) : "";
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}

/**
 * 把一张图缩成缩略图。
 * @returns {Promise<Buffer|null>} PNG 字节；认不出的格式给 null
 */
export async function buildStickerThumb(bytes, contentType) {
  if (!bytes?.length) return null;
  const kind = sniffImageType(bytes) || String(contentType ?? "").toLowerCase();
  // 解码器不对每张图都保证只返回 null：坏文件、截断的段都可能让它抛出来。
  // 这里兜住，是因为调用它的有一条是后台预热：那张图缩不出来就是缩不出来，
  // 不能让一张坏图把整批补图打断。
  let decoded = null;
  try {
    if (kind === "image/png") decoded = decodePng(bytes);
    else if (kind === "image/jpeg") decoded = decodeJpeg(bytes);
    else if (kind === "image/gif") decoded = gifFirstFrame(bytes);
  } catch {
    return null;
  }
  if (!decoded) return null;
  const small = resizeRgba(decoded.data, decoded.width, decoded.height, THUMB_MAX_SIZE);
  try {
    return await encodePng(small.width, small.height, small.data);
  } catch {
    return null;
  }
}

/**
 * 要一张缩略图：缓存里有就直接给，没有才去读原图现算一张再存下。
 * @param {string} dataDir 应用数据目录
 * @param {{sha256?: string, file?: string}} row 图库或来源快照里的那一行
 * @param {() => Promise<{bytes: Buffer, contentType: string}|null>} load 读原图
 * @returns {Promise<Buffer|null>}
 */
export async function ensureStickerThumb(dataDir, row, load) {
  const key = thumbKeyFor(row);
  if (!key) return null;
  const cached = readCachedThumb(dataDir, key);
  if (cached) return cached;
  const found = await load();
  if (!found?.bytes?.length) return null;
  const thumb = await buildStickerThumb(found.bytes, found.contentType);
  if (thumb) saveThumb(dataDir, key, thumb);
  return thumb;
}

/** 图库里还差几张缩略图（缓存没建全时用）。 */
export function missingThumbKeys(dataDir, rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = thumbKeyFor(row);
    if (key && !hasThumb(dataDir, key)) out.push({ row, key });
  }
  return out;
}

const warming = new Set();

/**
 * 后台慢慢把缺的那几张缩略图补齐。
 *
 * 不这么做的话：升级后的头几次打开表情包，每张缩略图都得现算，
 * 等于把「慢」从每次变成一次。她那边看不出区别，只会觉得这回又卡了。
 * 一次一张、一张歇一口气：补完就再也不占事。
 *
 * 每次调用都重新扫一遍（扫只看文件在不在，很便宜），所以**以后新加的图也会被补上**；
 * 正在跑的时候再来一次就直接拿上一次那个，不会叠两条。
 *
 * @param {string} dataDir
 * @param {Array} rows 图库或来源快照里的行
 * @param {(row: object) => Promise<{bytes: Buffer, contentType: string}|null>} load
 * @param {{idleMs?: number, scope?: string}} opts scope 区分自己图库和来源库
 * @returns {Promise<number>} 这一轮补出几张
 */
export function startThumbWarmup(dataDir, rows, load, { idleMs = 120, scope = "library" } = {}) {
  const slot = `${dataDir}\u0000${scope}`;
  if (warming.has(slot)) return Promise.resolve(0);
  const pending = missingThumbKeys(dataDir, rows).filter(({ row }) => SHRINKABLE_RE.test(String(row?.file ?? "")));
  // 没得补就直接回，别动槽位：下面的任务可能一口气跑完，
  // 先 delete 再 add 的话，槽位会永久卡住，以后新加的图就再也补不上了。
  if (!pending.length) return Promise.resolve(0);
  warming.add(slot);
  const task = (async () => {
    let made = 0;
    try {
      for (const { row } of pending) {
        const key = thumbKeyFor(row);
        if (hasThumb(dataDir, key)) continue;
        // 单张出错只算这一张缩不出来，不往上传。以前这里不包 try，
        // 一张坏图就把循环打断，warming.delete 也跟着跳掉，那个槽位就永久卡死，
        // 以后新加的图再也补不上缩略图，而且一声不响。
        try {
          const found = await load(row);
          const thumb = found?.bytes?.length ? await buildStickerThumb(found.bytes, found.contentType) : null;
          if (thumb) {
            saveThumb(dataDir, key, thumb);
            made++;
          }
        } catch {
          /* 这一张跳过，接着补下一张 */
        }
        await new Promise((resolve) => setTimeout(resolve, idleMs));
      }
    } finally {
      // 不管正常跑完还是被半路抛出来，槽位一定要放开。
      warming.delete(slot);
    }
    return made;
  })();
  return task;
}
