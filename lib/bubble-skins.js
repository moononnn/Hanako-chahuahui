/**
 * 聊天气泡的装扮清单。
 *
 * 像 QQ 的付费气泡那样，气泡不再只是「一张纸」，而是一套有边框、
 * 有渐变、有尾巴的壳。清单放这里，后端认白名单、设置页照着画预览，
 * 两边不会各认一套。
 *
 * 界面上真正长什么样在 ui/assets/bubble-skins.css：那边的
 * [data-bubble-skin-me="id"] 给「我」这一侧一组变量，
 * [data-bubble-skin-ta="id"] 给伙伴那一侧一组变量，跟这里的 id 一一对应。
 *
 * 分组只影响设置页怎么摆（group 那一栏），不影响存的是哪一套：
 * 淡雅那几套压得住长文，可爱那几套适合短句，花哨那几套自己会发光。
 *
 * 2026-10-28 按作者的意思删掉十二套（便签、宣纸、亚麻、缎带、糖果、
 * 奶油泡芙、猫爪、云朵、液态金属、星球、极光、烈焰）。删掉的那几套
 * 变量原文留在临时目录的 bubble-skins-24-full-20261028.css 里，
 * 要往回捡随时能捡。存过它们的配置读出来会回原味，不报错。
 *
 * 2026-10-28 晚：两侧拆开。以前一套皮肤同时决定两个人长什么样，
 * 现在「我」在设置页里挑自己的，伙伴那侧由 ta 按当天心情自己换
 * （见 lib/bubble-skin-mood.js）。这一节新增的 moods 就是给那条线用的：
 * 每套皮肤自己说「什么心境下我愿意长这样」，伙伴挑的时候照它挑。
 *
 * 以后加新样式只需要两步：这里加一行（带 label / hint / moods），
 * CSS 里补 [data-bubble-skin-me="新id"] 和 [data-bubble-skin-ta="新id"] 两组变量。
 * 伙伴那边不用改逻辑，只要 moods 里有它的心情就有机会被挑中。
 */

/** id、名字、分组、还有一句说给用户听的话（设置页上写在那儿）。 */
export const BUBBLE_SKIN_GROUPS = [
  { id: "plain", label: "淡雅" },
  { id: "cute", label: "可爱" },
  { id: "flashy", label: "花哨" },
];

/**
 * moods 写的是这套皮肤在哪些心境下成立，用的是心情日盘那十三格
 * （lib/mood-daily.js 的 MOOD_GRID）。没写 moods 的一套不参与伙伴自选，
 * 只给用户自己挑——原味就是这样：它不算一种"打扮"，是"没打扮"。
 */
export const BUBBLE_SKINS = [
  // ── 淡雅：釉、线，字最沉得住 ──
  { id: "plain", group: "plain", label: "原味", hint: "跟现在一样，气泡颜色跟着聊天背景走" },
  { id: "celadon", group: "plain", label: "青瓷", hint: "青灰釉色，一层内亮边", moods: ["calm", "bored", "missing"] },
  { id: "outline", group: "plain", label: "描边", hint: "两像素的线勾出轮廓，底色只留一层薄雾", moods: ["calm", "anxious", "annoyed"] },

  // ── 可爱：软、圆、带点小图案 ──
  { id: "jelly", group: "cute", label: "奶糖", hint: "果冻粉，顶上一点糖光", moods: ["happy", "excited", "bliss"] },
  { id: "sakura", group: "cute", label: "樱花", hint: "粉白底上飘着几朵小花", moods: ["happy", "moved", "missing"] },
  { id: "bear", group: "cute", label: "小熊", hint: "奶油棕的皮，顶上一对圆耳朵", moods: ["happy", "moved", "calm"] },
  { id: "marshmallow", group: "cute", label: "棉花糖", hint: "淡紫配奶黄，圆得没有棱角", moods: ["calm", "tired", "moved"] },

  // ── 花哨：会发光、会反光、带纹理 ──
  { id: "rainbow", group: "flashy", label: "彩虹糖", hint: "一圈七色渐变的边，白底彩框", moods: ["happy", "bliss", "excited"] },
  { id: "polka", group: "flashy", label: "波点", hint: "浅底上一颗颗规规矩矩的圆点", moods: ["happy", "excited", "calm"] },
  { id: "holo", group: "flashy", label: "镭射", hint: "一层虹彩压在白底上，转个角度看会变色", moods: ["excited", "happy", "bliss"] },
  { id: "star", group: "flashy", label: "星夜", hint: "深蓝紫渐变，撒一层碎星", moods: ["missing", "tired", "sad", "calm"] },
  { id: "neon", group: "flashy", label: "赛博", hint: "近黑的底，荧光描边加扫描线", moods: ["excited", "annoyed", "anxious"] },
  { id: "rain", group: "flashy", label: "霓虹雨", hint: "近黑底，斜着落一层霓虹雨丝", moods: ["sad", "anxious", "tired", "missing"] },
  { id: "pixel", group: "flashy", label: "像素", hint: "直角硬边，像老游戏里的对话框", moods: ["bored", "happy", "calm"] },
];

const SKIN_IDS = new Set(BUBBLE_SKINS.map((skin) => skin.id));
const BY_ID = new Map(BUBBLE_SKINS.map((skin) => [skin.id, skin]));

/** 认得的那套原样退回；不认得的（老数据、手改的）回原味，不凭空造样式。 */
export function normalizeBubbleSkin(value) {
  const id = String(value ?? "").trim();
  return SKIN_IDS.has(id) ? id : "plain";
}

export function bubbleSkinById(id) {
  return BY_ID.get(String(id ?? "").trim()) ?? null;
}

/** 伙伴自己那一侧能挑的池子：写了 moods 的才算一种"打扮"。 */
export const PARTNER_SKIN_IDS = Object.freeze(
  BUBBLE_SKINS.filter((skin) => Array.isArray(skin.moods) && skin.moods.length).map((skin) => skin.id),
);

/**
 * 某个心情下伙伴可能长什么样。
 * 心情落不到任何一套上（比如「委屈」「生气」这种还没人认领的），回空数组，
 * 调用方保住上一套不动——不为了"有变化"硬塞一套不搭的。
 */
export function skinsForMood(moodId) {
  const mood = String(moodId ?? "").trim();
  if (!mood) return [];
  return PARTNER_SKIN_IDS.filter((id) => BY_ID.get(id)?.moods.includes(mood));
}
