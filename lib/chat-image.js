/** 聊天照片只由最终回复触发；档位与标记共用一个业务入口。 */
export const IMAGE_TIERS = ["off", "less", "normal", "more"];
export const GLOBAL_IMAGE_LIMITS = { off: 0, less: 4, normal: 8, more: 16 };
export const PARTNER_IMAGE_LIMITS = { off: 0, less: 1, normal: 2, more: 4 };
export function normalizeImageTier(value) { return IMAGE_TIERS.includes(value) ? value : "off"; }

export function parseChatImage(text) {
  const raw = String(text ?? "");
  let output = "";
  let cursor = 0;
  const requests = [];
  let markers = 0;
  const start = /\[\s*生图\s*[:：]/g;
  let match;
  while ((match = start.exec(raw))) {
    markers++;
    output += raw.slice(cursor, match.index);
    let pos = start.lastIndex;
    while (/\s/.test(raw[pos] || "") && pos < raw.length) pos++;
    const begin = pos;
    let depth = 0, quoted = false, escaped = false, end = -1;
    if (raw[pos] === "{") {
      for (; pos < raw.length; pos++) {
        const ch = raw[pos];
        if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) { end = pos + 1; break; }
      }
    }
    let close = end;
    while (close >= 0 && close < raw.length && /\s/.test(raw[close])) close++;
    if (end >= 0 && raw[close] === "]") {
      try {
        const value = JSON.parse(raw.slice(begin, end));
        if (typeof value.prompt === "string" && value.prompt.trim() && value.prompt.length <= 4000 && typeof value.self === "boolean" && Object.keys(value).every(key => ["prompt", "self"].includes(key))) requests.push({ prompt: value.prompt.trim(), self: value.self });
      } catch { /* 坏协议只移除，不能触发付费 */ }
      cursor = close + 1;
    } else {
      // 坏/半截协议可能跨多行；标记之后全部舍弃，不能把内部JSON漏进聊天。
      cursor = raw.length;
    }
    start.lastIndex = cursor;
  }
  output += raw.slice(cursor);
  return { text: output.trim(), request: requests.length === 1 ? requests[0] : null,
    status: markers === 0 ? "none" : markers === 1 && requests.length === 1 ? "valid" : "invalid" };
}
/** 只在既有普通主动落点里挑照片表达，不另排定时器，也不因此提交付费请求。 */
export function pickPhotoShare({ enabled = false, tier = "off", hasContext = false, blocked = false, recentPhoto = false, random = Math.random } = {}) {
  if (!enabled || !hasContext || blocked || recentPhoto) return false;
  const weight = { less: 0.25, normal: 0.65, more: 1.2 }[normalizeImageTier(tier)] ?? 0;
  return weight > 0 && random() < weight / (1 + weight);
}

export function photoSharePrompt({ hasReference = false } = {}) {
  return [
    "【生活照片分享】这一轮专门考虑给对方分享一张生活照片，而非先写一段文字再顺便配图。",
    "先从最近真实聊天和已有角色状态里，选一个此刻值得给对方看的具体画面。不能把对方的生活冒充自己的，也不能凭空声称刚去了某处或经历了某事。",
    hasReference ? "你有外貌参考，可以自己出镜或只拍物件、食物或风景；是否露脸由你选择。自己出镜，包括背影和手部等局部，一律self=true。" : "你没有外貌参考，这轮只能self=false分享无人物的物件、食物或风景，不拍自己的脸、背影或手部。",
    "画面要比刚分享过的照片有新意。选好后按聊天照片协议输出一张图，可带一句自然配文或只发图。若没有合适画面、信息不够或不想拍，这轮只输出[不回]，不凑图片，不发送空头发图承诺。",
  ].join("\n");
}

export function chatImagePrompt({ enabled = false, hasReference = false, tier = "less", shareOnly = false } = {}) {
  const willingness = {
    less: "【发图意愿：少一些】你较少用图片表达，普通闲聊优先文字；有很贴切、值得一看的场景时，也可以主动分享。",
    normal: "【发图意愿：适中】你愿意顺着聊天分享眼前的画面；聊到自己的穿搭、吃喝、出门或小发现时，自然考虑用一张图让对方看看。",
    more: "【发图意愿：多一些】你更喜欢用图片分享生活；有合适的新场景时积极考虑主动拍给对方看，不要总等对方索要，但不连续刷图。",
  }[normalizeImageTier(tier)];
  if (!enabled || !willingness) return "";
  return [
    shareOnly ? "【聊天照片】生图能力已接通：按下述协议输出隐藏标记，系统会把成功生成的图片和配文一起发出。这轮按【生活照片分享】决定是否出图，没有合适画面就跳过本轮。" : "【聊天照片】生图能力已接通：你在回复里写出下述隐藏标记，系统就会生成图片，并把成功的图片和配文一起发给对方。你可以自己发起，不必等对方明确索要；也可以拒绝或只聊文字。",
    shareOnly ? "" : willingness,
    shareOnly ? "" : "回复前先考虑一下：此刻有没有一幅属于你、值得给对方看的画面？聊到自己的穿搭、吃喝、出门见闻或小发现时，主动把发照片作为一种表达选择；比起只描述，给对方看一张是否更贴切？有合适画面时可以直接发图加一句自然配文，或只发图。这个判断留在心里，不向对方解释。",
    "决定分享时要实际输出生图标记，让系统执行；仅写‘给你看看’、‘发张照片’或用文字描绘一张图，都不会生成图片。prompt写清主体、场景和关键视觉细节，以当前聊天已有信息为依据。",
    "画面要符合当前对话和你的角色状态，不要把对方的经历当成自己的。按最近聊天判断是否刚发过同类画面，避免重复；仅仅提到相关关键词不等于需要发图。",
    shareOnly ? "没有合适画面或不想拍时，只输出[不回]，不以普通文字替代照片，也不为了用完额度凑图。" : "没有合适画面就继续聊天，不必每轮发，不按固定轮数或随机抽签塞图，也不要为了用完额度凑图。",
    '决定发图时，在正文末尾追加且只追加一个隐藏标记：[生图:{"prompt":"具体画面描述","self":false}]。self=true表示画面有你本人；false表示只拍物件、食物或风景，不出现其他人物来冒充自己。',
    hasReference ? "你已有固定外貌参考。出镜与否由你选择，可以露脸、拍背影、侧影或只拍自己的手部等局部，也可以完全不出镜。出现你本人时必须self=true，包括不露脸的背影和局部；系统自动带上参考照，保持角色与参考画风一致。参考照不代表必须露脸。不出镜时用self=false。" : "你还没有外貌参考，只能self=false拍无人物的画面，不用陌生人的脸、背影或手部冒充自己。没有参考照也可以正常分享物件和风景，不必为了发图强行自拍。",
    "画风不写死：人物图遵循参考照，其他照片按聊天情境。一次最多一张。不需要暴露标记、额度或生成过程；不要提前声称照片已经拍好，配文只随成功的图片一起发。",
  ].join("\n");
}
