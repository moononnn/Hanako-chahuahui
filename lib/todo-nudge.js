/**
 * 拾光记待办到点：这句提醒该由谁来说。
 *
 * 只借用共享快照里「今天快到点或过了钟点、还没了结」的那几条待办，挑一位关系走得最远、
 * 最近也还在聊的伙伴，让 ta 顺着这件事开口。有来处，不是随机找话说。
 *
 * 钟点那几条会被拾光记提前几分钟摊出来：提醒要走一遍模型想措辞，踩着点开工一定晚。
 * 所以 soon 要留着，用来分清「快到了」和「已经过了」两种说法。
 *
 * 四条纪律：
 *   1. 只读。茶话会绝不写回拾光记的任何数据。
 *   2. 同一批待办一天只说一次，由调用方记账（nudgeKey / nudgeSeen）。
 *   3. 可选增强：没装拾光记、她没开今日情境、快照缺失，一律当没有，不报错、不降级成随机。
 *   4. 这件事只多给一个「开口的由头」，不动原本的静默时段、日上限与间隔规矩。
 */

const TEXT_LIMIT = 60;
/** 一次最多带几条，多了就成了念清单。 */
export const TODO_NUDGE_MAX = 4;

function clean(value, maxLength = TEXT_LIMIT) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

/** 从共享快照里取「今天快到点或已到点、还没了结」的那几条；取不到就是空数组。 */
export function dueTodosFromSnapshot(snapshot, limit = TODO_NUDGE_MAX) {
  const today = snapshot && typeof snapshot === "object" && snapshot.today && typeof snapshot.today === "object"
    ? snapshot.today
    : null;
  if (!today) return [];
  return (Array.isArray(today.todosDue) ? today.todosDue : [])
    .map((row) => ({
      title: clean(row?.title),
      at: clean(row?.at, 5),
      // soon 是拾光记给的「离钟点还差几分钟」：大于 0 是还没到点，0/缺省是已经过点了。
      soon: Math.max(0, Math.trunc(Number(row?.soon) || 0)),
    }))
    .filter((row) => row.title)
    .slice(0, limit);
}

/** 同一批待办认一个指纹，用来记「今天说过了」。内容变了就换指纹，可以再说一次。 */
export function nudgeKey(todos, dateKey = "") {
  const rows = (Array.isArray(todos) ? todos : []).map((row) => clean(row?.title)).filter(Boolean).sort();
  if (!rows.length) return "";
  return `${clean(dateKey, 10)}|${rows.join("|")}`;
}

/**
 * 选该来说这件事的那位伙伴。
 * 规则：关系走得最远的优先；一样远就看谁最近说过话。一个都够不着就没人说。
 */
export function pickTodoNudger(candidates = []) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .map((row) => ({
      agentId: String(row?.agentId ?? "").trim(),
      depth: Number.isFinite(Number(row?.depth)) ? Number(row.depth) : 0,
      lastAt: Number.isFinite(Number(row?.lastAt)) ? Number(row.lastAt) : 0,
    }))
    .filter((row) => row.agentId);
  if (!rows.length) return null;
  rows.sort((a, b) => (b.depth - a.depth) || (b.lastAt - a.lastAt) || a.agentId.localeCompare(b.agentId));
  return rows[0].agentId;
}

/**
 * 拼给伙伴看的那一段由头。空串表示这次没什么可提的。
 *
 * 这一段是「这次为什么开口」的全部原因，不是可以捎带的附带信息：
 * 写成附着在别的话题后面的尾巴时，模型就会先聊本来那件事、末尾补一句提醒，
 * 听上去像完成任务顺手清一下待办，不像在惦记她。因此措辞必须把这件事定成主事由。
 */
export function todoNudgeText(todos, { userName = "她" } = {}) {
  const rows = (Array.isArray(todos) ? todos : [])
    .map((row) => ({
      title: clean(row?.title),
      at: clean(row?.at, 5),
      soon: Math.max(0, Math.trunc(Number(row?.soon) || 0)),
    }))
    .filter((row) => row.title);
  if (!rows.length) return "";
  const person = String(userName || "她").trim() || "她";
  const label = (row) => (row.at ? `${row.at} ${row.title}` : row.title);
  // 提前开口的那几条：她那边还没到点，说成「已经到了没做」就成假话了，得分开讲。
  const soon = rows.filter((row) => row.soon > 0);
  const passed = rows.filter((row) => row.soon <= 0);
  const lines = [];
  if (soon.length) lines.push(`${person}今天这几件快到点了：${soon.map(label).join("、")}。`);
  if (passed.length) lines.push(`${person}今天这几件到了时间还没做：${passed.map(label).join("、")}。`);
  return [
    "【你现在来找 ta 的原因】",
    lines.join(""),
    "这件事就是你这次开口的全部由头，不要再另找一个话题来聊。",
    "用你自己的语气说：可以就是一句提醒，也可以顺着这件事多说一两句（问一句进展、顺手关心一下），都看你自己的性子。",
    "快到点那几条别当成已经拖了，说成「该准备了」「差不多到点了」这类口气；到了时间还没做那几条也别数落。",
    "别用记事的说法，别照抄上面那行；也别摆清单、别催、别说你是被谁叫来的。",
  ].join("\n");
}

/** 这批待办今天是不是已经说过了。没有指纹也当说过，免得空转。 */
export function nudgeSeen(runtime, key) {
  if (!key) return true;
  return String(runtime?.todoNudge?.key ?? "") === key;
}
