import test from "node:test";
import assert from "node:assert/strict";
import { protectKey, unprotectKey, isProtectedKey, encryptionAvailable, encryptionStatus } from "../lib/crypto.js";
import { canonicalGuide, closeRelationship } from "./helpers/adaptation.js";
import {
  cleanVoiceText,
  isExplicitVoiceRequest,
  nextTextRuntime,
  nextVoiceRuntime,
  shouldGenerateVoice,
  resolveVoicePolicy,
  normalizeVoiceModelConfig,
  voiceChoicesForModel,
  voiceGroupsForModel,
  defaultVoiceIdForModel,
  buildT2aUrl,
  normalizeVoiceProfiles,
  activeVoiceModel,
  activeVoiceProfileId,
  nextVoiceProfileId,
  voiceRequestHeaders,
  VOICE_PRESETS,
  migratedVoiceProfileId,
  synthesizeVoice,
  audioDurationMs,
  applyVoiceDelivery,
  stripUnknownVoiceTags,
  speakableChunks,
  chunkTimings,
  parseSubtitleFile,
} from "../lib/voice.js";

test("合成音频能在落盘前算出 WAV/MP3 时长", () => {
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(32000, 40);
  assert.equal(audioDurationMs(wav, "wav"), 1000);

  const mp3 = Buffer.alloc(4096);
  mp3[0] = 0xff; mp3[1] = 0xfb; mp3[2] = 0x90;
  assert.ok(audioDurationMs(mp3, "mp3") > 0);
});

test("朗读模型配置只认自定义字段，并限制长度", () => {
  assert.deepEqual(normalizeVoiceModelConfig({ protocol: "t2a", baseUrl: " https://example.com/ ", apiKey: "secret" }), {
    providerId: "", model: "", protocol: "t2a", baseUrl: "https://example.com", groupId: "", apiKey: "secret",
  });
  assert.equal(normalizeVoiceModelConfig(null).protocol, "chat");
  assert.equal(normalizeVoiceModelConfig({ protocol: "wrong" }).protocol, "chat");
});

test("旧版固定档位带着 Key 的迁成普通条目，空壳丢掉", () => {
  const profiles = normalizeVoiceProfiles({
    minimax: { label: "MiniMax", config: { providerId: "", model: "", protocol: "t2a", baseUrl: "", groupId: "2048", apiKey: "dpapi:minimax" } },
    mimo: { label: "MiMo", config: { providerId: "mimo", model: "mimo-v2.5-tts", protocol: "chat", baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "dpapi:mimo" } },
    custom: { label: "自定义", config: { protocol: "chat", apiKey: "" } },
  });
  assert.equal(profiles["custom-minimax"].config.apiKey, "dpapi:minimax");
  assert.equal(profiles["custom-minimax"].config.model, "speech-2.8-hd");
  assert.equal(profiles["custom-minimax"].config.baseUrl, "https://api.minimaxi.com");
  assert.equal(profiles["custom-minimax"].config.groupId, "2048");
  assert.equal(profiles["custom-mimo"].config.model, "mimo-v2.5-tts");
  assert.equal(profiles.custom, undefined);
  assert.equal(profiles["custom-legacy"], undefined);
});

test("分享版不保留从 Hana 目录拉出来的朗读条目", () => {
  const profiles = normalizeVoiceProfiles({
    "hana-minimax-speech-2.8-hd": { label: "speech-2.8-hd", config: { source: "hana", providerId: "minimax", model: "speech-2.8-hd", baseUrl: "", apiKey: "" } },
  });
  assert.deepEqual(Object.keys(profiles), []);
});

test("自定义朗读模型可以保存多条，当前选中项跟着走", () => {
  const profiles = normalizeVoiceProfiles({
    "custom-first": { label: "我的 MiMo", config: { providerId: "mimo", model: "mimo-v2.5-tts", apiKey: "key-1" } },
    "custom-second": { label: "备用模型", config: { baseUrl: "https://example.com", model: "voice-2", apiKey: "key-2" } },
  });
  assert.equal(profiles["custom-first"].label, "我的 MiMo");
  assert.equal(profiles["custom-second"].config.model, "voice-2");
  assert.equal(activeVoiceProfileId({ voiceProfiles: profiles, voiceProfile: "custom-second" }), "custom-second");
  assert.equal(activeVoiceProfileId({ voiceProfiles: profiles, voiceProfile: "找不到的" }), "custom-first");
  assert.equal(activeVoiceProfileId({ voiceProfiles: profiles }), "custom-first");
});

test("旧的当前选中项会跟着迁移后的条目走", () => {
  const settings = { voiceProfile: "minimax", voiceProfiles: { minimax: { label: "MiniMax", config: { protocol: "t2a", apiKey: "k" } } } };
  assert.equal(activeVoiceProfileId(settings), "custom-minimax");
  assert.equal(activeVoiceModel(settings).model, "speech-2.8-hd");
});

test("更早版本的单条全局朗读配置还能救回来一次", () => {
  const settings = { voiceProfiles: null, voiceModel: { protocol: "t2a", groupId: "1", apiKey: "old-key" } };
  const profiles = normalizeVoiceProfiles(settings.voiceProfiles, settings.voiceModel);
  assert.equal(profiles["custom-legacy"].config.apiKey, "old-key");
  assert.equal(profiles["custom-legacy"].config.model, "speech-2.8-hd");
  assert.equal(activeVoiceProfileId(settings), "custom-legacy");
  assert.deepEqual(normalizeVoiceProfiles(null, null), {});
  // 存过多条结构又删光了，不能拿旧的单条配置把条目复活
  assert.deepEqual(normalizeVoiceProfiles({}, settings.voiceModel), {});
});

test("新建朗读模型的开箱模板带好协议和默认地址", () => {
  assert.deepEqual(VOICE_PRESETS.map((item) => item.id), ["minimax", "minimax-turbo", "mimo", "openai"]);
  assert.equal(VOICE_PRESETS[0].protocol, "t2a");
  assert.equal(VOICE_PRESETS[0].baseUrl, "https://api.minimaxi.com");
  assert.equal(VOICE_PRESETS[2].baseUrl, "https://api.xiaomimimo.com/v1");
  // 省一半的那个只是换了模型名，协议和地址得跟正片一致
  assert.equal(VOICE_PRESETS[1].model, "speech-2.8-turbo");
  assert.equal(VOICE_PRESETS[1].baseUrl, VOICE_PRESETS[0].baseUrl);
  assert.equal(VOICE_PRESETS[1].protocol, "t2a");
});

test("新建条目生成的编号命中自定义前缀", () => {
  assert.match(nextVoiceProfileId(1234567, () => 0.5), /^custom-[a-z0-9]+-[a-z0-9]+$/);
});

test("旧档位编号能映射到迁移后的条目", () => {
  assert.equal(migratedVoiceProfileId("minimax"), "custom-minimax");
  assert.equal(migratedVoiceProfileId("mimo"), "custom-mimo");
  assert.equal(migratedVoiceProfileId("custom-minimax"), "");
  assert.equal(migratedVoiceProfileId(undefined), "");
});

/** 合成请求用假 ctx 接住，看看到底把哪个音色发出去了。 */
function captureVoiceRequest(payload) {
  const calls = [];
  const ctx = {
    network: {
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
        return { ok: true, status: 200, json: async () => payload };
      },
    },
  };
  return { ctx, calls };
}

test("指定音色不会被配置归一化吞掉（MiniMax t2a）", async () => {
  const { ctx, calls } = captureVoiceRequest({ data: { audio: "68656c6c6f" } });
  await synthesizeVoice(ctx, {
    text: "你好呀，我是小花。",
    voiceId: "Chinese (Mandarin)_Warm_Girl",
    modelConfig: { protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.voice_setting.voice_id, "Chinese (Mandarin)_Warm_Girl");
  assert.equal(calls[0].body.model, "speech-2.8-hd");
});

test("OpenAI 兼容协议会把音色放进 audio.voice", async () => {
  const { ctx, calls } = captureVoiceRequest({ choices: [{ message: { audio: { data: "68656c6c6f" } } }] });
  await synthesizeVoice(ctx, {
    text: "你好呀。",
    voiceId: "mimo_default",
    modelConfig: { protocol: "chat", providerId: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.audio.voice, "mimo_default");
  assert.match(calls[0].url, /\/chat\/completions$/);
});

test("乱填的音色会落回该模型的默认音色，而不是发个无效值", async () => {
  const { ctx, calls } = captureVoiceRequest({ data: { audio: "68656c6c6f" } });
  await synthesizeVoice(ctx, {
    text: "你好呀。",
    voiceId: "这不是音色 id??",
    modelConfig: { protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.voice_setting.voice_id, "Chinese (Mandarin)_Reliable_Executive");
});

test("自己克隆/设计出来的音色 ID 不会被换成默认嗓子", async () => {
  const { ctx, calls } = captureVoiceRequest({ data: { audio: "68656c6c6f" } });
  await synthesizeVoice(ctx, {
    text: "你好呀。",
    voiceId: "ttv-voice-2025060717322425-abc123",
    modelConfig: { protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.voice_setting.voice_id, "ttv-voice-2025060717322425-abc123");
});

test("合成请求带上语言识别与字幕开关", async () => {
  const { ctx, calls } = captureVoiceRequest({ data: { audio: "68656c6c6f" } });
  await synthesizeVoice(ctx, {
    text: "你好呀。",
    voiceId: "Chinese (Mandarin)_Warm_Girl",
    modelConfig: { protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.language_boost, "auto");
  assert.equal(calls[0].body.subtitle_enable, true);
  assert.equal(calls[0].body.subtitle_type, "word");
});

test("文字里的笑、叹气和小停顿会被翻译成官方记号", () => {
  assert.equal(applyVoiceDelivery("哈哈哈你终于肯理我了"), "哈哈哈(laughs)你终于肯理我了");
  assert.equal(applyVoiceDelivery("嘿嘿，我等着呢"), "嘿嘿(chuckle)，我等着呢");
  assert.equal(applyVoiceDelivery("唉，你今天都不理我"), "(sighs)，你今天都不理我");
  // 关掉就干净念，不能还偷偷加记号
  assert.equal(applyVoiceDelivery("哈哈哈你终于肯理我了", { enabled: false }), "哈哈哈你终于肯理我了");
});

test("不认识的半角括号会被扯掉，写错一个标签整条合成就废了", () => {
  // MiniMax 的记号是半角括号；中文圆括号它只当普通文字念出来，保持原样。
  assert.equal(stripUnknownVoiceTags("嘿嘿(wow) (laughs) 好"), "嘿嘿 (laughs) 好");
  assert.equal(stripUnknownVoiceTags("(laughs)"), "(laughs)");
  assert.equal(stripUnknownVoiceTags("（小声）你好"), "（小声）你好");
});

test("官方字幕换了字段名也要认出来，词级明细优先", () => {
  // 真机返回用的是 time_begin / time_end，逐词时间在 timestamped_words 里。
  const raw = JSON.stringify([
    {
      text: "哟，终于",
      time_begin: 0,
      time_end: 1200,
      timestamped_words: [
        { word: "哟", time_begin: 0, time_end: 128 },
        { word: "，", time_begin: 128, time_end: 170 },
        { word: "终", time_begin: 170, time_end: 853 },
      ],
    },
  ]);
  assert.deepEqual(parseSubtitleFile(raw), [
    { start: 0, end: 128, text: "哟" },
    { start: 128, end: 170, text: "，" },
    { start: 170, end: 853, text: "终" },
  ]);
});

test("没有逐词明细就退回整段，老的字段名照旧认", () => {
  const raw = JSON.stringify([{ text: "你好呀", begin_time: 0, end_time: 500 }]);
  assert.deepEqual(parseSubtitleFile(raw), [{ start: 0, end: 500, text: "你好呀" }]);
});

test("叹词和停顿各归各，不互相挤掉", () => {
  const out = applyVoiceDelivery("哈哈哈，我今天把屋子收拾了一遍，窗台那盆绿萝终于缓过来了，看着它我就高兴。");
  assert.match(out, /\(laughs\)/);
  assert.equal((out.match(/<#/g) || []).length, 1);
});

test("长句中间会留半拍停顿，短句不加", () => {
  const long = "我今天把屋子收拾了一遍，窗台那盆绿萝终于缓过来了，看着它我就高兴。";
  assert.match(applyVoiceDelivery(long), /<#0\.\d+#>/);
  assert.doesNotMatch(applyVoiceDelivery("我来啦，等我一下。"), /<#/);
  // 已经有停顿的别再插
  assert.equal((applyVoiceDelivery(long).match(/<#/g) || []).length, 1);
});

test("原话切句后能按字数摊到时长上", () => {
  const chunks = speakableChunks("我来了，你吃了吗？今天天气真好。");
  assert.deepEqual(chunks.map((item) => item.text), ["我来了，你吃了吗？", "今天天气真好。"]);
  const spans = chunkTimings(chunks, 6000);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, 6000);
  assert.ok(spans[0].end <= spans[1].start);
  // 时长拿不到就不硬编时间，前端自然不高亮
  assert.deepEqual(chunkTimings(chunks, 0), []);
});

test("字幕解析认 JSON 与 SRT，认不出来就说没有", () => {
  assert.deepEqual(
    parseSubtitleFile(JSON.stringify([{ begin_time: 0, end_time: 500, text: "你好" }])),
    [{ start: 0, end: 500, text: "你好" }],
  );
  assert.deepEqual(
    parseSubtitleFile("1\n00:00:00,000 --> 00:00:01,000\n你好呀\n"),
    [{ start: 0, end: 1000, text: "你好呀" }],
  );
  assert.equal(parseSubtitleFile("随便一段看不懂的东西"), null);
  assert.equal(parseSubtitleFile(""), null);
});

test("音色目录按语言分组，官方目录里新补的机甲音也在", () => {
  const groups = voiceGroupsForModel({ protocol: "t2a" });
  assert.ok(groups.length > 1);
  assert.ok(groups.every((group) => group.id && group.label && group.voices.length));
  assert.ok(groups.some((group) => group.voices.some((item) => item.id === "Robot_Armor")));
  // 扁平目录和分组必须是同一份，不能对不上
  assert.equal(
    groups.flatMap((group) => group.voices.map((item) => item.id)).join("|"),
    voiceChoicesForModel({ protocol: "t2a" }).map((item) => item.id).join("|"),
  );
});

test("MiMo 使用 api-key，MiniMax 继续使用 Bearer", () => {
  assert.deepEqual(voiceRequestHeaders({ providerId: "mimo" }, "mimo-key"), { "api-key": "mimo-key" });
  assert.deepEqual(voiceRequestHeaders({ model: "mimo-v2.5-tts" }, "mimo-key"), { "api-key": "mimo-key" });
  assert.deepEqual(voiceRequestHeaders({ providerId: "minimax" }, "max-key"), { Authorization: "Bearer max-key" });
});

test("已保护的 Key 再保存时保持原值，不重复套 DPAPI", async () => {
  const stored = "dpapi:already-protected";
  assert.equal(await protectKey(stored), stored);
});

test("系统加密用不上时要报出真实状态，不静默装没事", async () => {
  const plain = "sk-plain-123";
  const out = await protectKey(plain);
  if (out.startsWith("dpapi:")) {
    assert.equal(encryptionAvailable(), true, "加密成功时状态必须是成功的");
    assert.equal(await unprotectKey(out), plain);
  } else {
    assert.equal(out, plain, "加密失败只能交出原值，不能变成乱码");
    assert.equal(encryptionAvailable(), false);
    assert.match(encryptionStatus().reason, /\S/, "失败必须留下原因");
  }
});

test("判断一条 Key 到底有没有被系统加密保护", async () => {
  assert.equal(isProtectedKey("dpapi:abc"), true);
  assert.equal(isProtectedKey("sk-cp-abc"), false);
  assert.equal(isProtectedKey(""), false);
});

test("音色列表跟着朗读模型切换，MiniMax 不再展示旧 female-shaonv", () => {
  const minimax = voiceChoicesForModel({ protocol: "t2a", model: "speech-2.8-hd" });
  assert.ok(minimax.some((item) => item.id === "Chinese (Mandarin)_Warm_Girl"));
  assert.equal(minimax.some((item) => item.id === "female-shaonv"), false);
  assert.equal(minimax.find((item) => item.id === "Chinese (Mandarin)_Sincere_Adult")?.name, "真诚青年");
  assert.equal(minimax.find((item) => item.id === "Chinese (Mandarin)_Gentle_Senior")?.name, "温柔学姐");
  assert.equal(defaultVoiceIdForModel({ protocol: "t2a", model: "speech-2.8-hd" }), "Chinese (Mandarin)_Reliable_Executive");
  const mimo = voiceChoicesForModel({ providerId: "mimo", model: "mimo-v2.5-tts" });
  assert.ok(mimo.some((item) => item.id === "mimo_default"));
  assert.ok(mimo.some((item) => item.id === "冰糖"));
});

test("MiniMax 新版 API Key 可省略 GroupId，旧账号仍会带上", () => {
  assert.equal(buildT2aUrl("https://api.minimaxi.com", ""), "https://api.minimaxi.com/v1/t2a_v2");
  assert.equal(buildT2aUrl("https://api.minimaxi.com/", " 123 "), "https://api.minimaxi.com/v1/t2a_v2?GroupId=123");
});

test("伙伴语音清洗掉表情标记和动作描写，但保留正常正文", () => {
  assert.equal(cleanVoiceText("等下哈\n*低头找耳机*\n[表情:开心]"), "等下哈");
});

test("识别当下的语音点播，不把长期偏好当成立即请求", () => {
  assert.equal(isExplicitVoiceRequest("那你发个语音我再听听？"), true);
  assert.equal(isExplicitVoiceRequest("请用语音回复我"), true);
  assert.equal(isExplicitVoiceRequest("我喜欢你发语音，以后多发点哦"), false);
  assert.equal(isExplicitVoiceRequest("今天不要发语音"), false);
});

test("伙伴语音默认受全局开关和伙伴开关双重控制", () => {
  const args = {
    globalSettings: { voiceEnabled: false },
    partnerSettings: { enabled: true, voiceId: "female-shaonv", tier: "often" },
    text: "我先跟你说一声，马上回来。",
    random: () => 0,
  };
  assert.equal(shouldGenerateVoice(args).reason, "global-disabled");
  assert.equal(shouldGenerateVoice({ ...args, globalSettings: { voiceEnabled: true }, partnerSettings: { enabled: false } }).reason, "partner-disabled");
});

test("伙伴语音只接受短的整轮回复，长回复不机械切音频", () => {
  const base = {
    globalSettings: { voiceEnabled: true },
    partnerSettings: { enabled: true, voiceId: "female-shaonv", tier: "often" },
    runtime: {},
    random: () => 0,
  };
  assert.equal(shouldGenerateVoice({ ...base, text: "这是一段很长很长的回复。".repeat(30) }).reason, "too-long");
  assert.equal(shouldGenerateVoice({ ...base, text: "第一句。第二句。第三句。第四句。" }).reason, "too-many-sentences");
  assert.equal(shouldGenerateVoice({ ...base, text: "我马上回来找你哈。" }).ok, true);
});

test("明确点播绕过主动语音开关、关系限制、额度、冷却与连续发送护栏", () => {
  const result = shouldGenerateVoice({
    globalSettings: { voiceEnabled: false },
    partnerSettings: { enabled: false, tier: "rare", voiceId: "female-shaonv" },
    runtime: { voiceDay: "2026-09-24", voiceSentToday: 6, lastVoiceAt: new Date().toISOString(), consecutiveVoiceReplies: 1 },
    text: "阿舟今天乖惨了，我给你发一条语音。",
    voicePolicy: { allowed: false, hardBlocked: true },
    requested: true,
    now: new Date("2026-09-24T10:00:00+08:00"),
    random: () => 0.99,
  });
  assert.equal(result.ok, true);
  assert.equal(result.layer, "requested");
  assert.equal(result.requested, true);
});

test("伙伴语音有每日上限、冷却和连续发送护栏", () => {
  const base = {
    globalSettings: { voiceEnabled: true },
    partnerSettings: { enabled: true, voiceId: "female-shaonv", tier: "rare" },
    text: "我马上回来找你哈。",
    random: () => 0,
  };
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.equal(shouldGenerateVoice({ ...base, runtime: { voiceDay: todayKey, voiceSentToday: 1 } }).reason, "daily-limit");
  assert.equal(shouldGenerateVoice({ ...base, runtime: { lastVoiceAt: new Date(Date.now() - 30 * 60_000).toISOString() } }).reason, "cooldown");
  assert.equal(shouldGenerateVoice({ ...base, runtime: { consecutiveVoiceReplies: 1 } }).reason, "consecutive");
});

test("语音策略使用真实关系形状，关系只增加软额度", () => {
  const policy = resolveVoicePolicy({ tier: "sometimes", relationship: closeRelationship(), personality: { tags: ["热情"] }, random: () => 0.9 });
  assert.equal(policy.normalMax, 2);
  assert.equal(policy.exceptionExtraMax, 0);
  assert.equal(policy.hardMax, 6);
  assert.equal(policy.exceptionChance, 0);
});

test("canonical voice deny 在任意随机值下都阻断", () => {
  const policy = resolveVoicePolicy({
    relationship: closeRelationship(),
    guides: [canonicalGuide({
      id: "voice-deny",
      meaning: "不要给我发语音",
      kind: "boundary",
      claims: [{ target: "voice.frequency", effect: "deny", value: "none" }],
    })],
  });
  for (const roll of [0, 0.25, 0.999]) {
    const result = shouldGenerateVoice({
      globalSettings: { voiceEnabled: true },
      partnerSettings: { enabled: true, tier: "often", voiceId: "female-shaonv" },
      text: "我马上回来找你哈。",
      voicePolicy: policy,
      random: () => roll,
    });
    assert.equal(result.reason, "policy-denied");
    assert.equal(result.layer, "hard");
  }
});

test("canonical more / baseline / less 单调改变语音软空间", () => {
  const relationship = closeRelationship();
  const more = resolveVoicePolicy({ tier: "sometimes", relationship, guides: [canonicalGuide({ claims: [{ target: "voice.frequency", effect: "prefer", value: "more" }] })] });
  const baseline = resolveVoicePolicy({ tier: "sometimes", relationship });
  const less = resolveVoicePolicy({ tier: "sometimes", relationship, guides: [canonicalGuide({ claims: [{ target: "voice.frequency", effect: "prefer", value: "less" }] })] });
  assert.ok(more.normalChance > baseline.normalChance);
  assert.ok(baseline.normalChance > less.normalChance);
  assert.equal(more.exceptionExtraMax, 1);
  assert.equal(baseline.exceptionExtraMax, 0);
  assert.equal(less.exceptionExtraMax, 0);
  assert.ok(more.exceptionCooldownFloor < baseline.exceptionCooldownFloor);
  assert.ok(less.normalCooldownMinutes >= baseline.normalCooldownMinutes);
});

test("负反馈只封住关系破例额度，emerging / settled 逐级反哺普通语音", () => {
  const guide = canonicalGuide({ claims: [{ target: "voice.frequency", effect: "prefer", value: "more" }] });
  const baseline = resolveVoicePolicy({ tier: "sometimes", relationship: closeRelationship(), guides: [guide] });
  const blocked = resolveVoicePolicy({ tier: "sometimes", relationship: closeRelationship(), guides: [guide], runtime: { negativeFeedbackBehaviors: ["voice.frequency"] } });
  const emerging = resolveVoicePolicy({ tier: "sometimes", runtime: { habitStates: { "voice.frequency": "emerging" } } });
  const settled = resolveVoicePolicy({ tier: "sometimes", runtime: { habitStates: { "voice.frequency": "settled" } } });
  assert.equal(blocked.exceptionExtraMax, 0);
  assert.equal(blocked.exceptionChance, 0);
  assert.equal(blocked.normalMax, baseline.normalMax);
  assert.ok(emerging.normalChance > resolveVoicePolicy({ tier: "sometimes" }).normalChance);
  assert.ok(settled.normalChance > emerging.normalChance);
  assert.ok(settled.normalMax > emerging.normalMax);
});

test("达到 normal quota 后，只有 exception 软额度能继续，且不超过 hardMax", () => {
  const policy = { normalMax: 2, exceptionExtraMax: 1, hardMax: 6, normalChance: 1, exceptionChance: 1, normalCooldownMinutes: 90, exceptionCooldownFloor: 30 };
  const args = { globalSettings: { voiceEnabled: true }, partnerSettings: { enabled: true, tier: "sometimes", voiceId: "female-shaonv" }, text: "我马上回来找你哈。", voicePolicy: policy, now: new Date("2026-09-22T14:00:00+08:00"), random: () => 0 };
  assert.equal(shouldGenerateVoice({ ...args, runtime: { voiceDay: "2026-09-22", voiceSentToday: 2 } }).ok, true);
  assert.equal(shouldGenerateVoice({ ...args, runtime: { voiceDay: "2026-09-22", voiceSentToday: 3 } }).reason, "daily-limit");
});

test("伙伴语音运行账本会递增，普通文字会打断连续语音计数", () => {
  const next = nextVoiceRuntime({}, { voiceId: "female-shaonv" }, new Date("2026-09-21T14:00:00+08:00"));
  assert.equal(next.voiceSentToday, 1);
  assert.equal(next.consecutiveVoiceReplies, 1);
  assert.equal(next.voicePending, true);
  assert.equal(nextTextRuntime(next).consecutiveVoiceReplies, 0);
});

test("用户点播语音不消耗主动额度、冷却时间或连续发送状态", () => {
  const runtime = { voiceDay: "2026-09-24", voiceSentToday: 2, lastVoiceAt: "2026-09-24T01:00:00.000Z", consecutiveVoiceReplies: 0 };
  assert.deepEqual(nextVoiceRuntime(runtime, { requested: true, voiceId: "female-shaonv" }), { ...runtime, voicePending: false });
});
