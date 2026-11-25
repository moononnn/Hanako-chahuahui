/**
 * 「我们相处出来的理解」这张卡（2026-11-25）。
 *
 * 规则：
 * 1. 主列表只放长期条目（persistent）。
 * 2. 带 reviewReason（后端给的人话原因）的长期条目收进折叠的「建议复核」，
 *    不占主列表；每条仍是原来那套范围标签 / 一起改改 / 忘掉。
 * 3. 短期条目（life-day / until / current-turn）即使当下有效，也不占这一页。
 * 4. 没带 duration 的旧后端：按长期算，照旧显示（不把旧数据藏起来）。
 * 5. 不新增批量删除，不改动任何旧账。
 *
 * 卡片那段代码原样抠出来跑（假 DOM），不抄一份实现。
 */
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

/** 分类那两个纯函数（连同短期集合）。 */
function helperCode() {
  const start = html.indexOf("    // ── 适应理解（相处出来的理解）");
  assert.ok(start > 0, "设置页里要有适应理解那一段");
  const end = html.indexOf("    async function openPartner(", start);
  assert.ok(end > start);
  return html.slice(start, end);
}

/** 卡片本身的构造段：从 detailCard(…) 到挂进 relation 面板。 */
function cardCode() {
  const start = html.indexOf('      const adaptationCard = detailCard("我们相处出来的理解"');
  assert.ok(start > 0, "设置页里要有相处出来的理解这张卡");
  const end = html.indexOf("      detailPanels.relation.appendChild(adaptationCard);", start);
  assert.ok(end > start);
  return html.slice(start, end + "      detailPanels.relation.appendChild(adaptationCard);".length);
}

const HELPERS = helperCode();
const CARD = cardCode();

/** 够用的假节点：建卡只用得到这些。 */
function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    type: "",
    rows: 0,
    maxLength: 0,
    placeholder: "",
    disabled: false,
    children: [],
    handlers: {},
    attrs: {},
    append(...items) { for (const item of items) node.appendChild(item); },
    appendChild(child) { node.children.push(child); child.parent = node; return child; },
    insertBefore(child, ref) {
      const at = node.children.indexOf(ref);
      node.children.splice(at < 0 ? node.children.length : at, 0, child);
      return child;
    },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    addEventListener(name, handler) { (node.handlers[name] ??= []).push(handler); },
    focus() {},
    querySelector() { return null; },
  };
  return node;
}

/** 按 items 建一次卡，返回卡节点和 relation 面板。 */
function renderCard(items) {
  let title = "";
  const relation = makeNode("section");
  const context = vm.createContext({
    document: { createElement: (tag) => makeNode(tag) },
    detailCard: (cardTitle) => { title = cardTitle; return makeNode("article"); },
    splitAdaptationItems: null,
    partner: { name: "小花" },
    adaptation: { items, revisions: { relationship: 1, "user-wide": 2 } },
    detailPanels: { relation },
    agentId: "nova",
  });
  vm.runInContext(HELPERS, context);
  vm.runInContext(CARD, context);
  return { card: relation.children[0], relation, title };
}

const guide = (over = {}) => ({ id: over.id ?? "g1", meaning: over.meaning ?? "别老催她回话", kind: "tone", scope: over.scope ?? "relationship", duration: over.duration, reviewReason: over.reviewReason, ...over });
const texts = (node) => node.children.map((child) => child.textContent);
const withClass = (node, className) => node.children.filter((child) => child.className === className);
const itemsOf = (node) => withClass(node, "adaptation-item");

/* ── 纯函数：摆哪儿 ── */

test("长期没原因进主列表；有原因进复核；短期哪都不摆", () => {
  const context = vm.createContext({});
  vm.runInContext(`${HELPERS}\nglobalThis.place = adaptationPlacement;\nglobalThis.split = splitAdaptationItems;`, context);
  assert.equal(context.place(guide({ duration: "persistent" })), "main");
  assert.equal(context.place(guide({ duration: "persistent", reviewReason: "她最近的表现和这条对不上" })), "review");
  assert.equal(context.place(guide({ duration: "life-day" })), "hidden");
  assert.equal(context.place(guide({ duration: "until" })), "hidden");
  assert.equal(context.place(guide({ duration: "current-turn" })), "hidden");
});

test("还没带 duration 的后端：按长期算，照旧显示", () => {
  const context = vm.createContext({});
  vm.runInContext(`${HELPERS}\nglobalThis.place = adaptationPlacement;`, context);
  for (const value of [undefined, null, "", "  ", 42]) {
    assert.equal(context.place({ meaning: "x", duration: value }), "main", `duration=${JSON.stringify(value)} 时不该藏起来`);
  }
  // 认不出来的新 duration 也当长期：不让条目默默消失。
  assert.equal(context.place({ meaning: "x", duration: "seasonal" }), "main");
});

test("复核原因只有空白不算原因；前后空白会去掉", () => {
  const context = vm.createContext({});
  vm.runInContext(`${HELPERS}\nglobalThis.place = adaptationPlacement;`, context);
  assert.equal(context.place({ meaning: "x", duration: "persistent", reviewReason: "   " }), "main");
  assert.equal(context.place({ meaning: "x", duration: "persistent", reviewReason: " 说过的方式变了 " }), "review");
});

test("分拨：主列表与复核各自成列，短期直接丢掉", () => {
  const context = vm.createContext({});
  vm.runInContext(`${HELPERS}\nglobalThis.split = splitAdaptationItems;`, context);
  const items = [
    guide({ id: "a", duration: "persistent", meaning: "甲" }),
    guide({ id: "b", duration: "persistent", meaning: "乙", reviewReason: "变了" }),
    guide({ id: "c", duration: "life-day", meaning: "丙" }),
    guide({ id: "d", meaning: "丁" }),
  ];
  const split = context.split(items);
  assert.deepEqual(JSON.parse(JSON.stringify(split.main.map((row) => row.id))), ["a", "d"]);
  assert.deepEqual(JSON.parse(JSON.stringify(split.review.map((row) => row.id))), ["b"]);
});

test("复核原因一律给人话：后端代码翻成人话，已经是人话的原样显示", () => {
  const context = vm.createContext({});
  vm.runInContext(`${HELPERS}\nglobalThis.text = reviewReasonText;`, context);
  assert.equal(context.text("temporary-evidence"), "当初的原话像是一时的情况（今天、这次、先别），却被记成了长期。");
  assert.equal(context.text(" 这条是当时一时的情况  "), "这条是当时一时的情况", "人话原样显示，只去前后空白");
  assert.equal(context.text("conflict-evidence"), "当初的原话像是一时的情况，却被记成了长期。", "认不得的代码也不往页面上撂");
  assert.equal(context.text(""), "");
  assert.equal(context.text(undefined), "");
});

/* ── 卡片结构 ── */

test("主列表只放长期条目：短期的一个都不出现", () => {
  const { card, title } = renderCard([
    guide({ id: "a", meaning: "甲条长期", duration: "persistent" }),
    guide({ id: "b", meaning: "乙条短期", duration: "life-day" }),
    guide({ id: "c", meaning: "丙条当轮", duration: "current-turn" }),
    guide({ id: "d", meaning: "丁条旧的", duration: "until" }),
  ]);
  assert.equal(title, "我们相处出来的理解");
  const items = itemsOf(card);
  assert.equal(items.length, 1);
  assert.equal(items[0].children[1].textContent, "甲条长期");
  const all = JSON.stringify(card.children.map((child) => child.textContent));
  assert.doesNotMatch(all, /乙条短期|丙条当轮|丁条旧的/, "短期条目不该占这一页");
  assert.equal(withClass(card, "adaptation-review").length, 0, "没有复核条目就不摆折叠区");
});

test("带原因的长期条目收进折叠「建议复核」，不占主列表", () => {
  const { card } = renderCard([
    guide({ id: "a", meaning: "主列表这条", duration: "persistent" }),
    guide({ id: "b", meaning: "这条要复核", duration: "persistent", reviewReason: "她最近的做法和这条对不上" }),
    guide({ id: "c", meaning: "这条也要复核", duration: "persistent", reviewReason: "当时的事已经过去了" }),
  ]);
  const main = itemsOf(card);
  assert.equal(main.length, 1, "主列表只留没原因的那条");
  assert.equal(main[0].children[1].textContent, "主列表这条");

  const details = card.children.find((child) => child.tagName === "DETAILS");
  assert.ok(details, "复核区得是个折叠块");
  assert.equal(details.className, "adaptation-review");
  assert.equal(details.children[0].tagName, "SUMMARY");
  assert.equal(details.children[0].textContent, "建议复核（2）");
  const reviewItems = itemsOf(details);
  assert.equal(reviewItems.length, 2);
  assert.equal(withClass(reviewItems[0], "adaptation-review-reason").length, 1);
  assert.equal(withClass(reviewItems[0], "adaptation-review-reason")[0].textContent, "建议复核：她最近的做法和这条对不上");
  assert.equal(withClass(reviewItems[1], "adaptation-review-reason")[0].textContent, "建议复核：当时的事已经过去了");
});

test("复核区里每条还是原来那套：范围标签、一起改改、忘掉", () => {
  const { card } = renderCard([
    guide({ id: "a", meaning: "关系这条", scope: "relationship", duration: "persistent", reviewReason: "变了" }),
    guide({ id: "b", meaning: "全局这条", scope: "user-wide", duration: "persistent", reviewReason: "变了" }),
  ]);
  const details = card.children.find((child) => child.tagName === "DETAILS");
  const items = itemsOf(details);
  assert.equal(items.length, 2);
  assert.equal(items[0].children[0].className, "adaptation-scope ");
  assert.equal(items[0].children[0].textContent, "只在你和 小花 之间");
  assert.equal(items[1].children[0].className, "adaptation-scope wide");
  assert.equal(items[1].children[0].textContent, "所有伙伴都这样理解");
  for (const item of items) {
    const actions = item.children[item.children.length - 1];
    assert.equal(actions.className, "item-actions adaptation-actions");
    assert.deepEqual(texts(actions), ["一起改改", "忘掉"]);
    assert.equal(actions.children[1].className, "remove-link", "忘掉还是原来那个样式");
  }
});

test("只有复核条目时，主列表位置说实话，不冒充“什么都没有”", () => {
  const { card } = renderCard([
    guide({ id: "a", meaning: "只剩复核这条", duration: "persistent", reviewReason: "变了" }),
  ]);
  assert.equal(itemsOf(card).length, 0);
  const empty = withClass(card, "empty-note")[0];
  assert.ok(empty, "主列表空着得有一句话");
  assert.match(empty.textContent, /有 1 条在下面「建议复核」里/);
  assert.equal(card.children.find((child) => child.tagName === "DETAILS").children[0].textContent, "建议复核（1）");
});

test("一条长期都没有（只有短期）就是原来的空状态", () => {
  const { card } = renderCard([guide({ id: "a", meaning: "当轮这条", duration: "current-turn" })]);
  assert.equal(itemsOf(card).length, 0);
  assert.equal(withClass(card, "empty-note")[0].textContent, "还没有形成需要单独记下的相处习惯。");
  assert.equal(card.children.some((child) => child.tagName === "DETAILS"), false);
});

test("没传 duration 的旧数据照旧进主列表（兼容未升级的后端）", () => {
  const { card } = renderCard([guide({ id: "a", meaning: "旧数据这条" })]);
  assert.equal(itemsOf(card).length, 1);
  assert.equal(itemsOf(card)[0].children[1].textContent, "旧数据这条");
  assert.equal(card.children.some((child) => child.tagName === "DETAILS"), false);
});

/* ── 不改旧账、不新增批量删除 ── */

test("只用原来那几条接口：没有批量删除，也不动旧账", () => {
  assert.match(CARD, /adaptation\/\$\{encodeURIComponent\(agentId\)\}\/revoke/);
  assert.match(CARD, /adaptation\/\$\{encodeURIComponent\(agentId\)\}\/suggest/);
  assert.match(CARD, /adaptation\/\$\{encodeURIComponent\(agentId\)\}\/apply/);
  assert.doesNotMatch(CARD, /批量|全部忘掉|全部删|一键|"DELETE"/, "不新增批量删除");
  assert.doesNotMatch(CARD, /adaptation\.items\s*=|adaptation\.items\.splice|\.filter\(\(guide\) => guide\.status/, "不改列表、不过滤掉旧账");
  // 复核原因用 textContent 写，不拼 HTML；代码先翻成人话。
  assert.match(CARD, /reason\.textContent = `建议复核：\$\{reviewReasonText\(guide\.reviewReason\)\}`/);
  assert.doesNotMatch(CARD, /reason\.innerHTML/);
});
