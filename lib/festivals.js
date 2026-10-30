// 拾光记 · 内置节假日库（公开数据，不加密）
// 包含：① 中国法定节假日（含调休上班日）② 农历节日（春节/端午/中秋/重阳等）③ 公历固定节日（元旦/劳动节/国庆等）
// 结构：数据驱动 + 函数查询。每年调休安排人工更新（版本更新携带）。
// 农历部分用简化的「公历-农历」映射表（覆盖主要节日，不追求完整农历历法）。

// ── 农历节日（每年农历 X 月 X 日，映射到公历）──
// 格式：{ lunarMonth, lunarDay, name, emoji }
// 2026-2030 主要农历节日的公历日期映射（简表，后续可扩展补全）
const LUNAR_FESTIVALS = [
  // 春节（正月初一）及其前后
  { date: "2026-02-17", name: "春节", emoji: "🧧", lunar: "正月初一" },
  { date: "2027-02-06", name: "春节", emoji: "🧧", lunar: "正月初一" },
  { date: "2028-01-26", name: "春节", emoji: "🧧", lunar: "正月初一" },
  { date: "2029-02-13", name: "春节", emoji: "🧧", lunar: "正月初一" },
  { date: "2030-02-03", name: "春节", emoji: "🧧", lunar: "正月初一" },
  // 元宵节（正月十五）
  { date: "2026-03-03", name: "元宵节", emoji: "🏮", lunar: "正月十五" },
  { date: "2027-02-20", name: "元宵节", emoji: "🏮", lunar: "正月十五" },
  { date: "2028-02-09", name: "元宵节", emoji: "🏮", lunar: "正月十五" },
  { date: "2029-02-27", name: "元宵节", emoji: "🏮", lunar: "正月十五" },
  { date: "2030-02-17", name: "元宵节", emoji: "🏮", lunar: "正月十五" },
  // 端午节（五月初五）
  { date: "2026-06-19", name: "端午节", emoji: "🐉", lunar: "五月初五" },
  { date: "2027-06-09", name: "端午节", emoji: "🐉", lunar: "五月初五" },
  { date: "2028-05-28", name: "端午节", emoji: "🐉", lunar: "五月初五" },
  { date: "2029-06-16", name: "端午节", emoji: "🐉", lunar: "五月初五" },
  { date: "2030-06-05", name: "端午节", emoji: "🐉", lunar: "五月初五" },
  // 中秋节（八月十五）
  { date: "2026-09-25", name: "中秋节", emoji: "🌕", lunar: "八月十五" },
  { date: "2027-09-15", name: "中秋节", emoji: "🌕", lunar: "八月十五" },
  { date: "2028-10-03", name: "中秋节", emoji: "🌕", lunar: "八月十五" },
  { date: "2029-09-22", name: "中秋节", emoji: "🌕", lunar: "八月十五" },
  { date: "2030-09-12", name: "中秋节", emoji: "🌕", lunar: "八月十五" },
  // 重阳节（九月初九）
  { date: "2026-10-18", name: "重阳节", emoji: "🍂", lunar: "九月初九" },
  { date: "2027-10-08", name: "重阳节", emoji: "🍂", lunar: "九月初九" },
  { date: "2028-10-26", name: "重阳节", emoji: "🍂", lunar: "九月初九" },
  { date: "2029-10-15", name: "重阳节", emoji: "🍂", lunar: "九月初九" },
  { date: "2030-10-05", name: "重阳节", emoji: "🍂", lunar: "九月初九" },
  // 七夕（七月初七）
  { date: "2026-08-19", name: "七夕", emoji: "💞", lunar: "七月初七" },
  { date: "2027-08-08", name: "七夕", emoji: "💞", lunar: "七月初七" },
  { date: "2028-08-26", name: "七夕", emoji: "💞", lunar: "七月初七" },
  { date: "2029-08-16", name: "七夕", emoji: "💞", lunar: "七月初七" },
  { date: "2030-08-05", name: "七夕", emoji: "💞", lunar: "七月初七" },
  // 中元节（七月十五）
  { date: "2026-08-27", name: "中元节", emoji: "🕯️", lunar: "七月十五" },
  { date: "2027-08-16", name: "中元节", emoji: "🕯️", lunar: "七月十五" },
  { date: "2028-09-03", name: "中元节", emoji: "🕯️", lunar: "七月十五" },
  { date: "2029-08-24", name: "中元节", emoji: "🕯️", lunar: "七月十五" },
  { date: "2030-08-13", name: "中元节", emoji: "🕯️", lunar: "七月十五" },
  // 腊八（腊月初八）
  { date: "2026-01-26", name: "腊八节", emoji: "🥣", lunar: "腊月初八" },
  { date: "2027-01-15", name: "腊八节", emoji: "🥣", lunar: "腊月初八" },
  { date: "2028-01-04", name: "腊八节", emoji: "🥣", lunar: "腊月初八" },
  { date: "2029-01-22", name: "腊八节", emoji: "🥣", lunar: "腊月初八" },
  { date: "2030-01-12", name: "腊八节", emoji: "🥣", lunar: "腊月初八" },
  // 小年（腊月廿三）
  { date: "2026-02-10", name: "小年", emoji: "🧹", lunar: "腊月廿三" },
  { date: "2027-01-30", name: "小年", emoji: "🧹", lunar: "腊月廿三" },
  { date: "2028-01-19", name: "小年", emoji: "🧹", lunar: "腊月廿三" },
  { date: "2029-02-06", name: "小年", emoji: "🧹", lunar: "腊月廿三" },
  { date: "2030-01-27", name: "小年", emoji: "🧹", lunar: "腊月廿三" },
];

// ── 公历固定节日（每年同一天）──
const SOLAR_FESTIVALS = [
  { month: 1, day: 1, name: "元旦", emoji: "🎉" },
  { month: 2, day: 14, name: "情人节", emoji: "💝" },
  { month: 3, day: 8, name: "妇女节", emoji: "🌷" },
  { month: 3, day: 12, name: "植树节", emoji: "🌳" },
  { month: 4, day: 1, name: "愚人节", emoji: "🤡" },
  { month: 5, day: 1, name: "劳动节", emoji: "🎊" },
  { month: 5, day: 4, name: "青年节", emoji: "🚩" },
  { month: 6, day: 1, name: "儿童节", emoji: "🎈" },
  { month: 7, day: 1, name: "建党节", emoji: "🚩" },
  { month: 8, day: 1, name: "建军节", emoji: "🎖️" },
  { month: 9, day: 10, name: "教师节", emoji: "🍎" },
  { month: 10, day: 1, name: "国庆节", emoji: "🇨🇳" },
  { month: 11, day: 11, name: "光棍节", emoji: "🕶️" },
  { month: 12, day: 24, name: "平安夜", emoji: "🎄" },
  { month: 12, day: 25, name: "圣诞节", emoji: "🎄" },
  { month: 12, day: 31, name: "跨年夜", emoji: "🎆" },
];

// ── 法定节假日调休安排（按年）──
// 每年国务院发布后人工更新（2026 年依据国办发明电〔2025〕7 号）。
// 结构：{ year, holidays: [[MM-DD, 名称]], workdays: [MM-DD]（调休上班） }
// holidays 记的是「假期区间」，整段都挂着节日名；区间里哪一天才是节日本身，另见 LEGAL_FESTIVAL_DAYS。
const LEGAL_HOLIDAYS = {
  2026: {
    holidays: [
      ["01-01", "元旦"], ["01-02", "元旦"], ["01-03", "元旦"],
      ["02-15", "春节"], ["02-16", "春节"], ["02-17", "春节"], ["02-18", "春节"], ["02-19", "春节"], ["02-20", "春节"], ["02-21", "春节"], ["02-22", "春节"], ["02-23", "春节"],
      ["04-04", "清明节"], ["04-05", "清明节"], ["04-06", "清明节"],
      ["05-01", "劳动节"], ["05-02", "劳动节"], ["05-03", "劳动节"], ["05-04", "劳动节"], ["05-05", "劳动节"],
      ["06-19", "端午节"], ["06-20", "端午节"], ["06-21", "端午节"],
      ["09-25", "中秋节"], ["09-26", "中秋节"], ["09-27", "中秋节"],
      ["10-01", "国庆节"], ["10-02", "国庆节"], ["10-03", "国庆节"], ["10-04", "国庆节"], ["10-05", "国庆节"], ["10-06", "国庆节"], ["10-07", "国庆节"],
    ],
    workdays: ["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"],
  },
};

// ── 法定假期的「正日子」（节日当天）──
// 假期是区间，节日只有一天：正日子报节日名（照常问候），区间内其余天数按「X假期」报。
// 结构：{ year: { 节日名: MM-DD } }，随 LEGAL_HOLIDAYS 一起按年更新。
const LEGAL_FESTIVAL_DAYS = {
  2026: {
    元旦: "01-01",
    春节: "02-17",
    清明节: "04-05",
    劳动节: "05-01",
    端午节: "06-19",
    中秋节: "09-25",
    国庆节: "10-01",
  },
};

// 法定节日里没进农历/公历表的，这里补一个展示用 emoji（其余自动取对应节日表的 emoji）
const LEGAL_FESTIVAL_EMOJI_EXTRA = { 清明节: "🌿" };

// ── 二十四节气（每年公历日期近似表）──
// 节气是太阳历，公历日期每年波动 1-2 天。这里用近似值（2026 年为主），精确计算需要天文算法，分享版用近似够用。
const SOLAR_TERMS = [
  // 格式：[MM-DD, 名称]（2026 年近似）
  ["01-05", "小寒"], ["01-20", "大寒"],
  ["02-04", "立春"], ["02-19", "雨水"],
  ["03-05", "惊蛰"], ["03-20", "春分"],
  ["04-05", "清明"], ["04-20", "谷雨"],
  ["05-05", "立夏"], ["05-21", "小满"],
  ["06-05", "芒种"], ["06-21", "夏至"],
  ["07-07", "小暑"], ["07-22", "大暑"],
  ["08-07", "立秋"], ["08-23", "处暑"],
  ["09-07", "白露"], ["09-23", "秋分"],
  ["10-08", "寒露"], ["10-23", "霜降"],
  ["11-07", "立冬"], ["11-22", "小雪"],
  ["12-07", "大雪"], ["12-21", "冬至"],
];

// ── 查询函数 ──

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function mmddKey(d) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 算某节日在当年假期区间里是第几天 / 共几天。
 * 依赖 LEGAL_HOLIDAYS[y].holidays 里同节日名条目按日期顺序且连续（现有表均如此）。
 * @param {{holidays: Array<[string,string]>}} legal
 * @param {string} festivalName
 * @param {string} mk MM-DD
 * @returns {{holidayDay:number, holidayTotal:number}|null}
 */
function holidayRunStats(legal, festivalName, mk) {
  const days = legal.holidays.filter(([, n]) => n === festivalName).map(([k]) => k);
  const idx = days.indexOf(mk);
  if (idx < 0) return null;
  return { holidayDay: idx + 1, holidayTotal: days.length };
}

/**
 * 取节日展示用 emoji：优先农历表、其次公历表，最后用补位表/假期 emoji。
 * @param {string} name
 * @returns {string}
 */
function festivalEmoji(name) {
  const lunar = LUNAR_FESTIVALS.find((f) => f.name === name);
  if (lunar) return lunar.emoji;
  const solar = SOLAR_FESTIVALS.find((f) => f.name === name);
  if (solar) return solar.emoji;
  return LEGAL_FESTIVAL_EMOJI_EXTRA[name] || "🏖️";
}

/**
 * 查询某天的内置节日（不含用户自定义）。
 * @param {Date} date
 * @returns {Array<{name, emoji, kind, source}>} kind: legal(法定)/solar(公历)/lunar(农历)/term(节气)
 */
export function getBuiltinFestivals(date) {
  const y = date.getFullYear();
  const dk = dateKey(date);
  const mk = mmddKey(date);
  const out = [];
  const seen = new Set(); // 按节日名去重：法定优先，同名农历/公历不再重复报（如中秋在法定和农历都有）

  // 法定节假日（当年有安排才查）
  // 假期区间 ≠ 节日当天：只有正日子报节日名，其余天数报「X假期」，免得假期第二天又被当成过节。
  const legal = LEGAL_HOLIDAYS[y];
  if (legal) {
    const h = legal.holidays.find(([k]) => k === mk);
    if (h) {
      const festivalDay = LEGAL_FESTIVAL_DAYS[y]?.[h[1]];
      // 没登记正日子的年份退回旧行为（整段都算节日），避免数据没跟上就误报成假期
      const isFestivalDay = !festivalDay || festivalDay === mk;
      const name = isFestivalDay ? h[1] : `${h[1]}假期`;
      if (!seen.has(name)) {
        // 假期非正日子：带上「第 N 天 / 共 M 天」，注入层据此把日子说准，别让模型自己脑补成第一天。
        const stats = isFestivalDay ? null : holidayRunStats(legal, h[1], mk);
        out.push({
          name,
          emoji: isFestivalDay ? festivalEmoji(h[1]) : "🏖️",
          kind: "legal",
          source: "法定",
          baseName: h[1],
          isFestivalDay,
          ...(stats || {}),
        });
        seen.add(name);
      }
    }
  }

  // 公历固定节日
  for (const f of SOLAR_FESTIVALS) {
    if (f.month === date.getMonth() + 1 && f.day === date.getDate()) {
      if (!seen.has(f.name)) {
        out.push({ name: f.name, emoji: f.emoji, kind: "solar", source: "公历" });
        seen.add(f.name);
      }
    }
  }

  // 农历节日（用年份映射表）
  for (const f of LUNAR_FESTIVALS) {
    if (f.date === dk) {
      if (!seen.has(f.name)) {
        out.push({ name: f.name, emoji: f.emoji, kind: "lunar", source: "农历" });
        seen.add(f.name);
      }
    }
  }

  // 节气
  for (const [k, name] of SOLAR_TERMS) {
    if (k === mk) {
      if (!seen.has(name)) {
        out.push({ name, emoji: "🌿", kind: "term", source: "节气" });
        seen.add(name);
      }
    }
  }

  return out;
}

/**
 * 判断某天是否为调休上班日。
 * @returns {boolean}
 */
export function isWorkday(date) {
  const y = date.getFullYear();
  const legal = LEGAL_HOLIDAYS[y];
  if (!legal) return false;
  return legal.workdays.includes(mmddKey(date));
}

/**
 * 判断某天是否为中国法定节假日（只看放假日，不含调休上班日）。
 * DeepSeek 的峰谷计费规则将法定节假日全天计入谷价。
 */
export function isLegalHoliday(date) {
  const y = date.getFullYear();
  const legal = LEGAL_HOLIDAYS[y];
  if (!legal) return false;
  return legal.holidays.some(([key]) => key === mmddKey(date));
}

/**
 * 内置节日的完整年月视图（月历标记用）。
 * @param {number} year
 * @param {number} month 1-12
 * @returns {Map<string, Array>} "YYYY-MM-DD" → 节日数组
 */
export function getMonthFestivals(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const map = new Map();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const f = getBuiltinFestivals(d);
    if (f.length) map.set(dateKey(d), f);
  }
  return map;
}
