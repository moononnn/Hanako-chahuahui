/**
 * 生图走宿主，不自己接 API。
 *
 * 宿主手里已经有她登录的账号（OpenAI Codex OAuth、各家 key 都在宿主设置里），
 * 图片生成、模型目录、产出文件登记都由宿主办。茶话会只做三件事：
 * 提交、等它跑完、把字节取回来。
 *
 * 这样做的直接好处是：她不用为茶话会再买一份 API 额度，用的就是 Hana 里
 * 已经登录好的那套。代价是这扇门要 `app/media.generate`，默认关着，
 * 得她自己去「应用能力」里给茶话会开。
 */

/** 宿主给媒体调用的预算是十分钟；这里留五分钟，超过就当作没成。 */
export const HOST_IMAGE_TIMEOUT_MS = 300_000;

/** 轮询间隔。生图通常十几秒到一分钟，1.5 秒一次不至于把宿主问烦。 */
const POLL_INTERVAL_MS = 1500;

/** 宿主能识别的比例。传一个它不认的值会被 adapter 拒。 */
export const HOST_IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

export const HOST_IMAGE_QUALITIES = ["low", "medium", "high", "auto"];

function isBusy(status) {
  const text = String(status ?? "").toLowerCase();
  if (!text) return true;
  return !["completed", "complete", "done", "ready", "success", "succeeded", "finished", "failed", "error", "cancelled", "canceled"].includes(text);
}

function isFailed(status, failReason) {
  const text = String(status ?? "").toLowerCase();
  if (["failed", "error", "cancelled", "canceled"].includes(text)) return true;
  return Boolean(failReason) && ["completed", "done", "ready"].includes(text) === false && !isBusy(status);
}

/**
 * 当前可用的生图提供方。
 *
 * `selection.defaultConfigured` 决定要不要让用户挑：已配置默认时，正常生成
 * 就该整条省略 provider/model，跟着宿主设置走。
 */
export async function listHostImageProviders(ctx) {
  if (!ctx?.bus?.request) throw new Error("Hana 尚未提供总线接口");
  const result = await ctx.bus.request("provider:media-providers", { capability: "image_generation" });
  return result ?? { providers: {}, selection: null };
}

/**
 * 提交一次生图。
 *
 * App 范围必须用 response 投递（宿主会直接拒绝别种），产出不落任何会话，
 * 跑完由调用方经 ctx.media 取回。
 */
export async function submitHostImage(ctx, { prompt, referencePaths = [], ratio, quality, provider, model } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("提示词是空的");
  if (!ctx?.bus?.request) throw new Error("Hana 尚未提供总线接口");
  const input = { prompt: text.slice(0, 32000), count: 1 };
  if (Array.isArray(referencePaths) && referencePaths.length) {
    // 参考图必须落在茶话会自己的 data 目录里，宿主会 realpath 后再核一次。
    input.referenceImages = referencePaths.map((path) => ({ kind: "local-file", path }));
    // 有参考图时明确说这是「改这张」，不交给 adapter 猜。
    input.imageIntent = "edit";
  }
  if (ratio) input.ratio = HOST_IMAGE_RATIOS.includes(ratio) ? ratio : "1:1";
  if (quality) input.quality = HOST_IMAGE_QUALITIES.includes(quality) ? quality : "auto";
  if (provider) input.provider = String(provider);
  if (model) input.model = String(model);

  const result = await ctx.bus.request(
    "media:generate-image",
    { scope: "app", input, delivery: { mode: "response" } },
    { timeout: HOST_IMAGE_TIMEOUT_MS },
  );
  const task = result?.tasks?.[0] ?? null;
  const taskId = String(task?.taskId ?? "").trim();
  if (!taskId) {
    const reason = result?.error || result?.message || "宿主没有回任务号";
    throw new Error(`生图没有排上：${String(reason).slice(0, 200)}`);
  }
  return { taskId, batchId: result?.batchId ?? null, provider: task?.providerId ?? null, model: task?.modelId ?? null };
}

/** 等一个任务跑完。返回任务本身，失败也在里面，由调用方决定怎么说。 */
export async function waitForHostImage(ctx, taskId, { timeoutMs = HOST_IMAGE_TIMEOUT_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!ctx?.media?.getTask) throw new Error("Hana 尚未提供媒体任务接口");
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = await ctx.media.getTask(taskId, { scope: "own" });
    if (!last) return null;
    if (!isBusy(last.status)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  return last;
}

/**
 * 把任务产出的图读成字节。
 *
 * 只取图片类型的文件：一个任务可能有多个产出，交给调用方的是第一张，
 * 其余的数量要在结果里如实报出来。
 */
export async function readHostImageBytes(ctx, taskId) {
  if (!ctx?.media?.getTaskResources) throw new Error("Hana 尚未提供媒体任务接口");
  const { resources } = await ctx.media.getTaskResources(taskId, { scope: "own" });
  const rows = Array.isArray(resources) ? resources : [];
  if (!rows.length) throw new Error("任务跑完了，但没有产出文件");
  const first = rows[0].resource;
  const raw = await ctx.resources.read(first, { encoding: "base64" });
  return { bytes: toBytes(raw), resource: first, count: rows.length };
}

/** 资源通道回来的形状不止一种，照单收（与头像那条同一套）。 */
function toBytes(result) {
  const raw = result?.content ?? result?.data ?? result?.body ?? result;
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const buf = Buffer.from(trimmed, "base64");
    return buf.length > 0 ? buf : null;
  }
  return null;
}

/** 提交 → 等 → 取图，一步到位。失败时把任务自己的 failReason 带出来。 */
export async function generateViaHost(ctx, options = {}) {
  const submitted = await submitHostImage(ctx, options);
  const task = await waitForHostImage(ctx, submitted.taskId, {
    timeoutMs: options.timeoutMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  if (!task) throw new Error("任务查不到了，可能已经被清掉");
  if (isFailed(task.status, task.failReason)) {
    throw Object.assign(new Error(String(task.failReason || `生图失败（${task.status}）`).slice(0, 240)), { imageOutcome: "failed" });
  }
  if (isBusy(task.status)) throw new Error("生图还在跑，超过等待上限也没回来");
  let bytes, count;
  try { ({ bytes, count } = await readHostImageBytes(ctx, submitted.taskId)); }
  catch (error) { error.imageOutcome = "success"; throw error; }
  if (!bytes) throw Object.assign(new Error("产出文件读不出来"), { imageOutcome: "success" });
  return { ...submitted, bytes, count, task };
}

/** 从 bytes 认格式，交给上层写附件时用。 */
export function mimeOfImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return "image/png";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/png";
}
