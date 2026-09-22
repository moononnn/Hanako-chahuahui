import { unprotectKey } from "./crypto.js";
import { resolveRelationalPolicy } from "./plasticity.js";

/**
 * 茶话会自己的伙伴语音：音色、低频触发和 TTS 合成都收在这里。
 * 不依赖解语花；只借鉴它已经验证过的供应商协议和音频处理方式。
 */

/** 未知 OpenAI 兼容语音模型的保守候选；已知模型会走自己的目录。 */
export const VOICE_CHOICES = [
  { id: "female-shaonv", name: "少女（清亮温柔）" },
  { id: "female-yujie", name: "御姐（成熟优雅）" },
  { id: "female-tianmei", name: "甜美女性（甜软）" },
  { id: "male-qn-qingse", name: "青涩青年（少年感）" },
  { id: "male-qn-jingying", name: "清爽青年" },
  { id: "mimo_default", name: "默认音色（MiMo）" },
];

/** MiniMax Speech 2.8/2.6 使用官方 system voice_id，旧 female-shaonv 不在这份目录里。 */
export const MINIMAX_VOICE_CHOICES = [
  ["Chinese (Mandarin)_Reliable_Executive", "可靠高管"],
  ["Chinese (Mandarin)_News_Anchor", "新闻主播"],
  ["Chinese (Mandarin)_Unrestrained_Young_Man", "洒脱青年"],
  ["Chinese (Mandarin)_Mature_Woman", "成熟女性"],
  ["Arrogant_Miss", "傲娇小姐"],
  ["Chinese (Mandarin)_Kind-hearted_Antie", "和善阿姨"],
  ["Chinese (Mandarin)_HK_Flight_Attendant", "港式乘务员"],
  ["Chinese (Mandarin)_Humorous_Elder", "幽默长辈"],
  ["Chinese (Mandarin)_Gentleman", "绅士男声"],
  ["Chinese (Mandarin)_Warm_Bestie", "温暖闺蜜"],
  ["Chinese (Mandarin)_Stubborn_Friend", "倔强朋友"],
  ["Chinese (Mandarin)_Sweet_Lady", "甜美女声"],
  ["Chinese (Mandarin)_Southern_Young_Man", "南方青年"],
  ["Chinese (Mandarin)_Wise_Women", "睿智女性"],
  ["Chinese (Mandarin)_Gentle_Youth", "温柔少年"],
  ["Chinese (Mandarin)_Warm_Girl", "温暖少女"],
  ["Chinese (Mandarin)_Male_Announcer", "男声播报"],
  ["Chinese (Mandarin)_Kind-hearted_Elder", "和善长者"],
  ["Chinese (Mandarin)_Cute_Spirit", "可爱精灵"],
  ["Chinese (Mandarin)_Radio_Host", "电台主持"],
  ["Chinese (Mandarin)_Lyrical_Voice", "抒情声线"],
  ["Chinese (Mandarin)_Straightforward_Boy", "直率男孩"],
  ["Chinese (Mandarin)_Sincere_Adult", "真诚青年"],
  ["Chinese (Mandarin)_Gentle_Senior", "温柔学姐"],
  ["Chinese (Mandarin)_Crisp_Girl", "清脆少女"],
  ["Chinese (Mandarin)_Pure-hearted_Boy", "纯真男孩"],
  ["Chinese (Mandarin)_Soft_Girl", "柔和少女"],
  ["Chinese (Mandarin)_IntellectualGirl", "知性少女"],
  ["Chinese (Mandarin)_Warm_HeartedGirl", "暖心少女"],
  ["Chinese (Mandarin)_Laid_BackGirl", "松弛少女"],
  ["Chinese (Mandarin)_ExplorativeGirl", "探索少女"],
  ["Chinese (Mandarin)_Warm-HeartedAunt", "暖心阿姨"],
  ["Chinese (Mandarin)_BashfulGirl", "羞涩少女"],
].map(([id, name]) => ({ id, name }));

const MIMO_VOICE_CHOICES = [
  ["mimo_default", "默认音色"],
  ["冰糖", "冰糖"],
  ["茉莉", "茉莉"],
  ["苏打", "苏打"],
  ["白桦", "白桦"],
  ["Mia", "Mia"],
  ["Chloe", "Chloe"],
  ["Milo", "Milo"],
  ["Dean", "Dean"],
].map(([id, name]) => ({ id, name }));

export function voiceChoicesForModel(config = {}) {
  const protocol = config.protocol === "t2a" ? "t2a" : "chat";
  const provider = String(config.providerId ?? config.provider ?? "").toLowerCase();
  const model = String(config.model ?? "").toLowerCase();
  if (protocol === "t2a" || /speech[-_ ]?(02|2\.6|2\.8)/i.test(model)) {
    return MINIMAX_VOICE_CHOICES;
  }
  if (provider === "mimo" || model.includes("mimo")) return MIMO_VOICE_CHOICES;
  return VOICE_CHOICES;
}

export function defaultVoiceIdForModel(config = {}) {
  return voiceChoicesForModel(config)[0]?.id || "female-shaonv";
}

export const VOICE_TIERS = [
  ["rare", "少量"],
  ["sometimes", "偶尔"],
  ["often", "较常"],
];

const TIER_POLICY = {
  rare: { chance: 0.08, maxPerDay: 1, cooldownMinutes: 180 },
  sometimes: { chance: 0.16, maxPerDay: 2, cooldownMinutes: 90 },
  often: { chance: 0.28, maxPerDay: 3, cooldownMinutes: 45 },
};

export const VOICE_HARD_MAX = 6;

const VOICE_PREFERENCE_POLICY = Object.freeze({
  more: { chanceFactor: 1.45, normalMaxDelta: 0, exceptionExtraMax: 1, cooldownFactor: 0.55 },
  baseline: { chanceFactor: 1, normalMaxDelta: 0, exceptionExtraMax: 0, cooldownFactor: 1 },
  less: { chanceFactor: 0.55, normalMaxDelta: -1, exceptionExtraMax: 0, cooldownFactor: 1.5 },
});

export function resolveVoicePolicy({ tier = "sometimes", relationship = null, personality = null, guides = [], context = {}, runtime = {}, random = Math.random } = {}) {
  const base = policyFor(tier);
  const resolved = resolveRelationalPolicy({
    capability: "voice",
    baseline: { tier, maxPerDay: base.maxPerDay, cooldownMinutes: base.cooldownMinutes },
    guides,
    relationship,
    personality,
    context,
    runtime,
    adapter: {
      baseExceptionChance: 0.18,
      maxExceptionChance: 0.42,
      plasticity: 0.8,
      applyPreference(effective, direction) {
        effective.direction = direction;
        return effective;
      },
      personalityFactor(value) {
        const tags = JSON.stringify(value ?? "");
        if (/外放|热情|黏|爱表达/u.test(tags)) return 1.15;
        if (/克制|安静|慢热|省电/u.test(tags)) return 0.7;
        return 1;
      },
    },
    random: () => 0,
  });
  const direction = Number(resolved.effective?.direction ?? 0);
  const exceptionBlocked = Array.isArray(runtime.negativeFeedbackBehaviors) && runtime.negativeFeedbackBehaviors.includes("voice.frequency");
  const adjustment = direction > 0 ? VOICE_PREFERENCE_POLICY.more
    : direction < 0 ? VOICE_PREFERENCE_POLICY.less
      : VOICE_PREFERENCE_POLICY.baseline;
  const hardBlocked = resolved.allowed === false;
  const habitState = runtime.habitStates?.["voice.frequency"];
  const habitChanceFactor = habitState === "settled" ? 1.25 : habitState === "emerging" ? 1.1 : 1;
  const habitMaxDelta = habitState === "settled" ? 1 : 0;
  const normalMax = Math.max(0, base.maxPerDay + adjustment.normalMaxDelta + habitMaxDelta);
  const normalCooldownMinutes = Math.max(15, Math.round(base.cooldownMinutes * adjustment.cooldownFactor));
  return {
    ...resolved,
    tier,
    normalChance: Math.min(1, base.chance * adjustment.chanceFactor * habitChanceFactor),
    normalMax,
    normalCooldownMinutes,
    exceptionChance: hardBlocked || direction <= 0 || exceptionBlocked ? 0 : resolved.exceptionChance,
    exceptionExtraMax: hardBlocked || exceptionBlocked ? 0 : adjustment.exceptionExtraMax,
    exceptionCooldownFloor: direction > 0
      ? Math.max(15, Math.round(base.cooldownMinutes * adjustment.cooldownFactor))
      : normalCooldownMinutes,
    hardMax: VOICE_HARD_MAX,
    hardCooldownFloor: 15,
    hardBlocked,
    random,
  };
}

export const DEFAULT_VOICE_SETTINGS = {
  enabled: false,
  voiceId: "female-shaonv",
  tier: "sometimes",
};

export const DEFAULT_VOICE_MODEL_CONFIG = {
  providerId: "",
  model: "",
  protocol: "chat",
  baseUrl: "",
  groupId: "",
  apiKey: "",
};

/**
 * 新建朗读模型时可以套的开箱模板，只负责把协议和默认地址填好；
 * 保存之后就是一条普通的自定义模型，能改也能删。
 */
export const VOICE_PRESETS = [
  { id: "minimax", label: "MiniMax", protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd" },
  { id: "mimo", label: "MiMo", protocol: "chat", providerId: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts" },
  { id: "openai", label: "OpenAI 兼容", protocol: "chat", providerId: "", baseUrl: "", model: "" },
];

/** 朗读模型条目统一用 custom- 前缀；其余 id 一律不认。 */
const PROFILE_ID_RE = /^custom-[A-Za-z0-9_-]{1,80}$/;
/** 旧版把 MiniMax / MiMo / 自定义存成固定档位，迁移成普通条目。 */
const LEGACY_PROFILE_IDS = { minimax: "custom-minimax", mimo: "custom-mimo", custom: "custom-legacy" };

function presetById(id) {
  return VOICE_PRESETS.find((item) => item.id === id) || null;
}

/**
 * 只认 custom- 前缀的多条自定义模型。
 * 旧版的固定档位（minimax / mimo / custom）带着 Key 的迁成普通条目，空壳直接丢；
 * 旧版从 Hana 目录拉出来的 hana-* 条目在分享版里没有可用的地址，一并丢掉。
 */
export function normalizeVoiceProfiles(value, legacy = null) {
  // 存过一次就是这套结构自己说了算；键在但里面空了（她删光了），也不拿旧配置把条目复活。
  const hasStored = Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const raw = hasStored ? value : {};
  const profiles = {};
  for (const [id, item] of Object.entries(raw)) {
    if (!PROFILE_ID_RE.test(id) || !item || typeof item !== "object") continue;
    const label = String(item.label || item.name || "自定义模型").trim().slice(0, 80) || "自定义模型";
    profiles[id] = { label, config: normalizeVoiceModelConfig(item.config) };
  }
  for (const [oldId, nextId] of Object.entries(LEGACY_PROFILE_IDS)) {
    if (profiles[nextId]) continue;
    const item = raw[oldId];
    if (!item || typeof item !== "object") continue;
    const stored = normalizeVoiceModelConfig(item.config);
    if (!stored.apiKey) continue;
    const preset = presetById(oldId) || {};
    profiles[nextId] = {
      label: String(item.label || preset.label || "自定义模型").trim().slice(0, 80) || "自定义模型",
      config: normalizeVoiceModelConfig({
        protocol: stored.protocol,
        providerId: stored.providerId || preset.providerId || "",
        model: stored.model || preset.model || "",
        baseUrl: stored.baseUrl || preset.baseUrl || "",
        groupId: stored.groupId,
        apiKey: stored.apiKey,
      }),
    };
  }
  // 更早的版本只有一条全局朗读配置；从来没存过多条结构时才拿它救一次，救完就走自己的路。
  if (!hasStored && !Object.keys(profiles).length) {
    const stored = normalizeVoiceModelConfig(legacy);
    if (stored.apiKey) {
      const preset = stored.protocol === "t2a" ? presetById("minimax") : presetById("mimo");
      profiles["custom-legacy"] = {
        label: "旧朗读配置",
        config: normalizeVoiceModelConfig({
          protocol: stored.protocol,
          providerId: stored.providerId || preset?.providerId || "",
          model: stored.model || preset?.model || "",
          baseUrl: stored.baseUrl || preset?.baseUrl || "",
          groupId: stored.groupId,
          apiKey: stored.apiKey,
        }),
      };
    }
  }
  return profiles;
}

export function activeVoiceProfileId(settings = {}) {
  const profiles = normalizeVoiceProfiles(settings.voiceProfiles, settings.voiceModel);
  const wanted = String(settings.voiceProfile ?? "");
  const migrated = LEGACY_PROFILE_IDS[wanted] || wanted;
  if (migrated && Object.prototype.hasOwnProperty.call(profiles, migrated)) return migrated;
  return Object.keys(profiles)[0] || "";
}

/** 旧固定档位 id 迁移后的条目 id；不是旧档位就给空串。 */
export function migratedVoiceProfileId(profileId) {
  return LEGACY_PROFILE_IDS[String(profileId ?? "")] || "";
}

export function activeVoiceModel(settings = {}) {
  const profiles = normalizeVoiceProfiles(settings.voiceProfiles, settings.voiceModel);
  return profiles[activeVoiceProfileId(settings)]?.config || normalizeVoiceModelConfig(null);
}

export function normalizeVoiceModelConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    providerId: String(raw.providerId ?? "").trim().slice(0, 120),
    model: String(raw.model ?? "").trim().slice(0, 200),
    protocol: raw.protocol === "t2a" ? "t2a" : "chat",
    baseUrl: String(raw.baseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 500),
    groupId: String(raw.groupId ?? "").trim().slice(0, 160),
    apiKey: String(raw.apiKey ?? ""),
  };
}

/** 页面新建条目用的 id：稳定前缀加时间戳，够用且不会撞车。 */
export function nextVoiceProfileId(now = Date.now(), random = Math.random) {
  return `custom-${now.toString(36)}-${Math.floor(random() * 1e6).toString(36)}`;
}

const MAX_VOICE_CHARS = 180;
const MIN_VOICE_CHARS = 8;

export function normalizeVoiceSettings(value, fallback = DEFAULT_VOICE_SETTINGS) {
  const raw = value && typeof value === "object" ? value : {};
  const voiceId = String(raw.voiceId ?? fallback.voiceId ?? "female-shaonv").trim();
  const tier = Object.prototype.hasOwnProperty.call(TIER_POLICY, raw.tier) ? raw.tier : (fallback.tier ?? "sometimes");
  return {
    enabled: raw.enabled === true,
    voiceId: voiceId || "female-shaonv",
    tier,
  };
}

export function cleanVoiceText(text) {
  let value = String(text ?? "");
  value = value.replace(/\u0001stk:[^\n]+/g, " ");
  value = value.replace(/\[表情:[^\]]+\]/g, " ");
  value = value.replace(/```[\s\S]*?```/g, " ");
  value = value.replace(/`([^`\n]+)`/g, "$1");
  value = value.replace(/\*([^*\n]+)\*/g, " ");
  value = value.replace(/_([^_\n]+)_/g, " ");
  value = value.replace(/^\s*[-*+]+\s+/gm, "");
  value = value.replace(/\r\n?/g, "\n");
  value = value.replace(/[ \t]+/g, " ");
  value = value.replace(/\n\s*\n+/g, "\n");
  return value.split("\n").map((line) => line.trim()).filter(Boolean).join("\n").trim();
}

function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function policyFor(tier) {
  return TIER_POLICY[tier] ?? TIER_POLICY.sometimes;
}

/**
 * 只做低成本、可解释的闸门；随机数由调用方注入，方便测试。
 * 语音是整轮二选一，过长回复直接保留文字，不机械切成多条语音。
 */
export function shouldGenerateVoice({ globalSettings, partnerSettings, runtime = {}, text, now = new Date(), random = Math.random, voicePolicy = null } = {}) {
  const global = globalSettings && typeof globalSettings === "object" ? globalSettings : {};
  const partner = normalizeVoiceSettings(partnerSettings);
  const value = cleanVoiceText(text);
  if (global.voiceEnabled !== true) return { ok: false, reason: "global-disabled" };
  if (!partner.enabled) return { ok: false, reason: "partner-disabled" };
  if (value.length < MIN_VOICE_CHARS) return { ok: false, reason: "too-short" };
  if (value.length > MAX_VOICE_CHARS) return { ok: false, reason: "too-long" };
  const sentenceCount = (value.match(/[。！？!?；;\n]/g) || []).length;
  if (sentenceCount > 3) return { ok: false, reason: "too-many-sentences" };

  const policy = policyFor(partner.tier);
  const today = dayKey(now);
  const sentToday = runtime.voiceDay === today ? Number(runtime.voiceSentToday ?? 0) : 0;
  if (voicePolicy?.allowed === false || voicePolicy?.hardBlocked) return { ok: false, reason: "policy-denied", layer: "hard" };
  const normalMax = Number(voicePolicy?.normalMax ?? policy.maxPerDay);
  const exceptionExtraMax = Number(voicePolicy?.exceptionExtraMax ?? 0);
  const hardMax = Number(voicePolicy?.hardMax ?? Math.max(normalMax, VOICE_HARD_MAX));
  if (sentToday >= Math.min(hardMax, normalMax + exceptionExtraMax)) return { ok: false, reason: "daily-limit" };
  const roll = typeof random === "function" ? random() : 1;
  const exception = Boolean(voicePolicy) && sentToday >= normalMax;
  const exceptionAllowed = exception && roll < Number(voicePolicy.exceptionChance ?? 0);
  const normalAllowed = !exception && roll < Number(voicePolicy?.normalChance ?? policy.chance);
  if (voicePolicy && !normalAllowed && !exceptionAllowed) return { ok: false, reason: "chance" };
  if (!voicePolicy && roll >= policy.chance) return { ok: false, reason: "chance" };
  const cooldownMinutes = exceptionAllowed
    ? Number(voicePolicy.exceptionCooldownFloor ?? policy.cooldownMinutes)
    : Number(voicePolicy?.normalCooldownMinutes ?? policy.cooldownMinutes);
  const lastAt = Date.parse(String(runtime.lastVoiceAt ?? ""));
  if (Number.isFinite(lastAt) && now.getTime() - lastAt < cooldownMinutes * 60_000) {
    return { ok: false, reason: "cooldown" };
  }
  if (Number(runtime.consecutiveVoiceReplies ?? 0) >= 1) return { ok: false, reason: "consecutive" };
  return {
    ok: true,
    text: value,
    voiceId: partner.voiceId,
    tier: partner.tier,
    layer: exceptionAllowed ? "exception" : "normal",
    day: today,
  };
}

export function nextVoiceRuntime(runtime = {}, decision, at = new Date()) {
  const day = dayKey(at);
  const sentToday = runtime.voiceDay === day ? Number(runtime.voiceSentToday ?? 0) : 0;
  return {
    ...runtime,
    voiceDay: day,
    voiceSentToday: sentToday + 1,
    lastVoiceAt: at.toISOString(),
    consecutiveVoiceReplies: Number(runtime.consecutiveVoiceReplies ?? 0) + 1,
    voicePending: decision?.voiceId ? true : Boolean(runtime.voicePending),
  };
}

export function nextTextRuntime(runtime = {}) {
  return { ...runtime, consecutiveVoiceReplies: 0, voicePending: false };
}

function decodeAudio(value) {
  const raw = String(value ?? "").replace(/\s+/g, "");
  if (!raw) return null;
  const bytes = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  return bytes.length ? bytes : null;
}

/**
 * 合成完成时就把时长算出来，不能等用户第一次播放才临时知道。
 * WAV 直接读 data 块；MP3 按首个音频帧的码率估算，覆盖当前 MiniMax/MiMo 的常见返回。
 */
export function audioDurationMs(audio, format = "wav") {
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!bytes.length) return null;
  if (String(format).toLowerCase() === "wav" && bytes.length >= 44
    && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      const end = Math.min(bytes.length, offset + 8 + size);
      if (bytes.toString("ascii", offset, offset + 4) === "fmt " && offset + 20 <= bytes.length) {
        byteRate = bytes.readUInt32LE(offset + 16);
      } else if (bytes.toString("ascii", offset, offset + 4) === "data") {
        dataSize = Math.min(size, Math.max(0, bytes.length - offset - 8));
        break;
      }
      offset = end + (size % 2);
    }
    if (byteRate > 0 && dataSize > 0) return Math.round(dataSize / byteRate * 1000);
  }
  if (String(format).toLowerCase() === "mp3") {
    const bitrates = {
      1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    for (let offset = 0; offset + 4 < bytes.length; offset += 1) {
      if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
      const versionBits = (bytes[offset + 1] >> 3) & 3;
      const layer = (bytes[offset + 1] >> 1) & 3;
      const bitrateIndex = (bytes[offset + 2] >> 4) & 15;
      if (layer !== 1 || versionBits === 1 || bitrateIndex === 0 || bitrateIndex === 15) continue;
      const version = versionBits === 3 ? 1 : 2;
      const bitrate = bitrates[version][bitrateIndex] * 1000;
      if (bitrate > 0) return Math.max(1, Math.round(bytes.length * 8 / bitrate * 1000));
    }
  }
  return null;
}

async function postJson(ctx, url, headers, body) {
  if (!ctx?.network?.fetch) throw new Error("Hana 尚未提供受控网络接口");
  return ctx.network.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
}

async function responseJson(response) {
  try { return await response.json(); } catch { return {}; }
}

export function voiceRequestHeaders(config, key) {
  const provider = String(config?.providerId || "").toLowerCase();
  const model = String(config?.model || "").toLowerCase();
  return provider === "mimo" || model.includes("mimo")
    ? { "api-key": key }
    : { Authorization: `Bearer ${key}` };
}

function apiError(data, fallback) {
  const values = [data?.message, data?.error?.message, data?.error, data?.base_resp?.status_msg];
  return values.find((value) => typeof value === "string" && value.trim())?.slice(0, 200) || fallback;
}

function normalizeBaseUrl(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) throw new Error("朗读接口地址不合法，要以 http(s):// 开头");
  return base;
}

export function buildT2aUrl(baseUrl, groupId = "") {
  const base = `${normalizeBaseUrl(baseUrl)}/v1/t2a_v2`;
  return String(groupId || "").trim()
    ? `${base}?GroupId=${encodeURIComponent(String(groupId).trim())}`
    : base;
}

/**
 * 朗读配置就是用户自己填的那一条，没有“去别处拉”的分支；
 * 三样缺一不可，缺什么就直说是哪一样。
 * 注意：音色不在这份配置里，归一化时会把 voiceId 洗掉，所以得手动接回来。
 */
function resolveVoiceConfig(config) {
  const cfg = { ...normalizeVoiceModelConfig(config), voiceId: String(config?.voiceId ?? "").trim() };
  if (!cfg.baseUrl) throw new Error("这条朗读模型还没有填接口地址");
  if (!cfg.model) throw new Error("这条朗读模型还没有填模型名");
  if (!cfg.apiKey) throw new Error("这条朗读模型还没有填 API Key");
  return cfg;
}

async function synthesizeT2a(ctx, config, text) {
  const key = await unprotectKey(config.apiKey);
  if (!key) throw new Error("还没有配置 MiniMax API Key");
  const response = await postJson(ctx, buildT2aUrl(config.baseUrl || "https://api.minimaxi.com", config.groupId), { Authorization: `Bearer ${key}` }, {
    model: config.model || "speech-2.8-hd",
    text: String(text ?? "").slice(0, MAX_VOICE_CHARS),
    stream: false,
    voice_setting: { voice_id: config.voiceId || "female-shaonv", speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(apiError(data, `语音合成失败（HTTP ${response.status}）`));
  const audio = decodeAudio(data?.data?.audio);
  if (!audio) throw new Error("MiniMax 没有返回可播放的音频");
  return { audio, format: "mp3", durationMs: audioDurationMs(audio, "mp3"), model: config.model };
}

async function synthesizeChat(ctx, config, text) {
  const key = await unprotectKey(config.apiKey);
  if (!key) throw new Error("还没有配置朗读模型 API Key");
  const base = normalizeBaseUrl(config.baseUrl);
  if (!config.model) throw new Error("还没有填写朗读模型名");
  const headers = voiceRequestHeaders(config, key);
  const response = await postJson(ctx, `${base}/chat/completions`, headers, {
    model: config.model,
    messages: [
      { role: "user", content: "用自然、亲近、语速正常的语气说下面这句话。" },
      { role: "assistant", content: String(text ?? "").slice(0, MAX_VOICE_CHARS) },
    ],
    audio: { voice: config.voiceId || "mimo_default" },
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(apiError(data, `语音合成失败（HTTP ${response.status}）`));
  const audioPayload = data?.choices?.[0]?.message?.audio;
  const encoded = audioPayload?.data ?? data?.data?.audio;
  const audio = decodeAudio(encoded);
  if (!audio) throw new Error("语音模型没有返回可播放的音频");
  const format = data?.data?.format === "mp3" || config.providerId === "mimo" && data?.audio?.format === "mp3" ? "mp3" : "wav";
  return { audio, format, durationMs: audioDurationMs(audio, format), model: config.model };
}

export async function synthesizeVoice(ctx, { text, voiceId, modelConfig = null } = {}) {
  const config = resolveVoiceConfig({ ...(modelConfig || {}), voiceId });
  const choices = voiceChoicesForModel(config);
  const voice = choices.some((item) => item.id === config.voiceId) ? config.voiceId : defaultVoiceIdForModel(config);
  const safeConfig = { ...config, voiceId: voice };
  return safeConfig.protocol === "t2a" ? synthesizeT2a(ctx, safeConfig, text) : synthesizeChat(ctx, safeConfig, text);
}

export const VOICE_LIMITS = { minChars: MIN_VOICE_CHARS, maxChars: MAX_VOICE_CHARS };
