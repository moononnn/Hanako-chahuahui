/** 视觉模型配置与发送门禁的纯逻辑。 */

function cleanText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizeVisionConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const model = raw.model && typeof raw.model === "object"
    ? { provider: cleanText(raw.model.provider), model: cleanText(raw.model.model ?? raw.model.id) }
    : null;
  const validModel = model?.provider && model?.model ? model : null;
  const status = ["unverified", "verified", "failed"].includes(raw.status) ? raw.status : "unverified";
  return {
    model: validModel,
    status: validModel ? status : "unverified",
    testedAt: validModel ? cleanText(raw.testedAt, 40) || null : null,
    error: validModel && status === "failed" ? cleanText(raw.error, 300) || null : null,
  };
}

export function effectiveVisionConfig(globalConfig, partnerConfig) {
  const partner = normalizeVisionConfig(partnerConfig);
  if (partner.model) return { ...partner, source: "partner" };
  const global = normalizeVisionConfig(globalConfig);
  return { ...global, source: "global" };
}

export function canUnderstandImages(globalConfig, partnerConfig) {
  const config = effectiveVisionConfig(globalConfig, partnerConfig);
  return Boolean(config.model && config.status === "verified");
}

export function isStrictBase64(value) {
  const raw = String(value ?? "");
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return false;
  try {
    return Buffer.from(raw, "base64").toString("base64") === raw;
  } catch {
    return false;
  }
}

export function imageBytesMatchMime(bytes, mimeType) {
  if (!bytes || bytes.length < 12) return false;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/**
 * 识图失败时把原因分个类。
 *
 * 配额/限流是「等一会儿就好」，网络抖一下不是同一回事，
 * 提示她的话得分开说——笼统一句「模型不可用」等于什么都没说。
 */
export function classifyVisionFailure(error) {
  const raw = [
    error?.message,
    error?.code,
    error?.status,
    error?.statusCode,
    typeof error === "string" ? error : "",
  ].filter(Boolean).join(" ");
  if (/limit|quota|rate.?limit|429|usage|insufficient|credit|配额|限额|上限|超出|too many/i.test(raw)) return "quota";
  if (/fetch failed|econnreset|etimedout|enotfound|eai_again|timeout|timed out|socket hang|网络|network|offline|disconnect/i.test(raw)) return "network";
  return "unknown";
}

/**
 * 那条提示气泡的文案。
 *
 * 站在伙伴这边说的话：ta 自己也不知道是配额还是网络，只知道这会儿接不上话。
 * 消息已经存下来了这句必须留着——不然她会以为又要重发一遍。
 */
export function visionUnavailableNotice(kind, partnerName = "") {
  const who = String(partnerName ?? "").trim() || "ta";
  if (kind === "quota") return `${who}这会儿接不上话了：识图那边的额度用完了。发出去的已经存下来，没丢——等额度回来再发一次，ta 就能接上。`;
  if (kind === "network") return `${who}这会儿接不上话了：刚才那条连接没连上。发出去的已经存下来，没丢——晚点再发一次，ta 就能接上。`;
  // 说不出具体原因时别装知道，但也得给她一个能对号的猜测方向：
  // 那种“模型 provider 没能完成请求”的笼统报错，九成是模型这会儿用不上。
  return `${who}这会儿没能看清你发的图，话也就没接上——多半是模型或网络那边这会儿用不了。这条已经存下来了，晚点再发一次 ta 就能接上。`;
}

/**
 * ta 这会儿接不上话时，那条提示该说什么。
 *
 * 不拿别的模型的话冒充 ta 开口——所以这条是这边的情况说明，不是 ta 说的话，
 * 语气也不会因为换个模型就变。关键是得说清三件事：ta 说不出、发出去的在、等会儿会自己接。
 */
export function partnerOfflineNotice(kind, partnerName = "", { random = Math.random } = {}) {
  const who = String(partnerName ?? "").trim() || "ta";
  const pools = {
    quota: [
      `${who}这会儿也说不出话：模型那边的额度用完了。发出去的已经存着，${who}缓过来会自己来接上，不用重发。`,
      `${who}这会儿张嘴说不了——额度用完了。你这条${who}记着呢，等${who}能说话了自然会接。`,
    ],
    provider: [
      `${who}这会儿也说不出话：模型那边用不了。发出去的已经存着，${who}缓过来会自己来接上。`,
      `${who}这会儿发不出声，不是${who}不想理你。等模型那边缓过来，${who}自己来接。`,
    ],
    transient: [
      `${who}这会儿接不上话，模型那边没能应过来。发出去的已经存着，晚点${who}再接。`,
    ],
  };
  const pool = pools[kind] ?? pools.transient;
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length))];
}

/**
 * 首选识图模型挂了以后，要不要去动备用通道。
 *
 * 只有“真挂”才动：配额用完、凭据出事——这类不会自己好，备用通道该顶上就顶上。
 * 超时、断网这类首选模型多半还在等，换个视觉反而让 ta 在两双眼睛之间飘。
 */
export function shouldTryVisionFallback(kind) {
  return kind === "quota" || kind === "provider";
}

export function modelSupportsImage(row) {
  if (!row || typeof row !== "object") return false;
  if (row.image === true || row.supportsImage === true) return true;
  if (row.visionCapabilities && typeof row.visionCapabilities === "object") return true;
  const input = row.input ?? row.inputModalities ?? row.modalities;
  return Array.isArray(input) && input.some((item) => String(item).toLowerCase() === "image");
}
