/**
 * 伙伴 ID 的形状校验。
 *
 * 为什么要单独立一个：外面传进来的 agentId 会拼进文件路径（读人格、读头像、写账本），
 * 也会拼进目录名。不校验的话，`..` 这类值能爬到目标伙伴的目录外面去。
 *
 * 规则故意收得很紧：只认字母数字、下划线、连字符，长度封顶 64。
 * Hana 的伙伴 id 和茶话会自己的本地角色 id 都在这个范围内。
 */

export const PARTNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const RESERVED_PARTNER_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** 外部传进来的 agentId 一律先过这里。 */
export function isValidPartnerId(id) {
  const s = String(id ?? "").trim();
  if (!s || RESERVED_PARTNER_IDS.has(s)) return false;
  if (s === "." || s === "..") return false;
  return PARTNER_ID_RE.test(s);
}

/** 文件系统边界必须拒绝非法值，不能把它改名成另一个合法伙伴。 */
export function requirePartnerId(id) {
  const s = String(id ?? "").trim();
  if (!isValidPartnerId(s)) {
    const error = new Error("伙伴 ID 不合法");
    error.code = "INVALID_PARTNER_ID";
    throw error;
  }
  return s;
}

/** 旧调用的非抛错兼容口；新文件路径一律使用 requirePartnerId。 */
export function safePartnerId(id) {
  const s = String(id ?? "").trim();
  return isValidPartnerId(s) ? s : "";
}
