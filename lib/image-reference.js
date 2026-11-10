/** 伙伴参考照归本App所有；候选与选用分开，不经过聊天附件清理。 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requirePartnerId } from "./partner-id.js";
import { detectImageType } from "./background.js";
import { readJsonDurable, writeJsonAtomic } from "./persistence.js";

export const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ID = /^ref_[a-f0-9]{32}$/;
function failure(message, code = "INVALID_REFERENCE") {
  return Object.assign(new Error(message), { code });
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createImageReferences(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dataRoot = fs.realpathSync(dataDir);
  const root = path.join(dataRoot, "v2", "image-references");
  fs.mkdirSync(root, { recursive: true });
  if (!contained(dataRoot, fs.realpathSync(root))) throw failure("参考照目录不在应用数据内");

  function directory(agentId) {
    const dir = path.join(root, requirePartnerId(agentId));
    fs.mkdirSync(dir, { recursive: true });
    if (!contained(root, fs.realpathSync(dir))) throw failure("参考照目录不正确");
    return dir;
  }
  function stateOf(agentId) {
    const dir = directory(agentId);
    const file = path.join(dir, "index.json");
    if (!fs.existsSync(file) && fs.readdirSync(dir).some(name => name.startsWith("index.json.corrupt-"))) throw failure("参考照账本损坏，已停止修改", "REFERENCE_LEDGER_CORRUPT");
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw failure("参考照账本不正确");
    const state = readJsonDurable(file, { currentId: null, history: [] }, {
      onCorrupt() { throw failure("参考照账本损坏，已停止修改", "REFERENCE_LEDGER_CORRUPT"); },
    });
    if (!Array.isArray(state.history) || state.history.some(row => !ID.test(row?.id) || !EXT[row?.mimeType]) ||
        (state.currentId !== null && !state.history.some(row => row.id === state.currentId))) {
      throw failure("参考照账本格式不正确", "REFERENCE_LEDGER_CORRUPT");
    }
    return { dir, file, state };
  }
  const viewOf = state => ({
    currentId: state.currentId,
    history: state.history.map(({ id, mimeType, createdAt, prompt, source }) => ({ id, mimeType, createdAt, prompt, source })),
  });
  function resolve(agentId, referenceId) {
    if (!ID.test(String(referenceId ?? ""))) throw failure("这张参考照不存在", "REFERENCE_NOT_FOUND");
    const { dir, state } = stateOf(agentId);
    const row = state.history.find(row => row.id === referenceId);
    if (!row) throw failure("这张参考照不属于这位伙伴", "REFERENCE_NOT_FOUND");
    const file = path.join(dir, `${row.id}.${EXT[row.mimeType]}`);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !contained(dir, fs.realpathSync(file))) {
      throw failure("这张参考照已经不在了", "REFERENCE_NOT_FOUND");
    }
    return { path: file, ...row };
  }
  return {
    view(agentId) { return viewOf(stateOf(agentId).state); },
    add(agentId, { bytes, prompt = "", source = "upload" } = {}) {
      const buffer = Buffer.from(bytes ?? []);
      const mimeType = detectImageType(buffer);
      if (!buffer.length || buffer.length > REFERENCE_MAX_BYTES || !mimeType) throw failure("请选择不超过10MB的 PNG、JPG、GIF 或 WebP 图片");
      if (!["upload", "generated"].includes(source)) throw failure("参考照来源不正确");
      const { dir, file, state } = stateOf(agentId);
      const row = { id: `ref_${randomUUID().replaceAll("-", "")}`, mimeType, createdAt: new Date().toISOString(), prompt: String(prompt).trim().slice(0, 4000), source };
      const target = path.join(dir, `${row.id}.${EXT[mimeType]}`);
      fs.writeFileSync(target, buffer, { flag: "wx" });
      try {
        writeJsonAtomic(file, { ...state, history: [row, ...state.history] });
      } catch (error) {
        // 只回滚本次新建的候选，不碰旧照片或选用关系。
        try { fs.unlinkSync(target); } catch { /* 未引用文件不改变现有选择 */ }
        throw error;
      }
      return viewOf({ ...state, history: [row, ...state.history] });
    },
    select(agentId, referenceId) {
      resolve(agentId, referenceId);
      const { file, state } = stateOf(agentId);
      const next = { ...state, currentId: referenceId };
      writeJsonAtomic(file, next);
      return viewOf(next);
    },
    resolve,
    current(agentId) {
      const { state } = stateOf(agentId);
      return state.currentId ? resolve(agentId, state.currentId) : null;
    },
    read(agentId, referenceId) {
      const row = resolve(agentId, referenceId);
      const bytes = fs.readFileSync(row.path);
      if (bytes.length > REFERENCE_MAX_BYTES || detectImageType(bytes) !== row.mimeType) throw failure("参考照文件已损坏");
      return { bytes, mimeType: row.mimeType };
    },
  };
}
