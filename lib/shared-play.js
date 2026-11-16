/**
 * 共享小玩法（你们俩私下玩的那点东西）。
 *
 * 模型在同一轮回复里顺手输出一个隐藏标记 `<shared-play>{"updates":[...]}</shared-play>`，
 * 应用把里面那些「只有你们俩才懂的点」记下来：她说的那句、他接的那句、还有那张图。
 * 往后聊到同一件事，伙伴能自然把那张图再甩出来——不用她先说「这是梗」。
 *
 * 这里全是纯逻辑：不存盘、不找图、不做语义分类、不复制图片。
 * 记在哪儿、怎么落盘，由主会话那一头接。
 *
 * 几条不能破的线：
 * · 猜的只是猜的（state:"guess"），写进提示词时要标出来，不能当既成事实。
 * · 她不接的（state:"stopped"）与改过的（corrected）优先服从，别再拿旧说法去接。
 * · 证据必须是材料里真实存在、没被撤回的原话；模型自己编的引语不算。
 * · 时间和版本一律程序生成，不信模型传来的。
 */

import crypto from "node:crypto";
import { rankByOverlap } from "./longterm.js";

/** 隐藏标记的名字（正文里出现就要剥掉，不许漏进聊天）。 */
export const SHARED_PLAY_TAG = "shared-play";

/** 一共最多记这么多条；满了不新增，也绝不因为满了就删掉纠正或停止的记录。 */
export const SHARED_PLAY_MAX_ENTRIES = 120;

/** 单条的上限。 */
export const SHARED_PLAY_MAX_TITLE = 64;
export const SHARED_PLAY_MAX_MEANING = 400;
export const SHARED_PLAY_MAX_IMAGES = 6;
export const SHARED_PLAY_MAX_SOURCES = 64;
export const SHARED_PLAY_MAX_EVIDENCE = 6;

/** 一轮最多几项更新。 */
export const SHARED_PLAY_MAX_UPDATES = 3;

/** 提示词里最多摆几条玩法。 */
export const SHARED_PLAY_PROMPT_LIMIT = 8;

const IMAGE_ID_RE = /^img_[A-Za-z0-9_-]{1,120}$/;
const STATES = new Set(["guess", "familiar", "stopped"]);
const OPS = new Set(["learn", "revise", "reinforce", "stop"]);

/** 去控制字符并截断。 */
function text(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, "").trim().slice(0, max);
}

/** 字符串数组：去空、去重、限量。 */
function stringList(value, max, each = (item) => text(item, 64)) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const one = each(item);
    if (!one || out.includes(one)) continue;
    out.push(one);
    if (out.length >= max) break;
  }
  return out;
}

/** 稳定的短哈希：同样的来源与图片永远得到同一个 id。 */
function shortHash(...parts) {
  const joined = parts.map((part) => String(part ?? "")).filter(Boolean).join("|");
  return crypto.createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

/** 成对图条的稳定 id：两张图的编号一换，算出来就不一样。 */
export function sharedPlayPairId(userImageId, partnerImageId) {
  return `pair_${shortHash(String(userImageId ?? ""), String(partnerImageId ?? ""))}`;
}

/** 一条玩法的规范化形状。脏数据进来也能读成能用的样子。 */
export function normalizeSharedPlay(rows) {
  const input = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const id = text(raw.id, 160);
    if (!id) continue;
    const entry = {
      id,
      title: text(raw.title, SHARED_PLAY_MAX_TITLE),
      meaning: text(raw.meaning, SHARED_PLAY_MAX_MEANING),
      imageIds: stringList(raw.imageIds, SHARED_PLAY_MAX_IMAGES, (item) => {
        const value = String(item ?? "");
        return IMAGE_ID_RE.test(value) ? value : "";
      }),
      sourceIds: stringList(raw.sourceIds, SHARED_PLAY_MAX_SOURCES),
      state: STATES.has(raw.state) ? raw.state : "guess",
      revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
      corrected: raw.corrected === true,
      updatedAt: text(raw.updatedAt, 40),
      seenSourceIds: stringList(raw.seenSourceIds, SHARED_PLAY_MAX_SOURCES),
      resultMessageIds: stringList(raw.resultMessageIds, SHARED_PLAY_MAX_SOURCES),
    };
    const pair = raw.pair;
    if (pair && typeof pair === "object"
      && IMAGE_ID_RE.test(String(pair.userImageId ?? ""))
      && IMAGE_ID_RE.test(String(pair.partnerImageId ?? ""))) {
      entry.pair = { userImageId: String(pair.userImageId), partnerImageId: String(pair.partnerImageId) };
    }
    // 画里谁是谁：只认配对数据给的，别拿发送者推。
    const roles = raw.roles && typeof raw.roles === "object" ? raw.roles : null;
    if (roles) {
      const picked = {};
      for (const [imageId, value] of Object.entries(roles)) {
        if (!IMAGE_ID_RE.test(String(imageId))) continue;
        if (value !== "user" && value !== "partner") continue;
        picked[String(imageId)] = value;
      }
      if (Object.keys(picked).length) entry.roles = picked;
    }
    // legacy 只是「这条是从配对投影出来的」的标识，长期留着有用；
    // dirty 是这一轮改过的临时标记，不进长期账本。
    if (raw.legacy === true) entry.legacy = true;
    out.push(entry);
  }
  out.sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
  const kept = out.slice(0, SHARED_PLAY_MAX_ENTRIES);
  // 纠正过或停掉的记录不因为上限被悄悄删掉。
  for (const entry of out.slice(SHARED_PLAY_MAX_ENTRIES)) {
    if (entry.corrected || entry.state === "stopped") kept.push(entry);
  }
  return kept;
}

/**
 * 一对图在书里的样子（老式条目：由配对投影出来的）。
 *
 * 配对的形状是定死的：{name, meaning, userImageId, partnerImageId, at}。
 * userImageId 是画里她那一张，partnerImageId 是画里伙伴那一张——
 * 这跟谁发出来没关系，别拿发送者推角色。
 */
function pairEntry(pair) {
  if (!pair || typeof pair !== "object") return null;
  const userImageId = String(pair.userImageId ?? "");
  const partnerImageId = String(pair.partnerImageId ?? "");
  if (!IMAGE_ID_RE.test(userImageId) || !IMAGE_ID_RE.test(partnerImageId)) return null;
  const at = Number(pair.at);
  const updatedAt = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : "";
  return {
    id: sharedPlayPairId(userImageId, partnerImageId),
    title: text(pair.name, SHARED_PLAY_MAX_TITLE),
    meaning: text(pair.meaning, SHARED_PLAY_MAX_MEANING),
    imageIds: [userImageId, partnerImageId],
    sourceIds: [],
    state: "familiar",
    revision: 0,
    corrected: false,
    updatedAt,
    seenSourceIds: [],
    resultMessageIds: [],
    pair: { userImageId, partnerImageId },
    roles: { [userImageId]: "user", [partnerImageId]: "partner" },
    legacy: true,
  };
}

/**
 * 合成书：保存过的条目 + 配对投影出来的老式条目。
 *
 * 保存过的同 id 胜出；保存过的纠正或停止若与某个配对的图重叠，
 * 那个配对就压住不再露出——免得两套说法打架。
 */
export function sharedPlayBook(saved, pairs = []) {
  const rows = normalizeSharedPlay(saved);
  const guardedImages = new Set();
  for (const row of rows) {
    if (!row.corrected && row.state !== "stopped") continue;
    for (const imageId of row.imageIds) guardedImages.add(imageId);
  }
  const book = new Map();
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const entry = pairEntry(pair);
    if (!entry) continue;
    if (entry.imageIds.some((imageId) => guardedImages.has(imageId))) continue;
    book.set(entry.id, entry);
  }
  for (const row of rows) book.set(row.id, row);
  return [...book.values()];
}

/** 材料里真实存在的消息（没撤回、是她或他的、带正文）。 */
function materialIndex(materials) {
  const map = new Map();
  for (const row of Array.isArray(materials) ? materials : []) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? "");
    const role = String(row.role ?? "");
    if (!id || (role !== "user" && role !== "assistant")) continue;
    if (row.recalled) continue;
    const body = String(row.text ?? "");
    if (!body.trim()) continue;
    map.set(id, {
      id,
      role,
      text: body,
      attachmentId: row.attachment?.id ? String(row.attachment.id) : "",
      attachmentDescription: text(row.attachment?.description ?? "", 60),
    });
  }
  return map;
}

/** 她最新那条消息的 id：每项更新都得有它的证据。 */
function latestUserMessageId(materials) {
  let latest = "";
  for (const row of Array.isArray(materials) ? materials : []) {
    if (!row || row.recalled) continue;
    if (String(row.role ?? "") !== "user") continue;
    if (!String(row.text ?? "").trim()) continue;
    latest = String(row.id ?? "");
  }
  return latest;
}

/** 她最后发的那张图：最相关的那张。 */
function latestUserImageId(materials) {
  let latest = "";
  for (const row of Array.isArray(materials) ? materials : []) {
    if (!row || row.recalled) continue;
    if (String(row.role ?? "") !== "user") continue;
    const imageId = row.attachment?.id ? String(row.attachment.id) : "";
    if (imageId) latest = imageId;
  }
  return latest;
}

/** 画里是谁：只认配对给的，别拿发送者推。 */
function roleText(entry, imageId) {
  const who = entry.roles?.[imageId];
  if (who === "user") return "画里是她";
  if (who === "partner") return "画里是伙伴";
  return "画里是谁不确定";
}

/**
 * 给模型看的玩法清单。
 *
 * learn=true 时附上材料原话与更新格式：不等她说「这是梗」，你可以自己判断着学；
 * 猜错了能改（revise）也能停（stop）。她没接话不算她不认。
 * 书里还没有东西时也不拦着：照样给材料与协议，让它第一次就能学。
 */
export function sharedPlayPrompt(book, materials = [], { learn = true } = {}) {
  const rows = normalizeSharedPlay(book);
  if (!rows.length && !learn) return "";
  const recentImages = new Set();
  const recentTexts = [];
  for (const row of Array.isArray(materials) ? materials : []) {
    if (!row || row.recalled) continue;
    const imageId = row.attachment?.id ? String(row.attachment.id) : "";
    if (imageId) recentImages.add(imageId);
    const body = String(row.text ?? "").trim();
    if (body) recentTexts.push(body);
  }
  const latestImage = latestUserImageId(materials);
  const related = new Map(rankByOverlap(recentTexts.slice(-3).join("\n"), rows, { getText: (row) => `${row.title} ${row.meaning}` })
    .map(({ row, score }) => [row.id, Math.min(4, score / 3)]));
  const scored = rows.map((row) => {
    let score = related.get(row.id) ?? 0;
    if (latestImage && row.imageIds.includes(latestImage)) score += 6;
    else if (row.imageIds.some((imageId) => recentImages.has(imageId))) score += 3;
    if (row.title && recentTexts.some((body) => body.includes(row.title))) score += 2;
    return { row, score };
  });
  scored.sort((a, b) => b.score - a.score
    || (Date.parse(b.row.updatedAt || "") || 0) - (Date.parse(a.row.updatedAt || "") || 0));
  const picked = scored.slice(0, SHARED_PLAY_PROMPT_LIMIT).map((item) => item.row);

  const lines = ["【你们之间的共享小玩法】这是你与她私下的小默契；目前没有记录也可以从这轮互动里自己发现。",
    "这本的最新玩法、画中身份与停用决定优先于旧摘要、旧配对或旧猜测。她纠正或叫停共同玩法就 revise/stop，不套用长期事实记忆的 hold/doubt；别把你猜的写成双方确认过的经历。"];
  if (picked.length) {
    for (const row of picked) {
      if (row.state === "stopped") {
        // 停掉的也留着标题与意思：模型得知道禁的是哪一句，才不会换个说法又提。
        lines.push(`· [${row.id}] rev${row.revision} 这条已经停了：别再主动提，也别拿它接话。${row.title ? `「${row.title}」` : ""}${row.meaning ? `——${row.meaning}` : ""}`);
        lines.push("  只有她明确说要恢复的时候，才用 revise 把它改回来（给新的意思与新的证据）。");
        continue;
      }
      const tag = row.corrected ? "（已经改过，按改后的来）" : row.state === "guess" ? "（你自己猜的，还没确认）" : "（你们一起玩过了）";
      const images = row.imageIds.length
        ? `相关图：${row.imageIds.map((imageId) => `${imageId}（${roleText(row, imageId)}）`).join("、")}`
        : "没有图，是纯文字的那点意思";
      const meaning = row.meaning ? `；${row.state === "guess" ? "你猜的玩法" : "目前记着的玩法"}：${row.meaning}` : "";
      lines.push(`· [${row.id}] rev${row.revision} ${tag}${row.title ? `「${row.title}」` : ""}${meaning}`);
      lines.push(`  ${images}`);
      if (row.pair) {
        lines.push(`  这一对是成对的：${row.pair.userImageId}（画里是她）与 ${row.pair.partnerImageId}（画里是伙伴）。她发哪张你都接得住，接梗时把另一张甩出来就行，重发用隐藏标记 [旧图:{"id":"img_...","as":"sticker"}]。`);
      }
    }
  }
  if (rows.some((row) => row.state !== "stopped")) lines.push("这些玩法可以在普通聊天里接，也可以在合适的主动聊天里先抛一句或一张，等她来接；她接歪了可以顺势逗一下。猜测也能先试，不用等确认。不要每次都玩，也不逼她接、不因没回应就反复追问。相关原图用 [旧图:{\"id\":\"img_...\",\"as\":\"sticker\"}] 直接复用，不重新生图。");
  if (!learn) return lines.join("\n");

  const index = materialIndex(materials);
  const quoted = [...index.values()].slice(-12);
  if (quoted.length) {
    lines.push("【这一轮能参考的原话】下面逐字给你，括号里是消息 id，后面是那轮的附件编号与它原本的描述：");
    for (const row of quoted) {
      const who = row.role === "user" ? "她" : "你";
      const attachment = row.attachmentId ? `｜附件 ${row.attachmentId}` : "";
      const description = row.attachmentDescription ? `｜图：${row.attachmentDescription}` : "";
      lines.push(`- ${row.id}（${who}）：「${row.text.slice(0, 160)}」${attachment}${description}`);
    }
  }
  lines.push(
    "你可以自己判断着学这些：她的话里有个只有你们俩懂的点，不用等她说「这是梗」才动手，第一次觉得像就可以试着接一下、也允许记下来。猜错了就 revise 或 stop，别硬撑。你自己的独白、她的沉默都不算她认了这个点。",
    "她没接话、换了话题，都不算她不认这个点：别因此改口、也别因此就停掉它；已经改过的按改后的来，别再拿旧说法接。",
    "不写固定台词、不逼她接话：她不接就换个话题，别同一个点连着提。普通信息不必硬编成梗；有共同的画面、双关、对应关系或接续玩法时就能先猜。只有她确实跟着同一个点玩才 reinforce；一般寒暄不算。没新理解不输出更新，每项意思一两句、引语只截必要的短句。",
    "图只是附件编号：她发来的那张可能画的是她的OC，也可能是伙伴的OC——发送者不等于画里的人，角色不知道就别猜。",
    "要记的时候在正文末尾追加且只追加一个隐藏标记：<shared-play>{\"updates\":[...]}</shared-play>，一轮最多 3 项。",
    'learn：{"op":"learn","title":"短标题","meaning":"你们共同的意思","imageIds":["img_..."],"evidence":[{"sourceId":"消息id","quote":"逐字原话"}]}',
    'revise：{"op":"revise","id":"play_...","revision":2,"title":"短标题","meaning":"改过的意思","imageIds":["img_..."],"evidence":[{"sourceId":"消息id","quote":"逐字原话"}]}',
    'reinforce：{"op":"reinforce","id":"play_...","revision":2,"evidence":[{"sourceId":"消息id","quote":"逐字原话"}]}',
    'stop：{"op":"stop","id":"play_...","revision":2,"evidence":[{"sourceId":"消息id","quote":"逐字原话"}]}',
    "每项都得有至少一条来自她最新那条消息的证据；quote 必须是她原话里逐字有的。图只能用附件编号 img_...；没有图也行，那是纯文字的点。",
  );
  return lines.join("\n");
}

/**
 * 把正文里的标记剥下来，顺带把里面的更新校验一遍。
 *
 * 标记坏了（JSON 坏了、字段不对、证据是编的）就只剥不写：
 * 宁可这轮什么都不记，也不能让内部 JSON 漏进聊天。
 */
export function extractSharedPlay(raw, book, materials, allowedImageIds = []) {
  const { text: stripped, payloads } = splitSharedPlay(raw);
  const updates = [];
  if (!payloads.length) return { text: stripped, updates };
  const rows = normalizeSharedPlay(book);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const index = materialIndex(materials);
  const latestUserId = latestUserMessageId(materials);
  const allowed = new Set((Array.isArray(allowedImageIds) ? allowedImageIds : []).map(String));
  for (const payload of payloads) {
    let parsed = null;
    try { parsed = JSON.parse(payload); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.updates)) continue;
    for (const item of parsed.updates) {
      const update = verifyUpdate(item, { byId, index, latestUserId, allowed });
      if (update) updates.push(update);
      if (updates.length >= SHARED_PLAY_MAX_UPDATES) break;
    }
    if (updates.length >= SHARED_PLAY_MAX_UPDATES) break;
  }
  return { text: stripped, updates };
}

/** 剥标记：完整的、坏的、半截的，都不许漏进聊天。 */
export function splitSharedPlay(raw) {
  const source = String(raw ?? "");
  const payloads = [];
  const blockRe = /<\s*shared-play\s*>([\s\S]*?)<\s*\/\s*shared-play\s*>/giu;
  let stripped = source.replace(blockRe, (_, body) => {
    payloads.push(String(body ?? ""));
    return "";
  });
  // 半截标记：后面的内容全丢，不能把 JSON 漏进聊天。
  const half = stripped.search(/<\s*shared-play\b/iu);
  if (half >= 0) stripped = stripped.slice(0, half);
  stripped = stripped.replace(/<\s*\/\s*shared-play\b[^>]*(?:>|$)/giu, "");
  return { text: stripped.trim(), payloads };
}

/** 校验一条更新；不合格就当没有。 */
function verifyUpdate(item, { byId, index, latestUserId, allowed }) {
  if (!item || typeof item !== "object") return null;
  const op = String(item.op ?? "");
  if (!OPS.has(op)) return null;

  const evidence = [];
  for (const raw of Array.isArray(item.evidence) ? item.evidence : []) {
    if (!raw || typeof raw !== "object") continue;
    const sourceId = String(raw.sourceId ?? "");
    const quote = String(raw.quote ?? "");
    const message = index.get(sourceId);
    if (!message) continue;                       // 材料里没有这条消息：编的
    if (!quote.trim()) continue;                  // 没有引语
    if (!message.text.includes(quote)) continue;  // 不是逐字原话
    evidence.push({ sourceId, quote, role: message.role });
    if (evidence.length >= SHARED_PLAY_MAX_EVIDENCE) break;
  }
  if (!evidence.length) return null;
  // 每项都得有她最新那条消息的证据：不能靠伙伴自己说的话立一条玩法。
  if (!latestUserId || !evidence.some((row) => row.sourceId === latestUserId)) return null;

  if (op === "learn") {
    const title = text(item.title, SHARED_PLAY_MAX_TITLE);
    if (!title) return null;
    const meaning = text(item.meaning, SHARED_PLAY_MAX_MEANING);
    const imageIds = [];
    for (const raw of Array.isArray(item.imageIds) ? item.imageIds : []) {
      const imageId = String(raw ?? "");
      if (!IMAGE_ID_RE.test(imageId)) return null;   // 不合法的编号：整条不收
      if (!allowed.has(imageId)) return null;         // 不是这位伙伴现在能用的图：整条不收
      if (imageIds.includes(imageId)) continue;
      imageIds.push(imageId);
      if (imageIds.length > SHARED_PLAY_MAX_IMAGES) return null;
    }
    const sourceIds = evidence.map((row) => row.sourceId);
    const id = `play_${shortHash(sourceIds.join(","), imageIds.join(","))}`;
    // 不许借 learn 顶掉或复活已有的条目：同 id、同标题、同来源、同图都不行。
    for (const row of byId.values()) {
      if (row.id === id) return null;
      if (row.title && row.title === title) return null;
      if (row.sourceIds.some((sourceId) => sourceIds.includes(sourceId))) return null;
      if (row.imageIds.some((imageId) => imageIds.includes(imageId))) return null;
    }
    return { op, id, title, meaning, imageIds, evidence };
  }

  const id = String(item.id ?? "");
  const target = byId.get(id);
  if (!target) return null;
  const revision = Math.floor(Number(item.revision));
  if (!Number.isFinite(revision) || revision !== target.revision) return null;
  // 停掉的只能靠 revise 明确恢复：reinforce 与 stop 都不许再动它。
  if (target.state === "stopped" && op !== "revise") return null;

  const update = { op, id, revision, evidence };
  if (op === "revise") {
    const title = text(item.title, SHARED_PLAY_MAX_TITLE);
    if (!title) return null;
    const meaning = text(item.meaning, SHARED_PLAY_MAX_MEANING);
    const imageIds = [];
    for (const raw of Array.isArray(item.imageIds) ? item.imageIds : []) {
      const imageId = String(raw ?? "");
      if (!IMAGE_ID_RE.test(imageId)) return null;
      if (!allowed.has(imageId)) return null;
      if (imageIds.includes(imageId)) continue;
      imageIds.push(imageId);
      if (imageIds.length > SHARED_PLAY_MAX_IMAGES) return null;
    }
    update.title = title;
    update.meaning = meaning;
    update.imageIds = imageIds;
  }
  // 老式（配对投影）条目：带上完整的原目标，应用时好投影一次。
  if (target.legacy === true) update.base = legacyBase(target);
  return update;
}

/** 老式条目的原目标：一份规规矩矩的完整拷贝。 */
function legacyBase(target) {
  return {
    id: target.id,
    title: target.title,
    meaning: target.meaning,
    imageIds: [...target.imageIds],
    sourceIds: [...target.sourceIds],
    state: "familiar",
    revision: 0,
    corrected: false,
    updatedAt: target.updatedAt,
    seenSourceIds: [...target.seenSourceIds],
    resultMessageIds: [...target.resultMessageIds],
    ...(target.pair ? { pair: { ...target.pair } } : {}),
    ...(target.roles ? { roles: { ...target.roles } } : {}),
    legacy: true,
  };
}

/** 按 base 投影一条老式条目（只在第一次落盘时用一次）。 */
function projectLegacy(base) {
  if (!base || typeof base !== "object") return null;
  const id = String(base.id ?? "");
  if (!id.startsWith("pair_")) return null;
  const pair = base.pair;
  if (!pair || typeof pair !== "object") return null;
  const userImageId = String(pair.userImageId ?? "");
  const partnerImageId = String(pair.partnerImageId ?? "");
  if (!IMAGE_ID_RE.test(userImageId) || !IMAGE_ID_RE.test(partnerImageId)) return null;
  if (id !== sharedPlayPairId(userImageId, partnerImageId)) return null;
  const entry = {
    id,
    title: text(base.title, SHARED_PLAY_MAX_TITLE),
    meaning: text(base.meaning, SHARED_PLAY_MAX_MEANING),
    imageIds: stringList(base.imageIds, SHARED_PLAY_MAX_IMAGES, (item) => {
      const value = String(item ?? "");
      return IMAGE_ID_RE.test(value) ? value : "";
    }),
    sourceIds: stringList(base.sourceIds, SHARED_PLAY_MAX_SOURCES),
    state: "familiar",
    revision: 0,
    corrected: false,
    updatedAt: text(base.updatedAt, 40),
    seenSourceIds: [],
    resultMessageIds: [],
    pair: { userImageId, partnerImageId },
    roles: { [userImageId]: "user", [partnerImageId]: "partner" },
    legacy: true,
  };
  return entry;
}

/**
 * 把校验过的更新落到现有的条目上。
 *
 * 只应用版本对得上、而且她那条证据还没处理过的更新；
 * 时间与版本一律这里生成，不信模型传来的。
 */
export function applySharedPlay(existing, updates, { resultMessageId = "", now = new Date() } = {}) {
  const rows = normalizeSharedPlay(existing).map((row) => ({ ...row }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const at = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  const resultId = String(resultMessageId ?? "");
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || typeof update !== "object") continue;
    const op = String(update.op ?? "");
    const evidence = Array.isArray(update.evidence) ? update.evidence : [];
    const userEvidenceIds = evidence.filter((row) => row?.role === "user").map((row) => String(row.sourceId ?? ""));
    const allEvidenceIds = evidence.map((row) => String(row?.sourceId ?? "")).filter(Boolean);

    if (op === "learn") {
      const id = String(update.id ?? "");
      if (!id || byId.has(id)) continue;
      const title = text(update.title, SHARED_PLAY_MAX_TITLE);
      const imageIds = stringList(update.imageIds, SHARED_PLAY_MAX_IMAGES, (item) => {
        const value = String(item ?? "");
        return IMAGE_ID_RE.test(value) ? value : "";
      });
      // 再跟当前已有的条目比一次：模型这句话在路上时，别的回合可能刚改过同一条。
      const sourceIds = allEvidenceIds.slice(0, SHARED_PLAY_MAX_SOURCES);
      let clash = false;
      for (const row of rows) {
        if (row.id === id) { clash = true; break; }
        if (row.title && row.title === title) { clash = true; break; }
        if (row.sourceIds.some((sourceId) => sourceIds.includes(sourceId))) { clash = true; break; }
        if (row.imageIds.some((imageId) => imageIds.includes(imageId))) { clash = true; break; }
      }
      if (clash) continue;
      if (rows.length >= SHARED_PLAY_MAX_ENTRIES) continue;   // 满了不新增，也不动老的纠正
      const entry = {
        id,
        title,
        meaning: text(update.meaning, SHARED_PLAY_MAX_MEANING),
        imageIds,
        sourceIds,
        state: "guess",
        revision: 0,
        corrected: false,
        updatedAt: at,
        seenSourceIds: userEvidenceIds.slice(0, SHARED_PLAY_MAX_SOURCES),
        resultMessageIds: resultId ? [resultId] : [],
        dirty: true,
      };
      rows.push(entry);
      byId.set(id, entry);
      continue;
    }

    let entry = byId.get(String(update.id ?? ""));
    if (!entry) {
      // 老式条目第一次落盘：按 base 投影一次，再真正改。
      const projected = projectLegacy(update.base);
      if (!projected) continue;
      rows.push(projected);
      byId.set(projected.id, projected);
      entry = projected;
    }
    const revision = Math.floor(Number(update.revision));
    if (!Number.isFinite(revision) || revision !== entry.revision) continue;
    // 同一条证据已经处理过：重复的更新不再落一次。
    if (userEvidenceIds.length && userEvidenceIds.every((sourceId) => entry.seenSourceIds.includes(sourceId))) continue;

    if (op === "reinforce") {
      // reinforce 解除不了停止：停掉的条目上面已经拦住了，这里也不改它的状态。
      if (entry.state === "stopped") continue;
      entry.state = "familiar";
      entry.revision += 1;
      entry.updatedAt = at;
      entry.sourceIds = [...new Set([...entry.sourceIds, ...allEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      entry.seenSourceIds = [...new Set([...entry.seenSourceIds, ...userEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      if (resultId) entry.resultMessageIds = [...new Set([...entry.resultMessageIds, resultId])].slice(0, SHARED_PLAY_MAX_SOURCES);
      entry.dirty = true;
      continue;
    }
    if (op === "revise") {
      const wasStopped = entry.state === "stopped";
      entry.title = text(update.title, SHARED_PLAY_MAX_TITLE);
      entry.meaning = text(update.meaning, SHARED_PLAY_MAX_MEANING);
      entry.imageIds = stringList(update.imageIds, SHARED_PLAY_MAX_IMAGES, (item) => {
        const value = String(item ?? "");
        return IMAGE_ID_RE.test(value) ? value : "";
      });
      entry.corrected = true;
      // 她明确说要恢复的时候，revise 才把停掉的这条放回来（还是猜的）。
      entry.state = wasStopped ? "guess" : entry.state;
      entry.revision += 1;
      entry.updatedAt = at;
      entry.sourceIds = [...new Set([...entry.sourceIds, ...allEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      entry.seenSourceIds = [...new Set([...entry.seenSourceIds, ...userEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      if (resultId) entry.resultMessageIds = [...new Set([...entry.resultMessageIds, resultId])].slice(0, SHARED_PLAY_MAX_SOURCES);
      // 图换了就不再是原来那一对：配对角色不能留着说嘴。
      if (entry.pair) {
        const images = entry.imageIds;
        const stillPair = images.length === 2 && images.includes(entry.pair.userImageId) && images.includes(entry.pair.partnerImageId);
        if (!stillPair) {
          delete entry.pair;
          delete entry.roles;
        }
      }
      entry.dirty = true;
      continue;
    }
    if (op === "stop") {
      // 停掉不是删掉：标题、意思与来源都留着（也是不许再学同一句的依据）。
      entry.state = "stopped";
      entry.corrected = true;
      entry.revision += 1;
      entry.updatedAt = at;
      entry.sourceIds = [...new Set([...entry.sourceIds, ...allEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      entry.seenSourceIds = [...new Set([...entry.seenSourceIds, ...userEvidenceIds])].slice(0, SHARED_PLAY_MAX_SOURCES);
      if (resultId) entry.resultMessageIds = [...new Set([...entry.resultMessageIds, resultId])].slice(0, SHARED_PLAY_MAX_SOURCES);
      entry.dirty = true;
    }
  }
  return rows;
}

/**
 * 原来那句话被撤回了：靠它立起来的玩法一起停掉。
 *
 * 留一个最小墓碑（id、图编号、版本），旧的那条猜法就复活不了；
 * 被撤回的原话不留在标题与意思里。重复调用不再加版本、不再写盘。
 */
export function forgetSharedPlaySource(rows, sourceId) {
  const id = String(sourceId ?? "");
  const at = new Date().toISOString();
  if (!id) return normalizeSharedPlay(rows);
  return normalizeSharedPlay(rows).map((row) => {
    const hit = row.sourceIds.includes(id) || row.seenSourceIds.includes(id);
    if (!hit) return row;
    return {
      ...row,
      title: "",
      meaning: "",
      state: "stopped",
      corrected: true,
      revision: row.revision + 1,
      updatedAt: at,
      // 撤回的那句连同它的来源、它带来的结果引用一起去掉：
      // 下次再读到同一条撤回消息时，就没有东西可改，版本也不会再动。
      sourceIds: row.sourceIds.filter((sourceId) => sourceId !== id),
      seenSourceIds: row.seenSourceIds.filter((sourceId) => sourceId !== id),
      resultMessageIds: [],
      dirty: true,
    };
  });
}
