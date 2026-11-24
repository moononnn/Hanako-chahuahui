/**
 * 「允许作为表情动作参考」：她明确按过一下的授权标记（2026-11-23）。
 *
 * 这一条是她自己的决定：她按一下，就等于声明这张图她有权、也准许拿去做角色的表情动作参考。
 * 所以：
 * ① 它是独立的标记，不改旧收藏语义——「收作表情」还是「收作表情」，两回事；
 * ② 只认本地能可靠读到的附件：这位伙伴自己的、能读出字节的图；不接任意 URL，不跨 App 扫；
 * ③ 可以撤回：撤回之后，已经照它做出来的稿子当场作废。
 *
 * 这个模块只管纯逻辑：不碰文件、不调模型。
 */

/** 附件上那个授权标记的名字（写在附件元数据里，与 collection 分开）。 */
export const REFERENCE_USE_KEY = "referenceUse";

/** 授权标记归一：只有明确的 allowed 才算数，别的都当没授权。 */
export function normalizeReferenceUse(value) {
  const raw = value && typeof value === "object" ? value : {};
  if (raw.allowed !== true) return { allowed: false, at: null };
  const at = String(raw.at ?? "").trim().slice(0, 40);
  return { allowed: true, at: at || null };
}

/** 这张附件有没有被明确授权过。 */
export function referenceUseAllowed(meta) {
  return normalizeReferenceUse(meta?.[REFERENCE_USE_KEY]).allowed;
}

/**
 * 挑可用的动作参考图。
 *
 * 只从这位伙伴自己的附件里挑：被明确授权过、没被清掉、没被撤回、字节还在。
 * 挑不出就是挑不出——没有授权的图一张都不动。
 */
export function pickReferenceUseSources({ metas = [], agentId = "", limit = 4, hasBytes = () => true } = {}) {
  const owner = String(agentId ?? "");
  const out = [];
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!meta || typeof meta !== "object") continue;
    if (owner && String(meta.agentId ?? "") !== owner) continue;
    if (meta.purgedAt) continue;
    if (meta.collection?.recalledSource) continue;
    if (!referenceUseAllowed(meta)) continue;
    const id = String(meta.id ?? "");
    if (!id) continue;
    let alive = false;
    try { alive = Boolean(hasBytes(id)); } catch { alive = false; }
    if (!alive) continue;
    out.push({
      id,
      title: String(meta.title ?? "").trim().slice(0, 160),
      description: String(meta.description ?? "").trim().slice(0, 300),
      at: String(meta.at ?? "").trim().slice(0, 40) || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 稿子作废的几种情形：源被撤回、源被收回授权、身份换了。
 *
 * 调用方把源的状态算好传进来（读文件、读消息都在外面做），这里只判。
 */
export function stickerDraftStillValid({ draft = null, referenceId = "", sourceAllowed = false, sourceRecalled = false } = {}) {
  if (!draft?.attachmentId) return false;
  if (sourceRecalled) return false;
  if (!sourceAllowed) return false;
  if (draft.referenceId && String(referenceId ?? "") !== draft.referenceId) return false;
  return true;
}
