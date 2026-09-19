import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GLOBAL_GATE, normalizeGateMax } from "./proactive.js";
import { normalizeModelRef } from "./model.js";
import { normalizeRelationship, normalizeSeed } from "./relationship.js";
import { readBook } from "./topics.js";
import { readWatch } from "./selfwatch.js";
import { normalizeHobbies, normalizePersonality } from "./knowing.js";
import { normalizePalette } from "./palette.js";
import { normalizeRecognition } from "./recognition.js";
import { normalizeBackground, normalizeBackgroundOpacityMap } from "./background.js";
import { normalizeVisionConfig } from "./vision.js";
import { factKey, normalizeFacts } from "./facts.js";

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

/** 「账本读坏了、已挪到哪里去」的记录（诊断用；取走就清空）。 */
const corruptLog = [];
/** 最近一次「账本读坏已留档」的轻量提示（给界面用，取走即空）。跟 corruptLog 分开：那个走诊断，这个给用户看。 */
let corruptNotice = null;

/** 把读坏的文件挪到旁边留档，绝不让下一次写静默覆掉它。 */
function quarantineCorrupt(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, dest);
    corruptLog.push({ file, dest, at: new Date().toISOString() });
    corruptNotice = { file: path.basename(file), at: new Date().toISOString() };
    return dest;
  } catch {
    corruptLog.push({ file, dest: null, at: new Date().toISOString() });
    corruptNotice = { file: path.basename(file), at: new Date().toISOString() };
    return null;
  }
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // 文件不存在是正常的（第一次跑）；读不了（权限之类）也当没有，且绝不动文件。
    return fallback;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : fallback;
  } catch {
    // 文件在，但内容坏了。这里以前是默默返回空、下一次写就把它覆成了空账，
    // 损坏之后不可逆。现在先把坏的挪一份出来留档，再让程序照常往前走。
    quarantineCorrupt(file);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 临时名带 pid + 时间 + 随机：两次写碰巧撞上也不会互相踩。
  const tmp = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // 写不成时把临时件收掉，原文件原样不动（宁可这次失败，也不留半截账）。
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，别把原文件搞坏 */ }
    throw error;
  }
}

// 拼进文件名/目录名之前先削干净：`.` 也拿掉（保留它的话 `..` 能爬到上一层去）。
const safeId = (agentId) => String(agentId ?? "").replace(/[^\w-]/g, "_").slice(0, 64) || "_";

export function createStore(dataDir) {
  // 新账本起手不留上一条的损坏提示（模块级变量，多个实例时别互相串）
  corruptNotice = null;
  const dir = path.join(dataDir, "v2");
  const stateFile = path.join(dir, "state.json");
  const workfeedFile = path.join(dir, "workfeed.json");
  const threadsDir = path.join(dir, "threads");
  const partnersDir = path.join(dir, "partners");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.mkdirSync(partnersDir, { recursive: true });

  let state = readJson(stateFile, {});
  state = {
    schemaVersion: SCHEMA_VERSION,
    partners: state.partners ?? {},
    /** 只存在茶话会里的本地角色，不读写 Hana 的 agents 目录 */
    localPartners: state.localPartners ?? {},
    pref: state.pref ?? {},
    settings: state.settings ?? {},
    hiddenPartnerIds: Array.isArray(state.hiddenPartnerIds)
      ? [...new Set(state.hiddenPartnerIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
      : [],
    lastPartnerId: state.lastPartnerId ?? null,
    personaCache: state.personaCache ?? {},
    /** 她最后一次手动关掉提醒横幅的时间（"只认手动关"靠它翻篇） */
    bannerAckAt: state.bannerAckAt ?? null,
    /**
     * 主动那层的运行状态：下次到点、今天说过几条、暂存着还没说的话。
     * 它是机器自己跑出来的账，但必须跟设置一起过夜——漏在重建清单外面的话，
     * 每次进程重启第一次存盘就会把它整个抹掉：到点时间被重掷、想找她的话被丢、
     * 当日计数归零。这一格是修那个漏的。
     */
    runtime: {
      partners: state.runtime?.partners ?? {},
      global: state.runtime?.global ?? {},
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

  /** 把收集到的生活记录清空（她自己按的，不是自动清理）。 */
  const clearWorkfeed = () => writeWorkfeed({ events: [] });

  const listLocalPartners = () => Object.values(state.localPartners)
    .filter((row) => row && row.id && row.name)
    .map((row) => ({ ...row, isLocal: true }));

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

  const localPartner = (agentId) => state.localPartners[String(agentId ?? "")] ?? null;
  const threadFile = (agentId) => path.join(threadsDir, `${safeId(agentId)}.json`);
  const memoryFile = (agentId) => path.join(partnersDir, safeId(agentId), "memory.json");

  // ── 聊天记录 ───────────────────────────────────────────────

  const readThread = (agentId) => {
    const raw = readJson(threadFile(agentId), {});
    const source = Array.isArray(raw.messages) ? raw.messages : [];
    let nextSeq = Number(raw.nextSeq) > 0 ? Number(raw.nextSeq) : 1;
    const messages = source.map((row, index) => {
      const seq = Number(row?.seq) > 0 ? Number(row.seq) : index + 1;
      nextSeq = Math.max(nextSeq, seq + 1);
      return { ...row, seq };
    });
    const rolledThroughSeq = Number(raw.rolledThroughSeq) > 0 ? Number(raw.rolledThroughSeq) : null;
    return {
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
  };

  const writeThread = (agentId, thread) => {
    writeJson(threadFile(agentId), { ...thread, agentId, updatedAt: new Date().toISOString() });
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
  const unreadCount = (agentId) => {
    const thread = readThread(agentId);
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
  const markUserMessagesRead = (agentId, at = new Date().toISOString()) => {
    const thread = readThread(agentId);
    let touched = 0;
    for (const row of thread.messages) {
      if (row?.role !== "user" || row.recalled || row.readAt) continue;
      row.readAt = at;
      touched += 1;
    }
    if (touched > 0) writeThread(agentId, thread);
    return touched;
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

  // ── 茶话会里多加的那层：关系账 + 性格 + 爱好 ────────────────
  //
  // 设计借自一个已经停用的自家实验项目，但账只在茶话会自己这一本里，一个字都不外流。

  const knowingFile = (agentId) => path.join(partnersDir, safeId(agentId), "knowing.json");

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

  const draftFile = (agentId) => path.join(partnersDir, safeId(agentId), "palette-draft.json");

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

  const reviewFile = (agentId) => path.join(partnersDir, safeId(agentId), "review-session.json");

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

  // ── 自省小本子（内部：为何没开口，用户看不见也不进聊天） ──

  const watchFile = (agentId) => path.join(partnersDir, safeId(agentId), "selfwatch.json");

  const getSelfWatch = (agentId) => readWatch(readJson(watchFile(agentId), {}));

  const saveSelfWatch = (agentId, watch) => {
    const clean = readWatch(watch);
    writeJson(watchFile(agentId), clean);
    return clean;
  };

  // ── 话题本（ta搁着的、以后可以接回来聊的事） ─────────────

  const topicFile = (agentId) => path.join(partnersDir, safeId(agentId), "topics.json");

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
     * 拾光记的日子账本要不要接进提示词。
     * 只在自己装了拾光记、她又手动打开时才生效；默认关，不硬塞。
     */
    daybookEnabled: state.settings.daybookEnabled ?? false,
    /**
     * 电脑端生活联动：把 Hana 各会话里发生的事收进茶话会自己的账本，再当闲聊背景用。
     * 默认开（这是茶话会的一半），但用户可以关掉——关掉后不再收集，已经收的也不再用；
     * 想清掉已经收的走 POST /workfeed/clear。
     */
    workfeedEnabled: state.settings.workfeedEnabled !== false,
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
    proactiveEnabled: true,
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
    /** 聊天背景：{file, type, tone, opacity, at}；null = 没设，房间就是现在这份干净样子 */
    background: null,
    /** 每张背景图单独记一份透明度，切图时恢复各自的设置 */
    backgroundOpacity: {},
  };

  const getPartnerSettings = (agentId) => {
    const merged = {
      ...DEFAULT_PARTNER_SETTINGS,
      ...(state.pref[agentId] ?? {}),
    };
    // 存进来的可能是个残缺形状（改过数据、旧版本），统一过一遍再交出去
    return {
      ...merged,
      model: normalizeModelRef(merged.model),
      vision: normalizeVisionConfig(merged.vision),
      background: normalizeBackground(merged.background, agentId, dataDir),
      backgroundOpacity: normalizeBackgroundOpacityMap(merged.backgroundOpacity),
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
    staged: [],
    ...(state.runtime?.partners?.[agentId] ?? {}),
  });

  const setProactiveState = (agentId, patch) => {
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.partners = state.runtime.partners ?? {};
    state.runtime.partners[agentId] = { ...getProactiveState(agentId), ...(patch ?? {}) };
    save();
    return state.runtime.partners[agentId];
  };

  const getGlobalRuntime = () => ({
    lastAnySentAt: null,
    sentToday: null,
    ...(state.runtime?.global ?? {}),
  });

  const setGlobalRuntime = (patch) => {
    state.runtime = state.runtime ?? { partners: {}, global: {} };
    state.runtime.global = { ...getGlobalRuntime(), ...(patch ?? {}) };
    save();
    return state.runtime.global;
  };

  return {
    state,
    save,
    dir,

    // 伙伴来源
    listLocalPartners,
    createLocalPartner,
    localPartner,

    // 电脑端生活联动（只读来源的茶话会自有副本）
    readWorkfeed,
    writeWorkfeed,
    appendWorkEvent,
    clearWorkfeed,

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
    clearThread,
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

    // 话题本
    getTopicBook,
    saveTopicBook,

    // 自省小本子（内部，用户看不见）
    getSelfWatch,
    saveSelfWatch,

    // 茶话会里多加的那层
    getKnowing,
    saveKnowing,
    getPaletteDraft,
    savePaletteDraft,
    clearPaletteDraft,
    getReviewSession,
    saveReviewSession,
    clearReviewSession,

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
    /** 兼容旧调用名（早期叫 pref） */
    getPref: getPartnerSettings,
    setPref: setPartnerSettings,

    // 主动那层的运行状态
    getProactiveState,
    setProactiveState,
    getGlobalRuntime,
    setGlobalRuntime,

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
  } catch {
    /* 轮转失败就继续追加，不能因为日志把主流程带崩 */
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
        rotateDiagnostics(file);
        written = 0;
      }
    } catch {
      /* 诊断日志失败不影响主流程 */
    }
  };
}
