/**
 * 日子账本联动：只借不给（跟表情包那条一个规矩）。
 *
 * 「拾光记」把「今天是什么日子 / 窗外什么样 / 每位伙伴自己那段生活日」摊成一份只读快照，
 * 由 shiguangji-app 发布到宿主 publicData 的 today 键（data 保持 PUBLIC-TODAY 完整 schema）。
 * 茶话会只做两件事：异步读当前共享快照、按自己的规矩拼一段给伙伴看。
 *
 * 每次读取都经过宿主实时授权，不保留成功缓存。发布缺失、权限撤销或接口缺失时不可用；
 * 旧插件是否活跃无法由文件存在证明，故不回退读取冻结的 public-today.json。
 *
 * 这是可选增强：装了拾光记、且她在设置页打开了「今日情境」，才会真的读。
 *
 * 四条不变的前提：
 *   1. 只读。茶话会绝不写回拾光记的任何数据。
 *   2. 挂了就静默降级。没装拾光记、快照缺失、版本对不上 —— 都只是「这次没有今天的背景」。
 *   3. **只取本伙伴那一份做册**。别人的日子是别人的，不许串味。
 *   4. 日子这东西按天说，不每轮重复：跨天、或者内容变了，才重新露一次。
 */

/** 拾光记 App 公开快照的发布者与键。 */
export const DAYBOOK_APP_ID = "shiguangji-app";
export const DAYBOOK_KEY = "today";
/** 认得的快照版本；不是这个版本就别解析。 */
export const DAYBOOK_SCHEMA_VERSION = 1;

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
  const mine = id && snapshot.summaries && typeof snapshot.summaries === "object"
    && Object.prototype.hasOwnProperty.call(snapshot.summaries, id) ? snapshot.summaries[id] : null;
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
export function buildDaybookText(snapshot, agentId, { userName = "她", topics = null } = {}) {
  const entry = daybookEntry(snapshot, agentId);
  if (!entry) return "";
  const person = String(userName || "她").trim() || "她";
  const selected = Array.isArray(topics) ? new Set(topics) : null;
  const includes = (topic) => !selected || selected.has(topic);
  const lines = ["【今天】"];
  const facts = [];

  if (includes("today") && entry.specials.length) facts.push(`今天是：${entry.specials.join("、")}。`);
  if (includes("today") && entry.workday) facts.push("今天她那边是调休上班日。");
  if (includes("today") && entry.todos.length) facts.push(`${person}今天还有：${entry.todos.join("、")}。`);
  if (includes("body") && entry.period) facts.push(`她这两天身体不太舒服，人容易累、情绪也敏感些，我想多照顾她一点。`);
  if (includes("weather") && entry.weather?.line) facts.push(`窗外：${entry.weather.line}${Number.isFinite(entry.weather.temp) ? `（${entry.weather.temp}°C）` : ""}`);

  if (facts.length) {
    lines.push(...facts);
    lines.push("（这是背景，知道就行，别主动报出来；她提起相关内容了，顺着说一句就好。）");
  }

  if (includes("recap") && entry.recap.length) {
    if (facts.length) lines.push("");
    lines.push("【你们的日子】");
    lines.push(...entry.recap.map((row) => `${row.date}：${row.text}`));
    lines.push("（你俩这些天过下来的底子，不是她刚说的话。别一条条念，也别说\"我记得\"，该用的时候自然带出来。）");
  }

  // 来源与事实同轮提供；工作进度、旧回复中的「未验收」不代表这次没有取得共享数据。
  return lines.length > 1 ? [
    lines[0],
    `（来源：拾光记 App，茶话会后台本轮已读取。快照日子：${cleanText(snapshot.today?.date, 10) || "未标注"}。共享范围仅为以下片段，不代表能浏览完整档案或操作拾光记。）`,
    ...lines.slice(1),
  ].join("\n") : "";
}

/** 找日子账本追问所依赖的上一条伙伴消息，跳过导入卡片的首次问候。 */
export function previousAssistantBeforeUser(messages, userIndex) {
  const rows = Array.isArray(messages) ? messages : [];
  const index = Number(userIndex);
  if (!Number.isInteger(index) || index <= 0 || index > rows.length) return null;
  return rows.slice(0, index).reverse().find((row) => row?.role === "assistant" && row?.kind !== "tavern-opening") ?? null;
}

/** 只在用户明确问到拾光记提供的某类信息时，临时取出对应片段。 */
export function daybookQueryTopics(text, { previousAssistantText = "" } = {}) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  const asks = /[？?]|啥|什么|多少|几度|咋(?:个)?|怎么样|如何|有没有|有没|能不能|可以不|告诉我|看下|看一下|查下|查一下|说说|讲讲|呢\s*$/.test(value);
  if (!asks) return [];
  const topicsIn = (source) => {
    const topics = [];
    const asksWeather = /天气|温度|气温|几度|摄氏度|下雨|下雪|晴|阴|刮风|穿(?:什么|啥)|带伞|降温/.test(source);
    if (asksWeather) topics.push("weather");
    if (/待办|安排|节日|纪念日/.test(source) || (/今天/.test(source) && !asksWeather)) topics.push("today");
    if (/身体|生理期|经期|来事|月经/.test(source)) topics.push("body");
    if (/昨天|前天|最近|前几天|回顾|记得|聊过|做过|发生|我们那天/.test(source)) topics.push("recap");
    return [...new Set(topics)];
  };
  const direct = topicsIn(value);
  if (direct.length) return direct;
  if (!/^(?:那|然后|所以|这样|那这样|要不要|还要不要|会不会|够不够|呢)/.test(value)) return [];
  return topicsIn(String(previousAssistantText ?? ""));
}

/** 关掉就绝不读；明确询问可绕过日常“今天已露过”的去重。 */
export function shouldUseDaybook({ enabled, topics = [], mark, lifeDay = "", hash = "" } = {}) {
  if (enabled !== true) return false;
  if (Array.isArray(topics) && topics.length > 0) return true;
  return shouldRevealDaybook(mark, { lifeDay, hash });
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

/** 保留旧测试入口；读侧已不缓存共享快照。 */
export function __clearDaybookCache() {}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只校验共享环境结构；伙伴际遇仍由 daybookEntry 按自己的 agentId 取用。 */
function validDaybookSnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== DAYBOOK_SCHEMA_VERSION) return false;
  if (!isRecord(snapshot.today) || !isRecord(snapshot.summaries)) return false;
  for (const key of ["festivals", "events", "todos"]) {
    if (snapshot.today[key] !== undefined && !Array.isArray(snapshot.today[key])) return false;
  }
  for (const key of ["workday", "period"]) {
    if (snapshot.today[key] !== undefined && typeof snapshot.today[key] !== "boolean") return false;
  }
  return snapshot.weather == null || isRecord(snapshot.weather);
}

/**
 * 跟 readDaybook 同一件事，但把「为什么读不到」说出来。
 * 读不到时静默返回 null 曾经让我们对着一个没反应的待办猜了半天；排查要用的就是这个。
 */
export async function readDaybookVerbose(ctx) {
  if (typeof ctx?.publicData?.get !== "function") return { snapshot: null, reason: "no-publicData-api" };
  let result = null;
  try {
    result = await ctx.publicData.get({ appId: DAYBOOK_APP_ID, key: DAYBOOK_KEY });
  } catch (error) {
    return { snapshot: null, reason: `error:${error?.code || "?"}:${error?.message || error}` };
  }
  if (result?.appId !== DAYBOOK_APP_ID || result?.key !== DAYBOOK_KEY) {
    return { snapshot: null, reason: `identity:${result?.appId || "?"}/${result?.key || "?"}` };
  }
  if (result?.schemaVersion !== DAYBOOK_SCHEMA_VERSION) {
    return { snapshot: null, reason: `schema:${result?.schemaVersion ?? "?"}` };
  }
  if (!validDaybookSnapshot(result.data)) return { snapshot: null, reason: "invalid-shape" };
  return { snapshot: result.data, reason: "ok" };
}

/**
 * 每次异步读取当前发布。不可用时返回 null，绝不读旧文件或复用上次成功的值。
 * @param {object} ctx App 的 ctx（使用 publicData.get，需要 app/public-data.read）
 */
export async function readDaybook(ctx) {
  if (typeof ctx?.publicData?.get !== "function") return null;
  try {
    const result = await ctx.publicData.get({ appId: DAYBOOK_APP_ID, key: DAYBOOK_KEY });
    if (result?.appId !== DAYBOOK_APP_ID || result?.key !== DAYBOOK_KEY
      || result?.schemaVersion !== DAYBOOK_SCHEMA_VERSION || !validDaybookSnapshot(result.data)) return null;
    return result.data;
  } catch {
    return null;
  }
}

/** 设置页只把可读取的当前共享快照视为可用，不拿磁盘遗留文件证明安装/活跃。 */
export async function daybookAvailable(ctx) {
  return (await readDaybook(ctx)) !== null;
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
