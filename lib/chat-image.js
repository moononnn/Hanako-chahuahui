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
export function chatImagePrompt({ enabled = false, hasReference = false } = {}) {
  if (!enabled) return "";
  return [
    "【聊天照片】你可以根据眼前聊天自己决定是否分享一张照片，也可以拒绝或只聊文字。不要逢提照片就营业，不需要每轮发。",
    '决定发图时，在正文末尾追加且只追加一个隐藏标记：[生图:{"prompt":"具体画面描述","self":false}]。self=true表示画面有你本人；false表示只拍物件、食物或风景，不出现其他人物来冒充自己。',
    hasReference ? "你已有固定外貌参考。出现你本人时必须self=true，系统自动带上参考照，保持角色与参考画风一致。" : "你还没有外貌参考，只能self=false拍无人物的画面。想发自拍时先自然说明还没有定好参考照，不编一张陌生人的脸。",
    "画风不写死：人物图遵循参考照，其他照片按聊天情境。一次最多一张。不需要暴露标记、额度或生成过程；不要提前声称照片已经拍好，配文只随成功的图片一起发。",
  ].join("\n");
}
