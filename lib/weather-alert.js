// 拾光记 · 天气提醒
// 职责：从小时/日预报里挑出「值得用户留意」的事，并判断这一轮要不要开口。
// 与「窗外天气」播报彻底分开：独立判定、独立状态、独立措辞。
// 同一件事说过就不再提，除非情况变了（事件指纹带目标日期）。

// 判定门槛。宁可漏一次，也不要天天扰民。
export const WEATHER_ALERT_DEFAULTS = Object.freeze({
  tempDeltaC: 8,          // 温差门槛：升温和降温都按这条（成都十月昼夜差本来就 5~7°C）
  precipProbability: 60,  // 降水概率门槛（%）
  windGustKmh: 50,        // 阵风门槛（km/h）
  lookAheadHours: 24,     // 未来多少小时内的事算「接下来」
});

// 值得单独提一句的天气码：中雨以上、冻雨、雪、暴雨、雷暴冰雹、雾。
// 小雨、毛毛雨、普通阵雨交给降水概率门槛去判，不直接算恶劣。
const SEVERE_CODES = new Set([45, 48, 55, 56, 57, 63, 65, 66, 67, 71, 73, 75, 77, 81, 82, 85, 86, 95, 96, 99]);
// 有降水的码（配合概率门槛用）。
const PRECIP_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// 严重度排序：同一天有多件事时先报更严重的。
const KIND_SEVERITY = Object.freeze({ severe: 5, wind: 4, rain: 3, drop: 3, rise: 2 });

// 事件类别的人话标签：主对话的提示词和对外契约 alerts 共用一份，不各写一版。
export const KIND_LABELS = Object.freeze({
  severe: "天气转坏",
  wind: "风力上来了",
  rain: "可能要下雨",
  drop: "要降温",
  rise: "要升温",
});

// 每类事件给伙伴的关键词，用来判断这一轮伙伴到底开口了没有。
const KIND_KEYWORDS = Object.freeze({
  severe: ["雷", "冰雹", "暴雪", "大雪", "冻雨", "雾", "雨", "雪"],
  wind: ["风"],
  rain: ["雨", "伞", "淋", "湿"],
  drop: ["降温", "变冷", "冷", "外套", "保暖"],
  rise: ["升温", "变暖", "暖和", "薄"],
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// 把某个时间点换算成预报所在地的本地时间字段（hourly/daily 的时间都是当地时区）。
function localParts(timestamp, utcOffsetSeconds) {
  const offset = num(utcOffsetSeconds) || 0;
  const d = new Date((num(timestamp) || 0) + offset * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  };
}

function dateKeyOf(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function hourKeyOf(parts) {
  return `${dateKeyOf(parts)}T${pad2(parts.hour)}`;
}

// 「今天 / 明天 / 后天」这种口语标签，给伙伴组织句子用。
function dayLabel(dateKey, todayKey) {
  if (dateKey === todayKey) return "今天";
  const today = new Date(`${todayKey}T12:00:00Z`);
  const target = new Date(`${dateKey}T12:00:00Z`);
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days === 1) return "明天";
  if (days === 2) return "后天";
  return dateKey.slice(5).replace("-", "月") + "日";
}

// 时段口语：晚上 / 凌晨 / 明早 ……
function slotLabel(dateKey, hour, todayKey) {
  const label = dayLabel(dateKey, todayKey);
  if (hour == null) return label;
  if (hour < 6) return label === "今天" ? "今天凌晨" : `${label}凌晨`;
  if (hour < 11) return label === "今天" ? "今天上午" : `${label}上午`;
  if (hour < 14) return label === "今天" ? "今天中午" : `${label}中午`;
  if (hour < 18) return label === "今天" ? "今天下午" : `${label}下午`;
  if (hour < 22) return label === "今天" ? "今天傍晚" : `${label}傍晚`;
  return label === "今天" ? "今晚" : `${label}晚上`;
}

function thresholds(settings = {}) {
  const custom = settings?.weatherAlertThresholds || {};
  const pick = (key, fallback) => {
    const value = num(custom[key]);
    return value != null && value > 0 ? value : fallback;
  };
  return {
    tempDeltaC: pick("tempDeltaC", WEATHER_ALERT_DEFAULTS.tempDeltaC),
    precipProbability: pick("precipProbability", WEATHER_ALERT_DEFAULTS.precipProbability),
    windGustKmh: pick("windGustKmh", WEATHER_ALERT_DEFAULTS.windGustKmh),
    lookAheadHours: pick("lookAheadHours", WEATHER_ALERT_DEFAULTS.lookAheadHours),
  };
}

function makeEvent(kind, dateKey, slot, facts, extra = {}) {
  return {
    key: `${dateKey}#${kind}`,
    kind,
    dateKey,
    slot: slot || "",
    dayLabel: "",
    // 排序用的时间锚点：小时级事件用当小时，全天事件用当天中午。
    at: extra.at || `${dateKey}T12:00`,
    facts: Array.isArray(facts) ? facts.filter(Boolean) : [],
    keywords: KIND_KEYWORDS[kind] || [],
    severity: KIND_SEVERITY[kind] || 1,
    ...extra,
  };
}

// 事件排序：先看离现在多近，同一时刻再看有多严重。
// 「先报严重」不能压过「先说马上要来的」——今天下午下雨比明天凌晨的雨更该现在提。
export function sortWeatherEvents(events = []) {
  return [...events].sort((a, b) => {
    const at = String(a.at || a.dateKey).localeCompare(String(b.at || b.dateKey));
    if (at !== 0) return at;
    return (b.severity || 0) - (a.severity || 0);
  });
}

/**
 * 从预报里挑出值得留意的天气事件。
 * @param {object} opts
 *   forecast { utcOffsetSeconds, hourly, daily }
 *   now 当前时间
 *   currentTemp 当前温度（拿不到就用预报里的第一个小时）
 *   settings 设置（可覆盖门槛）
 * @returns {object[]} 事件数组
 */
export function collectWeatherEvents({ forecast, now = new Date(), currentTemp = null, settings = {} } = {}) {
  if (!forecast || typeof forecast !== "object") return [];
  const hourly = forecast.hourly && typeof forecast.hourly === "object" ? forecast.hourly : null;
  const daily = forecast.daily && typeof forecast.daily === "object" ? forecast.daily : null;
  if (!hourly && !daily) return [];

  const limits = thresholds(settings);
  const offset = num(forecast.utcOffsetSeconds) || 0;
  const local = localParts(now instanceof Date ? now.getTime() : now, offset);
  const todayKey = dateKeyOf(local);
  const currentHourKey = hourKeyOf(local);
  const events = new Map();

  const put = (event) => {
    if (!event || !event.facts.length) return;
    const existing = events.get(event.key);
    // 同一类同一目标日：保留事实更多的那份。
    if (!existing || event.facts.length > existing.facts.length) events.set(event.key, event);
  };

  // ── 未来 hours 小时：恶劣天气、降水概率、阵风 ──
  if (hourly && Array.isArray(hourly.time)) {
    const count = hourly.time.length;
    const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const feels = Array.isArray(hourly.apparent_temperature) ? hourly.apparent_temperature : [];
    const codes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
    const probs = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
    const gusts = Array.isArray(hourly.wind_gusts_10m) ? hourly.wind_gusts_10m : [];
    // 当前温度只认真的给到手的数字：null / 空串一律退回预报里的第一个小时。
    // （2026-10-24 修：Number(null) === 0，直接 num(null) 会把「不知道现在几度」当成 0°C，
    //   于是任何 8°C 以上的温度都会被误判成「比现在高了 8 度」，白报一条升温。）
    const currentValue = currentTemp === null || currentTemp === undefined || currentTemp === ""
      ? undefined
      : currentTemp;
    const base = num(currentValue) ?? num(temps[0]);

    const future = [];
    for (let i = 0; i < count; i += 1) {
      const time = String(hourly.time[i] || "");
      if (!time) continue;
      if (time.slice(0, 13) < currentHourKey.slice(0, 13)) continue;
      future.push({ i, time });
      if (future.length >= limits.lookAheadHours) break;
    }

    for (const { i, time } of future) {
      // hourly.time 本身就是当地时区的 "YYYY-MM-DDTHH:MM"，直接拆日期和钟点，不做时区换算。
      const [datePart, timePart] = String(time).split("T");
      const dateKey = datePart;
      const hour = Number(String(timePart || "0").slice(0, 2)) || 0;
      const slot = slotLabel(dateKey, hour, todayKey);
      const code = num(codes[i]);
      const prob = num(probs[i]);
      const gust = num(gusts[i]);
      const temp = num(temps[i]);
      const feel = num(feels[i]);

      if (code != null && SEVERE_CODES.has(code)) {
        const desc = weatherDesc(code);
        put(makeEvent("severe", dateKey, slot, [
          `${slot}${desc}`,
          `体感 ${feel != null ? Math.round(feel) : "—"}°C`,
        ], { code, at: `${dateKey}T${pad2(hour)}` }));
      }
      if (prob != null && prob >= limits.precipProbability && code != null && PRECIP_CODES.has(code)) {
        put(makeEvent("rain", dateKey, slot, [
          `${slot}降水概率 ${Math.round(prob)}%`,
          code != null ? weatherDesc(code) : "",
        ], { probability: prob, at: `${dateKey}T${pad2(hour)}` }));
      }
      if (gust != null && gust >= limits.windGustKmh) {
        put(makeEvent("wind", dateKey, slot, [
          `${slot}阵风能到 ${Math.round(gust)} km/h`,
        ], { gust, at: `${dateKey}T${pad2(hour)}` }));
      }
    }

    // ── 相对当下的突变：接下来会不会明显变冷 / 变热 ──
    if (base != null) {
      let minTemp = null;
      let minSlot = "";
      let minDate = "";
      let minHour = 12;
      let maxTemp = null;
      let maxSlot = "";
      let maxDate = "";
      let maxHour = 12;
      for (const { i, time } of future) {
        const temp = num(temps[i]);
        if (temp == null) continue;
        const [datePart, timePart] = String(time).split("T");
        const dateKey = datePart;
        const hour = Number(String(timePart || "0").slice(0, 2)) || 0;
        if (minTemp == null || temp < minTemp) {
          minTemp = temp;
          minDate = dateKey;
          minHour = hour;
          minSlot = slotLabel(dateKey, hour, todayKey);
        }
        if (maxTemp == null || temp > maxTemp) {
          maxTemp = temp;
          maxDate = dateKey;
          maxHour = hour;
          maxSlot = slotLabel(dateKey, hour, todayKey);
        }
      }
      if (minTemp != null && base - minTemp >= limits.tempDeltaC) {
        put(makeEvent("drop", minDate, minSlot, [
          `${minSlot}最低 ${Math.round(minTemp)}°C，比现在低 ${Math.round(base - minTemp)}°C`,
        ], { at: `${minDate}T${pad2(minHour)}` }));
      }
      if (maxTemp != null && maxTemp - base >= limits.tempDeltaC) {
        put(makeEvent("rise", maxDate, maxSlot, [
          `${maxSlot}会到 ${Math.round(maxTemp)}°C，比现在高 ${Math.round(maxTemp - base)}°C`,
        ], { at: `${maxDate}T${pad2(maxHour)}` }));
      }
    }
  }

  // ── 明天全天：跟今天比温差，加上全天的恶劣天气 / 降水 / 风 ──
  if (daily && Array.isArray(daily.time)) {
    const idx = daily.time.findIndex((t) => String(t || "") === todayKey);
    const tomorrowIdx = idx >= 0 ? idx + 1 : -1;
    if (tomorrowIdx >= 0 && tomorrowIdx < daily.time.length) {
      const dateKey = String(daily.time[tomorrowIdx]);
      const slot = dayLabel(dateKey, todayKey);
      const pick = (name) => (Array.isArray(daily[name]) ? num(daily[name][tomorrowIdx]) : null);
      const code = pick("weather_code");
      const probMax = pick("precipitation_probability_max");
      const gustMax = pick("wind_gusts_10m_max");
      const max = pick("temperature_2m_max");
      const min = pick("temperature_2m_min");
      const todayMax = idx >= 0 && Array.isArray(daily.temperature_2m_max) ? num(daily.temperature_2m_max[idx]) : null;
      const todayMin = idx >= 0 && Array.isArray(daily.temperature_2m_min) ? num(daily.temperature_2m_min[idx]) : null;

      if (code != null && SEVERE_CODES.has(code)) {
        put(makeEvent("severe", dateKey, slot, [`${slot}${weatherDesc(code)}`], { code }));
      }
      if (probMax != null && probMax >= limits.precipProbability) {
        put(makeEvent("rain", dateKey, slot, [`${slot}降水概率最高 ${Math.round(probMax)}%`], { probability: probMax }));
      }
      if (gustMax != null && gustMax >= limits.windGustKmh) {
        put(makeEvent("wind", dateKey, slot, [`${slot}阵风能到 ${Math.round(gustMax)} km/h`], { gust }));
      }
      if (max != null && todayMax != null && todayMax - max >= limits.tempDeltaC) {
        put(makeEvent("drop", dateKey, slot, [
          `${slot}最高 ${Math.round(max)}°C，比今天低 ${Math.round(todayMax - max)}°C`,
        ]));
      }
      if (max != null && todayMax != null && max - todayMax >= limits.tempDeltaC) {
        put(makeEvent("rise", dateKey, slot, [
          `${slot}最高 ${Math.round(max)}°C，比今天高 ${Math.round(max - todayMax)}°C`,
        ]));
      }
      if (min != null && todayMin != null && todayMin - min >= limits.tempDeltaC) {
        put(makeEvent("drop", dateKey, slot, [
          `${slot}最低 ${Math.round(min)}°C，比今天低 ${Math.round(todayMin - min)}°C`,
        ]));
      }
    }
  }

  const list = sortWeatherEvents([...events.values()]);
  return list.map((event) => ({ ...event, dayLabel: dayLabel(event.dateKey, todayKey) }));
}

// 天气码的短描述（给伙伴当素材，不要求照抄）。
export function weatherDesc(code) {
  const map = {
    45: "有雾", 48: "雾凇", 55: "雨下大了", 56: "冻毛毛雨", 57: "冻雨",
    63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪",
    75: "大雪", 77: "米雪", 81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨夹冰雹", 99: "强雷暴带冰雹",
  };
  return map[code] || "天气转坏";
}

// 同一件事最多补报几次：伙伴一直不提就放弃，别一直追着念。
const MAX_PENDING_RETRY = 2;

function pendingFromState(lastState) {
  const pending = lastState?.waPending;
  if (!pending || typeof pending !== "object") return null;
  const key = String(pending.key || "");
  if (!key) return null;
  return { key, count: Number(pending.count) || 0 };
}

/**
 * 决定这一轮要不要提天气提醒。
 * @param {object} opts
 *   events 事件数组（collectWeatherEvents 的结果）
 *   lastState 上次状态（{ waReported: string[], waPending: {key,count} }）
 *   now 当前时间
 * @returns {{ should:boolean, reason:string, notice:object|null, state:object }}
 */
export function decideWeatherAlert({ events = [], lastState = null, now = new Date() } = {}) {
  const reported = new Set(Array.isArray(lastState?.waReported) ? lastState.waReported.map(String) : []);
  const pending = pendingFromState(lastState);
  const candidates = sortWeatherEvents(events);

  if (!candidates.length) {
    return {
      should: false,
      reason: "no-event",
      notice: null,
      state: { ...(lastState || {}), waPending: null },
    };
  }

  // 优先挑还没说过的那件；都没说过就挑最严重的一件（说明它可能已说过或正在补报）。
  const fresh = candidates.find((event) => !reported.has(event.key));
  const target = fresh || candidates[0];

  if (reported.has(target.key)) {
    return { should: false, reason: "already-reported", notice: null, state: { ...(lastState || {}), waPending: null } };
  }
  if (pending && pending.key === target.key && pending.count >= MAX_PENDING_RETRY) {
    // 一直没人接住：记成已说过，不再追着提。
    const nextReported = [...reported, target.key];
    return {
      should: false,
      reason: "give-up",
      notice: null,
      state: { ...(lastState || {}), waReported: nextReported, waPending: null },
    };
  }

  const nextCount = pending && pending.key === target.key ? pending.count + 1 : 1;
  return {
    should: true,
    reason: pending && pending.key === target.key ? "retry" : "detected",
    notice: {
      ...target,
      label: KIND_LABELS[target.kind] || "天气有变化",
      attempt: nextCount,
    },
    state: {
      ...(lastState || {}),
      waReported: [...reported],
      // 待补报：把事件摘要一起存下，伙伴到底提了没有要靠它判断。
      waPending: {
        key: target.key,
        count: nextCount,
        kind: target.kind,
        keywords: Array.isArray(target.keywords) ? target.keywords : [],
        facts: Array.isArray(target.facts) ? target.facts : [],
      },
    },
  };
}

// 伙伴这一轮真的提到这件事了没有（宽松匹配，宁可当成提过，也不要重复扰民）。
export function didMentionWeatherEvent(text, event) {
  const content = String(text || "");
  if (!content || !event) return false;
  const keywords = Array.isArray(event.keywords) ? event.keywords : [];
  return keywords.some((word) => word && content.includes(word));
}

// 伙伴提过了：把这件事记成已说，清掉待补报。
export function markWeatherEventReported(lastState, event) {
  const reported = new Set(Array.isArray(lastState?.waReported) ? lastState.waReported.map(String) : []);
  if (event?.key) reported.add(String(event.key));
  return { ...(lastState || {}), waReported: [...reported].slice(-32), waPending: null };
}
