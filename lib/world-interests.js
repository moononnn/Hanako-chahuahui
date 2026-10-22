/**
 * 世界领域：伙伴「爱聊哪片世界」。
 *
 * 2026-10-20 实机反馈：主动消息写成了没人接得住的小作文。查下来的根子不在提示词，
 * 在兴趣点本身——现有那套 interest 全是「我怎么注意世界」（雨后窗台的干燥小角、
 * 楼道里不同的脚步声这一类），从它长出来的消息只能是「我注意到 XX」。
 * 这一层是补上去的另一半：**ta 会自己去刷什么**。
 *
 * 两条硬边界：
 * - 不动旧数据。现有的母题/癖好照旧，那是「人味」来源，新闻选题不该反过来顶掉它。
 * - 这一层只负责「搜什么、去哪儿看」，不管怎么开口；成文纪律仍归主动消息那套提示词。
 */

export const MAX_WORLD_INTERESTS = 4;
export const MIN_WORLD_INTERESTS = 2;
/** 同一个领域两次生成之间至少隔这么久，别每次养护都重摇一遍。 */
export const WORLD_SEED_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_DOMAINS = 3;
const MAX_SOURCES = 3;

/** 太泛的领域名：这种词搜不出东西，也不构成 ta 的口味。 */
const VAGUE_NAME_RE = /^(?:科技|娱乐|新闻|生活|文化|社会|网络|资讯|八卦|数码|影视|游戏|音乐|美食|体育|时尚|财经|互联网|AI)$/u;

const short = (value, max) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 领域 id 由名字派生：同一份名字重复养护不会长出两条重复的领域。 */
export function worldInterestId(name) {
  const key = String(name ?? "").toLowerCase().replace(/[\s·、，,。.！!？?]+/gu, "_").slice(0, 24);
  return key ? `wi_${key}` : "";
}

export function normalizeWorldInterests(raw, now = new Date()) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const name = short(row?.name, 20);
    if (!name) continue;
    const id = short(row?.id, 40) || worldInterestId(name);
    if (!id || seen.has(id)) continue;
    const domains = (Array.isArray(row?.domains) ? row.domains : [])
      .map((item) => short(item, 40)).filter(Boolean).slice(0, MAX_DOMAINS);
    if (!domains.length) continue;
    const sources = (Array.isArray(row?.sources) ? row.sources : [])
      .map((item) => short(item, 30)).filter(Boolean).slice(0, MAX_SOURCES);
    seen.add(id);
    out.push({
      id,
      name,
      domains,
      sources,
      note: short(row?.note, 80),
      muted: row?.muted === true,
      createdAt: iso(row?.createdAt) ?? iso(now),
      updatedAt: iso(row?.updatedAt) ?? iso(now),
    });
    if (out.length >= MAX_WORLD_INTERESTS) break;
  }
  return out;
}

/** 少两条就不够用：一条领域撑不起轮换，也容易天天同一口味的料。 */
export function needsWorldInterests(list) {
  return normalizeWorldInterests(list).length < MIN_WORLD_INTERESTS;
}

/** 同一批伙伴之间别撞衫：八卦型人格全写成同一个领域就没意义了。 */
function squeeze(text) {
  return String(text ?? "").toLowerCase().replace(/[\s，。、！？~～…,.!?·・"'“”‘’（）()【】\[\]]+/gu, "");
}

function spotSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

export function isSameWorldSpot(a, b) {
  return spotSimilarity(squeeze(a), squeeze(b)) >= 0.45;
}

const WORLD_SYSTEM = [
  "你在替一位伙伴定「ta 会自己去刷的世界」：ta 在手机里跟一个人聊天，除了观察身边的小事，还会主动去看哪几片内容。",
  "只负责定方向，不写聊天文案，不总结、不讲课。",
  "每条给三样：name（领域名，4 到 8 个字，像 ta 会脱口而出的叫法）、domains（2 到 3 条具体在追什么，越具体越好）、sources（1 到 3 个 ta 真的会看的地方，写平台名或站名，如 微博 / B站 / 知乎 / 豆瓣 / 播客 / 科技媒体 / 影评站）。",
  "硬要求：",
  "- 必须是外面真有的、这阵子会有新消息的领域，写不出新消息的一律不要（阳台怎么摆花、旧物怎么修补这类封闭小切口不行）；",
  "- 不要只写大词。写「娱乐圈八卦」可以，写「娱乐」「科技」「生活」不行；",
  "- 不同领域之间口味要分开，别都是同一种；",
  "- 不要出现对方的名字、她的私事、你们的聊天内容，也不要替她认领她未必喜欢的东西。",
  "严格输出 JSON：{\"worldInterests\":[{\"name\":\"…\",\"domains\":[…],\"sources\":[…],\"note\":\"一句 ta 刷这个时的状态或偏好，可留空\"}]}。想不出来输出 {\"worldInterests\":[]}。",
].join("\n");

/** 只把人格的注意方式递进去；她的名字和聊天原文都不是领域来源。 */
export function worldInterestSpec({ partnerName, personalityText = "", takenNames = [], sample = null }) {
  const material = String(personalityText ?? "").trim();
  const taken = (Array.isArray(takenNames) ? takenNames : []).map((item) => short(item, 40)).filter(Boolean).slice(0, 12);
  const atoms = Array.isArray(sample) && sample.length ? sample : [
    "追新八卦、圈内外的人事",
    "数码与新工具的更新",
    "书、影、剧集和它们的讨论",
    "网络热梗与社区里在吵的事",
    "游戏改动与考据",
    "手作、穿搭、街头文化",
    "播客与访谈里讲的事",
    "身边的人和事的生活流水",
  ];
  const blocks = [
    `这位伙伴叫「${partnerName}」。`,
    material ? `只把下面材料当作 ta 的注意方式和偏好结构：\n${material}` : "",
    `领域的大致形状（是方向不是候选，别照抄成一样的）：${atoms.join("、")}`,
    taken.length ? `同一批伙伴已经占了这些领域，换一批不同的：\n${taken.map((item) => `· ${item}`).join("\n")}` : "",
    `给 ta 定 ${MIN_WORLD_INTERESTS} 到 ${MAX_WORLD_INTERESTS} 条。`,
  ];
  return { kind: "world-interests", systemPrompt: WORLD_SYSTEM, userText: blocks.filter(Boolean).join("\n\n") };
}

export function parseWorldInterestReply(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*|```$/giu, "");
  if (!text) return [];
  let row;
  try { row = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(row?.worldInterests) ? row.worldInterests : [];
  return list.map((item) => ({
    name: short(item?.name, 20),
    domains: (Array.isArray(item?.domains) ? item.domains : []).map((d) => short(d, 40)).filter(Boolean),
    sources: (Array.isArray(item?.sources) ? item.sources : []).map((s) => short(s, 30)).filter(Boolean),
    note: short(item?.note, 80),
  })).filter((item) => item.name && item.domains.length);
}

/** 生成后门禁：太泛的名字、只写一层、跟人重复、蹭到她的名字，都不收。 */
export function validateWorldInterests(rows, { userName = "", takenNames = [] } = {}) {
  const name = String(userName ?? "").trim();
  const taken = (Array.isArray(takenNames) ? takenNames : []).map(squeeze).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = short(row?.name, 20);
    if (!label || VAGUE_NAME_RE.test(label)) continue;
    const values = [label, ...(row?.domains ?? []), ...(row?.sources ?? [])].map(String);
    if (name && values.some((value) => value.includes(name))) continue;
    if (values.some((value) => VAGUE_NAME_RE.test(value.trim()) && value.trim() === label)) continue;
    const key = squeeze(label);
    if (seen.has(key)) continue;
    if (taken.some((other) => isSameWorldSpot(key, other))) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= MAX_WORLD_INTERESTS) break;
  }
  return out;
}

/** 整批替换：养护是「ta 现在会刷什么」，不是往里加，所以按新一批覆盖旧的。 */
export function replaceWorldInterests(current, rows, now = new Date()) {
  const previous = normalizeWorldInterests(current, now);
  const byId = new Map(previous.map((row) => [row.id, row]));
  return normalizeWorldInterests(rows.map((row) => {
    const id = worldInterestId(row?.name);
    const old = byId.get(id);
    return {
      ...row,
      id,
      createdAt: old?.createdAt ?? iso(now),
      updatedAt: iso(now),
      muted: old?.muted === true,
    };
  }), now);
}

export function setWorldInterestMuted(list, id, muted, now = new Date()) {
  const key = short(id, 40);
  return normalizeWorldInterests(list, now).map((row) => (row.id === key ? { ...row, muted } : row));
}
