/**
 * 她递过来的视频。
 *
 * 跟 video-sharing.js 是相反方向：那条是伙伴自己刷到、自己决定要不要分享；
 * 这条是她发了个链接过来，伙伴手上被塞了一个要花点时间才看得完的东西。
 *
 * 硬边界沿用 video-source.js：全程只读 GET，不评论、不点赞、不投币、不收藏。
 *
 * 这一层只做三件事：
 *   1. 从聊天文本里认出 B 站链接（含 b23.tv 短链）
 *   2. 把链接换成 BV 号与分P
 *   3. 把材料取齐（不做「要不要分享」的判断，那是给主动分享那条路用的）
 *
 * 不负责：画面（走 video-understanding.js）、提示词拼装（走 video-materials.js）、
 * 要不要看（那由伙伴自己决定，见 index.js 的接线）。
 */

import { collectVideoMaterials, isAllowedVideoUrl, videoGet } from "./video-source.js";
import { READ_KINDS } from "./video-materials.js";
import { isSpeechMessage } from "./turn-window.js";

/** BV 号固定十位，大小写字母数字都有。 */
const BV_RE = /BV([0-9A-Za-z]{10})/u;
/** b23.tv 短码：App 分享出来的那种，不一定长得像 BV 号。 */
const SHORT_RE = /(?:https?:\/\/)?b23\.tv\/([0-9A-Za-z]{4,20})/iu;
/** 分P。只认 `p=`，不认别的参数。 */
const PAGE_RE = /[?&]p=(\d+)/u;
/** 番剧、专栏、动态：现有接口不支持，认出来是为了能老实说一句，而不是装看不见。 */
const UNSUPPORTED_RE = /bilibili\.com\/(?:bangumi\/play|read\/cv|dynamic\/|opus\/)/iu;

/** 用户发的视频不给 15 分钟硬闸，但也不是无底洞：一小时以上连字幕都不取。 */
export const INBOUND_MAX_SECONDS = 60 * 60;

/**
 * 从一段聊天文本里认出视频链接。
 *
 * 返回三种形状：
 *   { kind: "video", bvid, page }      —— 直接有 BV 号，不用再发请求
 *   { kind: "short", code }            —— 只有短码，得解析一次
 *   { kind: "unsupported", reason }    —— 认得出是 B 站，但这条路打不开
 *   null                               —— 压根不是 B 站链接
 *
 * 零宽字符会混进复制粘贴的链接里，把 BV 号拆成两截。先清掉再认。
 */
export function extractVideoLink(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return null;
  const text1 = raw.replace(/[\u200b-\u200d\ufeff]/gu, "").replace(/&amp;/giu, "&");

  if (UNSUPPORTED_RE.test(text1)) {
    const what = /bangumi/iu.test(text1) ? "番剧" : /(?:read\/cv|opus\/|dynamic\/)/iu.test(text1) ? "专栏或动态" : "这种页面";
    // 番剧里也可能夹着正片 BV 号，能认到就先给 BV；认不到才算不支持。
    const bvInBangumi = BV_RE.exec(text1);
    if (!bvInBangumi) return { kind: "unsupported", reason: `${what}这条路打不开` };
  }

  const bv = BV_RE.exec(text1);
  if (bv) {
    // 文本里根本没提 B 站，却把 BV 号包在别家的地址里（example.com/video/BV…），
    // 那不是分享视频，只是串巧一样的字串。裸的 BV 号（「看这个 BV1…」）照认。
    const before = text1.slice(0, bv.index);
    const insideForeignUrl = !/(?:bilibili\.com|b23\.tv)/iu.test(text1)
      && /https?:\/\/\S*$/u.test(before);
    if (!insideForeignUrl) {
      const page = Number(PAGE_RE.exec(text1)?.[1] ?? 1);
      return {
        kind: "video",
        bvid: `BV${bv[1]}`,
        page: Number.isInteger(page) && page > 0 ? page : 1,
      };
    }
  }

  const short = SHORT_RE.exec(text1);
  if (short && !/^BV/iu.test(short[1])) {
    return { kind: "short", code: short[1] };
  }
  return null;
}

/**
 * 短码换成 BV 号：发一次请求，只看落到哪儿，不读正文。
 *
 * b23.tv 会 302 到 www.bilibili.com/video/BV…，落地地址在 response.url 上。
 * 落地域由 videoGet 复查（沿用现有那套白名单校验），这里只负责把 BV 抠出来。
 * 拿不到就是拿不到，不猜、不拼。
 */
export async function resolveShortLink(fetcher, code) {
  const target = String(code ?? "").trim();
  if (!/^[0-9A-Za-z]{4,20}$/u.test(target)) return { ok: false, reason: "短码形状不对" };
  const res = await videoGet(fetcher, `https://b23.tv/${target}`, { maxResponseBytes: 2097152 });
  if (!res.ok) return { ok: false, reason: res.reason };
  const landed = String(res.response?.url ?? "");
  const bv = BV_RE.exec(landed);
  if (!bv) return { ok: false, reason: "跳转后没看到 BV 号" };
  const page = Number(PAGE_RE.exec(landed)?.[1] ?? 1);
  return {
    ok: true,
    bvid: `BV${bv[1]}`,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/**
 * 从最近几条聊天里挑出「这一轮该不该去看视频」的那一段源文本。
 *
 * 抽成纯函数的原因（2026-10-23 实机踩了两次）：
 *  1. 她常先甩链接、再补一句「你看看」。后一句进来，上一轮正在生成的回复被作废，
 *     链接那一轮取到的材料就白取了，所以得往回翻。
 *  2. 但茶话会每轮回复都绑一个回复目标（replyTargetId）。旧写法只要它非空就直接
 *     拿目标那句当源，而目标通常是「你看看」这种不带链接的补话——往回翻那条路
 *     从来没走到过。现在目标那句带链接才用它，不带就继续往回找。
 *
 * @returns {string|undefined} 当作视频源的文本；没有就退回本轮最后一句
 */
export function pickInboundSource({
  messages,
  replyTargetId = null,
  latestText,
  now = Date.now(),
  windowMs = 10 * 60_000,
  scanBack = 3,
} = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const hasLink = (text) => /(?:bilibili\.com|b23\.tv)/iu.test(String(text ?? ""));

  if (replyTargetId) {
    const target = rows.find((row) => row?.id === replyTargetId);
    if (target && hasLink(target.text)) return target.text;
  }

  // 只看最近一小段时间：不然昨天发过的链接会跟着一直触发。
  const cutoff = now - windowMs;
  const recent = rows
    .filter((row) => row?.role === "user" && !row.recalled && isSpeechMessage(row)
      && Date.parse(String(row?.at ?? "")) > cutoff)
    .slice(-scanBack)
    .reverse();
  const withLink = recent.find((row) => hasLink(row.text));
  return withLink?.text ?? latestText;
}

/**
 * 认链接 → 换 BV → 取材料，一条龙。
 *
 * 网络失败、视频没了、超长，全都返回 ok:false 并带上原因；
 * 调用方一律降级成「这轮没有材料」，绝不能因为一个坏链接把整条回复拖垮。
 */
export async function collectInboundVideo(fetcher, text, {
  cookie = "",
  maxSeconds = INBOUND_MAX_SECONDS,
} = {}) {
  const parsed = extractVideoLink(text);
  if (!parsed) return { ok: false, reason: "没有 B 站链接" };
  if (parsed.kind === "unsupported") return { ok: false, reason: parsed.reason, unsupported: true };

  let bvid = parsed.bvid;
  let page = parsed.page ?? 1;
  if (parsed.kind === "short") {
    // b23.tv 是新域名，宿主要单独审阅才能用。没开的时候这里如实报一句，
    // 不要发出一个注定被拒的请求，也不要装没看见。
    if (!isAllowedVideoUrl(`https://b23.tv/${parsed.code}`).ok) {
      return { ok: false, reason: "短链还打不开，你把视频页那个完整地址发我", shortLinkDisabled: true };
    }
    const resolved = await resolveShortLink(fetcher, parsed.code);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    bvid = resolved.bvid;
    page = resolved.page;
  }

  const materials = await collectVideoMaterials(fetcher, bvid, { cookie, page, requireSubtitle: false, maxSeconds });
  if (materials.ok) return { ok: true, materials, requestedPage: page };

  // 取不到材料，但知道是哪个视频：退回标题档。
  // 这个方向不能因为她发的东西太长就直接当没看见——她等着被回应。
  // 标题档只能讲标题，不能讲内容；那档的纪律在 packMaterials 里已经是齐的。
  if (materials.video) {
    return {
      ok: true,
      requestedPage: page,
      materials: {
        ok: false,
        reason: materials.reason ?? "",
        video: materials.video,
        readKind: READ_KINDS.TITLE_ONLY,
        shareable: false,
        subtitle: [],
        subtitleReason: materials.reason ?? "",
        danmakuHot: [],
        danmakuCount: 0,
        replies: [],
      },
    };
  }
  return { ok: false, reason: materials.reason ?? "材料没取到" };
}
