/**
 * 「给你递小东西」集中到主设置「主动联系」之后，那一页要的行为。
 *
 * 只抠设置页里那一段跑（partnerFeed 草稿、paintPartnerFeed、savePartnerFeed），
 * 假 DOM、假接口、假伙伴名单；不碰真实服务、不碰真实数据。
 *
 * 钉住六件事：
 * 1. 没读到名单时不许画成“都不递”。
 * 2. 挑人只改草稿，保存才发一次批量 PUT。
 * 3. 回包只认这一项：别的设置不许被盖掉。
 * 4. 晚到的旧回包不许盖掉更新的那一版。
 * 5. 回包不完整就当没存上，草稿留着。
 * 6. 伙伴页不再单开一个投喂开关（那件事归总设置了）。
 */
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

/** 按真实文件边界抠：递小东西那一段代码（草稿 → 画 → 存）。 */
function slicePartnerFeed() {
  const start = html.indexOf("    // 给你递小东西：集中在这里管");
  assert.ok(start > 0, "设置页里得有「给你递小东西」那一段");
  const end = html.indexOf("    /**\n     * B站实际生效上限", start);
  assert.ok(end > start, "这一段后面该接B站那段");
  return html.slice(start, end);
}

const FEED_CODE = slicePartnerFeed();

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    hidden: false,
    textContent: "",
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    handlers: {},
    appendChild(child) { node.children.push(child); child.parent = node; return child; },
    append(...items) { for (const item of items) node.appendChild(item); },
    replaceChildren(...items) { node.children = []; for (const item of items) node.appendChild(item); },
    addEventListener(name, handler) { (node.handlers[name] ??= []).push(handler); },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name] ?? null; },
    click(event = {}) { return node.handlers.click?.[0]?.(event); },
  };
  return node;
}

/**
 * 装起那一段代码，返回能点、能改的假页面。
 * 这一段自己声明了草稿那些变量（let），所以草稿要在装完之后再塞进去。
 */
function setup({ api: apiImpl, partners = [], draft = null } = {}) {
  const calls = [];
  const statuses = [];
  const nodes = {
    "partner-feed-partners": makeNode("div"),
    "partner-feed-save": makeNode("button"),
    "partner-feed-status": makeNode("small"),
  };
  const api = (method, path, payload) => {
    calls.push({ method, path, payload });
    return apiImpl ? apiImpl({ method, path, payload }) : Promise.resolve({ ok: true, partners: [] });
  };
  const context = vm.createContext({
    document: { getElementById: (id) => nodes[id] ?? null, createElement: (tag) => makeNode(tag) },
    api,
    partners,
    say: (text) => statuses.push(String(text)),
  });
  vm.runInContext(FEED_CODE, context);
  if (draft) vm.runInContext(`partnerFeedDraft = ${JSON.stringify(draft)};`, context);
  const host = () => nodes["partner-feed-partners"];
  return {
    context, calls, statuses, nodes,
    host,
    labels: () => host().children.map((child) => child.textContent),
    pressed: () => host().children.map((child) => child.getAttribute("aria-pressed")),
    click: (index) => host().children[index]?.click(),
    save: () => nodes["partner-feed-save"].click(),
    run: (code) => vm.runInContext(code, context),
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const ROW = (id, name, feed) => ({ id, name, settings: feed === undefined ? {} : { partnerFeedEnabled: feed } });

test("抠出来的就是递小东西这一段：草稿、画、保存", () => {
  assert.match(FEED_CODE, /let partnerFeedDraft = null;/);
  assert.match(FEED_CODE, /function paintPartnerFeed\(\)/);
  assert.match(FEED_CODE, /async function savePartnerFeed\(\)/);
  assert.match(FEED_CODE, /api\("PUT", "settings\/partner-feed"/);
  // 不多带隔壁的代码。
  assert.doesNotMatch(FEED_CODE, /paintVideoSharing/);
  assert.doesNotMatch(FEED_CODE, /async function boot\(/);
});

test("还没读到名单：不画名单，也不画成“都不递”", () => {
  const h = setup({ partners: [ROW("a", "小花")] });
  h.run("paintPartnerFeed()");
  assert.equal(h.host().children.length, 0, "没读到就不画名单");
  assert.match(h.nodes["partner-feed-status"].textContent, /还没读到/);
  assert.match(h.nodes["partner-feed-status"].textContent, /不是“都不递”/);
  assert.equal(h.nodes["partner-feed-save"].disabled, true, "没读到不许保存");
});

test("名单按各自的现值画：选中的那位是亮的，其余不亮", () => {
  const h = setup({ partners: [ROW("a", "小花"), ROW("b", "露娜", false)], draft: ["a"] });
  h.run("paintPartnerFeed()");
  assert.deepEqual(h.labels(), ["小花", "露娜"]);
  assert.deepEqual(h.pressed(), ["true", "false"]);
  assert.match(h.nodes["partner-feed-status"].textContent, /1 位伙伴会递小东西/);
});

test("挑人只改草稿，保存才发一次批量 PUT", async () => {
  const calls = [];
  const h = setup({
    partners: [ROW("a", "小花"), ROW("b", "露娜", false)],
    draft: ["a"],
    api: async ({ method, path, payload }) => {
      calls.push({ method, path, payload });
      return { ok: true, partners: [{ id: "a", partnerFeedEnabled: true }, { id: "b", partnerFeedEnabled: false }] };
    },
  });
  h.run("paintPartnerFeed()");
  h.click(1);
  assert.equal(calls.length, 0, "挑人不发请求");
  assert.deepEqual(plain(h.run("partnerFeedDraft")), ["a", "b"]);
  assert.match(h.nodes["partner-feed-status"].textContent, /尚未保存/);
  await h.save();
  assert.equal(calls.length, 1, "保存只发一次");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "settings/partner-feed");
  assert.deepEqual(plain(calls[0].payload.partnerIds), ["a", "b"]);
  assert.match(h.nodes["partner-feed-status"].textContent, /已保存/);
});

test("回包只认这一项：别的设置不许被这一条回包盖掉", async () => {
  const partners = [ROW("a", "小花"), ROW("b", "露娜", false)];
  const h = setup({
    partners,
    draft: ["a"],
    api: async () => ({ ok: true, partners: [{ id: "a", partnerFeedEnabled: true }, { id: "b", partnerFeedEnabled: false }] }),
  });
  partners[0].settings.other = "keep";
  await h.save();
  assert.equal(partners[0].settings.partnerFeedEnabled, true);
  assert.equal(partners[0].settings.other, "keep", "别的设置一个字都不许动");
  assert.equal(partners[1].settings.partnerFeedEnabled, false);
});

test("晚到的旧回包不许盖掉更新的那一版", async () => {
  let releaseFirst = null;
  let call = 0;
  const partners = [ROW("a", "小花")];
  const h = setup({
    partners,
    draft: ["a"],
    api: async () => {
      call += 1;
      if (call === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return { ok: true, partners: [{ id: "a", partnerFeedEnabled: true }] };
    },
  });
  const first = h.save();
  await Promise.resolve();
  // 第二次保存先回来：它才是最新的那一版。
  h.run("partnerFeedSaving = false");
  const second = h.save();
  await second;
  // 旧的那条这时才回来：只能被丢掉。
  releaseFirst({ ok: true, partners: [{ id: "a", partnerFeedEnabled: false }] });
  await first;
  assert.equal(partners[0].settings.partnerFeedEnabled, true, "旧回包不许盖掉新的一版");
});

test("回包不完整就当没存上：草稿留着，不污染已存状态", async () => {
  const partners = [ROW("a", "小花"), ROW("b", "露娜", false)];
  const h = setup({
    partners,
    draft: ["a", "b"],
    api: async () => ({ ok: true, partners: [{ id: "a", partnerFeedEnabled: true }] }),
  });
  await h.save();
  assert.match(h.nodes["partner-feed-status"].textContent, /没存上/);
  assert.match(h.nodes["partner-feed-status"].textContent, /草稿留着/);
  assert.deepEqual(plain(h.run("partnerFeedDraft")), ["a", "b"], "草稿得留着让她能再试一次");
  assert.equal(partners[0].settings.partnerFeedEnabled, undefined, "没存上就不许改已存状态");
  assert.ok(h.statuses.some((text) => text.startsWith("没存上：")));
});
