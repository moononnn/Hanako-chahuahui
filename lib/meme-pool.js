/**
 * 梗池：她自己玩过的那几手，攒成池子，再按伙伴的性子挑给她。
 *
 * 源头只有一个——她当面用出来的（说破「我在玩梗」、或者紧跟着给一句解释）。
 * 这条结论是 2026-11-14 试出来的，不是拍的：
 *   · B 站弹幕不行。8 个热门视频、约 1.1 万条，高频七成是现场语言（「合影」1055 次、
 *     「来了」129 次）。这些东西的功能是「我在这儿」，脱离那一刻没人懂。
 *   · B 站热评也不行，那是观后感。弹幕和热评都是**对着内容说的话**，梗是**对着人说的话**，
 *     这个差别不是数据量能补的。
 *   · 从她的话里用正则抠梗名也抠不准（387 条里命中 22 条，只有 2 条是真的）。
 *     所以识别那一层只负责「发现她在说梗」，原句交给回复那一轮的模型去提。
 *
 * 这里只有算术，不碰文件、不调模型。
 */

/** 上限 24 字：再长是台词，不是说法。 */
export const MEME_MAX_CHARS = 24;
/** 多久没再出现就从新鲜度里往下掉。梗的寿命大概两三周。 */
export const MEME_TTL_DAYS = 21;
/** 池子硬上限，超了按「用过的 > 确认过的 > 候选」三级让路。 */
export const MEME_POOL_MAX = 400;
/** 同一个梗对同一个伙伴，这么多天内不重复推。 */
export const MEME_REUSE_DAYS = 3;

function dayMs(days) {
  return Number(days) * 24 * 60 * 60 * 1000;
}

function newId(now) {
  return `meme_${Number(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 一条进池。
 *
 * 同一句话再次出现只加计数、往后续命，不新建条目。
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
 * 超上限时按三级让路：候选先走，其次是她确认过的，最后才动用过的；同级别里
 * 最久没出现的先走。输出保持入池顺序，别把旁边的顺序也搅了。
 *
 * 为什么要动确认过的（2026-11-15）：原来只裁候选，而她每说破一次就往池子里塞
 * 一条永不过期的确认条目——只进不出，池子迟早变成只涨不落的账。确认过的仍然
 * 排在最不容易被丢的那一档，正常用量下根本轮不到它们。
 */
export function trimPool(pool, now = Date.now(), { max = MEME_POOL_MAX } = {}) {
  const rows = Array.isArray(pool) ? pool.slice() : [];
  if (rows.length <= max) return rows;
  const tier = (row) => ((row.usedBy?.length ?? 0) > 0 ? 2 : row.status === "confirmed" ? 1 : 0);
  const oldestFirst = rows
    .slice()
    .sort((a, b) => (Number(a.lastSeenAt) || 0) - (Number(b.lastSeenAt) || 0));
  const victims = new Set();
  const need = rows.length - max;
  for (const level of [0, 1, 2]) {
    if (victims.size >= need) break;
    for (const row of oldestFirst) {
      if (victims.size >= need) break;
      if (tier(row) === level) victims.add(row);
    }
  }
  return rows.filter((row) => !victims.has(row));
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
    // 次数取对数：刷 1000 次和刷 100 次不该差 10 倍权重
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
 * 两种来源：她说的「我在玩梗/我在模仿 X」，和她解释过的「就是……的意思」。
 * 后者带释义，下次同族的梗就能对上——这是「老吴（猫叫）」那次的教训：
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
 * 她 2026-11-14 的原话：「活用，不是单纯的重复那种」。所以这里必须写死一件事：
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
