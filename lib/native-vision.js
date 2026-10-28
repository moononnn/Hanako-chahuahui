/**
 * 原生识图的图片记号：把「［附图：img_x］」兑成图片本体或当时写下的描述。
 *
 * 记号是 prompt 那一侧写下的（见 lib/prompt.js 的 threadToMessages），这里负责兑付。
 * 两条规矩，都是踩出来的：
 *
 *   ① 她一口气甩几张都得带上，不能只带第一张。
 *      她连发的两句会合成一条 user 消息，内容里就有两个记号；只认第一个的话，
 *      剩下那个会原样留给模型当字面文读，那张图等于没发。
 *      但一轮也不能给十张——原图是几兆的东西，一轮塞十张是把请求往爆里推。
 *
 *   ② 这一轮没带本体的那些，用当时写下的描述顶上。
 *      只留「她发过一张图」的话，下一轮她追问「图上第二行写的啥」，
 *      模型手上一个字都没有，只能去翻工具或者编。
 */

/** 记号的唯一写法。prompt 那一侧写的时候用的是同一串括号。 */
export const MARK_RE = /［附图：(img_[A-Za-z0-9_-]+)］\n?/gu;

const MARK_HINT = "［附图：";

/** 一轮请求里最多带几张原图。 */
export const NATIVE_IMAGE_PER_TURN = 3;

/**
 * 一轮请求里原图的体积上限（按 base64 字符算）。
 *
 * 张数管不住体积：单张上限 10MB，三张就是 30MB，base64 之后约 40MB，
 * 直接撞宿主 32MB 的请求体上限。所以张数和体积两道一起守。
 * 12MB 够装三张常见的 2MB 截图；更大的从第二张起退成描述。
 */
export const NATIVE_IMAGE_BYTES_PER_TURN = 12 * 1024 * 1024;

/**
 * 带原图的最多往前几行 user。
 *
 * 她发完图、下一句接着追问「图上第二行写的啥」，是最常见的那种下一句。
 * 只认「最后一条」的话，她追问时模型手上就只剩一句描述（甚至什么都没有），
 * 刚看过的那张等于没看。
 */
export const NATIVE_IMAGE_BODY_ROWS = 2;

/** 描述最多带这么多：它只是给模型一个把手，不是正文。 */
export const SEEN_TEXT_LIMIT = 1200;

export function hasNativeImageMark(content) {
  return typeof content === "string" && content.includes(MARK_HINT);
}

/**
 * 把一块文字接到末尾；上一块也是文字就连起来。
 *
 * 不连的话，她原话里放在图前后两边的那些字会变成一串碎块，
 * 图片换成描述时尤其碎：逗号、描述、后半句各占一条，读起来不像人说的话。
 */
function pushText(parts, text) {
  const clean = String(text ?? "").trim();
  if (!clean) return;
  const last = parts.at(-1);
  if (last?.type === "text") {
    last.text = `${last.text}\n${clean}`;
    return;
  }
  parts.push({ type: "text", text: clean });
}

/**
 * 把一条内容里的记号一个个兑掉，保留原来的阅读顺序。
 *
 * @param {string} content 带记号的那条内容
 * @param {{
 *   imageOf?: (id: string) => ({ type: "image", mimeType: string, data: string }|null),
 *   seenOf?: (id: string) => string,
 *   budget?: { left: number },
 * }} options
 *   imageOf 只该在「这一轮真要带本体」时给；不给我就只能用描述顶。
 *   budget 跨行共用，免得一段历史里的图加起来还是超；left 管张数，
 *   bytesLeft 管体积，taken 记这一轮已经带了几张（第一张不卡体积）。
 * @returns {{ content: string|Array, images: number, hit: boolean }}
 *   hit 为假表示这条内容里没有记号，调用方不必动它。
 *   全是文字时 content 退回字符串，跟原来那条的形状保持一致。
 */
export function rewriteNativeImageMarks(content, { imageOf = () => null, seenOf = () => "", budget } = {}) {
  if (!hasNativeImageMark(content)) return { content, images: 0, hit: false };
  // 调用方只传 left 也照跑，缺的按默认补齐。
  const spend = budget && typeof budget === "object" ? budget : {};
  if (!Number.isFinite(Number(spend.left))) spend.left = NATIVE_IMAGE_PER_TURN;
  if (!Number.isFinite(Number(spend.bytesLeft))) spend.bytesLeft = NATIVE_IMAGE_BYTES_PER_TURN;
  if (!Number.isFinite(Number(spend.taken))) spend.taken = 0;
  const parts = [];
  let images = 0;
  let last = 0;
  let hit = false;
  MARK_RE.lastIndex = 0;
  for (let match = MARK_RE.exec(content); match; match = MARK_RE.exec(content)) {
    hit = true;
    pushText(parts, content.slice(last, match.index));
    last = match.index + match[0].length;
    const id = match[1];
    const image = Number(spend.left) > 0 && typeof imageOf === "function" ? imageOf(id) : null;
    const size = image?.data ? String(image.data).length : 0;
    // 这一轮的第一张不论多大都带：单张最大也就 10MB（base64 约 13.3MB），
    // 带一张不会撞上限。从第二张起看体积，装不下就退成描述。
    const fits = Number(spend.taken) === 0 || size <= Number(spend.bytesLeft);
    if (image?.data && fits) {
      parts.push(image);
      images += 1;
      spend.taken = Number(spend.taken) + 1;
      spend.left = Number(spend.left) - 1;
      spend.bytesLeft = Number(spend.bytesLeft) - size;
      continue;
    }
    // 本体没带上来（这轮额度用完了，或者那张原图已经按期限清掉）：
    // 有描述就用描述，一个字都没有才退到最笼统的那句。
    const seen = String(seenOf(id) ?? "").trim().slice(0, SEEN_TEXT_LIMIT);
    pushText(parts, seen ? `［这张图当时看到的是：${seen}］` : "［她发过一张图］");
  }
  if (!hit) return { content, images: 0, hit: false };
  pushText(parts, content.slice(last));
  if (!parts.length) pushText(parts, "［她发过一张图］");
  const onlyText = parts.every((part) => part.type === "text");
  return {
    content: onlyText ? parts.map((part) => part.text).join("\n") : parts,
    images,
    hit: true,
  };
}
