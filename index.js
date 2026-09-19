import fs from "node:fs";
import path from "node:path";

import { splitReply } from "./lib/split.js";
import { planTurn, DEFAULT_RHYTHM } from "./lib/rhythm.js";
import { loadPersona, renderPersona } from "./lib/persona.js";
import { resolveUserDisplayName } from "./lib/host-user.js";
import { isValidPartnerId } from "./lib/partner-id.js";
import {
  applyVerdictToDraft,
  buildDerivativePrompt,
  buildDraftColorsPrompt,
  buildEvidencePrompt,
  buildPalettePrompt,
  buildRefillPrompt,
  buildReplaceTestPrompt,
  buildSelfPortraitPrompt,
  flattenDraftRows,
  normalizeColorPalette,
  normalizePortrait,
  normalizeDerivatives,
  normalizeDraftColors,
  parseEvidence,
  parseJsonLoose,
  parseReplaceTest,
  summarizeDraft,
  summarizeRun,
} from "./lib/analyze.js";
import { hasPalette, isPaletteDone, normalizePalette, paletteToText } from "./lib/palette.js";
import { createAvatarReader, toBytes } from "./lib/avatar.js";
import { buildSystemPrompt, identityBlock, replyChoiceBlock, shouldQuietClose, threadToMessages } from "./lib/prompt.js";
import { buildAmbientContextText, buildDaybookText, daybookHash, readDaybook, shouldRevealDaybook } from "./lib/daybook.js";
import { spokenClock, timeBlock } from "./lib/clock.js";
import { askUtility, generateReply, normalizeModelRef, chatModelOptions, visionModelOptions, resolveModelChoice } from "./lib/model.js";
import { createStore, createDiagnostics } from "./lib/store.js";
import { listBackgrounds, readBackgroundBytes, writeBackground, removeBackgroundFile, normalizeOpacity, normalizeTone, isBackgroundFile, fileTypeOf } from "./lib/background.js";
import {
  DEFAULT_CONTEXT,
  buildMemoryBlock,
  conversationMessages,
  isConversationMessage,
  makeArchiveEntry,
  planRollup,
  renderForSummary,
  splitForContext,
} from "./lib/memory.js";
import { dailySpec, isProfileIdentitySafe, profileSpec, runSummary, segmentSpec } from "./lib/summarize.js";
import { buildWorkfeedText, normalizeWorkEvent } from "./lib/workfeed.js";
import { buildFactSpec, parseFactsResult } from "./lib/facts.js";
import { dayKey } from "./lib/days.js";
import { advanceRelationship, disclosureRatio, mergeRelationship, relationshipNote, SEED_PICK_TIERS, SEED_TIER_IDS, seedByPick, seedFromTrace, traceSizeFromFiles, zeroSeed } from "./lib/relationship.js";
import {
  PERSONALITY_PRESETS,
  TEMPERAMENT_TAGS,
  addHobby,
  applyPersonalityPreset,
  buildDraftMaterial,
  buildKnowingText,
  hasPersonality,
  needsNativeInterestRefresh,
  replaceBornHobbies,
  layerTagProblem,
  normalizePersonality,
  parseDraftReply,
  personalityDraftSpec,
  personalityStanding,
  tagProblemText,
} from "./lib/knowing.js";
import {
  bornHobbySpec,
  canGrow,
  grownHobbySpec,
  nativeInterestSeed,
  parseHobbyReply,
  parseNativeHobbyReply,
  validateNativeHobbies,
} from "./lib/growth.js";
import { cleanVoice, inspectVoice, isAbstractOnlyProactive, isLowSignalProactive, isNoReply, isUsableVoice, nightSpec, proactiveSpec } from "./lib/compose.js";
import { searchTimelyTopic } from "./lib/topic-search.js";
import {
  buildCatalog,
  buildStickerHint,
  encodeStickerBubble,
  hasUsableTags,
  isStickerBubble,
  parseStickerMarker,
  pickSticker,
  readCatalog,
  readCatalogWithReason,
  readStickerBytes,
  recentStickerIds,
  readSourceCatalog,
  sourceRowById,
  stickerLabelMap,
  stickerLabelText,
} from "./lib/stickers.js";
import {
  createStickerGroup,
  importStickerBytes,
  listStickerLibrary,
  readOwnSticker,
  readStickerLibrary,
  removeSticker,
  removeStickerGroup,
} from "./lib/sticker-library.js";
import { canAnswerPoke } from "./lib/poke.js";
import { effectiveVisionConfig, imageBytesMatchMime, isStrictBase64, normalizeVisionConfig } from "./lib/vision.js";
import {
  RECOGNITION_QUESTIONS,
  applyRecognitionAnswer,
  applyRecognitionDraft,
  emptyRecognition,
  isRecognitionComplete,
  parseRecognitionSuggestions,
  questionById,
  recognitionSuggestionSpec,
  recognitionForResume,
  sanitizeSuggestions,
} from "./lib/recognition.js";
import { inspectPersona, renderDossier } from "./lib/persona-standard.js";
import {
  MAX_SUGGESTIONS,
  applySuggestions,
  chatSpec,
  commitChange,
  describeChange,
  diagnosisSpec,
  emptySession,
  listHistory,
  mergeSuggestions,
  normalizeSession,
  parseChatReply,
  parseDiagnosis,
  revertTo,
  touchSession,
} from "./lib/persona-review.js";
import { activePanelSeenAt, applyPresence, PANEL_OPEN_MS, bannerText, mergeBatch, shouldAnnounce } from "./lib/notify.js";
import {
  ACTION_STYLES,
  ACTION_VOICE,
  actionLabel,
  actionTailFromTemplate,
  actionTemplateFromTail,
  actionTemplateSpec,
  cleanActionTemplate,
  fallbackActionTemplate,
  isSafeActionText,
  isValidActionTemplate,
  needsRotation,
  nextRotationAt,
  parseToneReply,
  readMyTemplateEntry,
  readStyleId,
  readTemplateEntry,
  renderActionLine,
} from "./lib/actions.js";
import { SLEEP_SHAPE, baseHoursFor, dozingNow, isSleepSet, parseSleep, sleepSpec, sleepWindows } from "./lib/sleep.js";
import { DOZE_SLOWDOWN, mergeDueAt, planReply } from "./lib/reply.js";
import { recallEligibility, shouldCancelScheduledReply } from "./lib/recall.js";
import {
  dailyKey,
  decideForm,
  dueNow,
  gateCheck,
  isDirectReplyToProactive,
  isRepeatedPhrasing,
  noteSent,
  proactiveDelayFactor,
  proactiveSilenceContext,
  wakeEchoFor,
  quietNow,
  scheduleNext,
  stageIntent,
  takeIntent,
  windowStartDate,
} from "./lib/proactive.js";
import {
  correctionsFor,
  noteReview,
  noteWatch,
  reviewDue,
  reviewSpec,
  watchSummary,
} from "./lib/selfwatch.js";
import {
  MAX_NUDGE_BUBBLES,
  nudgeDelay,
  nudgeSpec,
  parseNudgeChoice,
  planNudge,
  temperamentOf,
} from "./lib/awaiting.js";
import {
  advanceTopics,
  correctTopic,
  dropTopic,
  existingTitles,
  markTopicUsed,
  mergeTopics,
  parseTopics,
  pickTopic,
  pruneTopics,
  refreshUsedTopics,
  topicSpec,
} from "./lib/topics.js";

export const name = "chahuahui";

/** 版本号从 manifest.json 读，不写死在代码里——写死过，日志骗了我一次。 */
function readManifestVersion() {
  try {
    const raw = fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const version = readManifestVersion();

const PERSONA_TTL_MS = 10 * 60 * 1000;
/**
 * 用户的名字：启动时从这台机器的配置里读，**不写死**。
 * 分享版换个人装，ta 的伙伴要叫的就是那个人自己的名字——叫错了比不说话更伤。
 * 读不到就退回一个中性称呼：宁可叫得平淡，也不能把人叫错。
 */
let USER_NAME = "对方";
const USER_NAME_FALLBACK = "对方";
/** 头像图片的读取范围：伙伴的、她自己的 */
const AVATAR_TTL_MS = 5 * 60 * 1000;

function describeError(error) {
  if (error == null) return { message: "null/undefined error" };
  if (typeof error === "string") return { message: error };
  return { name: error.name ?? null, message: error.message ?? String(error), code: error.code ?? null };
}

/**
 * 内测入口总开关。
 *
 * 本地正式版开着：`/probe`、`/probe/taste`、`/analyze/personality`、`/notify/test`、
 * `/proactive/tick`（手动催一次主动巡检）和三个内测工具，
 * 验收时要拿它们摆档位、冒提醒、催一条主动消息、看链路通不通。
 *
 * **发布副本构建时把它改成 false**，把这一整面关掉——这些入口能触发模型调用和后台写盘，
 * 不该暴露给只是装着玩的人（数据与流程上看，它们对普通使用者也毫无意义）。
 */
// 发布副本里整面关掉：这些口子能触发模型调用和后台写盘，不该暴露给只是装着玩的人。
// 本地验收要摆档位、吹提醒时，改回 true 再用。
const DEV_TOOLS = false;

export function apply(ctx) {
  const diagnostics = createDiagnostics(ctx.dataDir);
  const store = createStore(ctx.dataDir);

  function globalSettingsView() {
    const global = store.getGlobalSettings();
    return {
      ...global,
      effectiveUserName: USER_NAME,
      myActionTail: actionTailFromTemplate(readMyTemplateEntry(global)),
    };
  }

  /** 今日情境这一项她自己开了没（没开就不读拾光记，一个字都不带）。 */
  function daybookOn() {
    return store.getGlobalSettings().daybookEnabled === true;
  }

  /** 电脑端生活联动开着没（关了就一条都不收）。 */
  function workfeedOn() {
    return store.getGlobalSettings().workfeedEnabled !== false;
  }

  /**
   * 拾光记装了没有：只认它摊出来的东西，两条探针能读到任一条就算装。
   *
   * 【隐式约定，改路径必须两边同步】今日情境的快照位置是茶话会与拾光记之间的约定：
   * 拾光记写进自己的数据目录（plugins 目录之外），茶话会从 ctx.dataDir 往上退两层再拼
   * `plugin-data/shiguangji/public-today.json`；探针里的 `plugins/shiguangji/manifest.json`
   * 只是用来区分“根本没装”。哪一天谁挪了目录，两边会对不上且静默失效，改这里务必同步拾光记那边。
   */
  async function shiguangjiInstalled() {
    const home = path.dirname(path.dirname(String(ctx.dataDir ?? "")));
    if (!home) return false;
    const probes = [
      path.join(home, "plugins", "shiguangji", "manifest.json"),
      path.join(home, "plugin-data", "shiguangji", "public-today.json"),
    ];
    for (const file of probes) {
      try {
        const result = await ctx.resources.read({ kind: "local-file", path: file });
        const text = typeof result?.content === "string"
          ? result.content
          : (result?.content ? Buffer.from(result.content).toString("utf8") : "");
        if (text) return true;
      } catch {
        /* 换下一条探针 */
      }
    }
    return false;
  }

  function normalizeGlobalSettingsPatch(input) {
    const patch = { ...(input ?? {}) };
    if (Object.prototype.hasOwnProperty.call(patch, "myActionTail")) {
      patch.myAction = { text: actionTemplateFromTail(patch.myActionTail) };
      delete patch.myActionTail;
    }
    // 模型那一格：null 是“跟随当前模型”，其余形状不对就当没设
    if (Object.prototype.hasOwnProperty.call(patch, "model")) {
      patch.model = normalizeModelRef(patch.model);
    }
    // 认识用哪条：null 是跟默认那条，其余形状不对就当没设
    if (Object.prototype.hasOwnProperty.call(patch, "recognitionModel")) {
      patch.recognitionModel = normalizeModelRef(patch.recognitionModel);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "userNameOverride")) {
      const name = String(patch.userNameOverride ?? "").trim().slice(0, 40);
      patch.userNameOverride = name || null;
    }
    // 今日情境：只收真布尔，别让 "false" 这种字符串混成真值
    if (Object.prototype.hasOwnProperty.call(patch, "daybookEnabled")) {
      patch.daybookEnabled = patch.daybookEnabled === true;
    }
    // 电脑端生活联动：同样只收真布尔
    if (Object.prototype.hasOwnProperty.call(patch, "workfeedEnabled")) {
      patch.workfeedEnabled = patch.workfeedEnabled === true;
    }
    return patch;
  }

  /** 伙伴设置里只挑形状对的模型透进去，别把脏东西写进账本。 */
  function normalizePartnerSettingsPatch(body) {
    const patch = { ...(body ?? {}) };
    if (Object.prototype.hasOwnProperty.call(patch, "model")) {
      patch.model = normalizeModelRef(patch.model);
    }
    return patch;
  }

  let appDir = process.cwd();
  try {
    appDir = path.dirname(
      decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    );
  } catch {
    /* 保底用 cwd */
  }
  const guessedHanaHome = path.resolve(appDir, "..", "..");
  /**
   * 导图时每次并行取几张的字节。
   * 一次取字节是一次宿主往返（实测约 160~190ms），一百张排着队就是十几二十秒，
   * 她在那边什么都看不见。分批并行把这道等待压到一两秒。（落盘仍按顺序来）
   */
  const IMPORT_READ_CONCURRENCY = 6;
  const agentsRoot = path.join(guessedHanaHome, "agents");
  const userRoot = path.join(guessedHanaHome, "user");

  const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
  const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const attachmentsDir = path.join(ctx.dataDir, "v2", "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  /**
   * 附件总量闸：单张 10MB 管住了，总量也得管，不然反复发图能把数据目录撑满。
   * 超了只拒新的，并告诉她用了多少——**不偷偷删老图**（删了她翻记录会看到裂图）。
   */
  const ATTACHMENT_TOTAL_BYTES = 500 * 1024 * 1024;
  function attachmentDirBytes() {
    let total = 0;
    try {
      for (const name of fs.readdirSync(attachmentsDir)) {
        try { total += fs.statSync(path.join(attachmentsDir, name)).size; } catch { /* 读不到的跳过 */ }
      }
    } catch { /* 目录还没建 */ }
    return total;
  }

  function attachmentPath(id) {
    return path.join(attachmentsDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`);
  }

  function readAttachment(id, expectedAgentId = null) {
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const metaPath = path.join(attachmentsDir, `${safeId}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (expectedAgentId && meta.agentId !== expectedAgentId) return null;
      const data = fs.readFileSync(attachmentPath(safeId));
      return { ...meta, data };
    } catch {
      return null;
    }
  }

  function saveAttachment({ name, mimeType, data, agentId }) {
    const cleanType = String(mimeType ?? "").toLowerCase();
    if (!ATTACHMENT_TYPES.has(cleanType)) throw new Error("只支持 PNG、JPG、GIF 和 WebP 图片");
    const raw = String(data ?? "").replace(/^data:[^,]+,/, "");
    if (!isStrictBase64(raw)) throw new Error("图片数据格式不正确");
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length || bytes.length > ATTACHMENT_MAX_BYTES) throw new Error("图片太大了，单张上限 10MB");
    // 单张管住了，总量也得管。
    const usedBytes = attachmentDirBytes();
    if (usedBytes + bytes.length > ATTACHMENT_TOTAL_BYTES) {
      throw new Error(`图片存得太多了（已经用了约 ${Math.round(usedBytes / 1048576)} MB），先删掉一些老对话里的图片再发`);
    }
    if (!imageBytesMatchMime(bytes, cleanType)) throw new Error("图片内容与文件类型不一致");
    const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const binPath = attachmentPath(safeId);
    const metaPath = path.join(attachmentsDir, `${safeId}.json`);
    const binTemp = `${binPath}.tmp_${process.pid}_${Date.now()}`;
    const metaTemp = `${metaPath}.tmp_${process.pid}_${Date.now()}`;
    const meta = { id: safeId, agentId: String(agentId ?? ""), name: String(name ?? "图片").trim().slice(0, 120) || "图片", mimeType: cleanType, size: bytes.length, at: new Date().toISOString() };
    try {
      fs.writeFileSync(binTemp, bytes);
      fs.renameSync(binTemp, binPath);
      fs.writeFileSync(metaTemp, JSON.stringify(meta, null, 2), "utf8");
      fs.renameSync(metaTemp, metaPath);
      return { ...meta, data: bytes };
    } catch (error) {
      for (const file of [binTemp, metaTemp, binPath, metaPath]) {
        try { fs.rmSync(file, { force: true }); } catch { /* 回滚失败仍把原错误抛给上层 */ }
      }
      throw error;
    }
  }

  function removeAttachment(id) {
    for (const file of [attachmentPath(id), path.join(attachmentsDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)]) {
      try { fs.rmSync(file, { force: true }); } catch { /* 临时附件清理失败不影响聊天 */ }
    }
  }

  async function describeImage(modelRef, attachment) {
    const ref = normalizeModelRef(modelRef);
    if (!ref || !attachment?.data) throw new Error("识图模型不可用");
    const requestId = `chahuahui_image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    // 用完就释放：识图失败或中断时别让请求一直挂在模型那一侧
    // （文字那条路早就在 finally 里 cancel 了，识图这处漏了）。
    try {
      return await describeImageOnce(ref, attachment, requestId);
    } finally {
      try {
        await ctx.models.cancel(requestId);
      } catch (error) {
        diagnostics({ event: "models.cancel.failed", error: describeError(error) });
      }
    }
  }

  async function describeImageOnce(ref, attachment, requestId) {
    const response = await ctx.models.stream({
      requestId,
      provider: ref.provider,
      model: ref.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请用简洁中文描述这张图片：主要对象、动作、氛围、可见文字；不确定的内容请标明不确定。只输出图片说明。" },
          { type: "image", mimeType: attachment.mimeType, data: attachment.data.toString("base64") },
        ],
      }],
      maxTokens: 500,
      temperature: 0.2,
    });
    const raw = typeof response?.text === "function" ? await response.text() : "";
    let text = "";
    for (const line of String(raw).split(/\r?\n/)) {
      try {
        const row = JSON.parse(line);
        if (row.type === "error") throw new Error(row.message || "识图模型调用失败");
        if (row.type === "text-delta") text += String(row.delta ?? "");
        if (row.type === "done" && !text && Array.isArray(row.assistant?.content)) {
          text = row.assistant.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    if (!text.trim()) throw new Error("识图模型没有返回图片说明");
    return text.trim().slice(0, 4000);
  }

  async function testVisionModel(modelRef) {
    const ref = normalizeModelRef(modelRef);
    if (!ref) return { ok: false, error: { message: "识图模型引用不完整", code: "VISION_MODEL_MISSING" } };
    const imagePath = path.join(appDir, "assets", "icon.png");
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const requestId = `chahuahui_vision_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const response = await ctx.models.stream({
        requestId,
        provider: ref.provider,
        model: ref.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "请只回答：识图测试通过。不要描述图片，不要补充其他内容。" },
            { type: "image", mimeType: "image/png", data: imageData },
          ],
        }],
        maxTokens: 40,
        temperature: 0,
      });
      const raw = typeof response?.text === "function" ? await response.text() : "";
      let text = "";
      const errorLine = String(raw).split(/\r?\n/).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).find((row) => row?.type === "error");
      if (errorLine) return { ok: false, error: { message: errorLine.message || "识图模型调用失败", code: errorLine.code || "VISION_PROVIDER_ERROR" } };
      for (const line of String(raw).split(/\r?\n/)) {
        try {
          const row = JSON.parse(line);
          if (row.type === "text-delta") text += String(row.delta ?? "");
          if (row.type === "done" && !text && Array.isArray(row.assistant?.content)) {
            text = row.assistant.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
          }
        } catch { /* 非 JSON 行不是成功凭据 */ }
      }
      if (!text.trim()) return { ok: false, error: { message: "识图模型没有返回内容", code: "VISION_EMPTY_RESPONSE" } };
      if (!/识图测试通过/.test(text)) return { ok: false, error: { message: "模型没有按识图测试协议确认图片输入", code: "VISION_TEST_UNCONFIRMED" } };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      // 测试没通过也别把请求挂在那里。
      try {
        await ctx.models.cancel(requestId);
      } catch { /* 取消失败不影响测试结果 */ }
    }
  }

  /**
   * 把用户的名字读回来。读盘是异步的，但第一轮聊天之前肯定跑得完；
   * 万一没跑完，也只是称呼平淡一轮，不影响任何功能。
   */
  async function loadUserName() {
    const override = store.getGlobalSettings().userNameOverride;
    if (override) {
      USER_NAME = override;
      diagnostics({ event: "user.name", source: "chahuahui", name: override });
      return USER_NAME;
    }
    try {
      const resolved = await resolveUserDisplayName(ctx, guessedHanaHome);
      USER_NAME = resolved || USER_NAME_FALLBACK;
      diagnostics({ event: "user.name", source: resolved ? "config" : "fallback", name: resolved || null });
    } catch (error) {
      USER_NAME = USER_NAME_FALLBACK;
      diagnostics({ event: "user.name.failed", error: describeError(error) });
    }
    return USER_NAME;
  }
  // 装载期不预热用户名：读名字要走 ctx.resources.read，那是受权限保护的接口，
  // 不能出现在 apply() 里（宿主可能判定装载失败并回滚安装记录）。真正用到的地方各自 await。

  /**
   * 面向用户开口的那几条路（主动来找、半夜留言、等回音的催问）也要先发一块名牌，
   * 不然模型在开头几句最容易自称 AI。后台那些整理活儿（记忆、性格、爱好）不加：
   * 那是工具调用，不是跟人说话。
   */
  function withNamePlate(systemPrompt, partnerName) {
    return `${identityBlock({ partnerName, userName: USER_NAME })}\n\n${systemPrompt}`;
  }

  /** 正在跑的回合：turnId → { status, ... } */
  const turns = new Map();
  const COMPLETED_TURN_TTL_MS = 10 * 60 * 1000;
  function scheduleTurnCleanup(turn) {
    const timer = setTimeout(() => {
      if (turns.get(turn.id) === turn && ["ready", "error"].includes(turn.status)) turns.delete(turn.id);
    }, COMPLETED_TURN_TTL_MS);
    timer.unref?.();
  }
  /** 清空聊天后递增；旧模型回包即使回来，也不能再写进新线程。 */
  const threadGenerations = new Map();
  const threadGeneration = (agentId) => threadGenerations.get(agentId) ?? 0;

  // ─────────────────────────── 伙伴 ───────────────────────────

  async function listAllPartners() {
    const result = await ctx.bus.request("agent:list", { scope: "all", lifecycle: "active" });
    const rows = result?.agents ?? result?.items ?? [];
    const hanaPartners = rows
      .filter((row) => row?.id && row?.state !== "retired")
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? row.id),
        yuan: row.yuan ?? null,
        visibility: row.visibility ?? null,
        isCurrent: Boolean(row.isCurrent),
        isLocal: false,
      }));
    return [...hanaPartners, ...store.listLocalPartners()];
  }

  async function listPartners() {
    return (await listAllPartners()).filter((row) => !store.isPartnerHidden(row.id));
  }

  /**
   * 这位伙伴算不算已经住进茶话会了。
   *
   * 判定跟界面那道门禁用同一把尺（见 /onboarding）：捏过性格盘，或者走完过一遍认识流程。
   * 还没捏的伙伴，只是在 Hana 里有这么个人，茶话会这间屋子 ta 还没进门——
   * 不该被主动联系，也不该被后台顺手补性格、补作息、补动作文案。
   * 她自己建的角色例外：建的时候就算入了门。
   */
  function isSettled(agentId) {
    if (store.localPartner(agentId)) return true;
    const knowing = store.getKnowing(agentId);
    // 兼容旧版茶话会：已有旧 personality 的伙伴可以继续聊天，不因新版采访未完成被拦在门外。
    // everCompleted 是重做（清空采访）之后留的痕，否则她一点「重新认识」就会掉出入住名单。
    return isPaletteDone(knowing.palette)
      || hasPersonality(knowing.personality)
      || knowing.recognition?.status === "complete"
      || knowing.recognition?.everCompleted === true;
  }

  async function getPersona(agentId, { force = false } = {}) {
    const local = store.localPartner(agentId);
    if (local) {
      return {
        agentId,
        readAt: local.createdAt,
        files: { identity: null, description: local.description || null, public: null, pinned: null, facts: null, experience: null, dialect: null },
        extras: {},
        errors: {},
      };
    }
    const cached = store.getPersonaCache(agentId);
    if (!force && cached?.readAt && Date.now() - Date.parse(cached.readAt) < PERSONA_TTL_MS) {
      return cached;
    }
    try {
      const persona = await loadPersona(ctx, { agentsRoot, agentId });
      store.setPersonaCache(agentId, persona);
      diagnostics({ event: "persona.loaded", agentId, errors: persona.errors });
      return { readAt: persona.readAt, files: persona.files, errors: persona.errors };
    } catch (error) {
      diagnostics({ event: "persona.failed", agentId, error: describeError(error) });
      return cached ?? { readAt: null, files: {}, errors: { load: String(error?.message ?? error) } };
    }
  }

  // ─────────────────────────── 头像 ───────────────────────────
  //
  // 读 Hana 那边现成的头像文件（agents/<id>/avatars、user/avatars）。
  // 宿主那条 /api/agents/:id/avatar 要 chat 权限，应用面够不着，所以自己读同一份文件。
  // 伙伴没配头像的话，再退到宿主自带的那张默认脸（按「缘」分）——跟 Hana 里显示的是同一张。

  const { getAvatar } = createAvatarReader({
    ctx,
    agentsRoot,
    userRoot,
    diagnostics,
    ttlMs: AVATAR_TTL_MS,
  });

  /** agentId → { at, yuan }：头像那条路上要问「这位是什么缘」，卡个时间下限别每次都去敲宿主。 */
  const YUAN_TTL_MS = 10 * 60 * 1000;
  const yuanCache = new Map();

  async function yuanOf(agentId) {
    const hit = yuanCache.get(agentId);
    if (hit && Date.now() - hit.at < YUAN_TTL_MS) return hit.yuan;
    let yuan = null;
    try {
      yuan = (await listAllPartners()).find((row) => row.id === agentId)?.yuan ?? null;
    } catch (error) {
      diagnostics({ event: "avatar.yuan.failed", agentId, error: describeError(error) });
    }
    yuanCache.set(agentId, { at: Date.now(), yuan });
    return yuan;
  }

  // ─────────────────── 茶话会里多加的那层 ───────────────────
  //
  // 关系账 + 性格 + 爱好。这层设计来自一个已经停用的自家实验项目，但只活在茶话会自己这一本账里：
  // 不挂全局钩子、不碰任何人格文件、一步都不外溢到主对话。

  /** 她说完一句，账就往前挪一格。纯写盘，不挡后面的生成。 */
  function advancePartnerRelationship(agentId, text, stickerText = "") {
    const knowing = store.getKnowing(agentId);
    const step = advanceRelationship(knowing.relationship, { text, stickerText });
    store.saveKnowing(agentId, { ...knowing, relationship: step.relationship });
    if (step.stageChanged) {
      diagnostics({
        event: "knowing.stage",
        agentId,
        stage: step.relationship.stage,
        // 台阶跨了、披露也跟着挪了；把坡上的位置一起记下来，方便回头查「为什么里层还没露」
        disclosure: Number(disclosureRatio(effectiveRelationship({ ...knowing, relationship: step.relationship })).toFixed(3)),
      });
    }
    return step;
  }

  // ── 起跑线 ─────────────────────────────────────────────
  //
  // 她跟这些伙伴在 Hana 那边早就是熟人，不能因为换了个应用又装作初次见面。
  // 但茶话会看不到那边的会话（v2 应用只能列自己名下的会话，宿主会拦），
  // 所以只量「那边留了多少痕迹」：钉选、事实、经历三样材料的份量，
  // 内容一个字都不带走。量出来的只是相处史，亲近度一个字不动。

  const SEED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
  /** 量不出痕迹时重试的节流（跟性格初稿一个路子） */
  const SEED_RETRY_MS = 6 * 60 * 60 * 1000;

  /** 判断用的关系账 = 账本 + 起跑线。凡是要看「多熟了」的地方都走这个。 */
  function effectiveRelationship(knowing) {
    return mergeRelationship(knowing?.relationship, knowing?.relationSeed);
  }

  /** 量一次痕迹，存成起跑线；量不出来就没起点。pick 是「auto」或她锁的那一档。 */
  async function measureRelationSeed(agentId, { pick = "auto" } = {}) {
    store.setPartnerSettings(agentId, { seedMeasuredAt: new Date().toISOString() });
    const persona = await getPersona(agentId);
    const trace = traceSizeFromFiles(persona?.files);
    const seed = pick === "auto" ? seedFromTrace(trace) : seedByPick(pick, trace);
    const knowing = store.getKnowing(agentId);
    store.saveKnowing(agentId, { ...knowing, relationSeed: seed });
    diagnostics({
      event: "knowing.seed",
      agentId,
      source: pick === "auto" ? "auto" : "manual",
      pick,
      trace,
      turns: seed?.turns ?? 0,
      activeDays: seed?.activeDays ?? 0,
    });
    return seed;
  }

  /** 该不该重新量：没量过、自动量那份谝了一周、或上次量不出东西又过了六小时。 */
  function seedStale(seed, lastTryMs = 0) {
    if (!seed) return Date.now() - lastTryMs > SEED_RETRY_MS;
    if (seed.source === "manual") return false;
    const at = Date.parse(seed.measuredAt ?? "") || 0;
    return Date.now() - at > SEED_RECHECK_MS;
  }

  // ─────────────────────────── 记忆整理 ───────────────────────────
  //
  // 分层记忆里的"远处"靠这几个任务长出来。它们都在后台跑，不挡她看消息，
  // 但每个伙伴一条串行链：分条发送和摘要都是慢活，串行才不会互相踩。

  const memoryChain = new Map();

  function queueMemoryJob(agentId, job) {
    const prev = memoryChain.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => job())
      .catch((error) => diagnostics({ event: "memory.job.failed", agentId, error: describeError(error) }));
    memoryChain.set(agentId, next);
    void next.finally(() => {
      if (memoryChain.get(agentId) === next) memoryChain.delete(agentId);
    });
    return next;
  }

  const askCheap = (systemPrompt, userText, maxTokens) => askUtility(ctx, { systemPrompt, userText, maxTokens });

  /**
   * 「认识 ta」这条链用哪个模型。
   * 默认走宿主的 utility 通道（不占聊天额度，而且默认就是跟着当前对话模型）；
   * 她把 recognitionModel 单独指了一个，就用那一个，好让分享版不会被便宜的 utility 拖低质量。
   * 指的那个在目录里找不到了就退回默认那条，不硬用。
   */
  async function askRecognition(systemPrompt, userText, maxTokens) {
    const ref = normalizeModelRef(store.getGlobalSettings().recognitionModel);
    if (!ref) return askCheap(systemPrompt, userText, maxTokens);
    try {
      const catalog = await ctx.models.list();
      const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
      const usable = rows.some((row) => {
        const provider = row?.provider ?? row?.providerId ?? null;
        const model = row?.model ?? row?.modelId ?? row?.id ?? null;
        return provider === ref.provider && model === ref.model;
      });
      if (!usable) {
        diagnostics({ event: "recognition.model.missing", provider: ref.provider, model: ref.model });
        return askCheap(systemPrompt, userText, maxTokens);
      }
      const result = await generateReply(ctx, {
        systemPrompt,
        messages: [{ role: "user", content: String(userText ?? "") }],
        diagnostics,
        maxTokens,
        modelRef: ref,
        catalog,
      });
      const text = String(result?.text ?? "").trim();
      if (!text) return askCheap(systemPrompt, userText, maxTokens);
      return text;
    } catch (error) {
      diagnostics({ event: "recognition.model.failed", error: describeError(error) });
      return askCheap(systemPrompt, userText, maxTokens);
    }
  }

  async function askVoice(systemPrompt, userText, maxTokens, agentId, event = "voice") {
    let raw = await askCheap(systemPrompt, userText, maxTokens);
    const risk = inspectVoice(raw);
    if (risk.level !== "retry") return raw;
    diagnostics({ event: `${event}.retry`, agentId, reason: risk.reason, tail: risk.tail });
    const retryPrompt = `${systemPrompt}\n\n刚才的输出末尾疑似混入了无关字符。请只重新输出要说给对方的自然正文，不要解释格式。`;
    const retried = await askCheap(retryPrompt, userText, maxTokens);
    const retryRisk = inspectVoice(retried);
    diagnostics({ event: `${event}.retry.result`, agentId, level: retryRisk.level, reason: retryRisk.reason });
    return retryRisk.level === "retry" ? raw : retried;
  }

  /** 中间层：滚出窗口的段落压成一段摘要，靠 rolledThroughId 保证不重压。 */
  async function maybeRollup(agentId) {
    const pending = store.pendingMessages(agentId);
    const conversational = conversationMessages(pending);
    const plan = planRollup(conversational, { ...DEFAULT_CONTEXT, ...(store.getPref(agentId).context ?? {}) });
    if (!plan.need) return { rolled: false, pending: pending.length };
    const result = await runSummary(askCheap, segmentSpec(plan.batch, USER_NAME));
    if (!result.ok) {
      diagnostics({ event: "memory.rollup.failed", agentId, reason: result.reason, error: result.error ?? null });
      return { rolled: false, reason: result.reason };
    }
    store.appendArchive(agentId, makeArchiveEntry(result.text, plan.batch));
    const partners = await listPartners();
    const partnerName = partners.find((row) => row.id === agentId)?.name ?? agentId;
    try {
      const factSpec = buildFactSpec(plan.batch, USER_NAME, partnerName);
      const factRaw = await askCheap(factSpec.systemPrompt, factSpec.userText, 500);
      const parsedFacts = parseFactsResult(factRaw, plan.batch);
      if (!parsedFacts.ok) throw new Error("facts.parse-failed");
      if (parsedFacts.facts.length) store.appendFacts(agentId, parsedFacts.facts);
      diagnostics({ event: "memory.facts.ok", agentId, count: parsedFacts.facts.length });
    } catch (error) {
      diagnostics({ event: "memory.facts.failed", agentId, error: describeError(error) });
      return { rolled: false, reason: "facts-failed" };
    }
    store.markRolledThrough(agentId, plan.batch[plan.batch.length - 1].id);
    diagnostics({ event: "memory.rollup.ok", agentId, count: plan.batch.length, chars: result.text.length });
    return { rolled: true, text: result.text, count: plan.batch.length };
  }

  /** 关系档案：把新聊到的并进"我认识的她"。 */
  async function refreshProfile(agentId, sampleSize = 30) {
    const memory = store.readMemory(agentId);
    const recent = conversationMessages(store.getThread(agentId).messages).slice(-sampleSize);
    // Hana 那边记着的「关于她的事」也带进来：那边抽出的事实和这边聊出来的印象，合起来才是一个人
    const persona = await getPersona(agentId);
    const facts = String(persona?.files?.facts ?? "");
    // 这边还没聊过也不要紧：只要那边有关于她的事，就先起一版底稿（跟起跑线一个道理）
    if (recent.length === 0 && !facts.trim()) return { updated: false, reason: "no-material" };
    const partner = (await listPartners()).find((row) => row.id === agentId);
    const partnerName = partner?.name ?? agentId;
    const result = await runSummary(askCheap, profileSpec(memory.profile.text, recent, USER_NAME, facts, partnerName));
    if (!result.ok) {
      diagnostics({ event: "memory.profile.failed", agentId, reason: result.reason, error: result.error ?? null });
      return { updated: false, reason: result.reason };
    }
    if (!isProfileIdentitySafe(result.text, partnerName)) {
      store.quarantineProfile(agentId, result.text, "identity-mismatch", {
        partnerName,
        userName: USER_NAME,
        recentMessageCount: recent.length,
        factsIncluded: Boolean(facts.trim()),
      });
      diagnostics({ event: "memory.profile.rejected", agentId, reason: "identity-mismatch", partnerName });
      return { updated: false, reason: "identity-mismatch" };
    }
    store.setProfile(agentId, result.text, new Date(), {
      kind: "profile-refresh",
      partnerName,
      userName: USER_NAME,
      recentMessageCount: recent.length,
      factsIncluded: Boolean(facts.trim()),
    });
    store.setPartnerSettings(agentId, { profileRefreshedAt: new Date().toISOString() });
    diagnostics({ event: "memory.profile.ok", agentId, chars: result.text.length });
    return { updated: true, text: result.text };
  }

  const PROFILE_MIN_GAP_MS = 30 * 60 * 1000;

  /** 档案不用每句话都重写，卡个时间下限。 */
  async function maybeRefreshProfile(agentId, { force = false } = {}) {
    const last = Date.parse(store.getPartnerSettings(agentId).profileRefreshedAt ?? "") || 0;
    if (!force && Date.now() - last < PROFILE_MIN_GAP_MS) return { updated: false, reason: "throttled" };
    return refreshProfile(agentId);
  }

  /** 跨天了：给上一个日子补一条日账，顺手更新档案。 */
  async function maybeCloseDay(agentId) {
    const rows = store.getThread(agentId).messages;
    if (rows.length === 0) return { closed: false, reason: "empty" };
    const today = dayKey();
    const lastDay = dayKey(rows[rows.length - 1].at);
    if (!lastDay || lastDay === today) return { closed: false, day: today };
    const sameDay = rows.filter((row) => dayKey(row.at) === lastDay && isConversationMessage(row));
    if (sameDay.length === 0) return { closed: false, day: lastDay };
    const result = await runSummary(askCheap, dailySpec(sameDay, lastDay, USER_NAME));
    if (!result.ok) {
      diagnostics({
        event: "memory.ledger.failed",
        agentId,
        day: lastDay,
        reason: result.reason,
        error: result.error ?? null,
      });
      return { closed: false, day: lastDay, reason: result.reason };
    }
    store.upsertLedger(agentId, lastDay, result.text);
    diagnostics({ event: "memory.ledger.ok", agentId, day: lastDay, chars: result.text.length });
    await maybeRefreshProfile(agentId, { force: true });
    return { closed: true, day: lastDay, text: result.text };
  }

  /** 把一条主动消息送进她那个窗（她不在也照发，显示未读）。 */
  async function deliverProactive(agentId, { partnerName, topic, hobby, exception, followup, wakeEcho }) {
    await loadUserName();
    const memoryText = buildMemoryBlock(store.readMemory(agentId));
    let searchContext = "";
    if (!exception && topic?.freshness === "timely") {
      const fetcher = typeof ctx.network?.fetch === "function" ? ctx.network.fetch.bind(ctx.network) : null;
      const searched = await searchTimelyTopic(fetcher, topic);
      searchContext = searched.context ?? "";
      diagnostics({
        event: "proactive.topic-search",
        agentId,
        topic: topic.title,
        ok: searched.ok,
        reason: searched.reason ?? null,
        results: searched.results?.length ?? 0,
      });
    }
    const now = new Date();
    const currentTimeText = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日，${spokenClock(now)}`;
    // 开口的语气也要跟着起跑线走：熟人不能发出来像初次搭讪的话
    const knowing = store.getKnowing(agentId);
    const relationNote = relationshipNote(effectiveRelationship(knowing), knowing.relationSeed);
    let contextText = "";
    if (!exception) {
      try {
        // 今日情境要她自己打开才带：没开就当没这回事
        contextText = daybookOn() ? buildAmbientContextText(await readDaybook(ctx)) : "";
      } catch (error) {
        diagnostics({ event: "proactive.context.failed", agentId, error: describeError(error) });
      }
    }
    let stickerText = "";
    if (!exception) {
      try {
        const stickerIndex = await readCatalog(ctx);
        if (stickerIndex) stickerText = buildStickerHint(buildCatalog(stickerIndex, agentId));
      } catch (error) {
        diagnostics({ event: "proactive.sticker-hint.failed", agentId, error: describeError(error) });
      }
    }
    const spec = exception
      ? nightSpec({
          partnerName,
          userName: USER_NAME,
          memoryText,
          relationNote,
          worry: topic ? `${topic.title}${topic.note ? ` —— ${topic.note}` : ""}` : null,
          correction: topic?.correction ?? "",
          currentTimeText,
        })
      : proactiveSpec({ partnerName, userName: USER_NAME, topic, hobby, memoryText, relationNote, searchContext, currentTimeText, followup, wakeEcho, contextText, stickerText });

    let raw = "";
    try {
      raw = await askVoice(withNamePlate(spec.systemPrompt, partnerName), spec.userText, 300, agentId, "proactive");
    } catch (error) {
      diagnostics({ event: "proactive.failed", agentId, error: describeError(error) });
      return { ok: false, reason: "threw" };
    }
    if (followup?.read && String(raw ?? "").trim() === "[戳]") {
      await deliverAction(agentId, { partnerName, from: "partner" });
      return { ok: true, action: "poke" };
    }
    if (followup?.read && isNoReply(String(raw ?? "").trim())) {
      diagnostics({ event: "proactive.silent", agentId, reason: "read-followup" });
      return { ok: false, reason: "silent" };
    }
    const marker = parseStickerMarker(raw);
    const markerlessRaw = marker.keyword
      ? [marker.before, marker.after].filter(Boolean).join("\n")
      : raw;
    const text = cleanVoice(markerlessRaw, "voice");
    if (!isUsableVoice(text) && !marker.keyword) {
      diagnostics({ event: "proactive.empty", agentId, rawHead: String(raw ?? "").slice(0, 160) });
      return { ok: false, reason: "empty" };
    }
    if (!marker.keyword && isLowSignalProactive(text)) {
      diagnostics({ event: "proactive.low-signal", agentId, head: text.slice(0, 40) });
      return { ok: false, reason: "low-signal" };
    }
    if (isAbstractOnlyProactive(text, { topic })) {
      diagnostics({ event: "proactive.abstract-only", agentId, topic: topic?.title ?? null, head: text.slice(0, 40) });
      return { ok: false, reason: "abstract-only" };
    }
    // 出口兜底：同一句话别换个说法再发一遍。
    // 计划那一侧靠话题本的角度账本（下面 markTopicUsed 记的那笔），这侧防模型没照做。
    const saidRecently = store.getThread(agentId).messages
      .filter((row) => row.proactive && row.text)
      .slice(-6);
    const repeat = isRepeatedPhrasing(saidRecently, text, { now: Date.now() });
    if (repeat.repeated) {
      diagnostics({
        event: "proactive.repeat",
        agentId,
        score: Number(repeat.score.toFixed(3)),
        head: text.slice(0, 40),
      });
      return { ok: false, reason: "repeat-phrasing" };
    }
    const replyText = marker.keyword ? [text, `[表情:${marker.keyword}]`].filter(Boolean).join("\n") : text;
    const composed = await composeBubbles(agentId, replyText, {
      maxBubbles: 4,
      history: store.getThread(agentId).messages,
    });
    const bubbles = composed.bubbles;
    if (bubbles.length === 0) return { ok: false, reason: marker.keyword ? "sticker-unavailable" : "no-bubbles" };

    const stored = store.appendMessage(agentId, {
      role: "assistant",
      text: visibleTextOf(bubbles),
      bubbles,
      proactive: true,
      form: "word",
      exception: Boolean(exception),
      topicId: topic?.id ?? null,
      interestId: hobby?.id ?? null,
      interestName: hobby?.name ?? null,
      interestObject: hobby?.object ?? null,
    });
    if (topic) {
      // 记下这次聊的是哪一面：下次回来时拿它提醒模型换个延伸，而不是把话题封掉
      store.saveTopicBook(
        agentId,
        markTopicUsed(store.getTopicBook(agentId), topic.id, new Date(), { angle: text }),
      );
    }
    diagnostics({
      event: exception ? "proactive.night.ok" : "proactive.ok",
      agentId,
      topic: topic?.title ?? null,
      bubbles: bubbles.length,
      chars: text.length,
    });
    void announceArrival(agentId, partnerName);
    return {
      ok: true,
      bubbles,
      messageId: stored.id,
      interest: hobby ? { id: hobby.id ?? null, name: hobby.name ?? null, object: hobby.object ?? null } : null,
    };
  }

  /**
   * 等回音：她说了一句、ta接住了、她再没开口。
   *
   * 跟主动那套分开：不看主动档位，也不占主动的日上限。
   * 只看两件事：多熟了（坡上的位置）、等了多久。不熟的伙伴根本不催——刚认识就晾着，本来就正常。
   */
  let awaitingTickPromise = null;
  async function runAwaitingTick() {
    // 跟主动巡检一样上锁：模型跑得久的时候，下一轮定时器不该再进来催一次。
    if (awaitingTickPromise) return awaitingTickPromise;
    awaitingTickPromise = runAwaitingTickInternal();
    try {
      return await awaitingTickPromise;
    } finally {
      awaitingTickPromise = null;
    }
  }

  async function runAwaitingTickInternal() {
    let partners;
    try {
      partners = await listPartners();
    } catch (error) {
      diagnostics({ event: "awaiting.tick.no-partners", error: describeError(error) });
      return { ok: false, reason: "no-partners" };
    }
    const now = new Date();
    const globalSettings = store.getGlobalSettings();
    const report = [];

    for (const partner of partners) {
      const agentId = partner.id;
      // 没入住的伙伴谈不上"她晾着我"——这条也只在已入住的人身上跑
      if (!isSettled(agentId)) continue;
      const settings = store.getPartnerSettings(agentId);
      const state = settings.awaiting ?? {};
      if (state.done) continue;

      const knowing = store.getKnowing(agentId);
      const ratio = disclosureRatio(effectiveRelationship(knowing));
      const plan = planNudge({
        history: store.getThread(agentId).messages,
        now: now.getTime(),
        ratio,
        // 性子藏不住的，还不太熟也会先开口；宁可自己憋着的，熟起来了也未必会来
        temperament: temperamentOf(knowing.personality),
        nudges: Number(state.nudges ?? 0),
        nextCheckAt: Number(state.nextCheckAt ?? 0),
      });
      if (!plan.due) continue;

      // 她那边正在安静时间、或者ta睡着：这一趟往后挪，不搞破例。
      // 破例留言是留给「想你」的，催人是小事，不值得把她吵醒。
      const sleep = quietNow(now, globalSettings.quiet, settings.sleep);
      if (sleep.sleeping) {
        store.setPartnerSettings(agentId, {
          awaiting: { ...state, nextCheckAt: now.getTime() + 30 * 60 * 1000 },
        });
        report.push({ agentId, action: "blocked", reason: "quiet" });
        continue;
      }

      const result = await deliverNudge(agentId, { partner, plan, settings, ratio, knowing });
      report.push({ agentId, action: result.action, nudges: result.nudges });
    }
    return { ok: true, report };
  }

  /**
   * 催这一下：说什么、要不要说，全看ta自己。
   * 代码只管把处境摆给ta、把「催了几次」记住。
   */
  async function deliverNudge(agentId, { partner, plan, settings, ratio, knowing }) {
    await loadUserName();
    const recent = store.getThread(agentId).messages.slice(-10);
    const conversational = (row) => row && row.kind !== "action" && row.kind !== "poke";
    const lastAssistant = [...recent].reverse().find((row) => conversational(row) && row.role === "assistant" && !row.proactive)?.text ?? "";
    const lastUser = [...recent].reverse().find((row) => conversational(row) && row.role === "user")?.text ?? "";
    const spec = nudgeSpec({
      partnerName: partner.name,
      userName: USER_NAME,
      stage: plan.stage,
      temperament: plan.temperament,
      waitedMinutes: Math.max(1, Math.round((plan.waitedMs ?? 0) / 60000)),
      lastUserText: lastUser,
      lastAssistantText: lastAssistant,
      knowingText: buildKnowingText({
        disclosure: ratio,
        personality: knowing.personality,
        hobbies: knowing.hobbies,
        recognition: knowing.recognition,
        // 调过的盘优先。不传这个的话 paletteToText 恒为空，调了也白调。
        palette: knowing.palette,
        userName: USER_NAME,
      }),
      relationNote: relationshipNote(effectiveRelationship(knowing), knowing.relationSeed),
    });

    /** 记一笔：催到第几次了、下回什么时候再看、还要不要继续。 */
    const settle = (nudges, { done = false } = {}) => {
      store.setPartnerSettings(agentId, {
        awaiting: {
          nudges,
          nextCheckAt: Date.now() + nudgeDelay({ stage: plan.stage, nudges }),
          done: done || nudges >= MAX_NUDGES,
        },
      });
    };

    let raw = "";
    try {
      raw = await askVoice(withNamePlate(spec.systemPrompt, partner.name), spec.userText, 220, agentId, "awaiting");
    } catch (error) {
      diagnostics({ event: "awaiting.failed", agentId, error: describeError(error) });
      return { action: "error", nudges: Number(settings.awaiting?.nudges ?? 0) };
    }

    const choice = parseNudgeChoice(raw);
    const nudges = Number(settings.awaiting?.nudges ?? 0) + 1;

    if (choice.kind === "wait") {
      settle(nudges, { done: true });
      diagnostics({ event: "awaiting.wait", agentId, waitedMs: plan.waitedMs ?? 0 });
      return { action: "wait", nudges };
    }

    if (choice.kind === "poke") {
      await deliverAction(agentId, { partnerName: partner.name, from: "partner" });
      settle(nudges);
      diagnostics({ event: "awaiting.poke", agentId, stage: plan.stage, temperament: plan.temperament, waitedMs: plan.waitedMs ?? 0 });
      return { action: "poke", nudges };
    }

    const bubbles = splitReply(choice.text, { maxBubbles: MAX_NUDGE_BUBBLES });
    if (bubbles.length === 0) {
      settle(nudges, { done: true });
      diagnostics({ event: "awaiting.empty", agentId, raw: String(raw ?? "").slice(0, 80) });
      return { action: "empty", nudges };
    }
    store.appendMessage(agentId, {
      role: "assistant",
      text: bubbles.join("\n"),
      bubbles,
      nudge: true,
    });
    settle(nudges);
    diagnostics({ event: "awaiting.nudge", agentId, stage: plan.stage, temperament: plan.temperament, bubbles: bubbles.length, waitedMs: plan.waitedMs ?? 0 });
    void announceArrival(agentId, partner.name);
    return { action: "nudged", nudges };
  }

  /**
   * 主动那一层的巡检。每几分钟看一眼：到点了吗、门开了吗、有由头吗。
   * 不是定时器直接喊人——到点只是个开始，后面还有好几道闸。
   */
  // ── 自省小本子（内部）：记"为什么没开口"，攒够了自己看规律 ──
  // 用户看不到，也不进聊天正文；只落在茶话会自己的账本里。
  // 它改的是行为（排点多晚、什么时候放回话题、避开睡觉那段），不是话术。

  /** 记一笔，记不进去也不影响主动那层往下走。 */
  function recordWatch(agentId, entry) {
    try {
      store.saveSelfWatch(agentId, noteWatch(store.getSelfWatch(agentId), entry, new Date()));
    } catch (error) {
      diagnostics({ event: "selfwatch.note.failed", agentId, error: describeError(error) });
    }
  }

  function watchCorrections(agentId) {
    try {
      return store.getSelfWatch(agentId).corrections ?? {};
    } catch {
      return {};
    }
  }

  /**
   * 排下一个到点。
   * 自省说"太勤了"就往后再挪一截，说"总撞睡觉"就重新掷一个不落在睡觉段里的点。
   */
  function nextDueFor(agentId, settings, now, globalSettings) {
    const roll = () => new Date(scheduleNext(now, settings.tier));
    const corrections = watchCorrections(agentId);
    const thread = store.getThread(agentId);
    const silenceCount = proactiveSilenceContext(thread.messages, { readThroughId: thread.readThroughId, readThroughAt: thread.readThroughAt })?.count ?? 0;
    let at = roll();
    const baseDelay = at.getTime() - now.getTime();
    if (silenceCount > 0) {
      // 没接住不是催得更勤的信号；每多一次未回应，就把下一次落点往后挪，最多放大到 4 倍。
      at = new Date(now.getTime() + baseDelay * proactiveDelayFactor(silenceCount));
    }
    if (corrections.laterBy > 0) {
      at = new Date(at.getTime() + Math.round((at.getTime() - now.getTime()) * corrections.laterBy));
    }
    if (corrections.avoidQuiet) {
      const quiet = globalSettings?.quiet;
      for (let tries = 0; tries < 3; tries += 1) {
        if (!quietNow(at, quiet, sleepWindows(settings.sleep, at)).sleeping) break;
        at = roll();
      }
    }
    // 自省的 laterBy 是额外修正，但不能突破“沉默退避最多 4 倍”的总上限。
    at = new Date(Math.min(at.getTime(), now.getTime() + baseDelay * 4));
    return at.toISOString();
  }

  /**
   * 自己看一遍小本子：看出规律 → 写一句小结，并把修正交给下一轮排点用。
   * 只在攒够记录、且隔够一天时才跑；一轮 tick 最多一位，不一次叫一群模型。
   */
  async function runSelfReview(agentId, partnerName) {
    const watch = store.getSelfWatch(agentId);
    const now = new Date();
    if (!reviewDue(watch, now)) return false;
    const summary = watchSummary(watch, now);
    const corrections = correctionsFor(summary);
    const latestNote = watch.reviews[watch.reviews.length - 1]?.text ?? "";
    const spec = reviewSpec({ partnerName, userName: USER_NAME, summary, latestNote });
    let note = "";
    try {
      const raw = await askCheap(withNamePlate(spec.systemPrompt, partnerName), spec.userText, 120);
      note = cleanVoice(raw, "voice").slice(0, 60);
    } catch (error) {
      diagnostics({ event: "selfwatch.review.failed", agentId, error: describeError(error) });
    }
    store.saveSelfWatch(agentId, noteReview(watch, { text: note, corrections }, new Date()));
    diagnostics({
      event: "selfwatch.review",
      agentId,
      total: summary.total,
      dominant: summary.dominant,
      laterBy: corrections.laterBy,
      allowEarlyRevive: corrections.allowEarlyRevive,
      avoidQuiet: corrections.avoidQuiet,
      note: note || null,
    });
    return true;
  }

  let proactiveTickPromise = null;
  async function runProactiveTick(options = {}) {
    if (proactiveTickPromise) return proactiveTickPromise;
    proactiveTickPromise = runProactiveTickInternal(options);
    try {
      return await proactiveTickPromise;
    } finally {
      proactiveTickPromise = null;
    }
  }

  async function runProactiveTickInternal({ force = false } = {}) {
    // 账本读到坏文件时，store 会把坏的挪走留档。这里把记录捞进诊断，别让它静默发生。
    for (const row of store.takeCorruptLog()) {
      diagnostics({ event: "store.corrupt", file: row.file, moved: row.dest });
    }
    let partners;
    try {
      partners = await listPartners();
    } catch (error) {
      diagnostics({ event: "proactive.tick.no-partners", error: describeError(error) });
      return { ok: false, reason: "no-partners" };
    }
    const globalSettings = store.getGlobalSettings();
    const now = new Date();
    const report = [];
    /** 一轮 tick 最多自省一位，别一次叫一群模型 */
    let reviewedThisTick = false;

    for (const partner of partners) {
      const agentId = partner.id;
      // 没捏过性格的伙伴算还没入住：这间屋子 ta 还没进门，谈不上"来找她"
      if (!isSettled(agentId)) continue;
      const settings = store.getPartnerSettings(agentId);
      if (settings.proactiveEnabled === false) continue;

      // 自省：记录攒够了就自己看一遍，看出规律就改排点与话题的习惯
      if (!reviewedThisTick) {
        try {
          reviewedThisTick = await runSelfReview(agentId, partner.name);
        } catch (error) {
          diagnostics({ event: "selfwatch.review.threw", agentId, error: describeError(error) });
        }
      }

      let state = store.getProactiveState(agentId);
      // 头一回：先排个点，不立刻发（避免刚重载就一群人扑上来）
      if (!state.nextDueAt) {
        store.setProactiveState(agentId, { nextDueAt: nextDueFor(agentId, settings, now, globalSettings) });
        report.push({ agentId, action: "scheduled" });
        continue;
      }

      const pending = takeIntent(state, now);
      if (!force && !dueNow(state, now) && !pending.intent) continue;

      // 主动联系不能等用户先说话才有兴趣；到需要开口时，先确保 ta 的内在兴趣已长出来。
      await maybeTendHobbies(agentId).catch((error) => {
        diagnostics({ event: "knowing.hobbies.tick.failed", agentId, error: describeError(error) });
      });
      // 自省说"手上总缺由头"时，冷却过半的话题先放回来
      const book = upkeepTopics(agentId, { eager: Boolean(watchCorrections(agentId).allowEarlyRevive) });
      const thread = store.getThread(agentId);
      const followup = proactiveSilenceContext(thread.messages, { readThroughId: thread.readThroughId, readThroughAt: thread.readThroughAt });
      const previousTopic = followup?.previousTopicId
        ? book.topics.find((row) => row.id === followup.previousTopicId) ?? null
        : null;
      if (followup) followup.previousTopic = previousTopic;
      // 已读未回先处理关系反应，不继续端新的兴趣话题。
      const readyTopic = followup?.read
        ? null
        : pickTopic(book, now, { excludeId: followup?.previousTopicId ?? null });
      const gate = gateCheck({
        now,
        // ta今天的睡觉窗口先算好再递进去：主睡加可能的午觉，而且每天时长还会浮动
        settings: { ...settings, sleep: sleepWindows(settings.sleep, now) },
        globalSettings,
        state,
        globalState: store.getGlobalRuntime(),
      });

      const wakeEcho = gate.ok && !gate.exception && !followup?.read
        ? wakeEchoFor(thread.messages, { now: now.getTime(), consumedId: settings.wakeEcho?.sourceId ?? null })
        : null;

      if (!gate.ok) {
        recordWatch(agentId, { action: "blocked", reason: gate.reason, topic: readyTopic?.title ?? null });
        // 时机不合适：只记下"想找你"，不硬发
        const alreadyStaged = pending.intent ?? (state.staged ?? [])[0] ?? null;
        if (!alreadyStaged && readyTopic) {
          store.setProactiveState(agentId, {
            staged: stageIntent(state, { topicId: readyTopic.id, at: now.toISOString() }, now),
            lastSkippedAt: now.toISOString(),
          });
          diagnostics({ event: "proactive.staged", agentId, topic: readyTopic.title, reason: gate.reason });
        }
        report.push({ agentId, action: "blocked", reason: gate.reason });
        continue;
      }

      const pendingTopic = pending.intent
        ? (book.topics.find((row) => row.id === pending.intent.topicId) ?? null)
        : null;
      // 暂存意图也要遵守同题排除，不能从旁路把上一轮沉默的话题捞回来。
      // 暂存意图可能早于用户的手动操作，已放下的话题不能从这条旁路复活。
      const livePendingTopic = pendingTopic?.state === "dropped" ? null : pendingTopic;
      const topic = wakeEcho || followup?.read
        ? null
        : livePendingTopic?.id === followup?.previousTopicId ? readyTopic : (livePendingTopic ?? readyTopic);
      const memoryText = buildMemoryBlock(store.readMemory(agentId));
      const knowing = store.getKnowing(agentId);
      // 有共同话题优先；没有时，伙伴自己的兴趣就是正式的主动由头，不再只是随机兜底。
      const hobby = wakeEcho || followup?.read
        ? null
        : topic
          ? null
          : knowing.hobbies.length
            ? (() => {
                const usable = knowing.hobbies.filter((row) => row.id !== state.lastInterestUse?.id || knowing.hobbies.length === 1);
                return usable[Number(state.sentToday?.count ?? 0) % usable.length] ?? knowing.hobbies[0];
              })()
            : null;
      const selfSource = Boolean(memoryText.trim() || hobby || wakeEcho);
      const form = wakeEcho || followup?.read
        ? "word"
        : topic || hobby
          ? "word"
          : decideForm({ topic: null, selfSource, tier: settings.tier }).form;

      if (form === "poke") {
        // 这个动作不需要由头——ta天然就是"我就是闲着"
        deliverAction(agentId, { partnerName: partner.name, from: "partner" });
        const noted = noteSent(
          { state: { ...state, staged: pending.rest }, globalState: store.getGlobalRuntime(), now },
          { exception: Boolean(gate.exception), quiet: globalSettings.quiet },
        );
        store.setProactiveState(agentId, { ...noted.state, nextDueAt: nextDueFor(agentId, settings, now, globalSettings) });
        store.setGlobalRuntime(noted.globalState);
        report.push({ agentId, action: "poked" });
        continue;
      }

      if (form !== "word") {
        const skipReason = topic ? "no-form" : "no-topic";
        recordWatch(agentId, { action: "skip", reason: skipReason, topic: topic?.title ?? null });
        store.setProactiveState(agentId, {
          nextDueAt: nextDueFor(agentId, settings, now, globalSettings),
          staged: pending.rest,
        });
        diagnostics({ event: "proactive.skip", agentId, reason: skipReason });
        report.push({ agentId, action: "skip", reason: "no-topic" });
        continue;
      }

      const sent = await deliverProactive(agentId, {
        partnerName: partner.name,
        topic,
        hobby,
        exception: Boolean(gate.exception),
        followup,
        wakeEcho,
      });
      if (!sent.ok) {
        recordWatch(agentId, { action: "failed", reason: sent.reason, topic: topic?.title ?? null });
        // 没生成出来不算发过，重点再试一次（不记入配额）
        store.setProactiveState(agentId, {
          nextDueAt: nextDueFor(agentId, settings, now, globalSettings),
          staged: pending.rest,
        });
        report.push({ agentId, action: "failed", reason: sent.reason });
        continue;
      }

      const noted = noteSent(
        { state: { ...state, staged: pending.rest }, globalState: store.getGlobalRuntime(), now },
        { exception: Boolean(gate.exception), quiet: globalSettings.quiet },
      );
      store.setProactiveState(agentId, {
        ...noted.state,
        nextDueAt: nextDueFor(agentId, settings, now, globalSettings),
        lastInterestUse: sent.interest
          ? { ...sent.interest, at: now.toISOString() }
          : noted.state.lastInterestUse ?? null,
      });
      store.setGlobalRuntime(noted.globalState);
      if (wakeEcho) {
        store.setPartnerSettings(agentId, { wakeEcho: { sourceId: wakeEcho.sourceId, consumedAt: now.toISOString() } });
      }
      report.push({ agentId, action: "sent", topic: topic?.title ?? null, wakeEcho: Boolean(wakeEcho), exception: Boolean(gate.exception) });
    }

    // 顺手把还没写过那句的伙伴补上（只有一个动作，一轮最多暖 3 位）。
    // 不抢她的时间，也不一上来叫一群模型。
    let warmLeft = 3;
    const warmed = [];
    for (const partner of partners) {
      if (warmLeft <= 0) break;
      if (!isSettled(partner.id)) continue;
      const st = store.getPartnerSettings(partner.id);
      if (!needsRotation(readTemplateEntry(st))) continue;
      const rolled = await rollActionTemplate(partner.id, partner.name);
      if (rolled.rolled || rolled.reason) warmLeft -= 1;
      warmed.push({ agentId: partner.id, text: rolled.text ?? null });
    }

    // 作息也一样：没定过的伙伴顺手定几位，不一次叫一群模型。
    // 2026-09-13 起老形状的作息算"没定过"（要换成时长+午觉那一版），所以这一阵一轮多补两个，
    // 不然九位伙伴要四五十分钟才轮完；补完就回到正常的一轮一位。（补完这行注释也可以不管）
    let sleepLeft = 3;
    const slept = [];
    for (const partner of partners) {
      if (sleepLeft <= 0) break;
      if (!isSettled(partner.id)) continue;
      if (isSleepSet(store.getPartnerSettings(partner.id))) continue;
      const rolled = await rollSleep(partner.id, partner.name);
      sleepLeft -= 1;
      slept.push({ agentId: partner.id, sleep: rolled.sleep ?? null });
    }

    // 性格：装好、第一次启动就该把所有伙伴认一遍，不等她聊到谁，
    // 更不用她挨个点进设置页。一轮最多补两位，不一次叫一群模型。
    let draftLeft = 2;
    const drafted = [];
    for (const partner of partners) {
      if (draftLeft <= 0) break;
      if (!isSettled(partner.id)) continue;
      const result = await maybeDraftPersonality(partner.id).catch((error) => ({
        drafted: false,
        reason: "error",
        error: describeError(error),
      }));
      if (result.drafted) draftLeft -= 1;
      if (result.drafted || (result.reason && result.reason !== "already")) {
        drafted.push({ agentId: partner.id, drafted: Boolean(result.drafted), reason: result.reason ?? null });
      }
    }

    return { ok: true, at: now.toISOString(), report, warmed, slept, drafted };
  }

  /**
   * 给一位伙伴写/换一句ta自己的动作文案（ta写的，她改不了）。
   * 用得上才写：她点了这个动作、那格还空着，才当场叫ta写那一句。
   */
  async function rollActionTemplate(agentId, partnerName, { force = false } = {}) {
    const styleId = readStyleId(store.getGlobalSettings());
    const settings = store.getPartnerSettings(agentId);
    if (!force && !needsRotation(readTemplateEntry(settings))) return { rolled: false };
    try {
      const persona = await getPersona(agentId);
      const knowing = store.getKnowing(agentId);
      const current = readTemplateEntry(settings);
      const spec = actionTemplateSpec({
        styleId,
        partnerName,
        personaText: renderPersona(persona, { partnerName, userName: USER_NAME }),
        // 挑哪一档跟「熟到哪一步」有关：表层立刻生效，里层按披露一点点渗（跟对话里那套同一份账）
        knowingText: buildKnowingText({
          disclosure: disclosureRatio(effectiveRelationship(knowing)),
          personality: knowing.personality,
          hobbies: knowing.hobbies,
          recognition: knowing.recognition,
          palette: knowing.palette,
          userName: USER_NAME,
        }),
        tone: current?.tone ?? null,
      });

      /** 写一句。合格 = 格式对（带槽位带「你」）+ 不踩线（露骨的、隐晦的都不行）。 */
      const tryWrite = async () => {
        const attempt = await askCheap(spec.systemPrompt, spec.userText, 90).catch(() => "");
        const picked = parseToneReply(attempt);
        const cleaned = cleanActionTemplate(styleId, picked.text);
        return {
          raw: attempt,
          // ta这回想挑哪一档没认出来，就接着用上一次的（保持连不连得上）
          tone: picked.tone ?? current?.tone ?? null,
          text: cleaned,
          ok: isValidActionTemplate(styleId, cleaned) && isSafeActionText(cleaned),
        };
      };

      let written = await tryWrite();
      // 写成那种「隐晦」的腔调了（格式没错、却不是朋友间该有的写法）：当场重来一次
      if (!written.ok) {
        diagnostics({ event: "action.template.retry", agentId, head: String(written.text ?? "").slice(0, 60) });
        written = await tryWrite();
      }
      if (!written.ok) {
        diagnostics({
          event: "action.template.invalid",
          agentId,
          rawHead: String(written.raw ?? written.text ?? "").slice(0, 120),
        });
        // 两次都不行。旧的那句要是还好好的，就别动它（只把下次再换的时间推一下）；
        // 旧的那句本身就踩了线，那种句子不能继续挂着，换成兜底句。
        const oldText = String(current?.text ?? "");
        const oldOk = isValidActionTemplate(styleId, oldText) && isSafeActionText(oldText);
        if (oldOk) {
          store.setPartnerSettings(agentId, {
            action: { ...current, nextAt: nextRotationAt(new Date(), () => 0.2) },
          });
          return { rolled: false, reason: "invalid" };
        }
        written = { raw: "", tone: null, text: fallbackActionTemplate(styleId), ok: true };
      }
      const text = written.text;
      store.setPartnerSettings(agentId, {
        action: {
          text,
          voice: ACTION_VOICE,
          tone: written.tone ?? null,
          updatedAt: new Date().toISOString(),
          nextAt: nextRotationAt(),
        },
      });
      diagnostics({ event: "action.template.ok", agentId, text });
      return { rolled: true, text };
    } catch (error) {
      diagnostics({ event: "action.template.failed", agentId, error: describeError(error) });
      return { rolled: false, reason: "threw" };
    }
  }

  /**
   * 让这位伙伴按自己的性子定一次作息（ta定的，她改不了）。
   * 没定过的伙伴在巡检里慢慢定；她点了「请 ta 重新定」就 force 一次。
   * 定不出来就不覆盖原来那条，也不慌，等下一轮。
   */
  async function rollSleep(agentId, partnerName, { force = false } = {}) {
    const settings = store.getPartnerSettings(agentId);
    if (!force && isSleepSet(settings)) return { rolled: false };
    try {
      const persona = await getPersona(agentId);
      const spec = sleepSpec({ partnerName, personaText: renderPersona(persona, { partnerName, userName: USER_NAME }) });
      const raw = await askCheap(spec.systemPrompt, spec.userText, 120);
      const parsed = parseSleep(raw);
      if (!parsed) {
        diagnostics({ event: "sleep.invalid", agentId, rawHead: String(raw ?? "").slice(0, 120) });
        return { rolled: false, reason: "invalid" };
      }
      const sleep = {
        ...parsed,
        // 睡多久不照模型写的来：ta每次都挑中间值，按伙伴摊开才不一样
        hours: baseHoursFor(agentId),
        shape: SLEEP_SHAPE,
        source: "partner",
        updatedAt: new Date().toISOString(),
      };
      store.setPartnerSettings(agentId, { sleep });
      // 日志里把「几点睡 + 睡多久 + 有没有午觉」写全；新形状没有 end 那一项
      diagnostics({
        event: "sleep.ok",
        agentId,
        sleep: `${sleep.start} +${sleep.hours}h`,
        nap: sleep.nap ? `${sleep.nap.start}(${sleep.nap.minutes}m)` : null,
      });
      return { rolled: true, sleep };
    } catch (error) {
      diagnostics({ event: "sleep.failed", agentId, error: describeError(error) });
      return { rolled: false, reason: "threw" };
    }
  }

  /**
   * 一个动作。
   * 方向决定用谁的文案：伙伴对她做 → 用**她写的**那句；她对伙伴做 → 用**伙伴写的**那句。
   * 伙伴那格空着（ensure）就当场叫ta写，最多等 8 秒；写不出来就用兜底句，不卡住她。
   */
  async function deliverAction(agentId, { partnerName, from, ensure = false }) {
    await loadUserName();
    const globalSettings = store.getGlobalSettings();
    const styleId = readStyleId(globalSettings);
    if (ensure && from === "user") {
      const fresh = await withTimeout(rollActionTemplate(agentId, partnerName), 8000);
      if (fresh?.rolled) diagnostics({ event: "action.template.lazy", agentId });
    }
    const settings = store.getPartnerSettings(agentId);
    const line =
      from === "partner"
        ? renderActionLine(styleId, readMyTemplateEntry(globalSettings)?.text, partnerName)
        : renderActionLine(styleId, readTemplateEntry(settings)?.text, USER_NAME);
    const stored = store.appendMessage(agentId, {
      role: from === "partner" ? "assistant" : "user",
      kind: "action",
      actionId: styleId,
      actionLabel: actionLabel(styleId),
      from,
      text: line,
      proactive: from === "partner",
    });
    diagnostics({ event: "action.sent", agentId, style: styleId, from, line });
    return stored;
  }

  /** 等太久就当没等着 —— 不拿她的时间换一句文案。 */
  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(null);
      }, ms);
      promise.then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }


  /**
   * 她做了个动作之后，伙伴怎么接。
   *
   * 注意：**这不是配对**。动作本身只是一条文案，发完就完了；
   * ta接不接、接什么，是ta自己的事，不是"你戳了我我就得戳回去"。
   * 不去镜像她的动作（她抱了抱ta，ta犯不上也抱回来）。
   *
   * 而且这里**只用动作回，不出话**：戳一戳本来就是闲得没话说时点着玩的，
   * 一被正经接住就变味了（她 2026-09-13 拍的板）。回戳/回拍就够，没力气回就不回。
   */
  async function answerAction(agentId, { partnerName }) {
    if (!canAnswerPoke(store.getThread(agentId).messages)) {
      diagnostics({ event: "action.no-answer", agentId, reason: "streak" });
      return { answered: false, reason: "streak" };
    }
    deliverAction(agentId, { partnerName, from: "partner" });
    return { answered: true, form: "poke" };
  }

  /**
   * 她做完一个动作之后，**不马上接**。
   *
   * 她不该看见「我看到了、我在判断」这个过程：接不接、什么时候接，是ta自己的事。
   * 所以这里只排一个不规律的时刻，到点再走 answerAction；
   * 连戳几下也只算一次（后来那几下只是把话说完，不推后、不叠加）。
   */
  const ACTION_REPLY_MIN_MS = 15 * 1000;
  const ACTION_REPLY_MAX_MS = 75 * 1000;
  const pendingActionReplies = new Map();

  /** 把待发的那一下回戳撤掉。她要是在这之前又说了一句实在的，那下回戳再冒出来就没头没脑了。 */
  function cancelPendingActionReply(agentId) {
    const timer = pendingActionReplies.get(agentId);
    if (!timer) return false;
    clearTimeout(timer);
    pendingActionReplies.delete(agentId);
    return true;
  }

  function scheduleActionReply(agentId, { partnerName }) {
    // 已经有话要回她了（她发了实在的），那一下回戳就别再冒出来了
    if (pendingReplies.has(agentId)) {
      diagnostics({ event: "action.answer.skipped", agentId, reason: "already-replying" });
      return;
    }
    if (pendingActionReplies.has(agentId)) {
      diagnostics({ event: "action.answer.coalesced", agentId });
      return;
    }
    const delay = ACTION_REPLY_MIN_MS + Math.random() * (ACTION_REPLY_MAX_MS - ACTION_REPLY_MIN_MS);
    const timer = setTimeout(() => {
      pendingActionReplies.delete(agentId);
      void queueMemoryJob(agentId, async () => answerAction(agentId, { partnerName }));
    }, delay);
    timer.unref?.();
    pendingActionReplies.set(agentId, timer);
    diagnostics({ event: "action.answer.scheduled", agentId, delayMs: Math.round(delay) });
  }

  /** 试过一次之后多久才允许再试（性格初稿与爱好共用这条节流） */
  const HOBBY_SEED_RETRY_MS = 6 * 60 * 60 * 1000;
  const DRAFT_RETRY_MS = 6 * 60 * 60 * 1000;

  /**
   * 性格初稿：从 Hana 那边她自己配的人格文件里看一眼这个人是什么样。
   *
   * 不开会话、不问她那个伙伴本人——人格文件本来就在手上，一次短调用就够。
   * 料收 identity / description / public / pinned 四份（各按预算裁，见 DRAFT_MATERIAL_BUDGET）；
   * 茶话会自己攒的档案日账一律不掺，记忆流水（facts / experience）也不掺，容易冲淡性格信号。
   *
   * `force` 是「重新看一次 ta 的样子」用的：跳过「已经有了就不判」和节流，重判一份。
   */
  async function maybeDraftPersonality(agentId, { force = false } = {}) {
    const knowing = store.getKnowing(agentId);
    if (!force) {
      // 升级前就有的那份：分不清是系统判的还是她调过的。当成基准存下来（不改它），
      // 不认领来源，也不为它再跑一次模型——再判一份只会跟它不一样，反而把账搅乱。
      if (!knowing.personalityAuto && hasPersonality(knowing.personality)) {
        store.saveKnowing(agentId, { ...knowing, personalityAuto: knowing.personality });
        diagnostics({ event: "knowing.personality.auto-backfilled", agentId });
        return { drafted: false, reason: "backfilled" };
      }
      if (hasPersonality(knowing.personality)) return { drafted: false, reason: "already" };
      const lastTry = Date.parse(store.getPartnerSettings(agentId).personalityDraftAt ?? "") || 0;
      if (Date.now() - lastTry < DRAFT_RETRY_MS) return { drafted: false, reason: "throttled" };
    }
    store.setPartnerSettings(agentId, { personalityDraftAt: new Date().toISOString() });

    const persona = await getPersona(agentId);
    // 料从哪来：Hana 那边她自己配的那些，能收的都收（人格自述、自我介绍、对外意识、钉选记忆）。
    // 原先只挑一份，identity 一有内容，后面那几份写得再全也轮不到。
    const material = buildDraftMaterial(persona?.files);
    if (!material) {
      diagnostics({ event: "knowing.personality.no-material", agentId });
      return { drafted: false, reason: "no-material" };
    }

    const partner = (await listPartners()).find((row) => row.id === agentId);
    const spec = personalityDraftSpec({
      partnerName: partner?.name ?? agentId,
      userName: USER_NAME,
      material,
    });
    const raw = await askCheap(spec.systemPrompt, spec.userText, 400);
    const draft = parseDraftReply(raw);
    if (!draft) {
      diagnostics({ event: "knowing.personality.empty", agentId });
      return { drafted: false, reason: "empty" };
    }

    // 生成期间她可能自己挑了一个，别把她手动定的盖掉。她挑了也算数，
    // 刚判出来的这份就存成基准（将来想回去能回去）。
    const fresh = store.getKnowing(agentId);
    const stamped = { ...draft, updatedAt: new Date().toISOString() };
    if (fresh.personalityFrom === "user") {
      store.saveKnowing(agentId, { ...fresh, personalityAuto: stamped });
      return { drafted: false, reason: "user-owns" };
    }
    store.saveKnowing(agentId, {
      ...fresh,
      personality: { ...stamped },
      personalityAuto: { ...stamped },
      personalityFrom: "auto",
    });
    diagnostics({ event: "knowing.personality.drafted", agentId, from: "material", materialChars: material.length });
    return { drafted: true };
  }

  /** 兴趣那条：先补/重塑独立的原生兴趣；够格了再从真实相处里长共同兴趣。 */
  async function maybeTendHobbies(agentId) {
    const partner = (await listPartners()).find((row) => row.id === agentId);
    const partnerName = partner?.name ?? agentId;
    let knowing = store.getKnowing(agentId);

    if (needsNativeInterestRefresh(knowing.hobbies)) {
      const lastTry = Date.parse(store.getPartnerSettings(agentId).hobbySeedTryAt ?? "") || 0;
      if (Date.now() - lastTry < HOBBY_SEED_RETRY_MS) return { born: 0, reason: "throttled" };
      store.setPartnerSettings(agentId, { hobbySeedTryAt: new Date().toISOString() });
      const personalityText = nativeInterestSeed(knowing.personality);
      if (!personalityText.trim()) {
        diagnostics({ event: "knowing.hobbies.born.no-material", mode: "native-v2", agentId });
        return { born: 0, reason: "no-material" };
      }
      const spec = bornHobbySpec({
        partnerName,
        personalityText,
      });
      const raw = await askCheap(spec.systemPrompt, spec.userText, 420);
      const rows = validateNativeHobbies(parseNativeHobbyReply(raw), { userName: USER_NAME });
      if (!rows.length) {
        diagnostics({ event: "knowing.hobbies.native.empty", agentId, rawHead: String(raw ?? "").slice(0, 160) });
        return { born: 0, reason: "empty" };
      }
      const hobbies = replaceBornHobbies(knowing.hobbies, rows);
      if (!hobbies.some((row) => row.origin === "born" && row.object && row.preference && row.ritual && row.friction)) {
        diagnostics({ event: "knowing.hobbies.native.invalid", agentId, rawHead: String(raw ?? "").slice(0, 160) });
        return { born: 0, reason: "invalid" };
      }
      store.saveKnowing(agentId, { ...knowing, hobbies });
      diagnostics({ event: "knowing.hobbies.native", agentId, count: hobbies.filter((row) => row.origin === "born").length });
      return { born: hobbies.filter((row) => row.origin === "born").length };
    }

    if (!canGrow({ relationship: effectiveRelationship(knowing), hobbies: knowing.hobbies })) {
      return { grown: 0, reason: "not-yet" };
    }
    const material = buildMemoryBlock(store.readMemory(agentId));
    if (!material) return { grown: 0, reason: "no-material" };
    const settings = store.getPartnerSettings(agentId);
    const lastTry = Date.parse(settings.hobbyGrowTryAt ?? "") || 0;
    if (Date.now() - lastTry < HOBBY_SEED_RETRY_MS) return { grown: 0, reason: "throttled" };
    store.setPartnerSettings(agentId, { hobbyGrowTryAt: new Date().toISOString() });
    const spec = grownHobbySpec({
      partnerName,
      userName: USER_NAME,
      existing: knowing.hobbies,
      material,
    });
    const raw = await askCheap(spec.systemPrompt, spec.userText, 240);
    const rows = parseHobbyReply(raw);
    if (!rows.length) {
      diagnostics({ event: "knowing.hobbies.none", agentId });
      return { grown: 0, reason: "no-seed" };
    }
    knowing = store.getKnowing(agentId);
    const grown = addHobby(knowing.hobbies, {
      ...rows[0],
      origin: "grown",
      schemaVersion: 2,
      generationVersion: "shared-v1",
      source: "interaction",
    });
    if (grown.length === knowing.hobbies.length) return { grown: 0, reason: "no-room" };
    store.saveKnowing(agentId, { ...knowing, hobbies: grown });
    diagnostics({ event: "knowing.hobbies.grown", agentId, name: rows[0].name });
    return { grown: 1 };
  }

  /**
   * 回复之后在后台静悄悄整理。
   *
   * `burst` = 她刚才一口气连说了几条。连着好几条的时候，那些没被她接住的话头
   * 得马上过一遍话题本，以后当由头带出来（不靠"攒够十条"那个阀）。
   */
  function scheduleMemoryWork(agentId, { burst = 0 } = {}) {
    void queueMemoryJob(agentId, async () => {
      const rolled = await maybeRollup(agentId);
      await maybeRefreshProfile(agentId, { force: Boolean(rolled.rolled) });
      await maybeExtractTopics(agentId, { force: burst >= 2 });
      await maybeDraftPersonality(agentId);
      await maybeTendHobbies(agentId);
    });
  }

  // ─────────────────────── 话题本（M5 的核心） ───────────────────────

  // 低频聊天也要有机会留下由头；不必等满十条才整理。
  const TOPIC_MIN_NEW_MESSAGES = 6;
  const TOPIC_MIN_GAP_MS = 20 * 60 * 1000;

  /** 把到点的发酵话题推进成 ready、清掉老账（不调模型，很便宜）。 */
  function upkeepTopics(agentId, { eager = false } = {}) {
    const now = new Date();
    // ⚠️ 返回形状不一样，别顺手都加 .book：
    //    refreshUsedTopics / pruneTopics → 直接给本子
    //    advanceTopics → { book, changed }
    let book = refreshUsedTopics(store.getTopicBook(agentId), now, { eager });
    book = advanceTopics(book, now).book;
    book = pruneTopics(book, now);
    return store.saveTopicBook(agentId, book);
  }

  /** 从最近的对话里抽新话题。攒够了新的才抽，不是每句话都抽。 */
  async function maybeExtractTopics(agentId, { force = false } = {}) {
    const book = upkeepTopics(agentId);
    const messages = store.getThread(agentId).messages;
    if (messages.length === 0) return { extracted: false, reason: "no-messages" };

    let fresh = messages.length;
    if (book.extractedThroughId) {
      const index = messages.findIndex((row) => row.id === book.extractedThroughId);
      fresh = index < 0 ? messages.length : messages.length - index - 1;
    }
    const last = Date.parse(book.lastExtractedAt ?? "") || 0;
    if (!force && (fresh < TOPIC_MIN_NEW_MESSAGES || Date.now() - last < TOPIC_MIN_GAP_MS)) {
      return { extracted: false, fresh, topics: book.topics.length };
    }

    const sample = messages.slice(-30);
    const spec = topicSpec(sample, existingTitles(book), (rows) => renderForSummary(rows, USER_NAME));
    let raw = "";
    try {
      raw = await askCheap(spec.systemPrompt, spec.userText, 400);
    } catch (error) {
      diagnostics({ event: "memory.topics.failed", agentId, error: describeError(error) });
      return { extracted: false, reason: "threw" };
    }
    const incoming = parseTopics(raw);
    const merged = mergeTopics(book, incoming, new Date());
    const next = store.saveTopicBook(agentId, {
      ...merged.book,
      lastExtractedAt: new Date().toISOString(),
      extractedThroughId: messages[messages.length - 1]?.id ?? null,
    });
    diagnostics({
      event: "memory.topics.ok",
      agentId,
      picked: incoming.length,
      added: merged.added,
      mergedCount: merged.merged,
      total: next.topics.length,
      rawHead: incoming.length ? null : String(raw ?? "").slice(0, 160),
    });
    return { extracted: true, added: merged.added, merged: merged.merged, total: next.topics.length };
  }

  // ─────────────────────────── 发消息 ───────────────────────────
  //
  // 她发出去的消息什么时候被接住，只看一件事：**ta手里有没有手机**。
  // 那是ta自己的节奏（lib/phone.js：拿一阵、放下一阵、再拿起来），
  // 跟她打不打开窗口、发不发言都没关系。她"在不在看"只决定要不要给她演实时那套。

  /**
   * 把模型输出切成气泡，中间那个 [表情:关键词] 换成一张真的表情包。
   *
   * 只借不给：图和偏好都来自「表情包」那份只读快照。读不到、命中不了，
   * 就只是不发，不影响说话。甩不甩交给ta自己按情绪判断，代码只管一条回复最多出一张
   * （多余的标记在 parseStickerMarker 那里就被吃掉了）。
   */
  async function composeBubbles(agentId, rawText, { maxBubbles = 6, history = [] } = {}) {
    const mark = parseStickerMarker(rawText);
    let stickerBubble = null;
    let stickerId = null;
    if (mark.keyword) {
      const index = await readCatalog(ctx);
      const catalog = index ? buildCatalog(index, agentId) : null;
      if (catalog) {
        const picked = pickSticker(catalog, {
          keyword: mark.keyword,
          recentIds: recentStickerIds(history),
        });
        if (picked) {
          stickerBubble = encodeStickerBubble(picked.id);
          stickerId = picked.id;
        }
      }
    }

    const budget = Math.max(1, Number(maxBubbles) || 6);
    const room = Math.max(1, budget - (stickerBubble ? 1 : 0));
    const before = mark.before ? splitReply(mark.before, { maxBubbles: room }) : [];
    const after = mark.after
      ? splitReply(mark.after, { maxBubbles: Math.max(1, room - before.length) })
      : [];
    const bubbles = [...before];
    if (stickerBubble) bubbles.push(stickerBubble);
    bubbles.push(...after);
    return { bubbles, sentSticker: Boolean(stickerBubble), stickerId, marker: mark.keyword || "" };
  }

  /** 落库用的纯文本：表情包不进去，只留一个记号，免得历史里带哨兵字符。 */
  function visibleTextOf(bubbles) {
    const visible = bubbles.filter((piece) => !isStickerBubble(piece));
    const hasSticker = visible.length !== bubbles.length;
    const text = visible.join("\n");
    if (!hasSticker) return text;
    return text ? `${text}\n[表情]` : "[表情]";
  }

  /**
   * 生成一份回复并落库。同步那条路（她在场）和异步那条路都用它。
   * 只管生成与入账，节奏、提醒那些外面各自接。
   */
  async function composeReply(agentId, { repliedTo = null, mayPass = false, currentMessageId = null, excludeMessageId = null, replaceMessageId = null, isCurrent = null } = {}) {
    await loadUserName();
    const startedAt = Date.now();
    const pending = store.pendingMessages(agentId).filter((row) => row?.id !== excludeMessageId);
    const windowed = splitForContext(pending).recent;
    // 回复目标必须是这轮实际看进去的最后一条用户消息；否则连发时会把已经覆盖的话误判成漏回。
    const replyTargetId = [...windowed].reverse().find((row) => row?.role === "user" && !row.recalled)?.id ?? repliedTo;
    // 极明显的聊天句号先在只读消息判断阶段收口，不提前消耗日子账本等上下文状态。
    if (shouldQuietClose(windowed, currentMessageId || repliedTo)) {
      const generationMs = Date.now() - startedAt;
      diagnostics({ event: "reply.silent", agentId, generationMs, reason: "obvious-closing-signal" });
      return { ok: false, reason: "silent", generationMs };
    }
    // 跨天了就先给上一个日子补一笔（一天只发生一次，之后就短路返回）
    await maybeCloseDay(agentId);
    const [partners, persona] = await Promise.all([listPartners(), getPersona(agentId)]);
    const partner = partners.find((row) => row.id === agentId);
    const memoryText = buildMemoryBlock(store.readMemory(agentId));
    const knowing = store.getKnowing(agentId);
    const knowingText = buildKnowingText({
      disclosure: disclosureRatio(effectiveRelationship(knowing)),
      personality: knowing.personality,
      hobbies: knowing.hobbies,
      recognition: knowing.recognition,
      palette: knowing.palette,
      userName: USER_NAME,
    });
    // 表情包：只借不给。读不到就什么都不提，聊天照常。
    const stickerIndex = await readCatalog(ctx);
    const stickerCatalog = stickerIndex ? buildCatalog(stickerIndex, agentId) : null;
    const stickerText = buildStickerHint(stickerCatalog);
    // ta自己那块表：现在几点、距上次说话多久、今天她开没开口
    const timeText = timeBlock({
      now: new Date(),
      messages: store.getThread(agentId).messages,
      userName: USER_NAME,
      // ta自己的困不困：按ta自己那份作息算，不靠外面的提醒
      sleep: store.getPartnerSettings(agentId).sleep,
      currentMessageId: currentMessageId || repliedTo,
    });
    // 拾光记的日子账本：只借不给。没装、快照坏了都当今天没什么可说的。
    // 这是她选的沉浸感（设置页「今日情境」），没打开就读都不读。
    // 日子按天说一遍就够（跨天或内容变了才重新露），不每轮把节日念叨一次。
    let daybookText = "";
    try {
      const snapshot = daybookOn() ? await readDaybook(ctx) : null;
      const built = buildDaybookText(snapshot, agentId, { userName: USER_NAME });
      if (built) {
        const lifeDay = dayKey(new Date());
        const hash = daybookHash(built);
        if (shouldRevealDaybook(store.getPartnerSettings(agentId).daybook, { lifeDay, hash })) {
          daybookText = built;
          store.setPartnerSettings(agentId, { daybook: { lifeDay, hash } });
        }
      }
    } catch (error) {
      diagnostics({ event: "daybook.failed", agentId, error: describeError(error) });
    }
    const workfeedText = buildWorkfeedText(store.readWorkfeed(), agentId, { lifeDay: dayKey(new Date()), userName: USER_NAME });
    const systemPrompt = buildSystemPrompt({
      partnerId: agentId,
      partnerName: partner?.name ?? agentId,
      // 聊天这一头开名字兜底：分享版里“没写过人设”的伙伴很常见，
      // 宁可提示词里只有名字，也不能让 ta 光着上场、顺手捡上下文里别人的名字。
      personaText: renderPersona(persona, { partnerName: partner?.name ?? agentId, userName: USER_NAME, nameFallback: true }),
      memoryText,
      knowingText,
      stickerText,
      timeText,
      daybookText,
      workfeedText,
      // 正睡着被弄醒了：这一条得让ta带着起床气回
      wakeText: wakeBlockFor(agentId),
      // 每轮都给伙伴一个真实的回应出口：正常说、只发表情包，或安静收尾。
      replyText: replyChoiceBlock({ userName: USER_NAME }),
      // 这一句只说关系走到哪儿了（有人话、不给分数）；有起跑线时额外说不必重新自我介绍
      note: relationshipNote(effectiveRelationship(knowing), knowing.relationSeed),
      userName: USER_NAME,
    });
    // 表情包进上下文不能只剩"[表情]"两个字：从本地翻出标签，把"她发的是哪张"说成人话。
    // 只查本地（图库 + 快照），不靠看图，也不靠表情包插件当场在线。
    const stickerLabels = stickerLabelMap({
      library: readStickerLibrary(ctx.dataDir),
      catalog: stickerCatalog,
    });
    const messages = threadToMessages(windowed, windowed.length, {
      userName: USER_NAME,
      describeSticker: (id) => stickerLabels.get(id) ?? null,
    });

    // 这次用哪个模型：伙伴指定 > 全局默认 > 宿主当前模型。
    // 目录拉一次，resolve 和 stream 两处共用。拉不到也不播报，退回“跟当前模型走”。
    let modelCatalog = null;
    try {
      modelCatalog = await ctx.models.list();
    } catch (error) {
      diagnostics({ event: "models.list.failed", agentId, error: describeError(error) });
    }
    const choice = resolveModelChoice(modelCatalog, {
      partnerRef: store.getPartnerSettings(agentId).model,
      globalRef: store.getGlobalSettings().model,
    });

    let generated = await generateReply(ctx, {
      systemPrompt,
      messages,
      diagnostics,
      maxTokens: 900,
      modelRef: choice ? { provider: choice.provider, model: choice.model } : null,
      catalog: modelCatalog,
    });
    const voiceRisk = inspectVoice(generated.text);
    if (voiceRisk.level === "retry") {
      diagnostics({ event: "chat.output.retry", agentId, reason: voiceRisk.reason, tail: voiceRisk.tail });
      const retried = await generateReply(ctx, {
        systemPrompt: `${systemPrompt}\n\n刚才的输出末尾疑似混入了无关字符。请只重新输出要说给对方的自然正文，不要解释格式。`,
        messages,
        diagnostics,
        maxTokens: 900,
        modelRef: choice ? { provider: choice.provider, model: choice.model } : null,
        catalog: modelCatalog,
      });
      const retryRisk = inspectVoice(retried.text);
      diagnostics({ event: "chat.output.retry.result", agentId, level: retryRisk.level, reason: retryRisk.reason });
      if (retryRisk.level !== "retry") generated = retried;
    }
    if (choice) {
      diagnostics({ event: "model.choice", agentId, source: choice.source, provider: choice.provider, model: choice.model });
    }
    const generationMs = Date.now() - startedAt;

    // ta决定这回安静收尾：看到了（已读已经盖过），但不发伙伴消息。
    // 这是正常的回应结果，不是生成失败，也不能触发五分钟重试。
    const rawGeneratedText = String(generated.text ?? "");
    const marker = parseStickerMarker(rawGeneratedText);
    // 清洗会去掉表情标记，但分条器还需要它来挑图；先取出关键词，清洗正文后再放回规范写法。
    const markerlessRaw = marker.keyword
      ? [marker.before, marker.after].filter(Boolean).join("\n")
      : rawGeneratedText;
    const cleanedText = cleanVoice(markerlessRaw, "voice");
    if (isNoReply(cleanedText)) {
      diagnostics({ event: "reply.silent", agentId, generationMs });
      return { ok: false, reason: "silent", generationMs };
    }
    const replyText = marker.keyword
      ? [cleanedText, `[表情:${marker.keyword}]`].filter(Boolean).join("\n")
      : cleanedText;
    if (replyText !== rawGeneratedText.trim()) {
      diagnostics({ event: "chat.output.cleaned", agentId });
    }
    const composed = await composeBubbles(agentId, replyText, {
      maxBubbles: store.getPref(agentId).maxBubbles ?? 6,
      history: windowed,
    });
    const { bubbles } = composed;
    if (bubbles.length === 0) {
      // 伙伴只想甩图，但这次没有可用匹配：跟安静收尾一样结束，别把图库缺图伪装成模型失败重试。
      if (marker.keyword) {
        diagnostics({ event: "reply.silent", agentId, generationMs, reason: "sticker-unavailable" });
        return { ok: false, reason: "silent", generationMs };
      }
      return { ok: false, reason: "empty", generationMs };
    }
    // 表情包那份快照到底读没读到，日志里留一笔（catalog: 0 就是没读到）；ta这回自己想甩什么词、
    // 挑没挑上、挑了哪张也记上——“marker: null”就是ta压根没想甩，跟“想了但没匹配上”是两回事
    diagnostics({
      event: "sticker.reply",
      agentId,
      catalog: stickerCatalog ? stickerCatalog.stickers.length : 0,
      marker: composed.marker || null,
      sent: composed.sentSticker,
      picked: composed.stickerId ?? null,
    });

    // 她一口气说了好几条吗（那些没接住的话头要马上进话题本）。
    // 要在落盘前数：数完再 append，否则最后一条就是ta自己回的。
    const threadRows = store.getThread(agentId).messages;
    let burst = 0;
    for (let i = threadRows.length - 1; i >= 0; i -= 1) {
      if (threadRows[i].role !== "user") break;
      burst += 1;
    }

    if (isCurrent && !isCurrent()) return { ok: false, reason: "stale", generationMs };
    const reply = {
      role: "assistant",
      text: visibleTextOf(bubbles),
      bubbles,
      via: generated.via,
      reasoningChars: generated.reasoningChars ?? 0,
      repliedTo: replyTargetId,
    };
    const stored = replaceMessageId
      ? store.patchMessage(agentId, replaceMessageId, { ...reply, editedAt: new Date().toISOString() })
      : store.appendMessage(agentId, reply);
    if (!stored) return { ok: false, reason: "message-missing", generationMs };
    return {
      ok: true,
      bubbles,
      via: generated.via,
      messageId: stored.id,
      repliedTo: replyTargetId,
      generationMs,
      sentSticker: composed.sentSticker,
      burst,
    };
  }

  /**
   * 被吵醒的那一段。生成回复时现算：ta这会儿到底睡没睡，不靠外面传进来的旧判断
   * （排期排下的那会儿在睡，真写的时候可能已经自己醒了，那就别硬安一个起床气）。
   *
   * 关键是「先有脾气、再回正事」，而且脾气得是ta自己的，不是客套的抱歉。
   */
  function wakeBlockFor(agentId, now = new Date()) {
    const settings = store.getPartnerSettings(agentId);
    const state = dozingNow(now, settings.sleep);
    if (!state.dozing) return "";
    const night = windowStartDate(now, state.window) ?? dailyKey(now);
    const count = settings.wakeNight === night ? Number(settings.wakeCount ?? 0) : 0;
    const when = `${now.getHours()} 点多`;
    const lines = [
      "【你正睡着，被吵醒了】",
      `现在${when}，你在睡${state.kind === "nap" ? "午觉" : "觉"}。她这条消息把你弄醒了。`,
      "- 你困得很，带着起床气。先按你自己的性子抱怨一两句（可以凶她、可以阴阳两句，但别真伤人），然后再回她那句话",
      "- 困倦不等于每次都要说「再睡五分钟」；这句话偶尔可以出现，但不能当成所有伙伴被吵醒时的固定台词",
      "- 每次先有一个符合当下状态的醒来反应，再接她的话；这个反应可以很短：含糊确认是谁在叫、带起床气抱怨、先问时间或发生了什么、嘴硬说自己已经醒了，或短暂撒娇。按你自己的性子选一两个，不要把这些逐项说完",
      "- 不要写「抱歉在睡觉」这种客套，那是别人不是你；用你自己的说法",
      "- 回完接着睡，不用装精神",
    ];
    if (count >= 3) {
      lines.push("- 这不是这一觉里头一回了，你明显不耐烦，可以直接说「你是不是不打算让我睡了」这种话");
    } else if (count === 2) {
      lines.push("- 这一觉里这是第二回了，比头一次更不耐烦一点");
    } else {
      lines.push("- 这一觉里头一回被吵醒，嘟囔两句就够");
    }
    return lines.join("\n");
  }

  async function runTurn(turn) {
    try {
      turn.status = "generating";
      const made = await composeReply(turn.agentId, {
        repliedTo: turn.userMessageId,
        isCurrent: () => threadGeneration(turn.agentId) === turn.threadGeneration,
      });
      turn.generationMs = made.generationMs;
      if (!made.ok) {
        if (made.reason === "silent") {
          turn.status = "ready";
          turn.bubbles = [];
          turn.silent = true;
          store.clearPendingReplyIf(turn.agentId, turn.userMessageId);
          scheduleQueuedReply(turn.agentId, made.repliedTo ?? turn.userMessageId);
          scheduleTurnCleanup(turn);
          return;
        }
        turn.status = "error";
        turn.error = { message: made.reason === "empty" ? "模型没有返回内容" : "没能生成回复" };
        store.clearPendingReplyIf(turn.agentId, turn.userMessageId);
        scheduleQueuedReply(turn.agentId, made.repliedTo ?? turn.userMessageId);
        scheduleTurnCleanup(turn);
        return;
      }

      const rhythm = { ...DEFAULT_RHYTHM, ...(store.getPref(turn.agentId).rhythm ?? {}) };
      // 睡着那会儿整段慢下来：醒着一句话三五秒，打盹要磨蹭一会儿
      if (turn.mode === "dozing") rhythm.speed = (Number(rhythm.speed) || 1) * DOZE_SLOWDOWN;
      const plan = planTurn(made.bubbles, { rhythm });
      // 生成花掉的时间要从第一条的间隔里扣掉，否则会"打字打两遍"
      const overrun = Math.max(0, turn.generationMs - plan.typingMs);
      const items = plan.items.map((item, index) => ({
        text: item.text,
        gapMs: index === 0 ? Math.max(300, item.gapMs - overrun) : item.gapMs,
      }));

      turn.bubbles = items;
      turn.via = made.via;
      turn.status = "ready";
      turn.replyMessageId = made.messageId;
      store.clearPendingReplyIf(turn.agentId, turn.userMessageId);
      scheduleMemoryWork(turn.agentId, { burst: made.burst ?? 0 });
      scheduleQueuedReply(turn.agentId, made.repliedTo ?? turn.userMessageId);
      scheduleTurnCleanup(turn);
    } catch (error) {
      turn.status = "error";
      turn.error = describeError(error);
      store.clearPendingReplyIf(turn.agentId, turn.userMessageId);
      scheduleQueuedReply(turn.agentId, turn.userMessageId);
      scheduleTurnCleanup(turn);
      diagnostics({ event: "turn.failed", agentId: turn.agentId, error: turn.error });
    }
  }

  // ────────────────── 她不在场时：只记一个时刻 ──────────────────
  //
  // 她发完就走，那边不该马上应。什么时候接、接不接，是ta的事（见总纲）。
  // 连发几条只算一条待办，取更早的那个时刻，不往后推——她一直在说就该早点接。

  const pendingReplies = new Map(); // agentId → { timer, dueAt }
  const deliveringReplies = new Set(); // 已到点、正在排队或生成中的伙伴

  function cancelScheduledReply(agentId) {
    const existing = pendingReplies.get(agentId);
    if (existing) {
      clearTimeout(existing.timer);
      pendingReplies.delete(agentId);
    }
    store.clearPendingReply(agentId);
    diagnostics({ event: "reply.cancelled", agentId, reason: "all-user-messages-recalled" });
  }

  function scheduleReplyAt(agentId, dueAt, mode = "scheduled", messageId = null) {
    const existing = pendingReplies.get(agentId);
    const merged = mergeDueAt(existing?.dueAt, dueAt);
    if (existing && merged === existing.dueAt) {
      diagnostics({ event: "reply.coalesced", agentId });
      return { scheduled: true, dueAt: existing.dueAt };
    }
    if (existing) clearTimeout(existing.timer);
    const delay = Math.max(0, merged - Date.now());
    store.setPendingReply(agentId, {
      dueAt: new Date(merged).toISOString(),
      mode,
      messageId: messageId ?? existing?.messageId ?? null,
    });
    const timer = setTimeout(() => {
      pendingReplies.delete(agentId);
      deliveringReplies.add(agentId);
      const generation = threadGeneration(agentId);
      void queueMemoryJob(agentId, () => deliverScheduledReply(agentId, generation)).finally(() => {
        deliveringReplies.delete(agentId);
      });
    }, delay);
    timer.unref?.();
    pendingReplies.set(agentId, { timer, dueAt: merged });
    diagnostics({ event: "reply.scheduled", agentId, mode, delayMs: delay });
    return { scheduled: true, dueAt: merged };
  }

  function scheduleReply(agentId, { plan, messageId = null }) {
    return scheduleReplyAt(agentId, Date.now() + plan.delayMs, plan.mode, messageId);
  }

  /** 当前回复结束后，接住生成期间新进来的话；一批只排一个回合。 */
  function scheduleQueuedReply(agentId, repliedTo) {
    const messages = store.getThread(agentId).messages;
    const targetIndex = messages.findIndex((row) => row?.id === repliedTo);
    if (targetIndex < 0) return false;
    const replyIndex = messages.findIndex((row, index) => index > targetIndex && row?.role === "assistant" && row?.repliedTo === repliedTo);
    const boundary = replyIndex < 0 ? messages.length : replyIndex;
    const queued = messages.slice(targetIndex + 1, boundary).filter((row) => row?.role === "user" && !row.recalled);
    if (!queued.length || pendingReplies.has(agentId) || deliveringReplies.has(agentId)) return false;
    const active = [...turns.values()].some((turn) => turn.agentId === agentId && ["pending", "generating"].includes(turn.status));
    if (active) return false;
    return Boolean(scheduleReplyAt(agentId, Date.now(), "queued", queued[queued.length - 1].id));
  }

  /** Hana 重启后，给还没接完的话重新挂回排期；已到点的下一轮立即处理。 */
  async function recoverPendingReplies() {
    let partners;
    try {
      partners = await listPartners();
    } catch (error) {
      diagnostics({ event: "reply.recover.failed", error: describeError(error) });
      return;
    }
    for (const partner of partners) {
      if (pendingReplies.has(partner.id) || deliveringReplies.has(partner.id)) continue;
      const pending = store.getPendingReply(partner.id);
      const messages = store.getThread(partner.id).messages;
      const targetMessageId = pending?.messageId ?? null;
      // 关机可能发生在回复已落盘、待办还没清掉的窄窗口；这种情况只收账，不再生成第二条。
      if (targetMessageId && messages.some((row) => row?.role === "assistant" && row.repliedTo === targetMessageId && !row.recalled)) {
        store.clearPendingReply(partner.id);
        diagnostics({ event: "reply.recovered.already-delivered", agentId: partner.id, messageId: targetMessageId });
        continue;
      }
      const lastAssistant = messages.findLastIndex((row) => row?.role === "assistant");
      const tail = messages.slice(lastAssistant + 1).filter((row) => row?.role === "user");
      let dueAt = Date.parse(pending?.dueAt ?? "");
      let mode = pending?.mode ?? "recovered";
      // 兼容修复前已经挂住的消息：旧账本没有 pendingReply，只能认末尾未读的用户话。
      if (!Number.isFinite(dueAt)) {
        if (tail.some((row) => !row.readAt && !row.recalled)) {
          dueAt = Date.now();
          mode = "legacy-recovered";
        }
      }
      if (!Number.isFinite(dueAt)) continue;
      const replyTargetMessageId = targetMessageId
        ?? tail.find((row) => !row.readAt && !row.recalled)?.id
        ?? null;
      scheduleReplyAt(partner.id, dueAt, mode, replyTargetMessageId);
      diagnostics({ event: "reply.recovered", agentId: partner.id, dueAt, mode });
    }
  }

  /** 到点了：生成一条回复落库（她不在也照发，等她回来看）。 */
  async function deliverScheduledReply(agentId, generation = threadGeneration(agentId)) {
    // 手机拿起来了、也点开了：这条（连同她之前连着发的那几条）就算看到过了
    const touched = store.markUserMessagesRead(agentId);
    diagnostics({ event: "reply.read", agentId, touched });
    const pending = store.getPendingReply(agentId);
    const made = await composeReply(agentId, {
      mayPass: true,
      repliedTo: pending?.messageId ?? null,
      currentMessageId: pending?.messageId ?? null,
      isCurrent: () => threadGeneration(agentId) === generation,
    });
    if (!made.ok) {
      if (made.reason === "stale") return { ok: false, reason: "stale" };
      if (made.reason === "silent" || made.reason === "passed") {
        store.clearPendingReplyIf(agentId, pending?.messageId ?? null);
        return { ok: true, silent: made.reason === "silent", passed: made.reason === "passed" };
      }
      diagnostics({ event: "reply.failed", agentId, reason: made.reason });
      scheduleReplyAt(agentId, Date.now() + 5 * 60 * 1000, "retry", pending?.messageId ?? null);
      return { ok: false, reason: made.reason };
    }
    store.clearPendingReply(agentId);
    const partners = await listPartners().catch(() => []);
    const partnerName = partners.find((row) => row.id === agentId)?.name ?? agentId;
    diagnostics({ event: "reply.delivered", agentId, bubbles: made.bubbles.length });
    void announceArrival(agentId, partnerName);
    scheduleMemoryWork(agentId, { burst: made.burst ?? 0 });
    scheduleQueuedReply(agentId, made.repliedTo ?? pending?.messageId ?? null);
    return { ok: true };
  }

  // ──────────────────── 提醒那层：输入框上方的横幅 ────────────────────
  //
  // 伙伴主动来找她的时候，她不一定开着茶话会。所以：
  //   · 横幅挂在**她最近开口的那个会话**上，跟着人走，不认屋
  //   · 只认她手动关，自动淡走不算（她可能没抬头看到）
  //   · 卡片开着不冒，静默时段不冒
  // 横幅只要 `ctx.inputBanner`，不用额外能力词。
  //
  // 原先还有一条 `app/input.status` 的未读角标贴在输入框**下方**当兜底，2026-09-12 撤了：
  // 那个位置是宿主的输入栏工具条，不是提醒位（永远占着、不能点掉、也只能按会话一个个改），
  // 提到提醒反而是误导。未读还有好友列表里那位伙伴自己的徒标，够用。

  const BANNER_ID = "chahuahui-arrived";

  const notifyState = {
    /** 她最近开口的会话（bus 事件里带回来的第二个参数） */
    activeSessionPath: null,
    /** 茶话会各页面实例的在场租约：token → 最近心跳时间 */
    panelLeases: new Map(),
    /** 页面实例序号：挡住 active/ inactive 乱序回包 */
    panelSequences: new Map(),
    /** 当前所有在场租约里最新的一次心跳 */
    panelSeenAt: 0,
    /** 当前挂着的横幅 { sessionPath, batch } */
    banner: null,
    /** 还没被手动关掉的那一批 */
    batch: null,
    /** 茶话会在场窗口过期后的重试计时器，避免横幅睡过去 */
    retryTimer: null,
  };

  function clearNotifyRetry() {
    if (!notifyState.retryTimer) return;
    clearTimeout(notifyState.retryTimer);
    notifyState.retryTimer = null;
  }

  function scheduleNotifyRetry() {
    if (notifyState.retryTimer || !notifyState.batch || !notifyState.panelSeenAt) return;
    const elapsed = Date.now() - notifyState.panelSeenAt;
    const delay = Math.max(100, PANEL_OPEN_MS - elapsed + 50);
    notifyState.retryTimer = setTimeout(() => {
      notifyState.retryTimer = null;
      void maybeShowBanner();
    }, delay);
    notifyState.retryTimer.unref?.();
  }

  function dismissBanner(sessionPath) {
    if (!sessionPath) return;
    try {
      ctx.inputBanner.dismiss({ sessionPath, bannerId: BANNER_ID });
    } catch (error) {
      diagnostics({ event: "notify.dismiss.failed", error: describeError(error) });
    }
  }

  function isPanelOpen() {
    notifyState.panelSeenAt = activePanelSeenAt(notifyState.panelLeases);
    return notifyState.panelSeenAt > 0;
  }

  /** 把当前这批挂到活跃窗口上；挂不上就记原因，不硬塞。 */
  async function maybeShowBanner() {
    const verdict = shouldAnnounce({
      now: new Date(),
      quiet: store.getGlobalSettings().quiet,
      panelOpen: isPanelOpen(),
      batch: notifyState.batch,
      activeSessionPath: notifyState.activeSessionPath,
    });
    if (!verdict.ok) {
      if (verdict.reason === "panel-open") scheduleNotifyRetry();
      diagnostics({ event: "notify.skip", reason: verdict.reason });
      return { ok: false, reason: verdict.reason };
    }

    clearNotifyRetry();
    const sessionPath = notifyState.activeSessionPath;
    const text = bannerText(notifyState.batch);
    // 从旧窗口挪走：横幅全局只留一条
    if (notifyState.banner && notifyState.banner.sessionPath !== sessionPath) {
      dismissBanner(notifyState.banner.sessionPath);
      notifyState.banner = null;
    }
    try {
      ctx.inputBanner.set({
        sessionPath,
        bannerId: BANNER_ID,
        text,
        buttons: [{ id: "ok", title: "知道了", action: { kind: "notify-plugin" } }],
      });
    } catch (error) {
      diagnostics({ event: "notify.banner.failed", sessionPath, error: describeError(error) });
      return { ok: false, reason: "set-failed" };
    }
    notifyState.banner = { sessionPath, batch: notifyState.batch };
    diagnostics({ event: "notify.banner.ok", sessionPath, text, count: notifyState.batch.count });
    return { ok: true, reason: "ok" };
  }

  /** 伙伴主动来说话了 → 记进这批，然后在她的活跃窗口上冒一下。 */
  async function announceArrival(agentId, partnerName) {
    notifyState.batch = mergeBatch(notifyState.batch, { agentId, name: partnerName });
    diagnostics({ event: "notify.arrival", agentId, count: notifyState.batch.count });
    await maybeShowBanner();
  }

  /** 她手动关掉横幅（或点了「知道了」）→ 这批翻篇，条子也从输入框上方摘下来。 */
  function acknowledgeBatch(via) {
    const banner = notifyState.banner;
    clearNotifyRetry();
    notifyState.batch = null;
    notifyState.banner = null;
    // 按钮点击宿主只管通知，「条子还留在原处」——摘下来得应用自己动手。
    // 不摘的话她点了「知道了」那条还会一直挂在那里，看着就像点不动。
    if (banner?.sessionPath) dismissBanner(banner.sessionPath);
    const at = new Date().toISOString();
    store.setBannerAck(at);
    diagnostics({ event: "notify.ack", via, at });
  }

  function handleBannerBusEvent(event) {
    // 宿主回包只有文档里那一个形状是准的，但信封到底是挂在身上还是包一层 payload，
    // 不同版本不一定一样；这里两种都认，认不出来也不报错（只是把条子留着）。
    const payload = event?.payload ?? event?.data ?? event ?? {};
    const kind = payload?.kind ?? event?.kind ?? null;
    const bannerId = payload?.bannerId ?? event?.bannerId ?? null;
    // 以后要是茶话会再挂第二条横幅，别让它们互相误伤
    if (bannerId && bannerId !== BANNER_ID) return;
    if (kind === "dismissed" || kind === "button") acknowledgeBatch(kind);
  }

  /** 她换窗口了：横幅跟着人走。 */
  async function followActiveWindow() {
    if (!notifyState.batch) return;
    if (notifyState.banner && notifyState.banner.sessionPath === notifyState.activeSessionPath) return;
    await maybeShowBanner();
  }

  // ── 内测体感测试台（发布前连同 /probe、/notify/test 一起剥掉） ──
  //
  // 把账本摆到指定的几个档位上，用**真实的提示词**和真机模型各回几次，
  // 用来看「关系往上走一格，ta 说话有没有跟着挪」。
  // 只读：不写聊天记录、不动账本、不改性格与爱好（传进来的覆盖只对这一次生效，不落盘）。
  const TASTE_BLOCKS = { time: false, sticker: false, daybook: false, wake: false };

  // 两个现成的实验（点按钮就跑这两个，不用自己配参数）。发布前连同 /probe 一起剥掉。
  const EMPTY_PERSONALITY = { surface: { tags: [], signals: [] }, inner: { tags: [], signals: [] }, updatedAt: null };
  const TASTE_EXPERIMENTS = {
    // 关系坡：只动披露系数，性格与爱好原样
    slope: {
      repeats: 2,
      probes: ["在干嘛呀", "我今天有点烦，不太想说话", "最近手边在折腾什么东西？"],
      levels: [
        { name: "0.20 还没到里层", disclosure: 0.2, turns: 30, activeDays: 18, score: 0 },
        { name: "0.30 刚过里层那道坎", disclosure: 0.3, turns: 40, activeDays: 22, score: 4 },
        { name: "0.45 里层偶尔透", disclosure: 0.45, turns: 55, activeDays: 28, score: 10 },
        { name: "0.55 里层慢慢露", disclosure: 0.55, turns: 70, activeDays: 34, score: 16 },
        { name: "0.70 爱好那道坎", disclosure: 0.7, turns: 90, activeDays: 45, score: 24 },
        { name: "0.85 里层自然、爱好更多", disclosure: 0.85, turns: 120, activeDays: 60, score: 34 },
      ],
    },
    // 说话底色：把关系旋钮拧到零，只换性格（最后一组空着做对照）
    tone: {
      repeats: 2,
      probes: ["在干嘛呀", "我今天有点烦，不太想说话"],
      levels: [
        { name: "温柔细腻", disclosure: 0, personality: applyPersonalityPreset("gentle") },
        { name: "清醒理性", disclosure: 0, personality: applyPersonalityPreset("clear") },
        { name: "俏皮灵动", disclosure: 0, personality: applyPersonalityPreset("lively") },
        { name: "安静克制", disclosure: 0, personality: applyPersonalityPreset("quiet") },
        { name: "两层空着（对照）", disclosure: 0, personality: EMPTY_PERSONALITY },
      ],
    },
    // 多轮：一段连贯的相处，一轮接一轮走，看它接后面几句时贴不贴。
    // 单句探针把「关系」这个载体切掉了，这个补上。
    multiturn: {
      repeats: 1,
      script: [
        "在干嘛呀",
        "今天有点烦，不太想说话",
        "嗯……",
        "算了不说了",
        "你在就行",
        "谢谢你啊",
      ],
      levels: [
        { name: "0.20 还没到里层", disclosure: 0.2, turns: 30, activeDays: 18, score: 0 },
        { name: "0.55 里层慢慢露", disclosure: 0.55, turns: 70, activeDays: 34, score: 16 },
        { name: "0.85 里层自然", disclosure: 0.85, turns: 120, activeDays: 60, score: 34 },
      ],
    },
    // 同档 A/B：系数都是 0.85，只差里层那一行。比跨档对比敏感得多。
    ab: {
      repeats: 3,
      probes: [
        "我今天有点烦，不太想说话",
        "你懂我在说什么吗",
        "我最近好像有点不对劲，又说不上来",
      ],
      levels: [
        { name: "A 带里层", disclosure: 0.85, turns: 120, activeDays: 60, score: 34 },
        {
          name: "B 抹掉里层",
          disclosure: 0.85,
          turns: 120,
          activeDays: 60,
          score: 34,
          personality: {
            surface: { tags: ["温柔"], signals: ["说话柔和", "会照顾对话节奏"] },
            inner: { tags: [], signals: [] },
            updatedAt: null,
          },
        },
      ],
    },
  };

  // ────────────────────── 自动性格分析（内测） ──────────────────────
  //
  // 从伙伴现有素材里提炼一份调色盘。方法论见 lib/analyze.js 顶部。
  // 只读素材、不写伙伴任何文件；结果写到 dataDir 下的 analysis-<时刻>.json。
  //
  // 注意：这一版只产「通用衍生」（一认识就该有的）。阶段衍生等关系推上去、
  // 素材厚了再增量生成——首次分析的时候根本就没有相处史。

  const ANALYZE_BUDGET = {
    identity: 8000,
    description: 2000,
    public: 2000,
    pinned: 16000,
    facts: 8000,
    experience: 14000,
    dialect: 2000,
    extra: 6000,
  };
  // 分析比聊天贪一点：这几个平时不读，但对「它是个什么样的人」有用
  const ANALYZE_EXTRA_FILES = ["memory/longterm.md", "memory/memory.md"];

  // 草稿跑到哪一步了。界面就靠这个告诉用户「在干活，没卡死」。
  // 模型调用没法报百分比，但「现在在第几步」是能说清的。
  const DRAFT_STEPS = [
    { label: "读素材", note: "翻 ta 的记忆，和你们真正说过的话" },
    { label: "收集证据", note: "挑出它做过的、说过的具体的事" },
    { label: "归纳性格", note: "从这些事里理出几个色" },
    { label: "写行为候选", note: "每个色给一批具体行为，供你挑" },
    { label: "过审", note: "一条条问：换到别人身上还成立吗" },
    { label: "写自画像", note: "先猜一版「它是怎样一个人」，给你改" },
  ];
  const draftProgress = new Map();

  function setDraftProgress(agentId, index) {
    draftProgress.set(agentId, {
      step: index,
      label: DRAFT_STEPS[index]?.label ?? "",
      at: new Date().toISOString(),
    });
  }

  /**
   * 从 session 里抽一句人话（或者返回 null）。
   *
   * 结构：{type:"message", message:{role, content:[{type:"text",text}]}}。
   * 用户那条前面往往贴着 [hana_reference] 工具清单，那是给模型看的管道料，不是她说的话，掐掉。
   */
  function extractTranscriptTurn(row) {
    if (row?.type !== "message") return null;
    const message = row.message;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") return null;
    const parts = Array.isArray(message?.content) ? message.content : [];
    let text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) return null;
    text = text.replace(/^\[hana_reference\][\s\S]*?\[\/hana_reference\]/u, "").trim();
    if (text.length < 4) return null;
    const clipped = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return { role, text: clipped.replace(/\s+/g, " ").trim() };
  }

  /**
   * 读主对话框里真正说过的话。
   *
   * 原来只读伙伴的记忆和经验——那些都是工作笔记，提炼出来的「性格」也就全是工作流程。
   * 真正能看出一个人什么样子的东西在这儿：agents/<id>/sessions/*.jsonl，
   * 跟记忆文件在同一个根下，直接读磁盘。只读最近的几个文件，从近往远攒够字数就停。
   */
  /**
   * 列目录也得走 ctx.resources。
   *
   * 为什么不用 fs.readdirSync：Hana 跑 App 时开了 Node 的权限模型，
   * fs 只能碰放行过的路径（App 自己的 dataDir）。实测 readdirSync("agents/<id>/sessions")
   * 直接 ERR_ACCESS_DENIED——而人格记忆祥 ctx.resources 读得到，因为那才是用户资源的正门。
   *
   * 返回形状各家版本不一定一样，这里把能认的都认一遍；实在认不出来就把原样写进诊断，
   * 好歹下一次不用再猜。
   */
  function pickSessionNames(result) {
    const raw = Array.isArray(result)
      ? result
      : result?.entries ?? result?.items ?? result?.children ?? result?.files ?? result?.content;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => (typeof row === "string" ? row : row?.name ?? row?.path ?? null))
      .filter((name) => typeof name === "string")
      .map((name) => path.basename(name))
      .filter((name) => name.endsWith(".jsonl"));
  }

  async function listSessionFiles(agentId) {
    if (!isValidPartnerId(agentId)) return [];
    const dir = path.join(agentsRoot, agentId, "sessions");
    try {
      // 列目录用 list，不能用 read：read 只认文件，拿来撞目录会直接甩
      // "resource is not a file"。
      const result = await ctx.resources.list({ kind: "local-file", path: dir });
      const names = pickSessionNames(result);
      if (names.length) return names;
      diagnostics({ event: "analyze.transcripts.list", agentId, got: 0, keys: Object.keys(result ?? {}) });
    } catch (error) {
      diagnostics({
        event: "analyze.transcripts.list",
        agentId,
        error: error?.message ?? String(error),
      });
    }
    return [];
  }

  /** 读一个文件的正文字。同样走 ctx.resources。 */
  async function readResourceText(filePath) {
    try {
      const result = await ctx.resources.read({ kind: "local-file", path: filePath });
      const content = result?.content;
      if (typeof content === "string") return content;
      if (content && !Array.isArray(content) && typeof content.toString === "function") {
        return content.toString("utf8");
      }
      return "";
    } catch (error) {
      diagnostics({ event: "analyze.transcripts.read.failed", path: filePath, error: describeError(error) });
      return "";
    }
  }

  async function readTranscripts(agentId, { files = 3, maxChars = 12000, partnerName = "", userName = "" } = {}) {
    if (!isValidPartnerId(agentId)) return "";
    const dir = path.join(agentsRoot, agentId, "sessions");
    const names = await listSessionFiles(agentId);
    if (!names.length) return "";
    names.sort().reverse();
    const who = { user: userName || "她", assistant: partnerName || "ta" };
    const out = [];
    let used = 0;
    for (const file of names.slice(0, files)) {
      const raw = await readResourceText(path.join(dir, file));
      if (!raw) continue;
      const turns = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const turn = extractTranscriptTurn(parsed);
        if (turn) turns.push(turn);
      }
      // 从后往前收：近的话先要，远的攒不满就算
      for (let i = turns.length - 1; i >= 0 && used < maxChars; i -= 1) {
        out.push(`${who[turns[i].role]}：${turns[i].text}`);
        used += turns[i].text.length + 4;
      }
    }
    out.reverse();
    return out.join("\n");
  }

  function renderAnalyzeMaterial(persona) {
    const parts = [];
    const push = (label, text) => {
      if (typeof text === "string" && text.trim()) parts.push(`【${label}】\n${text.trim()}`);
    };
    const files = persona?.files ?? {};
    push("人格（identity.md）", files.identity);
    push("说话口吻", files.dialect);
    push("自我介绍（description.md）", files.description);
    push("对外公开（AGENTS.public.md）", files.public);
    push("钉选记忆（pinned.md）", files.pinned);
    push("记忆（memory/facts.md）", files.facts);
    push("经验（experience.md）", files.experience);
    for (const [rel, text] of Object.entries(persona?.extras ?? {})) push(rel, text);
    return parts.join("\n\n");
  }

  function clipStep(text) {
    const body = String(text ?? "");
    return body.length > 4000 ? `${body.slice(0, 4000)}\n…（后略，原文 ${body.length} 字）` : body;
  }

  async function analyzePersonalityOnce(input = {}) {
    const agentId = String(input?.agentId ?? "").trim();
    if (!agentId) throw new Error("要带 agentId");
    const maxRounds = Math.max(1, Math.min(3, Number(input?.rounds) || 2));

    const [partners, persona] = await Promise.all([
      listPartners(),
      loadPersona(ctx, { agentsRoot, agentId, budget: ANALYZE_BUDGET, extra: ANALYZE_EXTRA_FILES }),
    ]);
    const partner = partners.find((row) => row.id === agentId) ?? { id: agentId, name: agentId };
    const material = renderAnalyzeMaterial(persona);
    if (material.trim().length < 200) {
      return {
        ok: false,
        agentId,
        note: "素材太薄，分析不出东西来。这类伙伴先让它活一阵子再分析。",
        materialChars: material.length,
      };
    }

    let modelCatalog = null;
    try {
      modelCatalog = await ctx.models.list();
    } catch (error) {
      diagnostics({ event: "analyze.models.failed", agentId, error: describeError(error) });
    }
    const choice = resolveModelChoice(modelCatalog, {
      partnerRef: store.getPartnerSettings(agentId).model,
      globalRef: store.getGlobalSettings().model,
    });
    const modelRef = choice ? { provider: choice.provider, model: choice.model } : null;
    const modelLabel = choice ? `${choice.provider}/${choice.model}` : null;
    const call = (systemPrompt, userContent, maxTokens) =>
      generateReply(ctx, {
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        diagnostics,
        maxTokens,
        modelRef,
        catalog: modelCatalog,
        temperature: 0.3,
      });

    const notes = [];
    const steps = [];

    // ── 一、证据。这一步只要事实，不要判断。 ──
    const ev = await call(
      "你是一个只做证据收集的分析者。严格按要求输出，不加寒暄，不写导语。",
      buildEvidencePrompt({ partnerName: partner.name, material }),
      2400,
    );
    steps.push({ step: "evidence", text: clipStep(ev.text), via: ev.via });
    const evidence = parseEvidence(ev.text);
    if (!evidence.length) {
      return { ok: false, agentId, model: modelLabel, note: "模型说素材不足，一条证据都没挑出来", steps };
    }

    // ── 二、归色。每个色都得有证据撑着。 ──
    const pal = await call(
      "你是一个归纳性格结构的分析者。只输出 JSON，不加解释。",
      buildPalettePrompt({ partnerName: partner.name, evidence }),
      1200,
    );
    steps.push({ step: "palette", text: clipStep(pal.text), via: pal.via });
    let palette = normalizeColorPalette(parseJsonLoose(pal.text));
    if (!palette) {
      notes.push("归色那步没解析出结构，用单色兑底");
      palette = { base: { name: "底色", evidence: [] }, main: [], accent: [] };
    }

    // ── 三、写衍生 → 四、替换测试，被划掉的下一轮回炉 ──
    let derivatives = [];
    let feedback = [];
    let rounds = 0;
    for (let round = 1; round <= maxRounds; round += 1) {
      rounds = round;
      const gen = await call(
        "你是一个写性格行为的作者。只输出 JSON，不加解释。",
        buildDerivativePrompt({ partnerName: partner.name, evidence, palette, feedback }),
        2400,
      );
      steps.push({ step: `derivatives.r${round}`, text: clipStep(gen.text), via: gen.via });
      const written = normalizeDerivatives(parseJsonLoose(gen.text));
      if (!written.length) {
        notes.push(`第 ${round} 轮一条衍生都没写出来`);
        break;
      }

      const judge = await call(
        "你是一个严格的审稿人。你不认识这位伙伴，只看句子本身。只输出 JSON，不加解释。",
        buildReplaceTestPrompt({ partnerName: partner.name, candidates: written }),
        1200,
      );
      steps.push({ step: `replaceTest.r${round}`, text: clipStep(judge.text), via: judge.via });
      const verdict = parseReplaceTest(judge.text, written.length);
      if (verdict.unparsed) notes.push(`第 ${round} 轮审稿回复没解析出来，整批留下`);

      derivatives = [
        ...verdict.kept.map((i) => ({ ...written[i], dropped: false, round })),
        ...verdict.dropped.map((d) => ({ ...written[d.index], dropped: true, dropReason: d.reason, round })),
      ];
      feedback = verdict.dropped.map((d) => written[d.index].text);
      if (!feedback.length) break;
    }

    const result = summarizeRun({
      agentId,
      model: modelLabel,
      evidence,
      palette,
      derivatives,
      rounds,
      notes,
    });
    diagnostics({
      event: "analyze.personality",
      agentId,
      rounds,
      ...result.stats,
      materialChars: material.length,
    });
    return {
      ok: true,
      partner: { id: partner.id, name: partner.name },
      materialChars: material.length,
      steps,
      ...result,
    };
  }

  // ────────────────────── 捏人：出草稿（内测） ──────────────────────
  //
  // 跟 analyzePersonalityOnce 的区别：这里产的是「色 + 候选行为池」，交给用户挑；
  // 挑完才算定稿。草稿存 v2/partners/<id>/palette-draft.json，捏完清掉。

  async function draftPaletteOnce(agentId, input = {}) {
    setDraftProgress(agentId, 0);
    const [partners, persona] = await Promise.all([
      listPartners(),
      store.localPartner(agentId)
        ? getPersona(agentId)
        : loadPersona(ctx, { agentsRoot, agentId, budget: ANALYZE_BUDGET, extra: ANALYZE_EXTRA_FILES }),
    ]);
    const partner = partners.find((row) => row.id === agentId) ?? { id: agentId, name: agentId };
    // 素材分两块：伙伴自己写的（记忆、经验）＋ 跟这个人真正说过的话。
    // 只给前一块的话，提炼出来的永远是工作流程——因为前一块就是工作笔记。
    const transcript = await readTranscripts(agentId, { partnerName: partner.name, userName: USER_NAME });
    const material = [
      renderAnalyzeMaterial(persona),
      transcript ? `【${partner.name}和${USER_NAME}真正说过的话（最近节选）】\n${transcript}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const isLocal = Boolean(store.localPartner(agentId));
    if (material.trim().length < (isLocal ? 20 : 200)) {
      return { ok: false, agentId, note: isLocal ? "先给这位角色补几句描述，或者改走认真认识 ta。" : "素材太薄，先让 ta 活一阵子。" };
    }

    let modelCatalog = null;
    try {
      modelCatalog = await ctx.models.list();
    } catch (error) {
      diagnostics({ event: "onboarding.models.failed", agentId, error: describeError(error) });
    }
    const choice = resolveModelChoice(modelCatalog, {
      partnerRef: store.getPartnerSettings(agentId).model,
      globalRef: store.getGlobalSettings().model,
    });
    const modelRef = choice ? { provider: choice.provider, model: choice.model } : null;
    const modelLabel = choice ? `${choice.provider}/${choice.model}` : null;
    const call = (systemPrompt, userContent, maxTokens) =>
      generateReply(ctx, {
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        diagnostics,
        maxTokens,
        modelRef,
        catalog: modelCatalog,
        temperature: 0.3,
      });

    const notes = [];

    // 一、证据
    setDraftProgress(agentId, 1);
    const ev = await call(
      "你是一个只做证据收集的分析者。严格按要求输出，不加寒暄，不写导语。",
      buildEvidencePrompt({ partnerName: partner.name, material }),
      2400,
    );
    const evidence = parseEvidence(ev.text);
    if (!evidence.length) {
      return { ok: false, agentId, model: modelLabel, note: "模型说素材不足，一条证据都没挑出来" };
    }

    // 二、色 + 候选池
    setDraftProgress(agentId, 2);
    const draftReply = await call(
      "你是一个写性格的作者。只输出 JSON，不加解释。",
      buildDraftColorsPrompt({ partnerName: partner.name, evidence }),
      2600,
    );
    let colors = normalizeDraftColors(parseJsonLoose(draftReply.text));
    if (!colors.length) {
      return { ok: false, agentId, model: modelLabel, note: "草稿没解析出色来，再跑一次试试" };
    }

    // 三、替换测试：把池子摄平了一次性送审
    setDraftProgress(agentId, 3);
    const flat = flattenDraftRows(colors);
    let dropped = [];
    try {
      const judge = await call(
        "你是一个严格的审稿人。你不认识这位伙伴，只看句子本身。只输出 JSON，不加解释。",
        buildReplaceTestPrompt({ partnerName: partner.name, candidates: flat }),
        2000,
      );
      const verdict = parseReplaceTest(judge.text, flat.length);
      const pruned = applyVerdictToDraft(colors, verdict, flat);
      colors = pruned.colors;
      dropped = pruned.dropped;
      if (pruned.unparsed) notes.push("审稿回复没解析出来，池子没删");
    } catch (error) {
      notes.push(`替换测试没跑成（${describeError(error).message}），池子先全留着`);
    }

    // 四、被划得太狠的色，补一次（带着「太通用」的反馈，最多补一轮）
    setDraftProgress(agentId, 4);
    if (input?.refill !== false) {
      for (const color of colors) {
        if ((color.rows?.length ?? 0) >= 3) continue;
        try {
          const refill = await call(
            "你是一个写性格行为的作者。只输出 JSON，不加解释。",
            buildRefillPrompt({
              partnerName: partner.name,
              evidence,
              color,
              feedback: dropped.filter((row) => row.color === color.name).map((row) => row.text),
            }),
            900,
          );
          const rows = (parseJsonLoose(refill.text)?.rows ?? [])
            .map((item) => String(item ?? "").trim().replace(/\s+/g, " "))
            .filter((item) => item.length >= 6 && item.length <= 120)
            .slice(0, 4);
          const merged = [...(color.rows ?? [])];
          let index = merged.length;
          for (const text of rows) {
            if (merged.some((row) => row.text === text)) continue;
            index += 1;
            merged.push({ id: `${color.id}_r${index}`, text, origin: "model" });
          }
          color.rows = merged.slice(0, 5);
        } catch (error) {
          notes.push(`给「${color.name}」补候选没成`);
        }
      }
    }

    // 六、写一版「它是怎样一个人」——给用户当底稿，她在上面改
    setDraftProgress(agentId, 5);
    let portrait = [];
    try {
      const pr = await call(
        "你是一个写人物说明的作者。只输出 JSON，不加解释。",
        buildSelfPortraitPrompt({ partnerName: partner.name, material }),
        4000,
      );
      portrait = normalizePortrait(parseJsonLoose(pr));
      diagnostics({
        event: "onboarding.portrait",
        agentId,
        chars: String(pr ?? "").length,
        got: portrait.length,
        head: String(pr ?? "").slice(0, 160),
      });
    } catch (error) {
      diagnostics({ event: "onboarding.portrait.failed", agentId, error: describeError(error) });
    }

    const draft = summarizeDraft({ agentId, model: modelLabel, colors, dropped, notes });
    draft.portrait = portrait;
    store.savePaletteDraft(agentId, draft);
    draftProgress.delete(agentId);
    diagnostics({
      event: "onboarding.draft",
      agentId,
      ...draft.stats,
      materialChars: material.length,
      transcriptChars: transcript.length,
    });
    return { ok: true, partner: { id: partner.id, name: partner.name }, materialChars: material.length, ...draft };
  }

  /** 后台跑草稿（模型调用慢，不卡路由），跑完写进草稿文件。 */
  function startPaletteDraft(input = {}) {
    const agentId = String(input?.agentId ?? "").trim();
    void (async () => {
      try {
        const result = await draftPaletteOnce(agentId, input);
        if (!result?.ok) {
          store.savePaletteDraft(agentId, {
            agentId,
            colors: [],
            error: { message: result?.note ?? "这位角色的描述还不够，先走认真认识 ta。" },
          });
        }
        diagnostics({ event: "onboarding.draft.done", agentId, ok: Boolean(result?.ok) });
      } catch (error) {
        store.savePaletteDraft(agentId, { agentId, error: describeError(error), colors: [] });
        ctx.logger.error(`[${name}] 捏人草稿跑挂: ${error?.message || error}`);
      }
    })();
    return { ok: true, agentId, running: true };
  }

  /**
   * 后台跑一轮性格分析（模型调用慢，不卡路由也不卡工具）。
   * 结果写到 dataDir 下的 analysis-<时刻>.json，立刻把路径还回去。
   */
  function startPersonalityAnalysis(input = {}) {
    const file = path.join(ctx.dataDir, "v2", `analysis-${Date.now().toString(36)}.json`);
    void (async () => {
      try {
        const result = await analyzePersonalityOnce(input);
        fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
        diagnostics({ event: "analyze.done", file, ok: Boolean(result?.ok) });
      } catch (error) {
        try {
          fs.writeFileSync(file, JSON.stringify({ ok: false, error: describeError(error) }, null, 2), "utf8");
        } catch {
          /* 连错误都写不下去就算了，日志里还有一条 */
        }
        ctx.logger.error(`[${name}] 性格分析跑挂: ${error?.message || error}`);
      }
    })();
    return { ok: true, file, running: true };
  }

  async function tasteProbeOnce(input = {}) {
    const agentId = String(input?.agentId ?? "").trim();
    if (!agentId) throw new Error("要带 agentId");
    const probes = Array.isArray(input?.probes) && input.probes.length
      ? input.probes.map((row) => String(row ?? "").trim()).filter(Boolean).slice(0, 6)
      : ["在干嘛呀", "我今天好累，什么都不想做"];
    const repeats = Math.max(1, Math.min(5, Number(input?.repeats) || 1));
    // 多轮脚本：给了就一轮一轮走，不给就还是单句探针
    const script = Array.isArray(input?.script)
      ? input.script.map((row) => String(row ?? "").trim()).filter(Boolean).slice(0, 12)
      : [];
    const levels = Array.isArray(input?.levels) && input.levels.length
      ? input.levels.slice(0, 12)
      : [
          { name: "初识", turns: 3, activeDays: 1, score: 0 },
          { name: "刚熟", turns: 12, activeDays: 5, score: 8 },
          { name: "渐熟", turns: 20, activeDays: 10, score: 16 },
          { name: "亲近", turns: 30, activeDays: 15, score: 24 },
          { name: "很深", turns: 60, activeDays: 30, score: 45 },
        ];
    const blocks = {
      ...TASTE_BLOCKS,
      ...(input?.blocks && typeof input.blocks === "object" ? input.blocks : {}),
    };

    const [partners, persona] = await Promise.all([listPartners(), getPersona(agentId)]);
    const partner = partners.find((row) => row.id === agentId) ?? { id: agentId, name: agentId };
    const personaText = renderPersona(persona, { partnerName: partner.name, userName: USER_NAME });
    const memoryText = buildMemoryBlock(store.readMemory(agentId));
    const knowing = store.getKnowing(agentId);
    const personality = input?.personality ?? knowing.personality;
    const hobbies = Array.isArray(input?.hobbies) ? input.hobbies : knowing.hobbies;

    // 时间感、表情包、日子账本、被吵醒——都由开关决定带不带，默认全关（跟老行为一致）。
    let timeText = "";
    if (blocks.time) {
      timeText = timeBlock({
        now: new Date(),
        messages: store.getThread(agentId).messages,
        userName: USER_NAME,
        sleep: store.getPartnerSettings(agentId).sleep,
      });
    }
    let stickerText = "";
    if (blocks.sticker) {
      try {
        const stickerIndex = await readCatalog(ctx);
        if (stickerIndex) stickerText = buildStickerHint(buildCatalog(stickerIndex, agentId));
      } catch (error) {
        diagnostics({ event: "probe.taste.sticker.failed", agentId, error: describeError(error) });
      }
    }
    let daybookText = "";
    if (blocks.daybook) {
      try {
        const snapshot = await readDaybook(ctx);
        daybookText = buildDaybookText(snapshot, agentId, { userName: USER_NAME }) || "";
      } catch (error) {
        diagnostics({ event: "probe.taste.daybook.failed", agentId, error: describeError(error) });
      }
    }
    const wakeText = blocks.wake ? wakeBlockFor(agentId) : "";

    let modelCatalog = null;
    try {
      modelCatalog = await ctx.models.list();
    } catch (error) {
      diagnostics({ event: "probe.taste.models.failed", agentId, error: describeError(error) });
    }
    const choice = resolveModelChoice(modelCatalog, {
      partnerRef: store.getPartnerSettings(agentId).model,
      globalRef: store.getGlobalSettings().model,
    });

    const out = [];
    for (const level of levels) {
      const rel = {
        familiarity: {
          turns: Math.max(0, Number(level?.turns) || 0),
          activeDays: Math.max(0, Number(level?.activeDays) || 0),
          firstSeenAt: null,
          lastInteractionAt: null,
          lastActiveDay: null,
        },
        intimacy: {
          score: Math.max(0, Number(level?.score) || 0),
          signalCount: 0,
          signalDays: 0,
          daily: { day: null, score: 0, types: [] },
        },
        events: [],
        stage: 0,
      };
      // 起跑线只抬相处史（熟悉度），亲密度一个字不动——跟真实那条路同一个合并方式。
      const seedTurns = Math.max(0, Number(level?.seedTurns) || 0);
      const seedDays = Math.max(0, Number(level?.seedDays) || 0);
      const seed = seedTurns || seedDays ? { turns: seedTurns, activeDays: seedDays } : null;
      const merged = mergeRelationship(rel, seed);
      // 给了明确的系数就用它（好精确摆在坡的边界上），没给就按账本反推
      const explicit = Number(level?.disclosure);
      const ratio = Number.isFinite(explicit)
        ? Math.max(0, Math.min(1, explicit))
        : disclosureRatio(merged);
      const levelPersonality = level?.personality ?? personality;
      const levelHobbies = Array.isArray(level?.hobbies) ? level.hobbies : hobbies;
      const knowingText = buildKnowingText({
        disclosure: ratio,
        personality: levelPersonality,
        hobbies: levelHobbies,
        recognition: merged?.recognition ?? knowing.recognition,
        palette: merged?.palette ?? knowing.palette,
        userName: USER_NAME,
      });
      const note = relationshipNote(merged, seed);
      const systemPrompt = buildSystemPrompt({
        partnerId: agentId,
        partnerName: partner.name ?? agentId,
        personaText,
        memoryText,
        knowingText,
        stickerText,
        timeText,
        daybookText,
        wakeText,
        passText: "",
        note,
        userName: USER_NAME,
      });
      const replies = [];
      // 内测对账：把每条原始流的尾巴留下来，看怪字符是 provider 发的还是解析吞的
      const streamTails = [];
      const onRaw = (raw) => {
        const text = String(raw ?? "");
        streamTails.push({ len: text.length, tail: text.slice(-500) });
      };
      if (script.length) {
        // 多轮：一轮接一轮走，前一轮的回复也进上下文。关系这种东西得连着看。
        const messages = [];
        for (let i = 0; i < script.length; i += 1) {
          messages.push({ role: "user", content: script[i] });
          const generated = await generateReply(ctx, {
            systemPrompt,
            messages: [...messages],
            diagnostics,
            maxTokens: 900,
            modelRef: choice ? { provider: choice.provider, model: choice.model } : null,
            catalog: modelCatalog,
            onRaw,
          });
          // assistant 的内容得是 parts 数组，不是裸字符串——传字符串宿主会抛
          // 「assistant.content must be an array」，整条流直接失败退到 utility
          messages.push({ role: "assistant", content: [{ type: "text", text: String(generated.text ?? "") }] });
          replies.push({ probe: script[i], round: i + 1, text: generated.text, via: generated.via });
        }
      } else {
        for (const probe of probes) {
          for (let round = 1; round <= repeats; round += 1) {
            const generated = await generateReply(ctx, {
              systemPrompt,
              messages: [{ role: "user", content: probe }],
              diagnostics,
              maxTokens: 900,
              modelRef: choice ? { provider: choice.provider, model: choice.model } : null,
              catalog: modelCatalog,
              onRaw,
            });
            replies.push({ probe, round, text: generated.text, via: generated.via });
          }
        }
      }
      out.push({
        level: String(level?.name ?? ""),
        turns: rel.familiarity.turns,
        activeDays: rel.familiarity.activeDays,
        score: rel.intimacy.score,
        seed,
        ratio,
        note,
        knowingText,
        promptChars: systemPrompt.length,
        streamTails,
        replies,
      });
    }
    diagnostics({ event: "probe.taste", agentId, levels: out.length, probes: probes.length, repeats });
    return { ok: true, agentId, model: choice ? `${choice.provider}/${choice.model}` : null, blocks, repeats, probes, script, levels: out };
  }

  /**
   * 后台跑一轮体感测试（模型调用慢，不卡路由也不卡工具）。
   * 结果写到 dataDir 下的 taste-<时刻>.json，立刻把路径还回去。
   */
  function startTasteProbe(input = {}) {
    const file = path.join(ctx.dataDir, "v2", `taste-${Date.now().toString(36)}.json`);
    void (async () => {
      try {
        const result = await tasteProbeOnce(input);
        fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
        diagnostics({ event: "probe.taste.done", file, levels: result.levels.length });
      } catch (error) {
        try {
          fs.writeFileSync(file, JSON.stringify({ ok: false, error: describeError(error) }, null, 2), "utf8");
        } catch {
          /* 连错误都写不下去就算了，日志里还有一条 */
        }
        ctx.logger.error(`[${name}] 体感测试跑挂: ${error?.message || error}`);
      }
    })();
    return file;
  }

  // ─────────────────────────── 路由 ───────────────────────────

  try {
    ctx.routes.register((app) => {
      app.get("/partners", async (c) => {
        try {
          const partners = (await listPartners()).map((row) => {
            const thread = store.getThread(row.id);
            const last = thread.messages[thread.messages.length - 1] ?? null;
            const settings = store.getPartnerSettings(row.id);
            const vision = effectiveVisionConfig(store.getGlobalSettings().vision, settings.vision);
            return {
              ...row,
              unread: store.unreadCount(row.id),
              // 背景元数据跟着轮询下发：她在设置页换完图，聊天窗最迟一轮就自己跟上
              background: store.getPartnerSettings(row.id).background,
              imageCapability: {
                allowed: Boolean(vision.model && vision.status === "verified"),
                source: vision.source,
                status: vision.status,
                error: vision.error,
              },
              lastMessage: last
                ? { text: String(last.text ?? "").slice(0, 60), at: last.at, role: last.role }
                : null,
            };
          });
          return c.json({
            ok: true,
            partners,
            totalUnread: partners.reduce((sum, row) => sum + row.unread, 0),
            lastPartnerId: store.getLastPartner(),
            // 账本读到坏文件时 store 会把坏的挪走留档：这里捼一句，让界面能告诉她
            dataWarning: store.getCorruptNotice(),
            // 聊天窗要用的外观开关（跟轮询走，她在设置里改完最迟一轮就生效）
            messageAvatars: Boolean(store.getGlobalSettings().messageAvatars),
            messageRefine: Boolean(store.getGlobalSettings().messageRefine),
            // 聊天窗那条淡字前面的表情：跟叫法表同源，不在前端另拄一份
            actionStyles: ACTION_STYLES.map((s) => ({ id: s.id, emoji: s.emoji })),
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.get("/thread/:agentId", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const thread = store.getThread(agentId);
          const persona = await getPersona(agentId);
          store.setLastPartner(agentId);
          // 硬撤回的占位要说这位伙伴自己的名字，不写死某个人。
          // 名字拿不到（伙伴已移出、清单读不出来）就退回中性文案，不因此让整条线程拉不动。
          let recallLabel = "对方撤回了一条消息";
          try {
            const partners = await listPartners();
            const hit = partners.find((row) => row.id === agentId);
            if (hit?.name) recallLabel = `${hit.name}撤回了一条消息`;
          } catch { /* 拿不到名字就用中性文案 */ }
          // 这里不再盖章「已读」：拉一次记录不等于她看过（轮询也走这条路，
          // 窗口开着而人不在的时候，会把没看过的消息全标成已读）。
          // 真看过由前端在「可见且有焦点」时显式上报，见下面的 /read。
          return c.json({
            ok: true,
            agentId,
            messages: thread.messages.filter((message) =>
              !message?.recalled || message.recallMode !== "hard" || message.role === "assistant"
            ).map((message) => {
              if (message?.role === "assistant" && message.recalled && message.recallMode === "hard") {
                return { ...message, text: recallLabel, bubbles: null, kind: "recalled" };
              }
              if (message?.role !== "user") return message;
              const active = [...turns.values()].find((turn) => turn.agentId === agentId && turn.userMessageId === message.id);
              const verdict = recallEligibility(message, {
                processing: Boolean(active && ["pending", "generating", "ready"].includes(active.status)),
                delivering: deliveringReplies.has(agentId),
              });
              return { ...message, recall: verdict };
            }),
            pref: store.getPref(agentId),
            persona: { readAt: persona.readAt, errors: persona.errors },
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/thread/:agentId/read", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          let body = null;
          try { body = await c.req.json(); } catch { body = null; }
          const throughId = typeof body?.throughId === "string" ? body.throughId.trim() : null;
          const result = store.markRead(agentId, throughId ? { throughId } : {});
          diagnostics({ event: "thread.read", agentId, changed: result.changed, throughId: result.readThroughId });
          return c.json({ ok: true, ...result, unread: store.unreadCount(agentId) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/thread/:agentId/clear", (c) => {
        const agentId = c.req.param("agentId");
        threadGenerations.set(agentId, threadGeneration(agentId) + 1);
        cancelScheduledReply(agentId);
        store.clearThread(agentId);
        diagnostics({ event: "thread.cleared", agentId });
        return c.json({ ok: true });
      });

      app.post("/thread/:agentId/refine/:messageId/edit", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        const messageId = String(c.req.param("messageId") ?? "").trim();
        if (!store.getGlobalSettings().messageRefine) return c.json({ ok: false, error: { message: "回复修整入口还没打开" } }, 403);
        let body;
        try { body = await c.req.json(); } catch { return c.json({ ok: false, error: { message: "修改内容没读懂" } }, 400); }
        const text = String(body?.text ?? "").trim().slice(0, 4000);
        const thread = store.getThread(agentId);
        const message = thread.messages.find((row) => row.id === messageId);
        const lastAssistant = thread.messages.findLast((row) => row.role === "assistant" && !row.recalled);
        if (!message || message.role !== "assistant") return c.json({ ok: false, error: { message: "只能调整伙伴的回复" } }, 404);
        if (lastAssistant?.id !== messageId) return c.json({ ok: false, error: { message: "只能调整最后一条伙伴回复" } }, 409);
        if (!text) return c.json({ ok: false, error: { message: "回复不能改成空白" } }, 400);
        const updated = store.patchMessage(agentId, messageId, {
          text,
          bubbles: [text],
          editedAt: new Date().toISOString(),
          userRefined: true,
        });
        diagnostics({ event: "message.refined", agentId, messageId, mode: "edit" });
        return c.json({ ok: true, message: updated });
      });

      app.post("/thread/:agentId/refine/:messageId/regenerate", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        const messageId = String(c.req.param("messageId") ?? "").trim();
        if (!store.getGlobalSettings().messageRefine) return c.json({ ok: false, error: { message: "回复修整入口还没打开" } }, 403);
        const thread = store.getThread(agentId);
        const index = thread.messages.findIndex((row) => row.id === messageId);
        const message = index >= 0 ? thread.messages[index] : null;
        const lastAssistant = thread.messages.findLast((row) => row.role === "assistant" && !row.recalled);
        if (!message || message.role !== "assistant" || lastAssistant?.id !== messageId) {
          return c.json({ ok: false, error: { message: "只能重新生成最后一条伙伴回复" } }, 409);
        }
        const repliedTo = thread.messages.slice(0, index).findLast((row) => row.role === "user" && !row.recalled)?.id ?? null;
        // 生成期间她可能又发了新消息（或者清了聊天），那这次重做的结果就不该再往上贴。
        const gen = threadGeneration(agentId);
        const made = await composeReply(agentId, {
          repliedTo,
          excludeMessageId: messageId,
          replaceMessageId: messageId,
          isCurrent: () => threadGeneration(agentId) === gen
            && store.getThread(agentId).messages.findLast((row) => row.role === "assistant" && !row.recalled)?.id === messageId,
        });
        if (!made.ok) {
          const stale = made.reason === "stale";
          return c.json({ ok: false, error: { message: stale ? "这条回复已经不是最后一条了，刷新看看再重做" : "这次没生成出新的回复" } }, 409);
        }
        diagnostics({ event: "message.refined", agentId, messageId, mode: "regenerate" });
        return c.json({ ok: true, messageId, bubbles: made.bubbles });
      });

      app.post("/thread/:agentId/retract/:messageId", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        const messageId = String(c.req.param("messageId") ?? "").trim();
        const message = store.getThread(agentId).messages.find((row) => row.id === messageId);
        if (!message) return c.json({ ok: false, error: { message: "这条消息已经不在聊天记录里了" } }, 404);
        const active = [...turns.values()].find((turn) => turn.agentId === agentId && turn.userMessageId === messageId);
        const verdict = recallEligibility(message, {
          processing: Boolean(active && ["pending", "generating", "ready"].includes(active.status)),
          delivering: deliveringReplies.has(agentId),
        });
        if (!verdict.ok) {
          const messages = {
            expired: "这条消息已经发出去一阵了，不能撤回",
            processing: "ta已经开始看这条消息了，现在撤回会把上下文扯断",
            replying: "ta已经在接这条消息了，现在撤回会把上下文扯断",
            "not-user": "只能撤回自己发出的消息",
          };
          return c.json({ ok: false, error: { message: messages[verdict.reason] ?? "这条消息现在不能撤回" } }, 409);
        }
        let result;
        if (verdict.read) {
          result = store.patchMessage(agentId, messageId, {
            kind: "recalled",
            text: "你撤回了一条消息",
            bubbles: null,
            recalled: true,
            recalledAt: new Date().toISOString(),
          });
        } else {
          result = store.patchMessage(agentId, messageId, {
            text: "你撤回了一条消息",
            bubbles: null,
            recalled: true,
            recallMode: "hard",
            recalledAt: new Date().toISOString(),
          });
          if (store.getPendingReply(agentId) && shouldCancelScheduledReply(store.getThread(agentId).messages)) {
            cancelScheduledReply(agentId);
          }
        }
        diagnostics({ event: "message.retracted", agentId, messageId, read: verdict.read });
        return c.json({ ok: true, mode: verdict.read ? "placeholder" : "removed", message: result, expiresAt: verdict.expiresAt });
      });

      app.get("/attachment/:agentId/:id", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(agentId)) return c.json({ ok: false, error: { message: "图片归属不合法" } }, 403);
        const attachment = readAttachment(c.req.param("id"), agentId);
        if (!attachment) return c.json({ ok: false, error: { message: "图片不存在" } }, 404);
        return c.body(attachment.data, 200, {
          "content-type": attachment.mimeType,
          "cache-control": "private, max-age=31536000, immutable",
        });
      });

      app.post("/turns", async (c) => {
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: { message: "invalid-json" } }, 400);
        }
        const agentId = String(body?.agentId ?? "").trim();
        const text = String(body?.text ?? "").trim();
        const stickerId = String(body?.stickerId ?? "").trim();
        const imageInput = body?.image && typeof body.image === "object" ? body.image : null;
        // 回复是伙伴自己的慢节奏，不能占住她的发送门；正在处理时的新消息会并入下一轮。
        const isSticker = Boolean(stickerId);
        const isImage = Boolean(imageInput);
        if (!agentId || (!text && !isSticker && !isImage)) {
          return c.json({ ok: false, error: { message: "agentId 和消息内容都要有" } }, 400);
        }
        let attachment = null;
        let visionNote = "";
        if (isImage) {
          const vision = effectiveVisionConfig(store.getGlobalSettings().vision, store.getPartnerSettings(agentId).vision);
          if (!vision.model || vision.status !== "verified") {
            return c.json({ ok: false, error: { code: "VISION_UNAVAILABLE", message: "当前伙伴没有通过测试的识图模型，暂时不能发送图片" } }, 403);
          }
          try {
            attachment = saveAttachment({ ...imageInput, agentId });
            visionNote = await describeImage(vision.model, attachment);
          } catch (error) {
            if (attachment?.id) removeAttachment(attachment.id);
            return c.json({ ok: false, error: { code: "VISION_FAILED", message: error?.message || "图片暂时没识别出来，请稍后再试" } }, 502);
          }
        }
        let stickerSignalText = "";
        if (isSticker) {
          const own = readOwnSticker(ctx.dataDir, stickerId);
          if (own) {
            stickerSignalText = stickerLabelText(own.row);
          } else {
            const stickerIndex = await readCatalog(ctx);
            const catalog = stickerIndex ? buildCatalog(stickerIndex, agentId) : null;
            if (!catalog?.byId.has(stickerId)) {
              if (attachment?.id) removeAttachment(attachment.id);
              return c.json({ ok: false, error: { message: "这张表情包当前不可用" } }, 400);
            }
            stickerSignalText = stickerLabelText(catalog.byId.get(stickerId));
          }
        }
        const messageText = text || (isSticker ? "[表情]" : "[图片]");
        const userBubbles = [
          ...(text ? [text] : (attachment && isSticker ? ["[图片]"] : [])),
          ...(isSticker ? [encodeStickerBubble(stickerId)] : []),
        ];
        const threadBeforeMessage = store.getThread(agentId);
        const directReplyToProactive = isDirectReplyToProactive(threadBeforeMessage.messages);
        // 她能在这个窗里打字，就说明前面那些话她看见过了：水位顺手补上。
        // 这跟「拉一次记录」不是一回事——那是轮询也在走的路，不能当看过。
        store.markRead(agentId);
        const stored = store.appendMessage(agentId, {
          role: "user",
          text: messageText,
          ...(isSticker ? { kind: "sticker", bubbles: userBubbles } : {}),
          ...(attachment ? { attachment: { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }, visionNote } : {}),
        });
        const responseInFlight = [...turns.values()].some((turn) => turn.agentId === agentId && ["pending", "generating"].includes(turn.status))
          || pendingReplies.has(agentId)
          || deliveringReplies.has(agentId);
        advancePartnerRelationship(agentId, messageText, stickerSignalText);
        // 她一开口，「等回音」这件事就翻篇了：催到第几次、下次什么时候看，都不作数了。
        // 她回来了就当她一直没走，不翻旧账（真想数落她，那也是ta自己愿不愿意）。
        store.setPartnerSettings(agentId, { awaiting: null });

        // 她接着又说了一句实在的：原先排着的那句「顺口应一句」就没意义了（那句本来只是应个声），
        // 不撤的话会在她正题后面跟着冒一句客套话。连戳合并那套照旧。
        if (cancelPendingActionReply(agentId)) {
          diagnostics({ event: "action.answer.cancelled", agentId });
        }

        // 手机在不在ta手里是ta自己的事，不看她；这里只把ta那份状态推进到现在
        const settings = store.getPartnerSettings(agentId);
        const plan = planReply({
          phone: settings.phone,
          now: new Date(),
          // 主动消息已经把伙伴带进醒着的聊天场景，直接回复不能再次算作吵醒。
          sleep: directReplyToProactive ? null : settings.sleep,
        });
        store.setPartnerSettings(agentId, { phone: plan.phone });

        // ta在睡、她这时候发消息，就是把人家弄醒了：按「这一觉」记一笔，脾气一次比一次大
        if (plan.mode === "dozing") {
          const nowDate = new Date();
          const night = windowStartDate(nowDate, plan.window) ?? dailyKey(nowDate);
          const before = store.getPartnerSettings(agentId);
          store.setPartnerSettings(agentId, {
            wakeNight: night,
            wakeCount: before.wakeNight === night ? Number(before.wakeCount ?? 0) + 1 : 1,
          });
          diagnostics({ event: "dozing.woken", agentId, kind: plan.kind ?? null, night });
        }

        if (responseInFlight) {
          diagnostics({ event: "turn.queued", agentId, reason: "response-in-flight", messageId: stored.id });
          return c.json({ ok: true, messageId: stored.id, mode: "queued", queued: true, recall: recallEligibility(stored) });
        }

        // 面对面（醒着、手机在手）和打盹都演实时那套——打盹只是演得慢：
        // 半天才变已读，打字也磨蹭。递出去不演的那些（手机不在手）就只记一个时刻。
        const watching = body?.watching === true;
        const live = plan.mode === "hand" || plan.mode === "dozing";
        if (!live || !watching) {
          scheduleReply(agentId, { plan, messageId: stored.id });
          diagnostics({ event: "turn.queued", agentId, mode: plan.mode, watching });
          return c.json({ ok: true, messageId: stored.id, mode: plan.mode, watching });
        }

        const turn = {
          id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          agentId,
          status: "pending",
          userMessageId: stored.id,
          mode: plan.mode,
          startedAt: Date.now(),
          threadGeneration: threadGeneration(agentId),
        };
        // 实时生成也要先留恢复凭证；关机时 readAt 可能已经落盘，但回合本身还没结束。
        store.setPendingReply(agentId, {
          dueAt: new Date().toISOString(),
          mode: `live-${plan.mode}`,
          messageId: stored.id,
        });
        turns.set(turn.id, turn);
        void runTurn(turn);

        // 已读要等多久：睡着的时候就是ta迷迷移移摸到手机那一下（比醒着慢多了）
        let readAfterMs = plan.delayMs;
        if (plan.mode === "hand") {
          const rhythm = { ...DEFAULT_RHYTHM, ...(store.getPref(agentId).rhythm ?? {}) };
          readAfterMs = Math.round(
            rhythm.readMinMs + Math.random() * Math.max(0, rhythm.readMaxMs - rhythm.readMinMs),
          );
        }
        turn.readAfterMs = readAfterMs;

        // ta把这条看到了（她那边「未读」两个字就是这时候翻成「已读」的）：到点落一笔盘。
        // 不落盘的话，她一刷新就不知道读过没读过——只在屏幕上演一遍是不算数的。
        const readTimer = setTimeout(() => {
          const touched = store.markUserMessagesRead(agentId);
          diagnostics({ event: "turn.read", agentId, mode: plan.mode, touched });
        }, readAfterMs);
        readTimer.unref?.();

        return c.json({
          ok: true,
          turnId: turn.id,
          messageId: stored.id,
          readAfterMs,
          mode: plan.mode,
          recall: recallEligibility(stored),
        });
      });

      app.get("/turns/:turnId", (c) => {
        const turn = turns.get(c.req.param("turnId"));
        if (!turn) return c.json({ ok: false, error: { message: "turn 不存在（可能已重启）" } }, 404);
        return c.json({
          ok: true,
          turnId: turn.id,
          status: turn.status,
          readAfterMs: turn.readAfterMs ?? 0,
          items: turn.bubbles ?? null,
          replyMessageId: turn.replyMessageId ?? null,
          via: turn.via ?? null,
          error: turn.error ?? null,
        });
      });

      app.get("/settings", async (c) => {
        try {
          await loadUserName();
          const allPartners = await listAllPartners();
          const visible = allPartners.filter((row) => !store.isPartnerHidden(row.id));
          const byId = new Map(allPartners.map((row) => [row.id, row]));
          // 隐藏名单是插件自己的账。伙伴暂时不在 Hana 活跃清单里时也要能看见并放回，名字退回编号。
          const hidden = store.hiddenPartnerIds().map((id) => byId.get(id) ?? { id, name: id, unavailable: true });
          const partners = visible.map((row) => ({
            ...row,
            unread: store.unreadCount(row.id),
            settings: store.getPartnerSettings(row.id),
          }));
          // 模型下拉目录：聊天模型和识图模型分开投影；拉不到就给空数组
          let models = [];
          let visionModels = [];
          try {
            const catalog = await ctx.models.list();
            models = chatModelOptions(catalog);
            visionModels = visionModelOptions(catalog);
          } catch (error) {
            diagnostics({ event: "settings.models.failed", error: describeError(error) });
          }
          return c.json({
            ok: true,
            global: globalSettingsView(),
            daybookInstalled: await shiguangjiInstalled(),
            partners,
            models,
            visionModels,
            hiddenPartners: hidden.map(({ id, name, unavailable = false }) => ({ id, name, unavailable })),
            styles: ACTION_STYLES.map((s) => ({ id: s.id, label: s.label, verb: s.verb, emoji: s.emoji })),
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/settings/partner/:agentId/hide", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "缺少伙伴编号" } }, 400);
        return c.json({ ok: true, hiddenPartnerIds: store.hidePartner(agentId) });
      });

      app.post("/settings/partner/:agentId/unhide", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "缺少伙伴编号" } }, 400);
        return c.json({ ok: true, hiddenPartnerIds: store.unhidePartner(agentId) });
      });

      app.post("/vision/test", async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ ok: false, error: { message: "测试参数没读懂" } }, 400); }
        const ref = normalizeModelRef(body?.model);
        if (!ref) return c.json({ ok: false, error: { message: "请先选择识图模型" } }, 400);
        const result = await testVisionModel(ref);
        const vision = normalizeVisionConfig({
          model: ref,
          status: result.ok ? "verified" : "failed",
          testedAt: new Date().toISOString(),
          error: result.ok ? null : result.error?.message,
        });
        if (String(body?.agentId ?? "").trim()) {
          const agentId = String(body.agentId).trim();
          store.setPartnerSettings(agentId, { vision });
        } else {
          store.setGlobalSettings({ vision });
        }
        diagnostics({ event: "vision.test", agentId: body?.agentId ?? null, provider: ref.provider, model: ref.model, ok: result.ok, error: result.error?.code ?? null });
        return c.json({ ok: result.ok, vision, error: result.ok ? null : result.error });
      });

      app.put("/settings/global", async (c) => {
        try {
          const body = await c.req.json();
          const wasDaybookOn = daybookOn();
          store.setGlobalSettings(normalizeGlobalSettingsPatch(body));
          // 今日情境从关到开：清掉「今天已经露过」的记账。
          // 她打开就是为了让伙伴知道今天的事，不该因为同一天早先露过而当场没反应。
          if (!wasDaybookOn && daybookOn()) {
            try {
              store.clearDaybookMarks();
            } catch (error) {
              diagnostics({ event: "daybook.clear-marks.failed", error: describeError(error) });
            }
          }
          await loadUserName();
          return c.json({ ok: true, global: globalSettingsView() });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.put("/settings/partner/:agentId", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const body = await c.req.json();
          return c.json({ ok: true, settings: store.setPartnerSettings(agentId, normalizePartnerSettingsPatch(body)) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      // ── 记忆：给她看和改（设置页用，不进聊天窗） ──

      app.get("/memory/:agentId", (c) => {
        const agentId = c.req.param("agentId");
        const memory = store.readMemory(agentId);
        const pending = store.pendingMessages(agentId);
        return c.json({
          ok: true,
          agentId,
          profile: memory.profile,
          ledger: memory.ledger,
          archive: memory.archive,
          pendingMessages: pending.length,
        });
      });

      app.put("/memory/:agentId/profile", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const body = await c.req.json();
          const saved = store.setProfile(agentId, String(body?.text ?? ""));
          return c.json({ ok: true, profile: saved.profile });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.put("/memory/:agentId/ledger", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const body = await c.req.json();
          const day = String(body?.day ?? "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            return c.json({ ok: false, error: { message: "day 要写成 YYYY-MM-DD" } }, 400);
          }
          const saved = store.upsertLedger(agentId, day, String(body?.text ?? ""));
          return c.json({ ok: true, ledger: saved.ledger });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.delete("/memory/:agentId/ledger/:day", (c) => {
        const agentId = c.req.param("agentId");
        const saved = store.removeLedger(agentId, c.req.param("day"));
        return c.json({ ok: true, ledger: saved.ledger });
      });

      /** 手动催一次整理（调试和"我改过聊天记录了"时用）。 */
      app.post("/memory/:agentId/tidy", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const rolled = await queueMemoryJob(agentId, async () => maybeRollup(agentId));
          const profile = await queueMemoryJob(agentId, async () =>
            maybeRefreshProfile(agentId, { force: true }),
          );
          const topics = await queueMemoryJob(agentId, async () => maybeExtractTopics(agentId, { force: true }));
          return c.json({ ok: true, rolled, profile, topics });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 话题本（ta搁着的话题） ──

      app.get("/topics/:agentId", (c) => {
        const agentId = c.req.param("agentId");
        const book = upkeepTopics(agentId);
        return c.json({ ok: true, agentId, ...book });
      });

      app.post("/topics/:agentId/extract", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const result = await queueMemoryJob(agentId, async () => maybeExtractTopics(agentId, { force: true }));
          return c.json({ ok: true, result, book: store.getTopicBook(agentId) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.put("/topics/:agentId/:topicId", async (c) => {
        const agentId = c.req.param("agentId");
        const topicId = c.req.param("topicId");
        try {
          const current = store.getTopicBook(agentId);
          if (!current.topics.some((row) => row.id === topicId)) return c.json({ ok: false, error: { message: "这条话题已经不在本子里了，请刷新页面" } }, 404);
          const body = await c.req.json();
          const correction = String(body?.correction ?? "").trim();
          if (!correction) return c.json({ ok: false, error: { message: "纠正内容不能为空" } }, 400);
          const book = correctTopic(store.getTopicBook(agentId), topicId, correction);
          return c.json({ ok: true, book: store.saveTopicBook(agentId, book) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.delete("/topics/:agentId/:topicId", (c) => {
        const agentId = c.req.param("agentId");
        const topicId = c.req.param("topicId");
        const current = store.getTopicBook(agentId);
        if (!current.topics.some((row) => row.id === topicId)) return c.json({ ok: false, error: { message: "这条话题已经不在本子里了，请刷新页面" } }, 404);
        const book = dropTopic(current, topicId);
        const state = store.getProactiveState(agentId);
        store.setProactiveState(agentId, { staged: (state.staged ?? []).filter((row) => row.topicId !== topicId) });
        return c.json({ ok: true, book: store.saveTopicBook(agentId, book) });
      });

      // ── 主动那层 ──

      app.get("/proactive", async (c) => {
        try {
          const partners = (await listPartners()).map((row) => ({
            id: row.id,
            name: row.name,
            settings: store.getPartnerSettings(row.id),
            state: store.getProactiveState(row.id),
          }));
          return c.json({
            ok: true,
            global: store.getGlobalSettings(),
            globalRuntime: store.getGlobalRuntime(),
            partners,
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 内测用的手动催一次主动巡检（跳过“到没到点”这道门，静默与日上限照管）。
      // 发布前连同 /probe 一起剥掉。
      if (DEV_TOOLS) app.post("/proactive/tick", async (c) => {
        try {
          return c.json({ ok: true, result: await runProactiveTick({ force: true }) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 小动作（只有一个动作；「戳一戳」「拍了拍」只是ta的叫法）──

      /** 这个动作现在长什么样：ta做的 / 她做的（设置页与聊天窗都用这个）。 */
      function actionView(agentId, partnerName) {
        const globalSettings = store.getGlobalSettings();
        const styleId = readStyleId(globalSettings);
        const settings = store.getPartnerSettings(agentId);
        const mine = readMyTemplateEntry(globalSettings);
        const theirs = readTemplateEntry(settings);
        return {
          styleId,
          label: actionLabel(styleId),
          styles: ACTION_STYLES.map((s) => ({ id: s.id, label: s.label, verb: s.verb, emoji: s.emoji })),
          myTemplate: mine?.text ?? "",
          partnerTemplate: theirs?.text ?? "",
          partnerDoesIt: renderActionLine(styleId, mine?.text, partnerName),
          iDoIt: renderActionLine(styleId, theirs?.text, USER_NAME),
        };
      }

      app.get("/action/:agentId", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const partner = (await listPartners()).find((row) => row.id === agentId);
          const partnerName = partner?.name ?? agentId;
          return c.json({ ok: true, partnerName, ...actionView(agentId, partnerName) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /** 让这位伙伴把ta那句重写一遍。 */
      app.post("/action/:agentId/rewrite", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const partner = (await listPartners()).find((row) => row.id === agentId);
          const partnerName = partner?.name ?? agentId;
          const result = await rollActionTemplate(agentId, partnerName, { force: true });
          return c.json({ ok: true, result, ...actionView(agentId, partnerName) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /** 她对这位伙伴做一下（那格空着就现叫ta写一句）。 */
      app.post("/action/:agentId", async (c) => {
        const agentId = c.req.param("agentId");
        try {
          const partner = (await listPartners()).find((row) => row.id === agentId);
          const partnerName = partner?.name ?? agentId;
          const stored = await deliverAction(agentId, { partnerName, from: "user", ensure: true });
          // 用户又主动互动了，旧的等回音到此翻篇。
          store.setPartnerSettings(agentId, { awaiting: null });
          // 不马上接：排一个随机时刻，到点ta自己决定接不接（她看不到这一段）
          scheduleActionReply(agentId, { partnerName });
          return c.json({ ok: true, messageId: stored.id, line: stored.text });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 茶话会里多加的那层（性格她可以调；关系账和爱好一个字都不往外给）──

      /** 只给性格和几个预设。关系走到哪一步、ta自己长了什么爱好，她看不到。 */
      app.get("/knowing/:agentId", (c) => {
        const agentId = c.req.param("agentId");
        const knowing = store.getKnowing(agentId);
        const drafted = hasPersonality(knowing.personality);
        // 还没长过就当场补一份（不挡这次回包）；她那边轮询一下就有了
        if (!drafted) void maybeDraftPersonality(agentId).catch(() => {});
        const standing = personalityStanding({
          personality: knowing.personality,
          auto: knowing.personalityAuto,
          from: knowing.personalityFrom,
        });
        // 起跑线该量就量一份（只读那边的材料、数份量，不调模型，所以不挡回包）
        const seedLastTry = Date.parse(store.getPartnerSettings(agentId).seedMeasuredAt ?? "") || 0;
        if (seedStale(knowing.relationSeed, seedLastTry)) void measureRelationSeed(agentId).catch(() => {});
        return c.json({
          ok: true,
          personality: knowing.personality,
          // 系统自动定的那份（基准）：调过之后还能回到它；她怎么改都不动它
          auto: knowing.personalityAuto,
          // 现在生效那份的来历；分不清就是 null，界面宁可不说话也不说错话
          from: standing.from,
          edited: standing.edited,
          drafting: !drafted,
          /** 存过几版旧的（后悔药用），界面拿它决定要不要露「看看以前的样子」 */
          historyCount: (knowing.history ?? []).length,
          // 起跑线：从那边的痕量自动量的，或她自己锁的那份
          seed: knowing.relationSeed,
          seedMeasuring: !knowing.relationSeed,
          // 她能锁的档：从低到高（界面上越往下越熟），且不摆跟「从这儿开始」重样的那档
          seedTiers: SEED_PICK_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
          // 标签库：点一下就有描述，不用自己憋词
          tags: TEMPERAMENT_TAGS.map((tag) => ({ label: tag.label, note: tag.note })),
          presets: PERSONALITY_PRESETS.map((preset) => ({
            id: preset.id,
            label: preset.label,
            note: preset.note,
            surface: { tags: [...preset.surface.tags], signals: [...preset.surface.signals] },
            inner: { tags: [...preset.inner.tags], signals: [...preset.inner.signals] },
          })),
        });
      });

      /** 挑了预设就把两层铺满；自己挑标签就按挑的存；restore 就用回自动那份。 */
      app.put("/knowing/:agentId/personality", async (c) => {
        const agentId = c.req.param("agentId");
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: { message: "invalid-json" } }, 400);
        }
        const knowing = store.getKnowing(agentId);
        const presetId = String(body?.presetId ?? "").trim();
        let next;
        let from;
        if (body?.restore === true) {
          // 「回到自动那份」：自动那份还在就回到它（回完就算自动定的），
          // 没有基准（比如连人格文件都读不到）就只能清成空的，下次再判。
          next = knowing.personalityAuto
            ? { ...knowing.personalityAuto, updatedAt: new Date().toISOString() }
            : normalizePersonality(null);
          from = knowing.personalityAuto ? "auto" : null;
        } else if (presetId) {
          next = applyPersonalityPreset(presetId);
          if (!next) return c.json({ ok: false, error: { message: "没有这个气质" } }, 400);
          from = "user";
        } else {
          // 标签是一层最多两个、互相打架的不能放一起；规矩只在 knowing.js 里写一份
          const incoming = body?.personality;
          const problem = ["surface", "inner"]
            .map((layer) => layerTagProblem(incoming?.[layer]?.tags))
            .find((result) => !result.ok);
          if (problem) {
            return c.json({ ok: false, error: { message: tagProblemText(problem) } }, 400);
          }
          next = {
            ...normalizePersonality(incoming),
            updatedAt: new Date().toISOString(),
          };
          from = "user";
        }
        store.saveKnowing(agentId, { ...knowing, personality: next, personalityFrom: from });
        return c.json({ ok: true, personality: store.getKnowing(agentId).personality });
      });

      /**
       * 「重新看一次 ta 的样子」：拿现在手上最新的材料重判一份。
       * 她手动调过的话只更新基准那份（不动她挑的）；没调过就直接换掉现在用的。
       */
      app.post("/knowing/:agentId/redraft", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "缺少伙伴编号" } }, 400);
        try {
          const result = await maybeDraftPersonality(agentId, { force: true });
          return c.json({ ok: true, ...result, personality: store.getKnowing(agentId).personality });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /**
       * 起跑线：auto = 重新按那边的痕量量一份；zero = 从这儿开始（清掉起点）；
       * starting / chatty / close = 她自己锁一档。三样都只动相处史，亲近度一个字不变。
       */
      app.put("/knowing/:agentId/seed", async (c) => {
        const agentId = c.req.param("agentId");
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: { message: "invalid-json" } }, 400);
        }
        const mode = String(body?.mode ?? "auto").trim();
        if (mode !== "auto" && mode !== "zero" && !SEED_TIER_IDS.includes(mode)) {
          return c.json({ ok: false, error: { message: "unknown-seed-tier" } }, 400);
        }
        try {
          if (mode === "zero") {
            const knowing = store.getKnowing(agentId);
            const seed = zeroSeed();
            store.saveKnowing(agentId, { ...knowing, relationSeed: seed });
            store.setPartnerSettings(agentId, { seedMeasuredAt: new Date().toISOString() });
            diagnostics({ event: "knowing.seed", agentId, source: "manual", pick: "zero", trace: 0, turns: 0, activeDays: 0 });
            return c.json({ ok: true, seed });
          }
          const seed = await measureRelationSeed(agentId, mode === "auto" ? {} : { pick: mode });
          return c.json({ ok: true, seed });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 作息（伙伴自己定的，她只能看）──

      // ── 头像（伙伴的、她自己的）──

      /**
       * 从 Hana 那边的头像文件现读现给。Hana 里换了头像，这边最迟 5 分钟跟着换。
       * 没头像就 404，前端退回一个字。
       */
      // ── 聊天背景：每位伙伴一间房，房间可以有自己的样子 ──
      //
      // 图不指回她挑的那个原文件：选中那一刻就把字节抄进茶话会自己的目录。
      // 她之后把原图删了、挠了，房间不会跟着空掉。

      const bgAgentId = (c) => {
        const id = String(c.req.param("agentId") ?? "").trim();
        return /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : "";
      };

      /** 取背景图本体。没设过就 404，前端当「这位伙伴还没设背景」处理。 */
      app.get("/background/:agentId", (c) => {
        const agentId = bgAgentId(c);
        if (!agentId) return c.json({ ok: false, error: { message: "伙伴编号不合法" } }, 400);
        const current = store.getPartnerSettings(agentId).background;
        const requestedFile = String(c.req.query("file") ?? "").trim();
        const file = requestedFile && isBackgroundFile(requestedFile) ? requestedFile : current?.file;
        const bg = file ? { ...(current ?? {}), file, type: fileTypeOf(file) } : null;
        if (!bg) {
          ctx.logger.warn(`[${name}] 背景请求：${agentId} 没设过（或者读不出来）`);
          return c.json({ ok: false, error: { message: "这间房还没设背景" } }, 404);
        }
        const bytes = readBackgroundBytes(ctx.dataDir, bg.file);
        if (!bytes) {
          ctx.logger.warn(`[${name}] 背景请求：${agentId} 的图不在（${bg.file}）`);
          return c.json({ ok: false, error: { message: "背景图不在了" } }, 404);
        }
        ctx.logger.info(`[${name}] 背景请求：${agentId} → ${bg.file} ${bytes.length}B`);
        return c.body(bytes, 200, { "Content-Type": bg.type, "Cache-Control": "private, max-age=300" });
      });

      /**
       * 设背景。
       *   body.base64 / body.path：新增一张图，写进茶话会共享背景图库
       *   body.file：从已有图库切换当前背景
       *   body.opacity：背景透明度 0~100；旧 body.tone 仍兼容
       */
      app.post("/background/:agentId", async (c) => {
        const agentId = bgAgentId(c);
        if (!agentId) return c.json({ ok: false, error: { message: "伙伴编号不合法" } }, 400);
        try {
          const body = await c.req.json();
          const settings = store.getPartnerSettings(agentId);
          const current = settings.background;
          const tone = body?.tone === undefined ? (current?.tone ?? "medium") : normalizeTone(body.tone);
          const requestedOpacity = normalizeOpacity(body?.opacity, tone);
          const filePath = String(body?.path ?? "").trim();
          const base64 = String(body?.base64 ?? "").trim();
          const requestedFile = String(body?.file ?? "").trim();
          if (!filePath && !base64 && requestedFile) {
            if (!isBackgroundFile(requestedFile) || !readBackgroundBytes(ctx.dataDir, requestedFile)) {
              return c.json({ ok: false, error: { message: "这张背景已经不在图库里了" } }, 404);
            }
            const opacity = Object.prototype.hasOwnProperty.call(settings.backgroundOpacity, requestedFile)
              ? settings.backgroundOpacity[requestedFile]
              : requestedOpacity;
            const next = store.setPartnerSettings(agentId, {
              background: { file: requestedFile, type: requestedFile.split(".").pop() === "jpg" ? "image/jpeg" : `image/${requestedFile.split(".").pop()}`, tone, opacity, at: new Date().toISOString() },
              backgroundOpacity: { ...settings.backgroundOpacity, [requestedFile]: opacity },
            });
            return c.json({ ok: true, background: next.background });
          }
          if (!filePath && !base64) {
            if (body?.tone === undefined && body?.opacity === undefined) {
              return c.json({ ok: false, error: { message: "要么给张图，要么给个透明度" } }, 400);
            }
            if (!current) return c.json({ ok: false, error: { message: "这间房还没设背景" } }, 404);
            const opacity = requestedOpacity;
            const next = store.setPartnerSettings(agentId, {
              background: { ...current, tone, opacity },
              backgroundOpacity: { ...settings.backgroundOpacity, [current.file]: opacity },
            });
            diagnostics({ event: "background.opacity", agentId, opacity });
            return c.json({ ok: true, background: next.background });
          }
          const bytes = base64
            ? Buffer.from(base64, "base64")
            : toBytes(await ctx.resources.read({ kind: "local-file", path: filePath }, { encoding: "base64" }));
          if (!bytes?.length) return c.json({ ok: false, error: { message: "这张图读不出来" } }, 400);
          const written = writeBackground(ctx.dataDir, bytes);
          const opacity = requestedOpacity;
          const next = store.setPartnerSettings(agentId, {
            background: { ...written, tone, opacity, at: new Date().toISOString() },
            backgroundOpacity: { ...settings.backgroundOpacity, [written.file]: opacity },
          });
          diagnostics({ event: "background.set", agentId, bytes: bytes.length, type: written.type, opacity });
          return c.json({ ok: true, background: next.background });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.get("/backgrounds/:agentId", (c) => {
        const agentId = bgAgentId(c);
        if (!agentId) return c.json({ ok: false, error: { message: "伙伴编号不合法" } }, 400);
        return c.json({ ok: true, backgrounds: listBackgrounds(ctx.dataDir), current: store.getPartnerSettings(agentId).background });
      });

      /** 清掉当前选择：图库里的文件保留，之后仍可切回来。 */
      app.delete("/background/:agentId", (c) => {
        const agentId = bgAgentId(c);
        if (!agentId) return c.json({ ok: false, error: { message: "伙伴编号不合法" } }, 400);
        const current = store.getPartnerSettings(agentId).background;
        const file = String(c.req.query("file") ?? "").trim();
        const remove = c.req.query("remove") === "1";
        if (!remove) {
          // 清除当前选择不会动共享图库里的文件，之后仍然可以切回来。
          if (!file || file === current?.file) store.setPartnerSettings(agentId, { background: null });
          diagnostics({ event: "background.clear", agentId, file: file || current?.file || null });
          return c.json({ ok: true });
        }
        if (!isBackgroundFile(file) || !readBackgroundBytes(ctx.dataDir, file)) {
          return c.json({ ok: false, error: { message: "这张背景已经不在图库里了" } }, 404);
        }
        const usedElsewhere = Object.entries(store.allPartnerSettings())
          .some(([id, pref]) => id !== agentId && pref.background?.file === file);
        if (usedElsewhere) {
          return c.json({ ok: false, error: { message: "这张背景还被其他伙伴使用，先换掉再删" } }, 409);
        }
        if (!removeBackgroundFile(ctx.dataDir, file)) {
          return c.json({ ok: false, error: { message: "背景没删掉，请再试一次" } }, 500);
        }
        if (current?.file === file) store.setPartnerSettings(agentId, { background: null });
        diagnostics({ event: "background.remove", agentId, file });
        return c.json({ ok: true, removed: file });
      });

      // 茶话会自己的图库：表情包插件只负责提供一次导入来源，日常展示与发送都读这里。
      app.get("/library/stickers", (c) => {
        return c.json({ ok: true, ...listStickerLibrary(ctx.dataDir) });
      });

      // 只有表情包插件存在且公开快照可读时，才提供「添加表情包」来源。
      // 没读到就说清楚为什么，不拿一句「请确认插件已启动」冤枉人。
      // 没有标签的图不给选：伙伴那边只能看到"[表情]"两个字，发出去是添乱。
      app.get("/sticker-source", async (c) => {
        try {
          const { index, reason } = await readCatalogWithReason(ctx);
          if (!index) return c.json({ ok: true, available: false, reason, stickers: [], hiddenUntagged: 0 });
          const rows = Array.isArray(index.stickers) ? index.stickers : [];
          const usable = rows.filter((row) => hasUsableTags(row));
          return c.json({
            ok: true,
            available: true,
            reason: "ok",
            hiddenUntagged: rows.length - usable.length,
            stickers: usable.map((row) => ({
              id: String(row.id),
              emotion: Array.isArray(row.emotion) ? row.emotion.slice(0, 3) : [],
              scene: Array.isArray(row.scene) ? row.scene.slice(0, 3) : [],
              keywords: Array.isArray(row.keywords) ? row.keywords.slice(0, 5) : [],
              description: String(row.description ?? "").slice(0, 80),
            })),
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/library/groups", async (c) => {
        try {
          const body = await c.req.json();
          return c.json({ ok: true, group: createStickerGroup(ctx.dataDir, body?.name) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.post("/library/import", async (c) => {
        try {
          const body = await c.req.json();
          const ids = [...new Set((Array.isArray(body?.sourceIds) ? body.sourceIds : []).map(String).filter(Boolean))].slice(0, 100);
          if (!ids.length) return c.json({ ok: false, error: { message: "先选几张表情包" } }, 400);
          const index = await readSourceCatalog(ctx);
          if (!index) return c.json({ ok: false, error: { message: "表情包插件当前不可用" } }, 409);
          const groupId = String(body?.groupId ?? "").trim();
          const library = listStickerLibrary(ctx.dataDir);
          if (groupId && !library.groups.some((group) => group.id === groupId)) {
            return c.json({ ok: false, error: { message: "茶话会分组不存在" } }, 400);
          }
          const rows = new Map((index.stickers ?? []).map((row) => [String(row.id), row]));
          const imported = [];
          for (let at = 0; at < ids.length; at += IMPORT_READ_CONCURRENCY) {
            const batch = await Promise.all(
              ids.slice(at, at + IMPORT_READ_CONCURRENCY).map(async (id) => {
                const row = rows.get(id);
                if (!row?.file || !hasUsableTags(row)) return null;
                const found = await readStickerBytes(ctx, row.file, guessedHanaHome);
                return found ? { row, found } : null;
              }),
            );
            for (const item of batch) {
              if (!item) continue;
              imported.push(importStickerBytes(ctx.dataDir, { ...item.row, contentType: item.found.contentType }, item.found.bytes, groupId ? [groupId] : []));
            }
          }
          return c.json({ ok: true, imported: imported.length, duplicates: imported.filter((item) => item.duplicate).length });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 导入页要的是「全库」：它跟哪个伙伴没关系，不能按伙伴白名单筛。
      // 聊天那条路（/sticker/:agentId/:id）不动，那边该按白名单还是按白名单。
      app.get("/source-sticker/:id", async (c) => {
        const id = String(c.req.param("id") ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
          return c.json({ ok: false, error: { message: "表情包编号不合法" } }, 400);
        }
        try {
          const index = await readCatalog(ctx);
          const row = sourceRowById(index, id);
          if (!row?.file) return c.json({ ok: false, error: { message: "没有这张图" } }, 404);
          const found = await readStickerBytes(ctx, row.file, guessedHanaHome);
          if (!found) return c.json({ ok: false, error: { message: "读不到这张图" } }, 404);
          return c.body(found.bytes, 200, { "Content-Type": found.contentType, "Cache-Control": "private, max-age=3600" });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 从图库移除一张。图片文件故意留着：她以前发出去的那条消息还得看得见。
      app.delete("/library/stickers/:id", (c) => {
        try {
          if (!removeSticker(ctx.dataDir, String(c.req.param("id") ?? ""))) {
            return c.json({ ok: false, error: { message: "图库里没有这张" } }, 404);
          }
          return c.json({ ok: true });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 删分组：组里的图不跟着删，退回「全部」。
      app.delete("/library/groups/:id", (c) => {
        try {
          if (!removeStickerGroup(ctx.dataDir, String(c.req.param("id") ?? ""))) {
            return c.json({ ok: false, error: { message: "没有这个分组" } }, 404);
          }
          return c.json({ ok: true });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 新图读茶话会自己的目录；旧消息里的外部 id 仍走旧来源，保证历史不失图。
      app.get("/sticker/:agentId/:id", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        const id = String(c.req.param("id") ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
          return c.json({ ok: false, error: { message: "表情包编号不合法" } }, 400);
        }
        try {
          const own = readOwnSticker(ctx.dataDir, id);
          if (own) return c.body(own.bytes, 200, { "Content-Type": own.contentType, "Cache-Control": "private, max-age=3600" });
          const index = await readCatalog(ctx);
          const catalog = index ? buildCatalog(index, agentId) : null;
          const row = catalog?.byId.get(id);
          if (!row?.file) return c.json({ ok: false, error: { message: "没有这张图" } }, 404);
          const found = await readStickerBytes(ctx, row.file, guessedHanaHome);
          if (!found) return c.json({ ok: false, error: { message: "读不到这张图" } }, 404);
          return c.body(found.bytes, 200, { "Content-Type": found.contentType, "Cache-Control": "private, max-age=3600" });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.get("/avatar/:agentId", async (c) => {
        const raw = String(c.req.param("agentId") ?? "");
        const kind = raw === "__user" ? "user" : "agent";
        // 这个值会拼进文件路径，先过关。头像那条以前没校验。
        if (kind === "agent" && !isValidPartnerId(raw)) {
          return c.json({ ok: false, error: { message: "伙伴编号不合法" } }, 400);
        }
        try {
          // 茶话会本地角色暂时使用首字占位，不读取 Hana 的头像目录。
          if (kind === "agent" && store.localPartner(raw)) {
            return c.json({ ok: false, error: { message: "本地角色暂未配置头像" } }, 404);
          }
          // 没配头像的伙伴用宿主自带的那张（按「缘」分）
          const yuan = kind === "agent" ? await yuanOf(raw) : null;
          const avatar = await getAvatar(kind, kind === "user" ? null : raw, yuan);
          if (!avatar) return c.json({ ok: false, error: { message: "没有头像" } }, 404);
          return c.body(avatar.bytes, 200, {
            "Content-Type": avatar.contentType,
            "Cache-Control": "private, max-age=300",
          });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/workfeed/clear", (c) => {
        try {
          store.clearWorkfeed();
          return c.json({ ok: true, workfeed: store.readWorkfeed() });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      app.get("/diagnostics", (c) => {
        try {
          const file = path.join(ctx.dataDir, "v2", "diagnostics.jsonl");
          const raw = fs.readFileSync(file, "utf8").trim().split("\n");
          return c.json({ ok: true, lines: raw.slice(-40) });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 404);
        }
      });

      // ── M0 探针（保留，用于回归） ──
      if (DEV_TOOLS) app.get("/probe/last", (c) => {
        try {
          return c.json(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "v2", "probe-result.json"), "utf8")));
        } catch (error) {
          return c.json({ ok: false, note: "还没有探针结果", error: describeError(error) }, 404);
        }
      });

      // 内测用的体感测试台：活儿在 tasteProbeOnce 里（见上）。发布前连同 /probe 一起剥掉。
      if (DEV_TOOLS) app.post("/probe/taste", async (c) => {
        let body = {};
        try {
          body = await c.req.json();
        } catch {
          body = {};
        }
        try {
          // 现成的实验：她点一下按钮就跑这一套，不用自己配参数
          const preset = body?.experiment ? TASTE_EXPERIMENTS[String(body.experiment)] : null;
          const input = preset ? { ...preset, agentId: String(body?.agentId ?? "").trim() } : body;
          // 模型调用慢：要后台跑就立刻把结果文件路径还回去，别让 HTTP 等在那儿
          if (body?.background) {
            return c.json({ ok: true, background: true, file: startTasteProbe(input) });
          }
          return c.json(await tasteProbeOnce(input));
        } catch (error) {
          return c.json(
            { ok: false, error: describeError(error) },
            String(error?.message ?? "") === "要带 agentId" ? 400 : 500,
          );
        }
      });

      // 内测用的自动性格分析：活儿在 analyzePersonalityOnce 里（见上）。
      // 跟 /probe 一样，发布前剥掉。
      if (DEV_TOOLS) app.post("/analyze/personality", async (c) => {
        let body = {};
        try {
          body = await c.req.json();
        } catch {
          body = {};
        }
        try {
          const agentId = String(body?.agentId ?? "").trim();
          if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
          return c.json(startPersonalityAnalysis({ agentId, rounds: body?.rounds }));
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 茶话会本地角色：只存在应用自己的账本里 ──

      app.post("/local-partners", async (c) => {
        let body = {};
        try { body = await c.req.json(); } catch { body = {}; }
        try {
          const partner = store.createLocalPartner({ name: body?.name, description: body?.description });
          return c.json({ ok: true, partner });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 400);
        }
      });

      // ── 认识 ta：可暂停、可回头改的聊天式采访 ──

      app.get("/recognition/:agentId", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        const knowing = store.getKnowing(agentId);
        return c.json({
          ok: true,
          questions: RECOGNITION_QUESTIONS,
          recognition: recognitionForResume(knowing.recognition ?? emptyRecognition()),
        });
      });

      // 「重新认识」= 从头再做一遍：把之前答的清掉，从第一题重新开始。
      // 但“住过的痕”留着（everCompleted），不然清完她会被当成没入住的伙伴。
      app.post("/recognition/:agentId/restart", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        try {
          const knowing = store.getKnowing(agentId);
          const cleared = RECOGNITION_QUESTIONS.some((question) => knowing.recognition?.answers?.[question.id]);
          const recognition = {
            ...emptyRecognition(),
            everCompleted: knowing.recognition?.everCompleted === true || Boolean(knowing.recognition?.completedAt),
          };
          store.saveKnowing(agentId, { ...knowing, recognition });
          diagnostics({ event: "recognition.restart", agentId, cleared });
          return c.json({ ok: true, recognition });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/recognition/:agentId/answer", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: "回答格式不对" }, 400);
        }
        try {
          const knowing = store.getKnowing(agentId);
          const answer = {
            selected: body?.selected,
            note: body?.note,
            text: body?.text,
            scenarios: body?.scenarios,
            origin: body?.origin,
          };
          const recognition = body?.draft
            ? applyRecognitionDraft(knowing.recognition, body?.questionId, answer)
            : applyRecognitionAnswer(knowing.recognition, body?.questionId, answer);
          store.saveKnowing(agentId, { ...knowing, recognition });
          return c.json({ ok: true, recognition });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/recognition/:agentId/suggestions", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        let body = {};
        try { body = await c.req.json(); } catch { body = {}; }
        const question = questionById(body?.questionId);
        if (!question) return c.json({ ok: false, error: "问题不存在" }, 400);
        try {
          const knowing = store.getKnowing(agentId);
          const recognition = {
            ...(knowing.recognition ?? emptyRecognition()),
            answers: {
              ...(knowing.recognition?.answers ?? {}),
              ...(body?.draft && typeof body.draft === "object" ? { [question.id]: body.draft } : {}),
            },
          };
          const partners = await listPartners();
          const partner = partners.find((row) => row.id === agentId);
          const spec = recognitionSuggestionSpec({
            question,
            recognition,
            partnerName: partner?.name ?? agentId,
          });
          const raw = await askRecognition(spec.systemPrompt, spec.userText, 1200);
          const suggestions = sanitizeSuggestions(question, parseRecognitionSuggestions(raw));
          if (!suggestions.length) return c.json({ ok: false, error: "这次没想出合适的方向，再试一次嘛" }, 502);
          return c.json({ ok: true, suggestions });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 「和小花聊聊」：在现在这一版画像上做小步修订 ──
      //
      // 另外三个入口都是推倒重来（重判两层、重捏调色盘、重答七题），这一条不一样：
      // 在现版上改。协商期间只动 review-session.json，点了「确认修改」才写 knowing，
      // 写之前先把旧版存进 history（后悔药），回退本身也存一条，所以退错了还能退回来。

      const personaReviewReady = (knowing) => (
        isPaletteDone(knowing?.palette)
        || hasPersonality(knowing?.personality)
        || isRecognitionComplete(knowing?.recognition)
      );

      const readReviewSession = (agentId) => normalizeSession(store.getReviewSession(agentId));

      const historyRows = (knowing) => listHistory(knowing).map((row) => ({
        at: row.at,
        reason: row.reason,
        summary: describeChange(row.snapshot, knowing),
      }));

      const partnerNameOf = async (agentId) => {
        try {
          const partners = await listPartners();
          return partners.find((row) => row.id === agentId)?.name ?? agentId;
        } catch {
          return agentId;
        }
      };

      app.get("/persona-review/:agentId", (c) => {
        const agentId = c.req.param("agentId");
        const knowing = store.getKnowing(agentId);
        const session = readReviewSession(agentId);
        const mechanical = inspectPersona(knowing);
        return c.json({
          ok: true,
          ready: personaReviewReady(knowing),
          revision: knowing.revision,
          session,
          // 盘上还留着会话、但已经过期归一成 null：跟「从来没聊过」分开说
          expired: Boolean(store.getReviewSession(agentId) && !session),
          mechanical: { items: mechanical.items, counts: mechanical.counts, render: mechanical.render.note },
          history: historyRows(knowing),
          maxSuggestions: MAX_SUGGESTIONS,
        });
      });

      /** 开场体检：一次模型调用，按标准把现版过一遍。不写档案。 */
      app.post("/persona-review/:agentId/start", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "要带伙伴编号" } }, 400);
        try {
          const knowing = store.getKnowing(agentId);
          if (!personaReviewReady(knowing)) {
            return c.json({ ok: false, error: { message: "ta 的样子还没长出来，先聊一阵，或者走一遍认真认识 ta" } }, 409);
          }
          const partnerName = await partnerNameOf(agentId);
          const mechanical = inspectPersona(knowing);
          const spec = diagnosisSpec({
            partnerName,
            userName: USER_NAME,
            dossier: renderDossier(knowing, { userName: USER_NAME }),
            mechanical,
          });
          const raw = await askRecognition(spec.systemPrompt, spec.userText, 1600);
          const diagnosis = parseDiagnosis(raw);
          if (!diagnosis) return c.json({ ok: false, error: { message: "这次没看出什么，再试一次嘛" } }, 502);
          const session = touchSession(emptySession(agentId), {
            stage: "diagnosed",
            baseRevision: String(knowing.revision),
            diagnosis,
          });
          store.saveReviewSession(agentId, session);
          diagnostics({ event: "persona-review.start", agentId, keep: diagnosis.keep.length, grow: diagnosis.grow.length });
          return c.json({ ok: true, session, mechanical: { items: mechanical.items, counts: mechanical.counts, render: mechanical.render.note } });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /** 聊一轮。版本对不上就停下来，不让她在旧建议上白聊。 */
      app.post("/persona-review/:agentId/chat", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "要带伙伴编号" } }, 400);
        let body = {};
        try { body = await c.req.json(); } catch { body = {}; }
        const say = String(body?.text ?? "").trim().slice(0, 1200);
        try {
          const session = readReviewSession(agentId);
          if (!session) {
            return c.json({ ok: false, code: "session-gone", error: { message: "上次那次聊聊已经过期了，当时没有改动 ta" } }, 409);
          }
          const knowing = store.getKnowing(agentId);
          if (session.baseRevision && String(knowing.revision) !== session.baseRevision) {
            return c.json({ ok: false, code: "revision-changed", error: { message: "这段时间 ta 的画像已经有变化了，刚才那版建议按旧版本聊出来的" } }, 409);
          }
          const now = new Date().toISOString();
          const messages = say ? [...session.messages, { role: "user", text: say, at: now }] : session.messages;
          const partnerName = await partnerNameOf(agentId);
          const spec = chatSpec({
            partnerName,
            userName: USER_NAME,
            dossier: renderDossier(knowing, { userName: USER_NAME }),
            diagnosis: session.diagnosis,
            messages,
            suggestions: session.suggestions,
          });
          const raw = await askRecognition(spec.systemPrompt, spec.userText, 1200);
          const parsed = parseChatReply(raw);
          if (!parsed) return c.json({ ok: false, error: { message: "我刚才没接住，你再说一遍嘛" } }, 502);
          const next = touchSession(session, {
            stage: session.suggestions.length || parsed.suggestions.length ? "chatting" : session.stage,
            messages: parsed.reply ? [...messages, { role: "hua", text: parsed.reply, at: new Date().toISOString() }] : messages,
            suggestions: mergeSuggestions(session.suggestions, parsed.suggestions),
          });
          store.saveReviewSession(agentId, next);
          return c.json({ ok: true, session: next });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /** 结束这次聊聊：待改内容一并丢掉，档案一个字没动。 */
      app.post("/persona-review/:agentId/drop", (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "要带伙伴编号" } }, 400);
        store.clearReviewSession(agentId);
        return c.json({ ok: true });
      });

      /** 确认修改：先存档，再写盘，最后把会话消费掉。 */
      app.post("/persona-review/:agentId/apply", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "要带伙伴编号" } }, 400);
        let body = {};
        try { body = await c.req.json(); } catch { body = {}; }
        try {
          const session = readReviewSession(agentId);
          const knowing = store.getKnowing(agentId);
          if (session?.baseRevision && String(knowing.revision) !== session.baseRevision) {
            return c.json({ ok: false, code: "revision-changed", error: { message: "ta 的画像已经变过了，这版建议不直接盖上去" } }, 409);
          }
          const list = (Array.isArray(body?.suggestions) && body.suggestions.length ? body.suggestions : session?.suggestions) ?? [];
          if (!list.length) return c.json({ ok: false, error: { message: "还没有要改的地方" } }, 400);
          const { knowing: after, applied, skipped } = applySuggestions(knowing, list);
          if (!applied.length) {
            return c.json({ ok: false, code: "nothing-applied", error: { message: "这些改动落不上，回去再聊一句吗" }, skipped }, 409);
          }
          const change = describeChange(knowing, after);
          const saved = store.saveKnowing(agentId, commitChange(knowing, after, { reason: `和小花聊聊：${change}` }));
          store.clearReviewSession(agentId);
          diagnostics({ event: "persona-review.apply", agentId, applied: applied.length, skipped: skipped.length, change });
          return c.json({ ok: true, applied, skipped, change, personality: saved.personality, history: historyRows(saved), revision: saved.revision });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      /** 回退：换回以前某一版。当前这版也会被留一条，所以还能再换回来。 */
      app.post("/persona-review/:agentId/revert", async (c) => {
        const agentId = String(c.req.param("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: { message: "要带伙伴编号" } }, 400);
        let body = {};
        try { body = await c.req.json(); } catch { body = {}; }
        try {
          const knowing = store.getKnowing(agentId);
          const result = revertTo(knowing, String(body?.at ?? ""));
          if (!result.ok) return c.json({ ok: false, error: { message: result.reason } }, 404);
          const saved = store.saveKnowing(agentId, result.knowing);
          store.clearReviewSession(agentId);
          diagnostics({ event: "persona-review.revert", agentId, at: body?.at ?? null });
          return c.json({ ok: true, personality: saved.personality, history: historyRows(saved), revision: saved.revision });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // ── 先聊个大概：待认识清单 / 出草稿 / 读草稿 / 定稿 ──

      // 哪些伙伴还没完成快速认识。界面拿它当门禁。
      app.get("/onboarding", async (c) => {
        try {
          const partners = await listPartners();
          const pending = partners
            .filter((row) => !isSettled(row.id))
            .map((row) => ({ id: row.id, name: row.name }));
          return c.json({ ok: true, pending, total: partners.length });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      // 出一份草稿（后台跑，几分钟）。已经有的就先不重跑，除非带 force。
      app.post("/onboarding/draft", async (c) => {
        let body = {};
        try {
          body = await c.req.json();
        } catch {
          body = {};
        }
        const agentId = String(body?.agentId ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        try {
          // peek：只看一眼草稿好没好，不起新的活。
          // （原来用 GET + query 给前端轮询，实测拿不到——query 那块不稳，改成 POST。
          //   顺带的好处：没必要为了看一眼就去碰 URL。）
          if (body?.peek) {
            return c.json({
              ok: true,
              draft: store.getPaletteDraft(agentId),
              progress: draftProgress.get(agentId) ?? null,
              steps: DRAFT_STEPS,
            });
          }
          const ready = store.getPaletteDraft(agentId);
          if (ready?.colors?.length && !body?.force) {
            return c.json({ ok: true, cached: true, draft: ready });
          }
          // 失败草稿只用于把上一次原因交给界面；新一轮开始前先清掉，避免闪旧错误。
          store.clearPaletteDraft(agentId);
          return c.json(startPaletteDraft({ agentId, refill: body?.refill }));
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.get("/onboarding/draft", (c) => {
        const agentId = String(c.req.query?.("agentId") ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        return c.json({ ok: true, draft: store.getPaletteDraft(agentId) });
      });

      // 定稿：用户挑完的那份落盘，草稿清掉。
      app.post("/onboarding/save", async (c) => {
        let body = {};
        try {
          body = await c.req.json();
        } catch {
          body = {};
        }
        const agentId = String(body?.agentId ?? "").trim();
        if (!agentId) return c.json({ ok: false, error: "要带 agentId" }, 400);
        try {
          const palette = normalizePalette({
            colors: body?.colors,
            derivatives: body?.derivatives,
            portrait: body?.portrait,
            source: "reshaped",
          });
          if (!isPaletteDone(palette)) {
            return c.json({ ok: false, error: "这个盘还是空的，至少得留一个色、一条行为，或者留一段自画像" }, 400);
          }
          const knowing = store.getKnowing(agentId);
          store.saveKnowing(agentId, { ...knowing, palette });
          store.clearPaletteDraft(agentId);
          diagnostics({
            event: "onboarding.saved",
            agentId,
            colors: palette.colors.length,
            rows: palette.derivatives.filter((row) => row.on).length,
          });
          return c.json({ ok: true, palette });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.post("/presence", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const accepted = applyPresence(
            notifyState.panelLeases,
            notifyState.panelSequences,
            { token: body?.token, active: body?.active, seq: body?.seq },
          );
          notifyState.panelSeenAt = activePanelSeenAt(notifyState.panelLeases);
          if (accepted && body?.active === false) await maybeShowBanner();
          return c.json({ ok: true, accepted });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });

      app.get("/notify/state", (c) =>
        c.json({
          ok: true,
          activeSessionPath: notifyState.activeSessionPath,
          panelSeenAt: notifyState.panelSeenAt,
          banner: notifyState.banner
            ? { sessionPath: notifyState.banner.sessionPath, count: notifyState.banner.batch?.count ?? 0 }
            : null,
          batch: notifyState.batch,
          ackAt: store.getBannerAck(),
        }),
      );

      // 内测用的手动触发：模拟一位伙伴来找她，只看提醒链路通不通，不写聊天记录。
      // 发布前连同 /probe 一起剥掉。
      if (DEV_TOOLS) app.post("/notify/test", async (c) => {
        try {
          const partners = await listPartners();
          const who = partners[0] ?? { id: "test", name: "测试伙伴" };
          await announceArrival(who.id, who.name);
          return c.json({ ok: true, activeSessionPath: notifyState.activeSessionPath });
        } catch (error) {
          return c.json({ ok: false, error: describeError(error) }, 500);
        }
      });
    });
  } catch (error) {
    ctx.logger.error(`[${name}] 路由注册失败: ${error?.message || error}`);
  }

  try {
    if (DEV_TOOLS) ctx.tools.register({
      name: "chahuahui_ping",
      description: "茶话会存活检查。",
      parameters: { type: "object", properties: {} },
      execute: () => ({
        content: [{ type: "text", text: `茶话会 v${version} 活着。` }],
      }),
    });
  } catch (error) {
    ctx.logger.error(`[${name}] 工具注册失败: ${error?.message || error}`);
  }

  // 内测用的手动触发：不想等主动巡检随机到点的时候，直接冒一次看看链路通不通。
  // 不写聊天记录，只跑提醒那条路。发布前连同 /probe、/notify/test 一起剥掉。
  try {
    if (DEV_TOOLS) ctx.tools.register({
      name: "chahuahui_remind_now",
      description: "立刻模拟一位伙伴主动来找，用来验收茶话会的提醒横幅（内测用）。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const partners = await listPartners();
        const who = partners[0] ?? { id: "test", name: "测试伙伴" };
        await announceArrival(who.id, who.name);
        const where = notifyState.activeSessionPath ?? "（还没认出活跃窗口——先去某个会话里说一句话再试）";
        return {
          content: [{ type: "text", text: `提醒已触发。活跃窗口：${where}` }],
        };
      },
    });
  } catch (error) {
    ctx.logger.error(`[${name}] 提醒测试工具注册失败: ${error?.message || error}`);
  }

  // 内测用的体感测试台：把账本摆到几个档位上，用真实提示词和真机模型各回几次。
  // 模型调用很慢，所以这里立刻返回、活儿丢到后台，结果写到 dataDir 下的 taste-<时刻>.json。
  // 只读：不写聊天记录、不动账本。发布前连同 /probe、/notify/test 一起剥掉。
  try {
    if (DEV_TOOLS) ctx.tools.register({
      name: "chahuahui_taste_probe",
      description:
        "内测：把茶话会的关系账本摆到指定档位，用真实提示词和真机模型各回几次，"
        + "看伙伴的说话风格随关系怎么变。只读，不改聊天记录、不动账本、不落库。"
        + "结果以 JSON 写在返回的路径里，跑完再读那个文件。",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "哪位伙伴（茶话会里的 agentId，如 hanako）" },
          probes: {
            type: "array",
            items: { type: "string" },
            description: "探针：模拟她说的几句，最多 6 句",
          },
          repeats: { type: "number", description: "每个档位每句探针回几次（1~5），默认 1" },
          levels: {
            type: "array",
            description:
              "档位表，每项 { name, turns, activeDays, score, seedTurns?, seedDays?, disclosure? }；"
              + "disclosure 给了就直接用这个披露系数（不按账本反推）",
            items: { type: "object" },
          },
          blocks: {
            type: "object",
            description: "要额外拼进提示词的块：{ time, sticker, daybook, wake }，默认全关",
          },
          personality: { type: "object", description: "临时覆盖性格（只对这次生效，不落盘）" },
          hobbies: { type: "array", description: "临时覆盖爱好（只对这次生效，不落盘）", items: { type: "object" } },
        },
        required: ["agentId"],
      },
      execute: async (args) => {
        const agentId = String(args?.agentId ?? "").trim();
        if (!agentId) return { content: [{ type: "text", text: "要带 agentId" }] };
        const file = startTasteProbe(args);
        return {
          content: [{
            type: "text",
            text: `体感测试已在后台跑（模型调用慢，要等一会儿）。结果会写到：\n${file}`,
          }],
        };
      },
    });
  } catch (error) {
    ctx.logger.error(`[${name}] 体感测试工具注册失败: ${error?.message || error}`);
  }

  // 提醒那层要听两件事：她换窗口了（横幅跟着走）、她把横幅关了（这批翻篇）。
  // 订阅只是登记，不是受权限保护的调用，所以放在装载期是安全的。
  try {
    ctx.bus.subscribe(
      (event, sessionPath) => {
        const type = String(event?.type ?? "");
        if (type === "turn_start") {
          if (sessionPath) {
            const changed = notifyState.activeSessionPath !== sessionPath;
            notifyState.activeSessionPath = sessionPath;
            if (changed || notifyState.batch) {
              diagnostics({ event: "notify.window", sessionPath, changed });
              void followActiveWindow();
            }
          }
          return;
        }
        if (type === "message_end") {
          // 联动关了就一条都不收（她说不想让伙伴知道电脑那边的事，那就真的不知道）
          if (!workfeedOn()) return;
          const entry = normalizeWorkEvent(event, sessionPath);
          if (entry) {
            const feed = store.appendWorkEvent(entry);
            diagnostics({ event: "workfeed.event", agentId: entry.agentId, role: entry.role, lifeDay: entry.lifeDay, chars: entry.text.length, total: feed.events.length });
          }
          return;
        }
        if (type === `plugin-v2:${name}:banner`) handleBannerBusEvent(event);
      },
      { types: ["turn_start", "message_end", `plugin-v2:${name}:banner`] },
    );
  } catch (error) {
    diagnostics({ event: "notify.subscribe.failed", error: describeError(error) });
  }

  ctx.logger.info(`[${name}] v${version} 已装载：好友列表与聊天窗口就位。`);

  // 主动那层的巡检。挂在这里是故意的：它只是个定时器，真正的活儿在回调里，
  // 装载期一个受权限保护的接口都不碰。
  const PROACTIVE_TICK_MS = 5 * 60 * 1000;
  const timer = setInterval(() => {
    void recoverPendingReplies();
    void runProactiveTick().catch((error) =>
      ctx.logger.error(`[${name}] 主动巡检出错: ${error?.message || error}`),
    );
    void runAwaitingTick().catch((error) =>
      ctx.logger.error(`[${name}] 等回音巡检出错: ${error?.message || error}`),
    );
  }, PROACTIVE_TICK_MS);
  timer.unref?.();
  // 重启后先恢复未完成的回复；主动巡检仍然故意晚一点，避免刚装载就一群人扑上来
  const recover = setTimeout(() => {
    void recoverPendingReplies();
  }, 1000);
  recover.unref?.();
  // 起来一会儿后再看第一眼（不是立刻）
  const kick = setTimeout(() => {
    void runProactiveTick().catch(() => {});
    void runAwaitingTick().catch(() => {});
  }, 90 * 1000);
  kick.unref?.();
}

export default { name, version, apply };
