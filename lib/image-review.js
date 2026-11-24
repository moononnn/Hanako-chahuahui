/**
 * 生图发出前的二次质量检查：审核口径、判定与重画决策。纯逻辑，不联网、不读聊天。
 *
 * 2026-11-23：这是「生图」的一个新用途，所以默认关着（设置页有独立开关）。
 * 它只拦最硬的几处：明显多/缺肢体、脸明显崩、画面明显跑题、贴纸动作不明。
 * Q 版、简笔、夸张比例、故意遮挡一律不挑——那是画风，不是毛病。
 *
 * 判定严格三选一：pass / reject / unavailable。
 * 拿不准、看不清、模型没回话，都算 unavailable：宁可不发未审图，也不乱拦。
 *
 * 这份政策是共享的：聊天生图现在用它，将来自制表情包那条链也走同一份
 * （那条链还没做；旧图库也不扫，只管新生成的图）。
 */

/** 判定只有这三个值，别的一律按 unavailable 处理。 */
export const IMAGE_REVIEW_VERDICTS = Object.freeze(["pass", "reject", "unavailable"]);
/** 明确不通过时最多重画几次。 */
export const IMAGE_REVIEW_MAX_REPAINTS = 1;

/**
 * 审核提示词：只给候选图和一句构图意图，不给聊天内容。
 *
 * @param {object} options
 * @param {string} [options.intent] 这张图想要的画面（简短构图意图，不是聊天）
 * @param {string} [options.kind] chat / sticker 之类的用途，只影响措辞
 */
export function imageReviewPrompt({ intent = "", kind = "chat" } = {}) {
  const goal = String(intent ?? "").trim().slice(0, 300);
  const subject = kind === "sticker"
    ? "4) 动作不明确：这是一张贴纸/表情，看不出主体在做什么动作。"
    : "4) 动作不明确：主体在做的事完全看不出是什么动作。";
  return [
    "你在给一张生成图做质检。只看这张图本身：没有聊天内容可看，也不要猜聊天背景。",
    goal ? `这张图想要的画面：${goal}` : "",
    "只有下面这几种硬伤才算 reject：",
    "1) 肢体明显不对：多出一只手或一条腿、断肢、肢体接不上；",
    "2) 脸明显崩掉：五官错位、眼睛糊成一团、脸和身体完全不是一个人；",
    "3) 画面明显跑题：画的东西跟想要的画面完全不是一回事；",
    subject,
    "以下情况一律不要判 reject：Q 版、简笔、扁平画风、夸张比例、故意遮挡（背对镜头、只露手或局部、剪影）、大片留白。",
    "你没有拿到可比较的角色参考输入，所以不许对「这是不是同一个角色」下结论；身份类问题一律按 unavailable 处理。",
    "只输出一个词：pass、reject 或 unavailable。后面可以跟一句不超过 30 字的理由。",
  ].filter(Boolean).join("\n");
}

/**
 * 严格解析审核结果：只认 pass / reject / unavailable。
 *
 * 认得清的形式只有两种：整串就是一个判定词，或首词加一句短理由（也接受 {"verdict":"pass"}）。
 * 认不清就是 unavailable——宁可这张不发，也不因为模型含糊而误拦或误放：
 * “I cannot tell whether to pass”“pass or reject”这类都算说不准。
 */
const VERDICT_WORDS = new Set(IMAGE_REVIEW_VERDICTS);
/** 首词后面那截理由最多这么长：再长就不是「一句理由」，而是另一段话。 */
const REASON_MAX = 40;
/** 说不准的说法：出现这些就直接 unavailable，不去猜它想说什么。 */
const UNCERTAIN_RE = /\b(?:cannot|can'?t|cant|unable|unclear|unsure|ambiguous|whether|maybe|possibly|perhaps|not\s+sure|don'?t\s+know|no\s+idea)\b|无法判断|不确定|看不准|说不准/u;

export function parseImageReviewVerdict(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "unavailable";
  // JSON：只认 {"verdict": "pass"} 这种明确写法。
  const json = text.match(/\{[\s\S]*\}/u)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const verdict = String(parsed?.verdict ?? "").trim().toLowerCase();
      if (VERDICT_WORDS.has(verdict)) {
        // JSON 里也只许出现一个判定词。
        const hits = JSON.stringify(parsed).toLowerCase().match(/\b(unavailable|reject|pass)\b/gu) ?? [];
        if (hits.length <= 1) return verdict;
      }
    } catch { /* 不是 JSON 就按正文读 */ }
  }
  const lower = text.toLowerCase();
  if (UNCERTAIN_RE.test(lower)) return "unavailable";
  // 首词（后面可以跟一句短理由）：首词必须是明确的判定词。
  const head = text.match(/^([A-Za-z]+)([\s\S]*)$/u);
  if (!head) return "unavailable";
  const first = head[1].toLowerCase();
  if (!VERDICT_WORDS.has(first)) return "unavailable";
  // 全文只能出现这一个判定词：两个词就是拿不准，不猜。
  const hits = lower.match(/\b(unavailable|reject|pass)\b/gu) ?? [];
  if (hits.length !== 1) return "unavailable";
  const reason = head[2].trim();
  if (reason.length > REASON_MAX) return "unavailable";
  return first;
}

/**
 * 明确 reject 之后要不要重画一次。
 *
 * 四个条件全过才重画：还在这一轮（没被取消）、还有原配额、同一 provider、同一参考。
 * unavailable 一律不重画：审图那头自己都不通，盲画一张还是没人审。
 */
export function shouldRepaintAfterReview({
  verdict = "unavailable", stillCurrent = false, quotaAvailable = false, sameProvider = true, sameReference = true,
} = {}) {
  if (verdict !== "reject") return false;
  return Boolean(stillCurrent && quotaAvailable && sameProvider && sameReference);
}
