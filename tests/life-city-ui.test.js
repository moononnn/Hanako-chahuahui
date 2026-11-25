import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

/** 从设置页里把某个函数原样抠出来：跑它自己的逻辑，不抄一遍。 */
function extractFunction(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `设置页里找不到函数 ${name}`);
  const start = html.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (!depth) return html.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 没抠完整`);
}

/** 够用的假节点：设置页的弹窗只用到这些。 */
function fakeNode(extra = {}) {
  return {
    children: [], hidden: false, textContent: "", value: "", className: "",
    replaceChildren(...nodes) { this.children = nodes; },
    appendChild(node) { this.children.push(node); return node; },
    append(...nodes) { this.children.push(...nodes); },
    setAttribute() {}, addEventListener(name, handler) { this.events[name] = handler; },
    events: {},
    ...extra,
  };
}

const CITIES = [
  { code: "510104", name: "四川省 · 成都市", city: "成都市" },
  { code: "510107", name: "四川省 · 武侯区", city: "武侯区" },
  { code: "320100", name: "江苏省 · 南京市", city: "南京市" },
  { code: "110000", name: "北京市", city: "北京市" },
];

test("城市候选拆成省与市：直辖市不拆开，省市同名也算一条", () => {
  const context = vm.createContext({});
  vm.runInContext(`${extractFunction("lifeCityParts")}\nglobalThis.parts = lifeCityParts;`, context);
  const parts = context.parts(CITIES[0]);
  assert.equal(parts.province, "四川省");
  assert.equal(parts.city, "成都市");
  const capital = context.parts(CITIES[3]);
  assert.equal(capital.province, "北京市");
  assert.equal(capital.city, "北京市");
});

test("搜索：省名、市名、整条路径都命中，空格与间隔号不算", () => {
  const context = vm.createContext({});
  vm.runInContext(`${extractFunction("lifeCityParts")}\n${extractFunction("lifeCityMatches")}\nglobalThis.matches = lifeCityMatches;`, context);
  assert.equal(context.matches(CITIES[0], "成都"), true);
  assert.equal(context.matches(CITIES[0], "四川"), true);
  assert.equal(context.matches(CITIES[0], "江苏"), false);
  assert.equal(context.matches(CITIES[0], "成 都"), true, "去掉空格后要能命中");
  assert.equal(context.matches(CITIES[0], "四川省·成都市"), true);
});

test("候选按省分组，顺序照着城市表来", () => {
  const context = vm.createContext({ lifeCityItems: CITIES });
  vm.runInContext(`${extractFunction("lifeCityParts")}\n${extractFunction("lifeCityGroups")}\nglobalThis.groups = lifeCityGroups;`, context);
  const groups = [...context.groups().entries()];
  assert.deepEqual(groups.map(([province]) => province), ["四川省", "江苏省", "北京市"]);
  assert.equal(groups[0][1].length, 2);
});

test("弹窗：空搜索先列省，选了省再列该省的城市，搜索时跨省直接挑并标出完整省市", () => {
  const list = fakeNode();
  const back = fakeNode();
  const sub = fakeNode();
  const search = fakeNode();
  const nodes = { "life-city-modal-list": list, "life-city-modal-back": back, "life-city-modal-sub": sub, "life-city-modal-search": search };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] ?? null, createElement: () => fakeNode() },
    lifeCityItems: CITIES, lifeCityError: "", lifeCityDialogProvince: "", pickLifeCity: () => {},
  });
  vm.runInContext([
    extractFunction("lifeCityParts"), extractFunction("lifeCityMatches"), extractFunction("lifeCityGroups"),
    extractFunction("lifeCityOptionButton"), extractFunction("lifeCityEmpty"), extractFunction("renderLifeCityDialog"),
    "globalThis.render = renderLifeCityDialog;",
  ].join("\n"), context);
  context.render();
  // 空搜索：先给省份。
  assert.deepEqual(list.children.map(node => node.children[0].textContent), ["四川省", "江苏省", "北京市"]);
  assert.equal(back.hidden, true);
  // 点一个省：这一层列该省的城市。
  list.children[0].events.click();
  assert.deepEqual(list.children.map(node => node.children[0].textContent), ["成都市", "武侯区"]);
  assert.equal(back.hidden, false);
  // 搜索跨省：直接出结果，并标出完整省市。
  search.value = "南京";
  context.render();
  assert.deepEqual(list.children.map(node => node.children[0].textContent), ["江苏省 · 南京市"]);
  assert.equal(back.hidden, true);
  // 搜不到就说实话，不给空列表。
  search.value = "没有这座城";
  context.render();
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].textContent, /没有找到/);
});

test("选中一座城才交给点开它的那一页；没存上弹窗不关，取消与 Esc 都不保存", async () => {
  const calls = [];
  const context = vm.createContext({
    closeModal: (id) => calls.push({ closed: id }),
    lifeCityItems: CITIES,
    lifeCityPickTarget: null,
  });
  vm.runInContext([
    extractFunction("pickLifeCity"),
    "globalThis.aim = (fn) => { lifeCityPickTarget = fn; };",
    "globalThis.pick = pickLifeCity;",
  ].join("\n"), context);
  // 没人接（比如页面已换到别处）：只关弹窗，不写任何设置。
  await context.pick("510104", "四川省 · 成都市");
  assert.deepEqual(calls, [{ closed: "life-city-modal" }], "没有目标就只关弹窗");

  // 有人接：交回去的必须是 { code, label }，存上了才关弹窗。
  calls.length = 0;
  let handed = null;
  context.aim(async (payload) => { handed = payload; return saveResult; });
  let saveResult = true;
  await context.pick("510104", "四川省 · 成都市");
  assert.equal(handed?.code, "510104");
  assert.equal(handed?.label, "四川省 · 成都市");
  assert.ok(calls.some((call) => call.closed === "life-city-modal"), "存上了才关弹窗");
  // 没存上：弹窗留着，让她能再试一次。
  calls.length = 0;
  saveResult = false;
  await context.pick("510104", "四川省 · 成都市");
  assert.ok(!calls.some((call) => call.closed), "没存上不能关弹窗");
  // 没在候选表里的代码不交出去。
  calls.length = 0;
  saveResult = true;
  handed = null;
  await context.pick("不存在的代码", "瞎写的");
  assert.equal(handed, null);
  assert.equal(calls.length, 0);
  // 取消与 Esc 走的是关弹窗那条路，不碰保存。
  assert.match(html, /id="life-city-modal-cancel"[^>]*>\s*取消/);
  assert.match(html, /document\.addEventListener\("keydown", \(event\) => \{ if \(event\.key === "Escape"\) document\.querySelectorAll\("\.modal-layer:not\(\[hidden\]\)"\)/);
});

test("城市插画开关独立关闭，只复用同城发现来源且与真实街景分开", () => {
  const panel = partnerCityPanelSource();
  assert.match(panel, /"life-city-illustrations-switch"/);
  assert.match(panel, /不会为插画另发搜索/u);
  assert.match(panel, /不代表到访或亲眼见过/u);
  assert.match(panel, /"life-city-street-switch"/);
});

test("城市设置只留当前值、选择城市与清空；改的是这位伙伴，不再写全局", () => {
  const panel = partnerCityPanelSource();
  for (const id of ["life-city-card", "life-city-pick", "life-city-clear", "life-city-current", "life-city-discoveries-switch", "life-city-illustrations-switch", "life-city-street-switch"]) {
    assert.match(panel, new RegExp(`"${id}"`), `${id} 得在「城市与日常」那一页上`);
  }
  assert.match(panel, /{ lifeCityCode: code }/, "选城市只提交行政代码");
  assert.match(panel, /{ lifeCityCode: null }/, "清空要把这一项显式置空");
  assert.match(panel, /{ \[key\]: next }/, "三个开关各自写回这位伙伴");
  assert.doesNotMatch(panel, /saveGlobal\(/, "城市不再走全局设置");
  // 公共页上不再有城市按钮：城市跟着伙伴走。
  const immersion = html.slice(html.indexOf('id="panel-immersion"'), html.indexOf('</section>', html.indexOf('id="panel-immersion"')));
  assert.doesNotMatch(immersion, /life-city-(pick|clear|switch)/);
});

test("PUT 回包重算覆盖表：清空写成 null，没碰的字段不假装设过", () => {
  const context = vm.createContext({});
  vm.runInContext(`${extractFunction("partnerCityOverrideFrom")}\nglobalThis.ov = partnerCityOverrideFrom;`, context);
  const cleared = context.ov({ lifeCity: "", lifeCityCode: null, lifeCityStreetView: false });
  assert.equal(cleared.lifeCityCode, null, "清空是显式 null，不回退全局");
  assert.equal(cleared.lifeCityStreetView, false);
  assert.equal("lifeCityDiscoveries" in cleared, false, "没改的字段不进覆盖表");
  const picked = context.ov({ lifeCity: "杭州市", lifeCityCode: "330102" });
  assert.equal(picked.lifeCityCode, "330102");
  assert.equal(picked.lifeCity, "杭州市");
  assert.equal("lifeCityDiscoveries" in picked, false);
});

/** 「城市与日常」那段代码：城市跟伙伴走之后，卡片是 JS 现画的。 */
function partnerCityPanelSource() {
  const start = html.indexOf("function mountPartnerCitySettings");
  assert.ok(start > 0, "设置页里得有 mountPartnerCitySettings");
  return html.slice(start, html.indexOf("function mountPartnerManage", start));
}
