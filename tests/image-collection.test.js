import test from "node:test";
import assert from "node:assert/strict";
import {
  availableAttachmentMetas,
  detectGiftIntent,
  findGiftTarget,
  formatOldImageCandidates,
  formatOldImageRequest,
  isCollectedSticker,
  latestGiftIntents,
  parseOldImageProtocol,
  requestsResend,
  selectOldImageCandidates,
} from "../lib/image-collection.js";

test("协议只认自家附件的写法，坏的一律吃掉", () => {
  const good = parseOldImageProtocol(`给你看这个[旧图:{"id":"img_ab_1","as":"sticker"}]`);
  assert.equal(good.request.id, "img_ab_1");
  assert.equal(good.request.as, "sticker");
  assert.equal(good.status, "valid");
  assert.equal(good.text, "给你看这个", "内部 JSON 不能漏进聊天");

  // 半截协议：后面全丢，绝不把半个 JSON 发出去。
  const half = parseOldImageProtocol('前面[旧图:{"id":"img_a"');
  assert.equal(half.request, null);
  assert.equal(half.status, "invalid");
  assert.equal(half.text.includes("img_a"), false);

  // id 不认非自家写法；键多一个也不认；id/as 必须是字符串。
  assert.equal(parseOldImageProtocol('[旧图:{"id":"photo_1","as":"image"}]').request, null);
  assert.equal(parseOldImageProtocol('[旧图:{"id":"img/a","as":"image"}]').request, null);
  assert.equal(parseOldImageProtocol('[旧图:{"id":"img_a","as":"image","x":1}]').request, null);
  assert.equal(parseOldImageProtocol('[旧图:{"id":"img_a","as":"gif"}]').request, null);
  assert.equal(parseOldImageProtocol('[旧图:{"id":["img_a"],"as":"image"}]').request, null, "数组不能经 String() 变成合法 id");
  assert.equal(parseOldImageProtocol('[旧图:{"id":"img_a","as":["image"]}]').request, null);

  // 两个标记：不能挑一个当真的，全当没写。
  const twice = parseOldImageProtocol('[旧图:{"id":"img_a","as":"image"}][旧图:{"id":"img_b","as":"image"}]');
  assert.equal(twice.request, null);
  assert.equal(twice.status, "invalid");
  assert.equal(twice.text.includes("img_a"), false);

  assert.equal(formatOldImageRequest({ id: "img_a", as: "sticker" }), '[旧图:{"id":"img_a","as":"sticker"}]');
  assert.equal(parseOldImageProtocol(formatOldImageRequest({ id: "img_a" })).request.as, "image");
});

test("只有真的做了/送了/收作表情才算赠送，光提表情包不算", () => {
  for (const text of ["这张给你做表情包", "给你做的表情包", "送你当表情用", "这张收作表情", "专门给你整了个表情包", "我给你做了你oc的表情包"]) {
    assert.equal(detectGiftIntent(text).collect, true, text);
  }
  for (const text of ["这个表情包真好玩", "给你看看这个表情包", "给你看看", "我刚买了张贴纸", "表情包在哪儿", "这张照片真好看"]) {
    assert.equal(detectGiftIntent(text).collect, false, text);
  }
});

test("明确否定赠送的不收，也不当成退收藏", () => {
  assert.equal(detectGiftIntent("这不是给你做的表情包").collect, false);
  assert.equal(detectGiftIntent("不是送你的表情包").collect, false);
  assert.equal(detectGiftIntent("别给我做表情包").collect, false);
  assert.equal(detectGiftIntent("不用给我做表情包").collect, false);
});

test("否定与退收藏的说法", () => {
  for (const text of ["别再用这张了", "不要发这张表情包", "取消收藏", "这张别再当表情用了"]) {
    assert.equal(detectGiftIntent(text).remove, true, text);
  }
  assert.equal(detectGiftIntent("不用谢").remove, false, "不用谢不是退收藏");
  assert.equal(detectGiftIntent("这个表情包不好笑").remove, false);
  assert.equal(detectGiftIntent("别给我做表情包").remove, false, "拒绝以后做，不是撤回某一张");
});

test("礼物绑定到哪张图：同条、紧邻下一条、引用旧图都认", () => {
  const messages = [
    { id: "m1", role: "user", at: "2026-11-01T10:00:00", attachment: { id: "img_a" }, text: "看这个" },
    { id: "m2", role: "user", at: "2026-11-01T10:01:00", text: "这张给你做表情包" },
    { id: "m3", role: "user", at: "2026-11-01T11:00:00", attachment: { id: "img_b" }, text: "给你做的表情包" },
    { id: "m4", role: "user", at: "2026-11-01T12:00:00", quote: { messageId: "m3" }, text: "这张收作表情" },
  ];
  assert.equal(findGiftTarget(messages, 0).attachmentId, "img_a", "同条图片文字");
  assert.equal(findGiftTarget(messages, 0).imageMessageId, "m1");
  assert.equal(findGiftTarget(messages, 1).attachmentId, "img_a", "紧邻下一条说明");
  assert.equal(findGiftTarget(messages, 2).attachmentId, "img_b");
  assert.equal(findGiftTarget(messages, 3).attachmentId, "img_b", "引用旧图");
  assert.equal(findGiftTarget(messages, 3).imageMessageId, "m3");

  // 隔太久就不绑：半小时前那张跟现在这句没关系。
  const old = [
    { id: "m1", role: "user", at: "2026-11-01T08:00:00", attachment: { id: "img_a" }, text: "看这个" },
    { id: "m2", role: "user", at: "2026-11-01T10:00:00", text: "这张给你做表情包" },
  ];
  assert.equal(findGiftTarget(old, 1), null);
  assert.equal(findGiftTarget([], 0), null);
});

test("撤回的图不算礼物，伙伴自己发的那张只有明确引用才算", () => {
  const recalled = [
    { id: "m1", role: "user", at: "2026-11-01T10:00:00", attachment: { id: "img_a" }, text: "看这个", recalled: true },
    { id: "m2", role: "user", at: "2026-11-01T10:01:00", text: "这张给你做表情包" },
  ];
  assert.equal(findGiftTarget(recalled, 1), null, "撤回去的图不再当礼物");

  const ownPhoto = [
    { id: "m1", role: "assistant", at: "2026-11-01T10:00:00", attachment: { id: "img_mine" }, text: "我拍的" },
    { id: "m2", role: "user", at: "2026-11-01T10:01:00", text: "好看" },
    { id: "m3", role: "user", at: "2026-11-01T10:02:00", quote: { messageId: "m1" }, text: "这张收作表情" },
  ];
  assert.equal(findGiftTarget(ownPhoto, 1), null, "伙伴自己发的照片不能顺带被收走");
  assert.equal(findGiftTarget(ownPhoto, 2).attachmentId, "img_mine", "明确引用就能收");

  // 赠送那句话本身比图还早：不绑（时间差不能为负）。
  const backwards = [
    { id: "m1", role: "user", at: "2026-11-01T10:05:00", text: "这张给你做表情包" },
    { id: "m2", role: "user", at: "2026-11-01T10:00:00", attachment: { id: "img_a" }, text: "看这个" },
  ];
  assert.equal(findGiftTarget(backwards, 0), null);
});

test("每个附件只认最新的一条意图：旧赠送翻不动后来的退订", () => {
  const messages = [
    { id: "m1", role: "user", at: "2026-11-01T10:00:00", attachment: { id: "img_a" }, text: "这张给你做表情包" },
    { id: "m2", role: "user", at: "2026-11-01T10:05:00", text: "别再用这张了" },
  ];
  const intents = latestGiftIntents(messages);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].collect, false);
  assert.equal(intents[0].messageId, "m2");
  assert.equal(intents[0].imageMessageId, "m1", "带图的那条与赠送那句话是两条，要分开记");
});

test("同一个附件上超过二十条指令也不乱：最后一条说了算", () => {
  const messages = [{ id: "m0", role: "user", at: "2026-11-01T09:00:00", attachment: { id: "img_a" }, text: "看这个" }];
  for (let i = 0; i < 25; i += 1) {
    messages.push({
      id: `m${i + 1}`,
      role: "user",
      at: `2026-11-01T10:${String(i).padStart(2, "0")}:00`,
      quote: { messageId: "m0" },
      text: i % 2 === 0 ? "别再用了这张" : "这张收作表情",
    });
  }
  const intents = latestGiftIntents(messages);
  assert.equal(intents.length, 1, "同一个附件只留一条意图");
  assert.equal(intents[0].messageId, "m25", "最后一条说了算");
  assert.equal(intents[0].collect, false);
});

test("问句与假设不算赠送，同一句里的否定也不算", () => {
  assert.equal(detectGiftIntent("要不要给你做这张表情包？").collect, false);
  assert.equal(detectGiftIntent("如果给你做表情包你会用吗？").collect, false);
  assert.equal(detectGiftIntent("这张给你做的不是表情包").collect, false);
  assert.equal(detectGiftIntent("这张给你做表情包。喜欢吗？").collect, true, "前半句已经送了，后半句是问句");
});

test("还在盘上的附件才算数：属主、id、本体都要对", () => {
  const metas = [
    { id: "img_ok", agentId: "nova" },
    { id: "img_other", agentId: "other" },
    { id: "photo_x", agentId: "nova" },
    { id: "img_gone", agentId: "nova" },
    { id: "img_purged", agentId: "nova", purgedAt: "x" },
  ];
  const alive = new Set(["img_ok", "img_other", "photo_x", "img_purged"]);
  const rows = availableAttachmentMetas(metas, { agentId: "nova", hasBytes: (id) => alive.has(id) });
  assert.deepEqual(rows.map((row) => row.id), ["img_ok"]);
});

test("退收藏留墓碑：不再算收藏，也不被历史重新收回来", () => {
  assert.equal(isCollectedSticker({ agentId: "nova", collection: { sticker: true } }), true);
  assert.equal(isCollectedSticker({ agentId: "nova", collection: { sticker: false } }), false, "墓碑不算收藏");
  assert.equal(isCollectedSticker({ collection: { sticker: true } }), false, "没有属主的护不住");
  assert.equal(isCollectedSticker({ agentId: "nova", collection: { sticker: true }, purgedAt: "x" }), false, "清过的不算");
  assert.equal(isCollectedSticker(null), false);
});

test("候选只给这位伙伴的：收藏优先，普通图按最近的挑", () => {
  const metas = [
    { id: "img_stick", agentId: "nova", at: "2026-10-01T00:00:00", collection: { sticker: true, at: "2026-10-01T00:00:00" }, title: "收藏" },
    { id: "img_plain", agentId: "nova", at: "2026-10-05T00:00:00", title: "普通" },
    { id: "img_other", agentId: "other", at: "2026-10-06T00:00:00", collection: { sticker: true } },
  ];
  const messages = [
    { role: "user", at: "2026-10-05T00:00:00", attachment: { id: "img_plain" }, text: "这张" },
    { role: "assistant", at: "2026-10-05T00:01:00", attachment: { id: "img_other" }, text: "别的伙伴的" },
  ];
  const rows = selectOldImageCandidates({ messages, metas, agentId: "nova" });
  assert.deepEqual(rows.map((row) => row.id), ["img_stick", "img_plain"]);
  assert.equal(rows[0].as, "sticker");
  assert.equal(rows[1].as, "image");
  assert.equal(rows.some((row) => row.id === "img_other"), false, "别把别的伙伴的图塞进来");
  assert.equal(rows[0].from, null, "来源查不到就不臆断");
  assert.equal(rows[1].from, "user", "她的图要标出是她发的");
});

test("收藏多了也不能把普通图挤掉：各留几个位置，最近收的排前面", () => {
  const metas = [];
  for (let i = 0; i < 9; i += 1) {
    metas.push({ id: `img_s${i}`, agentId: "nova", at: `2026-10-0${i + 1}`, collection: { sticker: true, at: `2026-10-1${i}T00:00:00` } });
  }
  metas.push({ id: "img_plain", agentId: "nova", at: "2026-10-20" });
  const messages = [{ role: "user", at: "2026-10-20T00:00:00", attachment: { id: "img_plain" }, text: "普通图" }];
  const rows = selectOldImageCandidates({ messages, metas, agentId: "nova" });
  assert.equal(rows.length, 8);
  assert.equal(rows[0].id, "img_s8", "最近收的那张排最前");
  assert.ok(rows.filter((row) => row.as === "sticker").length >= 4, "收藏至少占四个位置");
  assert.ok(rows.some((row) => row.id === "img_plain"), "普通照片也得留位置");
  assert.equal(rows.some((row) => row.id === "img_s0"), false, "最老的那张这次不进");
});

test("原图被撤回的收藏不进候选", () => {
  const metas = [{ id: "img_s", agentId: "nova", at: "2026-10-01", collection: { sticker: true, sourceImageMessageId: "m1", sourceRole: "user" } }];
  const recalled = [{ id: "m1", role: "user", at: "2026-10-01T00:00:00", attachment: { id: "img_s" }, recalled: true }];
  assert.equal(selectOldImageCandidates({ messages: recalled, metas, agentId: "nova" }).length, 0);
  const live = [{ id: "m1", role: "user", at: "2026-10-01T00:00:00", attachment: { id: "img_s" } }];
  const rows = selectOldImageCandidates({ messages: live, metas, agentId: "nova" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, "user");
});

test("候选写进提示词时是数据，不是指令，还要说清是谁发的", () => {
  const text = formatOldImageCandidates([
    { id: "img_a", as: "sticker", from: "user", date: "2026-10-01", title: "猫", description: "一只猫", at: "2026-10-01T00:00:00", said: "给你的" },
    { id: "img_b", as: "image", from: "assistant", date: "2026-09-01", title: "", description: "", at: "2026-09-01T00:00:00", said: "" },
  ]);
  assert.match(text, /\[旧图:\{"id":"img_\.\.\."/u);
  assert.match(text, /"id":"img_a"/u);
  assert.match(text, /"from":"user"/u);
  assert.match(text, /"from":"assistant"/u);
  assert.match(text, /from 只表示原发送者/u);
  assert.match(text, /不要猜是谁拍的、画的是谁/u);
  assert.match(text, /别把她发来的图片当成你的新经历/u);
  assert.match(text, /别当成刚拍的新照片/u);
  assert.equal(formatOldImageCandidates([]), "");
});

test("她明确要再来一次时，同一张图可以再发", () => {
  assert.equal(requestsResend("再发一次那张图"), true);
  assert.equal(requestsResend("把刚才那张再发一遍"), true);
  assert.equal(requestsResend("今天天气不错"), false);
  assert.equal(requestsResend("再说一次"), false);
});
