/**
 * 地区下拉：省 / 市 / 区县三层。
 *
 * 数据来自公开的行政区分表（lib/administrative-divisions.js）。一次只端一层，
 * 不把整张表推给页面——三千多个区县全塞进设置页的响应里没道理。
 *
 * 选到区县就记下它的行政代码：天气按区县中心点查，精度到区域附近，不代表具体门牌。
 */

import { listAdministrativeRegions } from "./administrative-divisions.js";

let cachedRegions = null;

/** 表只读一次，之后复用。 */
function allRegions() {
  if (!cachedRegions) cachedRegions = listAdministrativeRegions();
  return cachedRegions;
}

/** 省级：表里出现过的省份，去重保序。 */
export function provinceOptions() {
  const seen = new Set();
  const out = [];
  for (const region of allRegions()) {
    const name = String(region?.province || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 市级：某个省下面的城市。 */
export function cityOptions(province) {
  const key = String(province || "").trim();
  if (!key) return [];
  const seen = new Set();
  const out = [];
  for (const region of allRegions()) {
    if (String(region?.province || "").trim() !== key) continue;
    const name = String(region?.city || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 区县级：某个市下面的区县，连行政代码一起给。 */
export function districtOptions(province, city) {
  const p = String(province || "").trim();
  const c = String(city || "").trim();
  if (!p || !c) return [];
  const out = [];
  const seen = new Set();
  for (const region of allRegions()) {
    if (String(region?.province || "").trim() !== p) continue;
    if (String(region?.city || "").trim() !== c) continue;
    const name = String(region?.district || "").trim();
    const code = String(region?.code || "").trim();
    if (!name || !code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name });
  }
  return out;
}

/** 某一层该给什么：省 / 市 / 区县。给错了就退回上一层，绝不猜。 */
export function regionOptions({ province = "", city = "" } = {}) {
  const p = String(province || "").trim();
  const c = String(city || "").trim();
  if (!p) return { level: "province", items: provinceOptions() };
  if (!c) return { level: "city", items: cityOptions(p) };
  return { level: "district", items: districtOptions(p, c) };
}
