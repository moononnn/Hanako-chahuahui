import { normalizeGuide } from "./adaptation.js";

const text = (value, max = 240) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function stableStickerSubject(value) {
  const raw = String(value ?? "");
  const explicit = /(?:source|sticker)[：:]\s*([a-z0-9._-]{2,80})/iu.exec(raw);
  if (explicit) return `source:${explicit[1]}`;
  const labeled = /表情包(?:id)?[：:]\s*([a-z0-9._-]{2,80})/iu.exec(raw);
  return labeled ? `source:${labeled[1]}` : "";
}

function legacyClaim(factText) {
  const value = String(factText ?? "");
  const negative = /(?:不要|不想|别再?|禁止|讨厌|不喜欢|不允许)/u.test(value);
  const less = /(?:少一点|少发|少说|别总|别老|晚一点|晚点|等.*醒|不用那么频繁)/u.test(value);
  const more = /(?:多一点|多发|多说|经常|常来|更主动|喜欢听|喜欢你发|继续这样)/u.test(value);

  if (/(?:语音|声音)/u.test(value)) {
    if (negative && !less) return { target: "voice.frequency", effect: "deny", value: "none" };
    if (less) return { target: "voice.frequency", effect: "prefer", value: "less" };
    if (more) return { target: "voice.frequency", effect: "prefer", value: "more" };
  }
  if (/(?:睡着|睡觉|叫醒|吵醒|醒来)/u.test(value)) {
    if (/(?:不要|别).*?(?:叫醒|吵醒)|(?:等|晚点).*?醒/u.test(value)) return { target: "sleep.reply", effect: negative ? "deny" : "prefer", value: negative ? "none" : "wake-later" };
    if (/(?:可以|希望|想让|哪怕).*?(?:叫醒|早点回|接住)/u.test(value)) return { target: "sleep.reply", effect: "prefer", value: "wake-sooner" };
  }
  if (/(?:主动找|主动联系|主动消息|来找我)/u.test(value)) {
    if (negative && !less) return { target: "proactive.frequency", effect: "deny", value: "none" };
    if (less) return { target: "proactive.frequency", effect: "prefer", value: "less" };
    if (more || /(?:希望|想让).*?主动/u.test(value)) return { target: "proactive.frequency", effect: "prefer", value: "more" };
  }
  if (/(?:建议|分析|安慰|接住情绪|陪我)/u.test(value)) {
    if (/(?:先.*?(?:安慰|陪|接住)|不要急着.*?(?:建议|分析))/u.test(value)) return { target: "reply.advice-style", effect: "prefer", value: "comfort-first" };
    if (/(?:先.*?(?:建议|分析)|直接.*?(?:建议|重点))/u.test(value)) return { target: "reply.advice-style", effect: "prefer", value: "advice-first" };
  }
  if (/(?:分享自己|说说自己|讲讲自己|自我披露)/u.test(value)) {
    if (negative || less) return { target: "reply.self-disclosure", effect: negative ? "deny" : "prefer", value: negative ? "none" : "less" };
    if (more) return { target: "reply.self-disclosure", effect: "prefer", value: "more" };
  }
  if (/(?:玩笑|打趣|损我|开我玩笑)/u.test(value)) {
    if (negative || less) return { target: "reply.teasing", effect: negative ? "deny" : "prefer", value: negative ? "none" : "less" };
    if (more || /喜欢.*?(?:玩笑|打趣|损)/u.test(value)) return { target: "reply.teasing", effect: "prefer", value: "more" };
  }
  if (/表情包/u.test(value)) {
    const subject = stableStickerSubject(value);
    if (!subject) return null;
    if (negative) return { target: "sticker.permission", effect: "deny", value: "specific", subject };
    if (/(?:允许|可以|同意|喜欢|想用)/u.test(value)) return { target: "sticker.permission", effect: "allow", value: "specific", subject };
  }
  return null;
}

function explicitRelationalMeaning(value) {
  const raw = String(value ?? "");
  return /(?:用户|我).{0,20}(?:希望|想让|要求|请|不要|别|习惯).{0,20}(?:伙伴|你).{0,24}(?:回复|回应|称呼|陪|安慰|建议|分析|玩笑|打趣|分享)/u.test(raw)
    || /(?:用户|我).{0,12}喜欢.{0,12}(?:伙伴|你).{0,16}(?:回复|回应|称呼|陪|安慰|玩笑|打趣|分享)/u.test(raw)
    || /(?:伙伴|你).{0,20}(?:回复|回应|称呼|陪|安慰|建议|分析|玩笑|打趣|分享).{0,20}(?:多|少|先|别|不要|简短|详细)/u.test(raw);
}

export function migrateLegacyFacts({ facts = [], messages = [], book = {}, existingGuides = [], now = new Date() } = {}) {
  const sourceMessages = new Map((Array.isArray(messages) ? messages : []).map((row) => [String(row?.id ?? ""), row]));
  const migration = book?.migration && typeof book.migration === "object" ? book.migration : {};
  if (migration.factsV1CompletedAt) return { book, added: [], skipped: [], alreadyCompleted: true };

  const guides = Array.isArray(book?.guides) ? [...book.guides] : [];
  const knownSources = new Set([
    ...(Array.isArray(migration.sourceIds) ? migration.sourceIds : []),
    ...(Array.isArray(existingGuides) ? existingGuides : []).flatMap((guide) => guide?.sourceMessageIds ?? []),
  ].map(String));
  const processedSources = new Set(Array.isArray(migration.sourceIds) ? migration.sourceIds.map(String) : []);
  const added = [];
  const skipped = [];

  for (const fact of Array.isArray(facts) ? facts : []) {
    const sourceId = String(fact?.source ?? "").trim();
    const source = sourceMessages.get(sourceId);
    const meaning = text(fact?.fact ?? fact?.text);
    if (!sourceId || !source || source.role !== "user" || source.recalled || !meaning) {
      skipped.push({ sourceId, reason: "untrusted-source" });
      continue;
    }
    processedSources.add(sourceId);
    if (knownSources.has(sourceId)) {
      skipped.push({ sourceId, reason: "source-exists" });
      continue;
    }
    if (!["preference", "boundary", "permission"].includes(String(fact?.kind))) {
      skipped.push({ sourceId, reason: "unsupported-fact" });
      continue;
    }
    const claim = legacyClaim(meaning);
    if (/表情包/u.test(meaning) && !claim) {
      skipped.push({ sourceId, reason: "unstable-sticker-subject" });
      continue;
    }
    if (!claim && !explicitRelationalMeaning(meaning)) {
      skipped.push({ sourceId, reason: "ambiguous-meaning" });
      continue;
    }
    const kind = claim?.target === "sticker.permission" && claim.effect === "allow"
      ? "permission"
      : fact.kind === "boundary" || claim?.effect === "deny" ? "boundary" : "preference";
    const sourceAt = source.at ?? fact.at ?? now;
    const guide = normalizeGuide({
      id: `legacy-fact-v1:${stableHash(`${sourceId}|${meaning}`)}`,
      meaning,
      kind,
      scope: "relationship",
      duration: "persistent",
      origin: "explicit",
      confidence: 1,
      sourceMessageIds: [sourceId],
      evidenceQuote: text(source.text, 160),
      claims: claim ? [claim] : [],
      status: "active",
      createdAt: sourceAt,
      updatedAt: sourceAt,
    }, now);
    guides.push(guide);
    added.push(guide);
    knownSources.add(sourceId);
  }

  return {
    book: {
      ...book,
      guides,
      migration: {
        ...migration,
        factsV1CompletedAt: new Date(now).toISOString(),
        sourceIds: [...processedSources].slice(-512),
      },
    },
    added,
    skipped,
    alreadyCompleted: false,
  };
}
