/**
 * 聊天图片的右键菜单（右键收进表情包 / 收进并允许动作参考）。
 *
 * 只抠 panel.html 里那一段跑：`/* 聊天里的图片` 到 collectChatImage 收尾，
 * 不抄一份实现，也不碰真实 DOM、真实接口或真实数据。
 *
 * 钉住六件事：
 * 1. 伙伴发的图只能收藏，不去问授权。
 * 2. 自己的图走组合动作时先收藏、后授权，顺序不许反。
 * 3. 失败只报那一部分：收藏没成就别提升级，收藏成了授权没成就说没记下。
 * 4. 已经授权过的图，撤回只撤授权，收藏不动。
 * 5. 不是自己的图给不出「允许参考」这个组合。
 * 6. 换到另一张图之后，上一张的旧回包不能写进这张菜单。
 */
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");

/** 按真实文件边界抠：从那段注释起，到 collectChatImage 收尾、接着就是表情格子的右键菜单。 */
function sliceImageCollectMenu() {
  const start = html.indexOf("    /* 聊天里的图片：右键收进表情包。 */");
  assert.ok(start > 0, "panel.html 里要有「聊天里的图片」这一段");
  const end = html.indexOf('\n    el.stickerGrid.addEventListener("contextmenu"', start);
  assert.ok(end > start, "这一段后面该接表情格子的右键菜单");
  return html.slice(start, end);
}

const MENU_CODE = sliceImageCollectMenu();

/* ── 够用的假 DOM：只用到创建节点、挂 children、显隐、定位和点一下 ── */

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    hidden: false,
    textContent: "",
    style: {},
    dataset: {},
    children: [],
    handlers: {},
    parent: null,
    appendChild(child) {
      node.children.push(child);
      child.parent = node;
      return child;
    },
    append(...items) {
      for (const item of items) node.appendChild(item);
    },
    replaceChildren(...items) {
      node.children = [];
      for (const item of items) node.appendChild(item);
    },
    addEventListener(name, handler) {
      (node.handlers[name] ??= []).push(handler);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 120, height: 36 };
    },
    contains(target) {
      return target === node || node.children.some((child) => child.contains?.(target));
    },
    click(event = {}) {
      return node.handlers.click?.[0]?.(event);
    },
  };
  return node;
}

function image(dataset) {
  return { dataset: { ...dataset } };
}

function contextMenuEvent(x = 120, y = 80) {
  return {
    clientX: x,
    clientY: y,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 把那段代码装进一个假页面里跑。
 * api 的回包由每一条用例自己决定，记录进 calls；statuses 是页脚提示的原文，原样比对。
 */
function setup({ api: apiImpl, current = "nova", pickerHidden = true } = {}) {
  const calls = [];
  const statuses = [];
  const loads = [];
  const body = makeNode("body");
  const api = (method, path, payload) => {
    const call = { method, path, payload };
    calls.push(call);
    return apiImpl ? apiImpl(call) : Promise.resolve({ ok: true, forwarded: { ok: true } });
  };
  const context = vm.createContext({
    document: { body, createElement: (tag) => makeNode(tag) },
    window: { innerWidth: 1200, innerHeight: 800 },
    api,
    current,
    setStatus: (text) => statuses.push(String(text)),
    el: { stickerPicker: { hidden: pickerHidden } },
    loadStickerLibrary: async () => { loads.push(true); },
  });
  // 这段代码调的是页面里已有的 stickerMenuButton，照原样补上（它也属于这份菜单的形状）。
  vm.runInContext(`
    function stickerMenuButton(label, handler) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", handler);
      return button;
    }
  `, context);
  vm.runInContext(MENU_CODE, context);
  const menu = () => body.children[0];
  const labels = () => menu().children.map((child) => child.textContent);
  return { context, calls, statuses, loads, body, menu, labels };
}

test("抠出来的就是这一段：从右键菜单到 collectChatImage 收尾", () => {
  assert.match(MENU_CODE, /const imageCollectMenu = document\.createElement\("div"\)/);
  assert.match(MENU_CODE, /function openImageCollectMenu/);
  assert.match(MENU_CODE, /async function paintReferenceUseAction/);
  assert.match(MENU_CODE, /async function collectChatImage/);
  // 不多带隔壁的代码。
  assert.doesNotMatch(MENU_CODE, /stickerGrid\.addEventListener/);
  assert.doesNotMatch(MENU_CODE, /async function loadStickerLibrary/);
  // 末尾正好收在 collectChatImage 的右括号上。
  assert.match(MENU_CODE.trimEnd(), /\}$/);
  assert.match(MENU_CODE.trimEnd(), /setStatus\(collected\);\s*\n\s*if \(!el\.stickerPicker\.hidden\) void loadStickerLibrary\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}$/);
});

test("伙伴发的图：只有「收进表情包」，连授权都不问", async () => {
  const h = setup({ api: async (call) => {
    if (call.path === "library/collect-sticker") return { ok: true, forwarded: { ok: true } };
    throw new Error(`不该调这个：${call.path}`);
  } });
  const event = contextMenuEvent();
  h.context.openImageCollectMenu(event, image({ attachmentId: "att-1", attachmentOwner: "nova", senderRole: "ta" }));
  await flush();
  assert.equal(event.defaultPrevented, true, "右键要挡住浏览器自己的菜单");
  assert.equal(h.menu().hidden, false);
  assert.deepEqual(h.labels(), ["收进表情包"]);
  assert.equal(h.calls.some((call) => call.path.startsWith("library/reference-use")), false, "不是自己发的，不该去问授权");

  h.menu().children[0].click();
  await flush();
  assert.equal(h.menu().hidden, true, "点完先把菜单收起来");
  assert.deepEqual(h.statuses, ["正在收进表情包…", "已收进「表情包」"]);
  const collect = h.calls.filter((call) => call.path === "library/collect-sticker");
  assert.equal(collect.length, 1);
  assert.equal(collect[0].method, "POST");
  assert.equal(collect[0].payload.agentId, "nova");
  assert.equal(collect[0].payload.attachmentId, "att-1");
  assert.equal(h.calls.some((call) => call.path === "library/reference-use"), false, "纯收藏不许顺手授权");
});

test("自己的图：组合动作先收藏、后授权，顺序不许反", async () => {
  const h = setup({ api: async (call) => {
    if (call.path.startsWith("library/reference-use/")) return { ok: true, referenceUse: { allowed: false } };
    if (call.path === "library/collect-sticker") return { ok: true, forwarded: { ok: true } };
    if (call.path === "library/reference-use") return { ok: true, referenceUse: { allowed: true } };
    throw new Error(`没准备这个接口：${call.path}`);
  } });
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-2", senderRole: "user" }));
  await flush();
  assert.deepEqual(h.labels(), ["收进表情包", "收进表情包并允许参考"]);

  h.menu().children[1].click();
  await flush();
  const writes = h.calls.filter((call) => call.method === "POST").map((call) => call.path);
  assert.deepEqual(writes, ["library/collect-sticker", "library/reference-use"], "收藏没成功之前不许先授权");
  assert.equal(h.statuses.at(-1), "已收进「表情包」，已允许作为动作参考");
  const ref = h.calls.find((call) => call.path === "library/reference-use");
  assert.equal(ref.payload.agentId, "nova");
  assert.equal(ref.payload.attachmentId, "att-2");
  assert.equal(ref.payload.allowed, true);
});

test("失败只报那一部分：收藏没成不提授权，收藏成了授权没成就说没记下", async () => {
  // 收藏就失败：不往下走，也不去写授权。
  const failCollect = setup({ api: async (call) => {
    if (call.path === "library/collect-sticker") throw new Error("断网了");
    return { ok: true };
  } });
  failCollect.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-3", senderRole: "ta" }));
  failCollect.menu().children[0].click();
  await flush();
  assert.equal(failCollect.statuses.at(-1), "没存上：断网了");
  assert.equal(failCollect.calls.some((call) => call.path === "library/reference-use"), false);

  // 收藏成功、授权失败：收藏那句话要留着，不能整句吞掉。
  const failAuth = setup({ api: async (call) => {
    if (call.path === "library/collect-sticker") return { ok: true, forwarded: { ok: true } };
    if (call.path.startsWith("library/reference-use/")) return { ok: true, referenceUse: { allowed: false } };
    throw new Error("授权接口炸了");
  } });
  failAuth.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-4", senderRole: "user" }));
  await flush();
  failAuth.menu().children[1].click();
  await flush();
  assert.equal(failAuth.statuses.at(-1), "已收进「表情包」，但没记下参考授权：授权接口炸了");

  // 授权回包没确认：也按没记下说，不冒充成功。
  const noConfirm = setup({ api: async (call) => {
    if (call.path === "library/collect-sticker") return { ok: true, forwarded: { ok: true } };
    if (call.path.startsWith("library/reference-use/")) return { ok: true, referenceUse: { allowed: false } };
    return { ok: true, referenceUse: { allowed: false } };
  } });
  noConfirm.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-5", senderRole: "user" }));
  await flush();
  noConfirm.menu().children[1].click();
  await flush();
  assert.equal(noConfirm.statuses.at(-1), "已收进「表情包」，但没记下参考授权：没收到授权确认");
});

test("已经授权过的图：撤回只撤授权，收藏不动", async () => {
  const h = setup({ api: async (call) => {
    if (call.path.startsWith("library/reference-use/")) return { ok: true, referenceUse: { allowed: true } };
    if (call.path === "library/reference-use") return { ok: true, referenceUse: { allowed: false } };
    throw new Error(`不该调这个：${call.path}`);
  } });
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-6", senderRole: "user" }));
  await flush();
  assert.deepEqual(h.labels(), ["收进表情包", "撤回表情参考授权"]);

  h.menu().children[1].click();
  await flush();
  assert.equal(h.menu().hidden, true);
  const writes = h.calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 1, "撤回不重发收藏");
  assert.equal(writes[0].path, "library/reference-use");
  assert.equal(writes[0].payload.agentId, "nova");
  assert.equal(writes[0].payload.attachmentId, "att-6");
  assert.equal(writes[0].payload.allowed, false);
  assert.equal(h.statuses.at(-1), "已撤回参考授权，收藏保留");
});

test("不是自己的图：给不出「允许参考」这个组合", async () => {
  let asked = 0;
  const h = setup({ api: async (call) => {
    if (call.path.startsWith("library/reference-use/")) {
      asked += 1;
      return { ok: true, referenceUse: { allowed: true } };
    }
    return { ok: true, forwarded: { ok: true } };
  } });
  // 伙伴发的：连授权状态都不问。
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-7", attachmentOwner: "luna", senderRole: "ta" }));
  await flush();
  assert.equal(asked, 0);
  assert.deepEqual(h.labels(), ["收进表情包"]);
  h.context.closeImageCollectMenu();

  // 属主不是当前这位伙伴：就算回包说能授权，也不往这张菜单上添。
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-8", attachmentOwner: "luna", senderRole: "user" }));
  await flush();
  assert.equal(asked, 1);
  assert.deepEqual(h.labels(), ["收进表情包"]);
});

test("换到另一张图之后：上一张的旧回包不许写进这张菜单", async () => {
  const pendingGets = [];
  const h = setup({ api: (call) => {
    if (call.path.startsWith("library/reference-use/")) {
      return new Promise((resolve) => { pendingGets.push({ path: call.path, resolve }); });
    }
    if (call.path === "library/reference-use") return Promise.resolve({ ok: true, referenceUse: { allowed: true } });
    return Promise.resolve({ ok: true, forwarded: { ok: true } });
  } });
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-A", senderRole: "user" }));
  await flush();
  h.context.openImageCollectMenu(contextMenuEvent(), image({ attachmentId: "att-B", senderRole: "user" }));
  await flush();
  assert.equal(pendingGets.length, 2);

  // A 的旧回包先说「能授权」：它晚到了，只能被丢掉。
  pendingGets[0].resolve({ ok: true, referenceUse: { allowed: true } });
  await tick();
  assert.deepEqual(h.labels(), ["收进表情包"], "旧回包不许插进 B 的菜单");

  pendingGets[1].resolve({ ok: true, referenceUse: { allowed: false } });
  await tick();
  assert.deepEqual(h.labels(), ["收进表情包", "收进表情包并允许参考"]);

  // 按钮绑的必须是现在这张图。
  h.menu().children[1].click();
  await tick();
  const ref = h.calls.find((call) => call.path === "library/reference-use");
  assert.equal(ref.payload.attachmentId, "att-B");
  assert.equal(h.statuses.at(-1), "已收进「表情包」，已允许作为动作参考");
});
