import { dayKey } from "./days.js";
import { normalizeGuide } from "./adaptation.js";

const SAFE_PATTERNS = Object.freeze([
  {
    key: "reply.self-disclosure|more",
    target: "reply.self-disclosure",
    meaning: "你似乎喜欢我也多分享一点自己",
    claim: { target: "reply.self-disclosure", effect: "prefer", value: "more" },
    matches: (value) => /(?:你呢|说说你自己|讲讲你自己|聊聊你自己|你今天(?:过得|怎么样))/u.test(value),
  },
  {
    key: "reply.advice-style|advice-first",
    target: "reply.advice-style",
    meaning: "你似乎更习惯先听清楚的分析和建议",
    claim: { target: "reply.advice-style", effect: "prefer", value: "advice-first" },
    matches: (value) => /(?:你觉得我该|我该怎么办|给我.{0,6}建议|帮我分析)/u.test(value),
  },
]);

const SENSITIVE = /(?:骂我|羞辱|色情|性爱|身体接触|碰我|隐私|密码|付款|支付|转账|花钱|联网|上传|对外发送|代发|安全边界)/u;

function claimsFor(guide, target) {
  return (Array.isArray(guide?.claims) ? guide.claims : []).filter((claim) => claim?.target === target);
}

function blockedByGuides(guides, target) {
  for (const guide of Array.isArray(guides) ? guides : []) {
    const claims = claimsFor(guide, target);
    if (!claims.length) continue;
    if (guide.origin === "explicit" && (guide.status === "active" || ["revoked", "superseded"].includes(guide.status))) return true;
    // 观察一旦被纠正、忘掉或取代，同一模式不再拿旧证据重新生成。
    if (guide.origin === "observed") return true;
  }
  return false;
}

function evidenceFor(messages, pattern) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user" && !message.recalled && message.id && message.at)
    .filter((message) => {
      const value = String(message.text ?? "");
      return !SENSITIVE.test(value) && pattern.matches(value);
    })
    .map((message) => ({ ...message, lifeDay: dayKey(message.at) }))
    .filter((message) => message.lifeDay)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function inferObservedGuide({ messages = [], guides = [], locks = [], now = new Date() } = {}) {
  const locked = new Set(Array.isArray(locks) ? locks.map(String) : []);
  for (const pattern of SAFE_PATTERNS) {
    if (locked.has(pattern.target) || blockedByGuides(guides, pattern.target)) continue;
    const evidence = evidenceFor(messages, pattern);
    const days = new Set(evidence.map((message) => message.lifeDay));
    if (evidence.length < 3 || days.size < 3) continue;
    const picked = evidence.slice(-12);
    const latest = picked[picked.length - 1];
    const guide = normalizeGuide({
      id: `observed:${pattern.key}`,
      meaning: pattern.meaning,
      kind: "preference",
      scope: "relationship",
      duration: "persistent",
      origin: "observed",
      confidence: 0.72,
      sourceMessageIds: picked.map((message) => message.id),
      evidenceQuote: String(latest.text ?? "").slice(0, 160),
      claims: [pattern.claim],
      status: "active",
      createdAt: latest.at,
      updatedAt: latest.at,
    }, now);
    return { guide, pattern: pattern.key, evidenceCount: evidence.length, lifeDays: days.size };
  }
  return { guide: null, pattern: null, evidenceCount: 0, lifeDays: 0 };
}
