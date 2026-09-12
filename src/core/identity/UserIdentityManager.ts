import fs from "node:fs";
import path from "node:path";

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

  constructor(storePath = path.resolve(process.cwd(), "data", "user_profiles.json")) {
    this.storePath = storePath;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
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

  private save(profiles: UserProfile[]): void {
    const tempPath = `${this.storePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(profiles, null, 2), "utf8");
    fs.renameSync(tempPath, this.storePath);
  }
}

export const userIdentityManager = new UserIdentityManager();
