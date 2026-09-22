import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_STYLES,
  ACTION_TONES,
  ACTION_VOICE,
  DEFAULT_STYLE_ID,
  actionLabel,
  actionTailFromTemplate,
  actionTemplateFromTail,
  actionTemplateSpec,
  cleanActionTemplate,
  ensurePlaceholders,
  fallbackActionTemplate,
  fallbackLine,
  getStyle,
  isSafeActionText,
  isStyleId,
  isValidActionTemplate,
  needsRotation,
  nextRotationAt,
  normalizeActionVoice,
  parseToneReply,
  readMyTemplateEntry,
  readStyleId,
  readTemplateEntry,
  renderActionLine,
  resolveStyleId,
  toneById,
} from "../lib/actions.js";

const T0 = new Date("2026-09-12T10:00:00.000Z");

test("动作文案提示词会带入相处理解", () => {
  const spec = actionTemplateSpec({
    styleId: DEFAULT_STYLE_ID,
    partnerName: "小花",
    adaptationText: "偏好：熟人玩笑里可以轻轻损一点",
  });
  assert.match(spec.userText, /熟人玩笑里可以轻轻损一点/);
});

test("每个叫法有自己的 emoji，而且不重样", () => {
  for (const style of ACTION_STYLES) {
    assert.equal(typeof style.emoji, "string");
    assert.ok(style.emoji.trim(), `${style.id} 得有自己的表情`);
  }
  const emojis = ACTION_STYLES.map((s) => s.emoji);
  assert.equal(new Set(emojis).size, ACTION_STYLES.length, "表情不能重复，别让动作们顶同一张脸");
});

test("踩线的文案一律挡掉，还会被排进重写", () => {
  assert.equal(isSafeActionText("{name}{verb}你的手背，你把手往回缩了一下"), true);
  assert.equal(isSafeActionText("{name}{verb}你的花瓣，你脸红了"), false);
  assert.equal(isSafeActionText("{name}{verb}你的花蕊"), false);
  assert.equal(isSafeActionText("{name}{verb}你的腰，你扭了一下"), true, "部位词不机械拦，别一刀切");
  assert.equal(isSafeActionText("{name}{verb}你的手，酥麻了一下"), true, "「酥」也不拦");
  // 隐晦的那种：一个字也不露骨，但镜头全往身体里引
  assert.equal(
    isSafeActionText("{name}{verb}你的枪穗，你耳尖一热，马尾跟着晃了晃"),
    false,
    "「耳尖一热」就是那种腔调",
  );
  assert.equal(isSafeActionText("{name}{verb}你的额角，你脸上一热"), false);
  assert.equal(isSafeActionText("{name}{verb}你，你心跳快得厉害"), false);
  assert.equal(isSafeActionText("{name}{verb}你，你身子一软"), false);
  // 好句子别误伤
  assert.equal(isSafeActionText("{name}{verb}你，你把一直僵着的肩膀松下来"), true);
  assert.equal(isSafeActionText("{name}{verb}你的脑袋，你把思绪抖回原位"), true);
  assert.equal(isValidActionTemplate("poke", "{name}{verb}你的花瓣"), false, "踩线的不算合格");
  const dirty = { text: "{name}{verb}你的花瓣", voice: ACTION_VOICE, nextAt: "2999-01-01T00:00:00.000Z" };
  assert.equal(needsRotation(dirty), true, "旧的脏文案要排进重写");
  const clean = { text: "{name}{verb}你的手背", voice: ACTION_VOICE, nextAt: "2999-01-01T00:00:00.000Z" };
  assert.equal(needsRotation(clean), false);
  assert.equal(
    needsRotation({ text: "{name}{verb}你，你耳尖一热", voice: ACTION_VOICE, nextAt: "2999-01-01T00:00:00.000Z" }),
    true,
    "隐晦的旧文案也要排进重写，不能等到期",
  );
});

test("两次都写不出来时，兜底句拿的是这一档的示范句", () => {
  assert.equal(fallbackActionTemplate("poke"), getStyle("poke").example);
  assert.equal(fallbackActionTemplate("hug"), getStyle("hug").example);
  for (const style of ACTION_STYLES) {
    assert.equal(isSafeActionText(fallbackActionTemplate(style.id)), true, `${style.label} 的兜底句得是干净的`);
  }
});

test("提示词画清了能落笔的地方，也不留暗喻当示范", () => {
  const spec = actionTemplateSpec({ styleId: "poke", partnerName: "小花", personaText: "" });
  assert.match(spec.systemPrompt, /落点在事，不在感受/, "尺度得当面说清");
  assert.match(spec.systemPrompt, /花瓣/, "露骨的暗喻点名挡掉");
  assert.match(spec.systemPrompt, /耳根发烫/, "隐晦的那一整类也得点名（光禁两个词拦不住）");
  for (const label of ["自嘲", "整活", "可爱", "戏精", "生活", "文艺温柔"]) {
    assert.match(spec.systemPrompt, new RegExp(label), `「${label}」这一档要摆出来`);
  }
  assert.match(spec.systemPrompt, /取材/, "取材那条也要说清：从自己身上取，不从段子库里挑");
  assert.match(spec.systemPrompt, /竖线隔开/, "得告诉ta怎么把挑的调子报回来");
  assert.doesNotMatch(spec.systemPrompt, /月牙/, "示范句里不能再留暗喻");
});

test("调子报得出来就用，报不出来也不耽误写", () => {
  assert.deepEqual(parseToneReply("文艺温柔|{name}{verb}你的杯沿"), { tone: "wenyi", text: "{name}{verb}你的杯沿" });
  assert.equal(parseToneReply("可爱｜{name}{verb}你的腮帮").tone, "keai");
  assert.equal(parseToneReply("调子：整活|{name}{verb}你的屏幕").tone, "zhenghuo");
  assert.equal(parseToneReply("沙雕|{name}{verb}你的键盘").tone, "zichao", "ta换个词写也算那一档");
  assert.equal(parseToneReply("戏精|{name}{verb}你的椅子").tone, "xijing");
  assert.equal(parseToneReply("生活|{name}{verb}你的碗").tone, "shenghuo");
  // 没写调子：不算错，接着用上一次那档
  assert.deepEqual(parseToneReply("{name}{verb}你的手背"), { tone: null, text: "{name}{verb}你的手背" });
  assert.equal(parseToneReply("").tone, null);
});

test("六档调子各有范本，而且每一条范本自己都得是干净的", () => {
  assert.equal(ACTION_TONES.length, 6);
  const ids = new Set();
  for (const tone of ACTION_TONES) {
    assert.ok(!ids.has(tone.id), `${tone.id} 重了`);
    ids.add(tone.id);
    assert.ok(tone.samples.length >= 2, `${tone.label} 得有两个范本`);
    for (const sample of tone.samples) {
      assert.match(sample, /\{name\}/, "范本得带槽位");
      assert.match(sample, /\{verb\}/);
      assert.equal(isSafeActionText(sample), true, `${tone.label} 的范本不能踩线：${sample}`);
    }
    assert.equal(toneById(tone.id).label, tone.label);
  }
  assert.equal(toneById("不存在"), null);
});

test("聊天正文里是动词，叫法名只留在设置页", () => {
  for (const style of ACTION_STYLES) {
    const line = renderActionLine(style.id, "", "某人");
    assert.ok(line.includes(style.verb), `${style.id} 的正文该用动词`);
    assert.ok(!line.includes(style.label), `${style.id} 的正文不该出现叫法名`);
    const written = renderActionLine(style.id, "{name}{verb}你的脑袋", "某人");
    assert.ok(written.includes(style.verb));
    assert.ok(!written.includes(style.label), `${style.id} 有文案时也不许把叫法名写进句子`);
  }
});

// ── 只有一个动作 ──

test("叫法表里 id 不重复，默认那个是「戳一戳」", () => {
  assert.ok(ACTION_STYLES.length >= 2);
  assert.equal(new Set(ACTION_STYLES.map((s) => s.id)).size, ACTION_STYLES.length);
  assert.equal(DEFAULT_STYLE_ID, "poke");
  assert.equal(getStyle("poke").label, "戳一戳");
});

test("每个叫法的例子本身就是合格文案（自查）", () => {
  for (const s of ACTION_STYLES) {
    assert.ok(s.example.includes("{name}"), `${s.id} 例子缺 {name}`);
    assert.ok(s.example.includes("{verb}"), `${s.id} 例子缺 {verb}`);
    assert.ok(s.example.includes("你"), `${s.id} 例子没带「你」`);
    assert.equal(isValidActionTemplate(s.id, s.example), true, `${s.id} 的例子没通过校验`);
  }
});

test("不认识的叫法一律回到默认，不吃脏数据", () => {
  assert.equal(resolveStyleId("pat"), "pat");
  assert.equal(resolveStyleId("nope"), DEFAULT_STYLE_ID);
  assert.equal(resolveStyleId(undefined), DEFAULT_STYLE_ID);
  assert.equal(isStyleId("pat"), true);
  assert.equal(isStyleId("nope"), false);
  assert.equal(actionLabel("nope"), "戳一戳");
});

// ── 句式：一套，{name}=动手的，{verb}=动作，你=挨的 ──

test("{name} 换成动手的那位，{verb} 换成这个动作现在的叫法", () => {
  assert.equal(
    renderActionLine("poke", "{name}{verb}你的手背，你把手往回缩了一下", "阿舟"),
    "阿舟戳了戳你的手背，你把手往回缩了一下",
  );
  assert.equal(
    renderActionLine("hug", "{name}{verb}你，你把一直僵着的肩膀松下来", "小花"),
    "小花抱了抱你，你把一直僵着的肩膀松下来",
  );
});

test("换叫法不换文案：同一句模板，换个叫法就换个词", () => {
  const tpl = "{name}{verb}你的手背";
  assert.equal(renderActionLine("poke", tpl, "小花"), "小花戳了戳你的手背");
  assert.equal(renderActionLine("pat", tpl, "小花"), "小花拍了拍你的手背");
});

test("谁都没写过就用兜底，不至于空着", () => {
  assert.equal(renderActionLine("poke", "", "红药"), "红药戳了戳你");
  assert.equal(renderActionLine("hug", null, "红药"), "红药抱了抱你");
  assert.equal(fallbackLine("pat"), "{name}拍了拍你");
});

test("设置页填空能收成旧模板，空着仍是默认句", () => {
  assert.equal(actionTemplateFromTail("肚皮并发出海豹音"), "{name}{verb}你的肚皮并发出海豹音");
  assert.equal(actionTemplateFromTail("我的肩膀"), "{name}{verb}你的肩膀");
  assert.equal(actionTemplateFromTail(""), "{name}{verb}你");
  assert.equal(renderActionLine("pat", actionTemplateFromTail("脑袋"), "小花"), "小花拍了拍你的脑袋");
});

test("设置页能从旧完整模板取回填空内容", () => {
  assert.equal(actionTailFromTemplate("{name}{verb}你的手背，你把手往回缩了一下"), "手背，你把手往回缩了一下");
  assert.equal(actionTailFromTemplate("{name}戳了戳我的帽檐，帽檐歪了"), "帽檐，帽檐歪了");
  assert.equal(actionTailFromTemplate("{name}{verb}你"), "");
  assert.equal(actionTailFromTemplate({ tail: "肚皮" }), "肚皮");
});

test("占位符出现多次也全换掉", () => {
  assert.equal(
    renderActionLine("poke", "{name}{verb}你，你又{verb}{name}", "红药"),
    "红药戳了戳你，你又戳了戳红药",
  );
});

test("缺哪个槽位就补哪个", () => {
  assert.equal(ensurePlaceholders("抱了抱你"), "{name}{verb}抱了抱你");
  assert.equal(ensurePlaceholders("{name}抱了抱你"), "{name}{verb}抱了抱你");
  assert.equal(ensurePlaceholders("{name}{verb}抱了抱你"), "{name}{verb}抱了抱你");
  assert.equal(ensurePlaceholders(""), "");
});

// ── 校验与清洗 ──

test("不合格的被挡住：太短、太长、缺槽位、没「你」、没这个叫法", () => {
  assert.equal(isValidActionTemplate("hug", "{name}{verb}抱了抱你"), true);
  assert.equal(isValidActionTemplate("hug", "抱你"), false); // 太短
  assert.equal(isValidActionTemplate("hug", "{name}{verb}" + "抱".repeat(48)), false); // 太长
  assert.equal(isValidActionTemplate("hug", "{name}抱了抱你"), false); // 缺 {verb}
  assert.equal(isValidActionTemplate("hug", "{verb}抱了抱你"), false); // 缺 {name}
  assert.equal(isValidActionTemplate("hug", "{name}{verb}抱了抱他"), false); // 没「你」
  assert.equal(isValidActionTemplate("nope", "{name}{verb}抱了抱你"), false); // 没这个叫法
});

test("洗文案：去引号、去前缀、折成一行、补齐槽位", () => {
  assert.equal(cleanActionTemplate("hug", "「{name}{verb}抱了抱你」"), "{name}{verb}抱了抱你");
  assert.equal(cleanActionTemplate("hug", "文案：{name}{verb}抱了抱你"), "{name}{verb}抱了抱你");
  assert.equal(cleanActionTemplate("hug", "{name}{verb}抱了抱你\n你笑了"), "{name}{verb}抱了抱你 你笑了");
  assert.equal(cleanActionTemplate("hug", "抱了抱你"), "{name}{verb}抱了抱你");
});

// 模型偶尔会把口径写歪，这里纯机械地扳回来。
test("扳回写歪的口径：我的→你的，句首的「你X」→{name}X", () => {
  assert.equal(
    normalizeActionVoice("{name}{verb}抱了抱我的肩膀，我愣住了"),
    "{name}{verb}抱了抱你的肩膀，你愣住了",
  );
  assert.equal(normalizeActionVoice("你抱了抱我，我愣住了"), "{name}抱了抱你，你愣住了");
  assert.equal(normalizeActionVoice("{name}{verb}抱了抱你，你愣住了"), "{name}{verb}抱了抱你，你愣住了");
  assert.equal(normalizeActionVoice(""), "");
});

test("洗完之后一定是最终句式", () => {
  assert.equal(
    cleanActionTemplate("kick", "{name}踢了踢我的椅子，我抬头"),
    "{name}{verb}踢了踢你的椅子，你抬头",
  );
  assert.equal(cleanActionTemplate("kick", "你踢了踢我的椅子"), "{name}{verb}踢了踢你的椅子");
});

// ── 换文案的节奏 ──

test("换文案的间隔不规律，在 7~21 天之间", () => {
  const early = nextRotationAt(T0, () => 0);
  const late = nextRotationAt(T0, () => 1);
  assert.equal(Date.parse(early) - T0.getTime(), 7 * 86400000);
  assert.equal(Date.parse(late) - T0.getTime(), 21 * 86400000);
});

test("没文案、到点了、或写法版本旧了，都该重写", () => {
  assert.equal(needsRotation(null, T0), true);
  assert.equal(needsRotation({ text: "{name}{verb}抱了抱你" }, T0), true); // 没版本号
  const ok = {
    text: "{name}{verb}抱了抱你",
    voice: ACTION_VOICE,
    nextAt: new Date(T0.getTime() + 86400000).toISOString(),
  };
  assert.equal(needsRotation(ok, T0), false);
  assert.equal(needsRotation({ ...ok, nextAt: new Date(T0.getTime() - 1000).toISOString() }, T0), true);
  assert.equal(needsRotation({ ...ok, voice: 1 }, T0), true); // 旧写法
});

// ── 读写与旧数据迁移 ──

test("伙伴那格：新结构 action；旧的两代都认", () => {
  assert.equal(readTemplateEntry({ action: { text: "{name}{verb}抱了抱你" } }).text, "{name}{verb}抱了抱你");

  // 九格时代：actions.poke
  assert.equal(
    readTemplateEntry({ actions: { poke: { text: "{name}{verb}戳了戳你" } } }).text,
    "{name}{verb}戳了戳你",
  );
  // 九格时代里被冷落的那几格不再当成单独的动作，但也不会崩
  assert.equal(readTemplateEntry({ actions: { hug: { text: "{name}{verb}抱了抱你" } } }), null);

  // 单格时代：pokeTemplate
  const legacy = {
    pokeTemplate: "{name}{verb}戳了戳你",
    pokeVoice: 1,
    pokeTemplateNextAt: "2026-09-30T00:00:00.000Z",
  };
  const migrated = readTemplateEntry(legacy);
  assert.equal(migrated.text, "{name}{verb}戳了戳你");
  assert.equal(migrated.voice, 1);
  assert.equal(migrated.nextAt, "2026-09-30T00:00:00.000Z");

  assert.equal(readTemplateEntry({}), null);
  assert.equal(readTemplateEntry(null), null);
});

test("她那格：新结构 myAction；旧的两代都认", () => {
  assert.equal(readMyTemplateEntry({ myAction: { text: "{name}{verb}抱了抱你" } }).text, "{name}{verb}抱了抱你");
  assert.equal(readMyTemplateEntry({ myActions: { poke: { text: "{name}{verb}戳了戳你" } } }).text, "{name}{verb}戳了戳你");
  assert.equal(readMyTemplateEntry({ myPokeTemplate: "{name}{verb}戳了戳你" }).text, "{name}{verb}戳了戳你");
  assert.equal(readMyTemplateEntry({}), null);
});

test("叫法存在全局设置里，认不出就用默认", () => {
  assert.equal(readStyleId({ actionStyle: "pat" }), "pat");
  assert.equal(readStyleId({ actionStyle: "nope" }), DEFAULT_STYLE_ID);
  assert.equal(readStyleId({}), DEFAULT_STYLE_ID);
});

// ── 提示词 ──

test("生成文案的 prompt 说清了叫法、两个占位符和「你」", () => {
  const spec = actionTemplateSpec({ styleId: "hug", partnerName: "红药", personaText: "理性、克制" });
  assert.match(spec.userText, /红药/);
  assert.match(spec.userText, /理性/);
  assert.match(spec.userText, /抱一抱/);
  assert.match(spec.systemPrompt, /抱一抱/);
  assert.match(spec.systemPrompt, /\{name\}/);
  assert.match(spec.systemPrompt, /\{verb\}/);
  assert.match(spec.systemPrompt, /「你」指的就是你本人/);
});
