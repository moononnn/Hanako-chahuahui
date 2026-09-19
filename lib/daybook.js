/**
 * 日子账本联动：只借不给（跟表情包那条一个规矩）。
 *
 * 「拾光记」把「今天是什么日子 / 窗外什么样 / 每位伙伴自己那段生活日」摊成一份只读快照，
 * 落在 plugin-data/shiguangji/public-today.json（契约见拾光记仓库的 PUBLIC-TODAY.md）。
 * 茶话会只做两件事：读这份快照、按自己的规矩拼一段给伙伴看。
 *
 * 【隐式约定，改路径必须两边同步】这个位置是两边各算一次的：拾光记写自己的数据目录，
 * 茶话会从 ctx.dataDir 往上退两层再拼 plugin-data/shiguangji/。谁挪了目录而另一边没跟着改，
 * 就会静默读不到（只当“今天没什么可说的”），排查时先对这里。
 *
 * 这是可选增强：装了拾光记、且她在设置页打开了「今日情境」，才会真的读。
 *
 * 四条不变的前提：
 *   1. 只读。茶话会绝不写回拾光记的任何数据。
 *   2. 挂了就静默降级。没装拾光记、快照缺失、版本对不上 —— 都只是「这次没有今天的背景」。
 *   3. **只取本伙伴那一份做册**。别人的日子是别人的，不许串味。
 *   4. 日子这东西按天说，不每轮重复：跨天、或者内容变了，才重新露一次。
 */

import path from "node:path";

/** 拾光记的数据目录名与快照文件名（对外的门面，不随插件内部结构变）。 */
export const DAYBOOK_PLUGIN_ID = "shiguangji";
export const DAYBOOK_FILE = "public-today.json";
/** 认得的快照版本；不是这个版本就别解析。 */
export const DAYBOOK_SCHEMA_VERSION = 1;
/** 快照在内存里缓存多久（毫秒）。够短，改完日子很快能反映过来。 */
export const DAYBOOK_TTL_MS = 60 * 1000;

const TEXT_LIMIT = 120;

function cleanText(value, maxLength = TEXT_LIMIT) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanList(values, limit = 12) {
  return (Array.isArray(values) ? values : [])
    .map((item) => cleanText(item, 60))
    .filter(Boolean)
    .slice(0, limit);
}

/** 短指纹：给「今天露过没」记账用，不够当哈希使，只求稳定且短。 */
export function daybookHash(text) {
  const value = String(text ?? "");
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 从快照里取这位伙伴该看的那一份。
 * 没装拾光记、没这一天、没有任何内容，一律返回 null（当「今天没什么可说的」）。
 */
export function daybookEntry(snapshot, agentId) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const today = snapshot.today && typeof snapshot.today === "object" ? snapshot.today : {};
  const specials = cleanList([...(today.festivals || []), ...(today.events || [])]);
  const todos = cleanList(today.todos, 8);
  const workday = today.workday === true;
  const period = today.period === true;
  const weather = snapshot.weather && typeof snapshot.weather === "object"
    ? { place: cleanText(snapshot.weather.place, 40), line: cleanText(snapshot.weather.line, 120), temp: Number.isFinite(Number(snapshot.weather.temp)) ? Number(snapshot.weather.temp) : null }
    : null;
  const id = String(agentId ?? "").trim();
  const mine = id && snapshot.summaries && typeof snapshot.summaries === "object" ? snapshot.summaries[id] : null;
  const recap = (Array.isArray(mine) ? mine : [])
    .map((row) => ({ date: cleanText(row?.date, 10), text: cleanText(row?.text, 1800) }))
    .filter((row) => row.date && row.text);

  if (!specials.length && !todos.length && !workday && !period && !weather?.line && !recap.length) return null;
  return { specials, todos, workday, period, weather, recap };
}

/**
 * 拼给伙伴看的那一段。返回空串表示今天没什么可说的——那就什么也不提。
 *
 * 语气上跟茶话会别处一致：讲事实，不讲规矩；收口那句也只是「这是背景」，
 * 不用「请注意」「必须」这类指令腔。
 */
export function buildDaybookText(snapshot, agentId, { userName = "她" } = {}) {
  const entry = daybookEntry(snapshot, agentId);
  if (!entry) return "";
  const person = String(userName || "她").trim() || "她";
  const lines = ["【今天】"];
  const facts = [];

  if (entry.specials.length) facts.push(`今天是：${entry.specials.join("、")}。`);
  if (entry.workday) facts.push("今天她那边是调休上班日。");
  if (entry.todos.length) facts.push(`${person}今天还有：${entry.todos.join("、")}。`);
  if (entry.period) facts.push(`她这两天身体不太舒服，人容易累、情绪也敏感些，我想多照顾她一点。`);
  if (entry.weather?.line) facts.push(`窗外：${entry.weather.line}${Number.isFinite(entry.weather.temp) ? `（${entry.weather.temp}°C）` : ""}`);

  if (facts.length) {
    lines.push(...facts);
    lines.push("（这是背景，知道就行，别主动报出来；她提起今天了，顺着说一句就好。）");
  }

  if (entry.recap.length) {
    if (facts.length) lines.push("");
    lines.push("【你们的日子】");
    lines.push(...entry.recap.map((row) => `${row.date}：${row.text}`));
    lines.push("（你俩这些天过下来的底子，不是她刚说的话。别一条条念，也别说\"我记得\"，该用的时候自然带出来。）");
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

/** 主动消息只借共享环境，不把拾光记的日子账本整段重复搬过去。 */
export function buildAmbientContextText(snapshot) {
  const entry = daybookEntry(snapshot, "");
  if (!entry?.weather?.line) return "";
  const temp = Number.isFinite(entry.weather.temp) ? `（${entry.weather.temp}°C）` : "";
  return [
    "【共享窗外情境】",
    `窗外：${entry.weather.line}${temp}`,
    "（这是可选的背景素材，只有自然贴合你这次要说的事时才带一句，不要照抄或主动播报。）",
  ].join("\n");
}

let cache = { value: null, at: 0 };

/** 仅供测试：清掉内存缓存。 */
export function __clearDaybookCache() {
  cache = { value: null, at: 0 };
}

/**
 * 读那份快照。任何一步出问题都返回 null，调用方当「今天没什么可说的」处理。
 * @param {object} ctx  App 的 ctx（用它的 resources.read 和 dataDir）
 */
export async function readDaybook(ctx, { now = Date.now(), ttlMs = DAYBOOK_TTL_MS } = {}) {
  if (cache.value && now - cache.at < ttlMs) return cache.value;
  const dataDir = String(ctx?.dataDir ?? "");
  if (!dataDir) return null;
  const hanaHome = path.dirname(path.dirname(dataDir));
  const file = path.join(hanaHome, "plugin-data", DAYBOOK_PLUGIN_ID, DAYBOOK_FILE);
  try {
    const result = await ctx.resources.read({ kind: "local-file", path: file });
    const text = typeof result?.content === "string"
      ? result.content
      : (result?.content ? Buffer.from(result.content).toString("utf8") : "");
    if (!text) return null;
    const snapshot = JSON.parse(text);
    if (!snapshot || Number(snapshot.schemaVersion) !== DAYBOOK_SCHEMA_VERSION) return null;
    cache = { value: snapshot, at: now };
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * 今天这一份该不该露出来。
 * 跨天、内容变了、或者这位伙伴从没看过 —— 都该露；同一天里内容没动过就不再重复。
 */
export function shouldRevealDaybook(mark, { lifeDay = "", hash = "" } = {}) {
  const state = mark && typeof mark === "object" ? mark : null;
  if (!state) return true;
  return String(state.lifeDay ?? "") !== String(lifeDay ?? "")
    || String(state.hash ?? "") !== String(hash ?? "");
}
