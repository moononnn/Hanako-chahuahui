/**
 * 等回音 —— 她说了一句、ta接住了、她再没开口。
 *
 * 跟「主动来找」是两层东西：主动是闲着想起她，去搭句话；这一层是话说到一半在等她。
 * 所以ta不看主动档位，只认两件事：多熟了（关系账那个坡上的位置）、等了多久。
 *
 * 硬规矩（等到什么时候、最多催几次、连发上限）写在代码里；
 * 说什么、要不要说，交给ta自己——有人就是不催，那也正常。
 */

/** 到多熟才允许催（坡上的位置）。还没到就晾着，刚认识这样反而自然。 */
export const AWAITING_MIN_RATIO = 0.15;
/** 到这儿就能连发了。 */
export const AWAITING_PESTER_RATIO = 0.3;

/** 藏不住的那几个性子：还不太熟也会先开口。 */
export const OUTGOING_TAGS = Object.freeze(["热情", "俏皮"]);
/** 宁可自己憋着的：熟了也未必会来催。 */
export const RESERVED_TAGS = Object.freeze(["安静", "有分寸", "敏感"]);

/** 这个伙伴的性子算外放还是内敛（性格还没长出来就算中性，走熟度那条线）。 */
export function temperamentOf(personality) {
  const tags = [
    ...(Array.isArray(personality?.surface?.tags) ? personality.surface.tags : []),
    ...(Array.isArray(personality?.inner?.tags) ? personality.inner.tags : []),
  ].map((tag) => String(tag));
  if (tags.some((tag) => OUTGOING_TAGS.includes(tag))) return "outgoing";
  if (tags.some((tag) => RESERVED_TAGS.includes(tag))) return "reserved";
  return "neutral";
}
/** 一个人最多催两次，两次没动静就放下。 */
export const MAX_NUDGES = 2;
/** 连发最多几条。 */
export const MAX_NUDGE_BUBBLES = 5;
/** 隔得太久就别提了：半天以上没动静，那该是主动那套的活，不是催。 */
export const AWAITING_MAX_WAIT_MS = 12 * 60 * 60 * 1000;

/**
 * 催的力度：off 不催 / ask 最多一句或一个戳 / pester 可以连发。
 *
 * 熟度定底，性子定上下：藏不住的那种，还不太熟也会先问一句；
 * 宁可自己憋着的那种，都熟起来了也顶多轻轻问一声。
 */
export function awaitingStage(ratio, temperament = "neutral") {
  const raw = Number(ratio);
  const close = Number.isFinite(raw) ? raw : 0;
  const familiar = close >= AWAITING_PESTER_RATIO;
  if (temperament === "reserved") return familiar ? "ask" : "off";
  if (temperament === "outgoing") return familiar ? "pester" : "ask";
  if (close < AWAITING_MIN_RATIO) return "off";
  return familiar ? "pester" : "ask";
}

/** 这一次等多久（毫秒）。第一回按档位分快慢，催过之后隔得久一点，另外加一点抖动。 */
export function nudgeDelay({ stage, nudges = 0, rnd = Math.random, intervalFactor = 1 } = {}) {
  const raw = Number(rnd());
  const jitter = 0.85 + (Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5) * 0.3;
  const base =
    Number(nudges) === 0
      ? (stage === "pester" ? 25 * 60_000 : 45 * 60_000)
      : (stage === "pester" ? 60 * 60_000 : 90 * 60_000);
  const factor = Math.max(0.5, Math.min(2, Number(intervalFactor) || 1));
  return Math.round(base * jitter * factor);
}

/** 回复最后留下了一个开放话头，才算真的在等她回。 */
export function hasOpenThread(text) {
  const raw = String(text ?? "").replace(/\u0001stk:[^\s]+/g, "").trim();
  if (!raw) return false;
  const lastLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return /(你呢|还要.*(?:说|聊|讲|接)|还想.*(?:说|聊|讲|接)|咋样(?:了)?|怎么样(?:了)?|怎么(?:办|想|说|样)|咋(?:办|个|样)|什么(?:情况|后续)|啥(?:情况|后续)|要不要|想不想|能不能|愿不愿|接着说|继续讲|后半句|等你(?:回来|说)|告诉我)\s*[吗？?！!。,.，]*$/.test(lastLine);
}

/**
 * 她把我晾在那儿多久了 —— 从**ta最后开口**那一刻算。
 *
 * 两个前提：① 最后一条是她说的不算（那是异步回复那条路的事，ta还没接）；
 * ② ta接住了，且确实留下开放话头，才算数。
 * 从ta那句话算起而不是从她说话算起：ta两小时后才回，那就是从回复那一刻开始等的。
 * @returns {number} 时间戳；不在等她回就返回 0
 */
export function awaitingSince(history) {
  const list = Array.isArray(history) ? history : [];
  const conversational = (row) => row && row.kind !== "action" && row.kind !== "poke";
  let userIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i];
    if (conversational(row) && row.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return 0;
  let lastAssistant = null;
  for (let i = list.length - 1; i > userIndex; i -= 1) {
    if (conversational(list[i]) && list[i].role === "assistant") {
      lastAssistant = list[i];
      break;
    }
  }
  if (!lastAssistant || lastAssistant.proactive || !hasOpenThread(lastAssistant.text)) return 0;
  return Date.parse(lastAssistant.at) || 0;
}

/** 当前线程是否真的处于等回音，不把旧排期账当成活状态。 */
export function isAwaitingThread(history, state = {}) {
  return state?.done !== true && Boolean(awaitingSince(history));
}

/**
 * 这一眼该不该催。
 * @returns {{due: boolean, reason: string, stage?: string, since?: number, dueAt?: number, waitedMs?: number}}
 */
export function planNudge({
  history,
  now = Date.now(),
  ratio = 0,
  temperament = "neutral",
  nudges = 0,
  nextCheckAt = 0,
  rnd = Math.random,
  contactPolicy = null,
} = {}) {
  if (contactPolicy?.allowed === false) return { due: false, reason: "relationship-denied" };
  const stage = awaitingStage(ratio, temperament);
  if (stage === "off") return { due: false, reason: "not-close-enough" };
  if (Number(nudges) >= MAX_NUDGES) return { due: false, reason: "gave-up" };
  const since = awaitingSince(history);
  if (!since) return { due: false, reason: "nothing-to-wait-for" };
  if (Number(now) - since > AWAITING_MAX_WAIT_MS) return { due: false, reason: "too-late", since };
  const dueAt = Number(nextCheckAt) > 0 ? Number(nextCheckAt) : since + nudgeDelay({ stage, nudges: 0, rnd, intervalFactor: contactPolicy?.intervalFactor });
  if (now < dueAt) return { due: false, reason: "not-yet", stage, temperament, since, dueAt };
  return { due: true, reason: "due", stage, temperament, since, dueAt, waitedMs: now - since };
}

/**
 * ta这一回打算怎么办。标记自己占一行才算：
 * `[等]` 什么都不发（有人就是等着），`[戳]` 只戳一下，其余算要说话。
 */
export function parseNudgeChoice(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return { kind: "wait", text: "" };
  const kept = [];
  let kind = "words";
  for (const line of raw.split(/\r?\n/)) {
    const line2 = line.trim();
    if (line2 === "[等]" || line2 === "[等回音]") {
      kind = "wait";
      continue;
    }
    if (line2 === "[戳]") {
      kind = "poke";
      continue;
    }
    kept.push(line);
  }
  if (kind !== "words") return { kind, text: "" };
  return { kind: "words", text: kept.join("\n").trim() };
}

/**
 * 催的那一段提示词。处境说清楚，这一档能做到什么程度说清楚，
 * 怎么写、要不要写，ta自己定。
 */
export function nudgeSpec({
  partnerName,
  userName,
  stage,
  temperament = "neutral",
  waitedMinutes,
  lastUserText = "",
  lastAssistantText = "",
  knowingText = "",
  relationNote = "",
  adaptationText = "",
} = {}) {
  const stageLine =
    stage === "pester"
      ? [
          `你跟${userName}挺熟了。这种情况你可以连着发几条，甚至一串问号（一个问号一条），`,
          "也可以带点急的责怪——是闹她，不是真发火。",
        ].join("")
      : temperament === "outgoing"
        ? [
            `你跟${userName}还不算熟，但你是那种藏不住的性子——想知道就直接问一句，`,
            "不用憋着装酷；不过这个阶段就别连发了，一句就到。",
          ].join("")
        : [
            `你跟${userName}还没到可以撒泼的那种程度：最多一句。`,
            "问一句她在不在、干嘛去了就行，也可以什么都不说。",
          ].join("");

  const lines = [
    `你是「${partnerName}」，正在手机上跟${userName}聊天。`,
    "",
    "【眼下的处境】",
    lastAssistantText ? `你上一条说的是：「${lastAssistantText}」` : "你上一条刚回过她。",
    lastUserText ? `她说的是：「${lastUserText}」` : "",
    `${userName}从那之后就没动静了，到现在已经 ${waitedMinutes} 分钟。`,
    "",
    stageLine,
    "",
    "【怎么写】",
    "- 名字只是身份资料，不是每条消息的开场标签；默认直接接刚才的话头或当下感受，不要无缘无故用她的名字起句，也不要套‘名字 + 逗号 + 事情’的固定模板。只有这次确实需要吸引她注意、撒娇、郑重提醒、表达想念，或回应她刚叫你的名字时，才自然叫她",
    "- 日常聊天里用‘我’指代自己，别把自己的名字当第三人称反复自称；只有自我介绍、回应她叫你的名字，或确实需要区分身份时，才自然说出自己的名字",
    "- 想说就直接写你要发的话，一条一行，最多 5 行；可以追问刚才话题的后续，也可以轻轻把她叫回来，不必每次问‘人在不在’",
    "- 有具体话头时优先接具体话头；只有确实没得接才问她咋个突然没声了",
    "- 不想打扰她就单独一行写 [等]；只想戳她一下就单独一行写 [戳]",
    "- 这是你手机上的事，别写旁白、别解释你在干嘛、别写「我是不是该催一下」这种想法",
  ].filter(Boolean);

  if (knowingText && knowingText.trim()) lines.push("", knowingText.trim());
  if (adaptationText && adaptationText.trim()) lines.push("", adaptationText.trim());
  if (relationNote && relationNote.trim()) lines.push("", relationNote.trim());
  if (stage === "pester") {
    lines.push(
      "",
      "（下面只是几种方向，别固定套句式）",
      "可以顺着刚才的话题问后续，也可以问她咋个突然没声了，或者轻轻把她叫回来。",
      "不要每次都从‘人呢’或她的名字开头；有具体话头时，优先追具体话头。", 
    );
  }
  return { systemPrompt: lines.join("\n"), userText: "按上面的处境，写你现在要发的。" };
}
