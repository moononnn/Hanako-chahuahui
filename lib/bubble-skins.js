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
 *
 * 2026-11-15 新增 art-* 八款（新画廊）：它们不挤进 ui/assets/bubble-skins.css，
 * 另走 ui/assets/bubble-gallery.css，两边互不覆盖。变量名沿用同一套约定
 * （[data-me-skin="id"] / [data-ta-skin="id"]），所以设置页与聊天页的挂法不用改。
 */

/** id、名字、分组、还有一句说给用户听的话（设置页上写在那儿）。 */
export const BUBBLE_SKIN_GROUPS = [
  { id: "everyday", label: "日常简约" },
  { id: "illustrated", label: "插画装饰" },
  { id: "effects", label: "光效与像素" },
];

// 只收当前可选款；下架款自动归回原味，原素材保留，方便恢复。
// moods 供伙伴按心情挑皮肤；没写的原味只供手选与兜底。
export const BUBBLE_SKINS = [
  { id: "plain", group: "everyday", label: "原味", hint: "跟现在一样，气泡颜色跟着聊天背景走" },
  { id: "outline", group: "everyday", label: "描边", hint: "两像素的线勾出轮廓，底色只留一层薄雾", moods: ["calm", "anxious", "annoyed"] },
  { id: "sakura", group: "everyday", label: "樱花", hint: "粉白底上飘着几朵小花", moods: ["happy", "moved", "missing"] },
  { id: "polka", group: "everyday", label: "波点", hint: "浅底上一颗颗规规矩矩的圆点", moods: ["happy", "excited", "calm"] },

  { id: "ill-croc", group: "illustrated", label: "团团小鳄", hint: "小爪先后轻扒框沿，下角叶片轻摇，动一阵歇一阵", moods: ["happy", "excited", "calm"] },
  { id: "ill-fox", group: "illustrated", label: "杏桃小狐", hint: "耳尖、尾尖偶尔轻动，闭眼安静地歇着", moods: ["calm", "moved", "missing"] },
  { id: "ill-berry", group: "illustrated", label: "草莓奶霜", hint: "叶片轻摇，奶油心微微亮起，动完歇一会儿", moods: ["happy", "bliss", "excited"] },
  { id: "ill-whale", group: "illustrated", label: "奶蓝云鲸", hint: "尾巴和鳍轻动，偶尔冒泡，动一阵歇一阵", moods: ["calm", "tired", "missing", "sad"] },
  { id: "art-rabbit", group: "illustrated", label: "桃桃垂耳兔", hint: "耳朵轻轻摆两下，趴着等你回话", moods: ["happy", "moved", "hurt"] },
  { id: "art-capybara", group: "illustrated", label: "奶茶水豚", hint: "头顶叶子轻晃一阵，再安静歇一会儿", moods: ["calm", "tired", "missing"] },
  { id: "art-chick", group: "illustrated", label: "黄油小鸡", hint: "翅膀扑两下就停，黄油色暖烘烘的", moods: ["happy", "excited", "bliss"] },
  { id: "art-jellyfish", group: "illustrated", label: "月光水母", hint: "触须轻轻浮着，光从里头透出来", moods: ["calm", "moved", "sad"] },
  { id: "art-cloud", group: "illustrated", label: "晴空云糖", hint: "云朵轮廓挂彩虹，雨滴晃两下再歇", moods: ["happy", "bliss", "bored"] },

  { id: "rainbow", group: "effects", label: "彩虹糖", hint: "一圈七色渐变的边，白底彩框", moods: ["happy", "bliss", "excited"] },
  { id: "holo", group: "effects", label: "镭射", hint: "一层虹彩压在白底上，转个角度看会变色", moods: ["excited", "happy", "bliss"] },
  { id: "neon", group: "effects", label: "赛博", hint: "近黑的底，荧光描边加扫描线", moods: ["excited", "annoyed", "anxious"] },
  { id: "art-pixel", group: "effects", label: "像素心跳", hint: "阶梯像素框配小心，亮一阵歇一阵", moods: ["excited", "happy", "angry"] },
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
