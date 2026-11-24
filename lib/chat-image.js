/** 聊天照片只由最终回复触发；档位与标记共用一个业务入口。 */
export const IMAGE_TIERS = ["off", "less", "normal", "more"];
export const GLOBAL_IMAGE_LIMITS = { off: 0, less: 4, normal: 8, more: 32 };
export const PARTNER_IMAGE_LIMITS = { off: 0, less: 1, normal: 2, more: 8 };
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
/** 主动生活照的档位概率（直接就是这一轮抽中的把握，不再二次折算）。 */
export const PHOTO_SHARE_CHANCES = { less: 0.25, normal: 0.5, more: 0.8 };

export function photoShareChance(tier) {
  return PHOTO_SHARE_CHANCES[normalizeImageTier(tier)] ?? 0;
}

/** 只在既有普通主动落点里挑照片表达，不另排定时器，也不因此提交付费请求。 */
export function pickPhotoShare({ enabled = false, tier = "off", hasContext = false, blocked = false, recentPhoto = false, random = Math.random } = {}) {
  if (!enabled || !hasContext || blocked || recentPhoto) return false;
  const chance = photoShareChance(tier);
  return chance > 0 && random() < chance;
}

/**
 * 照片优先机会（2026-11-20）：视频候选一占位，照片这一轮连概率都不参与，
 * 实机上连着十几条主动全是视频，照片一次都轮不到。这里给照片一次低频插队：
 * 只在照片本来就拍得了、别的护栏也没挡时，把这一轮的视频让回去（候选没被标记，下一轮照发）。
 * 落点、间隔、日上限、静默时段、生图额度都不动；这一轮到底出不出图仍由模型自己说。
 */
export const PHOTO_OPPORTUNITY_CHANCE = 0.35;
export const PHOTO_OPPORTUNITY_GAP_MS = 8 * 60 * 60_000;

export function pickPhotoOpportunity({
  enabled = false, tier = "off", hasContext = false, hardBlocked = false, recentPhoto = false, sceneUsed = false,
  lastAt = null, now = Date.now(), gapMs = PHOTO_OPPORTUNITY_GAP_MS, chance = PHOTO_OPPORTUNITY_CHANCE, random = Math.random,
} = {}) {
  if (!enabled || !hasContext || hardBlocked || recentPhoto || sceneUsed) return false;
  if (photoShareChance(tier) <= 0) return false;
  const raw = now instanceof Date ? now.getTime() : Number(now);
  const at = Number.isFinite(raw) ? raw : Date.now();
  const last = Date.parse(String(lastAt ?? ""));
  if (Number.isFinite(last) && at - last < gapMs) return false;
  return chance > 0 && random() < chance;
}

/**
 * 照片候选被哪些门槛挡下（只报标识，不带聊天正文）。
 * 有了它，下一次就能看出是没依据、还是刚发过、还是这一轮根本轮不到照片。
 */
export function photoShareBlockers({ enabled = false, tier = "off", hasContext = false, blocked = false, recentPhoto = false, sceneUsed = false } = {}) {
  const out = [];
  if (!enabled) out.push("image-unavailable");
  if (!photoShareChance(tier)) out.push("tier-off");
  if (!hasContext) out.push("no-context");
  if (blocked) out.push("blocked");
  if (recentPhoto) out.push("recent-photo");
  if (sceneUsed) out.push("scene-used");
  return out;
}

/**
 * 这一轮为什么轮不到普通主动的照片（只报标识，不带聊天正文）。
 * 与 ordinaryProactive 的判定口径一致：这些场景各有各的护栏，照片不插队。
 */
export function imageSceneExclusions({ exception = false, followup = false, wakeEcho = false, greetingOnly = false, todoNudge = "", publicEvent = false, video = false, news = false, videoLoginNotice = false } = {}) {
  const out = [];
  if (exception) out.push("exception");
  if (followup) out.push("followup");
  if (wakeEcho) out.push("wake-echo");
  if (greetingOnly) out.push("greeting-only");
  if (String(todoNudge ?? "").trim()) out.push("todo");
  if (publicEvent) out.push("public-event");
  if (video) out.push("video");
  if (news) out.push("news");
  if (videoLoginNotice) out.push("video-login");
  return out;
}

/** 注入照片提示词的最近聊天原文，各限这么多字：不让一条超长原文顶穿上下文预算。 */
export const PHOTO_CONTEXT_TEXT_LIMIT = 160;

export function photoSharePrompt({ hasReference = false, context = null, standalone = false } = {}) {
  const lines = [
    "【生活照片分享】这一轮专门考虑用一张生活照片来表达，而不是先写一段文字再顺便配图。",
    "由头和话题以上面已经定下的那个为准：照片只是这一轮的表达方式之一，不能变成脱离由头的装饰。",
    standalone
      ? "这一轮没有最近的面对面聊天可依据：按你此刻的由头（想念、搭话这类）、心情和日常状态挑一个具体画面（你自己的样子、手上的物件、桌上的吃喝、窗外的景）。不要编造刚刚发生的事、刚去过的地方或对方不知道的经历。"
      : "先从最近真实聊天和已有角色状态里，选一个此刻值得给对方看的具体画面。不能把对方的生活冒充自己的，也不能凭空声称刚去了某处或经历了某事。",
  ];
  const userText = String(context?.userText ?? "").trim().slice(0, PHOTO_CONTEXT_TEXT_LIMIT);
  const assistantText = String(context?.assistantText ?? "").trim().slice(0, PHOTO_CONTEXT_TEXT_LIMIT);
  if (userText) {
    lines.push(`你们最近面对面聊到的是——对方说：${userText}；你说：${assistantText}。挑画面时以这段对话和你已有的状态为依据，不要另起一个没聊过的话题。`);
  }
  if (!standalone) lines.push("聊天里提过的事不要求此刻正在发生：可以拍跟那段话相关的东西、你能拿得出的物件或当时的状态，但不能把它说成自己刚刚才有的新经历。");
  lines.push(hasReference ? "你有外貌参考，可以自己出镜或只拍物件、食物或风景；是否露脸由你选择。自己出镜，包括背影和手部等局部，一律self=true。" : "你没有外貌参考，这轮只能self=false分享无人物的物件、食物或风景，不拍自己的脸、背影或手部。");
  lines.push("画面要比刚分享过的照片有新意。有合适画面就按聊天照片协议实际输出一张图，可带一句自然配文或只发图。");
  lines.push("照片是这一轮优先考虑的表达，不是硬指标：没有合适画面、但你有自然的新内容要跟她说，就直接写普通文字，不必硬凑图；真的没话说时才只输出[不回]。不要写“给你看看”这类空头图承诺。");
  lines.push("这一轮最多出一张图；出图不成功也不会再来一次，别在同一条里写两个生图标记。");
  return lines.join("\n");
}

/**
 * 抽中生活照、但这轮生图不可用（服务未就绪、额度用完、或这一轮被别的由头占住）时，
 * 应退回普通文字主动，而不是整条不发——她等的是「ta 来找我」，不是「必须带图」。
 */
export function shouldDegradePhotoShare({ photoShare = false, imageEnabled = false } = {}) {
  return Boolean(photoShare) && !imageEnabled;
}

/**
 * 真实街景自拍这一轮的提示词。
 *
 * 跟普通生活照的区别只有一条：背景不是编的，是系统已经核过的那张真实街景照片。
 * 提示词只负责让人物在前、那条街在后；素材本身不进提示词（它作为第二张参考图给宿主）。
 */
export function streetViewPhotoPrompt({ city = "" } = {}) {
  const where = String(city ?? "").trim() || "这座城市";
  const lines = [
    "【真实街景自拍】这一轮的照片要带上这座城市真实的街景。",
    `背景用的是${where}真实街景的照片（系统已经核过出处与许可）：画面里那条街要跟它一致——同样的建筑、街道走向、路面和街边标志物，不要凭空改造地形，也不要换成别的城市。`,
    "人物在前景，街景铺在后面：像是你本人站在那条街上随手拍的一张。",
    "愿意发图时输出一个自拍生图标记，必须 self=true。角色外貌只由参考照决定，不另写外貌。",
    "这是一张参考真实街景生成的情景图。配文可以聊这座城市，不要声称刚到现场、拍到了现况或亲自逛过真实店铺。",
    "这一轮最多出一张图；没有合适画面就写普通文字，不要硬凑。",
  ];
  return lines.join("\n");
}

/**
 * 由头照片（2026-11-23）：由头先成立，照片只是这轮的表达方式。
 *
 * 以前照片只认最近那轮面对面聊天；没聊过的日子，哪怕“想念”已经抽中，也一张都发不出来，
 * 于是主动消息只剩文字。这里补的是同一个落点里的低频机会：由头本身站得住，
 * 档位概率再乘一个低因子，加上 12 小时间隔与“最近三句已经带过图”两重限制。
 * 不新建定时器、不抬落点、不改额度；是否真出图仍由模型说。
 */
export const PHOTO_REASON_KINDS = Object.freeze(["affection", "contact", "shared", "tease"]);
export const PHOTO_REASON_CHANCE = 0.5;
export const PHOTO_REASON_GAP_MS = 12 * 60 * 60_000;

export function pickReasonPhoto({
  enabled = false, tier = "off", reason = null, blocked = false, recentPhoto = false,
  lastAt = null, now = Date.now(), gapMs = PHOTO_REASON_GAP_MS, chance = PHOTO_REASON_CHANCE, random = Math.random,
} = {}) {
  if (!enabled || blocked || recentPhoto) return false;
  if (!PHOTO_REASON_KINDS.includes(String(reason?.kind ?? ""))) return false;
  const odds = photoShareChance(tier) * chance;
  if (!(odds > 0)) return false;
  const raw = now instanceof Date ? now.getTime() : Number(now);
  const at = Number.isFinite(raw) ? raw : Date.now();
  const last = Date.parse(String(lastAt ?? ""));
  if (Number.isFinite(last) && at - last < gapMs) return false;
  return random() < odds;
}

/** 配文里已经预告了这张图（“给你看看…”）：生图没成就不能单独把这句话发出去。 */
const IMAGE_PROMISE_RE = /(?:给你|给你看|给你瞅|发你|拍给|让你看看|等下发|待会儿给你|马上给你)[^。！？!?\n]{0,10}(?:看|瞅|图|照片)|(?:发|晒|传)张?(?:图|照片|相片)/u;

export function hasImagePromise(text) {
  return IMAGE_PROMISE_RE.test(String(text ?? ""));
}

export function chatImagePrompt({ enabled = false, hasReference = false, tier = "less", shareOnly = false } = {}) {
  const willingness = {
    less: "【发图意愿：少一些】你较少用图片表达，普通闲聊优先文字；有很贴切、值得一看的场景时，也可以主动分享。",
    normal: "【发图意愿：适中】你愿意顺着聊天分享眼前的画面；聊到自己的穿搭、吃喝、出门或小发现时，自然考虑用一张图让对方看看。",
    more: "【发图意愿：多一些】你更喜欢用图片分享生活；有合适的新场景时积极考虑主动拍给对方看，不要总等对方索要，但不连续刷图。",
  }[normalizeImageTier(tier)];
  if (!enabled || !willingness) return "";
  return [
    shareOnly ? "【聊天照片】生图能力已接通：按下述协议输出隐藏标记，系统会把成功生成的图片和配文一起发出。这轮按【生活照片分享】决定是否出图：有合适画面就出，没有合适画面也别硬凑。" : "【聊天照片】生图能力已接通：你在回复里写出下述隐藏标记，系统就会生成图片，并把成功的图片和配文一起发给对方。你可以自己发起，不必等对方明确索要；也可以拒绝或只聊文字。",
    shareOnly ? "" : willingness,
    shareOnly ? "" : "回复前先考虑一下：此刻有没有一幅属于你、值得给对方看的画面？聊到自己的穿搭、吃喝、出门见闻或小发现时，主动把发照片作为一种表达选择；比起只描述，给对方看一张是否更贴切？有合适画面时可以直接发图加一句自然配文，或只发图。这个判断留在心里，不向对方解释。",
    "决定分享时要实际输出生图标记，让系统执行；仅写‘给你看看’、‘发张照片’或用文字描绘一张图，都不会生成图片。prompt写清主体、场景和关键视觉细节，以当前聊天已有信息为依据。",
    "画面要符合当前对话和你的角色状态，不要把对方的经历当成自己的。按最近聊天判断是否刚发过同类画面，避免重复；仅仅提到相关关键词不等于需要发图。",
    shareOnly ? "没有合适画面时不要硬凑图：有自然的新内容就写普通文字，真的没话说时才只输出[不回]；不为了用完额度凑图。" : "没有合适画面就继续聊天，不必每轮发，不按固定轮数或随机抽签塞图，也不要为了用完额度凑图。",
    '决定发图时，在正文末尾追加且只追加一个隐藏标记：[生图:{"prompt":"具体画面描述","self":false}]。self=true表示画面有你本人；false表示只拍物件、食物或风景，不出现其他人物来冒充自己。',
    hasReference ? "你已有固定外貌参考。出镜与否由你选择，可以露脸、拍背影、侧影或只拍自己的手部等局部，也可以完全不出镜。出现你本人时必须self=true，包括不露脸的背影和局部；系统自动带上参考照，保持角色与参考画风一致。参考照不代表必须露脸。不出镜时用self=false。" : "你还没有外貌参考，只能self=false拍无人物的画面，不用陌生人的脸、背影或手部冒充自己。没有参考照也可以正常分享物件和风景，不必为了发图强行自拍。",
    "画风不写死：人物图遵循参考照，其他照片按聊天情境。一次最多一张。不需要暴露标记、额度或生成过程；不要提前声称照片已经拍好，配文只随成功的图片一起发。",
  ].join("\n");
}
