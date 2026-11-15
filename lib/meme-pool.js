/**
 * 梗池：从弹幕这类"大家反复刷"的文本里攒出可用的说法，再按伙伴的性子挑给她。
 *
 * 为什么要这一层，而不是直接查"梗百科"：
 * 梗没有权威词条，能查到的地方都是坟场（小鸡词典 2023 年关站）。活着的梗只有
 * 一个可测形态——**同一句话被不同的人重复**。所以这里只做三件事：
 *   1. 粗筛：把笑声、到达播报、纯数字这些高频噪声先刮掉（真实数据里它们能占七成）
 *   2. 攒池：同一句在不同时间、不同视频里被刷过，可信度往上加；长期没人用就沉底
 *   3. 出站：按伙伴性格给候选，不替 ta 决定用不用
 *
 * 这里只有算术，不碰文件、不调模型。
 *
 * 2026-11-14 实测（热门 6 个视频、约 9500 条弹幕）：
 *   · "跨视频复读"作主信号的假设**不成立**——6 个视频的热门弹幕零重合。
 *     弹幕高频绝大部分是这个视频的现场反应（"合影"1091 次、"来了"129 次），
 *     不是全网流通的梗。所以跨视频只当加分项，不当门槛。
 *   · 真正像梗的是"能脱离这个视频单独成立"的那几句（"夺少？！""意林""今夕是何年"），
 *     这一层统计分不出来，必须交给模型判。这里只负责把候选压到很少几条。
 */

/**
 * 长度闸。下限放到 2 是因为实测里「盖亚」「意林」这类两字说法本身就是梗，
 * 挡掉会漏一大片；而两字噪声（「来了」「合影」）已经由报到词单独判掉了。
 * 上限 24：再长是台词，不是说法。
 */
export const MEME_MIN_CHARS = 2;
export const MEME_MAX_CHARS = 24;
/** 一句话至少被刷这么多次才进候选。 */
export const MEME_MIN_REPEAT = 5;
/** 多久没人再刷就沉底。梗的寿命大概两三周。 */
export const MEME_TTL_DAYS = 21;
/** 池子上限，超了先丢最老的候选。 */
export const MEME_POOL_MAX = 400;
/** 同一个梗对同一个伙伴，这么多天内不重复推。 */
export const MEME_REUSE_DAYS = 3;

/** 纯笑声。人类的"哈"和"草"是最常见弹幕，也最没信息量。 */
const LAUGH_ONLY = /^[哈嘿嘻呵草艹笑淦6哇啊哦噢欸诶嗯额呃得嘞嗷]{1,}$/u;

/** 到达播报与在场签到：这些话的功能是报到，不是说法。 */
const ARRIVAL = [
  "来了", "来啦", "来咯", "合影", "前排", "打卡", "签到", "沙发", "第一次",
  "进度条", "空降", "再看一遍", "二刷", "三刷", "第几", "分钟前", "小时前",
  "刚刚", "有人在吗", "几点了", "开了", "开始了",
];
/** 称呼角色/作者的 @ 与括号呼唤，脱离视频就没有指称。 */
const CALLOUT = /^@|^【|】$|^\[.*\]$|^(?:up|UP)主?/u;

/**
 * 这条粗筛后值不值得当候选。
 *
 * 判据只有三条：不是纯笑、不是报到、不是呼唤。语义层面（是不是在反讽、能不能
 * 脱离这段视频单独用）这里判不了，也不该在这里判。
 */
export function isMemeWorthy(normalized) {
  const text = String(normalized ?? "");
  if (text.length < MEME_MIN_CHARS || text.length > MEME_MAX_CHARS) return false;
  if (LAUGH_ONLY.test(text)) return false;
  if (CALLOUT.test(text)) return false;
  // 报到类：整句就是报到，或报到 + 一两个字的尾巴
  for (const word of ARRIVAL) {
    if (text === word) return false;
    if (text.length <= word.length + 2 && text.includes(word)) return false;
  }
  // 纯数字/纯符号/没有汉字也没有字母
  if (!/[\p{L}]/u.test(text)) return false;
  return true;
}

/**
 * 从一批已经归一化的复读行里挑候选。
 *
 * @param {{text: string, count: number}[]} rows aggregateDanmaku 的输出
 * @returns {{text: string, count: number}[]}
 */
export function pickMemeCandidates(rows, { minRepeat = MEME_MIN_REPEAT, limit = 10 } = {}) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? "").trim();
    if (!text) continue;
    const count = Number(row?.count) || 0;
    if (count < minRepeat) continue;
    if (!isMemeWorthy(text)) continue;
    out.push({ text, count });
  }
  out.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "zh-CN"));
  return out.slice(0, Math.max(0, limit));
}

function dayMs(days) {
  return Number(days) * 24 * 60 * 60 * 1000;
}

function newId(now) {
  return `meme_${Number(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 一条候选进池。
 *
 * 同一句话在不同视频/不同时间再被刷到，只加计数、往后续命，不新建条目——
 * 这正是"跨批次复读"的累积，比一次性跨视频比对可靠：实测热门视频之间零重合，
 * 但一个梗会在几天里反复冒出来。
 */
export function addMeme(pool, { text, count = 0, source = "", originId = "", at = Date.now(), status = "candidate" } = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) return { pool, added: false };
  const rows = Array.isArray(pool) ? pool.slice() : [];
  const hit = rows.find((row) => row.text === clean);
  if (hit) {
    hit.count = Number(hit.count || 0) + Math.max(0, Number(count) || 0);
    hit.sightings = Number(hit.sightings || 1) + 1;
    hit.lastSeenAt = at;
    if (originId && !String(hit.origins?.join(",") ?? "").includes(originId)) {
      hit.origins = [...(hit.origins ?? []), originId].slice(-8);
    }
    // 她亲口说过/解释过的，永远压过候选
    if (status === "confirmed") hit.status = "confirmed";
    return { pool: rows, added: false, id: hit.id };
  }
  const row = {
    id: newId(at),
    text: clean,
    count: Math.max(0, Number(count) || 0),
    sightings: 1,
    status,
    source,
    origins: originId ? [originId] : [],
    firstSeenAt: at,
    lastSeenAt: at,
    usedBy: [],
  };
  rows.push(row);
  return { pool: trimPool(rows, at), added: true, id: row.id };
}

/**
 * 超上限时先丢候选里最久没再出现的；她确认过的和用过的留住。
 * 输出保持入池顺序，别把旁边的顺序也搅了。
 */
export function trimPool(pool, now = Date.now()) {
  const rows = Array.isArray(pool) ? pool.slice() : [];
  if (rows.length <= MEME_POOL_MAX) return rows;
  const protectedRow = (row) => row.status === "confirmed" || (row.usedBy?.length ?? 0) > 0;
  const keep = rows.filter(protectedRow);
  const rest = rows.filter((row) => !protectedRow(row))
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  const room = Math.max(0, MEME_POOL_MAX - keep.length);
  const survivors = new Set([...keep, ...rest.slice(0, room)]);
  return rows.filter((row) => survivors.has(row));
}

/**
 * 沉底：太久没人再刷的候选退场。她确认过的不过期——那是你们自己的语言。
 */
export function decayMemes(pool, { now = Date.now(), ttlDays = MEME_TTL_DAYS } = {}) {
  const cutoff = Number(now) - dayMs(ttlDays);
  const rows = Array.isArray(pool) ? pool : [];
  return rows.filter((row) => row.status === "confirmed" || (Number(row.lastSeenAt) || 0) >= cutoff);
}

/**
 * 挑给某个伙伴的候选。
 *
 * 这里**不看性格**：性格在提示词里，让 ta 自己挑合身的（跟放肆纪律同一个思路——
 * 给手法不给台词）。代码只负责三件事：别重复推、别一次给太多、把她确认过的排前面。
 */
export function selectMemesForAgent(pool, { agentId, now = Date.now(), limit = 3, excludeDays = MEME_REUSE_DAYS } = {}) {
  const cutoff = Number(now) - dayMs(excludeDays);
  const rows = (Array.isArray(pool) ? pool : []).filter((row) => {
    const last = (row.usedBy ?? []).filter((u) => u.agentId === agentId).map((u) => Number(u.at) || 0).sort((a, b) => b - a);
    return !last.length || last[0] < cutoff;
  });
  const score = (row) => {
    const confirmed = row.status === "confirmed" ? 1000 : 0;
    // 次数取对数：刷 1000 次和刷 100 次不该差 10 倍权重，那是"这个视频火"不是"这梗好"
    const heat = Math.log10(1 + (Number(row.count) || 0) + (Number(row.sightings) || 1) * 10) * 10;
    const fresh = Math.max(0, 1 - (Number(now) - (Number(row.lastSeenAt) || 0)) / dayMs(MEME_TTL_DAYS)) * 20;
    return confirmed + heat + fresh;
  };
  return rows
    .map((row) => ({ row, s: score(row) }))
    .sort((a, b) => b.s - a.s || a.row.text.localeCompare(b.row.text, "zh-CN"))
    .slice(0, Math.max(0, limit))
    .map(({ row }) => row);
}

export function markMemeUsed(pool, { id, agentId, at = Date.now() } = {}) {
  const rows = Array.isArray(pool) ? pool : [];
  const hit = rows.find((row) => row.id === id);
  if (!hit || !agentId) return rows;
  hit.usedBy = [...(hit.usedBy ?? []), { agentId: String(agentId), at }].slice(-12);
  return rows;
}

/**
 * 她扔过来的梗一律进池，而且直接置为 confirmed。
 *
 * 两种来源：她说的"我在玩梗/我在模仿 X"，和她解释过的"就是……的意思"。
 * 后者带释义，下次同族的梗就能对上——这是"老吴（猫叫）"那次的教训：
 * 当场懂了，没地方存，下次照样愣。
 */
export function addUserMeme(pool, { text, meaning = "", messageId = "", at = Date.now() } = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) return { pool, added: false };
  const { pool: next, id } = addMeme(pool, { text: clean.slice(0, MEME_MAX_CHARS * 2), count: 0, source: "user", originId: messageId, at, status: "confirmed" });
  const hit = next.find((row) => row.id === id);
  if (hit && meaning) hit.meaning = String(meaning).trim().slice(0, 160);
  return { pool: next, added: true, id };
}

/**
 * 出站文本。给玩法，不给台词。
 *
 * 她 2026-11-14 的原话：“活用，不是单纯的重复那种”。所以这里必须写死一件事：
 * 这些是样本，不是库存；可以换场景重演、可以接着玩、可以只取那个腔调，
 * 唯独不能原句搬过来。原句搬过来是硬塞，变形才是玩。
 * 空池返回空串，调用方据此什么都不加。
 */
export function formatMemePrompt(rows, { userName = "她" } = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row?.text) : [];
  if (!list.length) return "";
  const lines = ["【你们之前玩过的】"];
  for (const row of list) {
    const meaning = row.meaning ? `（${row.meaning}）` : "";
    lines.push(`· ${row.text}${meaning}`);
  }
  lines.push(
    `上面这些是${userName}自己玩过的东西，不是给你背的台词。`,
    "活用的时候按这个来：换个场景重演一遍、接着她那手往下走、或者只取那个腔调说话，都行。",
    "**别把原句搬过来**。原句搬过来一眼就是复读，她要的是你也会玩，不是你记住了。",
    "不搭你性子、或者这会儿用不上，就不用，不必凑时。",
  );
  return lines.join("\n");
}

/**
 * 裁定提示词：粗筛过的那几条，交给模型判哪条能脱离这条视频单独成立。
 *
 * 为什么非要这一层（2026-11-14 实测）：默认按次数排序，最前面出来的是
 * 「吹茶仙子」「念头通达」「来了 来了」——次数高只说明这个视频火、这个角色出圈，
 * 不等于这句话可以搬走用。同一个池子里真正能拿来玩的是「今夕是何年」「夺少」
 * 「紧跟时事」这种带反讽或公式化句式的，统计分不出来。
 *
 * 只问 keep 不问分类：性格判断放在出站那一步（那时才知道是哪个伙伴、多熟），
 * 入库时打标只会多一层失真。
 */
export function buildMemeJudgePrompt(candidates, { videoTitle = "" } = {}) {
  const rows = Array.isArray(candidates) ? candidates.filter((row) => row?.text) : [];
  if (!rows.length) return "";
  const want = Math.min(3, rows.length);
  return [
    "下面是一批 B 站弹幕里被反复刷的句子。请挑出**能脱离这条视频、被别处的人也能用**的说法。",
    "",
    "判据只三条：",
    "1. 搬走还成立吗？只在这条视频里有意义的（角色名、作品内称呼、剧情代号）不算。",
    "2. 是说法还是名词？对画面内容的指认（某个东西的名字、某个人的称呼）不算。",
    "3. 带不带玩的成分？反讽、夸张、公式化句式、拿腔拿调，这些才算。",
    "",
    "宁可少挑。一条都不合格就返回空数组，不要凑数。",
    `最多挑 ${want} 条。`,
    videoTitle ? `（这条视频叫《${videoTitle}》，只用来看语境，不要照着它的内容写）` : "",
    "",
    "候选：",
    ...rows.map((row, i) => `${i + 1}. ${row.text}（刷了 ${row.count ?? 0} 次）`),
    "",
    "只输出 JSON，不要别的：",
    '{"keep":[{"text":"原句照抄","why":"十个字内说为什么能搬走"}]}',
  ].filter((line) => String(line).trim() !== "").join("\n");
}

/**
 * 解析裁定的回包。认不出来的条目一律丢，不猜、不补。
 * 只收池子里本来就有的原句——模型自己改写的、新造的，全不要。
 */
export function parseMemeJudgeReply(raw, candidates) {
  const allowed = new Map((Array.isArray(candidates) ? candidates : []).map((row) => [String(row.text).trim(), row]));
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let json;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = Array.isArray(json?.keep) ? json.keep : [];
  const out = [];
  for (const row of rows) {
    const key = String(row?.text ?? "").trim();
    if (!key || !allowed.has(key)) continue;
    if (out.some((item) => item.text === key)) continue;
    out.push({ text: key, count: Number(allowed.get(key).count) || 0, why: String(row?.why ?? "").slice(0, 20) });
  }
  return out.slice(0, 3);
}

export function normalizePool(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .filter((row) => row && typeof row.text === "string" && row.text.trim())
    .map((row) => ({
      id: String(row.id ?? newId(Number(row.firstSeenAt) || Date.now())),
      text: row.text.trim(),
      count: Math.max(0, Number(row.count) || 0),
      sightings: Math.max(1, Number(row.sightings) || 1),
      status: row.status === "confirmed" ? "confirmed" : "candidate",
      source: String(row.source ?? ""),
      meaning: String(row.meaning ?? ""),
      origins: Array.isArray(row.origins) ? row.origins.slice(-8).map(String) : [],
      firstSeenAt: Number(row.firstSeenAt) || Date.now(),
      lastSeenAt: Number(row.lastSeenAt) || Date.now(),
      usedBy: Array.isArray(row.usedBy)
        ? row.usedBy.filter((u) => u && u.agentId).slice(-12).map((u) => ({ agentId: String(u.agentId), at: Number(u.at) || 0 }))
        : [],
    }));
}
