/**
 * 茶话会 · 她说「我做完了」，先问一句，落不落笔由她点。
 *
 * 为什么改成提议而不是直接勾：
 *   1. **ta 没资格替她宣布**。账本一动就是事实，没点之前事实没成立，
 *      ta 只能说「要我划掉吗」，不能说「记上了」。今天那句「账和记录都对上了」就是这么来的。
 *   2. **机器会猜错，人不会**。判定仍是规则（可能漏、极少误判），
 *      但误判的后果从「账被划错」降成「弹了个不想要的窗」。
 *   3. **关掉之后也还是她的授权**。开关关着只是不再问，不改变"谁点头"这件事。
 *
 * 三条纪律：
 *   1. 判定这一侧只提议，不落笔：proposeFromMessage 的参数里压根没有 ctx。
 *      整个文件里唯一碰账本的是 confirmProposal，而它只在她点了确认之后才被调到。
 *   2. 同一条只提议一次，账上没动过就还在。
 *   3. 过期只是把窗收起来，账本一个字不动——拾光记那边的到点提醒照常来。
 */

import { judgeCompletion, pendingFromSnapshot, TODO_COMPLETE_METHOD } from "./todo-done.js";
import { DAYBOOK_APP_ID } from "./daybook.js";

/** 同屏最多挂几条待确认。多了就不是确认，是账单。 */
export const PROPOSE_MAX = 3;

const TEXT_LIMIT = 400;
const KEY_LIMIT = 96;

function clean(value, maxLength = TEXT_LIMIT) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

/** 提议的稳定键：同一条待办在账上被勾掉之前，永远是同一条提议。 */
export function proposalKey(todoId) {
  const id = clean(todoId, KEY_LIMIT);
  return id ? `todo:${id}` : "";
}

/** 当天 24 点收窗。她的"我待会儿补"往往就在当天，别急着把窗收走。 */
export function proposalExpiry(now = new Date()) {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return end.getTime();
}

/**
 * 这一轮要不要弹那个窗。
 * 只判、不改。判定本身复用 todo-done 的 judgeCompletion，两边不长歪。
 * @returns {{proposed:true, todo:object}|{proposed:false, reason:string}}
 */
export function proposeFromMessage({ text, snapshot = null, diagnostics = null } = {}) {
  if (!snapshot) {
    diagnostics?.({ event: "todo-propose.no-snapshot", text: clean(text, 60) });
    return { proposed: false, reason: "no-snapshot" };
  }
  const pending = pendingFromSnapshot(snapshot);
  const judged = judgeCompletion(text, pending);
  if (judged.status !== "hit") {
    diagnostics?.({ event: `todo-propose.${judged.status}`, text: clean(text, 60), pending: pending.length });
    return { proposed: false, reason: judged.status };
  }
  diagnostics?.({ event: "todo-propose.hit", title: judged.todo.title });
  return { proposed: true, todo: judged.todo };
}

/** 一条待确认长什么样。窗口、聊天记录、日志都只用这一个形状。 */
export function makeProposal({ todo, agentId = "", now = new Date(), text = "" } = {}) {
  const key = proposalKey(todo?.id);
  if (!key || !clean(todo?.title, 120)) return null;
  return {
    key,
    todoId: clean(todo?.id, KEY_LIMIT),
    title: clean(todo?.title, 120),
    at: clean(todo?.at, 5),
    date: clean(todo?.date, 10),
    agentId: clean(agentId, 64),
    said: clean(text, 120),
    createdAt: now.getTime(),
    expiresAt: proposalExpiry(now),
  };
}

/** 收掉过期的、不合法的；同一条待办只留最早那一条。 */
export function normalizeProposals(rows, now = new Date()) {
  const stamp = now.getTime();
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    // 这里的行已经是「提议」自己，不是拾光记那边那条待办：两者的 id 字段名不一样。
    const todoId = clean(row?.todoId ?? row?.id, KEY_LIMIT);
    const title = clean(row?.title, 120);
    const key = proposalKey(todoId);
    if (!key || !title || seen.has(key)) continue;
    const createdAt = Number.isFinite(row?.createdAt) ? row.createdAt : stamp;
    const expiresAt = Number.isFinite(row?.expiresAt) ? row.expiresAt : proposalExpiry(new Date(createdAt));
    if (expiresAt <= stamp) continue;
    seen.add(key);
    out.push({
      key,
      todoId,
      title,
      at: clean(row?.at, 5),
      date: clean(row?.date, 10),
      agentId: clean(row?.agentId, 64),
      said: clean(row?.said, 120),
      createdAt,
      expiresAt,
    });
    if (out.length >= PROPOSE_MAX) break;
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** 这条待办已经有窗在等她了：同一件事不弹第二遍。 */
export function hasProposal(rows, todoId) {
  const key = proposalKey(todoId);
  if (!key) return false;
  return (Array.isArray(rows) ? rows : []).some((row) => row?.key === key);
}

export function findProposal(rows, key) {
  const want = clean(key, KEY_LIMIT);
  if (!want) return null;
  return (Array.isArray(rows) ? rows : []).find((row) => row?.key === want) ?? null;
}

/**
 * 整个功能里唯一碰账本的地方，只有一行：她点了「就打上完成」才会走到这。
 * 提议这一侧（proposeFromMessage）压根没有 ctx 参数，物理上够不到这里。
 * @returns {Promise<{ok:true, todo:object, alreadyDone:boolean}|{ok:false, reason:string}>}
 */
export async function confirmProposal(ctx, proposal, { diagnostics = null } = {}) {
  const todoId = clean(proposal?.todoId, KEY_LIMIT);
  const title = clean(proposal?.title, 120);
  if (!todoId || !title) return { ok: false, reason: "empty" };
  if (typeof ctx?.bus?.request !== "function") return { ok: false, reason: "no-bus" };
  let result = null;
  try {
    result = await ctx.bus.request(`app:${DAYBOOK_APP_ID}/${TODO_COMPLETE_METHOD}`, { id: todoId, title }, { timeout: 20_000 });
  } catch (error) {
    // 没划掉就不能报成功：窗留在原地让她再点一次，不假装已经记下了。
    diagnostics?.({ event: "todo-confirm.call-failed", error: error?.message ?? String(error) });
    return { ok: false, reason: "call-failed" };
  }
  if (!result?.ok) {
    diagnostics?.({ event: "todo-confirm.rejected", reason: result?.reason ?? "unknown" });
    return { ok: false, reason: result?.reason ?? "rejected" };
  }
  diagnostics?.({ event: "todo-confirm.done", title, alreadyDone: Boolean(result.alreadyDone) });
  return { ok: true, alreadyDone: Boolean(result.alreadyDone), todo: result.todo ?? { id: todoId, title } };
}

/**
 * 给 ta 看的那一句：事情还没成立，只能问。
 * 这里的每一行都是在拆台——ta 很容易顺口就把「记下了」说出口，
 * 而账本上一个字都还没动。
 */
export function proposalAskText(todo, { userName = "她" } = {}) {
  const person = String(userName || "她").trim() || "她";
  const title = clean(todo?.title, 60);
  if (!title) return "";
  return [
    "【她刚说的那句话，你听到她像是在报一件做完了的事】",
    `${person}说的像是「${title}」做完了。`,
    "但账本上一个字都还没动——她在聊天窗里会看到一个等你确认的小窗，点「就打上完成」才真的记下。",
    "所以：问句收尾（「要我给它打上完成不？」这一类），别当成已经记好了。",
    "严禁说「记上了」「已经划掉了」「账对上了」这类话：现在没有一条是真的。",
    "别把这句说成系统提示或功能说明，就当你在问她一句话。",
  ].join("\n");
}
