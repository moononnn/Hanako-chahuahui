import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { generateMobilePassword } from "../lib/mobile-access.js";
import { buttonThemeFromSample } from "../ui/assets/background-adaptive.js";

import {
  FEED_EMOJIS,
  LONG_PRESS_CLICK_SUPPRESS_MS,
  LONG_PRESS_MS,
  MOBILE_API_TIMEOUT_MS,
  MOBILE_IMAGE_MAX_BYTES,
  MOBILE_PAGE_MORE,
  MOBILE_PAGE_SIZE,
  MOBILE_TOKEN_TTL_MS,
  MOBILE_TURN_MAX_JSON_BYTES,
  MOBILE_BACKGROUND_TONE,
  MOBILE_QUOTE_MAX,
  BACKGROUND_THEME_VARS,
  backgroundImageKey,
  backgroundLayer,
  backgroundThemeVars,
  backgroundVeil,
  normalizeApiError,
  actionableMessage,
  anchorAfterPrepend,
  applyThreadPage,
  buildTurnPayload,
  claimSinglePlayback,
  createRequestTracker,
  createSendQueue,
  createThreadState,
  earliestSeq,
  feedSignatureOf,
  feedableMessage,
  fitsTurnLimit,
  formatDuration,
  formatMessageFeed,
  hasSendableContent,
  isNearBottom,
  menuPlacement,
  messageFeedItems,
  messageTextOf,
  parseThreadEvent,
  pickDraftImage,
  playVoice,
  readReceiptThrough,
  readTokenState,
  recallLabelOf,
  deliveredClientIds,
  pullLimit,
  selectedTextOf,
  shouldLoadOlder,
  showNote,
  signatureOf,
  startMobileClient,
  stickerIdOf,
  validateImageFile,
  visiblePartnerFeedItems,
  writeTokenState,
} from "../ui/assets/mobile-client.js";

// 这一组只跑纯逻辑（无 DOM、无网络、无 apply）。页面装配在 startMobileClient 里，
// 这里一行都不碰——所以能在测试进程里安全跑。

const msg = (over = {}) => ({
  id: "m1",
  seq: 1,
  role: "assistant",
  kind: null,
  text: "在呢",
  at: "2026-10-30T10:00:00.000Z",
  ...over,
});

// ── 请求归属与世代 ─────────────────────────────────────────────

test("切伙伴：旧 pull 的令牌当场作废，回来的结果不许写进新伙伴", () => {
  const tracker = createRequestTracker();
  const pullA = tracker.begin("pull:A");
  assert.equal(tracker.isCurrent(pullA), true);

  tracker.bump(); // 切到 B
  const pullB = tracker.begin("pull:B");

  assert.equal(tracker.isCurrent(pullA), false, "A 的结果作废");
  assert.equal(pullA.controller.signal.aborted, true, "在飞的请求被中止");
  assert.equal(tracker.isCurrent(pullB), true, "B 的令牌有效");

  // 即使 A 的回包真回来了，也不落进 B 的线程
  let state = createThreadState();
  state = applyThreadPage(state, { agentId: "B", page: { messages: [msg({ id: "b1", seq: 1 })] } });
  const before = signatureOf(state.messages);
  const accepted = tracker.isCurrent(pullA);
  const after = accepted
    ? applyThreadPage(state, { agentId: "A", page: { messages: [msg({ id: "a1", seq: 1 })] } })
    : state;
  assert.equal(signatureOf(after.messages), before, "A 的内容没混进 B");
  assert.deepEqual(after.messages.map((row) => row.id), ["b1"]);
});

test("同一伙伴重叠请求：后发的顶掉先发的，旧结果不许覆盖新结果", () => {
  const tracker = createRequestTracker();
  const first = tracker.begin("pull:A");
  const second = tracker.begin("pull:A");
  assert.equal(tracker.isCurrent(first), false);
  assert.equal(first.controller.signal.aborted, true, "旧请求被 abort，不再占带宽");
  assert.equal(tracker.isCurrent(second), true);

  // 旧的那次即使晚到再 settle，也不能把新的从表里摘掉
  tracker.settle(first);
  assert.equal(tracker.isCurrent(second), true);
  tracker.settle(second);
  assert.equal(tracker.isCurrent(second), false, "结束后就不算当前");
});

test("不同 key（拉线程 / 拉贴纸）互不顶掉，切伙伴时一起作废", () => {
  const tracker = createRequestTracker();
  const pull = tracker.begin("pull:A");
  const stickers = tracker.begin("stickers:A");
  assert.equal(tracker.isCurrent(pull), true);
  assert.equal(tracker.isCurrent(stickers), true);
  tracker.bump();
  assert.equal(tracker.isCurrent(pull), false);
  assert.equal(tracker.isCurrent(stickers), false);
});

// ── 渲染签名：比内容，不比 id ──────────────────────────────────

test("签名看正文：改稿、撤回、语音状态、图片、引用都会触发重建", () => {
  const base = signatureOf([msg()]);
  assert.notEqual(signatureOf([msg({ text: "改口了" })]), base, "同一条 id 改了正文");
  assert.notEqual(signatureOf([msg({ recalled: true, recallMode: "soft" })]), base, "撤回状态变了");
  assert.notEqual(
    signatureOf([msg({ voice: { status: "pending", durationMs: 1200, text: "" } })]),
    base,
    "语音从无到有",
  );
  assert.notEqual(
    signatureOf([msg({ voice: { status: "ready", durationMs: 1200, text: "" } })]),
    signatureOf([msg({ voice: { status: "pending", durationMs: 1200, text: "" } })]),
    "语音 pending→ready 也得重建",
  );
  assert.notEqual(
    signatureOf([msg({ attachment: { id: "a1", name: "猫.png", mimeType: "image/png" } })]),
    base,
    "图片消息出现",
  );
  assert.notEqual(
    signatureOf([msg({ quote: { messageId: "m0", text: "你刚说啥" } })]),
    base,
    "引用条出现",
  );
  assert.notEqual(signatureOf([msg({ bubbles: ["在", "呢"] })]), base, "气泡拆条变了");
});

test("只有时间戳变不重建：一遍下拉不会白闪，也不会把滚动位置弄丢", () => {
  assert.equal(signatureOf([msg({ at: "2026-10-31T00:00:00.000Z" })]), signatureOf([msg()]));
});

// ── 分页与滚动 ────────────────────────────────────────────────

test("分页：首屏替换、上翻前置，按 seq 排序、按 id 去重、跨伙伴不收", () => {
  let state = createThreadState();
  state = applyThreadPage(state, {
    agentId: "A",
    page: { messages: [msg({ id: "m3", seq: 3 }), msg({ id: "m2", seq: 2 })], total: 4, hasMore: true },
  });
  assert.deepEqual(state.messages.map((row) => row.id), ["m2", "m3"], "按 seq 正序");
  assert.equal(state.total, 4);
  assert.equal(state.hasMore, true);

  state = applyThreadPage(state, {
    agentId: "A",
    page: { messages: [msg({ id: "m1", seq: 1 }), msg({ id: "m2", seq: 2 })], total: 4, hasMore: false },
    mode: "prepend",
  });
  assert.deepEqual(state.messages.map((row) => row.id), ["m1", "m2", "m3"], "老记录接在前面，重复的 m2 只留一份");
  assert.equal(state.hasMore, false);

  const untouched = applyThreadPage(state, {
    agentId: "B",
    page: { messages: [msg({ id: "x1", seq: 9 })] },
    mode: "prepend",
  });
  assert.equal(untouched, state, "换伙伴后的上翻结果直接丢");

  assert.equal(earliestSeq(state.messages), 1);
  assert.equal(earliestSeq([]), null);
  assert.equal(earliestSeq([{ id: "no-seq" }]), null, "没有 seq 就别瞎猜游标");
});

test("滚动判定：贴底才自动滚，上翻只在快贴顶时发请求", () => {
  assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1400, clientHeight: 500 }), true);
  assert.equal(isNearBottom({ scrollTop: 700, scrollHeight: 1400, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollTop: 890, scrollHeight: 1400, clientHeight: 500 }), true, "留 48px 容差");

  assert.equal(shouldLoadOlder({ scrollTop: 30 }, { hasMore: true }), true);
  assert.equal(shouldLoadOlder({ scrollTop: 400 }, { hasMore: true }), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, { hasMore: false }), false, "没更多就别问");
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, { hasMore: true, loading: true }), false, "正在翻就别叠");

  // 前面插进一屏老记录后，把原来那条钉在原处
  assert.equal(anchorAfterPrepend({ prevHeight: 1000, prevTop: 0, nextHeight: 1600 }), 600);
});

// ── 选图与发送 ────────────────────────────────────────────────

test("选图先在本机挡一道：类型、大小、空文件", () => {
  assert.equal(validateImageFile({ type: "image/png", size: 1024 }).ok, true);
  assert.equal(validateImageFile({ type: "image/gif", size: 1024 }).ok, true);
  assert.equal(validateImageFile({ type: "image/svg+xml", size: 1024 }).ok, false, "SVG 不当图片发");
  assert.equal(validateImageFile({ type: "image/png", size: 0 }).ok, false);
  const big = validateImageFile({ type: "image/png", size: MOBILE_IMAGE_MAX_BYTES + 1 });
  assert.equal(big.ok, false);
  assert.match(big.reason, /MB/);
});

test("发送体：文本 / 贴纸 / 图片 / 引用，空内容不许发", () => {
  const text = buildTurnPayload({ agentId: " A ", text: " 在吗 ", clientMessageId: "cid_1" });
  assert.deepEqual(text, { agentId: "A", clientMessageId: "cid_1", text: "在吗" });
  assert.equal(hasSendableContent(text), true);

  const sticker = buildTurnPayload({ agentId: "A", stickerId: "stk_1", clientMessageId: "cid_2" });
  assert.equal(sticker.stickerId, "stk_1");
  assert.equal(sticker.text, undefined, "只发贴纸就不带空 text");

  const image = buildTurnPayload({
    agentId: "A",
    image: { data: "AAA", mimeType: "image/png", name: "猫.png" },
    clientMessageId: "cid_3",
  });
  assert.deepEqual(image.image, { data: "AAA", mimeType: "image/png", name: "猫.png" });

  const quoted = buildTurnPayload({
    agentId: "A",
    text: "嗯",
    quote: { messageId: "m9", text: "x".repeat(5000) },
    clientMessageId: "cid_4",
  });
  assert.equal(quoted.quote.messageId, "m9");
  assert.equal(quoted.quote.text.length, 4000, "引用正文按宿主上限截断");

  assert.equal(hasSendableContent(buildTurnPayload({ agentId: "A", text: "   ", clientMessageId: "c" })), false);
  assert.equal(hasSendableContent(null), false);
});

test("发送队列：不许重叠，失败后重试复用同一个 clientMessageId 与原内容", () => {
  const queue = createSendQueue();
  const payload = buildTurnPayload({ agentId: "A", text: "在吗", clientMessageId: "cid_keep" });
  const first = queue.begin({ clientMessageId: "cid_keep", agentId: "A", payload });
  assert.ok(first);
  assert.equal(queue.begin({ clientMessageId: "cid_other", agentId: "A", payload }), null, "上一条还在发就挡住");

  const failed = queue.fail();
  assert.equal(failed.clientMessageId, "cid_keep");
  const plan = queue.retryPlan();
  assert.equal(plan.clientMessageId, "cid_keep", "重试必须是同一张票，宿主据此去重");
  assert.equal(plan.agentId, "A", "重试还记得原本发给谁");
  assert.deepEqual(plan.payload, payload, "原始内容不丢");
  assert.equal(plan.payload.text, "在吗");

  // 重试用同一张票再发一次
  const again = queue.begin({ clientMessageId: plan.clientMessageId, agentId: plan.agentId, payload: plan.payload });
  assert.ok(again);
  assert.equal(queue.retryPlan(), null, "重新开始发之后旧票清掉");
  queue.done();
  assert.equal(queue.current(), null);
});

test("没有 clientMessageId 就不许入队（幂等的前提）", () => {
  const queue = createSendQueue();
  assert.equal(queue.begin({ agentId: "A", payload: { text: "x" } }), null);
  assert.equal(queue.begin({ clientMessageId: "c", agentId: "", payload: { text: "x" } }), null);
});

// ── 已读回执 ─────────────────────────────────────────────────

test("图片字段按约定形状：name/mimeType/data，尺寸有就带、不合法就不带", () => {
  const shot = buildTurnPayload({
    agentId: "A",
    image: { name: "猫.png", mimeType: "image/png", data: "AAA", width: 800, height: 600 },
    clientMessageId: "cid_img",
  });
  assert.deepEqual(shot.image, { name: "猫.png", mimeType: "image/png", data: "AAA", width: 800, height: 600 });

  const bare = buildTurnPayload({
    agentId: "A",
    image: { name: "猫.png", mimeType: "image/png", data: "AAA", width: 0, height: Number.NaN },
    clientMessageId: "cid_img2",
  });
  assert.deepEqual(bare.image, { name: "猫.png", mimeType: "image/png", data: "AAA" }, "0/NaN 不当尺寸");
});

test("turn.send 的 JSON 上限：图片加正文叠在一起也不越 16MiB", () => {
  const shot = buildTurnPayload({
    agentId: "A",
    image: { name: "猫.png", mimeType: "image/png", data: "A".repeat(1024) },
    text: "看看这个",
    clientMessageId: "cid_size",
  });
  assert.equal(fitsTurnLimit(shot), true);
  assert.equal(fitsTurnLimit(shot, 8), false, "超了就不发，不靠宿主回 413");
  assert.equal(fitsTurnLimit(null), false);
  assert.ok(MOBILE_TURN_MAX_JSON_BYTES === 16 * 1024 * 1024);
});

test("撤回的行一律不摆原文：按谁撤回的给一句，桌面给了占位就用它", () => {
  assert.equal(recallLabelOf({ role: "user", recalled: true, text: "原话在这" }), "你撤回了一条消息");
  assert.equal(recallLabelOf({ role: "assistant", recalled: true, text: "原话在这" }, { partnerName: "小花" }), "小花撤回了一条消息");
  assert.equal(recallLabelOf({ role: "assistant", recalled: true, text: "原话在这" }), "对方撤回了一条消息");
  assert.equal(
    recallLabelOf({ role: "assistant", recalled: true, recallLabel: "小花撤回了一条消息" }, { partnerName: "小花" }),
    "小花撤回了一条消息",
    "宿主已经换了占位就用它的",
  );
  assert.doesNotMatch(recallLabelOf({ role: "assistant", recalled: true, text: "原话在这" }), /原话/);
});

test("改稿后重新拉取：新正文进签名，旧正文不会留在屏幕上", () => {
  const before = [msg({ id: "m1", text: "我再想想" })];
  const after = applyThreadPage(createThreadState(), {
    agentId: "A",
    page: { messages: [msg({ id: "m1", text: "想好了，就按你说的" })], total: 1, hasMore: false },
  });
  assert.equal(after.messages[0].id, "m1", "改稿是原地改，id 不变");
  assert.notEqual(signatureOf(after.messages), signatureOf(before), "所以签名必须比正文");
});

test("轮询不会把已上翻的窗口抹回 50 条：50 → 上翻 100 → poll 仍然 150", () => {
  // 造 150 条，模拟宿主按 limit 返回最近那一段
  const all = Array.from({ length: 150 }, (_, i) => msg({ id: `m${i + 1}`, seq: i + 1, text: `第${i + 1}条` }));
  const hostPage = (limit, before = null) => {
    const pool = before == null ? all : all.filter((row) => row.seq < before);
    const rows = pool.slice(-limit);
    // hasMore 指的是「这一页之外还有没有更早的」，不是总条数；上翻拿完了就该 false
    return { messages: rows, total: all.length, hasMore: rows.length < pool.length };
  };

  // 首屏：limit=50，只拿到最近 50 条，还能往上翻
  let state = applyThreadPage(createThreadState(), {
    agentId: "A",
    page: hostPage(pullLimit(0)),
    mode: "replace",
  });
  assert.equal(state.messages.length, 50);
  assert.equal(state.hasMore, true);

  // 上翻：拿 before=最早 seq 的前 100 条
  state = applyThreadPage(state, {
    agentId: "A",
    page: hostPage(MOBILE_PAGE_MORE, earliestSeq(state.messages)),
    mode: "prepend",
  });
  assert.equal(state.messages.length, 150, "上翻后已加载 150 条");
  assert.equal(state.hasMore, false);

  // 20 秒后的 poll（或一条 SSE）：limit 就按已加载数（150），不再额外加一屏
  const pollLimit = pullLimit(state.messages.length);
  assert.equal(pollLimit, 150, "已加载 150 条就要 150，不多要");
  state = applyThreadPage(state, { agentId: "A", page: hostPage(pollLimit), mode: "replace" });
  assert.equal(state.messages.length, 150, "窗口没被抹掉");
  assert.equal(state.messages[0].id, "m1", "最早那条还在");
  assert.equal(state.messages.at(-1).id, "m150");

  // 原地改稿：同 id 新正文，replace 后拿到的就是新话
  const edited = all.map((row) => (row.id === "m150" ? { ...row, text: "改过的说法" } : row));
  const editedPage = { messages: edited.slice(-pollLimit), total: edited.length, hasMore: false };
  const editedState = applyThreadPage(state, { agentId: "A", page: editedPage, mode: "replace" });
  assert.equal(editedState.messages.at(-1).text, "改过的说法");
  assert.notEqual(signatureOf(editedState.messages), signatureOf(state.messages), "改稿得触发重建");

  // 删除：宿主下一页里没有那条，整体 replace 后幽灵不会留着
  const withoutM120 = all.filter((row) => row.id !== "m120");
  const deletedState = applyThreadPage(state, {
    agentId: "A",
    page: { messages: withoutM120.slice(-pollLimit), total: withoutM120.length, hasMore: false },
    mode: "replace",
  });
  assert.equal(deletedState.messages.length, 149);
  assert.equal(deletedState.messages.some((row) => row.id === "m120"), false, "删掉的不能在手机上复活");
});

test("pullLimit：底座 50、按已加载数见录，上限 2000，不自动扩窗", () => {
  assert.equal(pullLimit(0), 50, "初次就是 50");
  assert.equal(pullLimit(50), 50, "刚满一屏就不该自己涨");
  assert.equal(pullLimit(150), 150, "翻到多少就是多少");
  assert.equal(pullLimit(1990), 1990);
  assert.equal(pullLimit(5000), 2000, "再多也不越过宿主上限");
  assert.equal(pullLimit(-10), 50);
  assert.equal(pullLimit(Number.NaN), 50);
  assert.equal(pullLimit(undefined), 50);
});

test("连着几次静置 poll 不会自增，新消息进来只让窗口里最早的退出去", () => {
  const all = Array.from({ length: 60 }, (_, i) => msg({ id: `m${i + 1}`, seq: i + 1, text: `第${i + 1}条` }));
  const hostPage = (limit) => ({
    messages: all.slice(-limit),
    total: all.length,
    hasMore: all.length > limit,
  });

  let state = applyThreadPage(createThreadState(), { agentId: "A", page: hostPage(pullLimit(0)) });
  for (let i = 0; i < 4; i += 1) {
    const limit = pullLimit(state.messages.length);
    assert.equal(limit, 50, `第 ${i + 1} 次 poll 仍然只要 50`);
    state = applyThreadPage(state, { agentId: "A", page: hostPage(limit), mode: "replace" });
    assert.equal(state.messages.length, 50, "第四次也一样，不会 50→100→150");
  }

  // 静置后又来了 3 条：窗口还是有界的 50 条，最早那 3 条自然退出，不是无限往后长
  all.push(
    msg({ id: "m61", seq: 61, text: "第61条" }),
    msg({ id: "m62", seq: 62, text: "第62条" }),
    msg({ id: "m63", seq: 63, text: "第63条" }),
  );
  state = applyThreadPage(state, { agentId: "A", page: hostPage(pullLimit(state.messages.length)), mode: "replace" });
  assert.equal(state.messages.length, 50);
  assert.equal(state.messages[0].id, "m14", "最早的三条（m11~m13）离开了这扇窗口");
  assert.equal(state.messages.at(-1).id, "m63");
  assert.equal(state.hasMore, true, "变成还能往上翻");
});

test("上翻与轮询共用一个请求 key：晚到的旧 poll 抹不掉刚 prepend 的历史", async () => {
  const tracker = createRequestTracker();
  let state = createThreadState();
  state = applyThreadPage(state, {
    agentId: "A",
    page: { messages: [msg({ id: "m51", seq: 51 }), msg({ id: "m52", seq: 52 })], total: 52, hasMore: true },
    mode: "replace",
  });

  // ① 一次 poll 先发出去（挂起）
  const pollRow = tracker.begin("thread:A");
  // ② 她往上翻：同一 key，poll 被顶掉并 abort
  const olderRow = tracker.begin("thread:A");
  assert.equal(pollRow.controller.signal.aborted, true, "在飞的那次 poll 被中止");
  assert.equal(tracker.isCurrent(pollRow), false);

  // ③ 上翻成功，旧页真的 prepend 进去了
  if (tracker.isCurrent(olderRow)) {
    state = applyThreadPage(state, {
      agentId: "A",
      page: { messages: [msg({ id: "m50", seq: 50 })], total: 52, hasMore: false },
      mode: "prepend",
    });
  }
  assert.deepEqual(state.messages.map((row) => row.id), ["m50", "m51", "m52"]);

  // ④ 那次旧 poll 晚回来了：按 token 判它已经不算数，不许 replace
  const late = tracker.isCurrent(pollRow) ? applyThreadPage(state, { agentId: "A", page: { messages: [msg({ id: "m52", seq: 52 })] }, mode: "replace" }) : state;
  assert.deepEqual(late.messages.map((row) => row.id), ["m50", "m51", "m52"], "history 没被晚到的 poll 盖掉");

  // ⑤ 上翻结束后，下一次 poll 换回来的是“当前已加载这么多”，也不会弄丢旧页
  tracker.settle(olderRow);
  const nextPoll = tracker.begin("thread:A");
  assert.equal(tracker.isCurrent(nextPoll), true);
  const merged = applyThreadPage(state, {
    agentId: "A",
    page: { messages: [msg({ id: "m50", seq: 50 }), msg({ id: "m51", seq: 51 }), msg({ id: "m52", seq: 52 })], total: 52, hasMore: false },
    mode: "replace",
  });
  assert.deepEqual(merged.messages.map((row) => row.id), ["m50", "m51", "m52"]);
});

test("超时后那条后来落库：凭 clientMessageId 收掉失败标记，不再重发", () => {
  const landed = [msg({ id: "m1", seq: 1, role: "user", text: "在吗", clientMessageId: "cid_late" })];
  assert.equal(deliveredClientIds(landed).has("cid_late"), true);
  assert.equal(deliveredClientIds(landed).has("cid_other"), false);
  assert.equal(deliveredClientIds([msg({ id: "m2" })]).size, 0, "没有 clientMessageId 的旧记录不算");

  const plan = { clientMessageId: "cid_late", agentId: "A", payload: { text: "在吗" } };
  const ids = deliveredClientIds(landed);
  assert.equal(Boolean(plan && ids.has(plan.clientMessageId)), true, "宿主回同一张票 = 已经发出去了");
});

test("页面接线：pull 与上翻共用 thread 请求 key，轮询写死 50 已不存在", () => {
  const source = readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
  assert.match(source, /const limit = pullLimit\(state\.thread\.messages\.length\)/);
  assert.match(source, /limit=\$\{limit\}/);
  assert.doesNotMatch(source, /limit=\$\{MOBILE_PAGE_SIZE\}/, "轮询不能再写死 50");
  assert.match(source, /if \(state\.loadingOlder\) return;/, "翻旧页期间不抢那一发");
  assert.equal((source.match(/tracker\.begin\("thread:" \+ agentId\)/g) ?? []).length, 2, "pull 与 loadOlder 同一个 key");
  assert.doesNotMatch(source, /tracker\.begin\("older:"/, "不能再各用各的 key");
  assert.match(source, /if \(mode === "replace"\) settleDelivered\(\)/);
});

test("已读回执：聊天开着 + 页面可见 + 真贴在底下，三个条件缺一不可", () => {
  const messages = [msg({ id: "m1", seq: 1, role: "user" }), msg({ id: "m2", seq: 2 })];
  assert.equal(readReceiptThrough({ messages, chatOpen: true, documentVisible: true, atBottom: true }), "m2");
  assert.equal(readReceiptThrough({ messages, chatOpen: true, documentVisible: true }), null, "不传 atBottom 默认就不算看过");
  assert.equal(readReceiptThrough({ messages, chatOpen: true, documentVisible: true, atBottom: false }), null, "在上翻看旧记录时不盖章");
  assert.equal(readReceiptThrough({ messages, chatOpen: true, documentVisible: false, atBottom: true }), null, "后台不盖章");
  assert.equal(readReceiptThrough({ messages, chatOpen: false, documentVisible: true, atBottom: true }), null, "没开聊天不盖章");
  assert.equal(readReceiptThrough({ messages: [], chatOpen: true, documentVisible: true, atBottom: true }), null);
  assert.equal(readReceiptThrough({ messages: [{ text: "没有 id" }], chatOpen: true, documentVisible: true, atBottom: true }), null);
});

// ── 登录态与事件 ─────────────────────────────────────────────

test("登录态 8 小时过期：过期回解锁页，没登录过不报过期", () => {
  const now = Date.parse("2026-10-30T10:00:00.000Z");
  const fresh = writeTokenState("tk", now);
  assert.deepEqual(readTokenState(fresh, now + 1000), { token: "tk", valid: true, expired: false });
  assert.equal(readTokenState(fresh, now + MOBILE_TOKEN_TTL_MS + 1).expired, true);
  assert.equal(readTokenState("", now).expired, false);
  assert.equal(readTokenState("坏掉的", now).valid, false);
  // 老的裸 token 写法读不出来：宁可让她再输一次密码，也不拿一个没时间戳的凭证硬跑
  assert.equal(readTokenState("tk", now).valid, false);
});

test("SSE 事件只认 threads，别的都当噪声", () => {
  assert.deepEqual(parseThreadEvent('{"type":"threads","at":5}'), { type: "threads", at: 5 });
  assert.equal(parseThreadEvent('{"type":"hello"}'), null);
  assert.equal(parseThreadEvent("不是 json"), null);
  assert.equal(parseThreadEvent(""), null);
});

test("小工具：时长、贴纸记号、分页常量", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65000), "1:05");
  assert.equal(stickerIdOf("\u0001stk:stk_1"), "stk_1");
  assert.equal(stickerIdOf("普通文字"), "");
  assert.ok(MOBILE_PAGE_SIZE === 50 && MOBILE_PAGE_MORE === 100);
  assert.ok(MOBILE_API_TIMEOUT_MS > 0);
});

// ── 选图 / 语音的归属：用注入的 effect 代替 DOM 与网络 ─────────────
// 这里证明的是「旧操作晚回来时不会落到新伙伴身上」，不是源码长什么样。

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const fileOf = (over = {}) => ({ name: "a.png", type: "image/png", size: 4096, ...over });
const dataUrlOf = (text = "QUJD") => `data:image/png;base64,${text}`;

test("选图：A 的图读得慢，切到 B 之后旧结果不提交", async () => {
  const tracker = createRequestTracker();
  let agent = "A";
  const ticket = tracker.begin("image:A");
  const read = deferred();
  let committed = null;

  const pending = pickDraftImage(fileOf(), {
    stillMine: () => tracker.isCurrent(ticket) && agent === "A",
    readAsDataURL: () => read.promise,
    createObjectURL: () => "blob:a",
    revokeObjectURL: () => {},
    imageSize: async () => ({ width: 32, height: 32 }),
  }).then((result) => {
    if (result.ok) committed = result; // 客户端唯一的提交动作
    return result;
  });

  // 她在这时候切到了 B
  agent = "B";
  tracker.bump();
  read.resolve(dataUrlOf());

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true, "旧图必须被判作废");
  assert.equal(committed, null, "一点草稿状态都不许写进 B");
});

test("选图：量尺寸那一步才被顶掉——blobURL 收回，也不往草稿上 Object.assign 一个 null", async () => {
  const tracker = createRequestTracker();
  const ticket = tracker.begin("image:A");
  const size = deferred();
  const revoked = [];
  let sizeStarted;
  const reachedSize = new Promise((resolve) => { sizeStarted = resolve; });

  const pending = pickDraftImage(fileOf(), {
    stillMine: () => tracker.isCurrent(ticket),
    readAsDataURL: async () => dataUrlOf(),
    createObjectURL: () => "blob:a",
    revokeObjectURL: (url) => revoked.push(url),
    imageSize: () => { sizeStarted(); return size.promise; },
  });

  await reachedSize; // 读文件已过、URL 已建，正在量尺寸
  tracker.cancel("image:A"); // 例如她点了「移除图片」
  size.resolve({ width: null, height: null });

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.deepEqual(revoked, ["blob:a"], "已经建出来的 URL 必须收回");
});

test("选图：连着选第二张，第一张作废且 URL 收回，第二张照常交", async () => {
  const tracker = createRequestTracker();
  const firstRead = deferred();
  const revoked = [];

  const firstTicket = tracker.begin("image:A");
  const first = pickDraftImage(fileOf({ name: "一号.png" }), {
    stillMine: () => tracker.isCurrent(firstTicket),
    readAsDataURL: () => firstRead.promise,
    createObjectURL: () => "blob:first",
    revokeObjectURL: (url) => revoked.push(url),
    imageSize: async () => ({ width: 10, height: 10 }),
  });

  const secondTicket = tracker.begin("image:A"); // 后选的顶掉先选的
  const second = await pickDraftImage(fileOf({ name: "二号.png" }), {
    stillMine: () => tracker.isCurrent(secondTicket),
    readAsDataURL: async () => dataUrlOf("TEFURVI="),
    createObjectURL: () => "blob:second",
    revokeObjectURL: () => {},
    imageSize: async () => ({}),
  });
  firstRead.resolve(dataUrlOf());
  const stale = await first;

  assert.equal(second.ok, true, "后选的那张正常进草稿");
  assert.equal(second.image.name, "二号.png");
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.deepEqual(revoked, [], "在读完之前就被顶掉，还没建出 URL，没东西可收");
});

test("选图：尺寸读不出来（null/NaN）照样能用，只是不带 width/height", async () => {
  const ok = await pickDraftImage(fileOf(), {
    readAsDataURL: async () => dataUrlOf(),
    createObjectURL: () => "blob:a",
    imageSize: async () => null,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.image.data, "QUJD");
  assert.equal(ok.image.name, "a.png");
  assert.equal("width" in ok.image, false);
  assert.equal("height" in ok.image, false);

  const weird = await pickDraftImage(fileOf(), {
    readAsDataURL: async () => dataUrlOf(),
    createObjectURL: () => "blob:b",
    imageSize: async () => ({ width: Number.NaN, height: -3 }),
  });
  assert.equal(weird.ok, true);
  assert.equal("width" in weird.image, false);
  assert.equal("height" in weird.image, false);
});

test("选图：类型大小先挡下，连读都不读", async () => {
  let reads = 0;
  const bad = await pickDraftImage(fileOf({ name: "a.txt", type: "text/plain" }), {
    readAsDataURL: async () => { reads += 1; return ""; },
    validate: (file) => validateImageFile({ type: file.type, size: file.size }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.stale, false, "不是被顶掉，是本机就不收");
  assert.equal(reads, 0);

  const huge = await pickDraftImage(fileOf({ size: MOBILE_IMAGE_MAX_BYTES + 1 }), {
    readAsDataURL: async () => { reads += 1; return ""; },
    validate: (file) => validateImageFile({ type: file.type, size: file.size }),
  });
  assert.equal(huge.ok, false);
  assert.equal(reads, 0);
});

test("选图：读失败但人已经切走——不许给新伙伴写状态", async () => {
  const tracker = createRequestTracker();
  let agent = "A";
  const ticket = tracker.begin("image:A");
  const pending = pickDraftImage(fileOf(), {
    stillMine: () => tracker.isCurrent(ticket) && agent === "A",
    readAsDataURL: () => Promise.reject(new Error("这张图读不出来")),
  });
  agent = "B";
  tracker.bump();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true, "调用方看到 stale 就该闭嘴，不该在 B 那边弹这条错");
});

test("语音：切伙伴后才回来的 fetch，既不开播也不上报", async () => {
  const tracker = createRequestTracker();
  let agent = "A";
  const ticket = tracker.begin("voice:A:m1");
  const load = deferred();
  const started = [];
  const played = [];

  const pending = playVoice({
    agentId: "A",
    messageId: "m1",
    stillMine: () => tracker.isCurrent(ticket) && agent === "A",
    loadBlob: () => load.promise,
    createObjectURL: () => "blob:v",
    createAudio: () => ({ play: async () => started.push("play"), pause() {} }),
    start: (audio) => { started.push("start"); return audio.play(); },
    reportPlayed: ({ agentId: who, messageId }) => played.push({ agentId: who, messageId }),
  });

  agent = "B";
  tracker.bump();
  load.resolve({ size: 10 });

  const result = await pending;
  assert.equal(result.status, "stale");
  assert.deepEqual(started, [], "旧伙伴的语音不许响");
  assert.deepEqual(played, [], "也不许给它盖章听过");
});

test("语音：开着播的时候切走——立刻停掉、不上报；只有真播起来才盖章，agentId 用开播前捕获的那个", async () => {
  const tracker = createRequestTracker();
  let agent = "A";
  const played = [];
  let aborted = 0;
  let paused = 0;

  // ① 播起来的瞬间切到 B
  const ticketA = tracker.begin("voice:A:m1");
  const switching = playVoice({
    agentId: "A",
    messageId: "m1",
    stillMine: () => tracker.isCurrent(ticketA) && agent === "A",
    loadBlob: async () => ({ size: 1 }),
    createObjectURL: () => "blob:a",
    createAudio: () => ({ pause() { paused += 1; } }),
    start: async () => { agent = "B"; tracker.bump(); },
    // 客户端的 abort 就是“把这条音频停掉，UI/Set 一起收”，这里照同形状模拟
    abort: (audio) => { aborted += 1; audio?.pause(); },
    reportPlayed: ({ agentId: who, messageId }) => played.push({ agentId: who, messageId }),
  });
  const stale = await switching;
  assert.equal(stale.status, "stale");
  assert.equal(aborted, 1, "要把刚建出来的音频收掉");
  assert.equal(paused, 1);
  assert.deepEqual(played, []);

  // ② 正常播完
  agent = "A";
  const ticketB = tracker.begin("voice:A:m2");
  const ok = await playVoice({
    agentId: "A",
    messageId: "m2",
    stillMine: () => tracker.isCurrent(ticketB) && agent === "A",
    loadBlob: async () => ({ size: 1 }),
    createObjectURL: () => "blob:b",
    createAudio: () => ({ pause() {} }),
    start: async () => {},
    reportPlayed: ({ agentId: who, messageId }) => played.push({ agentId: who, messageId }),
  });
  assert.equal(ok.status, "played");
  assert.deepEqual(played, [{ agentId: "A", messageId: "m2" }], "上报用的是捕获的 A，不是届时的 state");
});

test("语音：旧的 fetch 被新的顶掉时按取消处理，不弹错", async () => {
  const tracker = createRequestTracker();
  const ticket = tracker.begin("voice:A:m1");
  const load = deferred();
  const pending = playVoice({
    agentId: "A",
    messageId: "m1",
    stillMine: () => tracker.isCurrent(ticket),
    loadBlob: () => load.promise,
    reportPlayed: () => { throw new Error("不该上报"); },
  });
  tracker.cancel("voice:A:m1");
  load.reject(new Error("aborted"));
  const result = await pending;
  assert.equal(result.status, "stale");
});

test("同一时刻只放一条：新的一条会让旧的暂停，并把旧的 UI 一起收掉", () => {
  const playing = new Set();
  const a = { paused: false, pause() { this.paused = true; } };
  const b = { paused: false, pause() { this.paused = true; } };
  playing.add(a);

  const cleared = [];
  const stopped = claimSinglePlayback(playing, b, (other) => cleared.push(other));

  assert.deepEqual(stopped, [a]);
  assert.equal(a.paused, true, "旧的真的被 pause 了");
  assert.deepEqual([...playing], [], "并从正在播的集合里拿掉");
  assert.deepEqual(cleared, [a], "旧的样式/图标也要收（不只是 audio.pause）");
  assert.equal(b.paused, false, "新的自己不动");
});

test("错误文本按 text 显示：尖括号原样留在文本里，不会被当成标签", () => {
  const make = (tag) => ({
    tag,
    className: "",
    textContent: "",
    children: [],
    append(child) { this.children.push(child); },
  });
  const fakeDoc = { createElement: (tag) => make(tag) };
  const container = { ...make("div"), textContent: "旧内容" };

  const note = showNote(fakeDoc, container, "ch-empty", '没连上：<img src=x onerror="alert(1)">');
  assert.equal(note.tag, "div");
  assert.equal(note.className, "ch-empty");
  assert.equal(note.textContent, '没连上：<img src=x onerror="alert(1)">');
  assert.equal(note.children.length, 0, "文本里没有子元素 = 没解析成标签");
  assert.equal(container.textContent, "", "旧内容先清掉");
  assert.deepEqual(container.children, [note]);
});

test("页面接线：选图/语音/错误提示都走新的守卫，错误文本不再拼 innerHTML", () => {
  const source = readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
  assert.match(source, /pickDraftImage\(file, \{/);
  assert.match(source, /tracker\.begin\("image:" \+ agentId\)/);
  assert.match(source, /tracker\.cancel\("image:" \+ state\.agent\.id\)/, "移除/清草稿要取消选图任务");
  assert.match(source, /await playVoice\(\{/);
  assert.match(source, /const stillMine = \(\) => tracker\.isCurrent\(ticket\) && state\.agent\?\.id === agentId && state\.chatOpen && row\.isConnected !== false/);
  assert.match(source, /reportVoicePlayed\(who, messageId\)/);
  assert.match(source, /claimSinglePlayback\(state\.playing, audio/);
  assert.equal((source.match(/showNote\(doc, (list|trayGrid), /g) ?? []).length, 2, "两处错误提示都改走 showNote");
  assert.doesNotMatch(source, /innerHTML = '[^']*' \+ String\(error\.message\)/, "错误消息不许拼进 innerHTML");
});


// ── 最小 DOM fake：证明 dispatch 的迟到回包不会打扰新伙伴 ─────────────

function makeDom() {
  const ids = new Map();
  const makeEl = (tag = "div") => {
    // class 与 style 都做成真行为：背景那套靠 classList.contains("has-bg") 与
    // style.setProperty("--mc-veil") 说话，全空实现就测不出「清干净了没」。
    const classes = new Set();
    const styleProps = new Map();
    const el = {
      tag,
      id: "",
      hidden: false,
      disabled: false,
      value: "",
      files: null,
      style: {
        setProperty(name, value) { styleProps.set(String(name), String(value ?? "")); },
        removeProperty(name) { styleProps.delete(String(name)); },
        getPropertyValue(name) { return styleProps.has(String(name)) ? styleProps.get(String(name)) : ""; },
      },
      dataset: {},
      attrs: {},
      children: [],
      parent: null,
      get parentNode() { return el.parent; },
      handlers: {},
      isConnected: true,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      // rect：菜单要按 getBoundingClientRect 摆位置、夹视口
      _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      getBoundingClientRect() { return el._rect; },
      contains(node) {
        let walk = node || null;
        while (walk) {
          if (walk === el) return true;
          walk = walk.parentNode || null;
        }
        return false;
      },
      _text: "",
      _html: "",
      get className() { return [...classes].join(" "); },
      set className(value) {
        classes.clear();
        for (const name of String(value ?? "").split(/\s+/)) if (name) classes.add(name);
      },
      classList: {
        add(...names) { for (const name of names) classes.add(name); },
        remove(...names) { for (const name of names) classes.delete(name); },
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains(name) { return classes.has(name); },
      },
      append(...nodes) {
        for (const node of nodes) {
          if (node?.parent) node.parent.children = node.parent.children.filter((each) => each !== node);
          node.parent = el;
          el.children.push(node);
        }
      },
      prepend(...nodes) {
        // 真 DOM 的 prepend 按参数顺序插在最前面（不是逐个 unshift 反过去）
        for (const node of [...nodes].reverse()) {
          node.parent = el;
          el.children.unshift(node);
        }
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((each) => each !== el);
        el.parent = null;
        el.isConnected = false;
      },
      replaceWith() { el.isConnected = false; },
      setAttribute(key, value) { el.attrs[key] = String(value); },
      removeAttribute(key) { delete el.attrs[key]; },
      querySelectorAll() { return []; },
      addEventListener(type, fn) { (el.handlers[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        el.handlers[type] = (el.handlers[type] || []).filter((each) => each !== fn);
      },
      click() { for (const fn of el.handlers.click ?? []) fn(); },
      focus() { doc.activeElement = el; },
      get textContent() {
        // 真 DOM 的 textContent 是整棵子树的文字；菜单的选区判定靠它
        if (el._text) return el._text;
        return el.children.map((child) => child.textContent ?? "").join("");
      },
      set textContent(value) {
        el._text = String(value ?? "");
        el.children = [];
        el._html = "";
      },
      get innerHTML() { return el._html; },
      set innerHTML(value) { el._html = String(value ?? ""); el.children = []; el._text = ""; },
    };
    return el;
  };
  const docListeners = {};
  const doc = {
    visibilityState: "visible",
    // 菜单要考虑视口大小；假窗口给一个手机尺寸
    defaultView: { innerWidth: 390, innerHeight: 640 },
    // 默认没有选区（长按不会误当成“她选中了一句”），用例要时可以换掉
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => "" }),
    createElement: (tag) => makeEl(tag),
    // 徽章图标走 createElementNS：假 DOM 里同名同实现
    createElementNS: (_ns, tag) => makeEl(tag),
    getElementById(id) {
      if (!ids.has(id)) {
        const el = makeEl();
        el.id = id;
        ids.set(id, el);
      }
      return ids.get(id);
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      docListeners[type] = (docListeners[type] || []).filter((each) => each !== fn);
    },
  };
  return { doc, ids, docListeners, el: (id) => doc.getElementById(id) };
}

function makeNet() {
  const calls = [];
  const waits = new Map();
  const threads = new Map();
  // 投喂/收藏：默认挂住，由用例自己放行（要测在途与晚回包）
  const feeds = [];
  const favorites = [];
  // turn.get：同样默认挂住，用例自己回 {status, replyMessageId, ...}
  const turns = [];
  let stickerRows = [{ id: "s1", groupIds: [], emotion: [], description: "一杯茶" }];
  let stickerGroups = [];
  const stickerWaits = [];
  let stickerMode = "auto";
  // 背景图：默认立刻回一张 16 字节的假 PNG；bgMode="manual" 时挂住，由用例自己放行
  const bgWaits = [];
  let bgMode = "auto";
  const bgResponse = () => ({ status: 200, ok: true, blob: async () => ({ size: 16, type: "image/png" }) });
  const respond = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
  const fetchStub = (url, init = {}) => {
    const path = String(url);
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    if (path.includes("/bg?")) {
      if (bgMode === "auto") return Promise.resolve(bgResponse());
      const gate = deferred();
      bgWaits.push(gate);
      return gate.promise;
    }
    if (path.includes("turn.send")) {
      const gate = deferred();
      waits.set("turn.send", gate);
      return gate.promise;
    }
    if (path.includes("turn.get")) {
      const gate = deferred();
      turns.push({ path, gate });
      return gate.promise;
    }
    if (path.includes("message.feed")) {
      const gate = deferred();
      feeds.push({ body: init.body ? JSON.parse(init.body) : null, gate });
      return gate.promise;
    }
    if (path.includes("message.favorite")) {
      const gate = deferred();
      favorites.push({ body: init.body ? JSON.parse(init.body) : null, gate });
      return gate.promise;
    }
    if (path.includes("partners.list")) return Promise.resolve(respond({ ok: true, data: [] }));
    if (path.includes("stickers.list")) {
      if (stickerMode === "auto") return Promise.resolve(respond({ ok: true, data: { stickers: stickerRows, groups: stickerGroups } }));
      const gate = deferred();
      stickerWaits.push(gate);
      return gate.promise;
    }
    if (path.includes("thread.read")) return Promise.resolve(respond({ ok: true, data: { changed: true } }));
    if (path.includes("/voice?")) {
      return Promise.resolve({ status: 200, ok: true, blob: async () => ({ size: 8, type: "audio/mpeg" }) });
    }
    if (path.includes("thread.get")) {
      const agentId = decodeURIComponent((path.match(/agentId=([^&]+)/) ?? [])[1] ?? "");
      return Promise.resolve(respond({ ok: true, data: { agentId, ...(threads.get(agentId) ?? { messages: [], total: 0, hasMore: false }) } }));
    }
    return Promise.resolve(respond({ ok: true, data: {} }));
  };
  return {
    calls,
    threads,
    feeds,
    favorites,
    fetch: fetchStub,
    ok(data) { waits.get("turn.send")?.resolve(respond({ ok: true, data: data ?? { messageId: "m1" } })); },
    fail(error) { waits.get("turn.send")?.reject(error); },
    feedOk(feed) { feeds.at(-1)?.gate.resolve(respond({ ok: true, data: { feed } })); },
    feedFail(status = 500, message = "这次投喂没放上") {
      feeds.at(-1)?.gate.resolve(respond({ ok: false, error: { message } }, status));
    },
    favoriteOk(favorite = true) { favorites.at(-1)?.gate.resolve(respond({ ok: true, data: { favorite } })); },
    favoriteFail(status = 500, message = "这条消息没收藏上") {
      favorites.at(-1)?.gate.resolve(respond({ ok: false, error: { message } }, status));
    },
    reads: () => calls.filter((row) => row.path.includes("thread.read")),
    turns,
    turnCalls: () => calls.filter((row) => row.path.includes("turn.get")),
    turnOk(data = { status: "done", replyMessageId: "m9" }) { turns.at(-1)?.gate.resolve(respond({ ok: true, data })); },
    turnFail(status = 500, message = "查不到这轮") {
      turns.at(-1)?.gate.resolve(respond({ ok: false, error: { message } }, status));
    },
    setStickers(rows, groups = []) { stickerRows = rows; stickerGroups = groups; },
    stickerMode(mode) { stickerMode = mode; },
    stickerCalls: () => calls.filter((row) => row.path.includes("stickers.list")),
    stickerOk() { stickerWaits.shift()?.resolve(respond({ ok: true, data: { stickers: stickerRows, groups: stickerGroups } })); },
    stickerFail(status = 500, message = "没拉下来") {
      stickerWaits.shift()?.resolve(respond({ ok: false, error: { message } }, status));
    },
    bgCalls: () => calls.filter((row) => row.path.includes("/bg?")),
    bgPending: () => bgWaits.length,
    bgMode(mode) { bgMode = mode; },
    bgOk() { bgWaits.shift()?.resolve(bgResponse()); },
    bgFail(status = 500) { bgWaits.shift()?.resolve({ status, ok: status < 400, blob: async () => ({ size: 0 }) }); },
  };
}

async function withClient(t, { threadFor, analyzeBackground, bgMode, createTools } = {}) {
  const dom = makeDom();
  const net = makeNet();
  net.bgMode(bgMode ?? "auto");
  if (threadFor) for (const [id, page] of Object.entries(threadFor)) net.threads.set(id, page);
  const saved = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    EventSource: globalThis.EventSource,
    Audio: globalThis.Audio,
    FileReader: globalThis.FileReader,
  };
  const audios = [];
  const createdUrls = [];
  const revokedUrls = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const store = new Map();
  globalThis.fetch = net.fetch;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.EventSource = class {
    constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; }
    close() {}
  };
  globalThis.Audio = class {
    constructor(src) {
      this.src = src;
      this.paused = true;
      this.duration = 3;
      this.currentTime = 0;
      audios.push(this);
    }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  };
  // 选图/粘贴图：读完立刻回一段假的 data URL
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,QUJD";
      setTimeout(() => this.onload?.(), 0);
    }
  };
  URL.createObjectURL = () => {
    const url = `blob:voice-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
  store.set("ch_mobile_auth", writeTokenState("tk-test"));

  let client = null;
  t.after(async () => {
    // 先收掉轮询/长连接，再把全局还回去（否则一个失败的用例会把进程吊在定时器上）
    try { client?.closeChat(); } catch { /* 已经在收尾 */ }
    await tick(10);
    globalThis.fetch = saved.fetch;
    globalThis.localStorage = saved.localStorage;
    globalThis.EventSource = saved.EventSource;
    globalThis.Audio = saved.Audio;
    globalThis.FileReader = saved.FileReader;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  // 采样背景主色：记下每次采样的 URL（看有没有重采样），具体返回值可以由用例换掉
  const sampled = [];
  const sample = analyzeBackground ?? (async () => ({ red: 62, green: 120, blue: 96, brightness: 0.42 }));
  const analyze = async (url) => { sampled.push(String(url)); return sample(url); };

  client = startMobileClient(dom.doc, { analyzeBackground: analyze, createTools });
  await tick(5);
  const fire = (id, type) => {
    for (const fn of dom.el(id).handlers[type] ?? []) fn();
  };
  const type = (id, value) => {
    dom.el(id).value = value;
    fire(id, "input");
  };
  // 带事件对象的那种：长按/右键/键位都要看得见事件里的坐标与 key
  const fireOn = (node, name, event) => {
    for (const fn of node?.handlers?.[name] ?? []) fn(event);
  };
  return { dom, net, client, el: (id) => dom.el(id), fire, type, fireOn, audios, createdUrls, revokedUrls, sampled };
}

test("dispatch：A 的成功回包迟到，不许清 B 的输入/选图/引用", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "A 的正文");
  const sending = h.client.send();
  await tick(2);

  // 发送途中她又改了 A 的草稿，然后切到 B 并开始打新的
  h.type("input", "A 又打的一句");
  await h.client.openChat({ id: "B", name: "小满" });
  h.type("input", "B 的新草稿");

  h.net.ok();
  await sending;
  await tick(2);

  assert.equal(h.el("input").value, "B 的新草稿", "A 的回包不许碰 B 的输入框");
  assert.equal(h.el("send").disabled, false, "B 有正文，发送键不该被 A 的回包锁住");
  assert.equal(h.client.state.agent.id, "B");
  assert.equal(h.client.state.draftImage, null);
  await h.client.closeChat();
});

test("dispatch：A 失败时已经切到 B——不回填正文、不弹错、不往 B 的列表塞失败行", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "A 没发出去的那句");
  const sending = h.client.send();
  await tick(2);

  await h.client.openChat({ id: "B", name: "小满" });
  h.type("input", "B 正在写");
  const before = h.el("msgs").children.length;
  h.net.fail(new Error("宿主炸了"));
  await sending;
  await tick(2);

  assert.equal(h.el("input").value, "B 正在写", "A 的正文绝不能被回填到 B");
  assert.ok(!String(h.el("state").textContent).includes("宿主炸了"), "A 的错误不该报在 B 头上");
  assert.equal(h.el("msgs").children.length, before, "失败行只属于 A，B 的列表一条不多");
  await h.client.closeChat();
});

test("dispatch：A→B→A 是新世代，上一世代的回包同样不算数", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "第一世代的话");
  const sending = h.client.send();
  await tick(2);

  await h.client.openChat({ id: "B", name: "小满" });
  await h.client.openChat({ id: "A", name: "阿岚" }); // 又回到 A，但已经是新的聊天世代
  h.type("input", "第三世代的话");
  h.net.ok();
  await sending;
  await tick(2);

  assert.equal(h.client.state.agent.id, "A");
  assert.equal(h.el("input").value, "第三世代的话", "只比 agent.id 会误把新草稿清掉");
  await h.client.closeChat();
});

test("dispatch：同一伙伴里超时——提示可重试、正文回填、留下失败行", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "这条会超时");
  const sending = h.client.send();
  await tick(2);
  // fetch 被 abort 时可能只抛出一个字符串 reason
  h.net.fail("timeout");
  await sending;
  await tick(2);

  assert.equal(h.el("state").textContent, "请求超时，可重试");
  assert.equal(h.el("input").value, "这条会超时", "超时不是发成功，正文得还给她");
  const failRow = h.el("msgs").children.at(-1);
  assert.ok(failRow, "要留一条可重试的失败行");
  assert.match(failRow.children[0].children[0].className, /ch-fail/);
  await h.client.closeChat();
});

test("dispatch：切伙伴导致的取消是静默的，不弹错也不留失败行", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "会被取消的一句");
  const sending = h.client.send();
  await tick(2);
  h.net.fail("superseded");
  await sending;
  await tick(2);

  assert.ok(!String(h.el("state").textContent).includes("superseded"));
  assert.equal(h.el("msgs").children.filter((row) => row.className === "row me").length, 0);
  assert.equal(h.el("input").value, "会被取消的一句", "取消不该动她的草稿");
  await h.client.closeChat();
});

test("abort 归一：字符串 reason、DOMException、普通错误各归各位", () => {
  const timeout = normalizeApiError("timeout");
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.message, "请求超时，可重试");
  assert.equal(normalizeApiError(new Error("x"), "timeout").code, "timeout");

  const superseded = normalizeApiError("superseded");
  assert.equal(superseded.code, "canceled");
  assert.equal(normalizeApiError({ name: "AbortError" }).code, "canceled");
  assert.equal(normalizeApiError(new Error("x"), "superseded").code, "canceled");

  const real = new Error("网络不通");
  assert.equal(normalizeApiError(real), real, "不是 abort 的错误原样交回");
});

test("已读：真实客户端里，没贴底就不盖章，滑到底才补一次", async (t) => {
  const h = await withClient(t, {
    threadFor: {
      A: { messages: [msg({ id: "m1", seq: 1, role: "user" }), msg({ id: "m2", seq: 2 })], total: 2, hasMore: false },
    },
  });
  const msgs = h.el("msgs");
  msgs.scrollHeight = 1000;
  msgs.clientHeight = 500;
  msgs.scrollTop = 0; // 停在上面看旧记录

  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  assert.equal(h.net.reads().length, 0, "看着旧记录，屏外的新消息不算看过");

  msgs.scrollTop = 1000; // 滑到底
  h.fire("msgs", "scroll");
  await tick(2);
  const reads = h.net.reads();
  assert.equal(reads.length, 1, "滑到底才补盖章");
  assert.equal(reads[0].body.throughId, "m2");
  assert.equal(reads[0].body.agentId, "A");
  await h.client.closeChat();
});


// ── 语音 blob URL 的回收：从 playing 删掉之后也得收得到 ─────────────

function findVoicePlay(root) {
  const stack = [...(root?.children ?? [])];
  while (stack.length) {
    const node = stack.shift();
    if (node?.className === "voice-play") return node;
    stack.push(...(node?.children ?? []));
  }
  return null;
}

const voiceThread = () => ({
  messages: [msg({ id: "m1", seq: 1, role: "assistant", text: "", voice: { status: "ready", durationMs: 3000, text: "嗯，在呢" } })],
  total: 1,
  hasMore: false,
});

test("语音 URL：播完（已从 playing 删掉）之后切回列表，也要收回并清账", async (t) => {
  const h = await withClient(t, { threadFor: { A: voiceThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);

  findVoicePlay(h.el("msgs")).click();
  await tick(5);
  assert.equal(h.audios.length, 1, "取回了一条语音");
  assert.equal(h.client.state.audioUrls.size, 1, "建出 blob URL 就要记账");
  assert.equal(h.client.state.playing.size, 1);

  h.audios[0].onended(); // 播完：onended 把它从 playing 里删掉，URL 还挂在账上
  assert.equal(h.client.state.playing.size, 0);
  assert.equal(h.client.state.audioUrls.size, 1);

  await h.client.closeChat();
  assert.deepEqual(h.revokedUrls, h.createdUrls, "播完那条的 blob URL 也必须收回");
  assert.equal(h.client.state.audioUrls.size, 0, "账要清干净");
  assert.equal(h.client.state.playing.size, 0);
});

test("语音 URL：暂停中的那条，切到别的伙伴也会收回", async (t) => {
  const h = await withClient(t, { threadFor: { A: voiceThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);

  findVoicePlay(h.el("msgs")).click();
  await tick(5);
  findVoicePlay(h.el("msgs")).click(); // 再点一次 = 暂停
  await tick(2);

  assert.equal(h.client.state.playing.size, 0, "暂停就从 playing 里拿掉");
  assert.equal(h.client.state.audioUrls.size, 1, "但 URL 还欠着");

  await h.client.openChat({ id: "B", name: "小满" });
  assert.deepEqual(h.revokedUrls, h.createdUrls, "切伙伴时把它收回");
  assert.equal(h.client.state.audioUrls.size, 0);
});

test("playVoice：过期/失败的语音会把 URL 从跟踪集合清掉并真 revoke", async () => {
  const urls = new Set();
  const revoked = [];
  const created = [];
  const tracker = createRequestTracker();
  let agent = "A";
  const ticket = tracker.begin("voice:A:m1");

  const base = (over = {}) => ({
    agentId: "A",
    messageId: "m1",
    stillMine: () => tracker.isCurrent(ticket) && agent === "A",
    loadBlob: async () => ({ size: 1 }),
    createObjectURL: () => {
      const url = `blob:${created.length + 1}`;
      created.push(url);
      urls.add(url);
      return url;
    },
    revokeObjectURL: (url) => {
      urls.delete(url);
      revoked.push(url);
    },
    createAudio: () => ({ play: async () => {}, pause() {} }),
    ...over,
  });

  // ① 播起来的瞬间切走 → stale，URL 收回
  const stale = await playVoice(base({ start: async () => { agent = "B"; tracker.bump(); } }));
  assert.equal(stale.status, "stale");
  assert.deepEqual(revoked, ["blob:1"]);
  assert.equal(urls.size, 0, "跟踪集合里也不许留");

  // ② 播放抛错 → failed，URL 同样收回
  agent = "A";
  const ticket2 = tracker.begin("voice:A:m2");
  const failed = await playVoice({
    ...base({ stillMine: () => tracker.isCurrent(ticket2) }),
    messageId: "m2",
    start: async () => { throw new Error("播放失败"); },
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
  assert.equal(urls.size, 0);
});

test("页面接线：toggleVoice 把 blob URL 记进 audioUrls，收回时出账，teardownMedia 统一 revoke", () => {
  const source = readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
  assert.match(source, /createObjectURL: \(blob\) => \{[\s\S]{0,120}state\.audioUrls\.add\(url\)/);
  assert.match(source, /revokeObjectURL: \(url\) => \{[\s\S]{0,80}state\.audioUrls\.delete\(url\)/);
  assert.match(source, /for \(const url of state\.audioUrls\) \{\s*\n\s*try \{ URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(source, /URL\.revokeObjectURL\(audio\.src\)/, "不要对 audio.src 重复 revoke");
});


// ── 发送不清新草稿：emoji 与“失败后改正文再重试” ──────────────────

function findByClass(root, className) {
  const stack = [...(root?.children ?? [])];
  while (stack.length) {
    const node = stack.shift();
    if (className.split(/\s+/).every((name) => node?.classList?.contains(name))) return node;
    stack.push(...(node?.children ?? []));
  }
  return null;
}

test("dispatch：发送途中插一个 emoji，回包不许把它清掉", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "在吗");
  const sending = h.client.send();
  await tick(2);

  // 打开表情抽屉 → 切到 Emoji 页 → 点第一枚
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayTabs").children[0].click();
  h.el("trayGrid").children[0].click();
  await tick(1);

  const draft = h.el("input").value;
  assert.ok(String(draft).startsWith("在吗"), `表情该接在原文后面，实际 ${draft}`);
  assert.notEqual(draft, "在吗", "确实插进去了");

  h.net.ok();
  await sending;
  await tick(2);

  assert.equal(h.el("input").value, draft, "回包后新插的 emoji 还在，一点没被清");
  assert.equal(h.el("send").disabled, false, "有正文就该能发");
  await h.client.closeChat();
});

test("dispatch：失败后改正文、再用原 clientMessageId 重试成功，新正文不许被清", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "原始正文");
  const sending = h.client.send();
  await tick(2);
  h.net.fail(new Error("宿主炸了"));
  await sending;
  await tick(2);

  const failRow = findByClass(h.el("msgs"), "ch-fail");
  assert.ok(failRow, "失败行该出来了");

  // 她改了正文，然后点重试（旧的 clientMessageId 那张票）
  h.type("input", "改过的正文");
  const before = h.net.calls.filter((row) => row.path.includes("turn.send"));
  const firstClientId = before.at(-1).body.clientMessageId;
  failRow.children[1].click();
  await tick(3);

  const resend = h.net.calls.filter((row) => row.path.includes("turn.send")).at(-1);
  assert.equal(resend.body.text, "原始正文", "重试发的是原来那张票的内容");
  assert.equal(resend.body.clientMessageId, firstClientId, "同一条票，宿主据此去重");

  h.net.ok();
  await tick(3);

  assert.equal(h.el("input").value, "改过的正文", "重试成功也不许清掉她新写的正文");
  await h.client.closeChat();
});


// ── 登录框契约：#pw 得装得下宿主真正发出来的那串密码 ─────────────
// 这里读的是真 mobile.html、用的是真 generateMobilePassword()（不写死 16）。

test("登录框契约：生成的密码能整段输进去——不许被 maxlength 截断，也不许给数字键盘", () => {
  const html = readFileSync(new URL("../ui/mobile.html", import.meta.url), "utf8");
  const tag = (html.match(/<input[^>]*id="pw"[^>]*>/) ?? [])[0];
  assert.ok(tag, "mobile.html 里要有 #pw 这个输入框");

  const attr = (name) => {
    const hit = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return hit ? hit[1] : null;
  };

  const password = generateMobilePassword();
  assert.ok(password.length > 12, `宿主发的密码是 ${password.length} 位，超过旧的 12 位上限`);
  assert.match(password, /^[a-z0-9]+$/, "口令字母表是字母+数字");

  assert.equal(attr("maxlength"), null, `maxlength 会把 ${password.length} 位密码截成 12 位，怎么输都不对`);
  assert.equal(attr("inputmode"), "text", "密码里有字母，numeric 键盘打不出来");
  assert.equal(attr("autocapitalize"), "none", "手机不许把字母自动大写");
  assert.equal(attr("autocorrect"), "off", "不许把口令当单词纠正");
  assert.equal(attr("spellcheck"), "false");
  assert.equal(attr("autocomplete"), "off", "原有的 autocomplete=off 要保留");
});


// ── 手机页骨架：输入栏穿茶话会本体的 class 与 SVG，不另设一套 ──────────
// 这里是真 mobile.html / panel.css：手机页自己那一份样式重复一遍就白干了。

const mobileHtmlText = () => readFileSync(new URL("../ui/mobile.html", import.meta.url), "utf8");
const mobileCssText = () => (mobileHtmlText().match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? "";
const panelCssText = () => readFileSync(new URL("../ui/assets/panel.css", import.meta.url), "utf8");

test("聊天窗：手机页穿本体 .chat，只把圆角边框阴影压掉，不重画一块板", () => {
  const html = mobileHtmlText();
  assert.match(html, /<div id="chat" class="chat" hidden>/, "聊天窗要挂上本体那个 .chat");
  assert.match(
    mobileCssText(),
    /#chat \{ position: fixed; inset: 0; z-index: 50; border: 0; border-radius: 0; box-shadow: none; \}/,
    "铺满整屏：圆角/边框/阴影只压掉，不重新画",
  );
  assert.doesNotMatch(html, /class="ch-bg"/, "底图直接铺在聊天窗上，不再多一层 .ch-bg");
});

test("头与输入区：穿本体的 .chat-head / .composer / .composer-row，自己不再画底色", () => {
  const html = mobileHtmlText();
  const css = mobileCssText();
  assert.match(html, /<div class="chat-head ch-bar">/);
  assert.match(html, /<div class="composer ch-composer">/);
  assert.match(html, /<div class="composer-row">/);
  // 有背景时那层半透明磨砂是 panel.css 的 .chat.has-bg 给；这里再写一层底色就把它盖死了
  assert.doesNotMatch(css, /\.ch-bar \{[^}]*background:/);
  assert.doesNotMatch(css, /\.ch-composer \{[^}]*background:/);
  assert.doesNotMatch(css, /\.ch-composer \{[^}]*border-top:/);
});

test("输入栏的键和图：表情/图片走 .emoji-btn，发送走 button.send 那张纸飞机", () => {
  const html = mobileHtmlText();
  const panelHtml = readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
  const sticker = (html.match(/<button class="emoji-btn" id="stickerBtn"[\s\S]*?<\/button>/) ?? [])[0] ?? "";
  const image = (html.match(/<button class="emoji-btn" id="imgBtn"[\s\S]*?<\/button>/) ?? [])[0] ?? "";
  const send = (html.match(/<button class="send" id="send"[\s\S]*?<\/button>/) ?? [])[0] ?? "";
  assert.match(sticker, /<svg viewBox="0 0 20 20"/);
  assert.match(image, /<svg viewBox="0 0 20 20"/);
  assert.match(send, /class="send-icon"/);
  // 三条路径与 panel.html 逐字一致：手机页不另画一套图标
  for (const piece of ["M6.8 11.8c.9 1.1", "m4.8 14.2 3.4-3.4", "m10.2 11.7 6.5-8"]) {
    assert.ok(panelHtml.includes(piece), `panel.html 里该有这段 SVG 路径：${piece}`);
    assert.ok(html.includes(piece), `手机页该照抄这段 SVG 路径：${piece}`);
  }
  assert.doesNotMatch(html, /class="ch-send"/, "旧的大圆角「发」按钮不再存在");
  assert.doesNotMatch(html, /class="ch-sticker-btn"|class="ch-img-btn"/, "旧的两个方块键也不留");
  assert.doesNotMatch(mobileCssText(), /\.ch-send[ ,{]|\.ch-sticker-btn|\.ch-img-btn/, "旧那套观感覆盖一并删干净");
});

test("聊天页的 id 一个不少：脚本摸得到的那些都还在", () => {
  const html = mobileHtmlText();
  for (const id of [
    "gate", "pw", "go", "err", "home", "hint", "list",
    "chat", "msgs", "who", "state", "link", "back",
    "quoteBar", "quoteText", "quoteDrop", "draft", "draftImg", "draftName", "draftDrop",
    "stickerBtn", "imgBtn", "input", "send", "pickImage",
    "tray", "trayCount", "trayTabs", "trayGrid", "trayClose",
    "overlay", "overlayImg", "overlayClose",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `少了 #${id}，脚本会摸到 null`);
  }
});

test("输入框：16px 字号防 iOS 放大、最高 120px，安全区和 42px 触控留着", () => {
  const css = mobileCssText();
  assert.match(css, /\.ch-composer textarea \{[^}]*font-size: 16px/);
  assert.match(css, /\.ch-composer textarea \{[^}]*max-height: 120px/);
  assert.match(css, /\.ch-composer \.emoji-btn,\s*\n\s*\.ch-composer button\.send \{ flex: 0 0 auto; width: 42px; height: 42px; \}/, "触控目标 42px");
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(mobileHtmlText(), /viewport-fit=cover/);
});

test("手机页不另立字体栈、不 blur 整张底图", () => {
  const css = mobileCssText();
  // 只允许 inherit（那是“跟着上代走”），写死一套字体栈才算另立一份
  for (const hit of css.matchAll(/font-family:\s*([^;}]+)/g)) {
    assert.equal(hit[1].trim(), "inherit", `字体栈继承 panel.css，这里只许 inherit：${hit[1]}`);
  }
  assert.doesNotMatch(css, /filter:\s*blur/, "磨砂只给头尾两条玻璃，不许糊整张图");
});

test("磨砂跟着本体走：panel.css 那两条 16px blur 与 --mc-veil 就是手机用的同一份", () => {
  const css = panelCssText();
  assert.match(
    css,
    /\.chat\.has-bg \.chat-head,\s*\n\.chat\.has-bg \.composer \{[\s\S]*?-webkit-backdrop-filter: blur\(16px\) saturate\(1\.08\);[\s\S]*?backdrop-filter: blur\(16px\) saturate\(1\.08\);/,
  );
  assert.match(css, /background: rgba\(255, 253, 249, var\(--mc-veil, \.5\)\)/, "玻璃条的白度跟着背景浓度走");
  assert.match(css, /\.chat\.has-bg \.chat-head \{ box-shadow: 0 14px 20px -12px/, "伙伴栏向下化开一层雾");
  assert.match(css, /\.chat\.has-bg \.composer \{ box-shadow: 0 -14px 20px -12px/, "输入区向上化开一层雾");
});


// ── 背景浓度、缓存 key、主题变量（纯逻辑）───────────────────────

test("背景浓度矩阵：百分数除 100，0 和 100 都是有效值，缺省才按 tone 兜底", () => {
  assert.equal(backgroundVeil(0), 0);
  assert.equal(backgroundVeil(34), 0.34);
  assert.equal(backgroundVeil(52), 0.52);
  assert.equal(backgroundVeil(100), 1);
  assert.equal(backgroundVeil("0"), 0, "字符串 \"0\" 也是合法的 0%");
  assert.equal(backgroundVeil("76"), 0.76);
  assert.equal(backgroundVeil(150), 1, "越界往两头夹");
  assert.equal(backgroundVeil(-20), 0);
  assert.equal(backgroundVeil(Number.NaN, "light"), 0.34, "NaN 没值，按档位");
  assert.equal(backgroundVeil(null, "medium"), 0.52);
  assert.equal(backgroundVeil(undefined, "heavy"), 0.76);
  assert.equal(backgroundVeil("", "light"), 0.34);
  assert.equal(backgroundVeil("   ", "heavy"), 0.76, "全是空格也算没给");
  assert.equal(backgroundVeil(null), 0.52, "null 不许被 Number(null) 误当成 0");
  assert.notEqual(backgroundVeil(null), 0);
  assert.equal(backgroundVeil(undefined, "不认得的档位"), 0.52, "不认得的档位回默认 52");
  assert.equal(backgroundVeil(true), 0.52, "布尔不当作浓度");
  assert.equal(MOBILE_BACKGROUND_TONE.light, 34);
  assert.equal(MOBILE_BACKGROUND_TONE.heavy, 76);
});

test("背景层：暖白遮罩与图写在同一句里，浓度就是那个百分数", () => {
  assert.equal(
    backgroundLayer(0.4, "blob:1"),
    'linear-gradient(rgba(247, 244, 236, 0.4), rgba(247, 244, 236, 0.4)), url("blob:1")',
  );
  assert.match(backgroundLayer(backgroundVeil(52), "blob:2"), /rgba\(247, 244, 236, 0\.52\)/);
});

test("背景缓存 key：同房同图同时间戳才算同一份，只拖明暗不算换图", () => {
  const base = { file: "room.png", at: "t1", opacity: 40, tone: "medium" };
  assert.equal(backgroundImageKey("A", base), backgroundImageKey("A", { ...base, opacity: 76, tone: "heavy" }));
  assert.notEqual(backgroundImageKey("A", base), backgroundImageKey("B", base), "换伙伴算换图");
  assert.notEqual(backgroundImageKey("A", base), backgroundImageKey("A", { ...base, file: "b.png" }));
  assert.notEqual(backgroundImageKey("A", base), backgroundImageKey("A", { ...base, at: "t2" }));
  assert.equal(backgroundImageKey("A", null), "");
  assert.equal(backgroundImageKey("A", { file: "   " }), "");
});

test("主题变量：桌面那串名字一个不少，气泡皮肤仍然优先", () => {
  const theme = buttonThemeFromSample({ red: 62, green: 120, blue: 96, brightness: 0.42 });
  const vars = backgroundThemeVars(theme);
  assert.deepEqual(Object.keys(vars).sort(), [...BACKGROUND_THEME_VARS].sort());
  assert.equal(vars["--send-bg"], theme.background);
  assert.equal(vars["--send-fg"], theme.foreground);
  assert.equal(vars["--send-border"], theme.border);
  assert.equal(vars["--voice-bg"], theme.background);
  assert.equal(vars["--voice-fg"], theme.foreground);
  assert.equal(vars["--status-fg"], theme.noticeForeground);
  assert.equal(vars["--status-border"], theme.noticeBorder);
  assert.equal(vars["--bubble-ta-fg"], theme.bubbleTaForeground);
  assert.deepEqual(backgroundThemeVars(null), {}, "没主题就一个都不写，让默认值兜");
  // 皮肤那层还在上面：皮肤给了颜色时不会被背景主题顶掉
  const skins = readFileSync(new URL("../ui/assets/bubble-skins.css", import.meta.url), "utf8");
  assert.match(skins, /background: var\(--skin-me-bg, var\(--bubble-me-bg, #dff0e8\)\);/);
  assert.match(skins, /background: var\(--skin-ta-bg, var\(--bubble-ta-bg, #fff\)\);/);
});

test("页面接线：背景走 tracker 票 + seq，相对路径 import，老 0..1 clamp 不许回来", () => {
  const source = readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
  assert.match(source, /import \{ analyzeBackgroundUrl, buttonThemeFromSample \} from "\.\/background-adaptive\.js";/, "相对路径 import，Node 里也要能直接引");
  assert.match(source, /tracker\.begin\("background:" \+ agentId\)/);
  assert.match(source, /if \(!mine\(\) \|\| backgroundState\.url !== url\) return;/, "采样回来先验归属再写变量");
  assert.match(source, /backgroundVeil\(background\?\.opacity, background\?\.tone\)/);
  assert.match(source, /chat\.style\.setProperty\("--mc-veil"/, "浓度传给两条玻璃条");
  assert.doesNotMatch(source, /Math\.max\(0, Math\.min\(1, opacity\)\)/, "老的 0..1 clamp 不许回来");
  assert.doesNotMatch(source, /chatBg/);
});


// ── 背景：真 startMobileClient + 假 DOM，看归属与释放 ─────────────

const bgRoom = (over = {}) => ({
  messages: [msg({ id: "m1", seq: 1 })],
  total: 1,
  hasMore: false,
  background: { file: "room.png", type: "image/png", tone: "medium", opacity: 40, at: "2026-10-30T10:00:00.000Z", ...over },
});

test("背景：首屏铺图 + 磨砂浓度 + 主题变量，之后轮询同一张图不再重下重采样", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);

  const chat = h.el("chat");
  const calls = h.net.bgCalls();
  assert.equal(calls.length, 1, "一张图只下一次");
  assert.equal(calls[0].path, "/bg?agentId=A&t=2026-10-30T10%3A00%3A00.000Z");
  assert.equal(calls[0].init.headers.authorization, "Bearer tk-test", "背景图也走 Bearer");
  assert.equal(h.sampled.length, 1, "主色只采一次");

  assert.ok(chat.classList.contains("has-bg"), "挂上 has-bg，本体那两条磨砂规则才生效");
  assert.equal(chat.style.getPropertyValue("--mc-veil"), "0.4", "52 这种百分数不再被 clamp 成 1");
  assert.equal(
    chat.style.getPropertyValue("background-image"),
    'linear-gradient(rgba(247, 244, 236, 0.4), rgba(247, 244, 236, 0.4)), url("blob:voice-1")',
  );
  assert.equal(chat.style.getPropertyValue("background-size"), "cover");

  const theme = buttonThemeFromSample({ red: 62, green: 120, blue: 96, brightness: 0.42 });
  assert.equal(chat.style.getPropertyValue("--send-bg"), theme.background);
  assert.equal(chat.style.getPropertyValue("--bubble-me-bg"), theme.bubbleMeBackground);
  assert.equal(chat.style.getPropertyValue("--status-bg"), theme.noticeBackground);

  // 再轮询两轮：同一间房同一张图 → 不重下、不重采样
  await h.client.pull();
  await tick(5);
  await h.client.pull();
  await tick(5);
  assert.equal(h.net.bgCalls().length, 1);
  assert.equal(h.sampled.length, 1);
  await h.client.closeChat();
});

test("背景：她只拖明暗条（图没变）只重画遮罩，不重下不重采", async (t) => {
  const page = bgRoom();
  const h = await withClient(t, { threadFor: { A: page } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  assert.equal(h.net.bgCalls().length, 1);

  h.net.threads.set("A", bgRoom({ opacity: 76, tone: "heavy", at: page.background.at }));
  await h.client.pull();
  await tick(5);

  assert.equal(h.net.bgCalls().length, 1, "同一张图不重下");
  assert.equal(h.sampled.length, 1, "主色也不用重采");
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "0.76");
  await h.client.closeChat();
});

test("背景：A 的图还没回来就切到 B——A 的图和色一个字都不许落在 B 身上", async (t) => {
  const h = await withClient(t, {
    threadFor: { A: bgRoom(), B: bgRoom({ file: "b.png", at: "2026-10-31T10:00:00.000Z" }) },
    bgMode: "manual",
  });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  assert.equal(h.net.bgPending(), 1, "A 的图挂在路上");

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(2);

  h.net.bgOk(); // A 那张现在才到
  await tick(5);
  assert.deepEqual(h.createdUrls, [], "A 的图连 blobURL 都不该建");
  assert.equal(h.el("chat").classList.contains("has-bg"), false, "B 还没铺上，更不许是 A 的");
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "", "浓度也不许写");

  h.net.bgOk(); // B 自己那张
  await tick(5);
  assert.equal(h.createdUrls.length, 1);
  assert.ok(h.el("chat").classList.contains("has-bg"));
  assert.match(h.el("chat").style.getPropertyValue("background-image"), /url\("blob:voice-1"\)/);
  await h.client.closeChat();
});

test("背景：A→B→A，上一世代晚回来的采样不许盖掉新会话的颜色", async (t) => {
  const first = deferred();
  const second = deferred();
  let round = 0;
  const sample = () => {
    round += 1;
    return round === 1 ? first.promise : second.promise;
  };
  const h = await withClient(t, { threadFor: { A: bgRoom() }, analyzeBackground: sample });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  assert.equal(round, 1, "A 第一次采样还挂住");

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  await h.client.openChat({ id: "A", name: "阿岚" }); // 又回 A：新世代
  await tick(5);
  assert.equal(round, 2);

  second.resolve({ red: 200, green: 60, blue: 70, brightness: 0.5 });
  await tick(5);
  const chat = h.el("chat");
  const fresh = chat.style.getPropertyValue("--send-bg");
  assert.ok(fresh, "新世代的颜色写上了");

  first.resolve({ red: 10, green: 200, blue: 10, brightness: 0.9 }); // 第一世代的旧采样
  await tick(5);
  assert.equal(chat.style.getPropertyValue("--send-bg"), fresh, "旧采样一个字都改不了");
  assert.equal(chat.style.getPropertyValue("--bubble-me-bg"), buttonThemeFromSample({ red: 200, green: 60, blue: 70, brightness: 0.5 }).bubbleMeBackground);
  await h.client.closeChat();
});

test("背景：她清掉背景，磨砂、浓度、主题变量和 blobURL 一起收干净", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  const chat = h.el("chat");
  assert.ok(chat.classList.contains("has-bg"));
  assert.equal(h.createdUrls.length, 1);

  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1 })], total: 1, hasMore: false, background: null });
  await h.client.pull();
  await tick(5);

  assert.equal(chat.classList.contains("has-bg"), false);
  assert.equal(chat.style.getPropertyValue("background-image"), "");
  assert.equal(chat.style.getPropertyValue("background-size"), "");
  assert.equal(chat.style.getPropertyValue("--mc-veil"), "");
  for (const name of BACKGROUND_THEME_VARS) assert.equal(chat.style.getPropertyValue(name), "", `${name} 没扫干净`);
  assert.deepEqual(h.revokedUrls, h.createdUrls, "图也要收回");
  await h.client.closeChat();
});

test("背景：图拉不下来就退回干净的样子，不留半截样式", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  h.net.bgFail(500);
  await tick(5);

  const chat = h.el("chat");
  assert.equal(chat.classList.contains("has-bg"), false);
  assert.equal(chat.style.getPropertyValue("--mc-veil"), "");
  assert.equal(chat.style.getPropertyValue("background-image"), "");
  assert.deepEqual(h.createdUrls, []);
  assert.match(String(h.el("state").textContent), /背景没铺上/);
  await h.client.closeChat();
});

test("背景：采样失败就只铺图不上色，颜色回默认", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, analyzeBackground: async () => null });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  const chat = h.el("chat");
  assert.ok(chat.classList.contains("has-bg"), "图照样铺");
  assert.equal(chat.style.getPropertyValue("--mc-veil"), "0.4");
  for (const name of BACKGROUND_THEME_VARS) assert.equal(chat.style.getPropertyValue(name), "", `${name} 该回默认`);
  await h.client.closeChat();
});

test("背景：关掉聊天时在飞的那发作废，关掉之后回来的图一个字都不画", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  await h.client.closeChat();
  await tick(2);

  h.net.bgOk();
  await tick(5);
  assert.deepEqual(h.createdUrls, []);
  assert.equal(h.el("chat").classList.contains("has-bg"), false);
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "");
});

test("背景：铺上之后再关掉，blobURL 也收回去", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  assert.equal(h.createdUrls.length, 1);

  await h.client.closeChat();
  assert.deepEqual(h.revokedUrls, h.createdUrls);
  assert.equal(h.el("chat").style.getPropertyValue("background-image"), "");
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "");
});

test("背景：同伙伴清掉背景时，还在飞的 /bg 当场被 abort，不留 has-bg 与主题", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  const inflight = h.net.bgCalls().at(-1);
  assert.equal(h.net.bgPending(), 1, "第一发还挂在路上");
  assert.equal(inflight.init.signal.aborted, false);

  // 同一间房，她把背景清了（没切人、没关闭，所以不走 tracker.bump）
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1 })], total: 1, hasMore: false, background: null });
  await h.client.pull();
  await tick(2);

  assert.equal(inflight.init.signal.aborted, true, "清背景要当场 abort 那一发，不是等它自己回来");
  assert.equal(h.el("chat").classList.contains("has-bg"), false);
  assert.equal(h.el("chat").style.getPropertyValue("background-image"), "");
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "");
  for (const name of BACKGROUND_THEME_VARS) assert.equal(h.el("chat").style.getPropertyValue(name), "", `${name} 该回默认`);

  // 就算这一发后来还是回来了（浏览器不一定保证 abort 后不回包），也一个字都不许画
  h.net.bgOk();
  await tick(5);
  assert.deepEqual(h.createdUrls, [], "abort 之后回来的图不许建 blobURL");
  assert.equal(h.el("chat").classList.contains("has-bg"), false);
  await h.client.closeChat();
});

test("背景：同一张图在飞时又轮询，不重开下载也不 abort；回来时用最新浓度", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  const first = h.net.bgCalls().at(-1);
  assert.equal(h.net.bgPending(), 1);
  assert.equal(first.init.signal.aborted, false);

  // 弱网：图还没回来，轮询又来了两轮（同一张图）
  await h.client.pull();
  await tick(2);
  await h.client.pull();
  await tick(2);
  assert.equal(h.net.bgCalls().length, 1, "同一张图在飞时不新开下载");
  assert.equal(h.net.bgPending(), 1);
  assert.equal(first.init.signal.aborted, false, "更不许把首发 abort 掉——弱网下就永远铺不上");

  // 期间她把明暗改到 76%
  h.net.threads.set("A", bgRoom({ opacity: 76, tone: "heavy" }));
  await h.client.pull();
  await tick(2);
  assert.equal(h.net.bgCalls().length, 1, "改浓度也还是那一发");
  assert.equal(first.init.signal.aborted, false);

  h.net.bgOk(); // 首图现在才回来
  await tick(5);
  assert.ok(h.el("chat").classList.contains("has-bg"));
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "0.76", "回来时用最新的浓度，不是发起那一刻的 0.4");
  assert.equal(h.sampled.length, 1, "图只采一次色");
  await h.client.closeChat();
});

test("背景：换了另一张图（key 变了）照样 abort 上一发，旧回包不落", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  const first = h.net.bgCalls().at(-1);

  h.net.threads.set("A", bgRoom({ file: "new.png", at: "2026-10-30T11:00:00.000Z" }));
  await h.client.pull();
  await tick(2);
  assert.equal(first.init.signal.aborted, true, "换图要 abort 旧的");
  assert.equal(h.net.bgCalls().length, 2);

  h.net.bgOk(); // 旧那一发（已 abort，但回包仍可能到）
  await tick(3);
  assert.deepEqual(h.createdUrls, [], "旧图回来一个字都别画");

  h.net.bgOk(); // 新那一发
  await tick(5);
  assert.equal(h.createdUrls.length, 1);
  assert.match(h.el("chat").style.getPropertyValue("background-image"), /blob:voice-1/);
  assert.equal(h.sampled.length, 1);
  await h.client.closeChat();
});

test("背景：401 跟别的接口一样回解锁页，不留背景", async (t) => {
  const h = await withClient(t, { threadFor: { A: bgRoom() }, bgMode: "manual" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  h.net.bgFail(401);
  await tick(5);

  assert.equal(h.el("gate").hidden, false, "回解锁页");
  assert.equal(h.el("chat").hidden, true);
  assert.equal(h.el("chat").classList.contains("has-bg"), false);
  assert.equal(h.el("chat").style.getPropertyValue("--mc-veil"), "");
});


// ── 消息菜单：投喂 / 复制 / 引用 / 收藏（真 client + 最小假 DOM）──────

const menuThread = () => ({
  messages: [
    msg({ id: "m1", seq: 1, role: "user", text: "在吗" }),
    msg({ id: "m2", seq: 2, role: "assistant", text: "在呢", bubbles: ["在呢", "刚睡醒"] }),
    msg({ id: "m3", seq: 3, role: "assistant", text: "\u0001stk:s1" }),
    msg({ id: "m4", seq: 4, role: "assistant", text: "撤回的那条", recalled: true }),
  ],
  total: 4,
  hasMore: false,
});

const allByClass = (root, className) => {
  const out = [];
  const stack = [...(root?.children ?? [])];
  while (stack.length) {
    const node = stack.shift();
    if (className.split(/\s+/).every((name) => node?.classList?.contains(name))) out.push(node);
    stack.push(...(node?.children ?? []));
  }
  return out;
};
const bubbleTextOf = (node) => String(node?.textContent ?? "").trim();
const menuOf = (h) => findByClass(h.el("chat"), "message-feed-menu");
const copyBoxOf = (h) => findByClass(h.el("chat"), "ch-copy-box");
const emojiRowOf = (h) => allByClass(menuOf(h), "message-feed-emojis")[0];
const menuButton = (h, label) => (allByClass(menuOf(h), "message-feed-actions")[0]?.children ?? [])
  .find((button) => button.textContent === label);
const menuLabels = (h) => (allByClass(menuOf(h), "message-feed-actions")[0]?.children ?? [])
  .map((button) => button.textContent);
const openMenuAt = (h, index) => {
  const row = h.el("msgs").children[index];
  h.fireOn(row, "contextmenu", { button: 2, preventDefault() {}, stopPropagation() {} });
  return row;
};
const clickOutside = (h) => {
  for (const fn of h.dom.docListeners.pointerdown ?? []) fn({ target: h.el("msgs") });
};
const pressEsc = (h) => {
  for (const fn of h.dom.docListeners.keydown ?? []) fn({ key: "Escape", preventDefault() {} });
};

const imageThread = () => ({
  messages: [msg({ id: "p1", seq: 1, role: "assistant", text: "", attachment: { id: "a1", name: "猫.png", mimeType: "image/png" } })],
  total: 1,
  hasMore: false,
});

async function openMenuThread(t, thread = menuThread()) {
  const h = await withClient(t, { threadFor: { A: thread } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  return h;
}

test("手机页只在本页收间距：同条多气泡 8px、引用与正文竖排、菜单 42px 分两行", () => {
  const css = mobileCssText();
  assert.match(css, /#chat \.msg-col \{ gap: 8px; \}/, "同一条里的多截气泡/图/表情之间要 8px");
  assert.match(css, /#chat \.msg-line \{ flex-direction: column; align-items: flex-start; gap: 6px; \}/, "引用块与正文竖排，不挤一行");
  assert.match(css, /#chat \.row\.me \.msg-line \{ align-items: flex-end; \}/, "自己那侧贴右边");
  assert.match(css, /\.message-feed-menu \{ max-width: calc\(100vw - 16px\); \}/, "窄屏不许溢出");
  assert.match(css, /\.message-feed-menu button \{ width: 42px; height: 42px;/, "触控 42px");
  assert.match(css, /\.message-feed-menu \.message-feed-emojis \{\s*display: grid; grid-template-columns: repeat\(4, 42px\);/, "八枚排成 4×2");
  assert.match(css, /\.message-feed-menu \.message-menu-action \{[\s\S]{0,90}height: 42px/, "动作键也是 42px");
  assert.match(css, /\.ch-copy-box textarea/, "剪贴板兜底框的样式在这儿");
  // 本体 panel.css 一处都没动：这一页收间距靠 #chat 前缀，不是去改 .msg-col
  assert.match(panelCssText(), /\.msg-col \{ display: flex; flex-direction: column; min-width: 0; \}/, "本体 .msg-col 不该被改");
});

test("右键菜单：伙伴那条八枚投喂 + 复制/引用/收藏，自己那条只有复制/引用", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  const menu = menuOf(h);
  assert.equal(menu.hidden, false);
  assert.equal(emojiRowOf(h).children.length, 8, "八枚投喂");
  assert.deepEqual(emojiRowOf(h).children.map((button) => button.textContent), [...FEED_EMOJIS]);
  assert.deepEqual(menuLabels(h), ["复制", "引用", "收藏"]);

  openMenuAt(h, 0); // 自己那条
  assert.equal(emojiRowOf(h), undefined, "自己那条不投喂");
  const ownLabels = menuLabels(h);
  assert.deepEqual(ownLabels.slice(0, 2), ["复制", "引用"], "自己那条先给复制/引用");
  assert.ok(!ownLabels.includes("收藏"), "自己那条不收藏");
  // 管理动作（撤回/编辑…）由工具模块自己决定，不能把投喂/收藏塞进自己那侧
  assert.ok(!ownLabels.includes("投喂"), "自己那条不投喂");

  // 撤回占位：根本不绑菜单
  assert.equal((h.el("msgs").children[3].handlers.contextmenu ?? []).length, 0, "撤回占位不绑右键");
  await h.client.closeChat();
});

test("长按 500ms 才开菜单；位移、第二指、抬起都取消", async (t) => {
  const h = await openMenuThread(t);
  const row = h.el("msgs").children[1];
  const menu = menuOf(h);
  const press = (x = 30, y = 300) => h.fireOn(row, "pointerdown", { button: 0, isPrimary: true, clientX: x, clientY: y });

  press();
  await tick(120);
  h.fireOn(row, "pointerup", {});
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menu.hidden, true, "普通点按不该开菜单");

  press();
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menu.hidden, false, "按住不动到 500ms 该开出来");
  clickOutside(h);

  press();
  h.fireOn(row, "pointermove", { clientX: 80, clientY: 300 });
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menu.hidden, true, "按住后滑走是在滚，不是长按");

  press();
  h.fireOn(row, "pointerdown", { button: 0, isPrimary: false, clientX: 40, clientY: 300 });
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menu.hidden, true, "第二指按下就把这一按作废");

  press();
  await tick(80);
  h.fireOn(row, "pointerup", {});
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menu.hidden, true, "抬手了就不算长按");

  // Shift+F10 / ContextMenu 键也能开
  h.fireOn(row, "keydown", { key: "F10", shiftKey: true, preventDefault() {} });
  assert.equal(menu.hidden, false, "键盘也要能开");
  clickOutside(h);
  h.fireOn(row, "keydown", { key: "ContextMenu", preventDefault() {} });
  assert.equal(menu.hidden, false);
  await h.client.closeChat();
});

test("长按后这一下点图不算数，普通点击照旧打开大图", async (t) => {
  const h = await withClient(t, { threadFor: { A: imageThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  const img = findByClass(h.el("msgs"), "ch-img");
  assert.ok(img, "图应该画出来了");

  img.click();
  assert.equal(h.el("overlay").hidden, false, "普通点击就该放大");
  h.el("overlayClose").click();
  assert.equal(h.el("overlay").hidden, true);

  const row = h.el("msgs").children[0];
  h.fireOn(row, "pointerdown", { button: 0, isPrimary: true, clientX: 20, clientY: 200 });
  await tick(LONG_PRESS_MS + 60);
  assert.equal(menuOf(h).hidden, false, "长按先把菜单开出来");

  img.click();
  assert.equal(h.el("overlay").hidden, true, "长按那一下不许顺手弹大图");

  img.click();
  assert.equal(h.el("overlay").hidden, false, "下一次普通点击照旧");
  await h.client.closeChat();
  assert.ok(LONG_PRESS_CLICK_SUPPRESS_MS > 0);
});

test("菜单摆位：贴右边缘夹回视口，下方放不下翻到上面", async (t) => {
  const view = { width: 390, height: 640 };
  const box = { width: 200, height: 120 };
  const right = menuPlacement({ left: 360, top: 380, bottom: 540 }, box, view);
  assert.equal(right.left, 182, "390-200-8");
  assert.equal(right.below, false, "下方 548+120 超过 640-8");
  assert.equal(menuPlacement({ left: 360, top: 380, bottom: 500 }, box, view).below, true, "508+120仍放得下，不应提前翻转");
  assert.equal(right.top, 252, "翻到上面：380-120-8");
  assert.deepEqual(menuPlacement({ left: 10, top: 10, bottom: 100 }, box, view), { left: 10, top: 108, below: true });
  assert.equal(menuPlacement({ left: 4, top: 0, bottom: 20 }, { width: 390, height: 40 }, view).left, 8, "左边也不许出界");
  assert.equal(menuPlacement({ left: 30, top: 10, bottom: 40 }, box, { width: 0, height: 0 }).left, 30, "没有视口信息就只贴边");

  // 真 client 里也真的写到 style 上
  const h = await openMenuThread(t);
  const menu = menuOf(h);
  menu._rect = { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 };
  const row = h.el("msgs").children[1];
  row._rect = { left: 360, top: 380, right: 390, bottom: 540, width: 30, height: 160 };
  openMenuAt(h, 1);
  assert.equal(menu.style.getPropertyValue("left"), "182px");
  assert.equal(menu.style.getPropertyValue("top"), "252px");
  assert.equal(menu.classList.contains("below"), false);
  await h.client.closeChat();
});

test("投喂：POST message.feed，回来的份数落在挂件上；在途再点不发第二份", async (t) => {
  const h = await openMenuThread(t);
  const menu = menuOf(h);
  openMenuAt(h, 1);
  emojiRowOf(h).children[0].click();
  await tick(2);

  const call = h.net.calls.at(-1);
  assert.equal(call.path, "/api/message.feed");
  assert.equal(call.init.method, "POST", "写操作不许走 GET");
  assert.deepEqual(call.body, { agentId: "A", messageId: "m2", emoji: "☕" });
  assert.equal(call.init.headers.authorization, "Bearer tk-test");
  assert.equal(menu.hidden, true, "点了就收菜单");

  openMenuAt(h, 1);
  emojiRowOf(h).children[0].click();
  await tick(2);
  assert.equal(h.net.feeds.length, 1, "同一枚在途时再点不许发第二份");
  openMenuAt(h, 1);
  assert.ok(emojiRowOf(h).children.every((button) => button.disabled), "同条消息在途时全部投喂禁用");
  emojiRowOf(h).children[1].click();
  await tick(2);
  assert.equal(h.net.feeds.length, 1, "不同emoji也不并发，免得回包乱序覆盖份数");

  h.net.feedOk({ items: [{ emoji: "☕", count: 2, at: "2026-10-30T10:10:00.000Z" }] });
  await tick(5);

  const widget = findByClass(h.el("msgs"), "message-feed");
  assert.ok(widget, "自己这侧要画出投喂挂件");
  assert.equal(widget.className, "message-feed");
  assert.equal(findByClass(widget, "message-feed-emoji").textContent, "☕");
  assert.equal(findByClass(widget, "message-feed-count").textContent, "2份");
  assert.equal(String(h.el("state").textContent), "已投喂 ☕");
  await h.client.closeChat();
});

test("投喂失败：不自己 +1、不重复投，提示留在自己这侧", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  emojiRowOf(h).children[0].click();
  await tick(2);
  h.net.feedFail(500, "宿主没接住");
  await tick(5);

  assert.equal(String(h.el("state").textContent), "宿主没接住");
  const target = h.client.state.thread.messages.find((row) => row.id === "m2");
  assert.equal(target.feed, undefined, "结果不明时绝不能自己记一份");
  assert.equal(findByClass(h.el("msgs"), "message-feed"), null, "没成就不画挂件");
  assert.equal(h.net.feeds.length, 1, "失败不自动重投");
  await h.client.closeChat();
});

test("投喂 401：跟别的接口一样回解锁页", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  emojiRowOf(h).children[0].click();
  await tick(2);
  h.net.feedFail(401, "先解锁");
  await tick(5);

  assert.equal(h.el("gate").hidden, false, "回解锁页");
  assert.equal(h.el("chat").hidden, true);
  assert.equal(menuOf(h).hidden, true);
});

test("投喂晚回包：切到 B 之后一个字都不许落到 B 上", async (t) => {
  const h = await withClient(t, {
    threadFor: {
      A: menuThread(),
      B: { messages: [msg({ id: "b1", seq: 1, role: "assistant", text: "B 在" })], total: 1, hasMore: false },
    },
  });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  openMenuAt(h, 1);
  emojiRowOf(h).children[0].click();
  await tick(2);

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(2);
  h.net.feedOk({ items: [{ emoji: "☕", count: 1 }] });
  await tick(5);

  assert.equal(findByClass(h.el("msgs"), "message-feed"), null, "B 的列表里不许冒出 A 的投喂");
  const b = h.client.state.thread.messages.find((row) => row.id === "b1");
  assert.equal(b?.feed, undefined, "B 的消息一个字没被碰");
  assert.equal(String(h.el("state").textContent), "", "更不许报在 B 头上");
  await h.client.closeChat();
});

test("投喂前核当前线程：那条已经撤回就不发", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  const target = h.client.state.thread.messages.find((row) => row.id === "m2");
  target.recalled = true;
  emojiRowOf(h).children[0].click();
  await tick(2);

  assert.equal(h.net.feeds.length, 0, "撤回的那条不该还能喂");
  assert.equal(String(h.el("state").textContent), "这条已经不在了");
  await h.client.closeChat();
});

test("收藏：POST message.favorite，回包决定提示，没有管理页", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  menuButton(h, "收藏").click();
  await tick(2);

  const call = h.net.calls.at(-1);
  assert.equal(call.path, "/api/message.favorite");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.body, { agentId: "A", messageId: "m2" });
  h.net.favoriteOk(true);
  await tick(5);
  assert.equal(String(h.el("state").textContent), "收藏好了");

  openMenuAt(h, 1);
  menuButton(h, "收藏").click();
  await tick(2);
  h.net.favoriteOk(false);
  await tick(5);
  assert.equal(String(h.el("state").textContent), "已取消收藏", "取消收藏也要说实话");
  assert.equal(h.net.calls.filter((row) => row.path.includes("favorites")).length, 0, "不进管理页、不拉收藏列表");
  await h.client.closeChat();
});

test("复制：navigator 被拒退到 execCommand；两层都不行只摆只读框，不谎报成功", async (t) => {
  const h = await openMenuThread(t);
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete globalThis.navigator;
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error("blocked"); } } },
  });

  let execCalls = 0;
  h.dom.doc.execCommand = () => { execCalls += 1; return true; };
  openMenuAt(h, 1);
  menuButton(h, "复制").click();
  await tick(5);
  assert.equal(execCalls, 1, "navigator 不行就用 textarea 那条老办法");
  assert.equal(String(h.el("state").textContent), "复制好了");
  assert.equal(copyBoxOf(h).hidden, true, "成功了就不用摆后备框");

  h.dom.doc.execCommand = () => false;
  openMenuAt(h, 1);
  menuButton(h, "复制").click();
  await tick(5);
  const box = copyBoxOf(h);
  assert.equal(box.hidden, false, "真的没写进去就把正文摆出来");
  assert.equal(box.children[0].value, "在呢", "框里得是那条的正文");
  assert.ok("readonly" in box.children[0].attrs, "只读，别让她改动原话");
  assert.notEqual(String(h.el("state").textContent), "复制好了", "不许谎报成功");
  assert.match(String(h.el("state").textContent), /自己复制/);
  // 不占草稿、不动输入框
  assert.equal(h.el("input").value, "");
  assert.equal(h.el("quoteBar").hidden, true);
  assert.equal(h.el("draft").hidden, true);
  await h.client.closeChat();
});

test("引用：不露 STICKER_PREFIX；所选片段优先，跨行选择宁可不带", async (t) => {
  const h = await openMenuThread(t);

  openMenuAt(h, 2); // 表情包那条
  menuButton(h, "引用").click();
  await tick(2);
  assert.equal(h.el("quoteBar").hidden, false);
  assert.equal(h.el("quoteText").textContent, "[表情]");
  assert.ok(!String(h.el("quoteText").textContent).includes("\u0001"), "控制字绝不许露出来");
  h.el("quoteDrop").click();

  const selectedRow = h.el("msgs").children[1];
  h.dom.doc.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: selectedRow.children[0], focusNode: selectedRow.children[0], toString: () => "刚睡醒" });
  openMenuAt(h, 1);
  menuButton(h, "引用").click();
  await tick(2);
  assert.equal(h.el("quoteText").textContent, "刚睡醒", "引她指的那段");
  h.el("quoteDrop").click();

  h.dom.doc.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: h.el("msgs").children[0], focusNode: selectedRow, toString: () => "在呢\n刚睡醒" });
  openMenuAt(h, 1);
  menuButton(h, "引用").click();
  await tick(2);
  assert.equal(h.el("quoteText").textContent, "在呢", "跨行选择不许误带，回落整条正文");
  await h.client.closeChat();
});

test("伙伴投喂挂件：只要已读、且在她回话之前递的", async (t) => {
  const fed = msg({
    id: "u1",
    seq: 1,
    role: "user",
    text: "我睡了",
    readAt: "2026-10-30T10:05:00.000Z",
    partnerFeed: { items: [{ emoji: "🍵", count: 1, at: "2026-10-30T10:04:00.000Z" }] },
  });
  const h = await withClient(t, { threadFor: { A: { messages: [fed], total: 1, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  const widget = allByClass(h.el("msgs"), "message-feed from-partner")[0];
  assert.ok(widget, "已读 + 递过的要画");
  assert.equal(findByClass(widget, "message-feed-emoji").textContent, "🍵");

  // 未读：不许挂（等于替 ta 说了她还没说的话）
  h.net.threads.set("A", { messages: [msg({ ...fed, readAt: null })], total: 1, hasMore: false });
  await h.client.pull();
  await tick(3);
  assert.equal(allByClass(h.el("msgs"), "message-feed from-partner").length, 0, "未读的不画");

  // 她在投喂之前就回了话：这份投喂已经过期
  h.net.threads.set("A", {
    messages: [fed, msg({ id: "r1", seq: 2, role: "assistant", text: "睡吧", repliedTo: "u1", at: "2026-10-30T10:03:00.000Z" })],
    total: 2,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  assert.equal(allByClass(h.el("msgs"), "message-feed from-partner").length, 0, "回复早于投喂就不算");

  // 她后来才回：那份投喂仍然算数
  h.net.threads.set("A", {
    messages: [fed, msg({ id: "r2", seq: 2, role: "assistant", text: "睡吧", repliedTo: "u1", at: "2026-10-30T10:10:00.000Z" })],
    total: 2,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  assert.equal(allByClass(h.el("msgs"), "message-feed from-partner").length, 1, "回复在后面，照画");
  await h.client.closeChat();
});

test("签名与投喂口径：feed/partnerFeed/readAt 都进签名，份数只认宿主那份账", () => {
  const base = msg();
  assert.notEqual(signatureOf([msg({ feed: { items: [{ emoji: "☕", count: 1 }] } })]), signatureOf([base]), "投喂变了要重画");
  assert.notEqual(signatureOf([msg({ partnerFeed: { items: [{ emoji: "🍵", count: 1 }] } })]), signatureOf([base]));
  assert.notEqual(signatureOf([msg({ readAt: "2026-10-30T11:00:00.000Z" })]), signatureOf([base]));
  assert.notEqual(signatureOf([msg({ repliedTo: "u1" })]), signatureOf([base]), "回复指向变化要重画投喂截断结果");
  assert.notEqual(signatureOf([msg({ repliedTo: "u1", at: "2026-10-30T10:00:00.000Z" })]), signatureOf([msg({ repliedTo: "u1", at: "2026-10-30T11:00:00.000Z" })]), "真正回复的时间决定投喂是否过期");

  assert.equal(feedSignatureOf({ items: [{ emoji: "☕", count: 1 }, { emoji: "🍵", count: 2 }] }), "☕:1:/🍵:2:");
  assert.deepEqual(messageFeedItems({ items: [{ emoji: "☕", count: 1 }, { emoji: "☕", count: 2 }] }), [{ emoji: "☕", count: 3, at: null }]);
  assert.deepEqual(messageFeedItems({ emoji: "☕" }), [{ emoji: "☕", count: 1, at: null }], "旧账只剩一枚也认");
  assert.equal(formatMessageFeed({ items: [{ emoji: "☕", count: 3 }] }), "☕×3");

  const row = msg({ id: "u1", role: "user", partnerFeed: { items: [{ emoji: "🍵", count: 1, at: "2026-10-30T10:04:00.000Z" }] } });
  const replyAt = (at) => msg({ id: "r1", seq: 9, role: "assistant", repliedTo: "u1", at });
  assert.equal(visiblePartnerFeedItems(row, [row]).length, 1);
  assert.equal(visiblePartnerFeedItems(row, [row, replyAt("2026-10-30T10:10:00.000Z")]).length, 1);
  assert.equal(visiblePartnerFeedItems(row, [row, replyAt("2026-10-30T10:03:00.000Z")]).length, 0);

  assert.equal(messageTextOf(msg({ text: "\u0001stk:s1" })), "[表情]");
  assert.equal(messageTextOf(msg({ text: "", voice: { status: "ready" } })), "[语音]");
  assert.equal(messageTextOf(msg({ text: "", attachment: { id: "a1" } })), "[图片]");
  assert.equal(messageTextOf(msg({ recalled: true })), "");
  assert.equal(feedableMessage(msg()), true);
  assert.equal(feedableMessage(msg({ role: "user" })), false, "自己那条不投喂");
  assert.equal(feedableMessage(msg({ recalled: true })), false);
  assert.equal(feedableMessage(msg({ voice: { status: "pending" } })), false, "还没录好的语音不能喂");
  assert.equal(actionableMessage(msg({ role: "user" })), true);
  assert.equal(actionableMessage(msg({ recalled: true })), false);
  assert.equal(actionableMessage(msg({ id: "" })), false);
});

test("菜单收尾：点外、ESC、滚动、换人、重绘都关；destroy 把文档监听收干净", async (t) => {
  const h = await withClient(t, {
    threadFor: {
      A: menuThread(),
      B: { messages: [msg({ id: "b1", seq: 1, role: "assistant", text: "B 在" })], total: 1, hasMore: false },
    },
  });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(2);
  const menu = menuOf(h);

  openMenuAt(h, 1);
  assert.equal(menu.hidden, false);
  clickOutside(h);
  assert.equal(menu.hidden, true, "点外要收");

  openMenuAt(h, 1);
  pressEsc(h);
  assert.equal(menu.hidden, true, "ESC 要收");

  openMenuAt(h, 1);
  h.fire("msgs", "scroll");
  assert.equal(menu.hidden, true, "一滑就收");

  openMenuAt(h, 1);
  await h.client.openChat({ id: "B", name: "小满" });
  assert.equal(menu.hidden, true, "换人要收");

  h.net.threads.set("B", {
    messages: [msg({ id: "b1", seq: 1, role: "assistant", text: "B 在" }), msg({ id: "b2", seq: 2, role: "user", text: "嗯" })],
    total: 2,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  openMenuAt(h, 1);
  assert.equal(menu.hidden, false);

  h.net.threads.set("B", {
    messages: [
      msg({ id: "b1", seq: 1, role: "assistant", text: "B 在" }),
      msg({ id: "b2", seq: 2, role: "user", text: "嗯" }),
      msg({ id: "b3", seq: 3, role: "assistant", text: "又一句" }),
    ],
    total: 3,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  assert.equal(menu.hidden, true, "重绘时菜单跟着那行旧节点一起作废");

  assert.ok((h.dom.docListeners.pointerdown ?? []).length >= 1);
  h.client.destroy();
  assert.equal((h.dom.docListeners.pointerdown ?? []).length, 0, "destroy 要摘掉文档级监听");
  assert.equal((h.dom.docListeners.keydown ?? []).length, 0);
  assert.equal(menu.hidden, true);
});

test("皮肤属性两个根都挂：#chat 与 #msgs 同步 data-me-skin/data-ta-skin，背景变量仍在 #chat", async (t) => {
  const h = await withClient(t, {
    threadFor: { A: { ...menuThread(), meSkin: "bear", taSkin: "celadon", showAvatars: true } },
  });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  for (const id of ["chat", "msgs"]) {
    assert.equal(h.el(id).attrs["data-me-skin"], "bear", `#${id} 也要挂自己那枚皮肤`);
    assert.equal(h.el(id).attrs["data-ta-skin"], "celadon", `#${id} 也要挂伙伴那枚皮肤`);
  }
  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  for (const id of ["chat", "msgs"]) {
    assert.equal(h.el(id).attrs["data-me-skin"], undefined, `切到没皮肤的伙伴要摘掉`);
    assert.equal(h.el(id).attrs["data-ta-skin"], undefined);
  }
  h.client.destroy();
});

test("菜单真DOM契约：内部pointerdown不误关，随后click仍能引用；外部才关闭", async (t) => {
  const h = await openMenuThread(t);
  openMenuAt(h, 1);
  const button = menuButton(h, "引用");
  // 标准DOM形状：只有parentNode，故意不提供fake专属parent。
  const target = { parentNode: button };
  for (const fn of h.dom.docListeners.pointerdown ?? []) fn({ target });
  assert.equal(menuOf(h).hidden, false);
  button.click();
  assert.equal(h.el("quoteText").textContent, "在呢");
  openMenuAt(h, 1);
  clickOutside(h);
  assert.equal(menuOf(h).hidden, true);
});

test("引用选区：另一行的相同文字不算本行；本行端点才采纳", () => {
  const local = {};
  const foreign = {};
  const row = { textContent: "在呢", contains: (node) => node === local };
  const selected = (anchorNode, focusNode) => ({ getSelection: () => ({ isCollapsed: false, rangeCount: 1, anchorNode, focusNode, toString: () => "在呢" }) });
  assert.equal(selectedTextOf(selected(foreign, foreign), row), "");
  assert.equal(selectedTextOf(selected(local, foreign), row), "");
  assert.equal(selectedTextOf(selected(local, local), row), "在呢");
});

test("自己的图文同泡：引用只画一次，图与多段正文共用一个气泡、共用间距列", async (t) => {
  const h = await openMenuThread(t, { messages: [msg({ id: "u1", role: "user", text: "两段", bubbles: ["第一段", "第二段"], attachment: { id: "pic" }, quote: { messageId: "a1", text: "引用原文" } })], total: 1, hasMore: false });
  const row = h.el("msgs").children[0];
  assert.equal(row.className, "row me");
  assert.equal(allByClass(row, "ch-quote-strip").length, 1, "引用块只画一次");
  assert.equal(allByClass(row, "msg-line").length, 1, "图文同泡：只有一层气泡");
  const media = findByClass(row, "bubble ch-media");
  assert.ok(media, "图和字装在同一个气泡里");
  assert.equal(allByClass(media, "ch-img").length, 1, "图在气泡里");
  assert.equal(allByClass(media, "ch-media-text").length, 2, "两段正文也在同一个气泡里");
  assert.equal(allByClass(row, "msg-col").length, 1);
  h.net.threads.set("A", { messages: [msg({ id: "u1", role: "user", recalled: true })], total: 1, hasMore: false });
  await h.client.pull();
  assert.equal(h.el("msgs").children[0].className, "row me", "自己撤回的占位也应留在自己这侧");
  assert.equal(allByClass(h.el("msgs"), "ch-quote-strip").length, 0);
});

test("长按：文档第二指和滚动都取消；右键按住不启动长按", async (t) => {
  const h = await openMenuThread(t);
  const row = h.el("msgs").children[1];
  const press = () => h.fireOn(row, "pointerdown", { button: 0, isPrimary: true, clientX: 20, clientY: 20 });
  press();
  for (const fn of h.dom.docListeners.pointerdown ?? []) fn({ isPrimary: false, target: h.el("msgs") });
  await tick(LONG_PRESS_MS + 30);
  assert.equal(menuOf(h).hidden, true);
  press();
  h.fire("msgs", "scroll");
  await tick(LONG_PRESS_MS + 30);
  assert.equal(menuOf(h).hidden, true);
  h.fireOn(row, "pointerdown", { button: 2, clientX: 20, clientY: 20 });
  await tick(LONG_PRESS_MS + 30);
  assert.equal(menuOf(h).hidden, true);
});

test("复制旧API抛错：临时textarea仍移除并恢复焦点，草稿不变", async (t) => {
  const h = await openMenuThread(t);
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => saved ? Object.defineProperty(globalThis, "navigator", saved) : delete globalThis.navigator);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  h.type("input", "没发出的新草稿");
  h.el("input").focus();
  const count = h.el("chat").children.length;
  h.dom.doc.execCommand = () => { throw new Error("denied"); };
  openMenuAt(h, 1);
  menuButton(h, "复制").click();
  await tick(5);
  assert.equal(h.el("chat").children.length, count, "临时textarea必须在finally移除");
  assert.equal(h.dom.doc.activeElement, h.el("input"));
  assert.equal(h.el("input").value, "没发出的新草稿");
  assert.equal(copyBoxOf(h).hidden, false);
});

test("复制权限迟到拒绝：换人、退出、撤回均不再露旧原文或改新草稿", async (t) => {
  for (const action of ["switch", "close", "recall"]) await t.test(action, async (t) => {
    const h = await openMenuThread(t);
    const pending = deferred();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    t.after(() => saved ? Object.defineProperty(globalThis, "navigator", saved) : delete globalThis.navigator);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: () => pending.promise } } });
    let fallbackCalls = 0;
    h.dom.doc.execCommand = () => { fallbackCalls++; return false; };
    openMenuAt(h, 1);
    menuButton(h, "复制").click();
    if (action === "switch") await h.client.openChat({ id: "B", name: "另一位" });
    else if (action === "close") h.client.closeChat();
    else h.client.state.thread.messages.find((m) => m.id === "m2").recalled = true;
    h.type("input", "新草稿");
    const status = h.el("state").textContent;
    pending.reject(new Error("late denied"));
    await tick(5);
    assert.equal(copyBoxOf(h).hidden, true);
    assert.equal(fallbackCalls, 0, "失效后也不能创建临时textarea抢焦点");
    assert.equal(h.el("state").textContent, status);
    assert.equal(h.el("input").value, "新草稿");
  });
});

test("语音布局例外：控制行横排、自己反向，转写用本体字号和6px间距", () => {
  const css = mobileCssText();
  assert.match(css, /#chat \.row \.msg-line\.voice-controls-line \{ flex-direction: row; align-items: center; gap: 8px; \}/);
  assert.match(css, /#chat \.row\.me \.msg-line\.voice-controls-line \{ flex-direction: row-reverse; \}/);
  assert.match(css, /#chat \.msg-col\.voice-col \{ gap: 0; \}/);
  assert.match(css, /#chat \.voice-transcript \{ font-size: 13px; line-height: 1\.6; \}/);
  assert.match(panelCssText(), /\.voice-transcript-line \{ margin-top: 6px; \}/);
  assert.match(css, /#chat \.msg-col \{ gap: 8px; \}/, "普通多气泡间距不回退");
});

test("两侧语音转文字：按钮与语音同层，文字在下方独立行，收起不留空行", async (t) => {
  const messages = ["assistant", "user"].map((role, i) => msg({ id: `v${i}`, seq: i + 1, role, text: "", voice: { status: "ready", durationMs: 3000, text: `${role}的转写` } }));
  const h = await withClient(t, { threadFor: { A: { messages, total: 2, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  for (let i = 0; i < 2; i++) {
    const row = h.el("msgs").children[i];
    assert.ok(row.classList.contains(i ? "me" : "ta"));
    const col = findByClass(row, "voice-col");
    const controls = findByClass(row, "voice-controls-line");
    const button = findByClass(row, "voice-transcript-toggle");
    const transcriptLine = findByClass(row, "voice-transcript-line");
    const transcript = findByClass(row, "voice-transcript");
    assert.equal(controls.children[0], findByClass(row, "voice-bubble"));
    assert.equal(controls.children[1], button);
    assert.equal(col.children[0], controls);
    assert.equal(col.children[1], transcriptLine);
    assert.equal(transcriptLine.children[0], transcript);
    assert.equal(transcriptLine.hidden, true);
    button.click();
    assert.equal(button.textContent, "收起文字");
    assert.equal(transcriptLine.hidden, false);
    assert.equal(transcript.hidden, false);
    assert.equal(transcript.textContent, `${messages[i].role}的转写`);
    button.click();
    assert.equal(button.textContent, "转文字");
    assert.equal(transcript.hidden, true);
    assert.equal(transcriptLine.hidden, true);
  }
  assert.equal(h.net.calls.filter((row) => row.path.startsWith("/voice")).length, 0, "展开转写不下载或播放音频");
});


// ── 2026-10-31：播放/已读/时间/草稿/表情/工具接线（真 client + 假 DOM）──

test("语音 playedAt 变了不整段重画：气泡节点不动、正在放的还在放、未听圆点当场收", async (t) => {
  const h = await withClient(t, { threadFor: { A: voiceThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const bubble = findByClass(h.el("msgs"), "voice-bubble");
  const dot = findByClass(h.el("msgs"), "voice-unplayed-dot");
  assert.ok(dot, "伙伴发的语音先挂未听圆点");
  assert.equal(dot.hidden, false);

  findVoicePlay(h.el("msgs")).click();
  await tick(5);
  assert.equal(h.audios.length, 1);
  assert.equal(h.audios[0].paused, false, "真放起来了");
  assert.equal(dot.hidden, true, "本地听过当场收点，不等轮询");

  // 轮询只带回 playedAt：属于「非本体」，不重画
  h.net.threads.set("A", {
    messages: [msg({ id: "m1", seq: 1, role: "assistant", text: "", voice: { status: "ready", durationMs: 3000, text: "嗯，在呢", playedAt: "2026-10-30T10:00:05.000Z" } })],
    total: 1,
    hasMore: false,
  });
  await h.client.pull();
  await tick(5);

  assert.equal(findByClass(h.el("msgs"), "voice-bubble"), bubble, "同一个语音气泡节点，没被重建");
  assert.equal(h.audios[0].paused, false, "正在放的音频不许被掉");
  assert.equal(findByClass(h.el("msgs"), "voice-unplayed-dot").hidden, true);
  await h.client.closeChat();
});

test("新消息只补新的：看旧记录的人不被拖走，贴底才自动滚，回到底部键能回去", async (t) => {
  const base = [
    msg({ id: "m1", seq: 1, role: "user", text: "第一句" }),
    msg({ id: "m2", seq: 2, role: "assistant", text: "第二句" }),
  ];
  const h = await withClient(t, { threadFor: { A: { messages: base, total: 2, hasMore: true } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const msgs = h.el("msgs");
  msgs.scrollHeight = 900;
  msgs.clientHeight = 400;
  msgs.scrollTop = 100; // 在看旧记录，不贴底
  const firstRow = msgs.children[0];

  h.net.threads.set("A", { messages: [...base, msg({ id: "m3", seq: 3, role: "assistant", text: "第三句" })], total: 3, hasMore: true });
  msgs.scrollHeight = 1000;
  await h.client.pull();
  await tick(3);

  assert.equal(msgs.children[0], firstRow, "旧 DOM 没被重建（增量追加上去的）");
  assert.equal(msgs.children.length, 3);
  assert.equal(msgs.scrollTop, 100, "新内容接在下面，阅读位置一动不动");
  assert.equal(h.el("jumpBottom").hidden, false, "离开底部时给回到底部键");

  h.el("jumpBottom").click();
  assert.equal(msgs.scrollTop, msgs.scrollHeight, "点它就回到底");

  h.net.threads.set("A", {
    messages: [...base, msg({ id: "m3", seq: 3, role: "assistant", text: "第三句" }), msg({ id: "m4", seq: 4, role: "assistant", text: "第四句" })],
    total: 4,
    hasMore: true,
  });
  msgs.scrollHeight = 1100;
  await h.client.pull();
  await tick(3);
  assert.equal(msgs.children.length, 4);
  assert.equal(msgs.scrollTop, 1100, "贴着底就跟着滚下去");
  await h.client.closeChat();
});

test("转写展开按 messageId 记着：整段重画之后还开着", async (t) => {
  const h = await openMenuThread(t, {
    messages: [
      msg({ id: "m1", seq: 1, role: "assistant", text: "", voice: { status: "ready", durationMs: 2000, text: "嗯，在呢" } }),
      msg({ id: "m2", seq: 2, role: "user", text: "听着呢" }),
    ],
    total: 2,
    hasMore: false,
  });
  const toggle = findByClass(h.el("msgs"), "voice-transcript-toggle");
  toggle.click();
  assert.equal(toggle.textContent, "收起文字");

  // 改一句正文 → 整段重画
  h.net.threads.set("A", {
    messages: [
      msg({ id: "m1", seq: 1, role: "assistant", text: "", voice: { status: "ready", durationMs: 2000, text: "嗯，在呢" } }),
      msg({ id: "m2", seq: 2, role: "user", text: "听着呢，你说" }),
    ],
    total: 2,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);

  const reopened = findByClass(h.el("msgs"), "voice-transcript-toggle");
  assert.equal(reopened.textContent, "收起文字", "重画之后还开着");
  assert.equal(findByClass(h.el("msgs"), "voice-transcript-line").hidden, false);
  await h.client.closeChat();
});

test("语音没念出来的气泡照旧摆回，链接只放 http(s) 并带 noopener", async (t) => {
  const thread = {
    messages: [msg({
      id: "m1",
      seq: 1,
      role: "assistant",
      text: "",
      bubbles: ["听我说", "看这个 https://example.com/x?a=1", "javascript:alert(1)"],
      voice: { status: "ready", durationMs: 2000, text: "听我说" },
    })],
    total: 1,
    hasMore: false,
  };
  const h = await withClient(t, { threadFor: { A: thread } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const leftovers = allByClass(h.el("msgs"), "voice-leftover-line");
  assert.equal(leftovers.length, 2, "念不出来的两句都摆回来了");
  const anchors = allByClass(h.el("msgs"), "ch-text-link");
  assert.equal(anchors.length, 1, "只有真 http 链接做成锚点");
  assert.equal(anchors[0].attrs.href, "https://example.com/x?a=1");
  assert.equal(anchors[0].attrs.rel, "noopener noreferrer");
  assert.equal(anchors[0].attrs.target, "_blank");
  assert.ok(leftovers[1].textContent.includes("javascript:alert(1)"), "危险协议原样当文字");
  assert.equal(leftovers[1].children.some((node) => node.tag === "a"), false, "不做成链接");
  await h.client.closeChat();
});

test("时间刻度/每条时间/已读小字：隔了十分钟插刻度，已读只拨那行小字", async (t) => {
  const first = msg({ id: "u1", seq: 1, role: "user", text: "我出门了", at: "2026-10-30T10:00:00.000Z" });
  const second = msg({ id: "a1", seq: 2, role: "assistant", text: "路上小心", at: "2026-10-30T10:25:00.000Z" });
  const h = await withClient(t, { threadFor: { A: { messages: [first, second], total: 2, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const dividers = allByClass(h.el("msgs"), "time-divider");
  assert.equal(dividers.length, 1, "隔了 25 分钟插一条");
  assert.match(dividers[0].textContent, /\d{2}:\d{2}/, "刻度写的是算出来的时刻");
  assert.equal(allByClass(h.el("msgs"), "ch-msg-time").length, 2, "每条都有时间（触控屏 hover 不到）");
  assert.equal(findByClass(h.el("msgs"), "ch-read-state").textContent, "未读");
  assert.match(String(findByClass(h.el("msgs"), "ch-read-state").className), /(^|\s)tick(\s|$)/, "未读小字穿本体的 .tick");

  const taRow = findByClass(h.el("msgs"), "row ta");
  h.net.threads.set("A", { messages: [{ ...first, readAt: "2026-10-30T10:30:00.000Z" }, second], total: 2, hasMore: false });
  await h.client.pull();
  await tick(3);
  assert.equal(findByClass(h.el("msgs"), "row ta"), taRow, "已读只收标记，伙伴那一行不重画");
  assert.equal(findByClass(h.el("msgs"), "ch-read-state"), null, "读到就收起，不留一个「已读」");
  await h.client.closeChat();
});

test("未读小字：外观全用本体 .tick，手机只抵列间距，不复制粉色也不另写灰字", () => {
  const css = mobileCssText();
  assert.match(css, /#chat \.ch-read-state \{ margin-top: -5px; \}/, "只留必要的布局抵消");
  assert.doesNotMatch(css, /ch-read-state \{[^}]*color:/, "颜色共享 .tick，不另写");
  assert.doesNotMatch(css, /ch-read-state \{[^}]*font-size:/, "字号也共享 .tick");
  assert.doesNotMatch(css, /--blossom|#eb6b8a/, "不把本体的粉色硬写一份");
  const panel = panelCssText();
  assert.match(panel, /\.tick \{[\s\S]{0,160}color: var\(--blossom\)/, ".tick 本体还在，直接共享");
  assert.match(panel, /\.tick::before \{[\s\S]{0,160}border-radius: 50%/, "小圆点也还是本体给的");
});

test("未读标记：读后收起、再次未读重建，都不碰伙伴那行与正在放的语音", async (t) => {
  const mine = msg({ id: "u1", seq: 1, role: "user", text: "我先说" });
  const voice = msg({ id: "a1", seq: 2, role: "assistant", text: "", voice: { status: "ready", durationMs: 2000, text: "嗯" } });
  const h = await withClient(t, { threadFor: { A: { messages: [mine, voice], total: 2, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const mark = findByClass(h.el("msgs"), "ch-read-state");
  assert.ok(mark, "自己最后那句下面有一枚");
  assert.match(String(mark.className), /(^|\s)tick(\s|$)/, "穿的是本体 .tick");
  assert.equal(mark.textContent, "未读");

  findVoicePlay(h.el("msgs")).click();
  await tick(5);
  assert.equal(h.audios[0].paused, false);
  const voiceBubble = findByClass(h.el("msgs"), "voice-bubble");

  // 被读到了：只收标记
  h.net.threads.set("A", { messages: [{ ...mine, readAt: "2026-10-30T10:00:10.000Z" }, voice], total: 2, hasMore: false });
  await h.client.pull();
  await tick(5);
  assert.equal(findByClass(h.el("msgs"), "ch-read-state"), null, "读到就收起，不留「已读」");
  assert.equal(findByClass(h.el("msgs"), "voice-bubble"), voiceBubble, "伙伴那行没被重画");
  assert.equal(h.audios[0].paused, false, "正在放的语音没被掉");

  // 又变回未读：安全重建，不重画气泡
  h.net.threads.set("A", { messages: [mine, voice], total: 2, hasMore: false });
  await h.client.pull();
  await tick(5);
  const again = findByClass(h.el("msgs"), "ch-read-state");
  assert.ok(again, "重新未读要能再挂回来");
  assert.equal(again.textContent, "未读");
  assert.equal(findByClass(h.el("msgs"), "voice-bubble"), voiceBubble, "重建标记也不重画气泡");

  // 撤回那句自己的话：标记不能留在屏上
  h.net.threads.set("A", { messages: [{ ...mine, recalled: true }, voice], total: 2, hasMore: false });
  await h.client.pull();
  await tick(5);
  assert.equal(findByClass(h.el("msgs"), "ch-read-state"), null, "撤回之后不留标记");

  // 切到另一位（自己没说过话）：也不该有标记
  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  assert.equal(findByClass(h.el("msgs"), "ch-read-state"), null);
  await h.client.closeChat();
});

test("时间结构：每条消息一枚时间，落在自己的 msg-line 里，不是气泡列的直接子", async (t) => {
  const thread = {
    messages: [
      msg({ id: "t1", seq: 1, role: "assistant", text: "普通一句", at: "2026-10-30T10:00:00.000Z" }),
      msg({ id: "t2", seq: 2, role: "assistant", text: "第一段\n第二段", bubbles: ["第一段", "第二段"], at: "2026-10-30T10:01:00.000Z" }),
      msg({ id: "t3", seq: 3, role: "assistant", text: "配个图", attachment: { id: "a1", name: "猫.png", mimeType: "image/png" }, at: "2026-10-30T10:02:00.000Z" }),
      msg({ id: "t4", seq: 4, role: "assistant", text: "\u0001stk:s1", at: "2026-10-30T10:03:00.000Z" }),
      msg({ id: "t5", seq: 5, role: "assistant", text: "", voice: { status: "ready", durationMs: 2000, text: "听着" }, at: "2026-10-30T10:04:00.000Z" }),
      msg({ id: "u1", seq: 6, role: "user", text: "我最后说的", at: "2026-10-30T10:05:00.000Z" }),
    ],
    total: 6,
    hasMore: false,
  };
  const h = await withClient(t, { threadFor: { A: thread } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const rows = [...h.el("msgs").children].filter((node) => String(node?.className ?? "").includes("row"));
  assert.equal(rows.length, 6, "六条各自一行");
  for (const row of rows) {
    const stamps = allByClass(row, "ch-msg-time");
    assert.equal(stamps.length, 1, `每条只一枚时间（${row.className}）`);
    const line = stamps[0].parent;
    assert.ok(String(line?.className ?? "").split(/\s+/).includes("msg-line"), "时间在 msg-line 里，不在 col 上");
    assert.equal(String(line.className).includes("voice-transcript") || String(line.className).includes("voice-leftover"), false, "不挂转写/附带文");
    const col = allByClass(row, "msg-col")[0];
    assert.equal(col.children.includes(stamps[0]), false, "不是气泡列的直接子");
  }

  // 多气泡：时间跟着最后那一条正文行
  const multi = rows[1];
  const multiCol = allByClass(multi, "msg-col")[0];
  const multiLines = allByClass(multi, "msg-line");
  assert.equal(allByClass(multi, "ch-msg-time")[0].parent, multiLines.at(-1));
  assert.equal(multiLines.length, 2, "两段正文两个行");

  // 语音：时间在第一条控件行
  const voiceRow = findByClass(h.el("msgs"), "row voice-row");
  const voiceStamp = findByClass(voiceRow, "ch-msg-time");
  assert.match(String(voiceStamp.parent.className), /voice-controls-line/, "语音时间在控件行");

  // 自己的未读小字：col 的直接子，不包含时间，也不在时间下面另起一行
  const ownRow = allByClass(h.el("msgs"), "row me").at(-1);
  const ownCol = allByClass(ownRow, "msg-col")[0];
  const mark = findByClass(ownRow, "ch-read-state");
  assert.equal(mark.parent, ownCol, "未读是气泡列的直接子");
  assert.equal(String(mark.textContent).includes(":"), false, "未读里没有时间");
  assert.equal(findByClass(ownRow, "ch-msg-time").parent === ownCol, false, "时间不在气泡列上");

  // 读到：只收标记，气泡不动
  const bubble = allByClass(ownRow, "bubble")[0];
  h.net.threads.set("A", { ...thread, messages: thread.messages.map((row) => (row.id === "u1" ? { ...row, readAt: "2026-10-30T10:06:00.000Z" } : row)) });
  await h.client.pull();
  await tick(5);
  assert.equal(findByClass(h.el("msgs"), "ch-read-state"), null);
  assert.equal(allByClass(allByClass(h.el("msgs"), "row me").at(-1), "bubble")[0], bubble, "气泡节点没被重画");
  assert.equal(allByClass(h.el("msgs"), "ch-msg-time").length, 6, "时间还是一条一枚");
  await h.client.closeChat();
});

test("时间/未读布局契约：外侧绝对定位、窄屏留白、语音未读补回 3px", () => {
  const css = mobileCssText();
  assert.match(css, /#chat \.msg-line \{ position: relative; \}/, "时间以行作定位基准");
  assert.match(css, /#chat \.ch-msg-time \{[\s\S]{0,140}position: absolute; bottom: 0; margin: 0 0 2px;/, "绝对定位，不占一行");
  assert.match(css, /#chat \.ch-msg-time \{[\s\S]{0,200}white-space: nowrap/);
  assert.match(css, /#chat \.row\.me \.ch-msg-time \{ right: calc\(100% \+ 8px\); \}/, "自己的贴左侧外");
  assert.match(css, /#chat \.row\.ta \.ch-msg-time \{ left: calc\(100% \+ 8px\); \}/, "伙伴的贴右侧外");
  assert.doesNotMatch(css, /ch-msg-time \{[^}]*margin: -4px/, "旧的负上边距已移除");
  assert.doesNotMatch(css, /ch-msg-time \{[^}]*text-align/, "旧的对齐覆写已移除");
  assert.match(css, /@media \(max-width: 600px\) \{\s*#chat \.row\.me, #chat \.row\.ta \{ max-width: calc\(100% - 52px\); \}/, "窄屏给外侧时间留位");
  assert.match(css, /#chat \.msg-col\.voice-col > \.ch-read-state \{ margin-top: 3px; \}/, "语音未读自己补回 3px");
  assert.match(css, /#chat \.ch-read-state \{ margin-top: -5px; \}/, "普通列仍抵掉列间距");
  // 不许顺手回退：返回键仍是 32px、选人仍是手型
  assert.match(css, /\.ch-back \{[\s\S]{0,160}width: 32px; height: 32px;/, "返回键保持 32px");
  assert.match(css, /\.ch-friend, \.ch-friend \* \{ cursor: pointer; \}/, "选人保持手型");
});

test("turn.send 回 queued：先打三个点，按 turnId 看状态，完了才拉线程；失败要留住话", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "在吗");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1", notice: "递过去了" });
  await sending;
  await tick(3);

  assert.ok(findByClass(h.el("msgs"), "typing ch-typing"), "先摆打字");
  assert.equal(h.el("state").textContent, "递过去了", "notice 照实说");

  await tick(1300);
  assert.equal(h.net.turnCalls().length, 1);
  assert.match(h.net.turnCalls()[0].path, /turn\.get\?agentId=A&turnId=t1/);
  h.net.turnOk({ status: "done", replyMessageId: "m9" });
  await tick(5);
  assert.equal(findByClass(h.el("msgs"), "typing ch-typing"), null, "完成后打字收起");

  h.type("input", "再来一句");
  const again = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t2" });
  await again;
  await tick(1300);
  h.net.turnOk({ status: "failed", message: "这句没接上" });
  await tick(5);
  assert.equal(h.el("state").textContent, "这句没接上");
  assert.equal(findByClass(h.el("msgs"), "typing ch-typing"), null, "失败也不许永远打字");
  await h.client.closeChat();
});

test("切伙伴：打字和 turn 轮询当场停，旧伙伴的 turn 不再发", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "在吗");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(3);
  assert.ok(findByClass(h.el("msgs"), "typing ch-typing"));

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  assert.equal(findByClass(h.el("msgs"), "typing ch-typing"), null, "换人立刻收起打字");
  const before = h.net.turnCalls().length;
  await tick(1400);
  assert.equal(h.net.turnCalls().length, before, "旧伙伴的 turn 轮询不再发");
  await h.client.closeChat();
});

test("草稿按伙伴留在会话内存：切来切去各自还在，登出全清", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread(), B: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.type("input", "A 的草稿");
  openMenuAt(h, 1);
  menuButton(h, "引用").click();
  assert.equal(h.el("quoteBar").hidden, false);

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  assert.equal(h.el("input").value, "", "B 那边不该看到 A 的草稿");
  assert.equal(h.el("quoteBar").hidden, true, "引用也不串");
  h.type("input", "B 的草稿");

  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  assert.equal(h.el("input").value, "A 的草稿", "回 A 草稿还在");
  assert.equal(h.el("quoteBar").hidden, false, "引用也还在");

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  assert.equal(h.el("input").value, "B 的草稿");
  assert.equal(h.client.state.drafts.size, 2, "两位各一份，都在内存里");
  assert.equal(globalThis.localStorage.getItem("ch_mobile_drafts"), null, "明文草稿不进 localStorage");

  h.client.lockOut("退了");
  assert.equal(h.client.state.drafts.size, 0, "登出把草稿全清");
});

test("没发出去的那条：切走再回来重试入口还在，票还是同一张", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "这句会失败");
  const sending = h.client.send();
  await tick(2);
  const firstId = h.net.calls.filter((row) => row.path.includes("turn.send")).at(-1).body.clientMessageId;
  h.net.fail(new Error("宿主炸了"));
  await sending;
  await tick(3);
  assert.ok(findByClass(h.el("msgs"), "ch-fail"));

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  const fail = findByClass(h.el("msgs"), "ch-fail");
  assert.ok(fail, "重进这间房，重试入口摆回来");
  assert.equal(h.el("input").value, "这句会失败", "正文也回来了");

  fail.children[1].click();
  await tick(3);
  const resend = h.net.calls.filter((row) => row.path.includes("turn.send")).at(-1);
  assert.equal(resend.body.clientMessageId, firstId, "同一张票，宿主据此去重");
  await h.client.closeChat();
});

test("表情：图库空也给 Emoji 页；搜索能筛；选图进预览不直接发；粘贴也能选图", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.setStickers([]);
  h.el("stickerBtn").click();
  await tick(3);
  assert.ok(String(h.el("trayTabs").children[0]?.textContent ?? "").startsWith("Emoji"), "空图库也留 Emoji 页");
  assert.ok(h.el("trayGrid").children.length > 10, "Emoji 格子照出");

  h.net.setStickers([
    { id: "s1", groupIds: [], emotion: ["茶"], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: ["睡"], description: "打哈欠" },
  ]);
  h.el("trayClose").click();
  h.el("stickerBtn").click();
  await tick(3);
  assert.equal(h.el("trayGrid").children.length, 2);
  h.el("traySearch").value = "茶";
  h.fire("traySearch", "input");
  assert.equal(h.el("trayGrid").children.length, 1, "只剩搜到的那张");

  const sendsBefore = h.net.calls.filter((row) => row.path.includes("turn.send")).length;
  h.el("trayGrid").children[0].click();
  await tick(2);
  assert.equal(h.client.state.draftSticker.id, "s1");
  assert.equal(h.el("stickerDraft").hidden, false, "先进待发预览");
  assert.equal(h.net.calls.filter((row) => row.path.includes("turn.send")).length, sendsBefore, "还没点发送就不发");

  h.type("input", "配一句");
  const sending = h.client.send();
  await tick(2);
  const body = h.net.calls.filter((row) => row.path.includes("turn.send")).at(-1).body;
  assert.equal(body.stickerId, "s1", "表情跟着这一发走");
  assert.equal(body.text, "配一句", "正文也一起");
  h.net.ok();
  await sending;
  await tick(3);

  for (const fn of h.dom.docListeners.paste ?? []) {
    fn({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ name: "p.png", type: "image/png", size: 1024 }) }] },
      preventDefault() {},
    });
  }
  await tick(10);
  assert.equal(h.el("draft").hidden, false, "粘进来的图进了待发预览");
  await h.client.closeChat();
});

test("工具模块接线：context/reset/提案刷新/菜单动作容器/顶栏只剩收藏/双击戳一下", async (t) => {
  const calls = [];
  const factory = (options) => ({
    appendMessageActions(container, message) {
      calls.push({ kind: "appendMessageActions", messageId: message?.id, container: container?.className });
    },
    openFavorites() { calls.push({ kind: "openFavorites" }); },
    // 旧版工具有 openLibrary：手机这一页不该再调它
    openLibrary() { calls.push({ kind: "openLibrary" }); },
    refreshProposals() { calls.push({ kind: "refreshProposals", context: options.getContext() }); },
    poke() { calls.push({ kind: "poke" }); },
    reset() { calls.push({ kind: "reset" }); },
  });
  const h = await withClient(t, { threadFor: { A: { ...menuThread(), messageRefine: true } }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);

  const proposals = calls.filter((row) => row.kind === "refreshProposals");
  assert.ok(proposals.length >= 1, "开聊天后问一次提案");
  const ctx = proposals[0].context;
  assert.equal(ctx.agentId, "A");
  assert.equal(ctx.messageRefine, true, "修整开关原样交给工具");
  assert.equal(typeof ctx.epoch, "number");
  assert.equal(ctx.latestAssistantId, "m3", "最后一条伙伴回复的 id");
  assert.ok(Array.isArray(ctx.messages));

  openMenuAt(h, 1);
  const appended = calls.find((row) => row.kind === "appendMessageActions");
  assert.equal(appended.messageId, "m2");
  assert.equal(appended.container, "message-feed-actions", "管理动作追加在动作行里");

  h.el("toolFavorites").click();
  h.fireOn(h.el("who"), "dblclick", {});
  assert.ok(calls.some((row) => row.kind === "openFavorites"));
  assert.equal(calls.some((row) => row.kind === "openLibrary"), false, "手机不再调图库管理（只读 tray 留给聊天）");
  assert.ok(calls.some((row) => row.kind === "poke"));
  // 顶栏只有收藏那一枚：没有网格/图库入口（假 DOM 不解析 HTML，这里直接读真页面）
  const page = mobileHtmlText();
  assert.equal(page.includes("toolLibrary"), false, "HTML 里不再有图库按钮");
  assert.equal((page.match(/class="ch-top-btn"/g) ?? []).length, 1, "顶栏只剩收藏按钮");
  assert.match(page, /id="toolFavorites"/);

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  assert.ok(calls.some((row) => row.kind === "reset"), "换人要 reset");
  const epochs = calls.filter((row) => row.kind === "refreshProposals").map((row) => row.context.epoch);
  assert.ok(new Set(epochs).size >= 2, "epoch 跟着换人变");
  await h.client.closeChat();
});


// ── 2026-10-31 收尾契约：还没认识 / turn.get 的 items 与 message / canRecall 透传 ──

test("还没认识：写入口全关、状态行常驻提示，thread.get 说认识了才放开", async (t) => {
  const calls = [];
  const factory = (options) => ({
    appendMessageActions() {},
    openFavorites() {},
    openLibrary() {},
    refreshProposals() { calls.push({ kind: "refreshProposals", context: options.getContext() }); },
    poke() { calls.push({ kind: "poke" }); },
    reset() { calls.push({ kind: "reset" }); },
  });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1 })], total: 1, hasMore: false } }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚", needsOnboarding: true });
  await tick(5);

  assert.equal(h.el("state").textContent, "先在茶话会本体完成认识", "状态行常驻这句");
  assert.equal(h.el("send").disabled, true);
  assert.equal(h.el("imgBtn").disabled, true);
  assert.equal(h.el("stickerBtn").disabled, true);
  assert.equal(calls.find((row) => row.kind === "refreshProposals").context.needsOnboarding, true, "context 也得说未认识");

  // 直接调也一律挡住
  h.type("input", "想说话");
  await h.client.send();
  await tick(2);
  assert.equal(h.net.calls.filter((row) => row.path.includes("turn.send")).length, 0, "不许发出去");
  h.el("stickerBtn").click();
  await tick(2);
  assert.equal(h.el("tray").hidden, true, "不许翻图库");
  for (const fn of h.dom.docListeners.paste ?? []) {
    fn({ clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ name: "p.png", type: "image/png", size: 1024 }) }] }, preventDefault() {} });
  }
  await tick(5);
  assert.equal(h.el("draft").hidden, true, "不许选图");
  h.fireOn(h.el("who"), "dblclick", {});
  assert.equal(calls.some((row) => row.kind === "poke"), false, "不许戳");

  // 本体说认识了：门禁放开
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1 })], total: 1, hasMore: false, needsOnboarding: false });
  await h.client.pull();
  await tick(3);
  assert.notEqual(h.el("state").textContent, "先在茶话会本体完成认识");
  assert.equal(h.el("imgBtn").disabled, false);
  assert.equal(h.el("stickerBtn").disabled, false);
  h.fireOn(h.el("who"), "dblclick", {});
  assert.ok(calls.some((row) => row.kind === "poke"), "认识之后放开了");
  await h.client.closeChat();
});

test("turn.get：真消息+items 在自己的气泡里逐段长出来；语音整条呈现，不倒带重播", async (t) => {
  const replyText = "我先去倒杯水。回来接着说。";
  const reply = msg({ id: "m9", seq: 9, role: "assistant", text: replyText });
  const voiceReply = msg({ id: "v9", seq: 9, role: "assistant", text: "", voice: { status: "ready", durationMs: 2000, text: "我在呢" } });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" })], total: 1, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  // ① 真消息是文字：message 与 items 一致 → 按 items 分段长出来
  h.type("input", "你那边怎样");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply], total: 2, hasMore: false });
  h.net.turnOk({
    status: "ready",
    replyMessageId: "m9",
    message: reply,
    items: [{ text: "我先去倒杯水。", gapMs: 0 }, { text: "回来接着说。", gapMs: 200 }],
  });
  await tick(8);
  const bubble = findByClass(h.el("msgs"), "row ta") && allByClass(h.el("msgs"), "bubble").at(-1);
  assert.equal(bubbleTextOf(bubble), "我先去倒杯水。", "先只长出第一段");
  await tick(260);
  assert.equal(bubbleTextOf(bubble), replyText, "后面那段按间隔接上");
  assert.equal(findByClass(h.el("msgs"), "ch-typing"), null, "真消息到了就不再打字");
  assert.equal(findByClass(h.el("msgs"), "ch-live-items"), null, "没有单独的 items 预览 DOM");

  // ② 语音：整条呈现，绝不先演成一段文字
  h.type("input", "再说一句");
  const second = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t2" });
  await second;
  await tick(1300);
  h.net.threads.set("A", {
    messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply, voiceReply],
    total: 3,
    hasMore: false,
  });
  h.net.turnOk({
    status: "ready",
    replyMessageId: "v9",
    message: voiceReply,
    items: [{ text: "我在", gapMs: 0 }, { text: "呢", gapMs: 200 }],
  });
  await tick(8);
  assert.ok(findByClass(h.el("msgs"), "voice-bubble"), "语音按语音画");
  const strayText = allByClass(h.el("msgs"), "bubble")
    .filter((node) => !String(node.className ?? "").includes("voice-transcript"))
    .filter((node) => String(node.textContent ?? "").includes("我在"));
  assert.equal(strayText.length, 0, "没有把语音先演成文字泡");
  await h.client.closeChat();
});

test("turn.get：同 id 内容变了要核实；一字未变才不重拉；过期就正常收手", async (t) => {
  const reply = msg({ id: "m9", seq: 9, role: "assistant", text: "我在" });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply], total: 2, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.type("input", "再问一句");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);

  // 一字未变：不重拉、不画成两条
  const before = h.net.calls.filter((row) => row.path.includes("thread.get")).length;
  h.net.turnOk({ status: "ready", replyMessageId: "m9", message: reply });
  await tick(8);
  assert.equal(h.net.calls.filter((row) => row.path.includes("thread.get")).length, before, "同 id 同内容不重拉");
  assert.equal(allByClass(h.el("msgs"), "row ta").length, 1);

  // 同 id 但内容变了（改稿）：不能因为“见过这个 id”就跳过
  h.type("input", "第三句");
  const third = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t2" });
  await third;
  await tick(1300);
  const edited = { ...reply, text: "我改了口气" };
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), edited], total: 2, hasMore: false });
  const beforeEdit = h.net.calls.filter((row) => row.path.includes("thread.get")).length;
  h.net.turnOk({ status: "ready", replyMessageId: "m9", message: edited });
  await tick(8);
  assert.ok(h.net.calls.filter((row) => row.path.includes("thread.get")).length > beforeEdit, "内容变了一定要拉一次核实");
  assert.equal(allByClass(h.el("msgs"), "row ta").length, 1, "还是一条（原地改稿）");

  // 第四轮：服务端说这一轮已经没了 → 正常停下，不再报错也不再轮
  h.type("input", "第四句");
  const fourth = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t3" });
  await fourth;
  await tick(1300);
  h.net.turnOk({ status: "expired" });
  await tick(8);
  assert.equal(h.el("state").textContent, "这一轮已经结束了");
  assert.equal(findByClass(h.el("msgs"), "typing ch-typing"), null, "不许永久打字");
  const settled = h.net.turnCalls().length;
  await tick(1400);
  assert.equal(h.net.turnCalls().length, settled, "结束后不再轮");
  await h.client.closeChat();
});

test("turn.get：失败用服务端那句可读的 error，不摊对象", async (t) => {
  const h = await withClient(t);
  await h.client.openChat({ id: "A", name: "阿岚" });
  h.type("input", "在吗");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);
  h.net.turnOk({ status: "failed", error: "这一轮没接上" });
  await tick(8);
  assert.equal(h.el("state").textContent, "这一轮没接上");
  assert.equal(findByClass(h.el("msgs"), "typing ch-typing"), null);
  await h.client.closeChat();
});

test("canRecall 原样透传给工具：手机不自己改判", async (t) => {
  let seen = null;
  const factory = (options) => ({
    appendMessageActions() {},
    openFavorites() {},
    openLibrary() {},
    refreshProposals() { seen = options.getContext(); },
    poke() {},
    reset() {},
  });
  const thread = {
    messages: [
      msg({ id: "u1", seq: 1, role: "user", text: "很早以前的" , canRecall: false }),
      msg({ id: "u2", seq: 2, role: "user", text: "刚发的", canRecall: true }),
    ],
    total: 2,
    hasMore: false,
  };
  const h = await withClient(t, { threadFor: { A: thread }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  assert.ok(seen, "工具拿到上下文了");
  assert.deepEqual(seen.messages.map((row) => row.canRecall), [false, true], "服务端怎么判就怎么给，手机不压成只准最新");
  await h.client.closeChat();
});


// ── 2026-10-31 二轮收尾：上翻不拆语音 / 单读章 / 戳一戳菜单 / 第二小泡 / syncThread ──

test("上翻补页只往头上插：正在放的语音节点不动、滚动位置补回去", async (t) => {
  const older = [
    msg({ id: "o1", seq: 1, role: "user", text: "更早一句", at: "2026-10-30T08:00:00.000Z" }),
    msg({ id: "o2", seq: 2, role: "assistant", text: "更早的回应", at: "2026-10-30T08:01:00.000Z" }),
  ];
  const page = [
    msg({ id: "m1", seq: 5, role: "assistant", text: "", voice: { status: "ready", durationMs: 3000, text: "嗯，在呢" }, at: "2026-10-30T10:00:00.000Z" }),
    msg({ id: "m2", seq: 6, role: "user", text: "听着呢", at: "2026-10-30T10:01:00.000Z" }),
  ];
  const h = await withClient(t, { threadFor: { A: { messages: page, total: 4, hasMore: true } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const msgs = h.el("msgs");
  const voiceBubble = findByClass(msgs, "voice-bubble");
  findVoicePlay(msgs).click();
  await tick(5);
  assert.equal(h.audios[0].paused, false, "先在放");

  msgs.scrollHeight = 800;
  msgs.scrollTop = 100;
  // 上翻拿回的新页 = 老页 + 前面两条
  h.net.threads.set("A", { messages: [...older, ...page], total: 4, hasMore: false });
  msgs.scrollHeight = 900;
  await h.client.loadOlder();
  await tick(5);
  assert.equal(h.net.calls.filter((row) => row.path.includes("before=")).length, 1, "真的走了一发上翻");
  assert.equal(findByClass(msgs, "voice-bubble"), voiceBubble, "旧的语音气泡没被重建");
  assert.equal(h.audios[0].paused, false, "正在放的语音不许被掉");
  assert.equal(h.client.state.audioUrls.size, 1, "URL 账也没被清");
  assert.equal(msgs.children.length, 5, "两条老消息 + 一条交界刻度插在最前面");
  assert.equal(String(msgs.children[2]?.className ?? ""), "time-divider", "新老交界处补了一条刻度");
  // 假 DOM 的 scrollHeight 是写死的，量不出「长高了多少」；滚动补偿本身由
  // anchorAfterPrepend 的单测盯住，这里只保证没把人抽走（prevTop 留着）。
  assert.equal(msgs.scrollTop, 100, "上翻完仍停在原来那条上");
  await h.client.closeChat();
});

test("已读章全局只一枚：永远跟着最后一条自己的话，换一条就摸掉旧的", async (t) => {
  const u1 = msg({ id: "u1", seq: 1, role: "user", text: "第一句", readAt: "2026-10-30T10:00:10.000Z" });
  const a1 = msg({ id: "a1", seq: 2, role: "assistant", text: "回应" });
  const u2 = msg({ id: "u2", seq: 3, role: "user", text: "第二句" });
  const h = await withClient(t, { threadFor: { A: { messages: [u1, a1, u2], total: 3, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  assert.equal(allByClass(h.el("msgs"), "ch-read-state").length, 1, "只有一枚读章");
  assert.equal(findByClass(h.el("msgs"), "ch-read-state").textContent, "未读");
  const lastRow = allByClass(h.el("msgs"), "row me").at(-1);
  assert.ok(findByClass(lastRow, "ch-read-state"), "挂在最后一条自己的话下面");

  // 又来一条自己的话：旧那枚要摸掉，只剩新的这枚
  h.net.threads.set("A", {
    messages: [u1, a1, { ...u2, readAt: "2026-10-30T10:05:00.000Z" }, msg({ id: "u3", seq: 4, role: "user", text: "第三句" })],
    total: 4,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  const states = allByClass(h.el("msgs"), "ch-read-state");
  assert.equal(states.length, 1, "不会越积越多");
  assert.equal(states[0].textContent, "未读");
  assert.ok(findByClass(allByClass(h.el("msgs"), "row me").at(-1), "ch-read-state"));

  // 语音那条自己发的也算「自己的话」
  h.net.threads.set("A", {
    messages: [
      u1,
      a1,
      { ...u2, readAt: "2026-10-30T10:05:00.000Z" },
      msg({ id: "uv", seq: 5, role: "user", text: "", voice: { status: "ready", durationMs: 2000, text: "我录的" } }),
    ],
    total: 4,
    hasMore: false,
  });
  await h.client.pull();
  await tick(3);
  const afterVoice = allByClass(h.el("msgs"), "ch-read-state");
  assert.equal(afterVoice.length, 1);
  assert.ok(findByClass(findByClass(h.el("msgs"), "row voice-row me"), "ch-read-state"), "语音那侧也挂上");
  await h.client.closeChat();
});

test("戳一戳：也给长按/右键菜单，但只给管理动作，不冒充聊天消息", async (t) => {
  const poke = { id: "p1", seq: 2, kind: "poke", role: "assistant", text: "戳了你一下" };
  const factory = () => ({
    appendMessageActions(container, message) {
      if (message?.kind !== "poke") return;
      const button = { type: "button", className: "message-menu-action", textContent: "删除", attrs: {}, handlers: {}, addEventListener() {}, focus() {} };
      container.append(button);
    },
    openFavorites() {}, openLibrary() {}, refreshProposals() {}, poke() {}, reset() {},
  });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), poke], total: 2, hasMore: false } }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  const row = allByClass(h.el("msgs"), "poke-row")[0];
  assert.ok(row, "戳一戳那一行画出来了");
  h.fireOn(row, "contextmenu", { button: 2, preventDefault() {}, stopPropagation() {} });
  const menu = menuOf(h);
  assert.equal(menu.hidden, false, "开得出来");
  assert.equal(emojiRowOf(h), undefined, "不给投喂");
  assert.deepEqual(menuLabels(h), ["删除"], "只给删除，没有复制/引用/收藏");
  await h.client.closeChat();
});

test("第二小泡：长按/右键哪一句，复制与引用的就是哪一句", async (t) => {
  const captured = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => captured.push(text) } },
  });
  try {
    const h = await openMenuThread(t, {
      messages: [msg({ id: "m1", seq: 1, role: "assistant", text: "在呢", bubbles: ["第一句", "第二句"] })],
      total: 1,
      hasMore: false,
    });
    const row = h.el("msgs").children[0];
    const second = allByClass(row, "bubble")[1];
    assert.equal(bubbleTextOf(second), "第二句");

    h.fireOn(row, "contextmenu", { button: 2, target: second, preventDefault() {}, stopPropagation() {} });
    menuButton(h, "引用").click();
    assert.equal(h.el("quoteText").textContent, "第二句", "引用的是点中那一句，不是整条");

    h.fireOn(row, "contextmenu", { button: 2, target: second, preventDefault() {}, stopPropagation() {} });
    menuButton(h, "复制").click();
    await tick(3);
    assert.deepEqual(captured, ["第二句"], "复制的也是那一句");

    // 没点中具体一句（点在行/空处）：回落整条正文
    h.fireOn(row, "contextmenu", { button: 2, target: row, preventDefault() {}, stopPropagation() {} });
    menuButton(h, "引用").click();
    assert.equal(h.el("quoteText").textContent, "在呢", "整条正文兜底");
    await h.client.closeChat();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});

test("syncThread：只在 core 真变时 contentChanged，playAt/readAt 不算；工具构造拿到 stopPlayback", async (t) => {
  const seen = [];
  const factory = (options) => ({
    appendMessageActions() {}, openFavorites() {}, openLibrary() {}, refreshProposals() {}, poke() {}, reset() {},
    syncThread(payload) { seen.push(payload); },
    hasStop: typeof options.stopPlayback === "function",
  });
  const base = [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), msg({ id: "m2", seq: 2, role: "assistant", text: "在呢" })];
  const h = await withClient(t, { threadFor: { A: { messages: base, total: 2, hasMore: false } }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].contentChanged, true, "首屏算真变");
  assert.equal(seen[0].revalidate, true, "每次合并都带 revalidate:true（收藏面板自己去核实旧条目）");

  // 只变已读：不算内容变了
  h.net.threads.set("A", { messages: [{ ...base[0], readAt: "2026-10-30T10:00:10.000Z" }, base[1]], total: 2, hasMore: false });
  await h.client.pull();
  await tick(3);
  assert.equal(seen.at(-1).contentChanged, false, "已读不算");
  assert.equal(seen.at(-1).revalidate, true, "只变已读也照样带 revalidate");

  // 改一句正文：算
  h.net.threads.set("A", { messages: [{ ...base[0], readAt: "2026-10-30T10:00:10.000Z" }, { ...base[1], text: "在呢，刚醒" }], total: 2, hasMore: false });
  await h.client.pull();
  await tick(3);
  assert.equal(seen.at(-1).contentChanged, true, "正文变了算");
  await h.client.closeChat();
});

test("静态 import 工具模块：不再用动态 import 吞故障；引用上限跟后端 4000", () => {
  const source = readFileSync(new URL("../ui/assets/mobile-client.js", import.meta.url), "utf8");
  assert.match(source, /import \{ createMobileTools \} from "\.\/mobile-tools\.js";/, "静态 import");
  assert.doesNotMatch(source, /await import\(/, "不许再用动态 import 吞故障");
  assert.doesNotMatch(source, /createMobileTools = null/, "不保留“还没落盘”的生产 fallback");
  assert.equal(MOBILE_QUOTE_MAX, 4000, "跟后端 normalizeQuote 同一个上限");
  assert.doesNotMatch(source, /slice\(0, 120\)/, "引用不许在 UI 里硬截 120");
});


test("多气泡回复：渐进只演最后一泡自己的原文，不把整条塞进去", async (t) => {
  const reply = msg({
    id: "m9",
    seq: 9,
    role: "assistant",
    text: "第一句\n第二句长正文",
    bubbles: ["第一句", "第二句长正文"],
  });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" })], total: 1, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.type("input", "你说两句");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply], total: 2, hasMore: false });
  // items 是整条的分段，与「最后那一片」对不上：只能按那片自己的文字分段
  h.net.turnOk({
    status: "ready",
    replyMessageId: "m9",
    message: reply,
    items: [{ text: "第一句", gapMs: 0 }, { text: "第二句", gapMs: 0 }, { text: "长正文", gapMs: 120 }],
  });
  await tick(8);

  const row = findByClass(h.el("msgs"), "row ta");
  const bubbles = allByClass(row, "bubble");
  assert.equal(bubbles.length, 2, "两泡还是两泡");
  assert.equal(bubbleTextOf(bubbles[0]), "第一句", "前面那泡原样不动");
  const partial = bubbleTextOf(bubbles[1]);
  assert.ok("第二句长正文".startsWith(partial), `最后一泡只长它自己那片，实际「${partial}」`);

  await tick(300);
  assert.equal(bubbleTextOf(bubbles[1]), "第二句长正文", "动画结束只含第二句那片");
  assert.equal(String(row.textContent).split("第一句").length - 1, 1, "整条没有重复第一句");
  assert.equal(String(row.textContent).split("第二句长正文").length - 1, 1, "整条没有重复第二句");

  // 复制/引用最后一泡还是那一片
  h.fireOn(row, "contextmenu", { button: 2, target: bubbles[1], preventDefault() {}, stopPropagation() {} });
  menuButton(h, "引用").click();
  assert.equal(h.el("quoteText").textContent, "第二句长正文");
  await h.client.closeChat();
});

test("逐段显现中途取消：把那一片补全，不留半截文案", async (t) => {
  const reply = msg({ id: "m9", seq: 9, role: "assistant", text: "第一段。第二段。" });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" })], total: 1, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.type("input", "说两句");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply], total: 2, hasMore: false });
  h.net.turnOk({
    status: "ready",
    replyMessageId: "m9",
    message: reply,
    items: [{ text: "第一段。", gapMs: 0 }, { text: "第二段。", gapMs: 900 }],
  });
  await tick(10);

  const bubble = allByClass(findByClass(h.el("msgs"), "row ta"), "bubble").at(-1);
  assert.equal(bubbleTextOf(bubble), "第一段。", "先只长了一段");

  // 她这时就发下一条：动画取消，但屏上那一条必须补全
  h.type("input", "等等");
  const second = h.client.send();
  await tick(5);
  assert.equal(bubbleTextOf(bubble), "第一段。第二段。", "取消后补全，不留半截");
  h.net.ok();
  await second;
  await tick(5);
  assert.equal(bubbleTextOf(bubble), "第一段。第二段。", "后面的回包也不把它拉回去");
  await h.client.closeChat();
});

test("逐段显现中途改稿：不把旧原文塞回来", async (t) => {
  const reply = msg({ id: "m9", seq: 9, role: "assistant", text: "旧的第一段。旧的第二段。" });
  const h = await withClient(t, { threadFor: { A: { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" })], total: 1, hasMore: false } } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.type("input", "说两句");
  const sending = h.client.send();
  await tick(2);
  h.net.ok({ queued: true, turnId: "t1" });
  await sending;
  await tick(1300);
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), reply], total: 2, hasMore: false });
  h.net.turnOk({
    status: "ready",
    replyMessageId: "m9",
    message: reply,
    items: [{ text: "旧的第一段。", gapMs: 0 }, { text: "旧的第二段。", gapMs: 900 }],
  });
  await tick(10);
  assert.equal(bubbleTextOf(allByClass(findByClass(h.el("msgs"), "row ta"), "bubble").at(-1)), "旧的第一段。");

  // 服务端把这条改稿了：整段重画，旧定时器不许把旧文案写回去
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1, role: "user", text: "在吗" }), { ...reply, text: "改过的正文" }], total: 2, hasMore: false });
  await h.client.pull();
  await tick(10);
  await tick(1000);
  const row = findByClass(h.el("msgs"), "row ta");
  assert.equal(bubbleTextOf(findByClass(row, "bubble")), "改过的正文");
  assert.ok(!String(row.textContent).includes("旧的第一段"), "旧稿不回来");
  await h.client.closeChat();
});


// ── 2026-11-01：手机只闲聊，图库只读且跟着 pull 同步 ──

test("图库只读：开着的面板跟着 pull 同步，搜索/分类/滚动留着，分类没了回全部", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.setStickers([
    { id: "s1", groupIds: ["g1"], emotion: ["茶"], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: ["睡"], description: "打哈欠" },
  ], [{ id: "g1", name: "茶" }]);
  h.el("stickerBtn").click();
  await tick(3);
  assert.equal(h.el("trayGrid").children.length, 2);

  // 同一清单的静默刷新不重画页签；旧 DOM 的监听仍须操作当前 cache。
  const unchangedTab = h.el("trayTabs").children[2];
  await h.client.pull();
  await tick(5);
  assert.equal(h.el("trayTabs").children[2], unchangedTab, "清单未变不重建分类 DOM");

  // 选到「茶」分类，再搜「一」
  h.el("trayTabs").children[2].click();
  h.el("traySearch").value = "一";
  h.fire("traySearch", "input");
  assert.equal(h.client.state.stickerCache.filter, "g1", "静默刷新后旧页签也能切换当前分类");
  assert.equal(h.el("trayGrid").children.length, 1, "分类+搜索只剩一张");
  h.el("trayGrid").scrollTop = 40;

  // 本体新增一张（同分类）→ 这轮 pull 顺带同步
  h.net.setStickers([
    { id: "s1", groupIds: ["g1"], emotion: ["茶"], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: ["睡"], description: "打哈欠" },
    { id: "s3", groupIds: ["g1"], emotion: ["茶"], description: "再来一杯" },
  ], [{ id: "g1", name: "茶" }]);
  await h.client.pull();
  await tick(5);

  assert.equal(h.client.state.stickerCache.filter, "g1", "分类还在就留着");
  assert.equal(h.el("traySearch").value, "一", "搜索词不动");
  assert.equal(h.el("trayGrid").children.length, 2, "按当前分类+搜索重画");
  assert.equal(h.el("trayGrid").scrollTop, 40, "滚动位置保住");
  assert.equal(h.el("tray").hidden, false, "面板还开着");

  // 本体把分类删了 → 回全部
  h.net.setStickers([
    { id: "s1", groupIds: [], emotion: ["茶"], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: ["睡"], description: "打哈欠" },
    { id: "s3", groupIds: [], emotion: ["茶"], description: "再来一杯" },
  ], []);
  await h.client.pull();
  await tick(5);
  assert.equal(h.client.state.stickerCache.filter, "", "分类被删就回全部");
  assert.equal(h.el("trayGrid").children.length, 2, "搜索还在（三张里只剩两张带「一」的）");
  await h.client.closeChat();
});

test("待发表情被本体删了：只清那一张，正文/图片/引用都不动", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.setStickers([{ id: "s1", groupIds: [], emotion: ["茶"], description: "一杯茶" }], []);
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayGrid").children[0].click();
  await tick(2);
  assert.equal(h.client.state.draftSticker.id, "s1");

  h.type("input", "配一句");
  openMenuAt(h, 1);
  menuButton(h, "引用").click();
  assert.equal(h.el("quoteBar").hidden, false);

  // 本体把这张删了：只剩另一张
  h.net.setStickers([{ id: "s9", groupIds: [], emotion: [], description: "别的" }], []);
  await h.client.pull();
  await tick(5);

  assert.equal(h.client.state.draftSticker, null, "那一张清掉");
  assert.equal(h.el("stickerDraft").hidden, true);
  assert.equal(h.el("input").value, "配一句", "正文留着");
  assert.equal(h.el("quoteBar").hidden, false, "引用留着");
  assert.match(String(h.el("state").textContent), /不在图库/);
  await h.client.closeChat();
});

test("关掉面板之后才回来的清单：不许重开、也不改旧清单", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.stickerMode("manual");
  h.el("stickerBtn").click();
  await tick(3);
  assert.equal(h.net.stickerCalls().length, 1, "打开时立即取一次");

  h.el("trayClose").click();
  await tick(2);
  h.net.setStickers([{ id: "z1", groupIds: [], emotion: [], description: "迟到的" }], []);
  h.net.stickerOk();
  await tick(8);

  assert.equal(h.el("tray").hidden, true, "不许自己重开");
  assert.equal(h.client.state.stickerCache.stickers.length, 0, "旧清单也不许被这发写进来");
  await h.client.closeChat();
});

test("清单拉失败：旧图清掉、搜索也不复活；待发那张不当成已删", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.setStickers([
    { id: "s1", groupIds: [], emotion: ["茶"], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: ["睡"], description: "打哈欠" },
  ], []);
  h.el("stickerBtn").click();
  await tick(3);
  assert.equal(h.el("trayGrid").children.length, 2);
  h.el("trayGrid").children[0].click();
  await tick(2);
  assert.equal(h.client.state.draftSticker.id, "s1");
  h.type("input", "配一句");
  h.el("stickerBtn").click();
  await tick(3);

  // 这一轮拉清单失败（网络错）
  h.net.stickerMode("manual");
  await h.client.pull();
  await tick(3);
  h.net.stickerFail(500, "网络断了");
  await tick(6);

  assert.equal(h.client.state.stickerCache.stickers.length, 0, "旧清单必须清掉");
  // 搜索一下：不能把本体已删的图又画回来
  h.el("traySearch").value = "茶";
  h.fire("traySearch", "input");
  assert.equal(h.el("trayGrid").children.length, 0, "搜索也不会复活旧图");
  // Emoji 照旧能用
  h.el("trayTabs").children[0].click();
  assert.ok(h.el("trayGrid").children.length > 10, "Emoji 页还能用");
  // 待发那张不能被当成已删（网络错不是删图）
  assert.equal(h.client.state.draftSticker.id, "s1");
  assert.equal(h.el("stickerDraft").hidden, false);
  assert.equal(h.el("input").value, "配一句", "其它草稿都不动");
  await h.client.closeChat();
});

test("空分类：新建就摆出来、能点进去；改名/再 pull 仍选中，不被当成删了", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);

  h.net.setStickers([{ id: "s1", groupIds: [], emotion: [], description: "一杯茶" }], [{ id: "g9", name: "新的" }]);
  h.el("stickerBtn").click();
  await tick(3);
  const tabs = h.el("trayTabs").children.map((button) => button.textContent);
  assert.equal(tabs.length, 3, "Emoji / 表情包 / 空分类都在");
  assert.equal(tabs[2], "新的", "空分类也要摆出来");

  h.el("trayTabs").children[2].click();
  assert.equal(h.client.state.stickerCache.filter, "g9", "点得进去");
  assert.equal(h.el("trayGrid").children.length, 0, "空分类给空态");

  // 本体把分类改名（仍然空）：pull 之后还选着它，改名同步
  h.net.setStickers([{ id: "s1", groupIds: [], emotion: [], description: "一杯茶" }], [{ id: "g9", name: "改名了" }]);
  await h.client.pull();
  await tick(5);
  assert.equal(h.client.state.stickerCache.filter, "g9", "选中的分类不被乱动");
  assert.equal(h.el("trayTabs").children[2].textContent, "改名了", "改名也得同步");

  // 一张图都没了，但选中的分组还在：不踢回 Emoji
  h.net.setStickers([], [{ id: "g9", name: "改名了" }]);
  await h.client.pull();
  await tick(5);
  assert.equal(h.client.state.stickerCache.filter, "g9", "总图数是 0 也不踢走仍存在的空组");
  assert.equal(h.el("trayTabs").children.length, 3, "Emoji 那页仍在");
  await h.client.closeChat();
});

test("工具构造参数：不再传 onLibraryChanged（图库管理已取消）", async (t) => {
  let captured = null;
  const factory = (options) => {
    captured = options;
    return { appendMessageActions() {}, openFavorites() {}, refreshProposals() {}, poke() {}, reset() {}, syncThread() {} };
  };
  const h = await withClient(t, { threadFor: { A: menuThread() }, createTools: factory });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);
  assert.ok(captured);
  assert.equal("onLibraryChanged" in captured, false, "孤儿回调整块删掉");
  for (const key of ["doc", "api", "getContext", "refreshThread", "stopPlayback", "notify", "closeMessageMenu"]) {
    assert.ok(key in captured, `仍要有 ${key}`);
  }
  await h.client.closeChat();
});

test("贴图不可用：不把失效那张放回草稿、不留同一张票重试，正文/引用还在", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.net.setStickers([{ id: "s1", groupIds: [], emotion: [], description: "一杯茶" }], []);
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayGrid").children[0].click();
  await tick(2);
  h.type("input", "配一句");
  openMenuAt(h, 1);
  menuButton(h, "引用").click();

  const sending = h.client.send();
  await tick(2);
  h.net.fail(new Error("这张表情包当前不可用"));
  await sending;
  await tick(3);

  assert.equal(h.client.state.draftSticker, null, "失效那张清掉");
  assert.equal(h.el("input").value, "配一句", "正文还给她");
  assert.equal(h.el("quoteBar").hidden, false, "引用留着");
  assert.equal(findByClass(h.el("msgs"), "ch-fail"), null, "不留同一张票的重试入口");
  assert.match(String(h.el("state").textContent), /不可用/);

  // 也不留可以重发的票：重进这间房也不会把这张贴图摆回来
  await h.client.openChat({ id: "B", name: "小满" });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  assert.equal(h.client.state.draftSticker, null);
  assert.equal(h.el("stickerDraft").hidden, true);
  await h.client.closeChat();
});

test("贴图不可用（已切走）：不清原伙伴的票，回过 A 文字/引用还在", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread(), B: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.net.setStickers([{ id: "s1", groupIds: [], emotion: [], description: "一杯茶" }], []);
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayGrid").children[0].click();
  await tick(2);
  h.type("input", "A 的正文");
  openMenuAt(h, 1);
  menuButton(h, "引用").click();

  const sending = h.client.send();
  await tick(2);
  // 回包还没到就切到 B 并开始打 B 的草稿
  await h.client.openChat({ id: "B", name: "小满" });
  h.type("input", "B 的草稿");

  h.net.fail(new Error("这张表情包当前不可用"));
  await sending;
  await tick(3);

  // B 这侧一点不动
  assert.equal(h.client.state.agent.id, "B");
  assert.equal(h.el("input").value, "B 的草稿", "B 的草稿不许被 A 的回包碰");
  assert.equal(findByClass(h.el("msgs"), "ch-fail"), null, "不给 B 塞失败行");
  assert.equal(h.client.state.draftSticker, null, "B 手里没贴图就不该凭空多一张");

  // A 那张票还在：文字与引用都没丢（已切走时不许 clearRetry）
  const plan = h.client.retryPlan();
  assert.ok(plan, "A 的 retry 票仍存");
  assert.equal(plan.agentId, "A");
  assert.equal(plan.payload.text, "A 的正文");
  assert.equal(plan.payload.quote?.messageId, "m2", "引用也跟着票保留");

  // 回 A：正文与引用都能恢复
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  assert.equal(h.el("input").value, "A 的正文", "回 A 正文还在");
  assert.equal(h.el("quoteBar").hidden, false, "引用也还在");
  await h.client.closeChat();
});

test("贴图不可用：她等待期间另选了另一张，那张不许被清", async (t) => {
  const h = await withClient(t, { threadFor: { A: menuThread() } });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(3);
  h.net.setStickers([
    { id: "s1", groupIds: [], emotion: [], description: "一杯茶" },
    { id: "s2", groupIds: [], emotion: [], description: "另一张" },
  ], []);
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayGrid").children[0].click();
  await tick(2);

  const sending = h.client.send();
  await tick(2);
  // 等回包的时候她另选了一张
  h.el("stickerBtn").click();
  await tick(3);
  h.el("trayGrid").children[1].click();
  await tick(2);
  assert.equal(h.client.state.draftSticker.id, "s2");

  h.net.fail(new Error("这张表情包当前不可用"));
  await sending;
  await tick(3);
  assert.equal(h.client.state.draftSticker.id, "s2", "另选那张不动");
  assert.equal(h.el("stickerDraft").hidden, false);
  assert.equal(findByClass(h.el("msgs"), "ch-fail"), null);
  await h.client.closeChat();
});


// ── 2026-11-02：状态徽章 / 圆形返回 / 回到底部跟输入区走 ──

test("页骨契约：返回是紧凑 SVG 键、徽章在名字旁、回到底部在输入区里", () => {
  const html = mobileHtmlText();
  const css = mobileCssText();

  // 返回：不再是裸文本
  const back = (html.match(/<button class="ch-back"[\s\S]*?<\/button>/) ?? [])[0] ?? "";
  assert.match(back, /id="back"/);
  assert.match(back, /<svg viewBox="0 0 20 20"/, "左箭头是 SVG");
  assert.match(back, /aria-label="返回伙伴列表"/);
  assert.match(back, /title="返回伙伴列表"/);
  assert.match(css, /\.ch-back \{[^}]*width: 32px; height: 32px;/, "返回键收成 32px，不改回底键尺寸");
  assert.match(css, /\.ch-back svg \{[^}]*width: 16px; height: 16px;/, "箭头同步收小");
  assert.match(css, /\.ch-back:focus-visible \{/, "焦点态保留");

  // 徽章：跟名字同一组，且不是右侧那颗连接点
  assert.match(html, /<span class="ch-ident">\s*<span class="ch-who" id="who"[^>]*><\/span>\s*<span class="chat-state-badge" id="partnerBadge" hidden><\/span>/, "名字与徽章同组");
  assert.match(css, /\.ch-ident \{[^}]*flex: 1 1 auto;/, "身份组占余量，右侧工具靠右且徽章不被自身百分比挤窄");
  assert.match(css, /\.ch-who \{[^}]*flex: 0 1 auto;/, "名字不许 flex:1 把徽章顶到远端");
  assert.match(css, /#chat \.chat-state-badge \{[^}]*max-width: 40%/, "窄屏先缩徽章");
  assert.match(css, /#chat\.has-bg \.chat-state-badge \{[\s\S]{0,160}--badge-bg: var\(--status-bg/, "有背景时徽章跟主题色走");

  // 回到底部：本体那颗圆键，放在 composer 里
  const composer = (html.match(/<div class="composer ch-composer">([\s\S]*?)<\/div>\s*<input id="pickImage"/) ?? [])[1] ?? "";
  assert.match(composer, /id="jumpBottom"/, "在输入区里");
  assert.match(composer, /class="jump-bottom"/, "穿本体的 .jump-bottom");
  assert.match(composer, /path d="m5 7\.5 5 5 5-5"/, "本体同款下箭头");
  assert.match(composer, /aria-label="回到底部"/);
  assert.doesNotMatch(html, /class="ch-jump"/, "旧的长条按钮不留");
  assert.match(css, /#chat \.jump-bottom \{[\s\S]{0,120}bottom: calc\(100% \+ 10px\)/, "相对输入区定位");
  assert.doesNotMatch(css, /bottom: calc\(84px/, "不再写死屏高偏移");
  assert.doesNotMatch(html, /class="ch-jump"/);
});

test("选人卡片及文字头像统一使用小手光标", () => {
  assert.match(mobileCssText(), /\.ch-friend,\s*\.ch-friend \* \{\s*cursor: pointer;\s*\}/, "整张可点卡片及子节点均显示小手，不仅留白区域");
});

test("徽章：首绘/更新/缺失就藏/自定义文案安全，且不跟连接绿点混淆", async (t) => {
  const h = await withClient(t, {
    threadFor: { A: { ...menuThread(), badge: { id: "online", title: "在线" } } },
  });
  await h.client.openChat({ id: "A", name: "阿岚", badge: { id: "online", title: "在线" } });
  await tick(3);

  const badge = h.el("partnerBadge");
  assert.equal(badge.hidden, false, "名单带的状态先绘上");
  assert.equal(badge.textContent, "在线");
  assert.match(String(badge.className), /chat-state-badge/);
  assert.match(String(badge.className), /state-badge--online/);
  assert.equal(badge.attrs["aria-label"], "当前状态：在线");
  assert.equal(badge.title, "当前状态：在线");

  // 连接断了：绿点变红，徽章不动
  h.client.state.sse.onerror();
  await tick(2);
  assert.match(String(h.el("link").className), /off/, "绿点表示连线");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "在线", "徽章不能被连接状态覆写");

  // 轮询带回新状态
  h.net.threads.set("A", { ...menuThread(), badge: { id: "sleeping", title: "睡觉", description: "半夜" } });
  await h.client.pull();
  await tick(3);
  assert.equal(badge.textContent, "睡觉");
  assert.match(String(badge.className), /state-badge--sleeping/);
  assert.equal(badge.title, "半夜", "description 原样做 title");

  // 自定义：文案只当文字，不解析标签；未知类型兜到 custom
  h.net.threads.set("A", { ...menuThread(), badge: { type: "custom", title: "<b>不在</b>" } });
  await h.client.pull();
  await tick(3);
  assert.equal(badge.textContent, "<b>不在</b>", "原样字串");
  assert.equal(badge.children.some((node) => node.tag === "b"), false, "没被解析成标签");
  assert.match(String(badge.className), /state-badge--custom/);

  // 没状态就藏，而且旧字不残留
  h.net.threads.set("A", { ...menuThread(), badge: null });
  await h.client.pull();
  await tick(3);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, "");
  await h.client.closeChat();
  // onerror 会排一个 3s 重连定时器；这页测完就把客户端整个收掉，不给假环境留活定时器
  h.client.destroy();
});

test("徽章：换伙伴先清上一位的，别把 A 的状态带过去", async (t) => {
  const h = await withClient(t, {
    threadFor: {
      A: { ...menuThread(), badge: { id: "busy", title: "忙" } },
      B: { ...menuThread(), badge: null },
    },
  });
  await h.client.openChat({ id: "A", name: "阿岚", badge: { id: "busy", title: "忙" } });
  await tick(3);
  assert.equal(h.el("partnerBadge").textContent, "忙");

  await h.client.openChat({ id: "B", name: "小满" });
  await tick(3);
  const badge = h.el("partnerBadge");
  assert.equal(badge.hidden, true, "B 没状态就不显示");
  assert.equal(badge.textContent, "", "A 的“忙”不能留着");
  assert.match(String(badge.className), /state-badge--custom/, "未知/空走 custom 色调");
  await h.client.closeChat();
});

test("主题新变量：回到底部/返回那组跟着背景写上去，清背景就扫干净", async (t) => {
  const h = await withClient(t, {
    threadFor: {
      A: {
        messages: [msg({ id: "m1", seq: 1 })],
        total: 1,
        hasMore: false,
        background: { file: "room.png", type: "image/png", tone: "medium", opacity: 40, at: "2026-10-30T10:00:00.000Z" },
      },
    },
  });
  await h.client.openChat({ id: "A", name: "阿岚" });
  await tick(5);

  const chat = h.el("chat");
  const theme = buttonThemeFromSample({ red: 62, green: 120, blue: 96, brightness: 0.42 });
  assert.equal(chat.style.getPropertyValue("--jump-bg"), theme.background);
  assert.equal(chat.style.getPropertyValue("--jump-fg"), theme.foreground);
  assert.equal(chat.style.getPropertyValue("--jump-border"), theme.border);
  assert.equal(chat.style.getPropertyValue("--jump-hover-bg"), theme.noticeBackground);
  for (const name of ["--jump-bg", "--jump-fg", "--jump-border", "--jump-hover-bg"]) {
    assert.ok(BACKGROUND_THEME_VARS.includes(name), `${name} 要进清扫名单`);
  }

  // 她清掉背景：这组也要跟着没（跟其它主题变量同一套清扫）
  h.net.threads.set("A", { messages: [msg({ id: "m1", seq: 1 })], total: 1, hasMore: false, background: null });
  await h.client.pull();
  await tick(5);
  for (const name of ["--jump-bg", "--jump-fg", "--jump-border", "--jump-hover-bg"]) {
    assert.equal(chat.style.getPropertyValue(name), "", `${name} 该被扫掉`);
  }
  await h.client.closeChat();
});

