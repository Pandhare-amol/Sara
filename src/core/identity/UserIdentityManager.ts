import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataFile } from "../../../server_paths";

const MAX_LEGACY_PROFILE_STORE_BYTES = 1024 * 1024;

export interface UserProfile {
  userId: string;
  displayName: string;
  relationship?: string;
  preferences: Record<string, unknown>;
  communicationStyle: Record<string, unknown>;
  permissions: string[];
  memoryScope: string;
  importantContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export class UserIdentityManager {
  private readonly storePath: string;

  constructor(
    storePath = dataFile("user_profiles.json"),
    legacyStorePath = process.env.SARA_USER_PROFILES_LEGACY_PATH || path.resolve(process.cwd(), "data", "user_profiles.json"),
  ) {
    this.storePath = path.resolve(storePath);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.migrateLegacyStoreIfNeeded(path.resolve(legacyStorePath));
  }

  list(): UserProfile[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  get(userId: string): UserProfile | null {
    const normalized = normalizeUserId(userId);
    return this.list().find((profile) => profile.userId === normalized) ?? null;
  }

  upsert(input: Partial<UserProfile> & { userId: string; displayName: string }): UserProfile {
    const userId = normalizeUserId(input.userId);
    const displayName = input.displayName.trim();
    if (!userId) throw new Error("A non-empty userId is required.");
    if (!displayName) throw new Error("A non-empty displayName is required.");

    const profiles = this.list();
    const now = new Date().toISOString();
    const existing = profiles.find((profile) => profile.userId === userId);
    const profile: UserProfile = {
      userId,
      displayName,
      relationship: input.relationship,
      preferences: input.preferences || existing?.preferences || {},
      communicationStyle: input.communicationStyle || existing?.communicationStyle || {},
      permissions: Array.from(new Set(input.permissions || existing?.permissions || [])),
      memoryScope: input.memoryScope || existing?.memoryScope || userId,
      importantContext: input.importantContext || existing?.importantContext || {},
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const index = profiles.findIndex((item) => item.userId === userId);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    this.save(profiles);
    return profile;
  }

  remove(userId: string): boolean {
    const profiles = this.list();
    const next = profiles.filter((profile) => profile.userId !== normalizeUserId(userId));
    if (next.length === profiles.length) return false;
    this.save(next);
    return true;
  }

  private migrateLegacyStoreIfNeeded(legacyPath: string): void {
    if (legacyPath === this.storePath || fs.existsSync(this.storePath)) return;

    let temporaryPath: string | undefined;
    try {
      const legacyStat = fs.lstatSync(legacyPath);
      if (!legacyStat.isFile() || legacyStat.isSymbolicLink() || legacyStat.size > MAX_LEGACY_PROFILE_STORE_BYTES) return;
      const legacyProfiles = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      if (!Array.isArray(legacyProfiles)) return;

      temporaryPath = `${this.storePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(legacyProfiles, null, 2), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(temporaryPath, 0o600); } catch { /* best-effort on platforms with different ACLs */ }
      fs.renameSync(temporaryPath, this.storePath);
      temporaryPath = undefined;
      try { fs.chmodSync(this.storePath, 0o600); } catch { /* best-effort on platforms with different ACLs */ }
    } catch {
      // Keep the old file untouched and let SARA start; a malformed legacy file
      // must not block the rest of the assistant from starting.
    } finally {
      if (temporaryPath) {
        try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
      }
    }
  }

  private save(profiles: UserProfile[]): void {
    const tempPath = `${this.storePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(profiles, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch { /* best-effort on platforms with different ACLs */ }
    fs.renameSync(tempPath, this.storePath);
    try { fs.chmodSync(this.storePath, 0o600); } catch { /* best-effort on platforms with different ACLs */ }
  }
}

export const userIdentityManager = new UserIdentityManager();
