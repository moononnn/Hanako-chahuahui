/**
 * 地区下拉（省 / 市 / 区县）测试。
 *
 * 守三件事：
 *   1. 每一层只给该层的选项：先省、再市、再区县，不越级；
 *   2. 区县带行政代码——天气按区县中心点查，靠的就是这个代码；
 *   3. 选中的代码由后端认：认得就以表里的地名与经纬度为准，认不得就不硬塞。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  cityOptions,
  districtOptions,
  provinceOptions,
  regionOptions,
} from "../lib/weather-regions.js";
import { formatAdministrativeRegion, getAdministrativeRegion } from "../lib/administrative-divisions.js";

test("省级：表里出现过的省份，去重保序", () => {
  const provinces = provinceOptions();
  assert.ok(provinces.includes("四川省"));
  assert.ok(provinces.includes("北京市"));
  assert.equal(new Set(provinces).size, provinces.length, "同一个省不该出现两次");
});

test("市级：跟着省走，越级要不到", () => {
  const cities = cityOptions("四川省");
  assert.ok(cities.includes("成都市"));
  assert.equal(cityOptions("").length, 0);
  assert.equal(cityOptions("不存在的省").length, 0);
});

test("区县级：带行政代码，代码能在表里换回那一行", () => {
  const districts = districtOptions("四川省", "成都市");
  const wuhou = districts.find((row) => row.name === "武侯区");
  assert.ok(wuhou, "成都下面该有武侯区");
  const region = getAdministrativeRegion(wuhou.code);
  assert.equal(region.district, "武侯区");
  assert.equal(region.city, "成都市");
  assert.ok(Number.isFinite(region.latitude) && Number.isFinite(region.longitude));
  assert.deepEqual(districtOptions("四川省", ""), []);
});

test("regionOptions 按参数给对层级", () => {
  assert.equal(regionOptions({}).level, "province");
  assert.equal(regionOptions({ province: "四川省" }).level, "city");
  assert.equal(regionOptions({ province: "四川省", city: "成都市" }).level, "district");
  assert.ok(regionOptions({ province: "四川省", city: "成都市" }).items.some((row) => row.name === "武侯区"));
});

test("地名拼法：省市区三段，认得出来的就是它", () => {
  const region = getAdministrativeRegion("510107");
  assert.equal(formatAdministrativeRegion(region), "四川省 成都市 武侯区");
});

test("index 接了这条路由，且认得的代码由后端改写成表里的地名", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(source.includes('app.get("/settings/weather-regions"'), "应该有地区下拉这条路由");
  assert.ok(source.includes("getAdministrativeRegion(code)"), "选中的代码应由后端去表里认，不信页面临时编的");
  assert.ok(source.includes("formatAdministrativeRegion(region)"), "地名以表里的为准");
  assert.ok(source.includes('app.post("/settings/weather-test"'), "应该有一条试连通性的路由");
  assert.ok(source.includes("createWeatherFetcher(ctx.network)"), "天气用的 fetcher 得先过 createWeatherFetcher，宿主给的是 Response");
  assert.ok(
    !/ownWeatherEvents\(\{[\s\S]{0,120}ctx\.network\?\.fetch/.test(source)
      && !/buildOwnDayContext\(\{[\s\S]{0,120}ctx\.network\?\.fetch/.test(source),
    "别再把宿主的原始 fetch 直接丢给天气模块",
  );
});

test("设置页回填时区县要留着：代码得一路传到区县那层", () => {
  const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
  // 以前就是这一层漏传：城市那层没把代码交给区县层，保存后区县自己空了。
  assert.ok(/fillWeatherCities\(province, city, code\)/.test(html), "省级那层要把区县代码传下去");
  assert.ok(/fillWeatherDistricts\(province, city, code\)/.test(html), "城市层也要把代码传到区县层");
  assert.ok(html.includes('id="own-weather-test"'), "该有个试连通性的按钮");
});
