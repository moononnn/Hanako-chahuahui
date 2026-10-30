import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bootChahuahui } from "./helpers/app-harness.js";
import { getMobileAccess } from "../lib/mobile-access.js";
import { MOBILE_PAGE_CAP, pullLimit } from "../ui/assets/mobile-client.js";
import { ACTION_VOICE } from "../lib/actions.js";
import { makeProposal } from "../lib/todo-propose.js";
import { __clearCatalogCache } from "../lib/stickers.js";

/**
 * 这一组跑的是真 apply、真路由、真账本（临时目录）。
 *
 * 手机那条路本来只挂在网关的 op 分发上，这里借着 mobile-access 暴露的同一条
 * 分发口（dispatch）去叫它——走的是 index 里那份 handler，不是另写一套。
 * 网关进程本身用不着起：默认关着，谁也不会 spawn。
 */

const PARTNER = "nova";

/** 把真路由接到「网关会用的那个口子」上：Response 的三种读法都补齐。 */
function attachRouteRequester(host) {
  host.app.request = async (url, init = {}) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    let json;
    if (init?.body !== undefined && init?.body !== null && String(init.body) !== "") {
      try { json = JSON.parse(String(init.body)); } catch { json = undefined; }
    }
    // harness 把 app.patch 登记成 PUT（见 helpers/app-harness.js），这里跟着换一下方法名
    const dispatchMethod = method === "PATCH" ? "PUT" : method;
    const result = await host.dispatch(dispatchMethod, url, json === undefined ? {} : { json });
    const body = result?.body;
    const binary = body instanceof Uint8Array;
    const status = result?.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => (binary ? null : "application/json") },
      async json() { return binary ? null : body ?? null; },
      async arrayBuffer() {
        if (!binary) return new ArrayBuffer(0);
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  };
  return host;
}

async function boot(options = {}) {
  const { settled = true, seed, ...rest } = options;
  const booted = await bootChahuahui({
    ...rest,
    seed: (store, ctx) => {
      // 默认把这位伙伴标成「已经认识完」：手机写入口按本体同一把尺（isSettled）要过这道门。
      // 要验那道门本身的用例传 settled:false。
      if (settled) {
        const knowing = store.getKnowing(PARTNER);
        store.saveKnowing(PARTNER, {
          ...knowing,
          personality: { surface: { tags: ["温柔"], signals: [] }, inner: { tags: [], signals: [] } },
        });
      }
      if (typeof seed === "function") seed(store, ctx);
    },
  });
  attachRouteRequester(booted.host);
  const access = getMobileAccess(booted.dataDir);
  return { ...booted, access };
}

function readConfig(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "mobile-gateway.json"), "utf8"));
}

/** 1x1 的 PNG：够真（魔数对得上），又不占地方。 */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 等到 fn() 返回真值为止；超时就抛，免得挂死。 */
async function waitFor(fn, what = "状态", timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await fn();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等${what}超时`);
}

/** 桌面那份徽章带 updatedAt，手机投影不带：比只比可见的那几项。 */
function pickBadge(badge) {
  if (!badge) return null;
  if (badge.type === "custom") {
    return { type: "custom", id: "custom", title: badge.title, description: badge.description };
  }
  return { type: "common", id: badge.id, label: badge.label, description: badge.description };
}

/** 从 index.js 里把真实的 mobileSafeText 拿下来执行：不另写一份“差不多”的，免得测的不灵。 */
function loadMobileSafeText() {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("const mobileSafeText = (value) =>");
  assert.ok(start > 0, "index.js 里应该有 mobileSafeText");
  const tail = source.slice(start);
  const anchor = ".slice(0, 200);";
  const end = tail.indexOf(anchor);
  assert.ok(end > 0, "mobileSafeText 应该以 .slice(0, 200); 收尾");
  const expression = tail.slice(0, end + anchor.length);
  return new Function(`${expression}\nreturn mobileSafeText;`)();
}

/** 表情包数据源快照：只让 ctx.resources.read 认这两个路径，不碰真实图库。 */
function stickerSourceResources(pngBase64 = TINY_PNG, seen = []) {
  const index = {
    schemaVersion: 1,
    stickers: [{
      id: "src_1",
      file: "images/src_1.png",
      emotion: ["开心"],
      scene: [],
      keywords: [],
      description: "一张测试用的来源图",
    }],
  };
  return {
    async read(target, options = {}) {
      const raw = String(target?.path ?? "");
      seen.push(raw);
      const normalized = raw.replace(/\\/g, "/");
      if (normalized.endsWith("/public-index.json")) return { content: JSON.stringify(index) };
      if (normalized.endsWith("/images/src_1.png")) {
        return options?.encoding === "base64" ? { content: pngBase64 } : { content: Buffer.from(pngBase64, "base64") };
      }
      return null;
    },
    async list() { return []; },
  };
}

test("手机接入默认关着：状态里没有密码，也不替人写配置文件", async () => {
  const { request, dataDir } = await boot();
  const res = await request("GET", "/mobile/status");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.running, false);
  assert.equal(res.body.reason, "disabled");
  assert.equal(res.body.hasPassword, false);
  assert.equal(Object.hasOwn(res.body, "password"), false, "状态回包里不许带密码");
  assert.ok(Array.isArray(res.body.addresses));
  assert.equal(fs.existsSync(path.join(dataDir, "mobile-gateway.json")), false, "没开过就不该凭空写一份配置");
});

test("开关和端口从桌面保存：非法端口拒掉，已保存和真在跑分开报", async () => {
  const { request, dataDir } = await boot();

  const saved = await request("POST", "/mobile/config", { json: { enabled: false, port: 18123 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.enabled, false);
  assert.equal(saved.body.port, 18123);
  assert.equal(saved.body.running, false, "存下来不等于起来了");
  const onDisk = readConfig(dataDir);
  assert.equal(onDisk.port, 18123);
  assert.equal(onDisk.enabled, false);

  for (const port of [0, 65536, 18.5, "端口"]) {
    const bad = await request("POST", "/mobile/config", { json: { enabled: false, port } });
    assert.equal(bad.status, 400, `端口 ${JSON.stringify(port)} 该被拒`);
    assert.match(bad.body.error.message, /端口/);
  }
  const after = await request("GET", "/mobile/status");
  assert.equal(after.body.port, 18123, "被拒的那次不能把端口改掉");
  assert.equal(readConfig(dataDir).port, 18123);
});

test("密码只在桌面上看得到：show 给本页，reset 换新的、旧的立刻不作数", async () => {
  const seeded = "abcdefghijkmNPQ";
  const { request, dataDir } = await boot({
    seed: (store, ctx) => {
      fs.writeFileSync(
        path.join(ctx.dataDir, "mobile-gateway.json"),
        JSON.stringify({ enabled: false, port: 18093, password: seeded }),
        "utf8",
      );
    },
  });

  const shown = await request("POST", "/mobile/password", { json: { action: "show" } });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.password, seeded);

  const status = await request("GET", "/mobile/status");
  assert.equal(status.body.hasPassword, true);
  assert.equal(JSON.stringify(status.body).includes(seeded), false, "状态里不该出现密码原文");

  const reset = await request("POST", "/mobile/password", { json: { action: "reset" } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.ok, true);
  assert.notEqual(reset.body.password, seeded);
  assert.ok(reset.body.password.length >= 12);
  assert.equal(reset.body.restarted, false, "关着的时候重置不用重起");
  assert.equal(readConfig(dataDir).password, reset.body.password);

  const again = await request("POST", "/mobile/password", { json: { action: "show" } });
  assert.equal(again.body.password, reset.body.password);

  const nonsense = await request("POST", "/mobile/password", { json: { action: "delete" } });
  assert.equal(nonsense.status, 400);
});

test("手机读一页：分页、seq、引用、语音状态齐全，账本里私房字段不跟着出去", async () => {
  const longQuote = "被我引用的那句。".repeat(100);
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "第一句", clientMessageId: "cm_seed_0001" }));
      made.push(store.appendMessage(PARTNER, {
        role: "assistant",
        text: "第二句",
        voice: { status: "ready", format: "mp3", durationMs: 1234, text: "转写在这儿" },
      }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "第三句", quote: { messageId: "m_quote", text: longQuote } }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "第四句" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "第五句" }));
    },
  });
  assert.ok(access, "apply 之后应该建好手机接入");

  const first = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: "2" });
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.messages.map((m) => m.text), ["第四句", "第五句"]);
  assert.deepEqual(first.messages.map((m) => m.seq), [4, 5]);
  assert.equal(first.messages[1].role, "user");
  assert.equal(typeof first.showAvatars, "boolean");

  const older = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 2, before: 4 });
  assert.deepEqual(older.messages.map((m) => m.seq), [2, 3]);
  assert.equal(older.hasMore, true);
  const voice = older.messages[0].voice;
  assert.equal(voice.status, "ready");
  assert.equal(voice.durationMs, 1234);
  assert.equal(voice.text, "转写在这儿");
  assert.equal(older.messages[1].quote.text, longQuote, "有效长引用不能在手机投影时截成 400 字");

  const last = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 2, before: 2 });
  assert.deepEqual(last.messages.map((m) => m.seq), [1]);
  assert.equal(last.hasMore, false);

  // 上限跟桌面 /thread 一致（2000）：手机不该一口气把整本账要走
  const tooMany = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 5000 });
  assert.equal(tooMany.messages.length, 5);

  // 坏游标要拒，不能当成「从头来」
  await assert.rejects(() => access.dispatch("mobile.thread.get", { agentId: PARTNER, before: "abc" }), /游标/);
  await assert.rejects(() => access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 0 }), /页码/);
  await assert.rejects(() => access.dispatch("mobile.thread.get", { agentId: "../etc" }), /伙伴不对/);

  // 私房字段：识图备注、离线告警这些不该整包倒给手机
  const sample = first.messages[0];
  for (const key of ["visionNote", "visionVia", "notice", "recall"]) {
    assert.equal(Object.hasOwn(sample, key), false, `不该把 ${key} 发给手机`);
  }
  // 投喂是可以看的（得让她看见喂了啥），但没喂过就不能凭空多一个空壳
  assert.equal(sample.feed, null, "没喂过的行不该凭空多一个空壳");
  assert.equal(sample.partnerFeed, null);
  assert.equal(Object.hasOwn(sample, "readAt"), true, "已读时间要跟着出去");
  // 但她自己那张票必须带回来：网络超时但已落库时，手机靠它把自己的乐观消息认回来
  assert.equal(last.messages[0].clientMessageId, "cm_seed_0001");
  void store;
});

test("撤回的行只留「撤回了」这件事：原话/转写/附件名/引用都不跟着出去", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      // 原话、语音转写、附件名、引用里都埋了 secret：漏一个就会被后面的序列化断言抓住
      made.push(store.appendMessage(PARTNER, {
        role: "assistant",
        text: "secret 这句要被撤回",
        bubbles: ["secret 这句要被撤回"],
        voice: { status: "ready", format: "mp3", durationMs: 1200, text: "secret 语音转写" },
        attachment: { id: "img_secret", name: "secret.png", mimeType: "image/png", size: 12 },
        quote: { messageId: "m_secret", text: "secret 被引用的那句" },
      }));
    },
  });
  store.patchMessage(PARTNER, made[0].id, {
    recalled: true,
    recallMode: "hard",
    recalledAt: new Date().toISOString(),
  });
  // 夹具前提：桌面那条 /thread 只换 text/bubbles，其余原字段还在账本上
  const raw = store.getThread(PARTNER).messages.at(-1);
  assert.match(raw.text, /secret/);
  assert.match(raw.attachment.name, /secret/);

  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  assert.equal(JSON.stringify(page).includes("secret"), false, "thread.get 的 JSON 里不能有半个 secret");
  const row = page.messages.find((message) => message.id === made[0].id);
  assert.ok(row, "硬撤回的伙伴消息要留着占位，不能凭空消失");
  assert.equal(row.kind, "recalled");
  assert.equal(row.recalled, true);
  assert.equal(row.recallMode, "hard");
  assert.equal(row.text, "对方撤回了一条消息");
  assert.equal(row.voice, null);
  assert.equal(row.attachment, null);
  assert.equal(row.quote, null);
  assert.equal(row.bubbles, null);

  const rows = await access.dispatch("mobile.partners.list", {});
  assert.equal(JSON.stringify(rows).includes("secret"), false, "名单预览也不能把它带回来");

  // 软撤回（她早先撤回、桌面仍显示占位的那种）手机同样保守处理
  const soft = store.appendMessage(PARTNER, {
    role: "user",
    text: "secret 软撤回的原话",
    attachment: { id: "img_soft", name: "secret-soft.png", mimeType: "image/png", size: 8 },
  });
  store.patchMessage(PARTNER, soft.id, {
    kind: "recalled",
    text: "你撤回了一条消息",
    bubbles: null,
    recalled: true,
    recalledAt: new Date().toISOString(),
  });
  const softPage = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  assert.equal(JSON.stringify(softPage).includes("secret"), false, "软撤回也不能带原话/附件");
  const softRow = softPage.messages.find((message) => message.id === soft.id);
  assert.equal(softRow.kind, "recalled");
  assert.equal(softRow.text, "你撤回了一条消息");
  assert.equal(softRow.attachment, null);
  assert.equal(softRow.voice, null);

  // 没撤回的那条照旧：字段还在（不要把整页都削成占位）
  const kept = store.appendMessage(PARTNER, { role: "assistant", text: "这句好好的" });
  const keptPage = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const keptRow = keptPage.messages.find((message) => message.id === kept.id);
  assert.equal(keptRow.text, "这句好好的");
  assert.equal(keptRow.recalled, false);
});

test("未读只认她真的看见那一下：拉记录不算已读，thread.read 才算", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "在吗" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "在的" }));
    },
  });

  const unreadBefore = store.unreadCount(PARTNER);
  assert.equal(unreadBefore, 1, "伙伴说的那句还没被看");

  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  assert.equal(page.messages.length, 2);
  assert.equal(store.unreadCount(PARTNER), unreadBefore, "拉一页记录不等于看过");
  assert.equal(store.getThread(PARTNER).readThroughId, null);

  const read = await access.dispatch("mobile.thread.read", { agentId: PARTNER, throughId: made[1].id });
  assert.equal(read.changed, true);
  assert.equal(read.unread, 0);
  assert.equal(store.getThread(PARTNER).readThroughId, made[1].id);
  assert.equal(store.getThread(PARTNER).readThroughAt !== null, true);

  // 水位只往前挪：重复上报同一条不再算一次变化
  const again = await access.dispatch("mobile.thread.read", { agentId: PARTNER, throughId: made[1].id });
  assert.equal(again.changed, false);
});

test("发一条：幂等 id、引用、图片都原样交给 /turns，重试不会发两遍", async () => {
  const { access, store } = await boot();
  const clientMessageId = "cm_mobile_0001";

  const sent = await access.dispatch("mobile.turn.send", {
    agentId: PARTNER,
    text: "手机发的第一句",
    clientMessageId,
    quote: { messageId: "m_prev", text: "引用一句" },
  });
  assert.ok(sent.messageId, "要回一条落盘的消息 id");
  assert.equal(sent.clientMessageId, clientMessageId);
  assert.equal(sent.duplicate, false);

  const retried = await access.dispatch("mobile.turn.send", {
    agentId: PARTNER,
    text: "手机发的第一句",
    clientMessageId,
    quote: { messageId: "m_prev", text: "引用一句" },
  });
  assert.equal(retried.duplicate, true, "同一个幂等 id 重试要认出来");
  assert.equal(retried.messageId, sent.messageId);

  const thread = store.getThread(PARTNER);
  const mine = thread.messages.filter((row) => row.clientMessageId === clientMessageId);
  assert.equal(mine.length, 1, "重试不能落两条");
  assert.equal(mine[0].quote.text, "引用一句");
  assert.equal(mine[0].text, "手机发的第一句");

  // 图片：形状对不上就别硬塞进账本
  await assert.rejects(() => access.dispatch("mobile.turn.send", { agentId: PARTNER }), /说点什么/);
  await assert.rejects(() => access.dispatch("mobile.turn.send", { agentId: "../x", text: "hi" }), /伙伴不对/);

  const withImage = await access.dispatch("mobile.turn.send", {
    agentId: PARTNER,
    text: "给你看张图",
    clientMessageId: "cm_mobile_0002",
    image: { name: "tiny.png", mimeType: "image/png", data: TINY_PNG },
  });
  const stored = store.getThread(PARTNER).messages.find((row) => row.id === withImage.messageId);
  assert.ok(stored?.attachment?.id, "图片要落在消息上");
  assert.equal(stored.text, "给你看张图", "一张图配一句话，两边都要留下");

  // 再从手机把这张图取回来：字节要一模一样
  const fetched = await access.dispatch("mobile.attachment", { agentId: PARTNER, attachmentId: stored.attachment.id });
  assert.equal(fetched.type, "image/png");
  assert.equal(Buffer.from(fetched.base64, "base64").toString("base64"), TINY_PNG);
});

test("撤回过的附件和语音不再放出去；听过了才盖章", async () => {
  const made = [];
  const booted = await boot();
  const { access, store, dataDir } = booted;

  // 一条带图的用户消息（走真发送口落盘）
  const sent = await access.dispatch("mobile.turn.send", {
    agentId: PARTNER,
    text: "这张图待会儿我要撤回",
    clientMessageId: "cm_mobile_0003",
    image: { name: "tiny.png", mimeType: "image/png", data: TINY_PNG },
  });
  const stored = store.getThread(PARTNER).messages.find((row) => row.id === sent.messageId);
  const attachmentId = stored.attachment.id;

  // 语音：造一条真文件 + 一条已就绪的语音消息
  const voiceMessage = store.appendMessage(PARTNER, {
    role: "assistant",
    text: "[语音]",
    voice: { status: "ready", format: "mp3", durationMs: 1000, text: "听见了" },
  });
  made.push(voiceMessage);
  const voicePath = path.join(dataDir, "v2", "voice", PARTNER, `${voiceMessage.id}.mp3`);
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  fs.writeFileSync(voicePath, Buffer.from("FAKE-MP3-BYTES"));

  const audio = await access.dispatch("mobile.voice", { agentId: PARTNER, messageId: voiceMessage.id });
  assert.equal(Buffer.from(audio.base64, "base64").toString("utf8"), "FAKE-MP3-BYTES");

  const played = await access.dispatch("mobile.voice.played", { agentId: PARTNER, messageId: voiceMessage.id });
  assert.ok(played.playedAt, "听过要盖时间");
  const firstPlayedAt = played.playedAt;
  const again = await access.dispatch("mobile.voice.played", { agentId: PARTNER, messageId: voiceMessage.id });
  assert.equal(again.playedAt, firstPlayedAt, "再听一遍不改第一次的时间");

  // 硬撤回之后：附件和语音都不许再取
  store.patchMessage(PARTNER, sent.messageId, { recalled: true, recallMode: "hard", kind: "recalled" });
  await assert.rejects(
    () => access.dispatch("mobile.attachment", { agentId: PARTNER, attachmentId }),
    /不在了/,
  );
  store.patchMessage(PARTNER, voiceMessage.id, { recalled: true, recallMode: "hard" });
  await assert.rejects(
    () => access.dispatch("mobile.voice", { agentId: PARTNER, messageId: voiceMessage.id }),
    /听不了|没准备好/,
  );
  await assert.rejects(
    () => access.dispatch("mobile.voice.played", { agentId: PARTNER, messageId: voiceMessage.id }),
    /听不了/,
  );

  // 没挂在任何消息上的附件 id 也不给：不是「文件在盘上」就能取
  await assert.rejects(
    () => access.dispatch("mobile.attachment", { agentId: PARTNER, attachmentId: "img_not_mine" }),
    /不在了/,
  );
  // 别人的图也不行：归属只看这位伙伴自己那本账
  await assert.rejects(
    () => access.dispatch("mobile.attachment", { agentId: "someone_else", attachmentId }),
    /不在了/,
  );

  // 语音还没录好就不给听、也不给盖章
  const pendingVoice = store.appendMessage(PARTNER, { role: "assistant", text: "[语音]", voice: { status: "pending", format: "mp3" } });
  await assert.rejects(() => access.dispatch("mobile.voice", { agentId: PARTNER, messageId: pendingVoice.id }), /没准备好/);
  await assert.rejects(() => access.dispatch("mobile.voice.played", { agentId: PARTNER, messageId: pendingVoice.id }), /听不了/);
});

test("同一张票并发重试只发一条：在途共用同一个请求，跑完再交回原业务幂等", async () => {
  const { access, store } = await boot();
  const clientMessageId = "cm_race_0001";
  const payload = {
    agentId: PARTNER,
    text: "同时按了两下",
    clientMessageId,
    // 带图才有跨 await 的窗口：没有图时原业务那次 check 本来就接得住
    image: { name: "tiny.png", mimeType: "image/png", data: TINY_PNG },
  };
  const [first, second] = await Promise.all([
    access.dispatch("mobile.turn.send", payload),
    access.dispatch("mobile.turn.send", payload),
  ]);
  assert.ok(first.messageId);
  assert.equal(second.messageId, first.messageId, "两次拿到的必须是同一条");

  const stored = store.getThread(PARTNER).messages.filter((row) => row.clientMessageId === clientMessageId);
  assert.equal(stored.length, 1, "并发重试只该落一条，也不该让识图花两次钱");

  // 在途表只在路上：跑完之后再重试，走的是原业务那份已落库幂等
  const later = await access.dispatch("mobile.turn.send", payload);
  assert.equal(later.duplicate, true);
  assert.equal(later.messageId, first.messageId);
  assert.equal(store.getThread(PARTNER).messages.filter((row) => row.clientMessageId === clientMessageId).length, 1);
});

test("图片还是那道 10MiB 的关：超一点就整条不收，账本里不留半条", async () => {
  const { access, store } = await boot();
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  big[0] = 0x89;
  big[1] = 0x50;
  big[2] = 0x4e;
  big[3] = 0x47;
  const before = store.getThread(PARTNER).messages.length;
  await assert.rejects(
    () => access.dispatch("mobile.turn.send", {
      agentId: PARTNER,
      text: "太大的图",
      clientMessageId: "cm_big_0001",
      image: { name: "big.png", mimeType: "image/png", data: big.toString("base64") },
    }),
    /太大/,
  );
  assert.equal(store.getThread(PARTNER).messages.length, before, "拒掉的图不能留下半条消息");
});

test("分页口径跟桌面 /thread 一致：首屏 50、上翻扩到 2000，不再卡在 200", async () => {
  const { access } = await boot({
    seed: (store) => {
      // 210 条：刚好越过旧的那个 200 上限，能看出到底有没有卡
      for (let index = 0; index < 210; index += 1) {
        store.appendMessage(PARTNER, { role: index % 2 ? "assistant" : "user", text: `第 ${index + 1} 句` });
      }
    },
  });

  const first = await access.dispatch("mobile.thread.get", { agentId: PARTNER });
  assert.equal(first.messages.length, 50, "首屏还是 50，不因为上限放宽就变重");
  assert.equal(first.total, 210);
  assert.equal(first.hasMore, true);

  // 上翻时手机会要「已加载条数 + 50」把整个窗重新拉一遍
  const expanded = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 260 });
  assert.equal(expanded.messages.length, 210, "扩大整窗时要真能拿到 200 条以上");
  assert.equal(expanded.messages[0].seq, 1);
  assert.equal(expanded.hasMore, false);

  const over = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 5000 });
  assert.equal(over.messages.length, 210, "要得再多也只是这本账的条数，不报错");

  const windowed = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 60, before: 151 });
  assert.equal(windowed.messages.length, 60);
  assert.equal(windowed.messages.at(-1).seq, 150);
  assert.equal(windowed.hasMore, true);

  // 上限是 2000（跟桌面那条一致），不是 200：这个数只钉常量，因为真造 2001 条太重
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /const MOBILE_PAGE_MAX = 2000;/);
});

test("手机页与脚本：模块引用带固定 build 戳，脚本按 JS 类型发出去", async () => {
  const { access } = await boot();
  const html = await access.dispatch("mobile.page.index", {});
  assert.match(html, /\/assets\/mobile-client\.js\?v=[A-Za-z0-9.-]+/, "模块 URL 要带 build 戳，别让旧脚本贴在缓存里");
  assert.match(html, /\/assets\/panel\.css\?v=[A-Za-z0-9.-]+/, "样式也一起带");
  const build = html.match(/mobile-client\.js\?v=([A-Za-z0-9.-]+)/)[1];
  assert.ok(build.startsWith("0.13.0-") || /^\d+\.\d+\.\d+-/u.test(build), `build 戳要带应用版本，现在 ${build}`);
  assert.equal((html.match(/mobile-client\.js\?v=/gu) ?? []).length, 1, "引用串只能带一层 query");
  const again = (await access.dispatch("mobile.page.index", {})).match(/mobile-client\.js\?v=([A-Za-z0-9.-]+)/)[1];
  assert.equal(again, build, "同一次安装里 build 戳必须固定");

  const asset = await access.dispatch("mobile.asset", { name: "mobile-client.js" });
  assert.equal(asset.type, "text/javascript; charset=utf-8", "js 资源要用 JS 的 MIME");
  const body = Buffer.from(asset.base64, "base64").toString("utf8");
  assert.match(body, /export function startMobileClient/, "白名单要真能把手机脚本发出去");
});

test("手机要的窗口和服务端允许的上限对得上", async () => {
  const { access } = await boot();
  // 客户端侧的常量：首屏 50，上翻按已加载数扩大，但永远不越过上限
  assert.equal(MOBILE_PAGE_CAP, 2000, "客户端上限要和桌面 /thread 那条一致");
  assert.equal(pullLimit(0), 50, "首屏就只要 50");
  assert.equal(pullLimit(120), 120, "翻过之后按已加载数要整个窗");
  assert.equal(pullLimit(5000), 2000, "再怎么翻也不越上限");
  // 服务端真能吃下这个上限：不报错，按账本里有的给
  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: pullLimit(2500) });
  assert.ok(Array.isArray(page.messages));
  assert.equal(page.total, 0);
});

test("名单预览不泄漏已撤回的原文：撤回只说撤回，硬撤回隐藏的那条按桌面口径跳过", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "上一句还在", at: "2026-10-30T08:00:00.000Z" }));
      made.push(store.appendMessage(PARTNER, {
        role: "assistant",
        text: "secret 这句话已经被撤回",
        voice: { status: "ready", format: "mp3", text: "secret 语音转写" },
      }));
    },
  });
  // 硬撤回后账本里的 text 仍是原文（桌面靠 /thread 换占位盖住）
  store.patchMessage(PARTNER, made[1].id, { recalled: true, recallMode: "hard", recalledAt: new Date().toISOString() });
  assert.match(store.getThread(PARTNER).messages.at(-1).text, /secret/, "夹具前提：底层确实还留着原文");

  const rows = await access.dispatch("mobile.partners.list", {});
  const row = rows.find((r) => r.id === PARTNER);
  assert.ok(row, "名单里应该有这位伙伴");
  assert.equal(JSON.stringify(rows).includes("secret"), false, "撤回的原文/转写一个字都不能进列表");
  assert.equal(row.last.kind, "recalled");
  assert.match(row.last.preview, /撤回了一条消息/);
  assert.equal(row.last.preview.includes("secret"), false);

  // 她自己硬撤回的那条在桌面本来就不显示：列表要退到上一条可见的，而不是读它
  const hidden = store.appendMessage(PARTNER, { role: "user", text: "secret 我自己撤的" });
  store.patchMessage(PARTNER, hidden.id, { recalled: true, recallMode: "hard", recalledAt: new Date().toISOString() });

  const afterRows = await access.dispatch("mobile.partners.list", {});
  const after = afterRows.find((r) => r.id === PARTNER);
  assert.equal(JSON.stringify(afterRows).includes("secret"), false, "隐藏掉的原文也不能从预览绕回来");
  assert.equal(after.last.id, made[1].id, "应退到上一条可见的消息");
  assert.notEqual(after.last.id, hidden.id);
  assert.match(after.last.preview, /撤回了一条消息/);
});

test("投喂：只给伙伴还在的那条累加，只回安全的 feed，账本里那份结构不跟着出去", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "给你留了口甜的" }));
    },
  });

  const first = await access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji: "🍰" });
  assert.deepEqual(Object.keys(first), ["feed"], "只回 feed，不把整条消息倒回来");
  assert.equal(first.feed.items.find((item) => item.emoji === "🍰").count, 1);

  const again = await access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji: "🍰" });
  assert.equal(again.feed.items.find((item) => item.emoji === "🍰").count, 2, "同一个 emoji 要累加");

  const another = await access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji: "☕" });
  assert.deepEqual(another.feed.items.map((item) => item.emoji).sort(), ["☕", "🍰"].sort());
  for (const item of another.feed.items) {
    for (const key of Object.keys(item)) assert.ok(["emoji", "count", "at"].includes(key), `feed item 不该带 ${key}`);
  }

  // 真的落进账本了（不是只回了包）
  const saved = store.getThread(PARTNER).messages.find((row) => row.id === made[0].id);
  assert.equal(saved.feed.items.find((item) => item.emoji === "🍰").count, 2);

  // 她递的小东西：账本里带 kind/reason，投影只留 emoji/次数/时间
  store.patchMessage(PARTNER, made[0].id, {
    partnerFeed: { items: [{ emoji: "🍭", count: 3, at: "2026-10-30T09:00:00.000Z", kind: "sweet", reason: "secret 看她今天不太好" }] },
  });
  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const shown = page.messages.find((row) => row.id === made[0].id);
  assert.deepEqual(shown.partnerFeed, { items: [{ emoji: "🍭", count: 3, at: "2026-10-30T09:00:00.000Z" }] });
  assert.deepEqual(
    shown.feed.items.map((item) => Object.keys(item).sort()),
    [["at", "count", "emoji"], ["at", "count", "emoji"]],
    "投影里每一项只能有 emoji/count/at",
  );
  assert.equal(JSON.stringify(page).includes("secret"), false, "内部判据一个字都不能出去");

  // 撤回之后两个投喂都不再显示（账本里可能还挂着，投影得清掉）
  store.patchMessage(PARTNER, made[0].id, { recalled: true, recallMode: "hard", recalledAt: new Date().toISOString() });
  const afterRecall = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const recalledRow = afterRecall.messages.find((row) => row.id === made[0].id);
  assert.equal(recalledRow.recalled, true);
  assert.equal(recalledRow.feed, null, "撤回的行不该还挂着投喂");
  assert.equal(recalledRow.partnerFeed, null);
  assert.equal(JSON.stringify(recalledRow).includes("🍰"), false);
  assert.equal(JSON.stringify(recalledRow).includes("🍭"), false);
});

test("回复挂在哪句上：repliedTo 只给字符串或 null，撤回的清空，主动消息不冒充", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "今晚吃什么" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "吃面吧", repliedTo: made[0].id }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "对了，明天降温", proactive: true }));
    },
  });

  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const byId = new Map(page.messages.map((row) => [row.id, row]));
  assert.equal(byId.get(made[0].id).repliedTo, null, "她自己那句话没有回复目标");
  assert.equal(byId.get(made[1].id).repliedTo, made[0].id, "回复要指回那句");
  assert.equal(typeof byId.get(made[1].id).repliedTo, "string");
  assert.equal(byId.get(made[2].id).repliedTo, null, "主动消息不能冒充回复（否则投喂会在它那儿提前截断）");
  for (const row of page.messages) {
    assert.ok(row.repliedTo === null || typeof row.repliedTo === "string", "repliedTo 只能是字符串或 null");
  }

  // 撤回后就不该再指回去
  store.patchMessage(PARTNER, made[1].id, { recalled: true, recallMode: "hard", recalledAt: new Date().toISOString() });
  const afterRecall = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const recalledRow = afterRecall.messages.find((row) => row.id === made[1].id);
  assert.equal(recalledRow.repliedTo, null, "撤回的行不指回去");
  assert.equal(JSON.stringify(recalledRow).includes(made[0].id), false, "连那个 id 也不该从别的字段绕回来");
});

test("收藏开关跟着桌面那条走：只回一个布尔，收藏夹快照不往手机带", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "这句值得留着" }));
    },
  });

  const on = await access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: made[0].id });
  assert.deepEqual(Object.keys(on), ["favorite"], "只回开关，不把整段收藏快照倒出去");
  assert.equal(on.favorite, true);
  assert.equal(store.listFavorites().filter((row) => row.agentId === PARTNER && row.messageId === made[0].id).length, 1);

  const off = await access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: made[0].id });
  assert.equal(off.favorite, false, "再点一下就是取消收藏");
  assert.equal(store.listFavorites().filter((row) => row.agentId === PARTNER && row.messageId === made[0].id).length, 0);
});

test("投喂/收藏的门禁：参数错、跨归属、不是她说的、已撤回全拒，而且一个字节都不落盘", async () => {
  const made = [];
  const { access, store, dataDir } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "伙伴说的" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "她说的" }));
      made.push(store.appendMessage("someone_else", { role: "assistant", text: "别人家的" }));
    },
  });

  const threadDir = path.join(dataDir, "v2", "threads");
  const snapshot = () => Object.fromEntries(
    fs.readdirSync(threadDir).filter((name) => name.endsWith(".json"))
      .map((name) => [name, fs.readFileSync(path.join(threadDir, name), "utf8")]),
  );
  const before = snapshot();

  // 参数
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: "", emoji: "🍰" }), /参数不对/);
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: "../etc", messageId: made[0].id, emoji: "🍰" }), /参数不对/);
  await assert.rejects(() => access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: "" }), /参数不对/);
  await assert.rejects(() => access.dispatch("mobile.message.favorite", { agentId: "../etc", messageId: made[0].id }), /参数不对/);
  // 小菜单外的 emoji
  for (const emoji of ["🍕", "", "  "]) {
    await assert.rejects(
      () => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji }),
      /小菜单/,
      `emoji ${JSON.stringify(emoji)} 该被拒`,
    );
  }
  // 不是她说的那条
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[1].id, emoji: "🍰" }), /还在的消息/);
  await assert.rejects(() => access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: made[1].id }), /还在的消息/);
  // 别人家的那条：归属只看这位伙伴自己那本账
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[2].id, emoji: "🍰" }), /还在的消息/);
  await assert.rejects(() => access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: made[2].id }), /还在的消息/);
  // 不存在的那条
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: "m_nope", emoji: "🍰" }), /还在的消息/);
  // 撤回过的
  assert.deepEqual(snapshot(), before, "前面那些被拒的请求也一个字节没写");
  store.patchMessage(PARTNER, made[0].id, { recalled: true, recallMode: "hard" });
  const afterRecall = snapshot();
  await assert.rejects(() => access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji: "🍰" }), /还在的消息/);
  await assert.rejects(() => access.dispatch("mobile.message.favorite", { agentId: PARTNER, messageId: made[0].id }), /还在的消息/);

  assert.deepEqual(snapshot(), afterRecall, "被拒的请求不能改账本（包括都不该顺手盖章已读）");
  assert.notDeepEqual(afterRecall, before, "夹具前提：撤回那一下本身应该落盘了");
  assert.equal(store.listFavorites().length, 0, "一个收藏也不该被偷偷建出来");
  assert.equal(JSON.stringify(store.getThread(PARTNER).messages.find((row) => row.id === made[0].id)).includes("feed"), false, "没喂成就不该留下 feed");
});

test("投喂也算变化：喂一口、被投喂、已读都要换指纹，没变时指纹要稳", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "指纹这句" }));
    },
  });
  await access.refreshWatched();
  assert.ok(access.watched.includes(PARTNER));

  const base = access.signatureNow();
  assert.equal(access.signatureNow(), base, "什么都没动时指纹要稳");

  await access.dispatch("mobile.message.feed", { agentId: PARTNER, messageId: made[0].id, emoji: "🍰" });
  const fed = access.signatureNow();
  assert.notEqual(fed, base, "喂一口要换指纹（消息 id 没变）");
  assert.equal(access.signatureNow(), fed, "没再动就接着稳");

  store.patchMessage(PARTNER, made[0].id, { partnerFeed: { items: [{ emoji: "🍭", count: 1, at: "2026-10-30T10:00:00.000Z" }] } });
  const partnerFed = access.signatureNow();
  assert.notEqual(partnerFed, fed, "她递的小东西也要换指纹");

  store.patchMessage(PARTNER, made[0].id, { readAt: "2026-10-30T10:05:00.000Z" });
  const read = access.signatureNow();
  assert.notEqual(read, partnerFed, "已读时间要进指纹");

  // 回复换了目标也换一屏：手机靠 repliedTo 定投喂截断点
  store.patchMessage(PARTNER, made[0].id, { repliedTo: "m_other_turn" });
  assert.notEqual(access.signatureNow(), read, "repliedTo 变了要换指纹");
});

test("thread.get 的修整信息：开关、整本账里的最后一条回复、每行能不能撤回", async () => {
  const made = [];
  const { access, request } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "第一句" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "答一句" }));
      for (let index = 0; index < 3; index += 1) made.push(store.appendMessage(PARTNER, { role: "user", text: `补一句 ${index}` }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "最后一条回复" }));
    },
  });

  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 2, before: 6 });
  assert.equal(page.messageRefine, false, "修整默认关着，手机也不开");
  assert.equal(page.latestAssistantId, made.at(-1).id, "最新伙伴回复要从整本账里算，不受这一页限制");
  assert.equal(page.messages.some((row) => row.id === made.at(-1).id), false, "钳制前提：这一页里确实没有它");

  const full = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  const userRow = full.messages.find((row) => row.id === made[0].id);
  const assistantRow = full.messages.find((row) => row.id === made[1].id);
  assert.equal(userRow.canRecall, true, "刚发出去、还没被看过的她自己那句可以撤");
  assert.equal(assistantRow.canRecall, false, "伙伴的回复不能由她撤回");
  assert.equal("recall" in assistantRow, false, "内部那条资格判定不整包出去");

  await request("PUT", "/settings/global", { json: { messageRefine: true } });
  const after = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 2 });
  assert.equal(after.messageRefine, true, "设置页打开后手机也看得到");
});

test("回合状态：只认自己的回合；答复被撤回后旧 items 不再贴回屏幕", async () => {
  const { access, store, models, request } = await boot();
  const sent = await access.dispatch("mobile.turn.send", { agentId: PARTNER, text: "在吗", clientMessageId: "cm_turn_0001" });
  assert.ok(sent.turnId, "发一条应该开一个回合");

  await assert.rejects(
    () => access.dispatch("mobile.turn.get", { agentId: "someone_else", turnId: sent.turnId }),
    /已经结束/,
    "别人的回合不许查",
  );
  await assert.rejects(() => access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: "t_nope" }), /已经结束/);

  const pending = await access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: sent.turnId });
  assert.ok(["pending", "generating"].includes(pending.status), `刚开出来应该还在做，实际 ${pending.status}`);
  assert.equal(pending.items, null);
  assert.equal(pending.replyMessageId, null);
  assert.equal(pending.message, null);

  const call = await models.waitForCall(0);
  models.release(call, "在的呀");
  const ready = await waitFor(async () => {
    const row = await access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: sent.turnId });
    return row.status === "ready" ? row : null;
  }, "回合就绪");
  assert.ok(ready.replyMessageId, "ready 时要给出对应那条回复");
  assert.equal(ready.message.id, ready.replyMessageId);
  assert.match(ready.message.text, /在的呀/);
  assert.ok(Array.isArray(ready.items) && ready.items.length >= 1);
  // items 是 {text, gapMs} 而不是裸字符串
  assert.equal(typeof ready.items[0].text, "string");
  assert.ok(Object.hasOwn(ready.items[0], "gapMs"));
  assert.deepEqual(Object.keys(ready.items[0]).sort(), ["gapMs", "text"]);
  assert.equal(JSON.stringify(ready).includes("system"), false, "提示词之类的不跟着出去");

  // 改过稿之后，旧 bubbles 不能再被当成屏上那句
  await request("PUT", "/settings/global", { json: { messageRefine: true } });
  await access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: ready.replyMessageId, text: "改过的在的呀" });
  const refreshed = await access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: sent.turnId });
  assert.equal(refreshed.items.length, 1);
  assert.equal(refreshed.items[0].text, "改过的在的呀", "改过稿就按现在这条重建 items");
  assert.equal(refreshed.message.text, "改过的在的呀");

  // 那条答复被撤回：旧回合不能把这句话又贴回去
  store.patchMessage(PARTNER, ready.replyMessageId, { recalled: true, recallMode: "hard" });
  const stale = await access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: sent.turnId });
  assert.equal(stale.items, null, "被撤回的答复不能再贴一次");
  assert.equal(stale.replyMessageId, null);
  assert.equal(stale.message, null);
});

test("撤回：她自己那条照本体门禁撤，伙伴的/已撤回的/别人的全拒", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "这句要撤回" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "这句不能由她撤" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "已经撤回过的" }));
    },
  });
  store.patchMessage(PARTNER, made[2].id, { recalled: true, recalledAt: new Date().toISOString() });

  const ok = await access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: made[0].id });
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, "removed", "还没被看过的那条撤得无痕");
  const stored = store.getThread(PARTNER).messages.find((row) => row.id === made[0].id);
  assert.equal(stored.recalled, true);
  assert.equal(stored.recallMode, "hard");

  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: made[1].id }), /不能撤回/);
  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: made[2].id }), /不能撤回/);
  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: "other", messageId: made[0].id }), /不能撤回/);
  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: "../../etc" }), /消息编号不对/);
});

test("改稿/重生成：只在修整打开、且是最后一条伙伴回复时才动手", async () => {
  const made = [];
  const { access, store, request, models } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "第一条回复" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "她说了句" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "最后一条回复" }));
    },
  });
  const first = made[0].id;
  const last = made[2].id;

  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: last, text: "改" }), /还没打开/);
  await assert.rejects(() => access.dispatch("mobile.message.regenerate", { agentId: PARTNER, messageId: last }), /还没打开/);

  await request("PUT", "/settings/global", { json: { messageRefine: true } });

  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: first, text: "改" }), /最后一条/);
  await assert.rejects(() => access.dispatch("mobile.message.regenerate", { agentId: PARTNER, messageId: first }), /最后一条/);

  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: last, text: "   " }), /空白/);
  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: last, text: "字".repeat(4001) }), /4000/);
  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: "other", messageId: last, text: "改" }), /伙伴还在/);

  const edited = await access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: last, text: "改过的句子" });
  assert.equal(edited.ok, true);
  assert.equal(edited.message.text, "改过的句子");
  assert.equal(edited.message.voice, null, "改字之后旧的语音不该还挂着");
  const stored = store.getThread(PARTNER).messages.find((row) => row.id === last);
  assert.equal(stored.text, "改过的句子");
  assert.equal(stored.userRefined, true);

  store.patchMessage(PARTNER, last, { recalled: true, recallMode: "hard" });
  await assert.rejects(() => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: last, text: "再改" }), /伙伴还在/);
  assert.equal(models.calls.length, 0, "这些门禁一路下来一次模型都不该叫");
});

test("删除：修整开关与归属先卡，戳一戳才真能删掉", async () => {
  const made = [];
  const { access, store, request } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", kind: "action", actionId: "poke", text: "戳了戳你的胳膊" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "她自己说的话" }));
    },
  });

  await assert.rejects(() => access.dispatch("mobile.message.delete", { agentId: PARTNER, messageId: made[0].id }), /还没打开/);
  await request("PUT", "/settings/global", { json: { messageRefine: true } });

  await assert.rejects(() => access.dispatch("mobile.message.delete", { agentId: PARTNER, messageId: "m_not_here" }), /不在聊天记录/);
  await assert.rejects(() => access.dispatch("mobile.message.delete", { agentId: PARTNER, messageId: made[1].id }), /只能删伙伴的回复/);
  await assert.rejects(() => access.dispatch("mobile.message.delete", { agentId: "other", messageId: made[0].id }), /不在聊天记录/);

  const removed = await access.dispatch("mobile.message.delete", { agentId: PARTNER, messageId: made[0].id });
  assert.equal(removed.ok, true);
  assert.equal(removed.action, true);
  assert.equal(store.getThread(PARTNER).messages.some((row) => row.id === made[0].id), false, "戳一戳真的从账本里没了");
});

test("收藏：只读当前伙伴，正文用还活着的那条，快照不复活旧话", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "原话要被改" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "这句待会儿删掉" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "别的伙伴那句" }));
    },
  });
  store.saveFavorite({ agentId: PARTNER, partnerName: "小花", messageId: made[0].id, kind: "text", text: "原话要被改", at: "2026-10-30T08:00:00.000Z" });
  store.saveFavorite({ agentId: PARTNER, partnerName: "小花", messageId: made[1].id, kind: "text", text: "这句待会儿删掉", at: "2026-10-30T08:05:00.000Z" });
  const otherFavorite = store.saveFavorite({ agentId: "other", partnerName: "别人", messageId: made[2].id, kind: "text", text: "别的伙伴那句", at: "2026-10-30T08:06:00.000Z" });

  store.patchMessage(PARTNER, made[0].id, { text: "改过的正文" });
  store.removeMessage(PARTNER, made[1].id);

  const list = await access.dispatch("mobile.favorites.list", { agentId: PARTNER });
  assert.equal(list.items.length, 1, "源消消息被删的那条不出现在列表里");
  assert.equal(list.items[0].messageId, made[0].id);
  assert.equal(list.items[0].text, "改过的正文", "正文用现在这条，不是收藏时的快照");
  assert.equal(JSON.stringify(list).includes("这句待会儿删掉"), false, "删掉的原话不能从快照里回来");
  assert.equal(JSON.stringify(list).includes("别的伙伴那句"), false, "别的伙伴的收藏不给");
  assert.equal(list.items[0].kind, "text");

  await assert.rejects(() => access.dispatch("mobile.favorite.remove", { agentId: PARTNER, id: otherFavorite.id }), /自己的收藏/);
  assert.equal(store.listFavorites().some((row) => row.id === otherFavorite.id), true, "别人的收藏一个字没动");

  const removed = await access.dispatch("mobile.favorite.remove", { agentId: PARTNER, id: list.items[0].id });
  assert.equal(removed.ok, true);
  assert.equal(store.listFavorites().some((row) => row.id === list.items[0].id), false);
  await assert.rejects(() => access.dispatch("mobile.favorite.remove", { agentId: PARTNER, id: "fav_gone" }), /已经不在了/);
});

test("拇一下：落一条动作消息，不即时叫模型", async () => {
  const { access, store, models } = await boot({
    seed: (store) => {
      // 先把这位伙伴的小动作文案备好：不然它会现叫模型写一句（这里不该发生）
      store.setPartnerSettings(PARTNER, {
        action: { text: "戳了戳你的胳膊", voice: ACTION_VOICE, nextAt: "2099-01-01T00:00:00.000Z" },
      });
    },
  });
  const result = await access.dispatch("mobile.action.send", { agentId: PARTNER });
  assert.equal(result.ok, true);
  assert.ok(result.messageId);
  const stored = store.getThread(PARTNER).messages.find((row) => row.id === result.messageId);
  assert.equal(stored.kind, "action");
  assert.equal(stored.role, "user");
  assert.equal(models.calls.length, 0, "拇一下不该现叫模型");
  await assert.rejects(() => access.dispatch("mobile.action.send", { agentId: "../x" }), /伙伴不对/);
});

test("待办：按伙伴过滤，跨伙伴 key 拒绝；确认失败要抛、不能假成功", async () => {
  const mine = makeProposal({ todo: { id: "td_mine", title: "交水费", date: "2026-10-31", at: "09:00" }, agentId: PARTNER });
  const theirs = makeProposal({ todo: { id: "td_theirs", title: "买牛奶", date: "2026-10-31", at: "10:00" }, agentId: "other" });
  const loose = makeProposal({ todo: { id: "td_loose", title: "没有归属", date: "2026-10-31", at: "11:00" }, agentId: "" });
  const { access, store } = await boot({
    seed: (store) => store.setTodoProposals([mine, theirs, loose]),
  });

  const list = await access.dispatch("mobile.todos.list", { agentId: PARTNER });
  assert.deepEqual(list.items.map((row) => row.key), [mine.key], "只给这位伙伴的，没归属的也不给");
  assert.equal(Object.hasOwn(list.items[0], "todoId"), false, "内部待办 id 不跟着出去");
  assert.equal(list.items[0].title, "交水费");

  await assert.rejects(() => access.dispatch("mobile.todos.confirm", { agentId: PARTNER, key: theirs.key }), /不是这位伙伴的/);
  await assert.rejects(() => access.dispatch("mobile.todos.dismiss", { agentId: PARTNER, key: theirs.key }), /不是这位伙伴的/);
  assert.equal(store.getTodoProposals().some((row) => row.key === theirs.key), true, "拒绝的时候别人的窗一个字没动");

  // 本体确认失败（回的是 200 + ok:false）：手机必须当失败，不能假成功
  await assert.rejects(() => access.dispatch("mobile.todos.confirm", { agentId: PARTNER, key: mine.key }), /没记上|留着/);
  assert.equal(store.getTodoProposals().some((row) => row.key === mine.key), true, "没确认成功窗就得留着");

  const dismissed = await access.dispatch("mobile.todos.dismiss", { agentId: PARTNER, key: mine.key });
  assert.equal(dismissed.ok, true);
  const after = await access.dispatch("mobile.todos.list", { agentId: PARTNER });
  assert.deepEqual(after.items, [], "先不用之后窗就收了");
});

test("手机没有图库管理口：来源/分组/导入/移除全拒，只读和发图还在", async () => {
  __clearCatalogCache();
  const { access, request } = await boot({ resources: stickerSourceResources(TINY_PNG, []) });

  // 哪怕图库真有东西、数据源也真在，这几个口子也不存在（不是在 UI 里藏起来）
  const refused = /unknown op/;
  for (const [op, payload] of [
    ["mobile.stickers.source", { agentId: PARTNER }],
    ["mobile.stickers.group.create", { agentId: PARTNER, name: "心头好" }],
    ["mobile.stickers.group.rename", { agentId: PARTNER, id: "grp_x", name: "改名" }],
    ["mobile.stickers.group.remove", { agentId: PARTNER, id: "grp_x" }],
    ["mobile.stickers.import", { agentId: PARTNER, sourceIds: ["src_1"] }],
    ["mobile.stickers.remove", { agentId: PARTNER, id: "local_x" }],
    ["mobile.source-sticker", { agentId: PARTNER, id: "src_1" }],
  ]) {
    await assert.rejects(() => access.dispatch(op, payload), refused, `${op} 不该还开着`);
  }

  // 只读清单还在；图由桌面那页导进来之后，手机发图/发表情照旧
  const listed = await access.dispatch("mobile.stickers.list", { agentId: PARTNER });
  assert.ok(Array.isArray(listed.groups));
  assert.ok(Array.isArray(listed.stickers));

  assert.equal((await request("POST", "/library/import", { json: { sourceIds: ["src_1"] } })).body.ok, true);
  const ready = await access.dispatch("mobile.stickers.list", { agentId: PARTNER });
  const own = ready.stickers.filter((row) => row.source === "own");
  assert.equal(own.length, 1);
  const sent = await access.dispatch("mobile.turn.send", { agentId: PARTNER, stickerId: own[0].id, clientMessageId: "cm_stk_0001" });
  assert.ok(sent.messageId, "发表情是聊天，不在收窄范围里");
  __clearCatalogCache();
});

test("手机只读图库：桌面新增/删除图和分类后，再取 list 就是新内容", async () => {
  __clearCatalogCache();
  const { access, request } = await boot({ resources: stickerSourceResources(TINY_PNG, []) });

  const before = await access.dispatch("mobile.stickers.list", { agentId: PARTNER });
  assert.deepEqual(before.groups, []);
  assert.equal(before.stickers.filter((row) => row.source === "own").length, 0);

  // 桌面那页建分类、导入一张图（走的是桌面的 /library/*，不经过手机）
  const created = await request("POST", "/library/groups", { json: { name: "桌面建的组" } });
  assert.equal(created.body.ok, true);
  const imported = await request("POST", "/library/import", { json: { sourceIds: ["src_1"], groupId: created.body.group.id } });
  assert.equal(imported.body.ok, true);
  assert.equal(imported.body.imported, 1);

  const after = await access.dispatch("mobile.stickers.list", { agentId: PARTNER });
  assert.deepEqual(after.groups.map((row) => row.name), ["桌面建的组"], "分类跟着桌面同步");
  const own = after.stickers.filter((row) => row.source === "own");
  assert.equal(own.length, 1, "桌面新导入的图手机上马上看得到");
  assert.deepEqual(own[0].groupIds, [created.body.group.id]);

  // 桌面删图、删分类，手机取到的就是删完的样子
  assert.equal((await request("DELETE", `/library/stickers/${own[0].id}`)).body.ok, true);
  assert.equal((await request("DELETE", `/library/groups/${created.body.group.id}`)).body.ok, true);
  const final = await access.dispatch("mobile.stickers.list", { agentId: PARTNER });
  assert.equal(final.stickers.filter((row) => row.source === "own").length, 0);
  assert.deepEqual(final.groups, []);
  __clearCatalogCache();
});

test("回合出错：只回一句能读的错误，路径不跟着出去", async () => {
  const { access, models } = await boot();
  const sent = await access.dispatch("mobile.turn.send", { agentId: PARTNER, text: "这句会接不上", clientMessageId: "cm_turn_err" });
  const call = await models.waitForCall(0);
  models.releaseError(call, "APP_MODEL_QUOTA_EXCEEDED", "quota exceeded D:\\app-cache\\cache.json");
  const row = await waitFor(async () => {
    const got = await access.dispatch("mobile.turn.get", { agentId: PARTNER, turnId: sent.turnId });
    return got.status === "error" ? got : null;
  }, "回合失败");
  assert.equal(row.items, null);
  assert.equal(row.replyMessageId, null);
  assert.equal(row.message, null);
  assert.ok(row.error, "要给出能读的错误");
  assert.equal(row.error.includes("app-cache"), false, "绝对路径不许跟着出去");
});

test("认识门禁：没认识完的伙伴只能看历史，不能替她开口", async () => {
  const made = [];
  const { access, store } = await boot({
    settled: false,
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "旧消息" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "旧回复" }));
    },
  });

  const rows = await access.dispatch("mobile.partners.list", {});
  assert.equal(rows.find((row) => row.id === PARTNER).needsOnboarding, true);
  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 50 });
  assert.equal(page.needsOnboarding, true);
  assert.equal(page.messages.length, 2, "历史照常能看");

  const refused = /请先在茶话会本体完成认识/;
  await assert.rejects(() => access.dispatch("mobile.turn.send", { agentId: PARTNER, text: "在吗", clientMessageId: "cm_gate_0001" }), refused);
  await assert.rejects(() => access.dispatch("mobile.action.send", { agentId: PARTNER }), refused);
  await assert.rejects(() => access.dispatch("mobile.message.regenerate", { agentId: PARTNER, messageId: made[1].id }), refused);
  assert.equal(store.getThread(PARTNER).messages.length, 2, "被拦的时候账本一个字没加");

  // 已经认识完的伙伴不受影响
  const ready = await boot({ seed: (store) => store.appendMessage(PARTNER, { role: "assistant", text: "在的" }) });
  const readyPage = await ready.access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  assert.equal(readyPage.needsOnboarding, false);
});

test("撤回只看本体门禁，不是「只许撤最近一条」；在看/过期由本体兜底", async () => {
  const made = [];
  const { access, store } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "较早那句" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "中间回复" }));
      made.push(store.appendMessage(PARTNER, { role: "user", text: "最新那句" }));
    },
  });

  // 不是最后一条，但本体说能撤（没被看过）→ 就撤得动
  const older = await access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: made[0].id });
  assert.equal(older.ok, true);
  assert.equal(store.getThread(PARTNER).messages.find((row) => row.id === made[0].id).recalled, true);

  // 被看过且已经过了两分钟：本体回 409，手机不自己放宽
  store.patchMessage(PARTNER, made[2].id, {
    readAt: new Date().toISOString(),
    at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: made[2].id }), /发出去一阵/);

  // 她刚发出去、伙伴正在接：也算不可撤（每行 canRecall 用的就是同一道门禁）
  const sent = await access.dispatch("mobile.turn.send", { agentId: PARTNER, text: "刚发出去的新话", clientMessageId: "cm_gate_0002" });
  await assert.rejects(() => access.dispatch("mobile.message.retract", { agentId: PARTNER, messageId: sent.messageId }), /开始看|已经/);
  const inflightPage = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  assert.equal(inflightPage.messages.find((row) => row.id === sent.messageId).canRecall, false, "正在接的那条不能报可撤");
});

test("并发编辑：带上打开时那句原文，另一端先改过就拒且不改状态", async () => {
  const made = [];
  const { access, store, request } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "问她" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "原来的回复" }));
    },
  });
  await request("PUT", "/settings/global", { json: { messageRefine: true } });

  // 正常：带上当前原文能存
  const ok = await access.dispatch("mobile.message.edit", {
    agentId: PARTNER,
    messageId: made[1].id,
    text: "手机改的",
    expectedText: "原来的回复",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.text, "手机改的");

  // 桌面另一端又改了一次
  const desktop = await request("POST", `/thread/${PARTNER}/refine/${made[1].id}/edit`, { json: { text: "桌面改的" } });
  assert.equal(desktop.status, 200);
  assert.equal(desktop.body.ok, true);

  // 手机还拿旧的原文提交：拒掉，而且桌面那次改稿必须保住
  await assert.rejects(
    () => access.dispatch("mobile.message.edit", {
      agentId: PARTNER,
      messageId: made[1].id,
      text: "手机又改",
      expectedText: "手机改的",
    }),
    /另一端改过/,
  );
  assert.equal(store.getThread(PARTNER).messages.find((row) => row.id === made[1].id).text, "桌面改的", "被拒的那次一个字都没动");

  // 路由层直接验：旧原文同样 409（不靠手机适配层自己比）
  const stale = await request("POST", `/thread/${PARTNER}/refine/${made[1].id}/edit`, { json: { text: "再改", expectedText: "原来的回复" } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error.message, /另一端改过/);
  assert.equal(store.getThread(PARTNER).messages.find((row) => row.id === made[1].id).text, "桌面改的");

  // 不传 expectedText：旧桌面的行为一点没变
  const legacy = await request("POST", `/thread/${PARTNER}/refine/${made[1].id}/edit`, { json: { text: "旧界面改的" } });
  assert.equal(legacy.status, 200);
  assert.equal(store.getThread(PARTNER).messages.find((row) => row.id === made[1].id).text, "旧界面改的");

  // 类型不对直接拒，不进路由
  await assert.rejects(
    () => access.dispatch("mobile.message.edit", { agentId: PARTNER, messageId: made[1].id, text: "x", expectedText: 123 }),
    /原文不对/,
  );
});

test("错误文案脱敏：Windows 单/双反斜线、正斜线、UNC、POSIX 路径都抹掉", () => {
  // 直接从源码取真实实现来跑：以前那条正则只认双反斜线，普通 Error.message 里的
  // C:\secret\file（单反斜线）会整段漏出去，这条用例就是盯它的。
  const safe = loadMobileSafeText();
  const cases = [
    "读不到 C:\\secret\\file.json",
    "读不到 C:\\\\secret\\\\file.json",
    "读不到 C:/secret/file.json",
    "读不到 \\\\server\\share\\file.json",
    "读不到 /Users/me/Library/cache.json",
  ];
  for (const input of cases) {
    const out = safe(input);
    assert.equal(/secret|Users|share/iu.test(out), false, `路径没抹干净：${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.equal(out.includes("…"), true, `该留个省略号：${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  // 普通文本里的斜杠不能误伤
  assert.equal(safe("10/30 那天 and/or 都行"), "10/30 那天 and/or 都行");
  assert.equal(safe(undefined), "");
  assert.ok(safe("长".repeat(500)).length <= 200, "长文案要截短");
});

test("重生成成功：模型真跑一次，替换同一条而不是新增", async () => {
  const made = [];
  const { access, store, models, request } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "问我一句" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "旧的那句" }));
    },
  });
  await request("PUT", "/settings/global", { json: { messageRefine: true } });

  const pending = access.dispatch("mobile.message.regenerate", { agentId: PARTNER, messageId: made[1].id });
  const call = await models.waitForCall(0);
  models.release(call, "重新写的一句");
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.messageId, made[1].id, "替换的是同一条，不是新增");
  const thread = store.getThread(PARTNER);
  assert.equal(thread.messages.filter((row) => row.role === "assistant").length, 1);
  assert.match(thread.messages.find((row) => row.id === made[1].id).text, /重新写的一句/);
  assert.equal(models.calls.length, 1, "只叫了一次模型");
});

test("删除成功：最后一条伙伴回复真的从账本里消失，收藏跟着清", async () => {
  const made = [];
  const { access, store, request } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "问她一句" }));
      made.push(store.appendMessage(PARTNER, { role: "assistant", text: "答了一句" }));
    },
  });
  await request("PUT", "/settings/global", { json: { messageRefine: true } });
  store.saveFavorite({ agentId: PARTNER, partnerName: "小花", messageId: made[1].id, kind: "text", text: "答了一句", at: "2026-10-30T08:00:00.000Z" });

  const removed = await access.dispatch("mobile.message.delete", { agentId: PARTNER, messageId: made[1].id });
  assert.equal(removed.ok, true);
  assert.equal(typeof removed.restoredUnread, "boolean");
  const thread = store.getThread(PARTNER);
  assert.equal(thread.messages.some((row) => row.id === made[1].id), false, "账本里真删了");
  assert.equal(store.listFavorites().some((row) => row.messageId === made[1].id), false, "挂在它上面的收藏一并清掉");
});

test("徽章：手机名单/一页/本体三处说的是同一枚，形状只留看得见的", async () => {
  const { access, request } = await boot({
    seed: (store) => {
      store.appendMessage(PARTNER, { role: "user", text: "晚上好" });
      store.setPartnerSettings(PARTNER, { badge: { type: "custom", title: "夜行猫", description: "晚上才有精神" } });
    },
  });

  const desktop = await request("GET", "/partners");
  const desktopBadge = desktop.body.partners.find((row) => row.id === PARTNER).badge;
  assert.ok(desktopBadge, "本体那边应该有徽章");

  const list = await access.dispatch("mobile.partners.list", {});
  const listed = list.find((row) => row.id === PARTNER).badge;
  const page = await access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });

  assert.deepEqual(listed, pickBadge(desktopBadge), "名单与本体一致");
  assert.deepEqual(page.badge, pickBadge(desktopBadge), "一页与本体一致");
  assert.equal(page.badge.title, "夜行猫");
  assert.deepEqual(Object.keys(page.badge).sort(), ["description", "id", "title", "type"], "只留看得见的字段");
  assert.equal(JSON.stringify(page.badge).includes("updatedAt"), false);
});

test("徽章：睡着给睡眠那枚；一个字没说过的伙伴给 null", async () => {
  const now = new Date();
  const startMin = (now.getHours() * 60 + now.getMinutes() + 24 * 60 - 10) % (24 * 60);
  const start = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
  const sleepy = await boot({
    seed: (store) => {
      store.appendMessage(PARTNER, { role: "user", text: "睡了吗" });
      store.setPartnerSettings(PARTNER, { sleep: { start, hours: 5 } });
    },
  });
  const page = await sleepy.access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  assert.equal(page.badge?.id, "sleeping", `这会儿应该在睡（start=${start}）`);
  const desktop = await sleepy.request("GET", "/partners");
  assert.deepEqual(page.badge, pickBadge(desktop.body.partners.find((row) => row.id === PARTNER).badge));

  const empty = await boot();
  const emptyPage = await empty.access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  assert.equal(emptyPage.badge, null, "没有历史就不冒充状态");
  const emptyList = await empty.access.dispatch("mobile.partners.list", {});
  assert.equal(emptyList.find((row) => row.id === PARTNER).badge, null);
});

test("徽章进指纹：换一枚就换指纹，读徽章不写任何状态", async () => {
  const plain = await boot({ seed: (store) => store.appendMessage(PARTNER, { role: "user", text: "在吗" }) });
  const custom = await boot({
    seed: (store) => {
      store.appendMessage(PARTNER, { role: "user", text: "在吗" });
      store.setPartnerSettings(PARTNER, { badge: { type: "custom", title: "夜行猫", description: "晚上才有精神" } });
    },
  });
  await plain.access.refreshWatched();
  await custom.access.refreshWatched();
  assert.notEqual(custom.access.signatureNow(), plain.access.signatureNow(), "只差徽章也要换指纹");

  // 同一个实例里：先读一次把「今日皮肤」这类惰性落盘的东西定下来，
  // 再看接着读名单/一页时指纹不动（徽章/phone/关系都没被写）
  await custom.access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  const before = custom.access.signatureNow();
  await custom.access.dispatch("mobile.partners.list", {});
  const page = await custom.access.dispatch("mobile.thread.get", { agentId: PARTNER, limit: 10 });
  assert.equal(custom.access.signatureNow(), before, "读徽章不能改指纹");

  // 手机那边拿到的徽章里没有内部字段（awaiting/phone/sleep/updatedAt 一概不带）
  const serialized = JSON.stringify(page.badge);
  for (const key of ["awaiting", "phone", "sleep", "holding", "updatedAt"]) {
    assert.equal(serialized.includes(key), false, `不该带 ${key}`);
  }
});

test("管理面三条不在手机 op 白名单里", async () => {
  const { access } = await boot();
  for (const op of ["mobile.status", "mobile.config", "mobile.password"]) {
    await assert.rejects(() => access.dispatch(op, {}), /unknown op/, `${op} 不该被手机叫到`);
  }
  await assert.rejects(() => access.dispatch("mobile.not.a.thing", {}), /unknown op/);
});

test("探测比的是内容不是末条 id：改稿、撤回、语音、已读、删除、设置全都算变了", async () => {
  const made = [];
  const { access, store, request, dataDir } = await boot({
    seed: (store) => {
      made.push(store.appendMessage(PARTNER, { role: "user", text: "原话", clientMessageId: "cm_seed_0002" }));
    },
  });
  await access.refreshWatched();
  assert.ok(access.watched.includes(PARTNER), "当前伙伴应该在探测名单里");

  const base = access.signatureNow();
  assert.equal(access.signatureNow(), base, "什么都没动时指纹要稳");

  store.patchMessage(PARTNER, made[0].id, { text: "改了个字" });
  const edited = access.signatureNow();
  assert.notEqual(edited, base, "改稿要换指纹（消息 id 没变）");

  store.patchMessage(PARTNER, made[0].id, { recalled: true, recallMode: "hard", kind: "recalled" });
  const recalled = access.signatureNow();
  assert.notEqual(recalled, edited, "撤回要换指纹");

  store.patchMessage(PARTNER, made[0].id, { voice: { status: "ready", format: "mp3", playedAt: null, durationMs: 900 } });
  const voiced = access.signatureNow();
  assert.notEqual(voiced, recalled, "语音状态要换指纹");

  store.patchMessage(PARTNER, made[0].id, { voice: { status: "ready", format: "mp3", playedAt: "2026-10-30T09:00:00.000Z", durationMs: 900 } });
  const listened = access.signatureNow();
  assert.notEqual(listened, voiced, "已听要换指纹");

  const beforeSettings = access.signatureNow();
  // 设置得走路由改：页面和探测看的是 App 自己那份 store，测试里那个实例只是同一个目录的另一个影子。
  const saved = await request("PUT", "/settings/global", { json: { messageAvatars: true } });
  assert.equal(saved.body.ok, true, "设置要真能存进去");
  assert.notEqual(access.signatureNow(), beforeSettings, "显示设置要换指纹");

  // 同一毫秒里改字：updatedAt 可能一模一样，光靠时间戳不算，得靠内容指纹
  const threadDir = path.join(dataDir, "v2", "threads");
  const threadFile = path.join(threadDir, fs.readdirSync(threadDir).find((name) => name.endsWith(".json")));
  const frozen = JSON.parse(fs.readFileSync(threadFile, "utf8"));
  const stamp = frozen.updatedAt;
  assert.ok(stamp, "账本上得有个 updatedAt");
  const beforeSameStamp = access.signatureNow();
  frozen.messages[frozen.messages.length - 1].text = "更新的一样但字不一样";
  fs.writeFileSync(threadFile, JSON.stringify(frozen, null, 2), "utf8");
  assert.equal(JSON.parse(fs.readFileSync(threadFile, "utf8")).updatedAt, stamp, "这条用例就是要让 stamp 一模一样");
  assert.notEqual(access.signatureNow(), beforeSameStamp, "时间戳没变、文字变了，也得算变了");

  const beforeDelete = access.signatureNow();
  store.removeMessage(PARTNER, made[0].id);
  assert.notEqual(access.signatureNow(), beforeDelete, "消息被删要换指纹");
});
