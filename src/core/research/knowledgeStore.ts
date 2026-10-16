import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SourceRecord } from "./researchEngine";

export type KnowledgeState = "pending_review" | "supported" | "verified" | "outdated";
export type Platform = "any" | "windows" | "linux" | "darwin";
export type SkillPermission = "read_public_web" | "browser_read" | "desktop_visual" | "edit_files";
export interface TestEvidence {
  source: "isolated_sandbox"; command: string; exitCode: number; completedAt: string;
  artifactHash: string; environment: string; reviewed: true;
}
export interface EvidencePassage { url: string; sourceId: string; sourceHash: string;
  retrievedAt: string; text: string; sourceVersion?: string }
export interface KnowledgeVersion {
  id: string; version: number; name: string; description: string; intendedUse: string;
  kind: "topic" | "skill"; status: KnowledgeState;
  evidence: EvidencePassage[]; sourceUrls: string[];
  platform: Platform; dependencies: string[]; requiredPermissions: SkillPermission[];
  procedure: string[]; expectedResults: string[]; failureHandling: string;
  examples: Array<{ input: string; expectedOutput: string }>;
  verification?: TestEvidence; confidence: "unverified" | "supported" | "tested";
  expiresAt: string; createdAt: string; updatedAt: string;
}
interface Snapshot { schema: 1; versions: KnowledgeVersion[] }
const NAME = /^[a-zA-Z0-9_. -]{2,100}$/;
const DEP = /^[a-zA-Z0-9_./@+-]{1,80}$/;
const PERMISSIONS: SkillPermission[] = ["read_public_web", "browser_read", "desktop_visual", "edit_files"];
const PLATFORMS: Platform[] = ["any", "windows", "linux", "darwin"];
const SENSITIVE = /\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|private key|secret)\s*[:=]\s*\S+/i;

function brief(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || SENSITIVE.test(value)) throw new Error("Knowledge text missing, oversized or potentially secret.");
  return value.trim();
}
function strings(value: unknown, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxCount) throw new Error("Invalid bounded knowledge list.");
  return value.map((item) => brief(item, maxLength));
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Only browser/app-backed evidence passed by trusted server code can create a record. */
export class KnowledgeStore {
  private readonly versions: KnowledgeVersion[];
  constructor(private readonly file: string) {
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Knowledge store cannot be a symlink.");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
      if (snapshot.schema !== 1 || !Array.isArray(snapshot.versions) || snapshot.versions.length > 1_000) throw new Error("Knowledge store needs manual recovery.");
      this.versions = snapshot.versions;
    } else this.versions = [];
  }
  private room() {
    if (this.versions.length >= 1_000) throw new Error("Knowledge history limit reached; delete outdated items after review.");
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error("Knowledge store cannot be a symlink.");
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schema: 1, versions: this.versions }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACLs need manual review */ }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  list(): KnowledgeVersion[] {
    return clone(this.versions.filter((item) => !this.versions.some((later) => later.id === item.id && later.version > item.version)));
  }
  history(id: string): KnowledgeVersion[] { return clone(this.versions.filter((item) => item.id === id)); }
  get(id: string, version?: number): KnowledgeVersion | undefined {
    const history = this.history(id);
    return version === undefined ? history.at(-1) : history.find((item) => item.version === version);
  }
  propose(input: Record<string, unknown>, sources: SourceRecord[], now = new Date()): KnowledgeVersion {
    this.room();
    if (!NAME.test(String(input.name || ""))) throw new Error("Knowledge name requires 2–100 simple characters.");
    const kind = input.kind;
    if (kind !== "topic" && kind !== "skill") throw new Error("Choose a topic or manual skill.");
    if (!PLATFORMS.includes(input.platform as Platform)) throw new Error("Platform requirement is invalid.");
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 5 ||
        sources.some((source) => source.status !== "retrieved_unverified" || !source.passages?.length)) throw new Error("Provenance must come from retrieved sources.");
    const dependencies = strings(input.dependencies ?? [], 10, 80);
    if (dependencies.some((item) => !DEP.test(item))) throw new Error("Dependencies must be package names, not commands.");
    const requiredPermissions = strings(input.requiredPermissions ?? [], 4, 30) as SkillPermission[];
    if (requiredPermissions.some((item) => !PERMISSIONS.includes(item))) throw new Error("Permission names must be reviewed.");
    const procedure = strings(input.procedure ?? [], 12, 320);
    const expectedResults = strings(input.expectedResults ?? [], 8, 320);
    if (kind === "skill" && (!procedure.length || !expectedResults.length)) throw new Error("Skills require a procedure and expected outcome.");
    const expiresInDays = input.expiresInDays;
    if (!Number.isInteger(expiresInDays) || Number(expiresInDays) < 1 || Number(expiresInDays) > 365) throw new Error("Set a 1–365 day revalidation period.");
    const evidence = sources.flatMap((source) => source.passages.slice(0, 2).map((passage) => ({
      url: source.url, sourceId: source.id, sourceHash: source.contentHash,
      retrievedAt: source.retrievedAt, text: brief(passage, 400),
      sourceVersion: source.publishedOrUpdatedAt,
    }))).slice(0, 8);
    const examples = input.examples ?? [];
    if (!Array.isArray(examples) || examples.length > 3 || examples.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.input !== "string" || typeof entry.expectedOutput !== "string")) throw new Error("Invalid skill examples.");
    const parsedExamples = examples.map((entry) => ({ input: brief(entry.input, 200), expectedOutput: brief(entry.expectedOutput, 200) }));
    const id = typeof input.id === "string" ? input.id : randomUUID();
    const prior = this.get(id);
    if (input.id !== undefined && !prior) throw new Error("Cannot revise an unknown knowledge item.");
    const item: KnowledgeVersion = {
      id, version: prior ? prior.version + 1 : 1,
      name: brief(input.name, 100), kind, description: brief(input.description, 1500),
      intendedUse: brief(input.intendedUse, 500), evidence,
      sourceUrls: [...new Set(sources.map((source) => source.url))],
      platform: input.platform as Platform, dependencies, requiredPermissions, procedure, expectedResults,
      failureHandling: brief(input.failureHandling || "Stop and ask for review; do not retry consequential effects.", 500),
      examples: parsedExamples, confidence: "unverified", status: "pending_review",
      expiresAt: new Date(now.getTime() + Number(expiresInDays) * 86400_000).toISOString(),
      createdAt: prior?.createdAt || now.toISOString(), updatedAt: now.toISOString(),
    };
    this.versions.push(item);
    this.save();
    return clone(item);
  }
  /** Human review can establish support, not independent experimental truth. */
  review(id: string, evidence?: TestEvidence): KnowledgeVersion {
    this.room();
    const latest = this.get(id);
    if (!latest) throw new Error("Unknown knowledge item.");
    if (latest.status === "outdated" || Date.parse(latest.expiresAt) <= Date.now()) {
      throw new Error("Knowledge is outdated or expired and needs fresh source evidence.");
    }
    if (evidence && latest.kind !== "skill") throw new Error("A topic cannot be promoted as an executable skill.");
    if (evidence && (evidence.source !== "isolated_sandbox" || evidence.exitCode !== 0 || evidence.reviewed !== true ||
        !/^[0-9a-f]{64}$/.test(evidence.artifactHash) || !evidence.command || !evidence.environment ||
        !Number.isFinite(Date.parse(evidence.completedAt)))) throw new Error("Independent test evidence is invalid.");
    const updated: KnowledgeVersion = { ...latest, version: latest.version + 1,
      status: evidence ? "verified" : "supported", confidence: evidence ? "tested" : "supported",
      verification: evidence, updatedAt: new Date().toISOString() };
    this.versions.push(updated); this.save(); return clone(updated);
  }
  rollback(id: string, targetVersion: number): KnowledgeVersion {
    this.room();
    if (!Number.isInteger(targetVersion) || targetVersion < 1) throw new Error("Select a prior knowledge version.");
    const previous = this.get(id, targetVersion), latest = this.get(id);
    if (!previous || !latest || previous.version >= latest.version || Date.parse(previous.expiresAt) <= Date.now() ||
        latest.status === "outdated" || previous.status === "outdated") {
      throw new Error("Only an unexpired earlier version with current source evidence can be restored for new review.");
    }
    // Restoring content never restores a past verification or old permissions.
    const restored: KnowledgeVersion = { ...clone(previous), version: latest.version + 1,
      status: "pending_review", confidence: "unverified", verification: undefined, updatedAt: new Date().toISOString() };
    this.versions.push(restored); this.save(); return clone(restored);
  }
  expire(id: string): KnowledgeVersion {
    this.room();
    const latest = this.get(id);
    if (!latest) throw new Error("Unknown knowledge item.");
    const updated: KnowledgeVersion = { ...latest, version: latest.version + 1, status: "outdated",
      updatedAt: new Date().toISOString() };
    this.versions.push(updated); this.save(); return clone(updated);
  }
  delete(id: string): boolean {
    const count = this.versions.length;
    for (let index = this.versions.length - 1; index >= 0; index--) if (this.versions[index].id === id) this.versions.splice(index, 1);
    if (this.versions.length === count) return false;
    this.save(); return true;
  }
  search(query: string, context: { platform: Platform; dependencies: string[]; permissions: SkillPermission[] }, now = Date.now()) {
    const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 15));
    if (!terms.size) return [];
    return this.list().filter((item) => item.kind === "skill" && item.status === "verified" &&
      Date.parse(item.expiresAt) > now && (item.platform === "any" || item.platform === context.platform) &&
      item.dependencies.every((dep) => context.dependencies.includes(dep)) &&
      item.requiredPermissions.every((permission) => context.permissions.includes(permission)) &&
      [...terms].some((term) => `${item.name} ${item.description} ${item.intendedUse}`.toLowerCase().includes(term)))
      .slice(0, 5).map((item) => ({ ...item, reuse: "manual_review_required" as const }));
  }
}
