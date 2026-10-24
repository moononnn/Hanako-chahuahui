/**
 * 读一条 B 站视频（工具）。
 *
 * 2026-10-23 定的方向：**不替她去点，给她点开的能力。**
 *
 * 一开始做的是「应用在回她之前替伙伴把材料抓好、塞进提示词」。这条路能跑，
 * 但只对那一轮有效，隔几轮再说起那个视频，材料早不在了；而且伙伴没有拒绝的余地，
 * 手上已经被塞了一份东西，只能假装不满意。
 *
 * 改成工具之后：
 * - 发起权在伙伴：觉得有意思就调，觉得没劲就压根不调，回一句「不看」或者甩个表情包；
 * - 没有时间窗限制：她三天前发的视频，只要还在手边清单里，哪天想起都能翻出来看；
 * - 执行在应用：读取文字材料，并在识图可用时补充少量真实画面，回给 ta。
 *
 * 这里只放纯逻辑（工具声明、手边清单、排版）。执行那一段在 index.js，
 * 因为登录态、缓存和诊断都住在那儿。
 */

import { extractVideoLink } from "./video-inbound.js";

export const READ_VIDEO_TOOL_NAME = "read_bilibili_video";

/** 工具声明（宿主契约 AppModelToolV2：JSON Schema，宿主自己不会执行）。 */
export const READ_VIDEO_TOOL = {
  name: READ_VIDEO_TOOL_NAME,
  description: "读一条 B 站视频的字幕、弹幕、热评；识图可用且取帧成功时，还会补充封面、稀疏正片采样与一个局部连续片段的画面事实，不含音轨，不代表完整观看。她发过链接、你也想看看时使用。只认 B 站普通视频；番剧、专栏打不开。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要看的视频：她发的那条链接原文，或者 BV 号。",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/** 她发出来的分享文案里，标题通常在【】里（B 站 App 和网页都是这个格式）。 */
const TITLE_RE = /【([^】]{2,80})】/u;

function titleOf(text) {
  const hit = TITLE_RE.exec(String(text ?? ""));
  return hit ? hit[1].trim() : "";
}

/**
 * 她手边还有哪些视频可以看。
 *
 * 只看最近一段时间她发的消息，不取任何材料——这一步零成本，纯文本扫描。
 * 目的只是让伙伴知道「这个东西可以点开」，点不点是 ta 自己的事。
 *
 * @returns {Array<{bvid: string, page: number, title: string, at: string}>}
 */
export function listVideoShelf({
  messages,
  now = Date.now(),
  windowMs = 24 * 60 * 60_000,
  limit = 3,
} = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const cutoff = now - windowMs;
  const seen = new Set();
  const out = [];
  // 从新往旧找，同一个视频只列一次（她可能重复发同一条）。
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.role !== "user" || row.recalled) continue;
    if (Date.parse(String(row?.at ?? "")) < cutoff) continue;
    const link = extractVideoLink(row?.text);
    if (!link || link.kind === "unsupported") continue;
    // 只有短码时还不知道是哪个视频，等她给完整地址再看；列出来反而是噪音。
    if (link.kind !== "video") continue;
    const key = `${link.bvid}:${link.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      bvid: link.bvid,
      page: link.page,
      title: titleOf(row.text),
      at: String(row.at ?? ""),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 清单排成给伙伴看的一段。
 *
 * 措辞上刻意不写「你应该看看」：要不要看是 ta 自己的事，
 * 写得太像任务就成了另一种推送器。
 */
export function formatVideoShelf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const lines = [
    "【她最近发过来的视频】",
    "这些是她发给你的，你随时可以点开看；也可以不看、或者先放着，等真想知道里面讲了什么再翻出来。",
    "现场就想看也行，放两天再看也行，取决于你自己。",
  ];
  for (const row of list) {
    const page = Number(row.page) > 1 ? `（P${row.page}）` : "";
    const title = row.title || "（她没写标题，只有链接）";
    lines.push(`· ${title}${page} —— ${row.bvid}`);
  }
  lines.push(
    `想看哪条就调 ${READ_VIDEO_TOOL_NAME}，把 BV 号或她发的原文给它。`,
    // 防穿帮：标题之外的东西只有真调了才知道，这条跟主动分享那边是同一个约束。
    "标题之外的内容你不调就不知道。没调过就别接“里面那段太绝了”这种话，也不要描摹画面；实在接不上就说你还没看。",
  );
  return lines.join("\n");
}

/** 没读到视频时给伙伴的那句话：说人话，不解释内部步骤，也不怪网络。 */
export const VIDEO_TOOL_EMPTY_TEXT = "这条没读到内容。可以说你没看进去，或者直接问她里面讲了什么；别讲你这边怎么取的。";

/** 链接打不开、类型不支持时的话。 */
export const VIDEO_TOOL_UNSUPPORTED_TEXT = "这种链接（番剧、专栏、动态之类）打不开。老实说一句你打不开，别装看过。";
