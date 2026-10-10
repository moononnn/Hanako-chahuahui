// 新消息提示音：全部用 Web Audio 现合成，不引外部音频文件，也就没有授权和加载那一套事。
// 聊天页（panel.html）和设置页（settings.html）共用这一份：音色只在这里改一次，两边一起变。
// 不要在页面里另写一份响铃逻辑，改了这边设置页试听会跟真实效果对不上。

export const PROFILES = {
  chime: { id: "chime", label: "清铃", hint: "轻轻的，两声上行", notes: [{ frequency: 740, offset: 0, duration: 0.1 }, { frequency: 988, offset: 0.12, duration: 0.19 }] },
  drop: { id: "drop", label: "水滴", hint: "一滴落下来", notes: [{ frequency: 1180, offset: 0, duration: 0.08 }, { frequency: 620, offset: 0.09, duration: 0.24 }] },
  bamboo: { id: "bamboo", label: "木音", hint: "敲两下，很干脆", notes: [{ frequency: 587, offset: 0, duration: 0.06 }, { frequency: 880, offset: 0.1, duration: 0.12 }] },
  bowl: { id: "bowl", label: "闷钟", hint: "一声沉的，尾巴长", notes: [{ frequency: 392, offset: 0, duration: 0.55 }] },
};

export const DEFAULT_PROFILE_ID = "chime";
// 拉满也只是 0.3：再高就不是提示音了，是吓人一跳。
export const MAX_GAIN = 0.3;
// 一半大约等于调好音量那版的响度（0.14~0.15），先从这个起点给。
export const DEFAULT_VOLUME = 0.5;

let context = null;

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
  for (const note of profile.notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + note.offset;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(peak, noteStart + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + note.duration + 0.015);
  }
  return true;
}
