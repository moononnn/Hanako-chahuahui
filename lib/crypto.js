import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DPAPI_PREFIX = "dpapi:";
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

export function isProtectedKey(value) {
  return String(value || "").startsWith(DPAPI_PREFIX);
}

export async function protectKey(value) {
  const plain = String(value || "");
  if (!plain) return "";
  if (isProtectedKey(plain)) return plain;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT], {
        env: { ...process.env, CHAHU_KEY: plain }, windowsHide: true, maxBuffer: 1024 * 1024,
      });
      const body = String(stdout || "").trim();
      if (body) { cache.set(body, plain); return DPAPI_PREFIX + body; }
    } catch { /* fallback is deliberate and visible to the caller only through storage */ }
  }
  return plain;
}

export async function unprotectKey(value) {
  const stored = String(value || "");
  if (!stored) return "";
  if (!isProtectedKey(stored)) return stored;
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
