// 新消息提示音：全部用 Web Audio 现合成，不引外部音频文件，也就没有授权和加载那一套事。
// 聊天页（panel.html）和设置页（settings.html）共用这一份：音色只在这里改一次，两边一起变。
// 不要在页面里另写一份响铃逻辑，改了这边设置页试听会跟真实效果对不上。
//
// 原来四个音色全是 sine 加同一种衰减包络，只换了音高——所以「清铃」和「木音」听起来
// 差不多（2026-10-14 实机听感反馈）。现在靠三样东西拉开差别：
//   · 波形：sine 亮而空、triangle 厚一点、带噪的更像敲的东西
//   · 包络：0.003s 的起音是「敲」，0.02s 是「鸣」
//   · 噪声：木头、青铜、纸这类打击/摩擦感靠一小段带通噪声，sine  oscillator 做不出来
// to 是滑音终点（水滴、咕噜那种一下走过去），没有 to 就是定音。
// 注意：新增只加不改 id，旧账本里选过的音色照旧认得。

export const PROFILES = {
  chime: {
    id: "chime",
    label: "清铃",
    notes: [{ frequency: 784, offset: 0, duration: 0.12 }, { frequency: 1175, offset: 0.13, duration: 0.32 }],
  },
  drop: {
    id: "drop",
    label: "水滴",
    notes: [{ frequency: 1560, to: 520, offset: 0, duration: 0.17, attack: 0.006 }],
    noise: [{ offset: 0, duration: 0.014, tone: 3200, level: 0.18 }],
  },
  bamboo: {
    id: "bamboo",
    label: "木音",
    notes: [
      { wave: "triangle", frequency: 920, to: 660, offset: 0, duration: 0.05, attack: 0.003 },
      { wave: "triangle", frequency: 760, to: 560, offset: 0.1, duration: 0.045, attack: 0.003 },
    ],
    noise: [
      { offset: 0, duration: 0.018, tone: 2500, level: 0.4 },
      { offset: 0.1, duration: 0.016, tone: 2200, level: 0.3 },
    ],
  },
  bowl: {
    id: "bowl",
    label: "闷钟",
    notes: [
      { frequency: 392, offset: 0, duration: 0.55, attack: 0.02 },
      { frequency: 588, offset: 0, duration: 0.36, level: 0.35, attack: 0.02 },
    ],
  },
  windchime: {
    id: "windchime",
    label: "风铃",
    notes: [
      { frequency: 1046, offset: 0, duration: 0.2 },
      { frequency: 1568, offset: 0.06, duration: 0.24, level: 0.65 },
      { frequency: 1318, offset: 0.13, duration: 0.34, level: 0.45 },
    ],
  },
  bubble: {
    id: "bubble",
    label: "咕噜",
    notes: [{ frequency: 300, to: 980, offset: 0, duration: 0.08, attack: 0.008 }],
  },
  ding: {
    id: "ding",
    label: "叮咚",
    notes: [
      { wave: "triangle", frequency: 880, offset: 0, duration: 0.15, attack: 0.008, level: 0.8 },
      { wave: "triangle", frequency: 659, offset: 0.17, duration: 0.3, attack: 0.008, level: 0.9 },
    ],
  },
};

export const DEFAULT_PROFILE_ID = "chime";
// 拉满也只是 0.3：再高就不是提示音了，是吓人一跳。
export const MAX_GAIN = 0.3;
// 一半大约等于调好音量那版的响度（0.14~0.15），先从这个起点给。
export const DEFAULT_VOLUME = 0.5;

let context = null;
let noiseCache = null;

/** 打击和摩擦感靠一段带通噪声，纯振荡器做不出来。噪声源本身跟音色无关，整段复用。 */
function noiseBuffer(ctx) {
  if (noiseCache && noiseCache.sampleRate === ctx.sampleRate) return noiseCache;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.15));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  noiseCache = buffer;
  return buffer;
}

/** 声音只在页面自己发得出去时才发得响；浏览器没放行就老实说没放行。 */
export function ensureAudio() {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return Promise.resolve(false);
  try { context ??= new AudioContextType(); } catch { return Promise.resolve(false); }
  if (context.state === "running") return Promise.resolve(true);
  return context.resume().then(() => context.state === "running").catch(() => false);
}

export function normalizeProfileId(id) {
  const key = String(id ?? "");
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? key : DEFAULT_PROFILE_ID;
}

export function normalizeVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

/** 读到的设置可能来自旧版或手改过的账本，形状不对就退回默认，别让坏值进到发声那一步。 */
export function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const byPartner = {};
  if (value.byPartner && typeof value.byPartner === "object" && !Array.isArray(value.byPartner)) {
    for (const [agentId, profileId] of Object.entries(value.byPartner)) {
      const key = String(agentId || "").trim().slice(0, 64);
      if (key) byPartner[key] = normalizeProfileId(profileId);
    }
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    volume: normalizeVolume(value.volume ?? DEFAULT_VOLUME),
    profile: normalizeProfileId(value.profile),
    byPartner,
  };
}

/** ta 自己那一份优先；没单挑过的跟默认走。 */
export function profileFor(sound, agentId) {
  const settings = normalizeSettings(sound);
  const own = String(agentId ?? "").trim();
  return normalizeProfileId(own && settings.byPartner[own] ? settings.byPartner[own] : settings.profile);
}

/** 返回有没有真的响出去，页面据此决定要不要说「刚才那声是试听」。 */
export function play({ profileId, volume, agentId, sound } = {}) {
  if (!context || context.state !== "running") return false;
  const settings = normalizeSettings(sound);
  const id = agentId !== undefined && agentId !== null ? profileFor(settings, agentId) : normalizeProfileId(profileId);
  const profile = PROFILES[id];
  const peak = MAX_GAIN * normalizeVolume(volume ?? settings.volume);
  if (peak <= 0) return false;
  const start = context.currentTime + 0.012;
  for (const note of profile.notes ?? []) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + (note.offset ?? 0);
    const duration = Math.max(0.02, note.duration ?? 0.12);
    oscillator.type = note.wave ?? "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    // 滑音：水滴、咕噜那种一下走过去的；没有 to 就是定音。
    if (typeof note.to === "number" && note.to > 0 && note.to !== note.frequency) {
      oscillator.frequency.exponentialRampToValueAtTime(note.to, noteStart + duration);
    }
    const attack = Math.min(duration * 0.6, Math.max(0.003, note.attack ?? 0.012));
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * (note.level ?? 1)), noteStart + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + duration + 0.015);
  }
  for (const hit of profile.noise ?? []) {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const hitStart = start + (hit.offset ?? 0);
    const duration = Math.max(0.008, hit.duration ?? 0.02);
    source.buffer = noiseBuffer(context);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(hit.tone ?? 2200, hitStart);
    filter.Q.setValueAtTime(hit.q ?? 1.2, hitStart);
    gain.gain.setValueAtTime(0.0001, hitStart);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * (hit.level ?? 0.3)), hitStart + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, hitStart + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(hitStart);
    source.stop(hitStart + duration + 0.015);
  }
  return true;
}
