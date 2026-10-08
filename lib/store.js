// 文件预算豁免：自有账本聚合层集中执行跨聊天、记忆、设置和适应账的同步清理，保持共享状态与原子落盘边界。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GLOBAL_GATE, normalizeGateMax } from "./proactive.js";
import { normalizeModelRef } from "./model.js";
import { normalizeVoiceModelConfig, normalizeVoiceProfiles, activeVoiceProfileId, migratedVoiceProfileId } from "./voice.js";
import { createRelationship, normalizeRelationship, normalizeSeed } from "./relationship.js";
import { emptyTopicBook, readBook } from "./topics.js";
import { emptyWatch, readWatch } from "./selfwatch.js";
import { normalizeHobbies, normalizePersonality } from "./knowing.js";
import { normalizePalette } from "./palette.js";
import { normalizeRecognition } from "./recognition.js";
import { normalizeBackground, normalizeBackgroundOpacityMap } from "./background.js";
import { normalizeVisionConfig } from "./vision.js";
import { normalizeBadge } from "./badges.js";
import { normalizeGuides } from "./adaptation.js";
import { appendException, consolidateHabitChanges, normalizeException } from "./plasticity.js";
import { factKey, normalizeFacts } from "./facts.js";
import { requirePartnerId } from "./partner-id.js";
import { normalizeProposals } from "./todo-propose.js";
import { dayKey } from "./days.js";
import { readJsonDurable, writeJsonAtomic } from "./persistence.js";

/**
 * 应用自己的账本：聊天记录、记忆、设置、未读。
 *
 * 与 Hanako 那边完全分开的两本账 —— 这里写的东西一个字都不会回流。
 *
 * 目录结构（都在 ctx.dataDir 下）：
 *   v2/state.json                      全局设置 + 每位伙伴的设置 + 人格快照
 *   v2/threads/<agentId>.json          聊天记录（含 rolledThroughId 和已读位置）
 *   v2/partners/<agentId>/memory.json  分层记忆：重要事实 + 日账 + 关系档案 + 段落摘要
 *   v2/partners/<agentId>/knowing.json 关系账 + 性格 + 爱好（茶话会自己多加的那一层）
 *   v2/partners/<agentId>/selfwatch.json 自省小本子（内部：为何没开口与修正，用户看不见）
 *   v2/diagnostics.jsonl               诊断日志
 *
 * 文件预算豁免（为什么这个文件不拆）：它是本应用唯一的落盘聚合层——所有读写都收在这一个门里，
 * 换来的是「数据在哪、怎么写」只有一处需要看。按行数拆成 state / memory / knowing 几个文件，
 * 只会让每个调用方多认一层 import，不会减少任何一条业务规则，故保留在一个文件里。
 *
 * 旧数据兼容策略：没有按 schemaVersion 逐版迁移，走的是「读的时候归一」——每个域各有自己的
 * normalize*（人格、关系、爱好、背景、调色盘、认知、事实……），读进来先过一遍：缺字段补默认、
 * 旧字段认旧写法，写回时自然升到当前形状。升级安全边界：能认的旧结构见各 normalize* 函数；
 * 认不出的旧结构按默认值处理（不会报错，但也不保证还原）。新增字段时请同时补归一，别只写默认值。
 */

const SCHEMA_VERSION = 1;
const MAX_MESSAGES_PER_THREAD = 500;
/** 摘要有多少段就往回带多少段；超出丢掉最老的（时间线的长尾交给关系档案） */
const MAX_ARCHIVE_ENTRIES = 12;
const MAX_FACT_ENTRIES = 80;
const MAX_ADAPTATION_GUIDES = 128;
const MAX_ADAPTATION_EXCEPTIONS = 64;
const MAX_ADAPTATION_FEEDBACK = 128;
const MAX_ADAPTATION_HABITS = 32;

/** 「账本读坏了、已挪到哪里去」的记录（诊断用；取走就清空）。 */
const corruptLog = [];
/** 最近一次「账本读坏已留档」的轻量提示（给界面用，取走即空）。跟 corruptLog 分开：那个走诊断，这个给用户看。 */
let corruptNotice = null;

function readJson(file, fallback) {
  return readJsonDurable(file, fallback, {
    onCorrupt: ({ file: corruptFile, dest }) => {
      const at = new Date().toISOString();
      corruptLog.push({ file: corruptFile, dest: dest ?? null, at });
      corruptNotice = { file: path.basename(corruptFile), at };
    },
  });
}

const writeJson = writeJsonAtomic;
const partnerPathId = (agentId) => requirePartnerId(agentId);
const dict = (value) => Object.assign(Object.create(null), value && typeof value === "object" && !Array.isArray(value) ? value : {});

function normalizeFeedback(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const polarity = source.polarity === "negative" ? "negative" : "positive";
  return {
    id: String(source.id ?? "").trim().slice(0, 120),
    exceptionId: String(source.exceptionId ?? "").trim().slice(0, 120),
    type: String(source.type ?? "").trim().slice(0, 60),
    polarity,
    sourceMessageId: String(source.sourceMessageId ?? "").trim().slice(0, 120),
    lifeDay: String(source.lifeDay ?? "").trim().slice(0, 20),
    at: source.at ?? null,
  };
}

function normalizeHabitChange(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const state = ["emerging", "settled", "reverted"].includes(source.state) ? source.state : "emerging";
  return {
    key: String(source.key ?? "").trim().slice(0, 120),
    description: String(source.description ?? "").trim().slice(0, 240),
    from: String(source.from ?? "").trim().slice(0, 80),
    to: String(source.to ?? "").trim().slice(0, 80),
    state,
    guideIds: Array.isArray(source.guideIds) ? [...new Set(source.guideIds.map((item) => String(item).trim()).filter(Boolean))].slice(0, 12) : [],
    exceptionIds: Array.isArray(source.exceptionIds) ? [...new Set(source.exceptionIds.map((item) => String(item).trim()).filter(Boolean))].slice(0, 64) : [],
    startedAt: source.startedAt ?? null,
    settledAt: source.settledAt ?? null,
    updatedAt: source.updatedAt ?? null,
  };
}

function normalizeAdaptationMigration(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    factsV1CompletedAt: source.factsV1CompletedAt ?? null,
    sourceIds: Array.isArray(source.sourceIds) ? [...new Set(source.sourceIds.map(String).filter(Boolean))].slice(-512) : [],
  };
}

function normalizeAdaptationBook(raw, now = new Date()) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    schemaVersion: 1,
    revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    guides: normalizeGuides(source.guides, now).slice(-MAX_ADAPTATION_GUIDES),
    exceptions: (Array.isArray(source.exceptions) ? source.exceptions : [])
      .map(normalizeException).filter((row) => row.id || row.behavior).slice(-MAX_ADAPTATION_EXCEPTIONS),
    feedbackEvents: (Array.isArray(source.feedbackEvents) ? source.feedbackEvents : [])
      .map(normalizeFeedback).filter((row) => row.id && row.exceptionId && row.sourceMessageId).slice(-MAX_ADAPTATION_FEEDBACK),
    habitChanges: (Array.isArray(source.habitChanges) ? source.habitChanges : [])
      .map(normalizeHabitChange).filter((row) => row.key || row.description).slice(-MAX_ADAPTATION_HABITS),
    migration: normalizeAdaptationMigration(source.migration),
    pendingInvalidationGuideIds: Array.isArray(source.pendingInvalidationGuideIds) ? [...new Set(source.pendingInvalidationGuideIds.map(String).filter(Boolean))].slice(-128) : [],
    observationLocks: Array.isArray(source.observationLocks) ? [...new Set(source.observationLocks.map(String).filter(Boolean))].slice(-64) : [],
  };
}

export function createStore(dataDir) {
  // 新账本起手不留上一条的损坏提示（模块级变量，多个实例时别互相串）
  corruptNotice = null;
  const dir = path.join(dataDir, "v2");
  const stateFile = path.join(dir, "state.json");
  const workfeedFile = path.join(dir, "workfeed.json");
  const favoritesFile = path.join(dir, "favorites.json");
  const threadsDir = path.join(dir, "threads");
  const partnersDir = path.join(dir, "partners");
  const localAvatarsDir = path.join(dir, "local-avatars");
  const voiceDir = path.join(dir, "voice");
  const userAdaptationFile = path.join(dir, "user-adaptation.json");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.mkdirSync(partnersDir, { recursive: true });

  /**
   * 「这间屋子里已经住过谁」：threads 目录里已经有账本的，都是改造前就在被主动联系的老伙伴。
   *
   * 主动开关的默认值分两种人：
   *   - 她还没跟某位 ta 聊过（新邀请进来的、新装的）→ 默认不主动，找不找 ta 由她自己定；
   *   - 已经在聊的 → 维持原样，之前一直主动就继续主动，不因为改了默认值把她的设置悄悄改掉。
   * 判据用聊天账本而不是设置字段：老数据里 proactiveEnabled 从来没被显式写过（默认就是开，
   * 不点就不落盘），只有「聊过」能真实反映她到底已经和谁建立了这层关系。
   */
  const residentCohort = new Set(
    fs.readdirSync(threadsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
  );
  const residentDefault = (agentId) => {
    try {
      return residentCohort.has(partnerPathId(agentId));
    } catch {
      return false;
    }
  };

  let state = readJson(stateFile, {});
  state = {
    schemaVersion: SCHEMA_VERSION,
    partners: dict(state.partners),
    /** 只存在茶话会里的本地角色，不读写 Hana 的 agents 目录 */
    localPartners: dict(state.localPartners),
    pref: dict(state.pref),
    settings: dict(state.settings),
    hiddenPartnerIds: Array.isArray(state.hiddenPartnerIds)
      ? [...new Set(state.hiddenPartnerIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
      : [],
    /** 用户自己排的伙伴顺序；新伙伴不在这里时追加到当前列表末尾。 */
    partnerOrder: Array.isArray(state.partnerOrder)
      ? [...new Set(state.partnerOrder.map((id) => String(id ?? "").trim()).filter(Boolean))]
      : [],
    lastPartnerId: state.lastPartnerId ?? null,
    personaCache: dict(state.personaCache),
    /** 她最后一次手动关掉提醒横幅的时间（"只认手动关"靠它翻篇） */
    bannerAckAt: state.bannerAckAt ?? null,
    /**
     * 主动那层的运行状态：下次到点、今天说过几条、暂存着还没说的话。
     * 它是机器自己跑出来的账，但必须跟设置一起过夜——漏在重建清单外面的话，
     * 每次进程重启第一次存盘就会把它整个抹掉：到点时间被重掷、想找她的话被丢、
     * 当日计数归零。这一格是修那个漏的。
     */
    runtime: {
      partners: dict(state.runtime?.partners),
      global: dict(state.runtime?.global),
    },
  };

  const save = () => writeJson(stateFile, state);

  const readWorkfeed = () => {
    const raw = readJson(workfeedFile, {});
    return {
      schemaVersion: 1,
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  };

  const writeWorkfeed = (feed) => {
    const clean = {
      schemaVersion: 1,
      events: Array.isArray(feed?.events) ? feed.events.slice(-240) : [],
    };
    writeJson(workfeedFile, clean);
    return clean;
  };

  const appendWorkEvent = (event) => {
    const feed = readWorkfeed();
    const id = String(event?.id ?? "").trim();
    if (!id || feed.events.some((row) => String(row?.id ?? "") === id)) return feed;
    feed.events.push({ ...event, id });
    return writeWorkfeed(feed);
  };

  /** 删除一条收集到的生活记录；找不到时保持账本原样。 */
  const removeWorkEvent = (eventId) => {
    const id = String(eventId ?? "").trim();
    const feed = readWorkfeed();
    if (!id || !feed.events.some((row) => String(row?.id ?? "") === id)) return feed;
    return writeWorkfeed({ events: feed.events.filter((row) => String(row?.id ?? "") !== id) });
  };

  /** 把收集到的生活记录清空（她自己按的，不是自动清理）。 */
  const clearWorkfeed = () => writeWorkfeed({ events: [] });

  const readFavorites = () => {
    const raw = readJson(favoritesFile, {});
    return {
      schemaVersion: 1,
      items: Array.isArray(raw.items) ? raw.items.filter((row) => row && row.id && row.agentId && row.kind).slice(-500) : [],
    };
  };

  const writeFavorites = (book) => {
    const next = { schemaVersion: 1, items: Array.isArray(book?.items) ? book.items.slice(-500) : [] };
    writeJson(favoritesFile, next);
    return next;
  };

  const listFavorites = () => readFavorites().items.slice().reverse();

  const saveFavorite = (item) => {
    const book = readFavorites();
    const existing = book.items.findIndex((row) => row.agentId === item.agentId && row.messageId === item.messageId);
    const entry = {
      id: existing >= 0 ? book.items[existing].id : `fav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: existing >= 0 ? book.items[existing].createdAt : new Date().toISOString(),
      ...item,
    };
    if (existing >= 0) book.items[existing] = entry;
    else book.items.push(entry);
    return writeFavorites(book).items.find((row) => row.id === entry.id);
  };

  const removeFavorite = (favoriteId) => {
    const book = readFavorites();
    const next = book.items.filter((row) => row.id !== String(favoriteId ?? ""));
    if (next.length === book.items.length) return null;
    writeFavorites({ items: next });
    return true;
  };

  const removeFavoritesByMessage = (agentId, messageId) => {
    const agent = String(agentId ?? "");
    const id = String(messageId ?? "");
    const book = readFavorites();
    const next = book.items.filter((row) => row.agentId !== agent || row.messageId !== id);
    const removed = book.items.length - next.length;
    if (removed) writeFavorites({ items: next });
    return removed;
  };

  const getFavorite = (favoriteId) => readFavorites().items.find((row) => row.id === String(favoriteId ?? "")) ?? null;

  const listLocalPartners = () => Object.values(state.localPartners)
    .filter((row) => row && row.id && row.name)
    // 角色卡正文留在 dataDir 和提示词编译路径里，不跟着好友列表每轮轮询传到界面。
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      isLocal: true,
      importedFromTavern: Boolean(row.tavernCard),
    }));

  const createLocalPartner = ({ name, description = "" } = {}) => {
    const cleanName = String(name ?? "").trim().slice(0, 40);
    if (!cleanName) throw new Error("角色名不能为空");
    const id = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const row = {
      id,
      name: cleanName,
      description: String(description ?? "").trim().slice(0, 4000),
      createdAt: new Date().toISOString(),
      isLocal: true,
    };
    state.localPartners[id] = row;
    save();
    return row;
  };

  const writeLocalAvatar = (agentId, avatar) => {
    if (!avatar?.bytes || !["png", "jpg", "gif", "webp"].includes(avatar.extension)) return null;
    const safeId = partnerPathId(agentId);
    fs.mkdirSync(localAvatarsDir, { recursive: true });
    const target = path.join(localAvatarsDir, `${safeId}.${avatar.extension}`);
    const temp = `${target}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(temp, avatar.bytes);
      fs.renameSync(temp, target);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* 保留原错误 */ }
      throw error;
    }
    return avatar.extension;
  };

  const importTavernPartner = (value = {}) => {
    const source = value.source && typeof value.source === "object" ? value.source : {};
    const cardKey = String(source.cardId ?? "").toLocaleLowerCase("en-US");
    const existing = Object.values(state.localPartners).find((row) =>
      row?.tavernCard?.source?.appId === source.appId
      && String(row.tavernCard.source.cardId ?? "").toLocaleLowerCase("en-US") === cardKey,
    );
    const character = value.character && typeof value.character === "object" ? value.character : {};
    const name = String(character.name ?? "").trim().slice(0, 40);
    if (!name) throw new Error("角色名不能为空");
    const now = new Date().toISOString();
    const id = existing?.id ?? `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const avatarExtension = value.avatar ? writeLocalAvatar(id, value.avatar) : existing?.avatarExtension ?? null;
    const partner = {
      ...(existing ?? {}),
      id,
      name,
      // 保留旧本地角色字段兼容；酒馆角色另存分栏资料，由 getPersona 编译。
      description: existing?.description ?? "",
      tavernCard: {
        source: {
          appId: String(source.appId ?? ""),
          cardId: String(source.cardId ?? ""),
          format: String(source.format ?? ""),
          creator: String(source.creator ?? ""),
          characterVersion: String(source.characterVersion ?? ""),
          creatorNotes: String(source.creatorNotes ?? ""),
          tags: Array.isArray(source.tags) ? source.tags.slice(0, 12) : [],
          openingSeeded: existing?.tavernCard?.source?.openingSeeded === true || !String(character.firstMessage ?? "").trim(),
          importedAt: existing?.tavernCard?.source?.importedAt ?? now,
          updatedAt: now,
        },
        description: String(character.description ?? ""),
        personality: String(character.personality ?? ""),
        scenario: String(character.scenario ?? ""),
        exampleDialogue: String(character.exampleDialogue ?? ""),
        // 世界书人格条目（基础信息 / 性格 / 二次解释 / 扮演准则）。旧数据没有这个字段，
        // getPersona 那边按空数组处理，重新邀请一次就会补上。
        personaNotes: Array.isArray(character.personaNotes)
          ? character.personaNotes.slice(0, 8).map((note) => ({
            label: String(note?.label ?? "").slice(0, 40),
            text: String(note?.text ?? ""),
          })).filter((note) => note.text)
          : [],
      },
      avatarExtension,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      isLocal: true,
    };
    state.localPartners[id] = partner;
    save();
    return { partner, created: !existing, openingPending: partner.tavernCard.source.openingSeeded !== true };
  };

  const markTavernOpeningSeeded = (agentId) => {
    const partner = localPartner(agentId);
    if (!partner?.tavernCard?.source) return false;
    partner.tavernCard.source.openingSeeded = true;
    partner.tavernCard.source.updatedAt = new Date().toISOString();
    save();
    return true;
  };

  const localPartner = (agentId) => state.localPartners[String(agentId ?? "")] ?? null;

  const getLocalPartnerAvatar = (agentId) => {
    const partner = localPartner(agentId);
    const extension = String(partner?.avatarExtension ?? "").toLowerCase();
    const contentType = ({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[extension];
    if (!contentType) return null;
    try {
      const file = path.join(localAvatarsDir, `${partnerPathId(agentId)}.${extension}`);
      return { bytes: fs.readFileSync(file), contentType };
    } catch {
      return null;
    }
  };
  const threadFile = (agentId) => path.join(threadsDir, `${partnerPathId(agentId)}.json`);
  const memoryFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "memory.json");

  // ── 聊天记录 ───────────────────────────────────────────────

  // 只缓存未变化的聊天账：每次仍检查文件身份，其他实例写入/删除后立即失效。
  // 返回深拷贝，调用方改一条消息不能污染下一次读取；最多保留 32 位伙伴。
  const threadCache = new Map();
  const threadStamp = (file) => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };

  const readThread = (agentId) => {
    const file = threadFile(agentId);
    const stamp = threadStamp(file);
    const cached = threadCache.get(file);
    if (stamp !== null && cached?.stamp === stamp) {
      threadCache.delete(file);
      threadCache.set(file, cached);
      return structuredClone(cached.thread);
    }
    threadCache.delete(file);
    const raw = stamp === null ? {} : readJson(file, {});
    const source = Array.isArray(raw.messages) ? raw.messages : [];
    let nextSeq = Number(raw.nextSeq) > 0 ? Number(raw.nextSeq) : 1;
    const messages = source.map((row, index) => {
      const seq = Number(row?.seq) > 0 ? Number(row.seq) : index + 1;
      nextSeq = Math.max(nextSeq, seq + 1);
      return { ...row, seq };
    });
    const rolledThroughSeq = Number(raw.rolledThroughSeq) > 0 ? Number(raw.rolledThroughSeq) : null;
    const thread = {
      agentId,
      messages,
      nextSeq,
      /** 这个水位及更早的消息已经进过摘要，不用再压一遍 */
      rolledThroughId: raw.rolledThroughId ?? null,
      rolledThroughSeq,
      /** 她读到哪儿了（用于未读徽标） */
      readThroughId: raw.readThroughId ?? null,
      /** 她读到那儿是什么时候（ta那边靠「已读多久了」决定怎么反应） */
      readThroughAt: raw.readThroughAt ?? null,
      /** 伙伴待处理的回复排期；重启后靠它恢复定时器 */
      pendingReply: raw.pendingReply && typeof raw.pendingReply === "object" ? raw.pendingReply : null,
      updatedAt: raw.updatedAt ?? null,
    };
    // 文件在读取中被替换、或者坏账本被隔离时，不把旧内容登记成新文件的缓存。
    if (stamp !== null && threadStamp(file) === stamp) {
      threadCache.set(file, { stamp, thread: structuredClone(thread) });
      if (threadCache.size > 32) threadCache.delete(threadCache.keys().next().value);
    }
    return thread;
  };

  const writeThread = (agentId, thread) => {
    const file = threadFile(agentId);
    threadCache.delete(file);
    writeJson(file, { ...thread, agentId, updatedAt: new Date().toISOString() });
  };

  const getThread = (agentId) => readThread(agentId);

  const appendMessage = (agentId, message) => {
    const thread = readThread(agentId);
    const entry = {
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      ...message,
      seq: thread.nextSeq,
    };
    thread.nextSeq += 1;
    thread.messages.push(entry);
    if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
      thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
    }
    writeThread(agentId, thread);
    return entry;
  };

  const clearThread = (agentId) => {
    // 清聊天不清记忆：日账和关系档案是另一本账，她要清得单独说
    writeThread(agentId, { agentId, messages: [], nextSeq: 1, rolledThroughId: null, rolledThroughSeq: null, readThroughId: null, readThroughAt: null, pendingReply: null });
  };

  const resetPartnerMemory = (agentId) => {
    const knowing = getKnowing(agentId);
    clearThread(agentId);
    writeMemory(agentId, { profile: {}, facts: [], ledger: [], archive: [] });
    saveKnowing(agentId, {
      ...knowing,
      relationship: createRelationship(),
      relationSeed: null,
      hobbies: [],
    });
    savePartnerAdaptation(agentId, {});
    saveTopicBook(agentId, emptyTopicBook());
    saveSelfWatch(agentId, emptyWatch());
    clearPaletteDraft(agentId);
    clearReviewSession(agentId);
    clearCoCreateSession(agentId);
    resetProactiveState(agentId);
    return { knowing: getKnowing(agentId) };
  };

  /**
   * 彻底删除一位伙伴在茶话会这边的一切。
   *
   * 「移出」是可恢复的隐藏，这里是不可逆的抹除：聊天、记忆（日账与关系档案）、
   * 关系进度、话题本、习惯与适应账、自画像、朗读音频、头像、收藏和全部设置都不留。
   * 用户在界面上二次确认过才会走到这里。
   *
   * 边界：删的只是茶话会这本账。ta 在 Hana 里的身份文件、记忆和主对话框一个字都不动。
   */
  const purgePartner = (agentId) => {
    const id = partnerPathId(agentId);
    const removed = { files: 0, favorites: 0, isLocal: false };
    const drop = (target) => {
      try {
        if (!fs.existsSync(target)) return;
        fs.rmSync(target, { recursive: true, force: true });
        removed.files += 1;
      } catch {
        // 单个文件删不掉（占用、权限）不反过来卡住整次删除：其余账照清，
        // 残留的那一两个文件下次再删也不会把数据接回去。
      }
    };

    drop(path.join(partnersDir, id));
    threadCache.delete(threadFile(id));
    drop(threadFile(id));
    drop(path.join(voiceDir, id));
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) drop(path.join(localAvatarsDir, `${id}.${ext}`));

    if (state.localPartners?.[id]) {
      delete state.localPartners[id];
      removed.isLocal = true;
    }
    state.hiddenPartnerIds = (state.hiddenPartnerIds ?? []).filter((item) => String(item ?? "") !== id);
    state.partnerOrder = (state.partnerOrder ?? []).filter((item) => String(item ?? "") !== id);
    if (String(state.lastPartnerId ?? "") === id) state.lastPartnerId = null;
    if (state.personaCache) delete state.personaCache[id];
    if (state.pref) delete state.pref[id];
    if (state.runtime?.partners) delete state.runtime.partners[id];
    save();

    const book = readFavorites();
    if (book.items.some((row) => String(row?.agentId ?? "") === id)) {
      const next = { ...book, items: book.items.filter((row) => String(row?.agentId ?? "") !== id) };
      writeFavorites(next);
      removed.favorites = book.items.length - next.items.length;
    }
    return removed;
  };

  const getPendingReply = (agentId) => readThread(agentId).pendingReply;

  const setPendingReply = (agentId, pendingReply) => {
    const thread = readThread(agentId);
    thread.pendingReply = pendingReply && typeof pendingReply === "object" ? { ...pendingReply } : null;
    writeThread(agentId, thread);
    return thread.pendingReply;
  };

  const clearPendingReply = (agentId) => setPendingReply(agentId, null);

  const clearPendingReplyIf = (agentId, messageId) => {
    const thread = readThread(agentId);
    if (thread.pendingReply?.messageId !== messageId) return false;
    thread.pendingReply = null;
    writeThread(agentId, thread);
    return true;
  };

  const patchMessage = (agentId, messageId, patch) => {
    const thread = readThread(agentId);
    const index = thread.messages.findIndex((row) => row.id === messageId);
    if (index < 0) return null;
    thread.messages[index] = { ...thread.messages[index], ...patch };
    writeThread(agentId, thread);
    return thread.messages[index];
  };

  const removeMessage = (agentId, messageId) => {
    const thread = readThread(agentId);
    const index = thread.messages.findIndex((row) => row.id === messageId);
    if (index < 0) return null;
    const [removed] = thread.messages.splice(index, 1);
    if (thread.rolledThroughId === messageId) thread.rolledThroughId = null;
    if (thread.readThroughId === messageId) {
      thread.readThroughId = thread.messages[index - 1]?.id ?? null;
      thread.readThroughAt = null;
    }
    writeThread(agentId, thread);
    return removed;
  };

  const replyTargetFor = (messages, index) => {
    const row = messages[index];
    if (!row || row.role !== "assistant" || row.recalled) return null;
    if (row.proactive || row.nudge || ["action", "poke", "tavern-opening"].includes(row.kind)) return null;
    if (row.repliedTo) return String(row.repliedTo);
    return messages.slice(0, index).findLast((item) => item?.role === "user" && !item.recalled)?.id ?? null;
  };

  /** 硬删除一整轮伙伴回复，并在该用户消息已无其他回复时恢复未读。 */
  const removeAssistantReply = (agentId, messageId, { at = new Date().toISOString() } = {}) => {
    const thread = readThread(agentId);
    const index = thread.messages.findIndex((row) => row.id === messageId);
    const message = index >= 0 ? thread.messages[index] : null;
    if (!message || message.role !== "assistant") return null;
    const targetId = String(replyTargetFor(thread.messages, index) ?? "");
    thread.messages.splice(index, 1);
    if (thread.readThroughId === messageId) {
      thread.readThroughId = thread.messages[index - 1]?.id ?? null;
      thread.readThroughAt = null;
    }

    let restoredUnread = false;
    const target = targetId
      ? thread.messages.find((row) => row?.id === targetId && row.role === "user" && !row.recalled)
      : null;
    if (target && !thread.messages.some((row, rowIndex) => replyTargetFor(thread.messages, rowIndex) === targetId)) {
      target.readAt = null;
      target.unreadResetAt = at;
      restoredUnread = true;
    }

    const memory = readMemory(agentId);
    const messageAt = Date.parse(String(message.at ?? ""));
    const hasUnknownArchiveRange = memory.archive.some((row) => {
      const from = Date.parse(String(row?.from ?? ""));
      const to = Date.parse(String(row?.to ?? ""));
      return !Number.isFinite(from) || !Number.isFinite(to) || to < from;
    });
    const archiveIndex = Number.isFinite(messageAt)
      ? memory.archive.findIndex((row) => {
          const from = Date.parse(String(row?.from ?? ""));
          const to = Date.parse(String(row?.to ?? ""));
          return Number.isFinite(from) && Number.isFinite(to) && messageAt >= from && messageAt <= to;
        })
      : -1;
    let removedArchiveEntries = 0;
    if (memory.archive.length && (hasUnknownArchiveRange || !Number.isFinite(messageAt))) {
      // 旧归档缺少时间边界时无法证明其中没有这条回复；宁可重新积累，也不留下可能泄漏的摘要。
      removedArchiveEntries = memory.archive.length;
      memory.archive = [];
      thread.rolledThroughId = null;
      thread.rolledThroughSeq = null;
    } else if (archiveIndex >= 0) {
      const affected = memory.archive[archiveIndex];
      const firstAt = Date.parse(String(affected?.from ?? ""));
      const firstRow = [message, ...thread.messages]
        .filter((row) => {
          const rowAt = Date.parse(String(row?.at ?? ""));
          return Number.isFinite(firstAt) && Number.isFinite(rowAt) && rowAt >= firstAt;
        })
        .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
      if (firstRow) {
        const checkpoint = Math.max(0, Number(firstRow.seq) - 1);
        if (!thread.rolledThroughSeq || checkpoint < thread.rolledThroughSeq) {
          thread.rolledThroughSeq = checkpoint || null;
          thread.rolledThroughId = checkpoint
            ? thread.messages.filter((row) => Number(row.seq) <= checkpoint).at(-1)?.id ?? null
            : null;
        }
      }
      removedArchiveEntries = memory.archive.length - archiveIndex;
      memory.archive = memory.archive.slice(0, archiveIndex);
    }

    const targetDay = dayKey(message.at);
    const ledgerLength = memory.ledger.length;
    if (targetDay) memory.ledger = memory.ledger.filter((row) => String(row?.day ?? "") !== targetDay);
    else if (!Number.isFinite(messageAt)) memory.ledger = [];
    const removedLedger = ledgerLength !== memory.ledger.length;
    const factsLength = memory.facts.length;
    memory.facts = memory.facts.filter((row) => row?.source !== messageId);
    const removedFacts = factsLength - memory.facts.length;
    const removedAdaptation = removeExceptionsByResultMessage(agentId, messageId, at);
    const profileCleared = Boolean(memory.profile?.text || memory.profile?.quarantine);
    memory.profile = { text: "", updatedAt: null, source: null, quarantine: null };
    writeMemory(agentId, memory);

    if (thread.rolledThroughId === messageId) {
      const previous = thread.messages.filter((row) => Number(row.seq) < Number(message.seq)).at(-1);
      thread.rolledThroughId = previous?.id ?? null;
      thread.rolledThroughSeq = previous?.seq ?? null;
    }
    writeThread(agentId, thread);
    return {
      message,
      repliedTo: targetId || null,
      restoredUnread,
      memoryCleanup: {
        archiveEntries: removedArchiveEntries,
        ledgerDay: removedLedger ? targetDay : null,
        facts: removedFacts,
        exceptions: removedAdaptation.exceptions,
        feedbackEvents: removedAdaptation.feedbackEvents,
        habitsUpdated: removedAdaptation.habitsUpdated,
        profileCleared,
      },
    };
  };

  /**
   * 删掉一条动作记录（戳一戳）。
   *
   * 动作不进记忆整理：不进模型上下文、不进摘要、不进日账、不进关系档案。
   * 所以这里只动聊天账，不碰任何记忆——这也是它跟 removeAssistantReply 的区别
   * （那条路会顺手清掉回复那天贡献的日账与摘要，对一条戳来说是误伤）。
   * 也不限制“只能删最后一条”：它不参与上下文，删中间的不会扯断任何话。
   */
  const removeActionMessage = (agentId, messageId) => {
    const thread = readThread(agentId);
    const index = thread.messages.findIndex((row) => row.id === messageId);
    if (index < 0) return null;
    const row = thread.messages[index];
    if (!row || !["poke", "action"].includes(row.kind)) return null;
    thread.messages.splice(index, 1);
    if (thread.rolledThroughId === messageId) {
      const previous = thread.messages[index - 1];
      thread.rolledThroughId = previous?.id ?? null;
      thread.rolledThroughSeq = previous?.seq ?? null;
    }
    if (thread.readThroughId === messageId) {
      thread.readThroughId = thread.messages[index - 1]?.id ?? null;
      thread.readThroughAt = null;
    }
    writeThread(agentId, thread);
    return row;
  };

  /** 还没压进摘要的消息（从 rolledThroughId 之后算起）。 */
  const pendingMessages = (agentId) => {
    const thread = readThread(agentId);
    if (thread.rolledThroughSeq) return thread.messages.filter((row) => Number(row.seq) > thread.rolledThroughSeq);
    if (!thread.rolledThroughId) return thread.messages;
    const index = thread.messages.findIndex((row) => row.id === thread.rolledThroughId);
    return index < 0 ? thread.messages : thread.messages.slice(index + 1);
  };

  const markRolledThrough = (agentId, messageId) => {
    const thread = readThread(agentId);
    const row = thread.messages.find((item) => item.id === messageId);
    thread.rolledThroughId = messageId ?? null;
    thread.rolledThroughSeq = row?.seq ?? thread.rolledThroughSeq ?? null;
    writeThread(agentId, thread);
  };

  // ── 未读 ───────────────────────────────────────────────────

  /** 她没看过的伙伴消息条数（友好列表挂徽标用）。 */
  const unreadCount = (agentId, thread = readThread(agentId)) => {
    const rows = thread.messages.filter((row) => row.role === "assistant");
    if (!thread.readThroughId) return rows.length;
    const index = thread.messages.findIndex((row) => row.id === thread.readThroughId);
    if (index < 0) return rows.length;
    return thread.messages.slice(index + 1).filter((row) => row.role === "assistant").length;
  };

  /**
   * 她读到哪儿了。
   *
   * throughId 是前端显式上报的那条（她真的画进眼里的），不给她就按最后一条算。
   * 水位只往前挪：旧回包、乱序上报都不能把已读往回拖。
   * 时间跟水位一起落盘——ta那边要靠「已读多久了」决定下一步怎么反应，光有「读过」不够。
   */
  const markRead = (agentId, { throughId = null, at = new Date().toISOString() } = {}) => {
    const thread = readThread(agentId);
    const target = throughId
      ? thread.messages.find((row) => row.id === throughId)
      : thread.messages[thread.messages.length - 1];
    if (!target) {
      return { changed: false, readThroughId: thread.readThroughId, readThroughAt: thread.readThroughAt };
    }
    const current = thread.readThroughId
      ? thread.messages.find((row) => row.id === thread.readThroughId)
      : null;
    if (current && Number(target.seq ?? 0) <= Number(current.seq ?? 0)) {
      return { changed: false, readThroughId: thread.readThroughId, readThroughAt: thread.readThroughAt };
    }
    thread.readThroughId = target.id;
    thread.readThroughAt = at;
    writeThread(agentId, thread);
    return { changed: true, readThroughId: thread.readThroughId, readThroughAt: thread.readThroughAt };
  };

  /**
   * ta把她的话看到了：给还没落过 readAt 的她说的话盖上时间。
   *
   * 跟上面的 markRead 是两回事：那个是"她读到了伙伴的话"（算未读徒标），
   * 这个是"伙伴看到了她的话"（她那边看到「已读」两个字）。两个方向各记各的。
   */
  const markUserMessagesRead = (agentId, at = new Date().toISOString(), { throughId = null } = {}) => {
    const thread = readThread(agentId);
    // throughId 是这轮真正读进去的目标上界。盖已读等于替 ta 签收，盖到没读的那句就是
    // 假收据：有上界时只盖到它为止，后来的新话留在未读。上界那条自己查不到（撤回、
    // 清空、旧档缺行）时一条都不盖——宁可漏盖，不发假收据。
    const boundSeq = throughId ? Number(thread.messages.find((row) => row.id === throughId)?.seq ?? -1) : null;
    const touchedIds = [];
    for (const row of thread.messages) {
      if (row?.role !== "user" || row.recalled || row.readAt) continue;
      // 模型那会儿用不了，这条 ta 压根没看到：不能盖已读。
      // 盖了就成假收据——她说「我看到了」的那个人其实什么都没接到。
      if (row?.notice?.code === "MODEL_UNAVAILABLE") continue;
      if (boundSeq !== null && !(Number(row.seq ?? 0) <= boundSeq)) break;
      row.readAt = at;
      touchedIds.push(row.id);
    }
    if (touchedIds.length > 0) writeThread(agentId, thread);
    return touchedIds;
  };

  // ── 远处记忆：重要事实 + 关系档案 + 日账 + 段落摘要 ───────────────

  const readMemory = (agentId) => {
    const raw = readJson(memoryFile(agentId), {});
    return {
      profile: {
        text: typeof raw.profile?.text === "string" ? raw.profile.text : "",
        updatedAt: raw.profile?.updatedAt ?? null,
        source: raw.profile?.source && typeof raw.profile.source === "object"
          ? raw.profile.source
          : null,
        quarantine: raw.profile?.quarantine && typeof raw.profile.quarantine === "object"
          ? raw.profile.quarantine
          : null,
      },
      facts: Array.isArray(raw.facts) ? normalizeFacts(raw.facts, raw.facts.map((row) => row?.source).filter(Boolean)) : [],
      ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
      archive: Array.isArray(raw.archive) ? raw.archive : [],
    };
  };

  const writeMemory = (agentId, memory) => {
    const clean = {
      profile: {
        text: String(memory.profile?.text ?? ""),
        updatedAt: memory.profile?.updatedAt ?? null,
        source: memory.profile?.source && typeof memory.profile.source === "object"
          ? memory.profile.source
          : null,
        quarantine: memory.profile?.quarantine && typeof memory.profile.quarantine === "object"
          ? memory.profile.quarantine
          : null,
      },
      facts: normalizeFacts(memory.facts, (Array.isArray(memory.facts) ? memory.facts : []).map((row) => row?.source).filter(Boolean)).slice(-MAX_FACT_ENTRIES),
      ledger: Array.isArray(memory.ledger) ? memory.ledger : [],
      archive: Array.isArray(memory.archive) ? memory.archive.slice(-MAX_ARCHIVE_ENTRIES) : [],
    };
    writeJson(memoryFile(agentId), clean);
    return clean;
  };

  const setProfile = (agentId, text, now = new Date(), source = null) => {
    const memory = readMemory(agentId);
    memory.profile = {
      text: String(text ?? ""),
      updatedAt: now.toISOString(),
      source: source && typeof source === "object" ? source : null,
      quarantine: null,
    };
    return writeMemory(agentId, memory);
  };

  /** 被身份门禁拦下的候选只留在后台，不进入伙伴记忆上下文。 */
  const quarantineProfile = (agentId, text, reason, meta = {}, now = new Date()) => {
    const memory = readMemory(agentId);
    memory.profile.quarantine = {
      text: String(text ?? ""),
      reason: String(reason ?? "unknown"),
      at: now.toISOString(),
      ...meta,
    };
    return writeMemory(agentId, memory);
  };

  /** 一天一条，同一天再写就是覆盖（模型重写当天的账）。 */
  const upsertLedger = (agentId, day, text, now = new Date()) => {
    const memory = readMemory(agentId);
    const entry = { day: String(day), text: String(text ?? "").trim(), at: now.toISOString() };
    const index = memory.ledger.findIndex((row) => row.day === entry.day);
    if (index < 0) memory.ledger.push(entry);
    else memory.ledger[index] = entry;
    memory.ledger.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    return writeMemory(agentId, memory);
  };

  const removeLedger = (agentId, day) => {
    const memory = readMemory(agentId);
    memory.ledger = memory.ledger.filter((row) => row.day !== day);
    return writeMemory(agentId, memory);
  };

  const appendArchive = (agentId, entry) => {
    const memory = readMemory(agentId);
    const id = String(entry?.id ?? "").trim();
    if (id && memory.archive.some((row) => String(row?.id ?? "") === id)) return memory;
    memory.archive.push(entry);
    return writeMemory(agentId, memory);
  };

  const appendFacts = (agentId, facts) => {
    const memory = readMemory(agentId);
    const thread = readThread(agentId);
    const valid = new Map(thread.messages.map((row) => [String(row?.id ?? ""), row]));
    const sourceIds = [...valid.keys()].filter(Boolean);
    const sourceTimes = new Map([...valid.entries()].map(([id, row]) => [id, row.at]));
    const clean = normalizeFacts(facts, sourceIds, new Date(), { requireSource: true }).map((fact) => ({
      ...fact,
      at: sourceTimes.get(fact.source) ?? fact.at,
    }));
    const existing = new Set(memory.facts.map((row) => factKey(row)).filter(Boolean));
    for (const fact of clean) {
      const key = factKey(fact);
      if (!key || existing.has(key)) continue;
      existing.add(key);
      memory.facts.push(fact);
    }
    memory.facts = memory.facts.slice(-MAX_FACT_ENTRIES);
    return writeMemory(agentId, memory);
  };

  const removeFactsBySource = (agentId, sourceId) => {
    const id = String(sourceId ?? "").trim();
    if (!id) return readMemory(agentId);
    const memory = readMemory(agentId);
    memory.facts = memory.facts.filter((fact) => fact?.source !== id);
    return writeMemory(agentId, memory);
  };

  // ── 茶话会里多加的那层：关系账 + 性格 + 爱好 ────────────────
  //
  // 设计借自一个已经停用的自家实验项目，但账只在茶话会自己这一本里，一个字都不外流。

  const knowingFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "knowing.json");
  const adaptationFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "adaptation.json");

  const getUserAdaptation = () => normalizeAdaptationBook(readJson(userAdaptationFile, {}));
  const saveUserAdaptation = (book) => {
    const onDisk = normalizeAdaptationBook(readJson(userAdaptationFile, {}));
    const clean = normalizeAdaptationBook(book);
    clean.revision = Math.max(onDisk.revision, clean.revision) + 1;
    const currentById = new Map(clean.guides.map((guide) => [guide.id, guide]));
    const deactivatedIds = onDisk.guides
      .filter((guide) => guide.status === "active" && currentById.get(guide.id)?.status !== "active")
      .map((guide) => guide.id);
    clean.pendingInvalidationGuideIds = [...new Set([...onDisk.pendingInvalidationGuideIds, ...clean.pendingInvalidationGuideIds, ...deactivatedIds])].slice(-128);
    writeJson(userAdaptationFile, clean);
    clean.pendingInvalidationGuideIds = clean.pendingInvalidationGuideIds
      .filter((guideId) => !invalidateGuideAcrossPartnerAdaptations(guideId));
    writeJson(userAdaptationFile, clean);
    return clean;
  };
  const getPartnerAdaptation = (agentId) => normalizeAdaptationBook(readJson(adaptationFile(agentId), {}));
  const savePartnerAdaptation = (agentId, book) => {
    const onDisk = normalizeAdaptationBook(readJson(adaptationFile(agentId), {}));
    const clean = normalizeAdaptationBook(book);
    clean.revision = Math.max(onDisk.revision, clean.revision) + 1;
    writeJson(adaptationFile(agentId), clean);
    return clean;
  };
  const updatePartnerAdaptation = (agentId, updater) => {
    if (typeof updater !== "function") throw new TypeError("adaptation updater 必须是函数");
    const current = getPartnerAdaptation(agentId);
    const next = updater(structuredClone(current));
    if (next && typeof next.then === "function") throw new TypeError("adaptation updater 不能是异步函数");
    return savePartnerAdaptation(agentId, next ?? current);
  };
  const listPartnerAdaptationIds = () => {
    try {
      return fs.readdirSync(partnersDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .map((entry) => entry.name).filter((agentId) => {
          try { requirePartnerId(agentId); } catch { return false; }
          return fs.existsSync(adaptationFile(agentId));
        });
    } catch { return null; }
  };
  const invalidatePartnerGuideReference = (agentId, guideId, now = new Date()) => {
    const id = String(guideId ?? "").trim();
    if (!id) return getPartnerAdaptation(agentId);
    const current = getPartnerAdaptation(agentId);
    // 极旧数据若出现跨 scope 同 ID，优先保住伙伴级 guide，避免 user-wide 回退误伤本地关系。
    if (current.guides.some((guide) => guide.id === id && guide.scope === "relationship" && guide.status === "active")) return current;
    const referenced = current.exceptions.some((row) => row.guideIds.includes(id) && row.sourceGuideRevoked !== true)
      || current.habitChanges.some((row) => row.guideIds.includes(id) && row.state !== "reverted");
    if (!referenced) return current;
    const at = now.toISOString();
    return savePartnerAdaptation(agentId, {
      ...current,
      exceptions: current.exceptions.map((row) => row.guideIds.includes(id) ? { ...row, sourceGuideRevoked: true } : row),
      habitChanges: current.habitChanges.map((row) => row.guideIds.includes(id) ? { ...row, state: "reverted", updatedAt: at } : row),
    });
  };
  const invalidateGuideAcrossPartnerAdaptations = (guideId, now = new Date()) => {
    const partnerIds = listPartnerAdaptationIds();
    if (!partnerIds) return false;
    let ok = true;
    for (const agentId of partnerIds) {
      try { invalidatePartnerGuideReference(agentId, guideId, now); }
      catch { ok = false; }
    }
    return ok;
  };
  const repairPendingUserAdaptationInvalidations = () => {
    const current = getUserAdaptation();
    if (!current.pendingInvalidationGuideIds.length) return current;
    return saveUserAdaptation(current);
  };
  function removeExceptionsByResultMessage(agentId, resultMessageId, at = new Date()) {
    const targetId = String(resultMessageId ?? "").trim();
    if (!targetId) return { exceptions: 0, feedbackEvents: 0, habitsUpdated: 0 };
    const book = getPartnerAdaptation(agentId);
    const removedExceptions = book.exceptions.filter((row) => row.resultMessageId === targetId);
    const removedIds = new Set(removedExceptions.map((row) => row.id).filter(Boolean));
    const linkedIds = new Set(removedIds);
    for (const habit of book.habitChanges) {
      for (const exceptionId of habit.exceptionIds) {
        if (exceptionId.endsWith(`|${targetId}`)) linkedIds.add(exceptionId);
      }
    }
    const exceptions = book.exceptions.filter((row) => row.resultMessageId !== targetId);
    const feedbackEvents = book.feedbackEvents.filter((row) => !linkedIds.has(row.exceptionId));
    if (!removedExceptions.length && feedbackEvents.length === book.feedbackEvents.length && !linkedIds.size) {
      return { exceptions: 0, feedbackEvents: 0, habitsUpdated: 0 };
    }
    // 重算时不继承旧状态，否则删掉支撑事件后会保留过期的行为影响。
    // 习惯可能由 user-wide guide 支撑，必须与伙伴级 guide 一起参与核算。
    const resetHabits = book.habitChanges.map((row) => ({ ...row, state: "reverted", settledAt: null }));
    const guides = [...getUserAdaptation().guides, ...book.guides];
    const habitChanges = consolidateHabitChanges({ exceptions, feedbackEvents, habitChanges: resetHabits, guides });
    const nextHabits = new Map(habitChanges.map((row) => [row.key, row]));
    const habitsUpdated = book.habitChanges.filter((row) => JSON.stringify(nextHabits.get(row.key) ?? null) !== JSON.stringify(row)).length;
    savePartnerAdaptation(agentId, { ...book, exceptions, feedbackEvents, habitChanges });
    return {
      exceptions: removedExceptions.length,
      feedbackEvents: book.feedbackEvents.length - feedbackEvents.length,
      habitsUpdated,
    };
  }

  const commitException = (agentId, exception, guides = []) => updatePartnerAdaptation(agentId, (book) => {
    const exceptions = appendException(book.exceptions, exception, MAX_ADAPTATION_EXCEPTIONS);
    return {
      ...book,
      exceptions,
      habitChanges: consolidateHabitChanges({ exceptions, feedbackEvents: book.feedbackEvents, habitChanges: book.habitChanges, guides: guides.length ? guides : book.guides }),
    };
  });
  const finalizeException = (agentId, exceptionId, patch = {}, guides = []) => updatePartnerAdaptation(agentId, (book) => {
    const exceptions = book.exceptions.map((row) => row.id === String(exceptionId ?? "")
      ? normalizeException({ ...row, ...patch, id: row.id })
      : row);
    return {
      ...book,
      exceptions,
      habitChanges: consolidateHabitChanges({ exceptions, feedbackEvents: book.feedbackEvents, habitChanges: book.habitChanges, guides: guides.length ? guides : book.guides }),
    };
  });
  const revokeAdaptationBookBySource = (book, sourceMessageId, now = new Date()) => {
    const id = String(sourceMessageId ?? "").trim();
    if (!id) return book;
    const at = now.toISOString();
    const revokedGuides = book.guides.filter((guide) => guide.sourceMessageIds.includes(id));
    const revokedGuideIds = new Set(revokedGuides.map((guide) => guide.id));
    book.observationLocks = [...new Set([...(book.observationLocks ?? []), ...revokedGuides.flatMap((guide) => guide.claims.map((claim) => claim.target))])].slice(-64);
    book.guides = book.guides.map((guide) => revokedGuideIds.has(guide.id)
      ? { ...guide, status: "revoked", revokedAt: at, updatedAt: at }
      : guide);
    book.exceptions = book.exceptions.map((exception) => exception.guideIds.some((guideId) => revokedGuideIds.has(guideId))
      ? { ...exception, sourceGuideRevoked: true }
      : exception);
    book.feedbackEvents = book.feedbackEvents.filter((feedback) => feedback.sourceMessageId !== id);
    book.habitChanges = book.habitChanges.map((habit) => habit.guideIds.some((guideId) => revokedGuideIds.has(guideId))
      ? { ...habit, state: "reverted", updatedAt: at }
      : habit);
    return book;
  };
  const revokePartnerGuidesBySource = (agentId, sourceMessageId, now = new Date()) =>
    savePartnerAdaptation(agentId, revokeAdaptationBookBySource(getPartnerAdaptation(agentId), sourceMessageId, now));
  const revokeUserGuidesBySource = (sourceMessageId, now = new Date()) =>
    saveUserAdaptation(revokeAdaptationBookBySource(getUserAdaptation(), sourceMessageId, now));

  /**
   * 历史版本（后悔药）：跟「和小花聊聊」的迭代配套。
   * 只留最近几版，存的是三面一起的快照（只退一面三层就对不上）。
   */
  const MAX_HISTORY = 2;
  const nextRevision = (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const normalizeHistory = (raw) => (Array.isArray(raw) ? raw : [])
    .filter((row) => row && typeof row === "object" && row.at && row.snapshot && typeof row.snapshot === "object")
    .map((row) => {
      const at = new Date(row.at);
      return {
        at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
        reason: String(row.reason ?? "").trim().slice(0, 80),
        snapshot: row.snapshot,
      };
    })
    .slice(0, MAX_HISTORY);

  const getKnowing = (agentId) => {
    const raw = readJson(knowingFile(agentId), {});
    return {
      relationship: normalizeRelationship(raw.relationship),
      personality: normalizePersonality(raw.personality),
      /** 系统自动定的那份（基准）。她怎么改都不动它，所以能回到它 */
      personalityAuto: raw.personalityAuto ? normalizePersonality(raw.personalityAuto) : null,
      /** 现在生效那份的来历：auto=自动定的、user=她调过的、null=分不清（升级前就有的） */
      personalityFrom: raw.personalityFrom === "user" ? "user"
        : raw.personalityFrom === "auto" ? "auto" : null,
      /** 起跑线：从 Hana 那边的痕量自动量的、或她说「我们早就熟」的那份；账本本身不含它 */
      relationSeed: normalizeSeed(raw.relationSeed),
      hobbies: normalizeHobbies(raw.hobbies),
      /** 性格调色盘（新）；没有就走旧的 personality 那条路 */
      palette: normalizePalette(raw.palette),
      /** 「认真认识 ta」采访的原始回答，可中途恢复和回头修改 */
      recognition: normalizeRecognition(raw.recognition),
      /** 性格档案的历史版本，最近几版，可回退 */
      history: normalizeHistory(raw.history),
      /**
       * 单调递增的版本戳。给「和小花聊聊」做版本守卫用：
       * 单算内容指纹挡不住「改了又改回」（文字恢复，指纹也恢复），只有戳能证明建议建立在同一版上。
       */
      revision: nextRevision(raw.revision),
    };
  };

  const saveKnowing = (agentId, knowing) => {
    // 戳只增不减：盘上那份和传进来的取大的那个再加一，
    // 就算调用方拿的是旧对象，也不会把戳写回去。
    const onDisk = readJson(knowingFile(agentId), {});
    const revision = Math.max(nextRevision(onDisk?.revision), nextRevision(knowing?.revision)) + 1;
    const clean = {
      relationship: normalizeRelationship(knowing?.relationship),
      personality: normalizePersonality(knowing?.personality),
      personalityAuto: knowing?.personalityAuto ? normalizePersonality(knowing.personalityAuto) : null,
      personalityFrom: knowing?.personalityFrom === "user" ? "user"
        : knowing?.personalityFrom === "auto" ? "auto" : null,
      relationSeed: normalizeSeed(knowing?.relationSeed),
      hobbies: normalizeHobbies(knowing?.hobbies),
      palette: normalizePalette(knowing?.palette),
      recognition: normalizeRecognition(knowing?.recognition),
      history: normalizeHistory(knowing?.history),
      revision,
    };
    writeJson(knowingFile(agentId), clean);
    return clean;
  };

  // ── 调色盘草稿（捏人用，捏完就清）────────────────────────
  //
  // 草稿里装着模型给的候选池（每个色好几条行为），比定稿大得多，
  // 而且是一次性的，所以单独一个文件，不进 knowing。

  const draftFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "palette-draft.json");

  const getPaletteDraft = (agentId) => {
    const raw = readJson(draftFile(agentId), null);
    return raw && typeof raw === "object" && Array.isArray(raw.colors) ? raw : null;
  };

  const savePaletteDraft = (agentId, draft) => {
    writeJson(draftFile(agentId), draft && typeof draft === "object" ? draft : {});
    return draft;
  };

  const clearPaletteDraft = (agentId) => {
    try {
      fs.rmSync(draftFile(agentId), { force: true });
      return true;
    } catch {
      return false;
    }
  };

  // ── 「和小花聊聊」的协商会话（会话期间不落档案，确认后才写 knowing）──

  const reviewFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "review-session.json");

  const getReviewSession = (agentId) => {
    const raw = readJson(reviewFile(agentId), null);
    return raw && typeof raw === "object" && raw.agentId ? raw : null;
  };

  const saveReviewSession = (agentId, session) => {
    writeJson(reviewFile(agentId), session && typeof session === "object" ? session : {});
    return session;
  };

  const clearReviewSession = (agentId) => {
    try {
      fs.rmSync(reviewFile(agentId), { force: true });
      return true;
    } catch {
      return false;
    }
  };

  // ── 「跟我聊着捏」的对谈会话（会话期间不落画像，点「成型」才写 palette）──

  const coCreateFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "co-create-session.json");

  const getCoCreateSession = (agentId) => {
    const raw = readJson(coCreateFile(agentId), null);
    return raw && typeof raw === "object" && raw.agentId ? raw : null;
  };

  const saveCoCreateSession = (agentId, session) => {
    writeJson(coCreateFile(agentId), session && typeof session === "object" ? session : {});
    return session;
  };

  const clearCoCreateSession = (agentId) => {
    try {
      fs.rmSync(coCreateFile(agentId), { force: true });
      return true;
    } catch {
      return false;
    }
  };

  // ── 自省小本子（内部：为何没开口，用户看不见也不进聊天） ──

  const watchFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "selfwatch.json");

  const getSelfWatch = (agentId) => readWatch(readJson(watchFile(agentId), {}));

  const saveSelfWatch = (agentId, watch) => {
    const clean = readWatch(watch);
    writeJson(watchFile(agentId), clean);
    return clean;
  };

  // ── 话题本（ta搁着的、以后可以接回来聊的事） ─────────────

  const topicFile = (agentId) => path.join(partnersDir, partnerPathId(agentId), "topics.json");

  const getTopicBook = (agentId) => {
    const raw = readJson(topicFile(agentId), {});
    return readBook(raw);
  };

  const saveTopicBook = (agentId, book) => {
    // 写坏了不如大声报错：这里静默吞掉过一次，结果是把人家的话题本洗成了空。
    if (!book || typeof book !== "object") {
      throw new Error("saveTopicBook 收到一个不像本子的东西，拒绝写入");
    }
    const clean = {
      topics: Array.isArray(book.topics) ? book.topics : [],
      lastExtractedAt: book.lastExtractedAt ?? null,
      extractedThroughId: book.extractedThroughId ?? null,
    };
    writeJson(topicFile(agentId), clean);
    return clean;
  };

  // ── 设置：全局一份 + 每位伙伴一份 ─────────────────────────────

  const getGlobalSettings = () => ({
    /** 静默时段（软闸，不是硬闸；时段内只允许"破例留言"） */
    quiet: state.settings.quiet ?? { start: "23:00", end: "08:00" },
    /** 跨伙伴总闸：全局最小间隔（分钟）+ 每天总共最多几次 */
    globalGate: state.settings.globalGate ?? { ...DEFAULT_GLOBAL_GATE },
    /** 她自己写的那句动作文案（{name} = 动手的那位，{verb} = 动作本身） */
    myAction: state.settings.myAction ?? {},
    /** 这个动作现在叫什么（也就是「戳一戳」还是「拍了拍」，只是叫法） */
    actionStyle: state.settings.actionStyle ?? "poke",
    /** 聊天窗里要不要给两边都挂上头像（默认关，跟以前一样） */
    messageAvatars: state.settings.messageAvatars ?? false,
    /** 是否显示伙伴回复的重新生成/编辑入口（默认关，保护沉浸感） */
    messageRefine: state.settings.messageRefine ?? false,
    /**
     * 「拾光记今日情境」要不要接进提示词。
     * 只在自己装了拾光记、她又手动打开时才生效；默认关，不硬塞。
     */
    daybookEnabled: state.settings.daybookEnabled ?? false,
    /**
     * Hana 主对话近况：把 Hana 各会话里发生的事收进茶话会自己的账本，再当闲聊背景用。
     * 默认开（这是茶话会的一半），但用户可以关掉——关掉后不再收集，已经收的也不再用；
     * 想清掉已经收的走 POST /workfeed/clear。
     */
    workfeedEnabled: state.settings.workfeedEnabled !== false,
    /**
     * 生活节拍默认打开；表达习惯与「主动关心」两个子类各自独立，清空通过 resetAt 重新起算。
     * rhythmProactiveEnabled 是全局主动总闸：全新安装默认关（找不找伙伴由她自己定），
     * 已经在这间屋子里住过人的老账本维持原样——改默认值不该顺手动过她已经有的那层关系。
     * 她手动开或关之后一律以账本里存的那个值为准。
     */
    rhythmEnabled: state.settings.rhythmEnabled !== false,
    rhythmStyleEnabled: state.settings.rhythmStyleEnabled !== false,
    rhythmProactiveEnabled: typeof state.settings.rhythmProactiveEnabled === "boolean"
      ? state.settings.rhythmProactiveEnabled
      : residentCohort.size > 0,
    rhythmResetAt: state.settings.rhythmResetAt ?? null,
    /** 伙伴语音默认关闭；打开后仍由每位伙伴自己的频率档位控制。 */
    voiceEnabled: state.settings.voiceEnabled === true,
    /** 朗读时带上自然的笑、叹气和小停顿；关掉就是干净利落地念。 */
    voiceDelivery: state.settings.voiceDelivery !== false,
    /** 旧字段：九格 / 更早的单格，留着兼容老数据 */
    myActions: state.settings.myActions ?? {},
    myPokeTemplate: state.settings.myPokeTemplate ?? "",
    /** 伙伴换来换去的口径不用她管，但"要不要自动换"给个开关 */
    ...state.settings,
    /** 只有测试通过的模型才算可识图；伙伴自己的配置覆盖全局 */
    vision: normalizeVisionConfig(state.settings.vision),
    /** 茶话会里的用户名称覆盖；null = 跟随 Hana 配置 */
    userNameOverride: typeof state.settings.userNameOverride === "string"
      ? state.settings.userNameOverride.trim().slice(0, 40) || null
      : null,
    /**
     * 总闸放在展开后面，免得被原样盖回去。
     * 老数据里可能存着已经下架的档位（比如 20），这里归一到现在的三档。
     */
    globalGate: {
      minGapMinutes: state.settings.globalGate?.minGapMinutes ?? DEFAULT_GLOBAL_GATE.minGapMinutes,
      maxPerDay: normalizeGateMax(state.settings.globalGate?.maxPerDay ?? DEFAULT_GLOBAL_GATE.maxPerDay),
    },
    /** 预设模型：null = 跟着宿主当前模型走；每位伙伴还能各自再压一个 */
    model: normalizeModelRef(state.settings.model),
    /** 「认识 ta」生成场景候选用的模型；null = 跟默认那条（宿主 utility 通道） */
    recognitionModel: normalizeModelRef(state.settings.recognitionModel),
    /** 朗读模型：用户自己保存的多条自定义配置，Key 保持 DPAPI 字符串，不回传页面。 */
    voiceProfiles: normalizeVoiceProfiles(state.settings.voiceProfiles, state.settings.voiceModel),
    voiceProfile: activeVoiceProfileId(state.settings),
    /** 只读投影：当前这一条，聊天和试听都读这个 */
    voiceModel: normalizeVoiceProfiles(state.settings.voiceProfiles, state.settings.voiceModel)[activeVoiceProfileId(state.settings)]?.config || normalizeVoiceModelConfig(null),
  });

  const setGlobalSettings = (patch) => {
    state.settings = { ...state.settings, ...(patch ?? {}) };
    save();
    return getGlobalSettings();
  };

  const DEFAULT_PARTNER_SETTINGS = {
    /** off | rare | sometimes | often | clingy */
    tier: "sometimes",
    /** 这位伙伴单独用哪个模型；null = 跟全局（全局也没设就跟着宿主当前模型） */
    model: null,
    /** 识图模型；不设就跟全局，只有测试通过才放行图片 */
    vision: null,
    /** ta 会不会主动来找她。她显式设过就听她的；没设过时看她是不是住过这间屋子的老伙伴（见 residentDefault）。 */
    /** ta自己写的那句动作文案（只读给她看，她改不了）：{text, voice, updatedAt, nextAt} */
    action: {},
    /** 旧字段：九格 / 更早的单格，留着兼容老数据 */
    actions: {},
    pokeTemplate: "",
    pokeTemplateUpdatedAt: null,
    /** ta自己的作息（"我在睡"的时间段），按ta自己的性子定，不上设置页；没定过就是 null */
    sleep: null,
    /** 这一觉里被她弄醒了几回（拿"哪一觉"配 wakeNight）；脾气一次比一次大 */
    wakeNight: null,
    wakeCount: 0,
    /** 最近一次困着状态已经在哪条主动回访里接住：{ sourceId, consumedAt } */
    wakeEcho: null,
    /** 生来那份爱好上次试过是什么时候（失败重试的节流用） */
    hobbySeedTryAt: null,
    /** 性格初稿上次试过是什么时候（同上） */
    personalityDraftAt: null,
    /** 起跑线上次量痕迹是什么时候；量不出痕迹时靠它节流，不然每次开详情都重写一遍 */
    seedMeasuredAt: null,
    /** ta手里有没有手机（ta自己的节奏，跟她打不打开窗口无关）；没记过就是 null */
    phone: null,
    /** 等回音那一层的状态：{ nudges, nextCheckAt, done }；她一回话就清掉 */
    awaiting: null,
    /** 「看到了没接」的当日计数：{ day, count }；一天最多一次 */
    passState: null,
    /** 拾光记日子账本露过没：{ lifeDay, hash }；跨天或内容变了才会重新露 */
    daybook: null,
    /** 伙伴自己选择的状态徽章；用户没有写入口，null 时由真实运行状态兜底 */
    badge: null,
    /** 聊天背景：{file, type, tone, opacity, at}；null = 没设，房间就是现在这份干净样子 */
    background: null,
    /** 每张背景图单独记一份透明度，切图时恢复各自的设置 */
    backgroundOpacity: {},
    /** 伙伴语音：音色和低频档位，默认关闭。 */
    voice: { enabled: false, voiceId: "female-shaonv", voiceByProfile: {}, tier: "sometimes" },
  };

  /**
   * 音色是按档位 id 存的；旧固定档位改名成 custom-* 之后，
   * 老账本里的音色要能跟着搬到新键上，不然会静默落回列表第一个。
   * 只做读取时的归一，不往回写磁盘；新键已有值就不动。
   */
  const normalizeVoiceByProfile = (value) => {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [id, voiceId] of Object.entries(raw)) {
      const key = String(id).trim().slice(0, 40);
      const picked = String(voiceId ?? "").trim().slice(0, 100);
      if (key && picked) out[key] = picked;
    }
    for (const [id, voiceId] of Object.entries(out)) {
      const next = migratedVoiceProfileId(id);
      if (next && !out[next]) out[next] = voiceId;
    }
    return out;
  };

  const getPartnerSettings = (agentId) => {
    const raw = state.pref[agentId] ?? {};
    const merged = {
      ...DEFAULT_PARTNER_SETTINGS,
      ...raw,
    };
    // 存进来的可能是个残缺形状（改过数据、旧版本），统一过一遍再交出去
    return {
      ...merged,
      proactiveEnabled: typeof raw.proactiveEnabled === "boolean" ? raw.proactiveEnabled : residentDefault(agentId),
      model: normalizeModelRef(merged.model),
      vision: normalizeVisionConfig(merged.vision),
      badge: normalizeBadge(merged.badge),
      background: normalizeBackground(merged.background, agentId, dataDir),
      backgroundOpacity: normalizeBackgroundOpacityMap(merged.backgroundOpacity),
      voice: merged.voice && typeof merged.voice === "object"
        ? {
          enabled: merged.voice.enabled === true,
          voiceId: String(merged.voice.voiceId || "female-shaonv"),
          voiceByProfile: normalizeVoiceByProfile(merged.voice.voiceByProfile),
          tier: ["rare", "sometimes", "often"].includes(merged.voice.tier) ? merged.voice.tier : "sometimes",
        }
        : { enabled: false, voiceId: "female-shaonv", voiceByProfile: {}, tier: "sometimes" },
    };
  };

  const setPartnerSettings = (agentId, patch) => {
    state.pref[agentId] = { ...(state.pref[agentId] ?? {}), ...(patch ?? {}) };
    save();
    return getPartnerSettings(agentId);
  };

  /**
   * 今日情境从关到开时用：清掉所有伙伴「今天已经露过」的记账。
   * 她打开开关就是为了让伙伴知道今天的事；不该因为同一天早先露过而当场没反应。
   */
  const clearDaybookMarks = () => {
    for (const agentId of Object.keys(state.pref)) {
      if (!state.pref[agentId]?.daybook) continue;
      state.pref[agentId] = { ...state.pref[agentId], daybook: null };
    }
    save();
  };

  /** 全部伙伴设置一份快照（设置页一次读全）。 */
  const allPartnerSettings = () =>
    Object.fromEntries(Object.keys(state.pref).map((id) => [id, getPartnerSettings(id)]));

  // ── 伙伴清单：移出只隐藏，不动聊天、记忆和设置 ──────────────

  const hiddenPartnerIds = () => [...state.hiddenPartnerIds];

  const isPartnerHidden = (agentId) => state.hiddenPartnerIds.includes(String(agentId ?? "").trim());

  const hidePartner = (agentId) => {
    const id = String(agentId ?? "").trim();
    if (id && !state.hiddenPartnerIds.includes(id)) {
      state.hiddenPartnerIds.push(id);
      save();
    }
    return hiddenPartnerIds();
  };

  const unhidePartner = (agentId) => {
    const id = String(agentId ?? "").trim();
    if (!id || !state.hiddenPartnerIds.includes(id)) return hiddenPartnerIds();
    state.hiddenPartnerIds = state.hiddenPartnerIds.filter((item) => item !== id);
    save();
    return hiddenPartnerIds();
  };

  // ── 伙伴列表顺序：只保存编号，不把 Hana 的伙伴资料复制进茶话会 ──

  const partnerOrder = () => [...state.partnerOrder];

  const setPartnerOrder = (ids) => {
    const next = Array.isArray(ids)
      ? [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))]
      : [];
    state.partnerOrder = next;
    save();
    return partnerOrder();
  };

  // ── 主动那层的运行状态（下次到点、今天说了几条、暂存的想法） ──
  //
  // 存成运行时而不是设置，因为它是机器自己跑出来的账。

  const getProactiveState = (agentId) => ({
    nextDueAt: null,
    lastSentAt: null,
    lastSkippedAt: null,
    sentToday: null,
    exceptionNight: null,
    exceptionCount: 0,
    rhythmCueDay: null,
    staged: [],
    interestLearning: null,
    topicSeeds: null,
    voiceDay: null,
    voiceSentToday: 0,
    lastVoiceAt: null,
    consecutiveVoiceReplies: 0,
    voicePending: false,
    /** 伙伴投喂的账：今天递过几次、上次什么时候、最近递过什么 */
    partnerFeed: null,
    /** 话题温度：每个方向冷到什么程度了（见 lib/topic-mood.js） */
    motifMood: null,
    ...(state.runtime?.partners?.[agentId] ?? {}),
  });

  const setProactiveState = (agentId, patch) => {
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.partners = state.runtime.partners ?? {};
    state.runtime.partners[agentId] = { ...getProactiveState(agentId), ...(patch ?? {}) };
    save();
    return state.runtime.partners[agentId];
  };

  const resetProactiveState = (agentId) => {
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.partners = state.runtime.partners ?? {};
    state.runtime.partners[agentId] = {
      nextDueAt: null,
      lastSentAt: null,
      lastSkippedAt: null,
      sentToday: null,
      exceptionNight: null,
      exceptionCount: 0,
      rhythmCueDay: null,
      staged: [],
      interestLearning: null,
      topicSeeds: null,
      voiceDay: null,
      voiceSentToday: 0,
      lastVoiceAt: null,
      consecutiveVoiceReplies: 0,
      voicePending: false,
      partnerFeed: null,
      motifMood: null,
    };
    save();
    return state.runtime.partners[agentId];
  };

  const getGlobalRuntime = () => ({
    lastAnySentAt: null,
    sentToday: null,
    rhythmCueDay: null,
    ...(state.runtime?.global ?? {}),
  });

  const setGlobalRuntime = (patch) => {
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.global = { ...getGlobalRuntime(), ...(patch ?? {}) };
    save();
    return state.runtime.global;
  };

  /**
   * 待办确认：她说「我做完了」时攒下来的待确认窗。
   * 读的时候顺手收掉过期的——过期只关窗，不碰账本。
   */
  const getTodoProposals = (now = new Date()) => {
    const kept = normalizeProposals(state.runtime?.global?.todoProposals ?? [], now);
    if (kept.length !== (state.runtime?.global?.todoProposals?.length ?? 0)) {
      state.runtime = state.runtime ?? { partners: {}, global: {} };
      state.runtime.global = { ...getGlobalRuntime(), todoProposals: kept };
      save();
    }
    return kept;
  };

  const setTodoProposals = (rows, now = new Date()) => {
    const kept = normalizeProposals(rows, now);
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.global = { ...getGlobalRuntime(), todoProposals: kept };
    save();
    return kept;
  };

  return {
    state,
    save,
    dir,

    // 伙伴来源
    listLocalPartners,
    createLocalPartner,
    importTavernPartner,
    markTavernOpeningSeeded,
    localPartner,
    getLocalPartnerAvatar,

    // Hana 主对话近况（只读来源的茶话会自有副本）
    readWorkfeed,
    writeWorkfeed,
    appendWorkEvent,
    removeWorkEvent,
    clearWorkfeed,

    // 收藏
    listFavorites,
    saveFavorite,
    removeFavorite,
    removeFavoritesByMessage,
    getFavorite,

    /** 取走「读坏的账本被挪到哪儿去了」的记录（诊断用，取完即空）。 */
    takeCorruptLog: () => {
      const rows = corruptLog.slice();
      corruptLog.length = 0;
      return rows;
    },

    /** 取走最近一次「账本读坏已留档」的提示（给界面用，取完即空）。 */
    getCorruptNotice: () => {
      const notice = corruptNotice;
      corruptNotice = null;
      return notice;
    },

    // 聊天记录
    getThread,
    appendMessage,
    patchMessage,
    removeMessage,
    removeAssistantReply,
    removeActionMessage,
    clearThread,
    resetPartnerMemory,
    purgePartner,
    pendingMessages,
    markRolledThrough,

    // 未读
    unreadCount,
    markRead,
    markUserMessagesRead,

    // 回复排期
    getPendingReply,
    setPendingReply,
    clearPendingReply,
    clearPendingReplyIf,

    // 远处记忆
    readMemory,
    writeMemory,
    setProfile,
    quarantineProfile,
    upsertLedger,
    removeLedger,
    appendArchive,
    appendFacts,
    removeFactsBySource,

    // 话题本
    getTopicBook,
    saveTopicBook,

    // 自省小本子（内部，用户看不见）
    getSelfWatch,
    saveSelfWatch,

    // 茶话会里多加的那层
    getKnowing,
    saveKnowing,
    getUserAdaptation,
    saveUserAdaptation,
    getPartnerAdaptation,
    savePartnerAdaptation,
    updatePartnerAdaptation,
    commitException,
    finalizeException,
    revokePartnerGuidesBySource,
    revokeUserGuidesBySource,
    repairPendingUserAdaptationInvalidations,
    getPaletteDraft,
    savePaletteDraft,
    clearPaletteDraft,
    getReviewSession,
    saveReviewSession,
    clearReviewSession,
    getCoCreateSession,
    saveCoCreateSession,
    clearCoCreateSession,

    // 设置
    getGlobalSettings,
    setGlobalSettings,
    getPartnerSettings,
    setPartnerSettings,
    clearDaybookMarks,
    allPartnerSettings,
    hiddenPartnerIds,
    isPartnerHidden,
    hidePartner,
    unhidePartner,
    partnerOrder,
    setPartnerOrder,
    /** 兼容旧调用名（早期叫 pref） */
    getPref: getPartnerSettings,
    setPref: setPartnerSettings,

    // 主动那层的运行状态
    getProactiveState,
    setProactiveState,
    resetProactiveState,
    getGlobalRuntime,
    setGlobalRuntime,
    getTodoProposals,
    setTodoProposals,

    /** 人格快照只用于缓存展示，过期就重读 */
    setPersonaCache(agentId, persona) {
      state.personaCache[agentId] = {
        readAt: persona.readAt,
        files: persona.files,
        errors: persona.errors,
      };
      save();
    },
    getPersonaCache(agentId) {
      return state.personaCache[agentId] ?? null;
    },
    setLastPartner(agentId) {
      if (state.lastPartnerId === agentId) return;
      state.lastPartnerId = agentId;
      save();
    },
    getLastPartner() {
      return state.lastPartnerId;
    },

    /** 提醒那层：手动关过的时间点。只认手动关，自动淡走不写这里。 */
    setBannerAck(at) {
      state.bannerAckAt = at ?? null;
      save();
    },
    getBannerAck() {
      return state.bannerAckAt;
    },
  };
}

/** 会带用户原文的字段：统一削掉，只留长度（查问题时看事件名和长度就够了）。 */
const DIAG_TEXT_KEYS = ["tail", "raw", "rawHead", "head", "text", "snippet", "preview"];
/** 日志上限：超过就轮掉一半（不然长期跑下来会无限长）。 */
const DIAG_MAX_BYTES = 2 * 1024 * 1024;

function rotateDiagnostics(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
    keep.push(JSON.stringify({ at: new Date().toISOString(), event: "diagnostics.rotated" }));
    fs.writeFileSync(file, `${keep.join("\n")}\n`, "utf8");
    return fs.statSync(file).size;
  } catch {
    /* 轮转失败就继续追加，不能因为日志把主流程带崩 */
    return null;
  }
}

/** 追加一行诊断日志（查问题时用，不进对话）。 */
export function createDiagnostics(dataDir) {
  const file = path.join(dataDir, "v2", "diagnostics.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let written = 0;
  try {
    written = fs.statSync(file).size;
  } catch {
    written = 0;
  }
  return (event) => {
    try {
      const row = { at: new Date().toISOString(), ...event };
      for (const key of DIAG_TEXT_KEYS) {
        if (typeof row[key] === "string") {
          row[`${key}Chars`] = row[key].length;
          delete row[key];
        }
      }
      // 用户名也不落盘：诊断是查问题用的，不需要知道谁是谁。
      if (typeof row.name === "string") {
        row.nameChars = row.name.length;
        delete row.name;
      }
      const line = JSON.stringify(row);
      fs.appendFileSync(file, `${line}\n`, "utf8");
      written += Buffer.byteLength(line) + 1;
      if (written > DIAG_MAX_BYTES) {
        written = rotateDiagnostics(file) ?? written;
      }
    } catch {
      /* 诊断日志失败不影响主流程 */
    }
  };
}
