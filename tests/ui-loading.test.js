import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

// Execute the actual inline functions, not copies of their implementation.
// This is an isolated DOM/API harness: no host, model, real network or user data.
const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
function functionSource(source, name, optional = false) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0 && optional) return "";
  assert.ok(start >= 0, `missing function ${name}`);
  const end = source.indexOf("\n    }", start);
  assert.ok(end >= start);
  return source.slice(start, end + 6);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const response = (ok = true, size = 10) => ({ ok, blob: async () => ({ size }) });

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false;
    this.className = ""; this._text = ""; this.writes = 0; this.layoutReads = 0;
    this.scrollTop = 0; this.clientHeight = 100; this.value = "";
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (...cs) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...cs])].join(" "); },
      remove: (...cs) => { this.className = this.className.split(/\s+/).filter((c) => !cs.includes(c)).join(" "); },
      toggle: (c, on) => { const next = on ?? !this.classList.contains(c); next ? this.classList.add(c) : this.classList.remove(c); return next; },
    };
  }
  get isConnected() { return this.root || Boolean(this.parentElement?.isConnected); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get src() { return this.attributes.src || ""; }
  set src(v) { this.attributes.src = v; this.writes++; }
  get scrollHeight() { this.layoutReads++; return 10000; }
  get textContent() { return this._text + this.children.map((n) => n.textContent).join(""); }
  set textContent(v) { this._text = String(v ?? ""); this.replaceChildren(); }
  get innerHTML() { return ""; }
  set innerHTML(html) {
    this.replaceChildren(); const stack = [this];
    for (const token of html.matchAll(/<\/?[\w-]+[^>]*>/g)) {
      const t = token[0];
      if (t.startsWith("</")) { stack.pop(); continue; }
      const n = new Node(/^<([\w-]+)/.exec(t)[1]);
      n.className = /class="([^"]*)"/.exec(t)?.[1] || "";
      n.hidden = /\bhidden\b/.test(t);
      stack.at(-1).appendChild(n);
      if (n.tagName !== "IMG" && n.tagName !== "BR") stack.push(n);
    }
  }
  appendChild(n) { return this.insertBefore(n, null); }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  prepend(n) { this.insertBefore(n, this.children[0] || null); }
  insertBefore(n, before) {
    n.remove(); const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, n);
    n.parentElement = this; this.writes++; return n;
  }
  remove() {
    if (this.parentElement) {
      const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1);
      parent.writes++; this.parentElement = null;
    }
  }
  replaceChildren(...ns) { this.children.forEach((n) => { n.parentElement = null; }); this.children = []; this.writes++; this.append(...ns); }
  setAttribute(k, v) { this.attributes[k] = String(v); this.writes++; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; this.writes++; }
  addEventListener(k, f) { (this.events[k] ||= []).push(f); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  getBoundingClientRect() { return { top: 0, width: 100 }; }
  cloneNode() { return new Node(this.tagName); }
  querySelectorAll(selector) {
    const matches = (n) => selector === "img" ? n.tagName === "IMG"
      : selector === "[data-avatar-want]" ? n.dataset.avatarWant !== undefined
      : selector.startsWith(".") && selector.slice(1).split(".").every((c) => n.classList.contains(c));
    const all = this.children.flatMap((n) => [n, ...n.querySelectorAll("*")]);
    return selector === "*" ? all : all.filter(matches);
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}
function avatarBox(root) {
  const box = new Node(); const ph = new Node("span"), im = new Node("img");
  ph.className = "ph"; im.className = "im"; im.hidden = true; box.append(ph, im);
  root?.appendChild(box); return box;
}
function avatarHarness(source = panel) {
  let calls = 0, now = 1000, counter = 0;
  const requests = [], revoked = [], images = [], root = new Node(); root.root = true;
  const listeners = {};
  const context = vm.createContext({
    console, AbortSignal, setTimeout, clearTimeout,
    Date: { now: () => now },
    document: { querySelectorAll: (s) => root.querySelectorAll(s) },
    window: { addEventListener: (k, f) => { listeners[k] = f; } },
    URL: { createObjectURL: () => `blob:test-${++counter}`, revokeObjectURL: (url) => revoked.push(url) },
    Image: class {
      set src(v) { this._src = v; images.push(this); if (!this.hold) queueMicrotask(() => this.onload?.()); }
      get src() { return this._src; }
    },
    hana: { api: { fetch: () => { calls++; const r = deferred(); requests.push(r); return r.promise; } } },
  });
  // Include avatar state and cleanup from the real source as well.
  const state = source === panel
    ? source.slice(source.indexOf("const AVATAR_TTL_MS"), source.indexOf("    /**\n     * 表情包："))
    : source.slice(source.indexOf("const AVATAR_TTL_MS"), source.indexOf("    function saveGlobal("));
  vm.runInContext(`const avatarCache = new Map();\n${state.replace(/const avatarCache = new Map\(\);/, "")}\n${source === panel ? functionSource(panel, "applyAvatarImage", true) + "\n" + functionSource(panel, "paintAvatar") : ""}`, context);
  return {
    context, root, requests, revoked, images, listeners,
    get calls() { return calls; }, expire() { now += 300001; },
    load: (id) => context.loadAvatar(id), paint: (...args) => context.paintAvatar(...args),
    async settleAll(ok = true, size = 10) { requests.forEach((r) => r.resolve(response(ok, size))); await flush(); },
  };
}

for (const [page, source] of [["panel", panel], ["settings", settings]]) {
  test(`${page}: 20 simultaneous cold avatar calls share one fetch; warm adds zero`, async (t) => {
    const h = avatarHarness(source);
    const tasks = Array.from({ length: 20 }, () => h.load("partner-a"));
    const cold = h.calls; await h.settleAll(); await Promise.all(tasks);
    const before = h.calls; await Promise.all(Array.from({ length: 20 }, () => h.load("partner-a")));
    t.diagnostic(`cold=${cold}, warm=${h.calls - before}`);
    assert.equal(cold, 1); assert.equal(h.calls - before, 0);
  });
  test(`${page}: unsuccessful avatars are immediately retryable`, async () => {
    for (const [ok, size] of [[false, 10], [true, 0]]) {
      const h = avatarHarness(source); const first = h.load("partner-a");
      await h.settleAll(ok, size); assert.equal(await first, null);
      const next = h.load("partner-a"); await h.settleAll(); await next;
      assert.equal(h.calls, 2);
    }
  });
  test(`${page}: refresh failure retains the successful cache and permits retry`, async () => {
    const h = avatarHarness(source); const first = h.load("partner-a"); await h.settleAll(); const old = await first;
    h.expire(); const refresh = h.load("partner-a"); await h.settleAll(false);
    assert.equal(await refresh, old); assert.ok(!h.revoked.includes(old));
    const retry = h.load("partner-a"); await h.settleAll(); await retry; assert.equal(h.calls, 3);
  });
}

for (const [page, source] of [["panel", panel], ["settings", settings]]) {
  test(`${page}: persisted page suspension keeps avatar URLs available`, async () => {
    const h = avatarHarness(source); const first = h.load("partner-a");
    await h.settleAll(); const url = await first;
    h.listeners.pagehide?.({ persisted: true });
    assert.equal(await h.load("partner-a"), url);
    assert.equal(h.revoked.length, 0);
    h.listeners.pagehide?.({ persisted: false });
    assert.ok(h.revoked.includes(url));
  });
  test(`${page}: stalled image decode is bounded and leaves the request retryable`, async () => {
    const h = avatarHarness(source); const timers = [];
    h.context.setTimeout = (callback) => { timers.push(callback); return timers.length; };
    h.context.clearTimeout = () => {};
    h.context.Image = class { set src(_value) {} };
    const first = h.load("partner-a"); await h.settleAll();
    assert.equal(timers.length, 1);
    timers[0](); assert.equal(await first, null);
    const retry = h.load("partner-a"); await h.settleAll();
    assert.equal(h.calls, 2);
    timers[1](); assert.equal(await retry, null);
    assert.equal(h.revoked.length, 2);
  });
}

test("warm message avatar is painted synchronously, including a detached node", async () => {
  const h = avatarHarness(); const task = h.load("partner-a"); await h.settleAll(); const url = await task;
  const box = avatarBox(); const painting = h.paint(box, "partner-a", "A");
  assert.equal(box.querySelector(".im").src, url); assert.equal(box.querySelector(".im").hidden, false);
  await painting;
});

test("switching avatar owner clears the old face immediately and ignores the old response", async () => {
  const h = avatarHarness(), box = avatarBox(h.root);
  const first = h.paint(box, "partner-a", "A"); await h.settleAll(); await first;
  const second = h.paint(box, "partner-b", "B");
  assert.equal(box.querySelector(".im").src, ""); assert.equal(box.querySelector(".ph").hidden, false);
  const third = h.paint(box, "partner-c", "C");
  h.requests.at(-1).resolve(response()); await flush(); await third;
  const currentUrl = box.querySelector(".im").src;
  h.requests[1].resolve(response()); await second;
  assert.equal(box.querySelector(".im").src, currentUrl); assert.equal(box.dataset.avatarWant, "partner-c");
});

test("expired avatar stays visible until image load; retired URL waits for visible references", async () => {
  const h = avatarHarness(), box = avatarBox(h.root);
  const first = h.paint(box, "partner-a", "A"); await h.settleAll(); await first;
  const old = box.querySelector(".im").src;
  // An unrelated visible image may still reference that URL.
  const other = new Node("img"); other.src = old; h.root.appendChild(other);
  h.expire(); const refresh = h.paint(box, "partner-a", "A");
  assert.equal(box.querySelector(".im").src, old);
  h.context.Image = class { set src(v) { this._src = v; h.images.push(this); } };
  h.requests.at(-1).resolve(response()); await flush();
  assert.equal(box.querySelector(".im").src, old); assert.ok(!h.revoked.includes(old));
  h.images.at(-1).onload?.(); await refresh;
  assert.notEqual(box.querySelector(".im").src, old); assert.ok(!h.revoked.includes(old));
  other.remove(); await h.paint(box, "partner-a", "A");
  assert.ok(h.revoked.includes(old));
});

test("image decode failure preserves old face and does not cache failure", async () => {
  const h = avatarHarness(), box = avatarBox(h.root);
  const first = h.paint(box, "partner-a", "A"); await h.settleAll(); await first;
  const old = box.querySelector(".im").src; h.expire();
  h.context.Image = class { set src(v) { this._src = v; queueMicrotask(() => this.onerror?.()); } };
  const refresh = h.paint(box, "partner-a", "A"); await h.settleAll(); await refresh;
  assert.equal(box.querySelector(".im").src, old);
  const retry = h.load("partner-a"); await h.settleAll(); await retry; assert.equal(h.calls, 3);
});

test("pagehide revokes owned avatar URLs, including late responses", async () => {
  const h = avatarHarness(); const first = h.load("partner-a"); await h.settleAll(); const url = await first;
  const late = h.load("partner-b"); h.listeners.pagehide?.();
  await h.settleAll(); await late;
  assert.ok(h.revoked.includes(url)); assert.equal(new Set(h.revoked).size, h.revoked.length);
  assert.equal(await h.load("partner-a"), null); assert.equal(h.calls, 2);
});

test("closed page avatar paint is a no-op and cannot start new requests", async () => {
  const h = avatarHarness(), box = avatarBox(h.root);
  const first = h.paint(box, "partner-a", "A"); await h.settleAll(); await first;
  h.listeners.pagehide?.({ persisted: false });
  const writes = box.querySelectorAll("*").reduce((sum, node) => sum + node.writes, 0);
  await h.paint(box, "partner-b", "B");
  assert.equal(h.calls, 1);
  assert.equal(box.querySelectorAll("*").reduce((sum, node) => sum + node.writes, 0), writes);
});

function panelHarness(names) {
  const root = new Node(); root.root = true;
  const el = new Proxy({}, { get: (obj, k) => obj[k] ||= root.appendChild(new Node()) });
  const binds = [], mounts = [], states = [], paints = [], opened = [], statuses = [], requests = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Date, Audio: class { addEventListener() {} },
    el, document: { createElement: (tag) => new Node(tag), querySelectorAll: (s) => root.querySelectorAll(s), body: root },
    partners: [], current: "partner-a", currentMessages: [], seenIds: new Set(), voiceStates: new Map(),
    partnerFeedNodes: new Map(), userCols: new Map(), tickNodes: new Map(), pendingDrafts: new Map(),
    actionEmoji: new Map(), liveDots: null, autoScrollAllowed: true, renderingAll: false,
    lastRenderedConversationAt: null, paintedWithAvatars: null, showMessageAvatars: false,
    renderGeneration: 0, SCROLL_BOTTOM_GAP: 24, TIME_DIVIDER_GAP_MS: 600000, SHOW_UNREAD_BADGES: true,
    draggedPartnerId: "", draggedPartnerNode: null, dragOriginIds: [], dragCommitted: false,
    partnerOrderRevision: 0, orderSavePending: false, openPartnerSeq: 0, threadViewSeq: 0,
    imageChoiceSeq: 0, inputRevision: 0, inputOwner: null, obPending: new Set(),
    bindMessageActions: (...args) => binds.push(["actions", ...args]),
    bindMessageFeed: (...args) => binds.push(["feed", ...args]),
    renderMessageFeed: (...args) => binds.push(["message-feed", ...args]),
    renderPartnerFeed: (...args) => binds.push(["partner-feed", ...args]),
    isLatestUserMessage: () => true, isLatestAssistantMessage: () => true,
    messageCopyText: (m) => m.text || m.voice?.text || "",
    mountAttachmentImage: (...args) => mounts.push(args),
    paintStateBadge: (...args) => states.push(args), paintStatePin: (...args) => states.push(args),
    paintAvatar: (...args) => paints.push(args), openPartner: (id) => opened.push(id),
    api: (method, path) => { const r = deferred(); requests.push({ path, ...r }); return r.promise; },
    loadPartners: () => { const r = deferred(); requests.push({ path: "partners", ...r }); return r.promise; },
    setStatus: (text) => statuses.push(text), syncChatBackground: () => {}, reportRead: () => {},
    savePartnerOrder: async () => {},
  });
  for (const n of ["rememberComposerDraft", "clearPendingQuote", "autosizeInput", "closeMessageActions", "foldAfterPick", "closeAppearance", "clearPendingImage", "clearPendingSticker", "renderStickerTabs", "closeEmojiDrawer", "clearChatBackground", "reconcilePendingImage"]) context[n] = () => {};
  const actual = names.map((n) => functionSource(panel, n)).join("\n");
  vm.runInContext(actual, context);
  return { context, root, el, binds, mounts, states, paints, opened, statuses, requests };
}
const renderFunctions = ["renderAll", "invalidateRendering", "renderMessage", "renderAction", "renderVoiceMessage", "bubble", "place", "messageTime", "bubbleTimeText", "timeDivider", "timeDividerText", "stickerIdOf", "isBareImageMarker", "isBareStickerMarker", "readUserIds", "scrollDown", "updateJumpBottom", "isAtBottom", "tick", "formatVoiceDuration", "appendImageToBubble"];
function renderHarness() {
  const h = panelHarness(renderFunctions);
  vm.runInContext('const STICKER_PREFIX = "\\u0001stk:"; const BARE_IMAGE_MARKER_RE = /^\\[图片\\]$/; const BARE_MARKER_RE = /^\\[表情\\]$/;', h.context);
  return h;
}
test("1000 history messages cause only final layout reads, with no history truncation", (t) => {
  const h = renderHarness(); const list = Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, role: "assistant", text: "message" }));
  h.context.renderAll(list); t.diagnostic(`messages=${h.context.seenIds.size}, scrollHeight reads=${h.el.stream.layoutReads}`);
  assert.equal(h.context.seenIds.size, 1000); assert.equal(h.el.stream.children.length, 1000);
  assert.ok(h.el.stream.layoutReads <= 4); assert.equal(h.el.stream.scrollTop, 10000);
});
test("batch redraw preserves voice, image, action and feed bindings and restores the batch flag", () => {
  const h = renderHarness();
  const list = [
    { id: "action", kind: "action", role: "assistant", text: "action" },
    { id: "voice", role: "assistant", voice: { status: "pending", text: "voice" } },
    { id: "image", role: "user", text: "image", attachment: { id: "attachment-a" } },
    { id: "text", role: "assistant", bubbles: ["one", "two"] },
  ];
  h.context.renderAll(list);
  assert.equal(h.context.seenIds.size, 4); assert.equal(h.mounts[0][2], "partner-a");
  for (const id of ["action", "voice", "image", "text"]) assert.ok(h.binds.some((b) => b[0] === "actions" && b[2].id === id));
  assert.equal(h.binds.filter((b) => b[0] === "feed").length, 3);
  assert.equal(h.context.renderingAll, false);
  const play = h.el.stream.querySelector(".voice-play"); assert.ok(play?.disabled);
  h.context.renderMessage = () => { throw new Error("render failed"); };
  assert.throws(() => h.context.renderAll([{ id: "failure" }]), /render failed/);
  assert.equal(h.context.renderingAll, false);
});

test("friend polls reuse nodes and content; changed state updates aria and uses latest partner", async (t) => {
  const h = panelHarness(["renderFriends"]);
  h.context.partners = [{ id: "partner-a", name: "A", unread: 1 }, { id: "partner-b", name: "B" }];
  h.context.renderFriends(); const nodes = [...h.el.friends.children]; const stateCalls = h.states.length;
  const beforeWrites = h.root.querySelectorAll("*").reduce((n, x) => n + x.writes, 0);
  for (let i = 0; i < 20; i++) { h.context.partners = h.context.partners.map((p) => ({ ...p })); h.context.renderFriends(); }
  const afterWrites = h.root.querySelectorAll("*").reduce((n, x) => n + x.writes, 0);
  t.diagnostic(`unchanged polls=20, state repaints=${h.states.length - stateCalls}, DOM writes=${afterWrites - beforeWrites}`);
  assert.ok(h.el.friends.children[0] === nodes[0]); assert.ok(h.el.friends.children[1] === nodes[1]);
  assert.equal(h.states.length, stateCalls); assert.equal(afterWrites, beforeWrites);
  h.context.current = "partner-b";
  h.context.partners = [{ id: "partner-b", name: "B-new", unread: 0 }, { id: "partner-a", name: "A-new", unread: 102, lastMessage: { text: "new preview" } }];
  h.context.renderFriends(); assert.equal(h.el.friends.children[0], nodes[1]);
  assert.equal(nodes[0].querySelector(".hint").textContent, "new preview");
  assert.match(nodes[0].getAttribute("aria-label"), /A-new，99\+ 条没看/);
  assert.ok(nodes[1].classList.contains("active")); assert.equal(nodes[0].events.click.length, 1);
  await nodes[0].events.keydown[0]({ key: "Enter", preventDefault() {} }); assert.equal(h.opened.at(-1), "partner-a");
  h.context.partners = [h.context.partners[0]]; h.context.renderFriends(); assert.equal(h.el.friends.children.length, 1);
});

test("removed friend reappearing with the same id receives a fresh node", () => {
  const h = panelHarness(["renderFriends"]);
  h.context.partners = [{ id: "partner-a", name: "A", unread: 3 }];
  h.context.renderFriends(); const old = h.el.friends.children[0];
  h.context.partners = []; h.context.renderFriends();
  h.context.partners = [{ id: "partner-a", name: "A-new", unread: 0 }];
  h.context.renderFriends(); const fresh = h.el.friends.children[0];
  assert.notEqual(fresh, old);
  assert.equal(fresh.querySelector(".name").textContent, "A-new");
  assert.equal(fresh.querySelector(".badge").hidden, true);
  assert.equal(fresh.events.click.length, 1);
});

test("reused friend nodes retain drag ordering and save bindings", async () => {
  const h = panelHarness(["renderFriends"]);
  h.context.partners = ["partner-a", "partner-b"].map((id) => ({ id, name: id }));
  h.context.renderFriends(); const [a, b] = h.el.friends.children; h.context.renderFriends();
  const event = { dataTransfer: { setData() {}, setDragImage() {} }, offsetX: 0, offsetY: 0, preventDefault() {}, clientY: 10 };
  a.events.dragstart[0](event); b.events.dragover[0](event);
  assert.equal(h.context.partners[0].id, "partner-b"); assert.ok(h.el.friends.children[1] === a);
  await b.events.drop[0](event); a.events.dragend[0]();
  assert.equal(h.context.partnerOrderRevision, 1); assert.equal(h.context.draggedPartnerId, "");
  assert.equal(a.style.opacity, "");
});

function openHarness() {
  const h = panelHarness(["openPartner"]); h.context.current = null;
  h.context.partners = [{ id: "partner-a", name: "A" }, { id: "partner-b", name: "B" }];
  h.context.renderFriends = () => {}; h.context.renderAll = (list) => { h.context.painted = list; };
  return h;
}
test("opening chat prewarms the user avatar without delaying thread loading", async () => {
  const h = openHarness(); const prewarmed = [];
  h.context.showMessageAvatars = true;
  h.context.loadAvatar = async (id) => { prewarmed.push(id); return null; };
  const task = h.context.openPartner("partner-a");
  assert.deepEqual(prewarmed, ["__user"]);
  assert.equal(h.requests[0].path, "thread/partner-a");
  h.requests[0].resolve({ messages: [] }); await task;
  h.requests.find((r) => r.path === "partners")?.resolve({});
});

test("opening thread finishes without waiting for unrelated partners refresh", async () => {
  const h = openHarness(); let done = false;
  const task = h.context.openPartner("partner-a").then(() => { done = true; });
  h.requests[0].resolve({ messages: [{ id: "a-message" }] }); await flush();
  const finishedBeforeList = done;
  h.requests.find((r) => r.path === "partners")?.resolve({}); await task;
  assert.ok(finishedBeforeList); assert.equal(h.context.painted[0].id, "a-message");
});
test("unrelated friend list failure does not turn an opened chat into an error", async () => {
  const h = openHarness(); const task = h.context.openPartner("partner-a");
  h.requests[0].resolve({ messages: [{ id: "a-message" }] }); await task;
  const statuses = [...h.statuses];
  h.requests.find((r) => r.path === "partners").reject(new Error("offline"));
  await flush();
  assert.deepEqual(h.statuses, statuses);
  assert.equal(h.context.painted[0].id, "a-message");
});

test("rapid A-B switch and removed current partner reject stale thread responses", async () => {
  const h = openHarness(); const a = h.context.openPartner("partner-a"), b = h.context.openPartner("partner-b");
  h.requests[1].resolve({ messages: [{ id: "b-message" }] }); await flush();
  h.requests.find((r) => r.path === "partners")?.resolve({}); await b;
  h.requests[0].resolve({ messages: [{ id: "a-message" }] }); await a;
  assert.equal(h.context.painted[0].id, "b-message");
  h.context.current = null; const again = h.context.openPartner("partner-a");
  const pending = h.requests.at(-1); h.context.current = null; h.context.threadViewSeq++;
  pending.resolve({ messages: [{ id: "removed-message" }] }); await flush();
  h.requests.filter((r) => r.path === "partners").forEach((r) => r.resolve({})); await again;
  assert.equal(h.context.painted[0].id, "b-message");
});
