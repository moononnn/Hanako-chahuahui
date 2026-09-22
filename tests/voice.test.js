import test from "node:test";
import assert from "node:assert/strict";
import { protectKey } from "../lib/crypto.js";
import { canonicalGuide, closeRelationship } from "./helpers/adaptation.js";
import {
  cleanVoiceText,
  nextTextRuntime,
  nextVoiceRuntime,
  shouldGenerateVoice,
  resolveVoicePolicy,
  normalizeVoiceModelConfig,
  voiceChoicesForModel,
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
  assert.deepEqual(VOICE_PRESETS.map((item) => item.id), ["minimax", "mimo", "openai"]);
  assert.equal(VOICE_PRESETS[0].protocol, "t2a");
  assert.equal(VOICE_PRESETS[0].baseUrl, "https://api.minimaxi.com");
  assert.equal(VOICE_PRESETS[1].baseUrl, "https://api.xiaomimimo.com/v1");
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

test("目录里没有的音色会落回该模型的默认音色，而不是发个无效值", async () => {
  const { ctx, calls } = captureVoiceRequest({ data: { audio: "68656c6c6f" } });
  await synthesizeVoice(ctx, {
    text: "你好呀。",
    voiceId: "female-shaonv",
    modelConfig: { protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd", apiKey: "plain-key" },
  });
  assert.equal(calls[0].body.voice_setting.voice_id, "Chinese (Mandarin)_Reliable_Executive");
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
