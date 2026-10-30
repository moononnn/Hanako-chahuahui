import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTION_LABELS,
  ACTION_TIMEOUTS,
  EDIT_MAX_CHARS,
  ONBOARDING_HINT,
  RECALL_WINDOW_MS,
  TIMEOUT_HINT,
  createMobileTools,
  messageActionsFor,
  retractHintOf,
} from "../ui/assets/mobile-tools.js";

// 这一组不碰真网络、不碰真 data：api 是假的，DOM 是最小 fake（真行为：append/remove/
// textContent/事件都按真 DOM 的语义走）。要验的是「谁在什么时候能改屏幕」，
// 不是字符串长得像不像。

const SOURCE = readFileSync(new URL("../ui/assets/mobile-tools.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../ui/assets/mobile-tools.css", import.meta.url), "utf8");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 最小 DOM fake ────────────────────────────────────────────

function makeDom() {
  const ids = new Map();

  const makeEl = (tag = "div") => {
    const classes = new Set();
    const attrs = new Map();
    const handlers = new Map();
    let ownText = null;

    const el = {
      tag,
      id: "",
      type: "",
      value: "",
      src: "",
      alt: "",
      disabled: false,
      hidden: false,
      parent: null,
      children: [],
      isConnected: true,
      get parentNode() {
        return el.parent;
      },
      get className() {
        return [...classes].join(" ");
      },
      set className(value) {
        classes.clear();
        for (const name of String(value ?? "").split(/\s+/)) if (name) classes.add(name);
      },
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
      get textContent() {
        return (ownText ?? "") + el.children.map((child) => child.textContent ?? "").join("");
      },
      set textContent(value) {
        ownText = String(value ?? "");
        el.children = [];
      },
      append(...nodes) {
        for (const node of nodes) {
          if (!node) continue;
          if (node.parent) node.parent.children = node.parent.children.filter((each) => each !== node);
          node.parent = el;
          el.children.push(node);
        }
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((each) => each !== el);
        el.parent = null;
        el.isConnected = false;
      },
      setAttribute(key, value) {
        attrs.set(String(key), String(value ?? ""));
      },
      getAttribute(key) {
        return attrs.has(String(key)) ? attrs.get(String(key)) : null;
      },
      removeAttribute(key) {
        attrs.delete(String(key));
      },
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        handlers.set(type, (handlers.get(type) ?? []).filter((each) => each !== fn));
      },
      fire(type, event = {}) {
        for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
      },
      click() {
        el.fire("click", { target: el });
      },
      focus() {},
      // 原生 audio 的最小行为：真 DOM 里就有，fake 里不实现就看不到“停没停”
      _pauses: 0,
      _loads: 0,
      pause() {
        el._pauses += 1;
      },
      load() {
        el._loads += 1;
      },
    };
    return el;
  };

  const body = makeEl("body");
  const doc = {
    body,
    documentElement: makeEl("html"),
    createElement: (tag) => makeEl(tag),
    getElementById(id) {
      const key = String(id);
      if (!ids.has(key)) {
        const node = makeEl("div");
        node.id = key;
        ids.set(key, node);
        body.append(node);
      }
      return ids.get(key);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, body, el: (id) => doc.getElementById(id) };
}

// ── 假 api：默认挂住，由用例决定什么时候回、回什么 ─────────────

function makeApi() {
  const calls = [];

  function api(path, init = {}, opts = {}) {
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const entry = {
      path: String(path),
      init,
      body: init?.body ? JSON.parse(init.body) : null,
      options: opts ?? {},
      signal: opts?.signal ?? null,
      answered: false,
    };
    entry.resolve = (data) => {
      entry.answered = true;
      settle.resolve(data);
    };
    entry.fail = (error) => {
      entry.answered = true;
      settle.reject(error);
    };
    calls.push(entry);
    return promise;
  }

  return {
    api,
    calls,
    of(needle) {
      return calls.filter((row) => row.path.includes(needle));
    },
    last(needle) {
      const rows = calls.filter((row) => row.path.includes(needle));
      return rows[rows.length - 1] ?? null;
    },
    clear() {
      calls.length = 0;
    },
  };
}

function makeTools(over = {}) {
  const dom = makeDom();
  const net = makeApi();
  const notes = [];
  const context = {
    agentId: "A",
    epoch: 0,
    messages: [],
    messageRefine: true,
    latestAssistantId: "",
    ...over.context,
  };
  let refreshes = 0;
  let menuCloses = 0;
  let stopPlaybacks = 0;
  const tools = createMobileTools({
    doc: dom.doc,
    api: net.api,
    getContext: () => context,
    refreshThread: () => {
      refreshes += 1;
    },
    notify: (text) => notes.push(String(text)),
    closeMessageMenu: () => {
      menuCloses += 1;
    },
    stopPlayback: () => {
      stopPlaybacks += 1;
    },
  });
  return {
    tools,
    dom,
    net,
    context,
    notes,
    stats: {
      get refreshes() {
        return refreshes;
      },
      get menuCloses() {
        return menuCloses;
      },
      get stopPlaybacks() {
        return stopPlaybacks;
      },
    },
  };
}

// ── 取值小工具（都按真 DOM 的树走，不按内部字段名） ──────────────

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function all(node, match) {
  const out = [];
  walk(node, (each) => {
    if (match(each)) out.push(each);
  });
  return out;
}

const byClass = (node, className) =>
  all(node, (each) => String(each.className ?? "").split(/\s+/).includes(className));

const buttonByText = (node, text) =>
  all(node, (each) => each.tag === "button" && each.textContent === text)[0] ?? null;

const sheetBody = (dom) => byClass(dom.body, "mt-sheet-body")[0] ?? null;
const proposals = (dom) => byClass(dom.body, "mt-proposals")[0] ?? null;
const dialog = (dom) => all(dom.body, (each) => String(each.className ?? "").includes("message-editor-layer"))[0] ?? null;

const userMessage = (over = {}) => ({
  id: "u1",
  role: "user",
  text: "我在呢",
  at: new Date().toISOString(),
  readAt: null,
  ...over,
});

const assistantMessage = (over = {}) => ({
  id: "a1",
  role: "assistant",
  text: "嗯，我在。",
  at: new Date().toISOString(),
  ...over,
});

// ── 权限矩阵（纯函数） ──────────────────────────────────────

test("动作权限：自己发的撤回入口一直在，canRecall=false / 已读过期都不藏", () => {
  const fresh = userMessage({ at: new Date().toISOString(), readAt: new Date().toISOString() });
  assert.deepEqual(messageActionsFor(fresh, {}), ["retract"]);

  // 已读且过了两分钟：本体入口照样在，点下去由服务端说行不行
  const old = userMessage({
    at: new Date(Date.now() - RECALL_WINDOW_MS - 60_000).toISOString(),
    readAt: new Date().toISOString(),
  });
  assert.deepEqual(messageActionsFor(old, {}), ["retract"], "过了两分钟入口也不能消失");

  const unread = userMessage({ at: new Date(Date.now() - 60 * 60_000).toISOString(), readAt: null });
  assert.deepEqual(messageActionsFor(unread, {}), ["retract"]);

  // 任意一条（不是只认最新）都能撤：能不能撤听服务端的
  const olderUnread = userMessage({ id: "u0", at: new Date(Date.now() - 86400_000).toISOString(), readAt: null });
  assert.deepEqual(messageActionsFor(olderUnread, {}), ["retract"]);

  assert.deepEqual(messageActionsFor(userMessage({ recall: { ok: false, reason: "processing" } }), {}), ["retract"], "服务端说不行也不藏");
  assert.deepEqual(messageActionsFor(userMessage({ recall: { ok: true, read: true } }), {}), ["retract"]);

  // canRecall 只值一句提示（本体同款：turn ready 会留十分钟，那阵子它是 false）
  assert.deepEqual(messageActionsFor(userMessage({ canRecall: false }), {}), ["retract"], "canRecall=false 不许把按钮藏掉");
  assert.match(retractHintOf(userMessage({ canRecall: false })), /可能撤不回来/);
  assert.equal(retractHintOf(userMessage({ canRecall: true })), "", "能撤就不碎嘴");
  assert.match(
    retractHintOf(userMessage({ at: "2020-01-01T00:00:00.000Z", readAt: "2020-01-01T00:00:00.000Z" })),
    /过了两分钟/,
  );
});

test("动作权限：伙伴的话要开关开着、而且只给最后一条", () => {
  const latest = assistantMessage({ id: "a9" });
  assert.deepEqual(
    messageActionsFor(latest, { messageRefine: true, latestAssistantId: "a9" }),
    ["regenerate", "edit", "delete"],
  );
  assert.deepEqual(
    messageActionsFor(latest, { messageRefine: false, latestAssistantId: "a9" }),
    [],
    "开关关着一个都不给",
  );
  assert.deepEqual(
    messageActionsFor(assistantMessage({ id: "a8" }), { messageRefine: true, latestAssistantId: "a9" }),
    [],
    "不是最后一条：一个动作都没有",
  );
});

test("动作权限：戳一戳只给删掉它；撤回过的什么都不给", () => {
  assert.deepEqual(
    messageActionsFor(assistantMessage({ id: "p1", kind: "poke", text: "" }), { messageRefine: true }),
    ["delete"],
  );
  assert.deepEqual(
    messageActionsFor(assistantMessage({ id: "p1", kind: "poke" }), { messageRefine: false }),
    [],
    "开关关着，连戳一戳也不给删（后端同一条门禁）",
  );
  assert.deepEqual(messageActionsFor(assistantMessage({ recalled: true }), { messageRefine: true, latestAssistantId: "a1" }), []);
  assert.deepEqual(messageActionsFor(userMessage({ recalled: true }), {}), []);
  assert.deepEqual(messageActionsFor(userMessage({ kind: "recalled" }), {}), []);
  assert.deepEqual(messageActionsFor(userMessage({ pending: true }), {}), [], "还在飞的那条不给撤回");
  assert.deepEqual(messageActionsFor(userMessage({ status: "pending" }), {}), [], "status=pending 同样不给");
  assert.deepEqual(messageActionsFor(null, {}), []);
  assert.deepEqual(messageActionsFor({ role: "user" }, {}), [], "没有 id 的不算一条消息");
});

// ── 消息菜单：按钮长出来、点下去走对门 ──────────────────────────

test("消息菜单：伙伴最后一条回复给三个动作，按钮文字跟本体一致", () => {
  const { tools, context, dom } = makeTools();
  context.latestAssistantId = "a1";
  context.messages = [assistantMessage()];
  const container = dom.doc.createElement("div");
  const made = tools.appendMessageActions(container, context.messages[0]);
  assert.equal(made.length, 3);
  assert.deepEqual(
    made.map((row) => row.textContent),
    [ACTION_LABELS.regenerate, ACTION_LABELS.edit, ACTION_LABELS.delete],
  );
  assert.equal(made[0].className, "message-menu-action");
});

test("消息菜单：撤回先核归属，再按现在这条发请求，成功后刷新线程", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  const message = userMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  const retractBtn = buttonByText(container, "撤回");
  assert.ok(retractBtn, "自己刚发的消息要有撤回");
  retractBtn.click();
  await tick();

  const call = net.last("message.retract");
  assert.ok(call, "点了就该发");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.deepEqual(call.body, { agentId: "A", messageId: "u1" });
  assert.equal(stats.menuCloses, 1, "开动作前先把消息菜单收掉");

  call.resolve({ ok: true });
  await tick();
  await tick();
  assert.equal(stats.refreshes, 1, "撤回成功要重拉线程");
  assert.deepEqual(notes, ["消息撤回了"]);
});

test("撤回失败也要把线程拉回来，并把原因说出来", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  const message = userMessage();
  context.messages = [message];
  tools.appendMessageActions(dom.doc.createElement("div"), message)[0].click();
  await tick();
  net.last("message.retract").fail(new Error("ta已经开始看这条消息了，现在撤回会把上下文扯断"));
  await tick();
  await tick();
  assert.equal(stats.refreshes, 1);
  assert.deepEqual(notes, ["ta已经开始看这条消息了，现在撤回会把上下文扯断"]);
});

test("按钮是旧的也没关系：点下去先按现在的线程核一遍，已经不在了就不发", async () => {
  const { tools, context, dom, net, notes } = makeTools();
  const message = userMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  // 线程刷新后这条已经撤回
  context.messages = [{ ...message, recalled: true, text: "你撤回了一条消息" }];
  buttonByText(container, "撤回").click();
  await tick();
  assert.equal(net.calls.length, 0, "已撤回的文案不许再发撤回");
  assert.deepEqual(notes, ["这条已经撤回了"]);
});

test("切了伙伴：旧消息的按钮点下去什么都不发", async () => {
  const { tools, context, dom, net, notes } = makeTools();
  const message = userMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  context.agentId = "B";
  context.epoch = 1;
  context.messages = [userMessage({ id: "u9" })];
  buttonByText(container, "撤回").click();
  await tick();
  assert.equal(net.calls.length, 0);
  assert.deepEqual(notes, ["已经翻篇了，刷新看看"]);
});

test("canRecall=false 时入口还在：点下去由后端拒绝，把原因说出来，不自己改屏幕", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  const message = userMessage({
    canRecall: false,
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    readAt: new Date().toISOString(),
  });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  const [button] = tools.appendMessageActions(container, message);
  assert.equal(button.textContent, "撤回", "canRecall=false 也必须有撤回");
  assert.match(button.getAttribute("title"), /可能撤不回来/, "canRecall 只能当提示");

  button.click();
  await tick();
  const call = net.last("message.retract");
  assert.ok(call, "入口在就真的发出去，让服务端判");
  assert.deepEqual(call.body, { agentId: "A", messageId: "u1" });
  call.fail(Object.assign(new Error("ta已经开始看这条消息了，现在撤回会把上下文扯断"), { status: 409 }));
  await tick();
  await tick();

  assert.deepEqual(notes, ["ta已经开始看这条消息了，现在撤回会把上下文扯断"], "只把服务端那句原因搬出来");
  assert.equal(notes.includes("消息撤回了"), false, "不许假成功");
  assert.equal(context.messages[0].recalled, undefined, "没拿到成功回包就不许在本地把它标成撤回");
  assert.equal(context.messages[0].text, "我在呢", "原文一个字不动");
  assert.equal(container.children.length, 1, "按钮也不因拒绝而被拔掉");
  assert.equal(stats.refreshes, 1, "失败也把线程拉回来对齐真样子");
});

// ── 收藏 ────────────────────────────────────────────────────

test("收藏：列出来的时候只用后端给的正文，取消成功才从屏上拿掉", async () => {
  const { tools, dom, net, notes } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  const list = net.last("favorites.list");
  assert.equal(list.path, "favorites.list?agentId=A");
  list.resolve({
    items: [
      { id: "f1", agentId: "A", messageId: "a1", text: "想起了<你>那天", at: "2026-10-30T10:00:00.000Z", kind: "text", voice: null },
      { id: "f2", agentId: "A", messageId: "a2", text: "语音那条", at: "2026-10-30T11:00:00.000Z", kind: "voice", voice: { durationMs: 3000 } },
    ],
  });
  await opening;

  const cards = byClass(sheetBody(dom), "mt-card");
  assert.equal(cards.length, 2);
  assert.equal(byClass(cards[0], "mt-card-text")[0].textContent, "想起了<你>那天", "尖括号原样是文字，没有被当成标签");
  assert.match(byClass(cards[1], "mt-card-meta")[0].textContent, /语音/);

  buttonByText(cards[0], "取消收藏").click();
  await tick();
  const remove = net.last("favorite.remove");
  assert.equal(remove.init.method, "POST");
  assert.deepEqual(remove.body, { agentId: "A", id: "f1" });
  remove.resolve({ ok: true });
  await tick();
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 1, "成功才拿掉那一行");
  assert.deepEqual(notes, ["取消了这条收藏"]);
});

test("收藏：取消失败就留在原地并说清楚，不许假装删掉", async () => {
  const { tools, dom, net, notes } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", text: "一句", at: null, kind: "text" }] });
  await opening;
  buttonByText(sheetBody(dom), "取消收藏").click();
  await tick();
  net.last("favorite.remove").fail(new Error("这条收藏已经不在了"));
  await tick();
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 1, "卡还在");
  assert.deepEqual(notes, ["这条收藏已经不在了"]);
});

test("收藏：切伙伴后晚回来的列表不许画到新伙伴的窗上", async () => {
  const { tools, dom, net, context, notes } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  context.agentId = "B";
  context.epoch = 1;
  net.last("favorites.list").resolve({ items: [{ id: "f1", text: "A 的收藏", at: null, kind: "text" }] });
  await opening;
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0, "一份都不许画");
  assert.deepEqual(notes, []);
});

test("收藏：面板关掉之后（同伙伴 epoch 不变）迟到的列表也不许画", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  const closeBtn = byClass(dom.body, "mt-sheet-close")[0];
  closeBtn.click();
  const request = net.last("favorites.list");
  request.resolve({ items: [{ id: "f1", text: "晚到的", at: null, kind: "text" }] });
  await opening;
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0);
  assert.equal(request.signal.aborted, true, "关面板时把在飞的请求 abort 掉");
});

// ── 待办确认窗 ──────────────────────────────────────────────

test("待办：确认失败时卡留在原地、原因写在卡上、还能再点一次", async () => {
  const { tools, dom, net, notes } = makeTools();
  const loading = tools.refreshProposals();
  await tick();
  const read = net.last("todos.list");
  assert.equal(read.path, "todos.list?agentId=A");
  read.resolve({ items: [{ key: "todo:t1", title: "交水费", at: "09:12" }] });
  await loading;

  const card = byClass(proposals(dom), "todo-proposal")[0];
  assert.ok(card, "提议要挂成卡");
  assert.match(card.textContent, /09:12 · 交水费/);
  buttonByText(card, "就打上完成").click();
  await tick();
  const confirm = net.last("todos.confirm");
  assert.equal(confirm.init.method, "POST");
  assert.deepEqual(confirm.body, { agentId: "A", key: "todo:t1" });
  confirm.fail(new Error("这次没记上，窗还给你留着，再点一次试试"));
  await tick();

  assert.equal(byClass(proposals(dom), "todo-proposal").length, 1, "失败不许收窗");
  assert.ok(byClass(proposals(dom), "todo-proposal-warn")[0], "要把原因写在卡上");
  assert.ok(buttonByText(card, "再试一次"), "还得能再点一次");
  assert.ok(notes.some((line) => line === "这次没记上，窗还给你留着，再点一次试试"), "失败也要有一句可读说明");
});

test("待办：确认成功后收窗；「先不用」失败也留着", async () => {
  const { tools, dom, net } = makeTools();
  const loading = tools.refreshProposals();
  await tick();
  net.last("todos.list").resolve({
    items: [
      { key: "todo:t1", title: "交水费", at: "" },
      { key: "todo:t2", title: "买猫粮", at: "" },
    ],
  });
  await loading;
  const cards = byClass(proposals(dom), "todo-proposal");
  assert.equal(cards.length, 2);

  buttonByText(cards[0], "就打上完成").click();
  await tick();
  net.last("todos.confirm").resolve({ ok: true, todo: { title: "交水费" } });
  await tick();
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 1, "成功才收");

  const left = byClass(proposals(dom), "todo-proposal")[0];
  buttonByText(left, "先不用").click();
  await tick();
  const dismiss = net.last("todos.dismiss");
  assert.deepEqual(dismiss.body, { agentId: "A", key: "todo:t2" });
  dismiss.fail(new Error("这条窗暂时收不掉，再点一次"));
  await tick();
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 1, "收不掉就还在");
});

test("待办：读不到就不动现有的窗，不许误收", async () => {
  const { tools, dom, net } = makeTools();
  const first = tools.refreshProposals();
  await tick();
  net.last("todos.list").resolve({ items: [{ key: "todo:t1", title: "交水费", at: "" }] });
  await first;

  const again = tools.refreshProposals();
  await tick();
  net.last("todos.list").fail(new Error("待确认的窗没能读出来"));
  await again;
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 1, "读失败保留旧卡");
});

test("待办：切伙伴后晚到的提议不许挂到新伙伴身上", async () => {
  const { tools, dom, net, context } = makeTools();
  const loading = tools.refreshProposals();
  await tick();
  context.agentId = "B";
  context.epoch = 2;
  net.last("todos.list").resolve({ items: [{ key: "todo:t1", title: "A 的事", at: "" }] });
  await loading;
  assert.equal(all(proposals(dom), (each) => each.className === "todo-proposal").length, 0);
});

// ── 编辑 / 重新生成 / 删除 ──────────────────────────────────

test("编辑：限 4000 字、不能空白；成功后清掉原文并刷新线程", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage({ text: "原来那一版" });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "编辑").click();
  await tick();

  const layer = dialog(dom);
  const area = all(layer, (each) => each.tag === "textarea")[0];
  assert.equal(area.value, "原来那一版");
  assert.equal(area.getAttribute("maxlength"), String(EDIT_MAX_CHARS));

  area.value = "   ";
  buttonByText(layer, "采用这版回复").click();
  await tick();
  assert.equal(net.of("message.edit").length, 0, "空白不发");
  assert.ok(notes.includes("回复不能改成空白"));

  area.value = "改好的这一版";
  buttonByText(layer, "采用这版回复").click();
  await tick();
  const call = net.last("message.edit");
  assert.deepEqual(call.body, {
    agentId: "A",
    messageId: "a1",
    text: "改好的这一版",
    // 开框时那一版原话：后端据此原子校旧稿，桌面改过的不会被盖掉
    expectedText: "原来那一版",
  });
  call.resolve({ ok: true, message: { id: "a1", text: "改好的这一版" } });
  await tick();
  await tick();
  assert.equal(dialog(dom), null, "成功收框");
  assert.equal(area.value, "", "原文不许留在 DOM 里");
  assert.equal(stats.refreshes, 1);
});

test("删除：回复与戳一戳的确认文案各自说清楚，删成功才收框", async () => {
  const { tools, context, dom, net } = makeTools();
  context.latestAssistantId = "a1";
  const reply = assistantMessage();
  context.messages = [reply];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, reply);
  buttonByText(container, "删除").click();
  await tick();
  const layer = dialog(dom);
  assert.match(layer.textContent, /永久删除这一整轮回复/);
  assert.match(layer.textContent, /回到未读状态/, "要说清楚原话可能重新进入待回复");

  buttonByText(layer, "彻底删除").click();
  await tick();
  const call = net.last("message.delete");
  assert.equal(call.body.agentId, "A");
  assert.equal(call.body.messageId, "a1");
  call.resolve({ ok: true, restoredUnread: true });
  await tick();
  await tick();
  assert.equal(dialog(dom), null);
});

test("删除：戳一戳只给删掉它，文案说明不进记忆", async () => {
  const { tools, context, dom } = makeTools();
  const poke = assistantMessage({ id: "p1", kind: "poke", text: "戳了你一下" });
  context.messages = [poke];
  const container = dom.doc.createElement("div");
  const made = tools.appendMessageActions(container, poke);
  assert.deepEqual(made.map((row) => row.textContent), ["删除"]);
  made[0].click();
  await tick();
  assert.match(dialog(dom).textContent, /不进 ta 的记忆/);
});

test("重新生成：确认里说明会覆盖当前回复并叫模型", async () => {
  const { tools, context, dom, net } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "重新生成").click();
  await tick();
  const layer = dialog(dom);
  assert.match(layer.textContent, /覆盖你眼前这一版/);
  assert.match(layer.textContent, /叫一次模型/);
  buttonByText(layer, "重新生成").click();
  await tick();
  const call = net.last("message.regenerate");
  assert.deepEqual(call.body, { agentId: "A", messageId: "a1" });
  call.resolve({ ok: true, messageId: "a1" });
  await tick();
  await tick();
  assert.equal(dialog(dom), null);
});

// ── 戳一下 ──────────────────────────────────────────────────

test("戳一下：连点只发一次，成功刷新线程，失败说清楚", async () => {
  const { tools, net, notes, stats } = makeTools();
  const first = tools.poke();
  const second = tools.poke();
  await tick();
  assert.equal(net.of("action.send").length, 1, "连点不许发第二份");
  const call = net.last("action.send");
  assert.deepEqual(call.body, { agentId: "A" });
  call.resolve({ ok: true, line: "你轻轻戳了 ta 一下" });
  assert.equal(await first, true);
  assert.equal(await second, false, "被挡下的那次什么都不算");
  assert.equal(stats.refreshes, 1);
  assert.ok(notes.includes("你轻轻戳了 ta 一下"));

  const failure = tools.poke();
  await tick();
  net.last("action.send").fail(new Error("ta这会儿不在"));
  assert.equal(await failure, false);
  assert.ok(notes.includes("ta这会儿不在"));
});

// ── reset ───────────────────────────────────────────────────

test("reset：abort 在飞请求、清面板/卡片/编辑原文，晚到的回包不再落地", async () => {
  const { tools, context, dom, net } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage({ text: "编辑中的原文" });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "编辑").click();
  await tick();
  const area = all(dialog(dom), (each) => each.tag === "textarea")[0];
  area.value = "改到一半";

  const firstProposals = tools.refreshProposals();
  await tick();
  net.last("todos.list").resolve({ items: [{ key: "todo:t1", title: "交水费", at: "" }] });
  await firstProposals;
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 1, "先挂上一张卡");

  const favorites = tools.openFavorites();
  await tick();
  const pendingRead = net.last("favorites.list");

  const proposalsLoading = tools.refreshProposals();
  await tick();
  const pendingProposals = net.last("todos.list");

  tools.reset();

  assert.equal(pendingRead.signal.aborted, true, "在飞的读被 abort");
  assert.equal(pendingProposals.signal.aborted, true);
  assert.equal(dialog(dom), null, "编辑框收掉");
  assert.equal(area.value, "", "编辑原文清空");
  assert.equal(byClass(dom.body, "mt-card").length, 0);
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 0, "卡片清掉");
  assert.equal(proposals(dom).hidden, true, "卡片区收起来");
  assert.equal(byClass(dom.body, "mt-sheet")[0].parentNode.hidden, true, "面板收起来");

  pendingRead.resolve({ items: [{ id: "f1", text: "晚到的", at: null, kind: "text" }] });
  pendingProposals.resolve({ items: [{ key: "todo:t9", title: "晚到的", at: "" }] });
  await favorites;
  await proposalsLoading;
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0, "reset 之后晚到的结果不许画");
  assert.equal(byClass(proposals(dom), "todo-proposal").length, 0, "晚到的提议也不许画");
});

test("reset 之后旧线程的写请求回包不许再动屏幕", async () => {
  const { tools, context, dom, net, notes } = makeTools();
  const message = userMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "撤回").click();
  await tick();
  const call = net.last("message.retract");
  tools.reset();
  call.resolve({ ok: true });
  await tick();
  await tick();
  assert.deepEqual(notes, [], "reset 之后连提示都不该冒");
});

// ── 接口收紧：长操作时限、在途锁、未认识 ────────────────

test("长操作各自报自己的时限：重生成 190 秒，删除 130 秒", async () => {
  const { tools, context, dom, net } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage();
  context.messages = [message];

  assert.equal(ACTION_TIMEOUTS.regenerate, 190_000);
  assert.equal(ACTION_TIMEOUTS.delete, 130_000);
  assert.equal(ACTION_TIMEOUTS.import, undefined, "导入时限随图库管理一起拿掉了");

  const first = dom.doc.createElement("div");
  tools.appendMessageActions(first, message);
  buttonByText(first, "重新生成").click();
  await tick();
  buttonByText(dialog(dom), "重新生成").click();
  await tick();
  const regen = net.last("message.regenerate");
  assert.equal(regen.options.timeoutMs, ACTION_TIMEOUTS.regenerate, "重生成要等模型跑完");
  regen.resolve({ ok: true, messageId: "a1" });
  await tick();
  await tick();

  const second = dom.doc.createElement("div");
  tools.appendMessageActions(second, message);
  buttonByText(second, "删除").click();
  await tick();
  buttonByText(dialog(dom), "彻底删除").click();
  await tick();
  const remove = net.last("message.delete");
  assert.equal(remove.options.timeoutMs, ACTION_TIMEOUTS.delete, "删除要清摘要/日账/语音");
  remove.resolve({ ok: true });
  await tick();
  await tick();
});

test("重生成超时：只说结果不确定、先刷新，不说「没生成」，也不自动重试", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "重新生成").click();
  await tick();
  buttonByText(dialog(dom), "重新生成").click();
  await tick();
  net.last("message.regenerate").fail(Object.assign(new Error("请求超时，可重试"), { code: "timeout" }));
  await tick();
  await tick();

  assert.deepEqual(notes, [TIMEOUT_HINT], "只给一句「不确定，先刷新」");
  assert.equal(notes.some((line) => /没生成|失败/.test(line)), false, "不能诱导她再点一次模型");
  assert.equal(net.of("message.regenerate").length, 1, "不自动重试");
  assert.equal(stats.refreshes, 1, "先刷新让她自己看");
  assert.equal(dialog(dom), null, "浮层收掉，不留一个可再点的按钮");
});

test("删除超时同样只说结果不确定，删没删先刷新看", async () => {
  const { tools, context, dom, net, notes, stats } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "删除").click();
  await tick();
  buttonByText(dialog(dom), "彻底删除").click();
  await tick();
  net.last("message.delete").fail(Object.assign(new Error("请求超时，可重试"), { code: "timeout" }));
  await tick();
  await tick();
  assert.deepEqual(notes, [TIMEOUT_HINT]);
  assert.equal(net.of("message.delete").length, 1);
  assert.equal(stats.refreshes, 1);
});

test("同一条消息的动作在飞时不接第二下：撤回和重生成都只发一份", async () => {
  const { tools, context, dom, net } = makeTools();
  const message = userMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  const retract = tools.appendMessageActions(container, message)[0];
  retract.click();
  retract.click();
  await tick();
  assert.equal(net.of("message.retract").length, 1, "连点两次只发一份");
  net.last("message.retract").resolve({ ok: true });
  await tick();

  context.latestAssistantId = "a1";
  const reply = assistantMessage();
  context.messages = [reply];
  const second = dom.doc.createElement("div");
  tools.appendMessageActions(second, reply);
  buttonByText(second, "重新生成").click();
  await tick();
  const confirm = buttonByText(dialog(dom), "重新生成");
  confirm.click();
  confirm.click();
  await tick();
  assert.equal(net.of("message.regenerate").length, 1, "确认键也不能连点");
});

test("还没认识完：戳一下和重新生成都只提示回本体，不发请求", async () => {
  const { tools, context, dom, net, notes } = makeTools({ context: { needsOnboarding: true } });
  assert.equal(await tools.poke(), false);
  assert.equal(net.of("action.send").length, 0, "未认识不发戳一戳");
  assert.deepEqual(notes, [ONBOARDING_HINT]);

  context.latestAssistantId = "a1";
  const message = assistantMessage();
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "重新生成").click();
  await tick();
  assert.equal(dialog(dom), null, "连确认框都不开");
  assert.equal(net.of("message.regenerate").length, 0);
  assert.equal(notes.at(-1), ONBOARDING_HINT);
});

test("收藏里的语音用现有 /voice，不走桌面收藏专用那条", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({
    items: [{ id: "f1", messageId: "m9", text: "语音那条", at: null, kind: "voice", voice: { durationMs: 3000 } }],
  });
  await opening;
  const audio = all(sheetBody(dom), (each) => each.tag === "audio")[0];
  assert.ok(audio, "语音收藏要给个能放的入口");
  assert.equal(audio.src, "/voice?agentId=A&messageId=m9");
  assert.doesNotMatch(SOURCE, /\/favorites\//, "不碰桌面收藏专用的语音路");
});

// ── syncThread：收藏与确认框的原文生命周期 ────────────────

test("收藏面板开着时线程内容变了：先清旧条目再重取，撤回的原文不再挂在屏上", async () => {
  const { tools, dom, net, context } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({
    items: [{ id: "f1", messageId: "a1", text: "旧的那句原文", at: null, kind: "text" }],
  });
  await opening;
  assert.match(sheetBody(dom).textContent, /旧的那句原文/);

  // 线程那边把这条撤回了（内容变了）
  context.messages = [{ id: "a1", role: "assistant", recalled: true, kind: "recalled" }];
  tools.syncThread({ contentChanged: true });
  assert.equal(net.of("favorites.list").length, 2, "内容变了一定重取");
  assert.doesNotMatch(sheetBody(dom).textContent, /旧的那句原文/, "回包之前旧原文已经清掉");

  net.last("favorites.list").resolve({ items: [] });
  await tick();
  await tick();
  assert.match(sheetBody(dom).textContent, /还没有收藏的话/);
});

test("仅已读/playedAt 这类不变内容的变更不重取收藏", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", messageId: "m1", text: "一句", at: null, kind: "voice" }] });
  await opening;
  tools.syncThread();
  tools.syncThread({ contentChanged: false });
  await tick();
  assert.equal(net.of("favorites.list").length, 1, "没变内容就不刷");
  assert.match(sheetBody(dom).textContent, /一句/);
});

test("关闭收藏面板后，晚回来的重取回包不许把面板又画出来", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", messageId: "a1", text: "先前的", at: null, kind: "text" }] });
  await opening;

  tools.syncThread({ contentChanged: true });
  const refetch = net.last("favorites.list");
  byClass(dom.body, "mt-sheet-close")[0].click();
  refetch.resolve({ items: [{ id: "f1", messageId: "a1", text: "晚到的", at: null, kind: "text" }] });
  await tick();
  await tick();

  assert.equal(byClass(dom.body, "mt-sheet")[0].parentNode.hidden, true, "面板还是关的");
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0);
  assert.doesNotMatch(sheetBody(dom).textContent, /晚到的/);
});

test("正在编辑时别人改了这一条：syncThread 收框、清稿，并说清楚为什么", async () => {
  const { tools, context, dom, notes } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage({ text: "原来那一版" });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "编辑").click();
  await tick();
  const area = all(dialog(dom), (each) => each.tag === "textarea")[0];
  area.value = "我的新稿";

  // 桌面那边改过了（或服务端推送了新的正文）
  context.messages = [{ ...message, text: "桌面改后的那一版" }];
  tools.syncThread({ contentChanged: true });

  assert.equal(dialog(dom), null, "源变了确认框就该收");
  assert.equal(area.value, "", "旧原文与她的稿子都不留在 DOM 里");
  assert.ok(notes.some((line) => /改过/.test(line)), "要给一句能读的说明");
});

test("普通新消息不影响编辑框：权限没变就不抹她的稿", async () => {
  const { tools, context, dom } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage({ text: "原来那一版" });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "编辑").click();
  await tick();
  const area = all(dialog(dom), (each) => each.tag === "textarea")[0];
  area.value = "我的新稿";

  // 她又自己插了一句（不是伙伴的新回复，a1 还是最后一轮）
  context.messages = [message, userMessage({ id: "u9" })];
  tools.syncThread({ contentChanged: true });

  assert.ok(dialog(dom), "确认框还在");
  assert.equal(area.value, "我的新稿", "她的稿子一个字都不该被抹");
});

test("确认回调提交前再核一遍：开框后那条被撤回就不发请求", async () => {
  const { tools, context, dom, net, notes } = makeTools();
  context.latestAssistantId = "a1";
  const message = assistantMessage({ text: "要删的那条" });
  context.messages = [message];
  const container = dom.doc.createElement("div");
  tools.appendMessageActions(container, message);
  buttonByText(container, "删除").click();
  await tick();
  // 没走 syncThread，直接让源撤回了
  context.messages = [{ ...message, recalled: true, kind: "recalled" }];
  buttonByText(dialog(dom), "彻底删除").click();
  await tick();
  assert.equal(net.of("message.delete").length, 0, "不能再按旧屏发删除");
  assert.equal(dialog(dom), null);
  assert.ok(notes.some((line) => /撤回/.test(line)));
});

test("收藏语音：新的一条开播就暂停同面板其它、并停掉核心语音；关面板时 pause + 清 src + load", async () => {
  const { tools, dom, net, stats } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({
    items: [
      { id: "f1", messageId: "m1", text: "第一条语音", at: null, kind: "voice" },
      { id: "f2", messageId: "m2", text: "第二条语音", at: null, kind: "voice" },
    ],
  });
  await opening;

  const audios = all(sheetBody(dom), (each) => each.tag === "audio");
  assert.equal(audios.length, 2);
  assert.equal(audios[0].src, "/voice?agentId=A&messageId=m1");

  audios[0].fire("play", {});
  assert.equal(audios[1]._pauses, 1, "同面板的另一条要暂停");
  assert.equal(stats.stopPlaybacks, 1, "核心那条语音也要停");

  byClass(dom.body, "mt-sheet-close")[0].click();
  assert.ok(audios[0]._pauses >= 1, "关面板要 pause");
  assert.equal(audios[0].src, "", "关面板要清 src");
  assert.ok(audios[0]._loads >= 1, "再 load 一次，不给旧声音续上");
  assert.equal(audios[1].src, "");

  // reset 也要把面板里剩的声音收掉
  const again = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f3", messageId: "m3", text: "第三条", at: null, kind: "voice" }] });
  await again;
  const third = all(sheetBody(dom), (each) => each.tag === "audio")[0];
  tools.reset();
  assert.ok(third._pauses >= 1, "reset 也要 pause");
  assert.equal(third.src, "", "reset 也要清 src");
});

test("线程变了重取收藏时也先把声音停掉", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", messageId: "m1", text: "语音", at: null, kind: "voice" }] });
  await opening;
  const audio = all(sheetBody(dom), (each) => each.tag === "audio")[0];
  audio.fire("play", {});

  tools.syncThread({ contentChanged: true });
  assert.ok(audio._pauses >= 1, "重取前先停");
  assert.equal(audio.src, "");
  net.last("favorites.list").resolve({ items: [] });
  await tick();
});

test("取消最后一条收藏后要看见空态，不能只剩一个空列表壳", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", messageId: "a1", text: "唯一一条", at: null, kind: "text" }] });
  await opening;

  buttonByText(sheetBody(dom), "取消收藏").click();
  await tick();
  net.last("favorite.remove").resolve({ ok: true });
  await tick();

  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0);
  assert.equal(byClass(sheetBody(dom), "mt-empty").length, 1, "空态要真的画出来");
  assert.match(sheetBody(dom).textContent, /还没有收藏的话/);
});

test("主窗口内容没变、但补拉后发现早那条被撤了：revalidate 也让收藏重取", async () => {
  const { tools, dom, net, context } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({
    items: [{ id: "f1", messageId: "old1", text: "窗口外那条旧原文", at: null, kind: "text" }],
  });
  await opening;
  assert.match(sheetBody(dom).textContent, /窗口外那条旧原文/);

  // 主聊天那一页一个字没变（old1 根本不在 messages 里）
  context.messages = [assistantMessage({ id: "a9", text: "窗口里的内容" })];
  tools.syncThread({ contentChanged: false, revalidate: true });
  assert.equal(net.of("favorites.list").length, 2, "revalidate 也要重取");
  assert.doesNotMatch(sheetBody(dom).textContent, /窗口外那条旧原文/, "回包前旧正文就清了");

  // 服务端已经按「源已撤回」筛过，回的是空列表
  net.last("favorites.list").resolve({ items: [] });
  await tick();
  await tick();
  assert.match(sheetBody(dom).textContent, /还没有收藏的话/);
  assert.equal(byClass(sheetBody(dom), "mt-card").length, 0);
});

test("收藏面板关着时 revalidate 不发请求、也不把面板重新打开", async () => {
  const { tools, dom, net } = makeTools();
  const opening = tools.openFavorites();
  await tick();
  net.last("favorites.list").resolve({ items: [{ id: "f1", messageId: "a1", text: "一句", at: null, kind: "text" }] });
  await opening;
  byClass(dom.body, "mt-sheet-close")[0].click();

  tools.syncThread({ contentChanged: false, revalidate: true });
  await tick();
  assert.equal(net.of("favorites.list").length, 1, "关着就不接这份勤");
  assert.equal(byClass(dom.body, "mt-sheet")[0].parentNode.hidden, true, "更不许自己重开");
  assert.doesNotMatch(sheetBody(dom).textContent, /一句/);
});

// ── 源码守卫 ────────────────────────────────────────────────

test("这个模块不拼 HTML，也没有自带网络/存储", () => {
  assert.doesNotMatch(SOURCE, /\.innerHTML\s*=/, "正文一律 textContent，模板插 HTML 一律不干");
  assert.doesNotMatch(SOURCE, /fetch\(|localStorage|XMLHttpRequest/);
  assert.match(SOURCE, /export function createMobileTools\(/);
  // 契约里的方法一个都不能少
  for (const name of ["appendMessageActions", "openFavorites", "refreshProposals", "poke", "reset", "syncThread"]) {
    assert.match(SOURCE, new RegExp(`${name}[,(]`), `少了 ${name}`);
  }
});

// ── 窄契约：手机不做表情图库管理 ──────────────────────────

test("手机不再管表情图库：不导出 openLibrary，也不发任何表情管理写请求", () => {
  const { tools } = makeTools();
  assert.deepEqual(
    Object.keys(tools).sort(),
    ["appendMessageActions", "openFavorites", "poke", "refreshProposals", "reset", "syncThread"],
    "返回的方法就这六个",
  );
  assert.equal(tools.openLibrary, undefined, "openLibrary 已经从模块拿掉");
  assert.doesNotMatch(SOURCE, /openLibrary/);
  // 图库管理那套写操作 / 来源读取 / 全库缩略图一个都不许回来
  assert.doesNotMatch(SOURCE, /stickers\.(list|source|import|remove|group)/);
  assert.doesNotMatch(SOURCE, /source-sticker/);
  assert.doesNotMatch(SOURCE, /onLibraryChanged/);
  assert.doesNotMatch(CSS, /mt-(tabs?|grid|cell|import|row|inline|input|pane)/);
});

test("样式只借用本体的变量，不另立一套字体/颜色体系", () => {
  assert.match(CSS, /var\(--paper/);
  assert.match(CSS, /var\(--line/);
  assert.match(CSS, /var\(--accent-soft/);
  assert.doesNotMatch(CSS, /@font-face/);
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,6}\s*!important/, "不去覆盖本体的颜色体系");
});



