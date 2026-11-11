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
  const start = /\[\s*生图\s*[:：]/g;
  let match;
  while ((match = start.exec(raw))) {
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
  return { text: output.trim(), request: requests.length === 1 ? requests[0] : null };
}
export function chatImagePrompt({ enabled = false, hasReference = false, tier = "less" } = {}) {
  const willingness = {
    less: "【发图意愿：少一些】你较少用图片表达，普通闲聊优先文字；有很贴切、值得一看的场景时，也可以主动分享。",
    normal: "【发图意愿：适中】你愿意顺着聊天分享眼前的画面；聊到自己的穿搭、吃喝、出门或小发现时，自然考虑用一张图让对方看看。",
    more: "【发图意愿：多一些】你更喜欢用图片分享生活；有合适的新场景时积极考虑主动拍给对方看，不要总等对方索要，但不连续刷图。",
  }[normalizeImageTier(tier)];
  if (!enabled || !willingness) return "";
  return [
    "【聊天照片】你可以根据眼前聊天自己决定分享一张照片，也可以拒绝或只聊文字。不必等对方明确索要；当画面比文字更能表达此刻时，可以主动分享。",
    willingness,
    "画面要符合当前对话和你的角色状态，不要把对方的经历当成自己的。按最近聊天判断是否刚发过同类画面，避免重复；仅仅提到相关关键词不等于需要发图。",
    "没有合适画面就继续聊天，不必每轮发，不按固定轮数或随机抽签塞图，也不要为了用完额度凑图。",
    '决定发图时，在正文末尾追加且只追加一个隐藏标记：[生图:{"prompt":"具体画面描述","self":false}]。self=true表示画面有你本人；false表示只拍物件、食物或风景，不出现其他人物来冒充自己。',
    hasReference ? "你已有固定外貌参考。出现你本人时必须self=true，系统自动带上参考照，保持角色与参考画风一致。" : "你还没有外貌参考，只能self=false拍无人物的画面。想发自拍时先自然说明还没有定好参考照，不编一张陌生人的脸。",
    "画风不写死：人物图遵循参考照，其他照片按聊天情境。一次最多一张。不需要暴露标记、额度或生成过程；不要提前声称照片已经拍好，配文只随成功的图片一起发。",
  ].join("\n");
}
