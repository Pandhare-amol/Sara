/**
 * SARA â€” path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets SARA_DATA_DIR to a
 * writable folder under %APPDATA%\SARA, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

// DATA_DIR is resolved during module import. Load local configuration before
// any backend imports instantiate account guards or bind a datastore; loading
// dotenv only inside server_full.ts runs too late for SARA_MULTIUSER_REQUIRED
// and SARA_DATA_DIR and could silently reopen an intended protected install.
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Writable per-user data directory.
 *
 * In production this is controlled by SARA_DATA_DIR and points to the user
 * data folder (e.g. %APPDATA%/Sara). In development, keep writable runtime data
 * in a dedicated ./data directory so file watchers on the project root do not
 * trigger frontend reloads when the app writes memories, sessions, or settings.
 */
export const DATA_DIR: string = path.resolve(process.env.SARA_DATA_DIR || path.join(process.cwd(), "data"));

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the data dir).
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt â€” treat as empty */
  }
  return {};
}

function writeSecrets(secrets: Secrets): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${SECRETS_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(secrets, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best-effort where ACLs differ */ }
    fs.renameSync(temporary, SECRETS_FILE);
    try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* best-effort where ACLs differ */ }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Resolve the active Gemini API key.
 * Priority: user-entered key (secrets.json) â†’ environment (.env, dev only).
 */
export function getGeminiApiKey(): string | undefined {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return stored;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env || undefined;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Persist a user-supplied key to the per-user secrets file. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\u0000]/.test(trimmed)) {
    throw new Error("API key format is invalid.");
  }
  const current = readSecrets();
  current.geminiApiKey = trimmed;
  writeSecrets(current);
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  const current = readSecrets();
  delete current.geminiApiKey;
  try {
    writeSecrets(current);
  } catch {
    /* best-effort */
  }
}

