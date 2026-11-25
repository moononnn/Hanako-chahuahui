/**
 * 桌面设置：伙伴页的三层导航（2026-11-25 拍板）。
 *
 * 1. 设置 → 伙伴设置：只落到名单，不替她打开第一位。
 * 2. 点名字：只显示该伙伴的目录；名单和它的附属内容一起收起。
 * 3. 进分项：只显示该分项。
 * 4. 工具栏那一个返回：分项 → 该伙伴目录 → 伙伴名单 → 设置总目录。
 *
 * 这里把导航那几个函数原样抠出来跑（假 DOM、假状态），
 * 不抄一份实现；打开伙伴页那么重的东西用桩代替，只验退到哪一层、焦点和滚动。
 */
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 从设置页里把某个函数原样抠出来。 */
function extractFunction(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `设置页里找不到函数 ${name}`);
  const open = html.indexOf("{", html.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (!depth) return html.slice(at, i + 1);
    }
  }
  throw new Error(`函数 ${name} 没抠完整`);
}

const NAV_CODE = ["partnerLevel", "paintPartnerListVisibility", "paintIndexBackLabel", "showPartnerList", "stepBack"]
  .map(extractFunction).join("\n");

/** 装起导航那几个函数，状态可设；打开伙伴页是桩，只记被叫过什么。 */
function setup({ activeSetting = "partners", currentId = null, currentDetailTab = "directory", seq = 0, partnerIds = [] } = {}) {
  const calls = [];
  const focus = [];
  const partnerList = {
    querySelector(selector) {
      const hit = /^\[data-partner-id="(.+)"\]$/.exec(selector);
      if (!hit || !partnerIds.includes(hit[1])) return null;
      return { focus(options) { focus.push({ partnerId: hit[1], options }); } };
    },
  };
  const pageTitle = { textContent: "", focus(options) { focus.push({ title: true, options }); } };
  const indexBack = {
    textContent: "‹ 设置",
    attrs: {},
    setAttribute(name, value) { indexBack.attrs[name] = String(value); },
  };
  const partnerListView = { hidden: false };
  const partnerBody = { cleared: 0, replaceChildren() { partnerBody.cleared += 1; } };
  const context = vm.createContext({
    activeSetting, currentId, currentDetailTab, partnerRequestSeq: seq,
    partners: partnerIds.map((id) => ({ id })),
    el: { partnerBody, partnerList, partnerListView },
    pageTitle, indexBack,
    window: { scrollTo: (x, y) => calls.push(["scrollTo", x, y]) },
    paintPartnerList: () => calls.push(["paintPartnerList"]),
    openPartner: (...args) => calls.push(["openPartner", ...args]),
    showIndex: () => calls.push(["showIndex"]),
  });
  vm.runInContext(NAV_CODE, context);
  return { context, calls, focus, indexBack, partnerListView, partnerBody, pageTitle };
}

test("抠出来的导航函数都在，且没有页内返回", () => {
  for (const name of ["partnerLevel", "paintPartnerListVisibility", "paintIndexBackLabel", "showPartnerList", "stepBack"]) {
    assert.match(NAV_CODE, new RegExp(`function ${name}\\(`));
  }
  // 工具栏只有一个返回：分项页里不再另摆「‹ 返回」。
  assert.equal([...html.matchAll(/partner-back/g)].length, 0);
  assert.match(html, /indexBack\.addEventListener\("click", stepBack\)/);
});

test("三层：名单 → 某位伙伴的目录 → 某个分项", () => {
  assert.equal(setup({ currentId: null }).context.partnerLevel(), "list");
  assert.equal(setup({ currentId: "nova", currentDetailTab: "directory" }).context.partnerLevel(), "directory");
  assert.equal(setup({ currentId: "nova", currentDetailTab: "contact" }).context.partnerLevel(), "section");
  // 不在伙伴页时没有这一层，返回就是回总目录。
  assert.equal(setup({ activeSetting: "chat", currentId: "nova", currentDetailTab: "contact" }).context.partnerLevel(), null);
});

test("名单和它的附属内容只在名单这一层出现", () => {
  const list = setup({ currentId: null });
  list.context.paintPartnerListVisibility();
  assert.equal(list.partnerListView.hidden, false);

  const directory = setup({ currentId: "nova", currentDetailTab: "directory" });
  directory.context.paintPartnerListVisibility();
  assert.equal(directory.partnerListView.hidden, true, "点进某位伙伴后名单要收起");

  const section = setup({ currentId: "nova", currentDetailTab: "city" });
  section.context.paintPartnerListVisibility();
  assert.equal(section.partnerListView.hidden, true);
});

test("工具栏那一个返回的文字跟着目标变", () => {
  const list = setup({ currentId: null });
  list.context.paintIndexBackLabel();
  assert.equal(list.indexBack.textContent, "‹ 设置");
  assert.equal(list.indexBack.attrs["aria-label"], "返回设置");

  const directory = setup({ currentId: "nova", currentDetailTab: "directory" });
  directory.context.paintIndexBackLabel();
  assert.equal(directory.indexBack.textContent, "‹ 返回");
  assert.equal(directory.indexBack.attrs["aria-label"], "返回伙伴名单");

  const section = setup({ currentId: "nova", currentDetailTab: "city" });
  section.context.paintIndexBackLabel();
  assert.equal(section.indexBack.textContent, "‹ 返回");
  assert.equal(section.indexBack.attrs["aria-label"], "返回这位伙伴的设置");
});

test("逐级返回：分项 → 该伙伴目录 → 伙伴名单 → 设置总目录", async () => {
  // 分项：退回目录，并把焦点落回刚才那一行。
  const section = setup({ currentId: "nova", currentDetailTab: "city" });
  section.context.stepBack();
  assert.deepEqual(plain(section.calls), [["openPartner", "nova", "directory", { focusSection: "city" }]]);

  // 目录：退回名单，焦点落在该伙伴的名字上。
  const directory = setup({ currentId: "nova", currentDetailTab: "directory", partnerIds: ["nova", "luna"] });
  directory.context.stepBack();
  assert.equal(directory.context.currentId, null);
  assert.equal(directory.context.partnerRequestSeq, 1, "退回名单时把在途的伙伴页回包作废");
  assert.deepEqual(directory.calls.filter((call) => call[0] === "paintPartnerList"), [["paintPartnerList"]]);
  assert.deepEqual(plain(directory.focus.at(-1)), { partnerId: "nova", options: { preventScroll: true } });

  // 名单：退回设置总目录。
  const list = setup({ currentId: null });
  list.context.stepBack();
  assert.deepEqual(plain(list.calls), [["showIndex"]]);
});

test("回到名单：清掉打开的那位、标题回到伙伴设置、滚动到顶、焦点有处可落", () => {
  const h = setup({ currentId: "nova", currentDetailTab: "contact", partnerIds: ["nova"] });
  h.context.showPartnerList();
  assert.equal(h.context.currentId, null);
  assert.equal(h.context.currentDetailTab, "directory");
  assert.equal(h.partnerBody.cleared, 1, "伙伴页内容要清掉，不给下一次留残页");
  assert.equal(h.partnerListView.hidden, false, "名单要回来");
  assert.equal(h.pageTitle.textContent, "伙伴设置");
  assert.deepEqual(plain(h.calls.filter((call) => call[0] === "scrollTo")), [["scrollTo", 0, 0]]);
  assert.deepEqual(plain(h.focus.at(-1)), { title: true, options: { preventScroll: true } });

  // 名单里还有那位时，焦点落在她的名字上。
  const withRow = setup({ currentId: "nova", currentDetailTab: "directory", partnerIds: ["nova"] });
  withRow.context.showPartnerList({ focusPartnerId: "nova" });
  assert.deepEqual(plain(withRow.focus.at(-1)), { partnerId: "nova", options: { preventScroll: true } });
});

test("异步串页：退回名单后，晚到的伙伴页回包一律作废", () => {
  const h = setup({ currentId: "nova", currentDetailTab: "city", seq: 7 });
  const before = h.context.partnerRequestSeq;
  h.context.showPartnerList();
  assert.ok(h.context.partnerRequestSeq > before, "序号要往前走，晚到的回包才对不上");
  assert.equal(h.context.currentId, null);
});

test("结构：名单的附属内容包在名单层里，伙伴详情在它外面", () => {
  const panel = html.slice(html.indexOf('id="panel-partners"'), html.indexOf('id="panel-mobile"'));
  const viewStart = panel.indexOf('id="partner-list-view"');
  const viewEnd = panel.indexOf('id="partner-body"');
  assert.ok(viewStart > 0 && viewEnd > viewStart, "名单层要在伙伴详情前面");
  const listView = panel.slice(viewStart, viewEnd);
  for (const id of ["partner-heading", "new-local-entry", "removed-entry", "msg-refine-switch", "partner-list"]) {
    assert.match(listView, new RegExp(`id="${id}"`), `${id} 属于名单这一层`);
  }
  assert.match(panel.slice(viewEnd), /id="partner-body"/);
});
