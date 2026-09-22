import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/store.js";
import { applyPersonalityPreset, hasPersonality } from "../lib/knowing.js";
import { createRelationship } from "../lib/relationship.js";
import { applyStickerPolicy, resolveStickerPolicy } from "../lib/stickers.js";
import { canonicalGuide } from "./helpers/adaptation.js";

const storeSource = fs.readFileSync(new URL("../lib/store.js", import.meta.url), "utf8");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chahuahui-store-"));
  return { store: createStore(dir), dir };
}

test("旧档位 id 存的音色会跟到迁移后的朗读模型条目上", () => {
  const { store } = freshStore();
  store.setPartnerSettings("hanako", { voice: { enabled: true, voiceId: "female-shaonv", voiceByProfile: { minimax: "Chinese (Mandarin)_Warm_Girl" } } });
  assert.equal(store.getPartnerSettings("hanako").voice.voiceByProfile["custom-minimax"], "Chinese (Mandarin)_Warm_Girl");
  // 新键已经有值时不跟着旧键走
  store.setPartnerSettings("mimo-fan", { voice: { enabled: true, voiceByProfile: { "custom-minimax": "Chinese (Mandarin)_Soft_Girl", minimax: "Chinese (Mandarin)_Warm_Girl" } } });
  assert.equal(store.getPartnerSettings("mimo-fan").voice.voiceByProfile["custom-minimax"], "Chinese (Mandarin)_Soft_Girl");
});

test("茶话会本地角色只存自己的账本，重开仍能读到", () => {
  const { store, dir } = freshStore();
  const partner = store.createLocalPartner({ name: "小院里的猫", description: "只在茶话会里出现的角色" });
  assert.equal(partner.isLocal, true);
  assert.equal(store.listLocalPartners()[0].name, "小院里的猫");
  const reopened = createStore(dir);
  assert.equal(reopened.localPartner(partner.id).description, "只在茶话会里出现的角色");
});

test("追加消息能读回来，且带 id 和时间", () => {
  const { store } = freshStore();
  const entry = store.appendMessage("nova", { role: "user", text: "在吗" });
  assert.match(entry.id, /^m_/);
  assert.ok(entry.at);
  const thread = store.getThread("nova");
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "在吗");
});

test("生活记录可以单条删除，不影响其他记录", () => {
  const { store } = freshStore();
  store.appendWorkEvent({ id: "keep", agentId: "nova", lifeDay: "2026-09-20", at: "2026-09-20T10:00:00.000Z", role: "user", text: "保留" });
  store.appendWorkEvent({ id: "drop", agentId: "nova", lifeDay: "2026-09-20", at: "2026-09-20T10:01:00.000Z", role: "assistant", text: "删除" });
  assert.equal(store.removeWorkEvent("drop").events.map((row) => row.id).join(","), "keep");
  assert.equal(store.removeWorkEvent("missing").events.map((row) => row.id).join(","), "keep");
});

test("撤回未读消息会从聊天流移除，且不会误删其他消息", () => {
  const { store } = freshStore();
  const first = store.appendMessage("nova", { role: "user", text: "打错了" });
  const second = store.appendMessage("nova", { role: "user", text: "这句保留" });
  const removed = store.removeMessage("nova", first.id);
  assert.equal(removed.text, "打错了");
  assert.deepEqual(store.getThread("nova").messages.map((row) => row.id), [second.id]);
});

test("清聊天不清记忆", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "user", text: "在吗" });
  store.upsertLedger("nova", "2026-09-12", "聊了两句");
  store.clearThread("nova");
  assert.equal(store.getThread("nova").messages.length, 0);
  assert.equal(store.readMemory("nova").ledger.length, 1);
});

test("重要事实带来源和时间落盘，重复事实不重复写", () => {
  const { store, dir } = freshStore();
  store.appendMessage("nova", { id: "m1", role: "user", text: "我喜欢像素艺术", at: "2026-09-16T10:00:00.000Z" });
  const fact = { fact: "喜欢像素艺术", kind: "interest", source: "m1", at: "2026-09-16T10:00:00.000Z" };
  store.appendFacts("nova", [fact, { ...fact, fact: "喜欢像素艺术！" }]);
  const reopened = createStore(dir);
  const facts = reopened.readMemory("nova").facts;
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, "m1");
  assert.equal(facts[0].at, "2026-09-16T10:00:00.000Z");
});

test("待回复排期落盘，重开账本仍能恢复", () => {
  const { store, dir } = freshStore();
  const pending = { dueAt: "2026-09-15T02:00:00.000Z", mode: "away" };
  store.setPendingReply("nova", pending);
  const reopened = createStore(dir);
  assert.deepEqual(reopened.getPendingReply("nova"), pending);
  reopened.clearPendingReply("nova");
  assert.equal(reopened.getPendingReply("nova"), null);
});

test("待回复可以按消息归属幂等清除，不会误清新回合", () => {
  const { store } = freshStore();
  store.setPendingReply("nova", { dueAt: "2026-09-16T10:00:00.000Z", messageId: "m1" });
  assert.equal(store.clearPendingReplyIf("nova", "m2"), false);
  assert.ok(store.getPendingReply("nova"));
  assert.equal(store.clearPendingReplyIf("nova", "m1"), true);
  assert.equal(store.getPendingReply("nova"), null);
});

test("未读只数伙伴发的，她读一次就归零", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "user", text: "在吗" });
  assert.equal(store.unreadCount("nova"), 0);
  store.appendMessage("nova", { role: "assistant", text: "在呢" });
  store.appendMessage("nova", { role: "assistant", text: "咋啦" });
  assert.equal(store.unreadCount("nova"), 2);
  store.markRead("nova");
  assert.equal(store.unreadCount("nova"), 0);
});

test("读完之后新来的又算未读", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "assistant", text: "第一条" });
  store.markRead("nova");
  store.appendMessage("nova", { role: "assistant", text: "第二条" });
  assert.equal(store.unreadCount("nova"), 1);
});

test("已读水位可以由前端指定，而且只往前挪", () => {
  const { store } = freshStore();
  const a1 = store.appendMessage("nova", { role: "assistant", text: "第一条" });
  const a2 = store.appendMessage("nova", { role: "assistant", text: "第二条" });
  const a3 = store.appendMessage("nova", { role: "assistant", text: "第三条" });

  // 她只看到第二条：水位就停在第二条，第三条仍算未读
  const first = store.markRead("nova", { throughId: a2.id, at: "2026-09-19T02:00:00.000Z" });
  assert.equal(first.changed, true);
  assert.equal(store.getThread("nova").readThroughId, a2.id);
  assert.equal(store.getThread("nova").readThroughAt, "2026-09-19T02:00:00.000Z", "读到哪儿的时间和位置一起落盘");
  assert.equal(store.unreadCount("nova"), 1, "第三条她还没看到");

  // 迟到的旧回包上报更早的水位，不能把已读往回拖
  const stale = store.markRead("nova", { throughId: a1.id, at: "2026-09-19T01:00:00.000Z" });
  assert.equal(stale.changed, false);
  assert.equal(store.getThread("nova").readThroughId, a2.id);
  assert.equal(store.getThread("nova").readThroughAt, "2026-09-19T02:00:00.000Z");

  // 往后挪才作数
  const later = store.markRead("nova", { throughId: a3.id, at: "2026-09-19T03:00:00.000Z" });
  assert.equal(later.changed, true);
  assert.equal(store.unreadCount("nova"), 0);
});

test("认不出来的水位不写账，空聊天也不出错", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "assistant", text: "第一条" });
  // 前端报了一条这个窗里不存在的 id：不能顺手把水位推到最后一条
  const bogus = store.markRead("nova", { throughId: "m_不存在" });
  assert.equal(bogus.changed, false);
  assert.equal(store.unreadCount("nova"), 1);

  const { store: empty } = freshStore();
  const none = empty.markRead("nova");
  assert.equal(none.changed, false);
  assert.equal(none.readThroughId, null);
  assert.equal(none.readThroughAt, null);
});

test("撤回她正读到的那条时，水位和读到的时间一起回退", () => {
  const { store } = freshStore();
  store.appendMessage("nova", { role: "assistant", text: "第一条" });
  const second = store.appendMessage("nova", { role: "assistant", text: "第二条" });
  store.markRead("nova", { throughId: second.id, at: "2026-09-19T02:00:00.000Z" });
  store.removeMessage("nova", second.id);
  const thread = store.getThread("nova");
  assert.notEqual(thread.readThroughId, second.id);
  assert.equal(thread.readThroughAt, null, "读到的那条没了，时间也别留着当凭据");
});

test("压过的消息不再进待压队列", () => {
  const { store } = freshStore();
  const a = store.appendMessage("nova", { role: "user", text: "1" });
  store.appendMessage("nova", { role: "assistant", text: "2" });
  const c = store.appendMessage("nova", { role: "user", text: "3" });
  assert.equal(store.pendingMessages("nova").length, 3);
  store.markRolledThrough("nova", a.id);
  assert.equal(store.pendingMessages("nova").length, 2);
  assert.equal(store.pendingMessages("nova")[0].id !== a.id, true);
  store.markRolledThrough("nova", c.id);
  assert.equal(store.pendingMessages("nova").length, 0);
});

test("聊天超过 500 条后，滚动水位仍按序号过滤，不重复整理旧消息", () => {
  const { store } = freshStore();
  const rows = Array.from({ length: 120 }, (_, i) => store.appendMessage("nova", { role: i % 2 ? "assistant" : "user", text: String(i) }));
  store.markRolledThrough("nova", rows[100].id);
  for (let i = 120; i < 620; i += 1) {
    store.appendMessage("nova", { role: i % 2 ? "assistant" : "user", text: String(i) });
  }
  const pending = store.pendingMessages("nova");
  assert.equal(store.getThread("nova").messages.length, 500);
  assert.ok(pending.every((row) => row.seq > rows[100].seq));
  assert.equal(pending[0].text, "120");
});

test("同一个摘要批次重复提交只保留一份", () => {
  const { store } = freshStore();
  const entry = { id: "a_m1_m2", text: "同一批" };
  store.appendArchive("nova", entry);
  store.appendArchive("nova", entry);
  assert.equal(store.readMemory("nova").archive.length, 1);
});

test("同一天的日账是覆盖，不是追加", () => {
  const { store } = freshStore();
  store.upsertLedger("nova", "2026-09-12", "第一版");
  store.upsertLedger("nova", "2026-09-12", "重写过的版本");
  store.upsertLedger("nova", "2026-09-11", "前一天");
  const ledger = store.readMemory("nova").ledger;
  assert.equal(ledger.length, 2);
  assert.equal(ledger.find((r) => r.day === "2026-09-12").text, "重写过的版本");
  assert.deepEqual(ledger.map((r) => r.day), ["2026-09-11", "2026-09-12"]);
});

test("日账可以单天删掉（她手动修正的一种）", () => {
  const { store } = freshStore();
  store.upsertLedger("nova", "2026-09-12", "记错了");
  store.removeLedger("nova", "2026-09-12");
  assert.equal(store.readMemory("nova").ledger.length, 0);
});

test("关系档案可写可读，带更新时间", () => {
  const { store } = freshStore();
  store.setProfile("nova", "她叫我阿凉，喜欢薄荷绿。");
  const profile = store.readMemory("nova").profile;
  assert.equal(profile.text, "她叫我阿凉，喜欢薄荷绿。");
  assert.ok(profile.updatedAt);
});

test("档案候选和来源分开落盘，成功写入会清掉隔离候选", () => {
  const { store } = freshStore();
  store.quarantineProfile("carol", "我叫小花。", "identity-mismatch", {
    partnerName: "小七",
    recentMessageCount: 2,
  });
  let profile = store.readMemory("carol").profile;
  assert.equal(profile.text, "");
  assert.deepEqual(profile.quarantine, {
    text: "我叫小花。",
    reason: "identity-mismatch",
    at: profile.quarantine.at,
    partnerName: "小七",
    recentMessageCount: 2,
  });
  store.setProfile("carol", "她叫我小花。", new Date("2026-09-16T00:00:00.000Z"), {
    kind: "profile-refresh",
    partnerName: "小七",
    recentMessageCount: 2,
  });
  profile = store.readMemory("carol").profile;
  assert.equal(profile.quarantine, null);
  assert.deepEqual(profile.source, {
    kind: "profile-refresh",
    partnerName: "小七",
    recentMessageCount: 2,
  });
});

test("摘要段数有上限，超出丢最老的（长尾交给关系档案）", () => {
  const { store } = freshStore();
  for (let i = 0; i < 20; i += 1) {
    store.appendArchive("nova", { id: `a${i}`, text: `第${i}段` });
  }
  const archive = store.readMemory("nova").archive;
  assert.equal(archive.length, 12);
  assert.equal(archive[0].text, "第8段");
});

test("每位伙伴的设置互不干扰，且有默认值", () => {
  const { store } = freshStore();
  assert.equal(store.getPartnerSettings("hanako").tier, "sometimes");
  assert.equal(store.getPartnerSettings("hanako").proactiveEnabled, true);
  assert.equal(store.getPartnerSettings("hanako").sleep, null, "作息没定过就是 null，不由她设");
  store.setPartnerSettings("hanako", { tier: "clingy" });
  assert.equal(store.getPartnerSettings("hanako").tier, "clingy");
  assert.equal(store.getPartnerSettings("erin").tier, "sometimes");
});

test("伙伴的设置里能存ta自己写的戳文案和作息", () => {
  const { store } = freshStore();
  store.setPartnerSettings("erin", {
    pokeTemplate: "{name}戳了戳我的帽檐，帽檐歪了。",
    sleep: { start: "01:00", end: "09:00", why: "夜里才清醒", source: "partner" },
  });
  const settings = store.getPartnerSettings("erin");
  assert.match(settings.pokeTemplate, /帽檐/);
  assert.equal(settings.sleep.end, "09:00");
  assert.equal(settings.sleep.source, "partner");
});

test("全局设置有默认的静默时段和总闸", () => {
  const { store } = freshStore();
  const settings = store.getGlobalSettings();
  assert.equal(settings.quiet.start, "23:00");
  assert.ok(settings.globalGate.minGapMinutes > 0);
  store.setGlobalSettings({ quiet: { start: "22:30", end: "07:30" } });
  assert.equal(store.getGlobalSettings().quiet.start, "22:30");
});

test("认识伙伴用哪条模型：设了记得住，不设就跟默认", () => {
  const { store, dir } = freshStore();
  assert.equal(store.getGlobalSettings().recognitionModel, null);
  store.setGlobalSettings({ recognitionModel: { provider: "openai-codex", model: "gpt-5.6-luna" } });
  assert.deepEqual(store.getGlobalSettings().recognitionModel, { provider: "openai-codex", model: "gpt-5.6-luna" });
  assert.deepEqual(
    createStore(dir).getGlobalSettings().recognitionModel,
    { provider: "openai-codex", model: "gpt-5.6-luna" },
    "重启也不丢",
  );
  store.setGlobalSettings({ recognitionModel: { provider: "", model: "" } });
  assert.equal(store.getGlobalSettings().recognitionModel, null, "形状不对就当没设过");
});

test("茶话会用户名称覆盖：有值就用，清空就回到跟随 Hana", () => {
  const { store } = freshStore();
  assert.equal(store.getGlobalSettings().userNameOverride, null);
  store.setGlobalSettings({ userNameOverride: "  小禾  " });
  assert.equal(store.getGlobalSettings().userNameOverride, "小禾");
  store.setGlobalSettings({ userNameOverride: "" });
  assert.equal(store.getGlobalSettings().userNameOverride, null);
});

test("聊天窗头像开关默认是关的，开了之后记得住（重启也不丢）", () => {
  const { store, dir } = freshStore();
  assert.equal(store.getGlobalSettings().messageAvatars, false);
  store.setGlobalSettings({ messageAvatars: true });
  assert.equal(store.getGlobalSettings().messageAvatars, true);

  const again = createStore(dir);
  assert.equal(again.getGlobalSettings().messageAvatars, true);
});

test("移出伙伴只隐藏清单，聊天、记忆和设置都保留；放回后重启也记得", () => {
  const { store, dir } = freshStore();
  store.appendMessage("probe", { role: "assistant", text: "别把这句弄丢" });
  store.upsertLedger("probe", "2026-09-12", "聊过一天");
  store.setPartnerSettings("probe", { tier: "rare" });

  assert.deepEqual(store.hidePartner("probe"), ["probe"]);
  assert.deepEqual(store.hidePartner("probe"), ["probe"], "重复移出不产生重复项");
  assert.equal(store.isPartnerHidden("probe"), true);
  assert.equal(store.getThread("probe").messages.length, 1);
  assert.equal(store.readMemory("probe").ledger.length, 1);
  assert.equal(store.getPartnerSettings("probe").tier, "rare");

  const hiddenAfterRestart = createStore(dir);
  assert.equal(hiddenAfterRestart.isPartnerHidden("probe"), true);
  assert.deepEqual(hiddenAfterRestart.unhidePartner("probe"), []);
  assert.deepEqual(hiddenAfterRestart.unhidePartner("probe"), [], "重复放回不报错");
  assert.equal(createStore(dir).isPartnerHidden("probe"), false);
});

test("重开一次 store，之前写的东西还在（重启不丢）", () => {
  const { store, dir } = freshStore();
  store.appendMessage("nova", { role: "assistant", text: "在呢" });
  store.upsertLedger("nova", "2026-09-12", "聊了两句");
  store.setPartnerSettings("nova", { tier: "rare" });
  store.setGlobalSettings({ myPokeTemplate: "{name}戳了戳我的肚皮" });

  const again = createStore(dir);
  assert.equal(again.getThread("nova").messages.length, 1);
  assert.equal(again.readMemory("nova").ledger.length, 1);
  assert.equal(again.getPartnerSettings("nova").tier, "rare");
  assert.match(again.getGlobalSettings().myPokeTemplate, /肚皮/);
});

test("主动那层的运行状态跟设置一起过关：重启不重掷、也不丢暂存的话", () => {
  const { store, dir } = freshStore();
  store.setProactiveState("nova", {
    nextDueAt: "2026-09-15T12:00:00.000Z",
    lastSentAt: "2026-09-15T10:00:00.000Z",
    sentToday: { day: "2026-09-15", count: 3 },
    staged: [{ topicId: "tp_1", at: "2026-09-15T11:00:00.000Z" }],
  });
  store.setGlobalRuntime({ lastAnySentAt: "2026-09-15T11:00:00.000Z", sentToday: { day: "2026-09-15", count: 5 } });

  // 重启后先改一个别的东西，再重启一次
  const again = createStore(dir);
  again.setPartnerSettings("nova", { tier: "often" });

  const third = createStore(dir);
  const state = third.getProactiveState("nova");
  assert.equal(state.nextDueAt, "2026-09-15T12:00:00.000Z", "到点时间不被重掷");
  assert.equal(state.sentToday.count, 3, "今天说过几条还在");
  assert.equal(state.staged.length, 1, "想找你说的那句还在");
  assert.equal(third.getGlobalRuntime().sentToday.count, 5, "全局那本也跟着过关");
});

test("伙伴 id 里有奇怪字符直接拒绝，不会生成替代账本", () => {
  const { store } = freshStore();
  assert.throws(() => store.appendMessage("../../evil", { role: "user", text: "x" }), { code: "INVALID_PARTNER_ID" });

});

test("关系适应账独立于 knowing，重启后仍保留并隔离伙伴", () => {
  const { store, dir } = freshStore();
  const guide = {
    id: "g-voice",
    meaning: "我喜欢你多发一点语音",
    kind: "preference",
    scope: "relationship",
    duration: "persistent",
    origin: "explicit",
    sourceMessageIds: ["m-pref"],
    claims: [{ target: "voice.frequency", effect: "prefer", value: "more" }],
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  const firstSaved = store.savePartnerAdaptation("nova", { guides: [guide], exceptions: [{ id: "ex-1", behavior: "voice.frequency", resultMessageId: "m-reply" }], migration: { factsV1CompletedAt: "2026-09-22T12:00:00.000Z", sourceIds: ["m-pref"] } });
  const secondSaved = store.updatePartnerAdaptation("nova", (book) => book);
  store.saveUserAdaptation({ guides: [{ ...guide, id: "g-wide", scope: "user-wide" }] });
  const reopened = createStore(dir);
  assert.equal(firstSaved.revision, 1);
  assert.equal(secondSaved.revision, 2, "每次关系账写入都要推进 revision，旧建议才能被识别");
  assert.equal(reopened.getPartnerAdaptation("nova").guides[0].id, "g-voice");
  assert.equal(reopened.getPartnerAdaptation("nova").migration.factsV1CompletedAt, "2026-09-22T12:00:00.000Z");
  assert.deepEqual(reopened.getPartnerAdaptation("nova").migration.sourceIds, ["m-pref"]);
  assert.equal(reopened.getUserAdaptation().guides[0].scope, "user-wide");
  assert.equal(reopened.getPartnerAdaptation("other").guides.length, 0);
  assert.equal(reopened.getKnowing("nova").relationship.familiarity.turns, 0);
});

test("伙伴目录枚举失败时保留 user-wide 恢复账，不能把扫描失败冒充零伙伴", () => {
  assert.match(storeSource, /catch \{ return null; \}[\s\S]*?if \(!partnerIds\) return false;/);
});

test("user-wide guide 忘掉或被取代时，会回退所有伙伴账本里的派生 habit", () => {
  const { store } = freshStore();
  const guide = {
    id: "g-wide",
    meaning: "所有伙伴都先给建议",
    kind: "preference",
    scope: "user-wide",
    duration: "persistent",
    origin: "explicit",
    sourceMessageIds: ["m-wide"],
    claims: [{ target: "reply.advice-style", effect: "prefer", value: "advice-first" }],
    status: "active",
    createdAt: "2026-09-20T00:00:00.000Z",
  };
  store.saveUserAdaptation({ guides: [guide] });
  for (const agentId of ["nova", "luna"]) {
    store.savePartnerAdaptation(agentId, {
      exceptions: [{ id: `ex-${agentId}`, behavior: "reply.advice-style", guideIds: ["g-wide"], outcome: "committed" }],
      habitChanges: [{ key: "reply.advice-style", guideIds: ["g-wide"], state: "settled" }],
    });
  }
  store.savePartnerAdaptation("terra", {
    guides: [{ ...guide, scope: "relationship" }],
    exceptions: [{ id: "ex-terra", behavior: "reply.advice-style", guideIds: ["g-wide"], outcome: "committed" }],
    habitChanges: [{ key: "reply.advice-style", guideIds: ["g-wide"], state: "settled" }],
  });
  const repaired = store.saveUserAdaptation({ guides: [{ ...guide, status: "revoked", revokedAt: "2026-09-22T12:00:00.000Z" }], pendingInvalidationGuideIds: ["g-wide"] });
  assert.deepEqual(repaired.pendingInvalidationGuideIds, [], "跨账本回退完成后才清恢复账；若中断，下次启动会重试");
  for (const agentId of ["nova", "luna"]) {
    const book = store.getPartnerAdaptation(agentId);
    assert.equal(book.exceptions[0].sourceGuideRevoked, true);
    assert.equal(book.habitChanges[0].state, "reverted");
  }
  assert.equal(store.getPartnerAdaptation("terra").habitChanges[0].state, "settled", "极旧数据跨 scope 撞 ID 时不能误伤仍 active 的伙伴级 guide");
});

test("统一 exception 入口按稳定 id 幂等提交，近同时写入不同破例不会互相覆盖", () => {
  const { store } = freshStore();
  store.commitException("nova", { id: "voice.frequency|m-v", behavior: "voice.frequency", resultMessageId: "m-v", outcome: "committed" });
  store.commitException("nova", { id: "sticker.permission|m-s", behavior: "sticker.permission", resultMessageId: "m-s", outcome: "committed" });
  store.commitException("nova", { id: "voice.frequency|m-v", behavior: "voice.frequency", resultMessageId: "m-v", description: "补齐描述", outcome: "committed" });
  const rows = store.getPartnerAdaptation("nova").exceptions;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === "voice.frequency|m-v").description, "补齐描述");
  const finalized = store.finalizeException("nova", "sticker.permission|m-s", { consolidated: true });
  assert.equal(finalized.exceptions.find((row) => row.id === "sticker.permission|m-s").consolidated, true);
});

test("表情包 stable subject 经 store 往返后仍能进入正式策略过滤", () => {
  const { store } = freshStore();
  store.savePartnerAdaptation("nova", {
    guides: [canonicalGuide({
      id: "allow-one-sticker",
      meaning: "这张可以用",
      kind: "permission",
      claims: [{ target: "sticker.permission", effect: "allow", value: "specific", subject: "source:stk-2" }],
    })],
  });
  const policy = resolveStickerPolicy({ guides: store.getPartnerAdaptation("nova").guides });
  const catalog = {
    stickers: [{ id: "stk-1" }, { id: "stk-2" }],
    byId: new Map([["stk-1", { id: "stk-1" }], ["stk-2", { id: "stk-2" }]]),
    preferred: new Set(["stk-1", "stk-2"]),
  };
  assert.deepEqual(applyStickerPolicy(catalog, policy).stickers.map((row) => row.id), ["stk-2"]);
});

test("关系适应账撤回来源会同时撤伙伴级与 user-wide guide，并回退引用习惯", () => {
  const { store } = freshStore();
  const book = {
    guides: [{ id: "g-1", meaning: "先陪我", origin: "explicit", sourceMessageIds: ["m-1"] }],
    exceptions: [{ id: "ex-1", behavior: "reply.advice-style", outcome: "committed", guideIds: ["g-1"], committedAt: "2026-09-22T00:30:00.000Z", lifeDay: "2026-09-22" }],
    feedbackEvents: [{ id: "fb-1", exceptionId: "ex-1", type: "explicit-like", polarity: "positive", sourceMessageId: "m-1", lifeDay: "2026-09-22", at: "2026-09-22T00:35:00.000Z" }],
    habitChanges: [{ key: "reply.advice-style", description: "先陪再分析", state: "emerging", guideIds: ["g-1"] }],
  };
  store.savePartnerAdaptation("nova", book);
  store.saveUserAdaptation({
    ...book,
    guides: [{ ...book.guides[0], id: "g-wide", scope: "user-wide" }],
    habitChanges: [{ ...book.habitChanges[0], guideIds: ["g-wide"] }],
  });
  const at = new Date("2026-09-22T08:35:00+08:00");
  const next = store.revokePartnerGuidesBySource("nova", "m-1", at);
  const wide = store.revokeUserGuidesBySource("m-1", at);
  assert.equal(next.guides[0].status, "revoked");
  assert.equal(next.habitChanges[0].state, "reverted");
  assert.equal(next.exceptions[0].sourceGuideRevoked, true);
  assert.equal(next.feedbackEvents.length, 0);
  assert.equal(wide.guides[0].status, "revoked");
  assert.equal(wide.habitChanges[0].state, "reverted");
});

test("关系账、性格和爱好各存一本，重启还在", () => {
  const { store, dir } = freshStore();
  const fresh = store.getKnowing("nova");
  assert.equal(fresh.relationship.familiarity.turns, 0);
  assert.equal(fresh.relationship.stage, 0);
  assert.deepEqual(fresh.hobbies, []);
  assert.equal(hasPersonality(fresh.personality), false);

  store.saveKnowing("nova", {
    relationship: {
      ...fresh.relationship,
      familiarity: { ...fresh.relationship.familiarity, turns: 7, activeDays: 3 },
    },
    personality: applyPersonalityPreset("quiet"),
    hobbies: [{ name: "拼图", reason: "喜欢慢慢来", origin: "born" }],
  });

  const again = createStore(dir).getKnowing("nova");
  assert.equal(again.relationship.familiarity.turns, 7);
  assert.equal(again.relationship.familiarity.activeDays, 3);
  assert.deepEqual(again.personality.surface.tags, ["安静"]);
  assert.equal(again.hobbies.length, 1);
  assert.equal(again.hobbies[0].origin, "born");
});

test("自动那份和ta的来历各自存一份，没存过就是 null", () => {
  const { store, dir } = freshStore();
  const fresh = store.getKnowing("nova");
  assert.equal(fresh.personalityAuto, null, "没判过就是空，不是一份空性格");
  assert.equal(fresh.personalityFrom, null, "来历不详就不编");

  const auto = applyPersonalityPreset("gentle");
  store.saveKnowing("nova", { ...fresh, personality: auto, personalityAuto: auto, personalityFrom: "auto" });
  const mine = { ...applyPersonalityPreset("lively"), updatedAt: auto.updatedAt };
  store.saveKnowing("nova", { ...store.getKnowing("nova"), personality: mine, personalityFrom: "user" });

  const again = createStore(dir).getKnowing("nova");
  assert.deepEqual(again.personality.surface.tags, ["俏皮"], "现在用的是她调的那份");
  assert.deepEqual(again.personalityAuto.surface.tags, ["温柔"], "自动那份原样放着，没被盖掉");
  assert.equal(again.personalityFrom, "user");
});

test("起跑线单独躺一格，跟账本分开", () => {
  const { store, dir } = freshStore();
  assert.equal(store.getKnowing("nova").relationSeed, null, "没量过就是空");

  const seed = { turns: 80, activeDays: 30, label: "很熟了", trace: 22983, source: "auto", measuredAt: "2026-09-12T00:00:00.000Z" };
  const fresh = store.getKnowing("nova");
  store.saveKnowing("nova", { ...fresh, relationSeed: seed });

  const again = createStore(dir).getKnowing("nova");
  assert.equal(again.relationSeed.turns, 80);
  assert.equal(again.relationSeed.source, "auto");
  assert.equal(again.relationship.familiarity.turns, 0, "账本还是零：起跑线不算她聊过的");

  // 撤掉起跑线：账本不受影响
  store.saveKnowing("nova", { ...store.getKnowing("nova"), relationSeed: null });
  assert.equal(createStore(dir).getKnowing("nova").relationSeed, null);
});

test("knowing 文件坏了就当没调过，不炸", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "v2", "partners", "nova", "knowing.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{不是 json", "utf8");
  const knowing = store.getKnowing("nova");
  assert.equal(knowing.relationship.familiarity.turns, 0);
  assert.deepEqual(knowing.hobbies, []);
});

test("清聊天不清这一层账", () => {
  const { store } = freshStore();
  store.saveKnowing("nova", {
    relationship: createRelationship(),
    personality: applyPersonalityPreset("clear"),
    hobbies: [],
  });
  store.clearThread("nova");
  assert.deepEqual(store.getKnowing("nova").personality.surface.tags, ["清醒"]);
});

test("ta看到她的话要盖个 readAt：刷新还在，没看到就是没看到", () => {
  const { store } = freshStore();
  const one = store.appendMessage("nova", { role: "user", text: "在吗" });
  store.appendMessage("nova", { role: "assistant", text: "在呢" });
  const two = store.appendMessage("nova", { role: "user", text: "刚才那事" });
  store.appendMessage("nova", { role: "user", text: "还在吗" });

  assert.equal(store.getThread("nova").messages.every((m) => !m.readAt), true, "刚发出去都还是未读");

  const at = "2026-09-13T01:00:00.000Z";
  assert.deepEqual(store.markUserMessagesRead("nova", at).length, 3, "三条她的话都算看到过了");
  assert.deepEqual(store.markUserMessagesRead("nova", at), [], "再盖一遍不该重复计");

  const thread = store.getThread("nova");
  for (const row of thread.messages.filter((m) => m.role === "user")) assert.equal(row.readAt, at);
  for (const row of thread.messages.filter((m) => m.role === "assistant")) {
    assert.equal(row.readAt, undefined, "她读ta的话是另一本账（readThroughId），别混");
  }
  assert.equal(thread.messages.find((m) => m.id === one.id).readAt, at);
  assert.equal(thread.messages.find((m) => m.id === two.id).readAt, at);
});

test("今日情境默认关：没打开就不往提示词里塞拾光记的日子", () => {
  const { store, dir } = freshStore();
  assert.equal(store.getGlobalSettings().daybookEnabled, false);
  store.setGlobalSettings({ daybookEnabled: true });
  assert.equal(store.getGlobalSettings().daybookEnabled, true);
  assert.equal(createStore(dir).getGlobalSettings().daybookEnabled, true);
});

test("今日情境从关到开：清掉「今天露过」的记账，打开就能看到效果", () => {
  const { store } = freshStore();
  store.setPartnerSettings("nova", { daybook: { lifeDay: "2026-09-19", hash: "abc" } });
  assert.ok(store.getPartnerSettings("nova").daybook);
  store.clearDaybookMarks();
  assert.equal(store.getPartnerSettings("nova").daybook, null);
});
