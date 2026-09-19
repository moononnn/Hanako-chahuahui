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

export function modelSupportsImage(row) {
  if (!row || typeof row !== "object") return false;
  if (row.image === true || row.supportsImage === true) return true;
  if (row.visionCapabilities && typeof row.visionCapabilities === "object") return true;
  const input = row.input ?? row.inputModalities ?? row.modalities;
  return Array.isArray(input) && input.some((item) => String(item).toLowerCase() === "image");
}
