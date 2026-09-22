import { GUIDE_KINDS, normalizeClaims, normalizeGuide } from "./adaptation.js";

const text = (value, max = 240) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
const revisionOf = (book) => Math.max(0, Math.floor(Number(book?.revision) || 0));

function extractJson(raw) {
  const value = String(raw ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

function activeGuide(book, guideId) {
  return (Array.isArray(book?.guides) ? book.guides : []).find((guide) => guide?.id === guideId && guide.status === "active") ?? null;
}

function claimKey(claim) {
  return `${claim?.target ?? ""}|${claim?.subject ?? ""}`;
}

function safeProposal(raw, guide, { instruction = "", allowPermissionChange = false } = {}) {
  if (!raw || typeof raw !== "object" || !guide) return { ok: false, reason: "invalid" };
  const meaning = text(raw.meaning);
  const kind = GUIDE_KINDS.includes(raw.kind) && raw.kind !== "temporary-state" ? raw.kind : "";
  const claims = normalizeClaims(raw.claims);
  if (!meaning || !kind) return { ok: false, reason: "invalid" };

  const existingClaims = Array.isArray(guide.claims) ? guide.claims : [];
  const allowedClaims = new Set(existingClaims.map(claimKey));
  if (claims.some((claim) => !allowedClaims.has(claimKey(claim)))) return { ok: false, reason: "claim-expanded" };
  if (claims.length !== existingClaims.length) return { ok: false, reason: existingClaims.length ? "claim-lost" : "claim-expanded" };

  const stickerClaims = existingClaims.filter((claim) => claim.target === "sticker.permission");
  if (stickerClaims.length) {
    if (claims.length !== stickerClaims.length) return { ok: false, reason: "permission-ambiguous" };
    for (const claim of claims) {
      const previous = stickerClaims.find((old) => old.subject === claim.subject);
      if (claim.target !== "sticker.permission" || !claim.subject || !previous) return { ok: false, reason: "permission-expanded" };
      const changed = claim.effect !== previous.effect || claim.value !== previous.value;
      const explicitChange = claim.effect === "deny"
        ? /(?:不要|别|禁止|不允许|不能再)/u.test(instruction)
        : /(?:可以|允许|同意|继续用)/u.test(instruction);
      if (changed && !allowPermissionChange && !explicitChange) return { ok: false, reason: "permission-not-explicit" };
      const meaningMatches = claim.effect === "deny"
        ? /(?:不要|别|禁止|不允许|不能再)/u.test(meaning)
        : /(?:可以|允许|同意|能用|继续用)/u.test(meaning);
      if (!meaningMatches) return { ok: false, reason: "permission-meaning-mismatch" };
    }
  }
  return { ok: true, proposal: { meaning, kind, claims } };
}

export function listAdaptationForUser({ partnerBook = {}, userBook = {} } = {}) {
  const project = (guide) => ({
    id: guide.id,
    meaning: guide.meaning,
    kind: guide.kind,
    scope: guide.scope,
    updatedAt: guide.updatedAt,
  });
  return [
    ...(Array.isArray(partnerBook.guides) ? partnerBook.guides : []),
    ...(Array.isArray(userBook.guides) ? userBook.guides : []),
  ].filter((guide) => guide?.status === "active" && guide.meaning).map(project);
}

export function revokeAdaptationGuide(book = {}, guideId, now = new Date()) {
  const id = text(guideId, 120);
  const target = activeGuide(book, id);
  if (!target) return { ok: false, reason: "not-found", book };
  const at = new Date(now).toISOString();
  const guides = book.guides.map((guide) => guide.id === id
    ? { ...guide, status: "revoked", revokedAt: at, updatedAt: at }
    : guide);
  const exceptions = (Array.isArray(book.exceptions) ? book.exceptions : []).map((exception) =>
    exception?.guideIds?.includes(id) ? { ...exception, sourceGuideRevoked: true } : exception);
  const habitChanges = (Array.isArray(book.habitChanges) ? book.habitChanges : []).map((habit) =>
    habit?.guideIds?.includes(id) ? { ...habit, state: "reverted", updatedAt: at } : habit);
  const observationLocks = [...new Set([...(book.observationLocks ?? []), ...target.claims.map((claim) => claim.target)])].slice(-64);
  return { ok: true, book: { ...book, guides, exceptions, habitChanges, observationLocks } };
}

export function parseAdaptationCorrection(raw, { guide, userInstruction = "" } = {}) {
  return safeProposal(extractJson(raw), guide, { instruction: String(userInstruction ?? "") });
}

export function applyAdaptationCorrection(book = {}, { guideId, baseRevision, proposal, now = new Date() } = {}) {
  if (revisionOf(book) !== revisionOf({ revision: baseRevision })) return { ok: false, reason: "stale", book };
  const target = activeGuide(book, text(guideId, 120));
  if (!target) return { ok: false, reason: "not-found", book };
  const checked = safeProposal(proposal, target, { allowPermissionChange: true });
  if (!checked.ok) return { ok: false, reason: checked.reason, book };
  const at = new Date(now).toISOString();
  const newId = `correction:${target.id}:${Date.parse(at).toString(36)}`.slice(0, 120);
  const replacement = normalizeGuide({
    ...target,
    ...checked.proposal,
    id: newId,
    scope: target.scope,
    duration: "persistent",
    origin: "explicit",
    confidence: 1,
    sourceMessageIds: target.sourceMessageIds,
    evidenceQuote: target.evidenceQuote,
    status: "active",
    supersedesId: target.id,
    createdAt: at,
    updatedAt: at,
  }, now);
  const guides = book.guides.map((guide) => guide.id === target.id
    ? { ...guide, status: "superseded", supersededById: newId, updatedAt: at }
    : guide);
  guides.push(replacement);
  const exceptions = (Array.isArray(book.exceptions) ? book.exceptions : []).map((exception) =>
    exception?.guideIds?.includes(target.id) ? { ...exception, sourceGuideRevoked: true } : exception);
  const habitChanges = (Array.isArray(book.habitChanges) ? book.habitChanges : []).map((habit) =>
    habit?.guideIds?.includes(target.id) ? { ...habit, state: "reverted", updatedAt: at } : habit);
  const observationLocks = [...new Set([...(book.observationLocks ?? []), ...target.claims.map((claim) => claim.target)])].slice(-64);
  return { ok: true, book: { ...book, guides, exceptions, habitChanges, observationLocks }, guide: replacement };
}

export function buildAdaptationCorrectionSpec({ guide, instruction, conversation = [], partnerName = "" } = {}) {
  const transcript = (Array.isArray(conversation) ? conversation : []).slice(-8)
    .map((row) => `${row?.role === "assistant" ? "伙伴" : "用户"}：${text(row?.text, 300)}`).join("\n");
  return {
    systemPrompt: `你在协助用户纠正一条“相处中形成的理解”。只修改这条理解，不扩展权限，不添加新行为领域。${partnerName ? `当前伙伴：${partnerName}。` : ""}\n只输出 JSON：{"meaning":"给用户看的简短新理解","kind":"preference|aversion|permission|boundary|convention","claims":[...]}`,
    userText: `原理解：${guide?.meaning ?? ""}\n用户想怎么改：${text(instruction, 800)}${transcript ? `\n协商记录：\n${transcript}` : ""}\n原机器约束（target 与 subject 不得新增）：${JSON.stringify(guide?.claims ?? [])}`,
  };
}
