import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoredMemory } from "../../server_memory";

/** Separate on-disk namespaces for invited users. Legacy desktop data belongs only
 * to the original default-user. Callers must supply an authenticated account ID.
 * Guests do not use this store: their context stays in process/browser memory.
 */
export function userDataPath(dataDir: string, userId: string, name: "memories.json" | "conversations.json"): string {
  if (!/^u-[a-f0-9]{32}$/.test(userId)) throw new Error("Invalid private account ID.");
  return path.join(dataDir, "users", userId, name);
}

export function readPrivateData<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const items = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(items)) throw new Error("Private account data is damaged; it was not overwritten.");
  return items as T[];
}

export function savePrivateData(file: string, items: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows filesystem ACLs */ }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export function belongsToUserConversation(userId: string, conversationId: string): boolean {
  if (typeof conversationId !== "string" || conversationId.length < 1 || conversationId.length > 140) return false;
  if (userId === "default-user") return !conversationId.startsWith("u-") && /^[a-zA-Z0-9:_-]+$/.test(conversationId);
  if (!/^u-[a-f0-9]{32}$/.test(userId)) return false;
  return conversationId.startsWith(`${userId}:`) && /^[a-zA-Z0-9:_-]+$/.test(conversationId);
}

export function readUserMemories(dataDir: string, userId: string): StoredMemory[] {
  return readPrivateData<StoredMemory>(userDataPath(dataDir, userId, "memories.json"));
}
export function writeUserMemories(dataDir: string, userId: string, memories: StoredMemory[]): void {
  savePrivateData(userDataPath(dataDir, userId, "memories.json"), memories);
}
