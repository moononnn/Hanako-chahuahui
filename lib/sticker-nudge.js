/**
 * 表情包沉默提醒。
 *
 * 2026-10-23 到 10-25 实机：图库读得到（330 张）、标记解析和挑图都通，
 * 但模型连着几天一次 [表情:关键词] 都没写。诊断里 sticker.reply 的 marker 全是 null，
 * 也就是压根没伸手。原因是上下文里没有可模仿的示范：提示词自己写着「模型是模仿动物，
 * 看见怎么用的比读十条说明管用」，连着几轮没有一条带图，那段说明就退化成背景噪音。
 *
 * 所以这里补的不是「必须配图」，是给两个真正成立的时机放行一次：
 *   ① 她给了落地信号（纯笑声／附和），或者直接甩了张图过来斗图；
 *   ② 连着好几轮一张都没甩，一天最多提一次。
 *
 * 计数全部从聊天记录现数，发过图就自然归零，不另存一个迟早会忘记清的计数器。
 * 真正跨轮要留的只有「沉默兜底今天提过没有」，那一份落在伙伴设置里。
 */

/** 只认得窄的纯笑声/附和，跟回复规则共用同一套判据。 */
import { isClosingSignal } from "./prompt.js";

export const STICKER_NUDGE_SCHEMA_VERSION = 1;
/** 连着几轮没甩图算沉默。 */
export const SILENCE_ROUNDS = 6;
/** 沉默兜底一天最多提一次。 */
export const DAILY_SILENCE_LIMIT = 1;

/** 落库文本里表情包只留一个记号（见 index.js 的 visibleTextOf）。 */
const STICKER_MARK = "[表情]";

function textOf(row) {
  return typeof row?.text === "string" ? row.text : "";
}

/** 这条消息是不是带了一张图。 */
export function isStickerMessage(row) {
  if (!row) return false;
  if (row.attachment && row.attachment.kind === "sticker") return true;
  return textOf(row)
    .split("\n")
    .some((line) => line.trim() === STICKER_MARK);
}

/**
 * 从末尾往前数：连着几条伙伴回复没有甩图。
 * 用户消息、动作消息（kind: action）和召回的空壳都不占轮次；
 * 一碰到带图的回复就停，那张图就是示范，沉默到头了。
 */
export function stickerSilenceRounds(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let rounds = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.recalled) continue;
    if (row.role !== "assistant") continue;
    if (row.kind === "action") continue;
    if (!textOf(row).trim()) continue;
    if (isStickerMessage(row)) return rounds;
    rounds += 1;
  }
  return rounds;
}

/**
 * 她这一轮给的信号。
 * @returns {"sticker"|"closing"|""} 甩图过来 / 笑完落地 / 没有信号
 */
export function latestUserSignal(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastUser = [...rows].reverse().find((row) => row?.role === "user" && !row.recalled);
  if (!lastUser) return "";
  if (isStickerMessage(lastUser)) return "sticker";
  if (isClosingSignal(lastUser.text)) return "closing";
  return "";
}

const SIGNAL_TEXT = {
  sticker: [
    "【她递了张图过来】",
    "这一轮她的话就是一张图。接这一手最自然的是也甩一张回去，图能接住就单独甩，不够就配一句再接；不想接就正常说一句，别当没看见那张图，也不用解释她在发什么。",
  ],
  closing: [
    "【这一轮可以只用一张图收尾】",
    "她这句是笑完落地，没有新话题等你接。这种时候甩一张自己的图比再补一句话更像你：想甩就整条只写一行 [表情:关键词]，不想甩就安静收尾，不必为了接而接。",
  ],
};

/**
 * 拼这一轮的提醒。信号优先，沉默兜底排在后面，同一轮最多一条。
 * @returns {{ kind: "sticker"|"closing"|"silence"|"", text: string }}
 */
export function buildStickerNudge({
  signal = "",
  silenceRounds = 0,
  nudgesToday = 0,
  userName = "她",
  threshold = SILENCE_ROUNDS,
  dailyLimit = DAILY_SILENCE_LIMIT,
} = {}) {
  if (signal && SIGNAL_TEXT[signal]) {
    return { kind: signal, text: SIGNAL_TEXT[signal].join("\n") };
  }
  const rounds = Math.max(0, Number(silenceRounds) || 0);
  const used = Math.max(0, Number(nudgesToday) || 0);
  if (rounds >= threshold && used < Math.max(0, Number(dailyLimit) || 0)) {
    return {
      kind: "silence",
      text: [
        "【提醒你一下】",
        `你已经连着 ${rounds} 轮没甩过表情包了。不是要你补一张凑数，只是把这件事提醒回你手边：这一轮要是哪张正好合你说的话，就甩，别只挂在嘴上说。`,
        `顺带一句，${userName}笑完、甩图过来、或者损你的时候，就是最自然的时机。`,
      ].join("\n"),
    };
  }
  return { kind: "", text: "" };
}

/** 今天这一份兜底提醒的账；跨天了就归零。 */
export function nudgeStateForToday(state, lifeDay) {
  const day = String(lifeDay ?? "");
  if (!state || String(state.lifeDay ?? "") !== day) return { lifeDay: day, count: 0 };
  const count = Math.max(0, Number(state.count) || 0);
  return { lifeDay: day, count };
}

/** 提过一次就记一笔。 */
export function bumpNudgeState(state, lifeDay) {
  const today = nudgeStateForToday(state, lifeDay);
  return { lifeDay: today.lifeDay, count: today.count + 1 };
}
