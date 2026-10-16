import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";

/** Named-person identity is established only by a verified credential or a one-time secret.
 * A relationship label, voice score, image, device token, or claimed userId is never proof.
 * This store is deliberately independent of legacy user_profiles.json.
 */
export type UserRole = "owner" | "admin" | "member" | "restricted" | "guest";
export type UserCapability = "chat" | "memory" | "manage_users" | "manage_security_settings" | "view_security_events";
const CAPABILITIES: UserCapability[] = ["chat", "memory", "manage_users", "manage_security_settings", "view_security_events"];
const ROLES: UserRole[] = ["owner", "admin", "member", "restricted", "guest"];
const OWNER_SECURITY: UserCapability[] = ["manage_security_settings", "view_security_events"];
const ADMIN_ONLY: UserCapability[] = ["manage_users", ...OWNER_SECURITY];
const DEFAULT_ROLES: Record<UserRole, UserCapability[]> = {
  owner: ["chat", "memory", "manage_users", ...OWNER_SECURITY], admin: ["chat", "memory"],
  member: ["chat", "memory"], restricted: [], guest: ["chat"],
};

/** Explicitly chosen preferences, not deductions from speech, family labels or biometrics.
 * Old version-1 account stores without this field use these safe defaults. */
export const SUPPORTED_LANGUAGES = ["en", "hi", "mr", "gu", "bn", "ta", "te", "kn", "ml", "pa"] as const;
export type UserLanguage = typeof SUPPORTED_LANGUAGES[number];
export interface UserPreferences {
  language: UserLanguage;
  personalizedGreeting: boolean;
  proactiveConversation: boolean;
}
const DEFAULT_PREFERENCES: UserPreferences = { language: "en", personalizedGreeting: false, proactiveConversation: false };
function validPreferences(value: unknown): value is UserPreferences {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && Object.keys(value).every((key) => Object.hasOwn(DEFAULT_PREFERENCES, key)) &&
    SUPPORTED_LANGUAGES.includes((value as UserPreferences).language) &&
    typeof (value as UserPreferences).personalizedGreeting === "boolean" &&
    typeof (value as UserPreferences).proactiveConversation === "boolean";
}
function preferencePatch(value: unknown): Partial<UserPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.keys(value).length || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_PREFERENCES, key))) {
    throw new Error("Only supported personal preferences can be changed.");
  }
  const patch = value as Partial<UserPreferences>;
  if ((patch.language !== undefined && !SUPPORTED_LANGUAGES.includes(patch.language)) ||
      (patch.personalizedGreeting !== undefined && typeof patch.personalizedGreeting !== "boolean") ||
      (patch.proactiveConversation !== undefined && typeof patch.proactiveConversation !== "boolean")) {
    throw new Error("Invalid language or preference value.");
  }
  return patch;
}
const SESSION_MS = 8 * 60 * 60_000;
const DEFAULT_IDLE_MINUTES = 15;
const GUEST_MS = 30 * 60_000;
const FRESH_MS = 2 * 60_000;
const CEREMONY_MS = 2 * 60_000;

interface Credential {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: string;
  lastUsedAt?: string;
  consentedAt: string;
}
interface Account {
  id: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
  preferences?: UserPreferences;
  inviteHash?: string;
  recoveryHash?: string;
  passphrase?: { salt: string; hash: string };
  credentials: Credential[];
  allow: UserCapability[];
  deny: UserCapability[];
}
export interface PublicAccount {
  id: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
  activeSessions: number;
  hasPasskey: boolean;
  hasPassphrase: boolean;
  capabilities: UserCapability[];
  allow: UserCapability[];
  deny: UserCapability[];
}
/** Never include private preferences in the manager's account directory. */
export interface OwnAccount extends PublicAccount { preferences: UserPreferences }
export interface UserSession {
  userId: string;
  role: UserRole;
  displayName: string;
  capabilities: UserCapability[];
  method: "admin-token" | "passkey" | "passphrase" | "invitation" | "recovery";
  expiresAt: number;
  freshUntil: number;
  tokenHash: string;
}
interface SavedSession {
  tokenHash: string;
  userId: string;
  method: UserSession["method"];
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  freshUntil: number;
}
export interface Relationship {
  id: string;
  from: string;
  to: string;
  label: string;
  createdAt: string;
}
export interface AccountAuditEvent {
  at: string;
  action: string;
  actor: string;
  subject: string;
  result: "allowed" | "denied";
}
interface Store {
  version: 1;
  accounts: Account[];
  roles: Record<UserRole, UserCapability[]>;
  settings?: { sessionIdleMinutes: number };
  sessions: SavedSession[];
}
interface Ceremony {
  kind: "register" | "login";
  userId: string;
  sessionHash?: string;
  challenge: string;
  rpID: string;
  origin: string;
  expiresAt: number;
}
function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function secret(): string { return crypto.randomBytes(32).toString("base64url"); }
function passphraseDigest(passphrase: string, salt: string): string {
  return crypto.scryptSync(passphrase, Buffer.from(salt, "hex"), 64,
    { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
}
function accountName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Enter a display name (1–80 characters).");
  }
  return value.trim();
}
function assertId(id: string): void {
  if (!/^(default-user|u-[a-f0-9]{32})$/.test(id)) throw new Error("Invalid account ID.");
}
function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export class MultiUserStore {
  private readonly file: string;
  private readonly relationsFile: string;
  private readonly auditFile: string;
  private readonly activationIntentFile: string;
  private readonly ceremonies = new Map<string, Ceremony>();

  constructor(private readonly dataDir: string, private readonly required = process.env.SARA_MULTIUSER_REQUIRED === "true") {
    this.file = path.join(dataDir, "security", "multiuser.json");
    this.relationsFile = path.join(dataDir, "security", "relationships.json");
    this.auditFile = path.join(dataDir, "security", "multiuser-audit.jsonl");
    this.activationIntentFile = path.join(dataDir, "security", "multiuser.pending");
  }

  isEnabled(): boolean { return this.required || fs.existsSync(this.file) || fs.existsSync(this.activationIntentFile); }
  isInitialized(): boolean { return fs.existsSync(this.file) && this.read().accounts.some((a) => a.id === "default-user"); }

  private read(): Store {
    // Never fall back to an open/legacy mode when an account store is damaged.
    if (!fs.existsSync(this.file)) throw new Error("Multi-user setup is required. Legacy endpoints are locked.");
    const state = JSON.parse(fs.readFileSync(this.file, "utf8")) as Store;
    if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.sessions) || !state.roles ||
        !state.accounts.some((a) => a.id === "default-user" && a.role === "owner") ||
        state.accounts.some((a) => !a || typeof a.id !== "string" || !/^(default-user|u-[a-f0-9]{32})$/.test(a.id) ||
          !ROLES.includes(a.role) || !Array.isArray(a.credentials) || !Array.isArray(a.allow) || !Array.isArray(a.deny) ||
          (a.preferences !== undefined && !validPreferences(a.preferences)) ||
          (a.lastUsedAt !== undefined && (typeof a.lastUsedAt !== "string" || !Number.isFinite(Date.parse(a.lastUsedAt)))) ||
          (a.passphrase !== undefined && (!/^[a-f0-9]{32}$/.test(a.passphrase.salt) || !/^[a-f0-9]{128}$/.test(a.passphrase.hash)))) ||
        ROLES.some((role) => !Array.isArray(state.roles[role]) || state.roles[role].some((cap) => !CAPABILITIES.includes(cap))) ||
        (state.settings !== undefined && (!Number.isInteger(state.settings.sessionIdleMinutes) ||
          state.settings.sessionIdleMinutes < 5 || state.settings.sessionIdleMinutes > 60))) {
      throw new Error("Multi-user account store is invalid; protected APIs remain locked. Restore from a reviewed backup.");
    }
    return state;
  }

  private audit(action: string, actor: string, subject: string, result: "allowed" | "denied" = "allowed"): void {
    fs.mkdirSync(path.dirname(this.auditFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), action, actor, subject, result })}\n`, { mode: 0o600 });
  }

  /** Read a bounded tail: other people's sign-ins and activity are not public,
   * including to accounts with an admin or relationship label. Never return
   * a session hash, invitation, or recovery code in audit records.
   */
  private readAuditTail(): AccountAuditEvent[] {
    if (!fs.existsSync(this.auditFile)) return [];
    const size = fs.statSync(this.auditFile).size;
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(this.auditFile, "r");
    try { fs.readSync(fd, buf, 0, length, size - length); }
    finally { fs.closeSync(fd); }
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    if (size > length) lines.shift(); // the first line may have been cut in half
    return lines.filter(Boolean).map((line) => {
      const event = JSON.parse(line) as AccountAuditEvent;
      if (typeof event.at !== "string" || typeof event.action !== "string" ||
          typeof event.actor !== "string" || typeof event.subject !== "string" ||
          !["allowed", "denied"].includes(event.result)) throw new Error("Account audit log is unreadable.");
      return event;
    });
  }
  readOwnAudit(userId: string): AccountAuditEvent[] {
    assertId(userId);
    return this.readAuditTail().filter((event) => event.actor === userId || event.subject === userId).slice(-50).reverse();
  }
  /** Cross-account security metadata is available only to a freshly verified
   * owner or explicitly authorized admin. Never includes private message text. */
  readSecurityAudit(session: UserSession): AccountAuditEvent[] {
    const active = this.requireSavedSession(session);
    this.requireFresh(active);
    if ((active.role !== "owner" && active.role !== "admin") || !this.has(active, "view_security_events")) {
      throw new Error("System security activity is not permitted.");
    }
    return this.readAuditTail().slice(-100).reverse();
  }

  private save(state: Store): void { atomicJson(this.file, state); }

  private withWrite<T>(change: (state: Store) => T): T {
    // Exclusive inter-process writer lock. A stale lock is not silently stolen: operator
    // review is required after a crash, rather than risking lost permissions/revocations.
    const lock = `${this.file}.lock`;
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch { throw new Error("Account store is busy or has a stale writer lock. Retry or review the lock safely."); }
    try {
      const state = this.read();
      const result = change(state);
      this.save(state);
      return result;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  /** Explicit opt-in; preserve original files and never auto-enroll legacy profiles. */
  bootstrap(displayName: string): { account: PublicAccount; token: string; expiresAt: number } {
    if (fs.existsSync(this.file)) throw new Error("Multi-user mode has already been initialized.");
    const name = accountName(displayName);
    const securityDir = path.dirname(this.file);
    fs.mkdirSync(securityDir, { recursive: true, mode: 0o700 });
    // Once setup begins, keep the entire installation locked, even if a backup
    // or process fails. This marker survives a restart and can be retried only
    // after local owner verification; never revert automatically to legacy APIs.
    if (!fs.existsSync(this.activationIntentFile)) {
      try { fs.writeFileSync(this.activationIntentFile, "pending\n", { flag: "wx", mode: 0o600 }); }
      catch { if (!fs.existsSync(this.activationIntentFile)) throw new Error("Could not establish the account setup lock."); }
    }
    // Backup sensitive legacy data before writing the account store. The originals
    // remain in place and are owned only by the authenticated default-user account.
    const backupDir = path.join(securityDir, `backup-${new Date().toISOString().replace(/[^0-9]/g, "")}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(backupDir, { mode: 0o700 });
    for (const file of ["conversations.json", "conversations_mobile.json", "memories.json", "memories_mobile.json", "sara_memory.db", "data.db", "sessions.json", "tasks.json", "tool_calls.json", "decisions.json", "questions.json", "user_profiles.json"]) {
      const source = path.join(this.dataDir, file);
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, path.join(backupDir, file), fs.constants.COPYFILE_EXCL);
        try { fs.chmodSync(path.join(backupDir, file), 0o600); } catch { /* OS-specific ACLs */ }
      }
    }
    const owner: Account = { id: "default-user", displayName: name, role: "owner", disabled: false,
      createdAt: new Date().toISOString(), activatedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      credentials: [], allow: [], deny: [] };
    const state: Store = { version: 1, accounts: [owner], roles: structuredClone(DEFAULT_ROLES),
      settings: { sessionIdleMinutes: DEFAULT_IDLE_MINUTES }, sessions: [] };
    const { token, saved } = this.newSession(owner, "admin-token");
    state.sessions.push(saved);
    this.audit("mode_enabled", "default-user", "default-user");
    // 'wx' prevents two concurrent bootstraps from replacing a just-created store.
    fs.writeFileSync(this.file, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    try { fs.unlinkSync(this.activationIntentFile); } catch { /* account store exists; protected mode stays active */ }
    return { account: this.publicAccount(owner, state), token, expiresAt: saved.expiresAt };
  }

  private publicAccount(account: Account, state: Store): PublicAccount {
    const allowed = new Set<UserCapability>(state.roles[account.role] || []);
    for (const cap of account.allow) if (CAPABILITIES.includes(cap)) allowed.add(cap);
    for (const cap of account.deny) allowed.delete(cap);
    // Old version-1 stores predate the owner security flags. Never strand the
    // verified original owner; non-admin roles cannot gain administration by
    // modifying a role matrix or a one-off override.
    if (account.role === "owner") for (const cap of OWNER_SECURITY) allowed.add(cap);
    if (account.role !== "owner" && account.role !== "admin") for (const cap of ADMIN_ONLY) allowed.delete(cap);
    if (account.role === "guest") allowed.delete("memory");
    if (account.disabled) allowed.clear();
    const now = Date.now();
    const idleMs = (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    return { id: account.id, displayName: account.displayName, role: account.role,
      disabled: account.disabled, createdAt: account.createdAt, activatedAt: account.activatedAt,
      lastUsedAt: account.lastUsedAt,
      activeSessions: state.sessions.filter((s) => s.userId === account.id && !account.disabled && s.expiresAt > now && s.lastSeenAt + idleMs > now).length,
      hasPasskey: account.credentials.length > 0, hasPassphrase: Boolean(account.passphrase),
      capabilities: [...allowed], allow: [...account.allow], deny: [...account.deny] };
  }
  private ownAccount(account: Account, state: Store): OwnAccount {
    return { ...this.publicAccount(account, state),
      preferences: account.role === "guest" ? { ...DEFAULT_PREFERENCES } : { ...DEFAULT_PREFERENCES, ...account.preferences } };
  }

  list(): PublicAccount[] { const state = this.read(); return state.accounts.map((a) => this.publicAccount(a, state)); }
  roles(): Record<UserRole, UserCapability[]> {
    const roles = structuredClone(this.read().roles);
    roles.owner = [...new Set([...roles.owner, ...OWNER_SECURITY])];
    return roles;
  }
  systemSettings(): { sessionIdleMinutes: number } {
    return { sessionIdleMinutes: this.read().settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES };
  }
  updateSystemSettings(minutes: number, actorId = "default-user"): { sessionIdleMinutes: number } {
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) throw new Error("Idle lock must be 5–60 minutes.");
    assertId(actorId);
    this.withWrite((state) => {
      state.settings = { sessionIdleMinutes: minutes };
      const now = Date.now();
      state.sessions = state.sessions.filter((session) => session.lastSeenAt + minutes * 60_000 > now);
      this.audit("system_idle_lock_updated", actorId, "installation");
    });
    return this.systemSettings();
  }
  ownProfile(userId: string): OwnAccount | null {
    assertId(userId);
    const state = this.read(); const user = state.accounts.find((a) => a.id === userId);
    return user ? this.ownAccount(user, state) : null;
  }
  private relationshipRecords(): Relationship[] {
    if (!fs.existsSync(this.relationsFile)) return [];
    const data = JSON.parse(fs.readFileSync(this.relationsFile, "utf8"));
    if (!Array.isArray(data) || data.some((r) => !r || typeof r.id !== "string" ||
        !/^r-[a-f0-9-]{36}$/.test(r.id) || typeof r.from !== "string" || typeof r.to !== "string" ||
        typeof r.label !== "string" || typeof r.createdAt !== "string")) {
      throw new Error("Relationships store is invalid.");
    }
    return data as Relationship[];
  }
  readRelationships(userId: string, includeAll = false): Relationship[] {
    assertId(userId);
    if (includeAll && userId !== "default-user") throw new Error("Only the owner can manage all relationship labels.");
    const items = this.relationshipRecords();
    return includeAll ? items : items.filter((item) => item.from === userId || item.to === userId);
  }
  addRelationship(from: string, to: string, label: string, actorId = "default-user"): Relationship {
    assertId(from); assertId(to); assertId(actorId);
    if (from === to || typeof label !== "string" || !label.trim() || label.trim().length > 60 || /[\u0000-\u001f]/.test(label)) {
      throw new Error("Invalid relationship. Labels confer no access or authority.");
    }
    return this.withWrite((state) => {
      if (!state.accounts.find((a) => a.id === from && !a.disabled) || !state.accounts.find((a) => a.id === to && !a.disabled)) throw new Error("Unknown account.");
      const data = this.relationshipRecords();
      if (data.some((r) => r.from === from && r.to === to && r.label.toLowerCase() === label.trim().toLowerCase())) {
        throw new Error("This relationship label already exists.");
      }
      const relation = { id: `r-${crypto.randomUUID()}`, from, to, label: label.trim(), createdAt: new Date().toISOString() };
      atomicJson(this.relationsFile, [...data, relation]);
      this.audit("relationship_labeled", actorId, to);
      return relation;
    });
  }
  removeRelationship(id: string, actor: UserSession): void {
    if (typeof id !== "string" || !/^r-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid relationship ID.");
    this.withWrite((state) => {
      const now = Date.now();
      const saved = state.sessions.find((s) => s.tokenHash === actor.tokenHash && s.userId === actor.userId &&
        s.expiresAt > now && s.freshUntil > now &&
        s.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now);
      const user = state.accounts.find((a) => a.id === saved?.userId && !a.disabled);
      if (!saved || !["passkey", "admin-token"].includes(saved.method) || !user || user.role !== "owner") {
        throw new Error("Only a freshly verified owner can remove a relationship label.");
      }
      const data = this.relationshipRecords();
      const removed = data.find((r) => r.id === id);
      if (!removed) throw new Error("Relationship label not found.");
      atomicJson(this.relationsFile, data.filter((r) => r.id !== id));
      this.audit("relationship_removed", user.id, removed.to);
    });
  }

  private newSession(user: Account, method: SavedSession["method"]): { token: string; saved: SavedSession } {
    const token = secret(); const now = Date.now();
    return { token, saved: { tokenHash: sha256(token), userId: user.id, method,
      createdAt: now, lastSeenAt: now, expiresAt: now + (user.role === "guest" ? GUEST_MS : SESSION_MS),
      freshUntil: now + FRESH_MS } };
  }
  private issue(userId: string, method: SavedSession["method"]): { token: string; session: UserSession } {
    const { token, saved } = this.withWrite((state) => {
      const user = state.accounts.find((a) => a.id === userId && !a.disabled);
      if (!user) throw new Error("Account unavailable.");
      const issued = this.newSession(user, method);
      user.lastUsedAt = new Date().toISOString();
      state.sessions = state.sessions.filter((s) => s.expiresAt > Date.now() &&
        s.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > Date.now()).slice(-99);
      state.sessions.push(issued.saved);
      this.audit("signed_in", userId, userId);
      return issued;
    });
    return { token, session: this.requireSession(token) };
  }

  requireSession(token: string, options: { activity?: boolean } = {}): UserSession {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Sign in to continue.");
    const state = this.read(); const now = Date.now();
    const hashed = sha256(token);
    const saved = state.sessions.find((s) => s.tokenHash === hashed);
    const user = state.accounts.find((a) => a.id === saved?.userId);
    if (!saved || !user || user.disabled || saved.expiresAt <= now || saved.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 <= now) {
      throw new Error("Session expired or revoked. Sign in again.");
    }
    if (options.activity !== false && now - saved.lastSeenAt > 30_000) {
      // Only interactive requests refresh the idle window, not session-status polling.
      this.withWrite((next) => { const found = next.sessions.find((s) => s.tokenHash === hashed);
        if (!found || next.accounts.find((a) => a.id === found.userId)?.disabled ||
            found.expiresAt <= now || found.lastSeenAt + (next.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 <= now) {
          throw new Error("Session expired or revoked.");
        }
        found.lastSeenAt = now;
        const activeUser = next.accounts.find((a) => a.id === found.userId);
        if (activeUser) activeUser.lastUsedAt = new Date(now).toISOString();
      });
    }
    return { userId: user.id, role: user.role, displayName: user.displayName,
      capabilities: this.publicAccount(user, state).capabilities, method: saved.method,
      expiresAt: saved.expiresAt, freshUntil: saved.freshUntil, tokenHash: hashed };
  }
  private requireSavedSession(session: UserSession): UserSession {
    const state = this.read(); const now = Date.now();
    const saved = state.sessions.find((item) => item.tokenHash === session.tokenHash && item.userId === session.userId);
    const user = state.accounts.find((item) => item.id === saved?.userId && !item.disabled);
    if (!saved || !user || saved.expiresAt <= now ||
        saved.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 <= now) {
      throw new Error("Session expired or revoked. Sign in again.");
    }
    return { userId: user.id, role: user.role, displayName: user.displayName,
      capabilities: this.publicAccount(user, state).capabilities, method: saved.method,
      expiresAt: saved.expiresAt, freshUntil: saved.freshUntil, tokenHash: saved.tokenHash };
  }
  ownSessions(session: UserSession): { createdAt: number; lastSeenAt: number; expiresAt: number; method: UserSession["method"]; current: boolean }[] {
    const state = this.read(); const now = Date.now();
    const idleMs = (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    return state.sessions.filter((item) => item.userId === session.userId &&
      item.expiresAt > now && item.lastSeenAt + idleMs > now)
      .map((item) => ({ createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, expiresAt: item.expiresAt,
        method: item.method, current: item.tokenHash === session.tokenHash }));
  }
  recordOwnDataExport(session: UserSession): void {
    this.withWrite((state) => {
      const now = Date.now();
      if (session.freshUntil <= now || !state.sessions.some((item) =>
        item.userId === session.userId && item.tokenHash === session.tokenHash &&
        item.expiresAt > now && item.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now)) {
        throw new Error("Re-authenticate to export private data.");
      }
      this.audit("self_data_exported", session.userId, session.userId);
    });
  }
  revokeOtherSessions(session: UserSession): void {
    if (session.freshUntil <= Date.now()) throw new Error("Re-authenticate to revoke other sessions.");
    this.withWrite((state) => {
      const now = Date.now();
      if (!state.sessions.some((item) => item.tokenHash === session.tokenHash && item.userId === session.userId &&
          item.expiresAt > now && item.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now)) {
        throw new Error("Session expired or revoked.");
      }
      state.sessions = state.sessions.filter((item) => item.userId !== session.userId || item.tokenHash === session.tokenHash);
      this.audit("other_sessions_revoked", session.userId, session.userId);
    });
  }
  has(session: UserSession, cap: UserCapability): boolean { return session.capabilities.includes(cap); }
  requireFresh(session: UserSession): void {
    if (session.freshUntil <= Date.now() || !["passkey", "admin-token"].includes(session.method)) {
      throw new Error("Re-authenticate with a passkey or the local owner secret before sensitive changes.");
    }
  }
  revoke(token: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const hash = sha256(token);
    this.withWrite((s) => {
      const userId = s.sessions.find((item) => item.tokenHash === hash)?.userId;
      s.sessions = s.sessions.filter((item) => item.tokenHash !== hash);
      if (userId) this.audit("signed_out", userId, userId);
    });
  }
  /** Revoking another account's sessions never reveals its messages or
   * credentials. Only a fresh owner can do so, and not through a relationship. */
  revokeAccountSessions(actor: UserSession, userId: string): number {
    assertId(userId);
    return this.withWrite((state) => {
      const now = Date.now();
      const saved = state.sessions.find((s) => s.tokenHash === actor.tokenHash && s.userId === actor.userId &&
        s.expiresAt > now && s.freshUntil > now &&
        s.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now);
      const manager = state.accounts.find((a) => a.id === saved?.userId && !a.disabled);
      const target = state.accounts.find((a) => a.id === userId);
      if (!saved || !["admin-token", "passkey"].includes(saved.method) ||
          !manager || manager.role !== "owner" || !target || target.role === "owner") {
        throw new Error("Fresh owner verification is required to revoke another account's sessions.");
      }
      const removed = state.sessions.filter((s) => s.userId === userId).length;
      state.sessions = state.sessions.filter((s) => s.userId !== userId);
      this.audit("account_sessions_revoked", actor.userId, userId);
      return removed;
    });
  }
  authenticateOwner(adminSecret: string, expectedSecret: string): { token: string; session: UserSession } {
    if (expectedSecret.length < 32 || !/\S/.test(adminSecret) || adminSecret.length > 512 ||
        !crypto.timingSafeEqual(Buffer.from(sha256(adminSecret)), Buffer.from(sha256(expectedSecret)))) {
      this.audit("owner_sign_in", "unknown", "default-user", "denied");
      throw new Error("Owner authentication failed.");
    }
    return this.issue("default-user", "admin-token");
  }
  authenticatePassphrase(userId: string, passphrase: string): { token: string; session: UserSession } {
    assertId(userId);
    if (typeof passphrase !== "string" || passphrase.length > 256) throw new Error("Sign-in failed.");
    const user = this.read().accounts.find((a) => a.id === userId && !a.disabled);
    // Perform a comparable hash even when an ID has no password; never reveal
    // which person has enrolled or allow client-supplied user IDs to bind a session.
    const record = user?.passphrase || { salt: "0".repeat(32), hash: "0".repeat(128) };
    const given = Buffer.from(passphraseDigest(passphrase, record.salt), "hex");
    const expected = Buffer.from(record.hash, "hex");
    if (!user?.passphrase || user.role === "guest" || !crypto.timingSafeEqual(given, expected)) {
      this.audit("passphrase_sign_in", userId, userId, "denied");
      throw new Error("Sign-in failed.");
    }
    return this.issue(userId, "passphrase");
  }
  setOwnPassphrase(session: UserSession, passphrase: string): void {
    if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 256 ||
        passphrase !== passphrase.trim() || /[\u0000-\u001f]/.test(passphrase)) {
      throw new Error("Use a unique passphrase of 16–256 characters without control characters or surrounding spaces.");
    }
    if (session.role === "guest" || session.freshUntil <= Date.now() ||
        !["admin-token", "passkey", "passphrase", "invitation", "recovery"].includes(session.method)) {
      throw new Error("Re-authenticate before changing your own sign-in method.");
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = passphraseDigest(passphrase, salt);
    this.withWrite((s) => {
      const saved = s.sessions.find((v) => v.tokenHash === session.tokenHash && v.userId === session.userId &&
        v.expiresAt > Date.now() && v.lastSeenAt + (s.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > Date.now());
      const account = s.accounts.find((a) => a.id === session.userId && !a.disabled && a.activatedAt);
      if (!saved || !account) throw new Error("Account session has ended.");
      account.passphrase = { salt, hash };
      s.sessions = s.sessions.filter((v) => v.userId !== session.userId || v.tokenHash === session.tokenHash);
      this.audit("self_passphrase_changed_and_other_sessions_revoked", session.userId, session.userId);
    });
  }
  createAccount(displayName: string, role: UserRole, actorId = "default-user"): { account: PublicAccount; invitation: string } {
    assertId(actorId);
    if (!ROLES.includes(role) || role === "owner") throw new Error("Select a non-owner role.");
    const name = accountName(displayName);
    const invitation = secret();
    const account = this.withWrite((s) => {
      if (s.accounts.length >= 50) throw new Error("Account limit reached.");
      const next: Account = { id: `u-${crypto.randomBytes(16).toString("hex")}`, displayName: name, role,
        disabled: false, createdAt: new Date().toISOString(), inviteHash: sha256(invitation),
        credentials: [], allow: [], deny: [] };
      s.accounts.push(next); this.audit("account_invited", actorId, next.id);
      return this.publicAccount(next, s);
    });
    return { account, invitation };
  }
  private consumeCode(userId: string, code: string, kind: "inviteHash" | "recoveryHash"): { token: string; session: UserSession } {
    assertId(userId);
    if (typeof code !== "string" || code.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("Invalid or expired one-time code.");
    // Consume the code and issue its session in ONE atomic account-store write.
    // A crash must not permanently strand someone after consuming their only
    // invitation/recovery code but before creating their signed-in session.
    const issued = this.withWrite((state) => {
      const user = state.accounts.find((a) => a.id === userId && !a.disabled);
      const expected = user?.[kind];
      if (!expected || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sha256(code))) ||
          (kind === "recoveryHash" && user?.role === "guest")) {
        this.audit("code_sign_in", userId, userId, "denied");
        throw new Error("Invalid or expired one-time code.");
      }
      if (kind === "inviteHash") {
        if (user!.activatedAt) throw new Error("Invitation already accepted.");
        user!.activatedAt = new Date().toISOString();
      }
      delete user![kind];
      if (kind === "recoveryHash") {
        user!.credentials = []; // lost or compromised credentials must no longer unlock the account
        delete user!.passphrase;
        state.sessions = state.sessions.filter((session) => session.userId !== userId);
      }
      const next = this.newSession(user!, kind === "inviteHash" ? "invitation" : "recovery");
      state.sessions = state.sessions.filter((s) => s.expiresAt > Date.now() &&
        s.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > Date.now()).slice(-99);
      state.sessions.push(next.saved);
      user!.lastUsedAt = new Date().toISOString();
      this.audit(kind === "recoveryHash" ? "recovered_and_passkeys_revoked" : "invitation_used", userId, userId);
      this.audit("signed_in", userId, userId);
      return next;
    });
    return { token: issued.token, session: this.requireSession(issued.token) };
  }
  acceptInvitation(userId: string, code: string) { return this.consumeCode(userId, code, "inviteHash"); }
  recover(userId: string, code: string) { return this.consumeCode(userId, code, "recoveryHash"); }
  rotateInvitation(userId: string, actorId = "default-user"): string {
    assertId(userId); assertId(actorId); const code = secret();
    this.withWrite((s) => {
      const user = s.accounts.find((a) => a.id === userId && !a.disabled);
      if (!user || user.activatedAt) throw new Error("Only an unaccepted invitation may be replaced; account history is private.");
      user.inviteHash = sha256(code);
      this.audit("pending_invitation_rotated", actorId, userId);
    });
    return code;
  }
  issueOwnRecoveryCode(session: UserSession): string {
    if (session.role === "guest" || session.freshUntil <= Date.now() ||
        !["invitation", "passkey", "passphrase", "admin-token"].includes(session.method)) {
      throw new Error("Authenticate again to create your own recovery code.");
    }
    const code = secret();
    this.withWrite((s) => {
      const saved = s.sessions.find((v) => v.tokenHash === session.tokenHash && v.userId === session.userId &&
        v.expiresAt > Date.now() && v.lastSeenAt + (s.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > Date.now());
      const account = s.accounts.find((a) => a.id === session.userId && !a.disabled && a.activatedAt);
      if (!saved || !account) throw new Error("Account session has ended.");
      account.recoveryHash = sha256(code);
      this.audit("self_recovery_code_created", session.userId, session.userId);
    });
    return code;
  }
  updateProfile(userId: string, displayName: string): OwnAccount {
    const name = accountName(displayName);
    return this.withWrite((s) => { const user = s.accounts.find((a) => a.id === userId && !a.disabled);
      if (!user) throw new Error("Account unavailable."); user.displayName = name;
      this.audit("profile_updated", userId, userId); return this.ownAccount(user, s); });
  }
  updatePreferences(session: UserSession, value: unknown): OwnAccount {
    const patch = preferencePatch(value);
    const active = this.requireSavedSession(session);
    if (active.role === "guest") throw new Error("Guest preferences are temporary and cannot be saved.");
    return this.withWrite((state) => {
      const now = Date.now();
      const saved = state.sessions.find((item) => item.tokenHash === active.tokenHash && item.userId === active.userId &&
        item.expiresAt > now && item.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now);
      const user = state.accounts.find((item) => item.id === active.userId && !item.disabled && item.role !== "guest");
      if (!saved || !user) throw new Error("Session expired or revoked.");
      user.preferences = { ...DEFAULT_PREFERENCES, ...user.preferences, ...patch };
      this.audit("self_preferences_updated", user.id, user.id);
      return this.ownAccount(user, state);
    });
  }
  updateAccount(userId: string, patch: { role?: UserRole; disabled?: boolean; allow?: UserCapability[]; deny?: UserCapability[] }, actorId = "default-user"): PublicAccount {
    assertId(userId); assertId(actorId);
    return this.withWrite((s) => {
      const user = s.accounts.find((a) => a.id === userId);
      if (!user || user.role === "owner" || userId === "default-user") throw new Error("The owner account cannot be changed by this endpoint.");
      if (patch.role !== undefined) {
        if (!ROLES.includes(patch.role) || patch.role === "owner") throw new Error("Invalid role.");
        if (patch.role !== user.role) {
          // An old exceptional grant must not silently reappear when someone is
          // moved to a lower-trust role, then moved back months later.
          user.allow = []; user.deny = [];
        }
        user.role = patch.role;
      }
      if (patch.disabled !== undefined) { if (typeof patch.disabled !== "boolean") throw new Error("Invalid status."); user.disabled = patch.disabled; }
      for (const key of ["allow", "deny"] as const) if (patch[key] !== undefined) {
        if (!Array.isArray(patch[key]) || patch[key]!.some((cap) => !CAPABILITIES.includes(cap))) throw new Error("Invalid capability.");
        user[key] = [...new Set(patch[key])];
      }
      s.sessions = s.sessions.filter((v) => v.userId !== userId);
      this.audit("permissions_changed_and_sessions_revoked", actorId, userId);
      return this.publicAccount(user, s);
    });
  }
  updateRole(role: UserRole, capabilities: UserCapability[], actorId = "default-user"): Record<UserRole, UserCapability[]> {
    assertId(actorId);
    if (!ROLES.includes(role) || role === "owner" || !Array.isArray(capabilities) ||
        capabilities.some((cap) => !CAPABILITIES.includes(cap))) throw new Error("Invalid role or capability.");
    this.withWrite((s) => { s.roles[role] = [...new Set(capabilities)];
      s.sessions = s.sessions.filter((v) => !s.accounts.some((a) => a.id === v.userId && a.role === role));
      this.audit("role_changed_and_sessions_revoked", actorId, role); });
    return this.roles();
  }

  ownPasskeys(userId: string): { id: string; createdAt: string; lastUsedAt?: string }[] {
    assertId(userId);
    const user = this.read().accounts.find((item) => item.id === userId && !item.disabled);
    if (!user) throw new Error("Account unavailable.");
    return user.credentials.map((key) => ({ id: key.id, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt }));
  }
  revokeOwnPasskey(session: UserSession, credentialId: string): void {
    if (typeof credentialId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(credentialId)) throw new Error("Invalid passkey ID.");
    this.requireFresh(session);
    this.withWrite((state) => {
      const now = Date.now();
      const saved = state.sessions.find((item) => item.userId === session.userId && item.tokenHash === session.tokenHash &&
        item.expiresAt > now && item.freshUntil > now &&
        item.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now);
      const user = state.accounts.find((item) => item.id === session.userId && !item.disabled);
      if (!saved || !user || !["passkey", "admin-token"].includes(saved.method)) throw new Error("Re-authenticate to revoke a passkey.");
      const index = user.credentials.findIndex((key) => key.id === credentialId);
      if (index < 0) throw new Error("This passkey is not enrolled to your account.");
      if (user.credentials.length === 1 && user.role !== "owner" && !user.passphrase && !user.recoveryHash) {
        throw new Error("Set a personal passphrase or save your own recovery code before revoking your last passkey.");
      }
      user.credentials.splice(index, 1);
      state.sessions = state.sessions.filter((item) => item.userId !== session.userId);
      this.audit("self_passkey_revoked_all_sessions", session.userId, session.userId);
    });
  }

  private startCeremony(item: Omit<Ceremony, "expiresAt">): string {
    for (const [id, pending] of this.ceremonies) if (pending.expiresAt <= Date.now()) this.ceremonies.delete(id);
    if (this.ceremonies.size >= 40) throw new Error("Too many pending authentication attempts.");
    const id = crypto.randomBytes(16).toString("hex"); this.ceremonies.set(id, { ...item, expiresAt: Date.now() + CEREMONY_MS }); return id;
  }
  private consumeCeremony(id: string, kind: Ceremony["kind"]): Ceremony {
    const item = this.ceremonies.get(id); this.ceremonies.delete(id);
    if (!item || item.kind !== kind || item.expiresAt <= Date.now()) throw new Error("Challenge expired or already used. Start again.");
    return item;
  }
  async beginEnrollment(session: UserSession, context: { rpID: string; origin: string }, consent: boolean) {
    if (consent !== true) throw new Error("The account holder must explicitly consent to enroll a passkey.");
    const active = this.requireSavedSession(session);
    const user = this.read().accounts.find((a) => a.id === active.userId && !a.disabled);
    if (!user || user.role === "guest" || user.credentials.length >= 5 || active.freshUntil <= Date.now() ||
        (user.credentials.length > 0 && !["passkey", "admin-token"].includes(active.method))) {
      throw new Error("Re-authenticate before enrolling a passkey, or review the account passkey limit.");
    }
    const options = await generateRegistrationOptions({ rpName: "SARA personal sign-in", rpID: context.rpID,
      userID: new TextEncoder().encode(user.id), userName: user.id, userDisplayName: user.displayName,
      attestationType: "none", timeout: CEREMONY_MS,
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      excludeCredentials: user.credentials.map((key) => ({ id: key.id, transports: key.transports })) });
    return { ceremonyId: this.startCeremony({ kind: "register", userId: user.id, sessionHash: session.tokenHash,
      challenge: options.challenge, ...context }), options };
  }
  async finishEnrollment(session: UserSession, ceremonyId: string, response: RegistrationResponseJSON) {
    const ceremony = this.consumeCeremony(ceremonyId, "register");
    if (ceremony.userId !== session.userId || ceremony.sessionHash !== session.tokenHash || session.freshUntil <= Date.now()) {
      throw new Error("Enrollment challenge expired or belongs to another session.");
    }
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin, expectedRPID: ceremony.rpID, requireUserVerification: true });
    if (!verified.verified || !verified.registrationInfo?.userVerified) throw new Error("Passkey verification failed.");
    const credential = verified.registrationInfo.credential;
    const user = this.withWrite((state) => {
      const now = Date.now();
      const saved = state.sessions.find((s) => s.tokenHash === session.tokenHash && s.userId === session.userId &&
        s.expiresAt > now && s.freshUntil > now &&
        s.lastSeenAt + (state.settings?.sessionIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000 > now);
      const account = state.accounts.find((a) => a.id === session.userId && !a.disabled && a.role !== "guest");
      if (!saved || !account) throw new Error("Enrollment session was revoked or expired.");
      if (account.credentials.length > 0 && !["passkey", "admin-token"].includes(saved.method)) {
        throw new Error("Re-authenticate with an enrolled passkey before adding another.");
      }
      if (account.credentials.length >= 5 || state.accounts.some((a) => a.credentials.some((key) => key.id === credential.id))) {
        throw new Error("Passkey is already registered or account unavailable.");
      }
      account.credentials.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter, transports: credential.transports || [], createdAt: new Date().toISOString(),
        consentedAt: new Date().toISOString() });
      this.audit("passkey_enrolled_with_consent", session.userId, session.userId);
      return this.ownAccount(account, state);
    });
    return user;
  }
  async beginPasskeyLogin(userId: string, context: { rpID: string; origin: string }) {
    assertId(userId);
    const user = this.read().accounts.find((a) => a.id === userId && !a.disabled && a.role !== "guest");
    if (!user?.credentials.length) throw new Error("No passkey is enrolled for that account.");
    const options = await generateAuthenticationOptions({ rpID: context.rpID, timeout: CEREMONY_MS,
      userVerification: "required", allowCredentials: user.credentials.map((key) => ({ id: key.id, transports: key.transports })) });
    return { ceremonyId: this.startCeremony({ kind: "login", userId, challenge: options.challenge, ...context }), options };
  }
  async finishPasskeyLogin(ceremonyId: string, response: AuthenticationResponseJSON) {
    const ceremony = this.consumeCeremony(ceremonyId, "login");
    const user = this.read().accounts.find((a) => a.id === ceremony.userId && !a.disabled && a.role !== "guest");
    const key = user?.credentials.find((c) => c.id === response?.id);
    if (!key) throw new Error("This passkey is not enrolled for this account.");
    const credential: WebAuthnCredential = { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")),
      counter: key.counter, transports: key.transports };
    const verified = await verifyAuthenticationResponse({ response, expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin, expectedRPID: ceremony.rpID, credential, requireUserVerification: true });
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw new Error("Passkey verification failed.");
    this.withWrite((s) => {
      const active = s.accounts.find((a) => a.id === ceremony.userId && !a.disabled && a.role !== "guest")?.credentials.find((c) => c.id === key.id);
      if (!active || active.counter !== key.counter) throw new Error("Passkey changed during authentication; retry.");
      active.counter = verified.authenticationInfo.newCounter;
      active.lastUsedAt = new Date().toISOString();
      this.audit("passkey_authenticated", ceremony.userId, ceremony.userId);
    });
    return this.issue(ceremony.userId, "passkey");
  }
}
