/**
 * 凭据加解密。两层，都加密，绝不写明文：
 *
 * - 系统锁（Windows DPAPI / CurrentUser）：文件被拷到别的机器或别的账户都解不开。
 *   代价是得在 App 进程里起 powershell 子进程，而 v2 App 的 Node 权限模型默认
 *   不给 `--allow-child-process`，`execFile` 会直接 ERR_ACCESS_DENIED。要它真正
 *   可用，得让宿主给这个 App 授 `app/process.spawn`，并在授权后重启 App 进程。
 * - 本机锁（AES-256-GCM，密钥由本机标识派生）：不需要子进程，任何时候都能落盘。
 *   挡住的是"数据文件被同步、备份、拷到别的电脑"，挡不住本机上能读这份文件的
 *   程序——密钥在那台机器上可以重新算出来。这是诚实的边界，不夸大。
 *
 * 默认 auto：先试系统锁，拿不到退回本机锁。CHAHU_CREDENTIAL_MODE 可以指定
 * local（只用本机锁）或 system（只用系统锁，失败就拒绝落盘）。
 */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DPAPI_PREFIX = "dpapi:";
const LOCAL_PREFIX = "local1:";
const LOCAL_SALT = "chahuahui-credential-v1";
const MODES = new Set(["auto", "system", "local"]);
const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$b = [Text.Encoding]::UTF8.GetBytes($env:CHAHU_KEY)
$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($e)`;
const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String($env:CHAHU_KEY)
$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($d)`;
const cache = new Map();
/** 上一次系统加密到底成没成；失败时不猜、不静默。 */
let lastProtect = { ok: false, reason: "", storage: "" };

function credentialMode() {
  const raw = String(process.env.CHAHU_CREDENTIAL_MODE || "auto").trim().toLowerCase();
  return MODES.has(raw) ? raw : "auto";
}

/** 本机能不能用 Windows 系统加密保护 Key。 */
export function encryptionAvailable() {
  return lastProtect.ok;
}

export function encryptionStatus() {
  return { ...lastProtect };
}

export function isProtectedKey(value) {
  const text = String(value || "");
  return text.startsWith(DPAPI_PREFIX) || text.startsWith(LOCAL_PREFIX);
}

/** 认证串到底是哪种锁：encrypted=系统锁，local=本机锁，空=没加密。 */
export function credentialStorage(value) {
  const text = String(value || "");
  if (text.startsWith(DPAPI_PREFIX)) return "encrypted";
  if (text.startsWith(LOCAL_PREFIX)) return "local";
  return "";
}

// ── 本机锁 ─────────────────────────────────────────────────────

function localSeed() {
  let username = "";
  try { username = os.userInfo().username; } catch { /* 取不到就少一项，密钥仍然稳定。 */ }
  return `${os.hostname()}|${username}|${os.homedir()}`;
}

function localKey() {
  return Buffer.from(hkdfSync("sha256", localSeed(), LOCAL_SALT, "chahuahui/credential", 32));
}

export function protectLocal(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `${LOCAL_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function unprotectLocal(stored) {
  const body = String(stored || "").slice(LOCAL_PREFIX.length);
  const [iv, tag, cipherText] = body.split(".");
  if (!iv || !tag || !cipherText) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", localKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

// ── 系统锁 ─────────────────────────────────────────────────────

async function protectWithDpapi(plain) {
  lastProtect = { ok: false, reason: "", storage: "" };
  if (process.platform !== "win32") {
    lastProtect = { ok: false, reason: "非 Windows 系统", storage: "" };
    return "";
  }
  try {
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT], {
      env: { ...process.env, CHAHU_KEY: plain }, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const body = String(stdout || "").trim();
    if (body) {
      cache.set(body, plain);
      lastProtect = { ok: true, reason: "", storage: "encrypted" };
      return DPAPI_PREFIX + body;
    }
    lastProtect = { ok: false, reason: "系统加密没有返回结果", storage: "" };
  } catch (error) {
    // 沙箱里能不能起子进程是环境说了算（App 未授 app/process.spawn 就是 ERR_ACCESS_DENIED）。
    // 这里不硬撑，记下真实原因交给上层，加密本身不降级成明文。
    lastProtect = { ok: false, reason: String(error?.code || error?.message || "系统加密调用失败").slice(0, 120), storage: "" };
  }
  return "";
}

/**
 * 加密一段凭据，返回带前缀的密文。
 * 系统锁、本机锁都拿不到时返回空串：调用方必须拒绝落盘，不能悄悄写明文。
 */
export async function protectKey(value) {
  const plain = String(value || "");
  if (!plain) return "";
  if (isProtectedKey(plain)) return plain;
  const mode = credentialMode();
  if (mode !== "local") {
    const system = await protectWithDpapi(plain);
    if (system) return system;
    if (mode === "system") return "";
  } else {
    lastProtect = { ok: false, reason: "本机加密模式", storage: "local" };
  }
  const local = protectLocal(plain);
  lastProtect = { ok: false, reason: lastProtect.reason || "系统加密不可用", storage: "local" };
  return local.startsWith(LOCAL_PREFIX) ? local : "";
}

export async function unprotectKey(value) {
  const stored = String(value || "");
  if (!stored) return "";
  if (stored.startsWith(LOCAL_PREFIX)) return unprotectLocal(stored);
  if (!stored.startsWith(DPAPI_PREFIX)) return stored;
  const body = stored.slice(DPAPI_PREFIX.length);
  if (cache.has(body)) return cache.get(body);
  if (process.platform !== "win32") return "";
  try {
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT], {
      env: { ...process.env, CHAHU_KEY: body }, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const plain = String(stdout || "").trim();
    if (plain) cache.set(body, plain);
    return plain;
  } catch { return ""; }
}
