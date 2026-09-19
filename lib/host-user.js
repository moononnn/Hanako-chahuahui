/**
 * 读这台机器上「用的人」叫什么。
 *
 * 分享版的地基之一：茶话会绝不能把某个人的名字写死在代码里。
 * 换个人装这个应用，ta 的伙伴要叫的应该是 ta 自己的名字；叫错了比不说话更伤。
 *
 * 来源按可靠度排：
 *   1. <hanaHome>/users.json —— defaultUserId 那位的 displayName（账号体系里的正主）
 *   2. <hanaHome>/user/preferences.json —— userName（界面偏好里那份）
 * 两边都拿不到就返回空串，由调用方给一个中性称呼兜底，不硬编一个名字顶上。
 *
 * 纯逻辑为主：解析是纯函数（好测），只有 resolveUserDisplayName 一处读盘。
 */

import path from "node:path";

export const USERS_FILE = "users.json";
export const PREFERENCES_FILE = path.join("user", "preferences.json");

/** 字段可能叫这几个名字，按顺序取第一个非空的。 */
const NAME_KEYS = ["displayName", "username", "name"];

function safeJson(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
}

/**
 * 从 users.json 里取默认用户的名字；拿不到返回 ""。
 * 认不出 defaultUserId 就退到第一条用户——总比没有强。
 */
export function parseUsersJson(value) {
  const data = safeJson(value);
  const users = Array.isArray(data?.users) ? data.users : [];
  if (users.length === 0) return "";
  const wanted = String(data?.defaultUserId ?? "");
  const picked = wanted ? users.find((row) => String(row?.userId ?? "") === wanted) : null;
  const row = picked ?? users[0];
  for (const key of NAME_KEYS) {
    const text = String(row?.[key] ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** 从 user/preferences.json 里取名字；拿不到返回 ""。 */
export function parsePreferencesJson(value) {
  const data = safeJson(value);
  return String(data?.userName ?? "").trim();
}

/**
 * 去读盘。读盘走 ctx.resources.read（App 沙箱下的正门）。
 * 任何一步失败都只当「这次没读到」，不打断启动、也不惊动她。
 */
export async function resolveUserDisplayName(ctx, hanaHome) {
  const readText = async (rel) => {
    try {
      const result = await ctx.resources.read({ kind: "local-file", path: path.join(hanaHome, rel) });
      const content = result?.content;
      if (typeof content === "string") return content;
      if (content) return Buffer.from(content).toString("utf8");
      return "";
    } catch {
      return "";
    }
  };
  const fromUsers = parseUsersJson(await readText(USERS_FILE));
  if (fromUsers) return fromUsers;
  return parsePreferencesJson(await readText(PREFERENCES_FILE));
}
