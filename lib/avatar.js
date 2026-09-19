import path from "node:path";

import { isValidPartnerId } from "./partner-id.js";

/**
 * 头像读取 —— 走到 Hana 那边把头像文件现读回来。
 *
 * 位置是固定的：`agents/<id>/avatars/agent.<ext>`、`user/avatars/user.<ext>`。
 * 宿主自己也有一条 `/api/agents/:id/avatar` 的路由，但它要 chat 权限，应用面够不着，
 * 所以这里走资源通道读**同一份文件** —— Hana 里换了头像，这边跟着换，不用维护两份。
 *
 * 伙伴自己没配头像时，还有第二层：读宿主自带的那张默认脸（按助手的「缘」分，
 * `Hanako.png` / `Butter.png` / `Ming.png` / `Kong.png`）。茶话会里显示的就是 Hana 里显示的那张，
 * 不另画一张、也不留空白。
 *
 * 全程只读。两层都读不到就返回 null，界面退回一个字，不编一张假头像出来。
 */

/** 扩展名按这个顺序找，跟宿主一致。 */
export const AVATAR_TYPES = [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
];

/** 宿主自带的那几张默认脸：按助手的「缘」摆着，名字就是宿主自己的文件命名。 */
export const YUAN_AVATAR_FILES = {
  hanako: "Hanako",
  butter: "Butter",
  ming: "Ming",
  kong: "Kong",
};

/**
 * 这几张图装在哪儿：跟平台、跟装法有关，候选目录一个个试，谁读到算谁的。
 * 环境变量留了个口子，装到非默认位置时也能指过来。
 */
export function defaultAvatarDirs({ platform = process.platform, env = process.env } = {}) {
  const dirs = [];
  const fromEnv = String(env?.HANA_AGENT_RESOURCES ?? "").trim();
  if (fromEnv) dirs.push(path.join(fromEnv, "assets"));
  if (platform === "win32") {
    dirs.push("C:\\Program Files\\HanaAgent\\resources\\assets");
    dirs.push("C:\\Program Files (x86)\\HanaAgent\\resources\\assets");
  } else if (platform === "darwin") {
    dirs.push("/Applications/HanaAgent.app/Contents/Resources/assets");
  } else {
    dirs.push("/opt/HanaAgent/resources/assets");
    dirs.push("/usr/lib/HanaAgent/resources/assets");
  }
  return dirs;
}

/**
 * 认一下图片头。
 * 对不上说明没读到真图（比如宿主忽略了 base64 编码），宁可当没读到，也不能把乱码当头像送出去。
 */
export function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // RIFF/WebP
  return false;
}

/** 资源通道回来的内容形状不止一种，照单收。 */
export function toBytes(result) {
  const raw = result?.content ?? result?.data ?? result?.body ?? result;
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const buf = Buffer.from(trimmed, "base64");
    return buf.length > 0 ? buf : null;
  }
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.ctx          应用 ctx（用 ctx.resources.read）
 * @param {string} deps.agentsRoot   <HANA_HOME>/agents
 * @param {string} deps.userRoot     <HANA_HOME>/user
 * @param {Function} [deps.diagnostics]
 * @param {number} [deps.ttlMs]
 * @param {Function} [deps.defaultDirs]  默认脸可能在哪几个目录（测试里可以换）
 */
export function createAvatarReader({
  ctx,
  agentsRoot,
  userRoot,
  diagnostics = () => {},
  ttlMs = 5 * 60 * 1000,
  defaultDirs = defaultAvatarDirs,
}) {
  const cache = new Map();

  /** 在一个目录里按扩展名顺序找同一个文件名。 */
  async function readByBase(dir, base) {
    for (const [ext, contentType] of AVATAR_TYPES) {
      const file = path.join(dir, `${base}.${ext}`);
      let result;
      try {
        result = await ctx.resources.read({ kind: "local-file", path: file }, { encoding: "base64" });
      } catch {
        continue;
      }
      const bytes = toBytes(result);
      if (!bytes) continue;
      if (!looksLikeImage(bytes)) {
        diagnostics({ event: "avatar.not-image", file, bytes: bytes.length });
        continue;
      }
      return { bytes, contentType, file };
    }
    return null;
  }

  /** 伙伴自己配的那份。 */
  async function readFromDisk(kind, agentId) {
    // 目录名是拼出来的，id 先过关（不拦的话 `..` 能爬到伙伴目录外面去）。
    if (kind !== "user" && !isValidPartnerId(agentId)) return null;
    const dir =
      kind === "user"
        ? path.join(userRoot, "avatars")
        : path.join(agentsRoot, String(agentId ?? ""), "avatars");
    return readByBase(dir, kind === "user" ? "user" : "agent");
  }

  /** 宿主自带的那张默认脸（按「缘」选）。认不出这个「缘」就不猜。 */
  async function readDefaultAvatar(yuan) {
    const base = YUAN_AVATAR_FILES[String(yuan ?? "").toLowerCase()];
    if (!base) return null;
    for (const dir of defaultDirs()) {
      const found = await readByBase(dir, base);
      if (found) return found;
    }
    return null;
  }

  /**
   * 读一张头像：先读伙伴自己配的，没有再退到宿主自带的默认脸。
   * 都没有返回 null（会缓存一小会儿，免得每次都去敲）。
   */
  async function getAvatar(kind, agentId, yuan = null) {
    const key = kind === "user" ? "user:" : `agent:${agentId}:${yuan ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;

    let value = null;
    let source = null;
    try {
      value = await readFromDisk(kind, agentId);
      if (value) source = "file";
    } catch (error) {
      diagnostics({ event: "avatar.failed", key, message: String(error?.message ?? error) });
    }
    if (!value && kind === "agent" && yuan) {
      try {
        value = await readDefaultAvatar(yuan);
        if (value) source = "default";
      } catch (error) {
        diagnostics({ event: "avatar.default.failed", key, message: String(error?.message ?? error) });
      }
    }
    cache.set(key, { at: Date.now(), value });
    diagnostics({ event: "avatar.read", key, ok: Boolean(value), source, bytes: value?.bytes?.length ?? 0 });
    return value;
  }

  return { getAvatar, readFromDisk, readDefaultAvatar, cache };
}
