import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "../studio/artifactStore";
import type { KnowledgeStore, TestEvidence } from "../research/knowledgeStore";
import { SandboxVerifier, type SandboxResult } from "./sandboxVerifier";

export type SkillTestStatus = "RUNNING" | "CANCEL_REQUESTED" | "CANCELLED" | "FAILED" | "UNAVAILABLE" |
  "TIMED_OUT" | "PASSED_AWAITING_REVIEW" | "REVIEWING" | "REVIEWED" | "INVALIDATED";
export interface SkillTestRecord {
  id: string; skillId: string; skillVersion: number; codeArtifactId: string; codeSha256: string;
  testSource: string; testSha256: string; startedAt: string; completedAt?: string;
  status: SkillTestStatus; reason?: string; stdout?: string; stderr?: string; durationMs?: number;
  evidence?: Omit<TestEvidence, "reviewed"> & { reviewed: false }; promotedVersion?: number;
}
interface Snapshot { schema: 1; attempts: SkillTestRecord[] }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const candidateDigest = (source: string, tests: string) => digest(`${source}\0${tests}`);
const IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const ACTIVE = new Set<SkillTestStatus>(["RUNNING", "CANCEL_REQUESTED"]);

/** Real Docker evidence stays pending until a separate owner review. Never run or promote a legacy skill. */
export class SkillVerificationService {
  private readonly attempts: SkillTestRecord[];
  private active: { id: string; abort: AbortController } | null = null;
  private persistenceLocked = false;
  constructor(private readonly file: string, private readonly knowledge: KnowledgeStore,
    private readonly artifacts: ArtifactStore, private readonly verifier: Pick<SandboxVerifier, "status" | "run"> = new SandboxVerifier(),
    private readonly env: NodeJS.ProcessEnv = process.env) {
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Skill test ledger cannot be a symlink.");
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
      if (data.schema !== 1 || !Array.isArray(data.attempts) || data.attempts.length > 60) throw new Error("Skill test ledger needs manual review.");
      this.attempts = data.attempts;
      for (const item of this.attempts) {
        if (ACTIVE.has(item.status)) { item.status = "INVALIDATED"; item.reason = "Sandbox process was interrupted; inspect the host before any retry."; }
      }
    } else this.attempts = [];
  }
  list(): Array<Omit<SkillTestRecord, "testSource">> {
    return this.attempts.map(({ testSource: _, ...item }) => structuredClone(item)).reverse();
  }
  get(id: string): SkillTestRecord | undefined {
    const item = this.attempts.find((entry) => entry.id === id);
    return item ? structuredClone(item) : undefined;
  }
  private save() {
    if (this.persistenceLocked) throw new Error("Skill test checkpoint needs manual review.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error("Skill test ledger cannot be a symlink.");
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ schema: 1, attempts: this.attempts }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACL review remains necessary */ }
    } catch (error) { this.persistenceLocked = true; throw error; }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  start(skillId: string, codeArtifactId: string, tests: string): SkillTestRecord {
    if (this.persistenceLocked) throw new Error("Skill test ledger requires manual review.");
    if (!this.verifier.status().configured || this.env.SARA_ENABLE_DOCKER_SANDBOX !== "true" ||
        !IMAGE.test(this.env.SARA_SANDBOX_IMAGE || "")) throw new Error("Reviewed digest-pinned Docker sandbox is not configured.");
    if (this.active || this.attempts.length >= 60) throw new Error("Only one sandbox test may run; bounded test history is full.");
    const skill = this.knowledge.get(skillId), artifact = this.artifacts.read(codeArtifactId);
    if (!skill || skill.kind !== "skill" || skill.status !== "supported" || Date.parse(skill.expiresAt) <= Date.now()) {
      throw new Error("Start from an unexpired, human-reviewed supported skill proposal.");
    }
    if (!artifact || artifact.item.kind !== "code" || artifact.item.format !== "py" || artifact.bytes.length > 30_000) {
      throw new Error("Select an intact, bounded Python draft from the private workspace.");
    }
    if (typeof tests !== "string" || tests.length < 20 || tests.length > 30_000 ||
        !tests.includes("unittest") || /[\u0000]/.test(tests)) {
      throw new Error("Supply human-reviewed bounded Python unittest source.");
    }
    const id = randomUUID();
    const record: SkillTestRecord = { id, skillId, skillVersion: skill.version,
      codeArtifactId, codeSha256: artifact.item.sha256, testSource: tests, testSha256: digest(tests),
      status: "RUNNING", startedAt: new Date().toISOString() };
    this.attempts.push(record);
    try { this.save(); } catch (error) { this.attempts.pop(); throw error; }
    const controller = new AbortController(); this.active = { id, abort: controller };
    const source = artifact.bytes.toString("utf8");
    setImmediate(() => { void this.run(record, source, controller); });
    return structuredClone(record);
  }
  private async run(record: SkillTestRecord, source: string, controller: AbortController) {
    try {
      const result: SandboxResult = await this.verifier.run(source, record.testSource, controller.signal);
      record.completedAt = new Date().toISOString();
      record.stdout = result.stdout?.slice(0, 8192); record.stderr = result.stderr?.slice(0, 8192);
      record.durationMs = result.durationMs;
      if (controller.signal.aborted) { record.status = "CANCELLED"; record.reason = "Test cancelled; container shutdown must be checked on the host."; }
      else if (result.status === "PASSED" && result.exitCode === 0 && result.evidence?.reviewed === false &&
          result.evidence.source === "isolated_sandbox" && result.evidence.artifactHash === candidateDigest(source, record.testSource) &&
          result.evidence.environment === this.env.SARA_SANDBOX_IMAGE && IMAGE.test(result.evidence.environment) &&
          result.evidence.exitCode === 0 && !!result.evidence.command && Number.isFinite(Date.parse(result.evidence.completedAt))) {
        const current = this.knowledge.get(record.skillId), artifact = this.artifacts.read(record.codeArtifactId);
        if (!current || current.version !== record.skillVersion || current.status !== "supported" ||
            !artifact || artifact.item.sha256 !== record.codeSha256 || Date.parse(current.expiresAt) <= Date.now()) {
          record.status = "INVALIDATED"; record.reason = "Skill or candidate changed while the sandbox ran; retest.";
        } else { record.status = "PASSED_AWAITING_REVIEW"; record.evidence = result.evidence; }
      } else {
        record.status = result.status === "UNAVAILABLE" ? "UNAVAILABLE" : result.status === "TIMED_OUT" ? "TIMED_OUT" : "FAILED";
        record.reason = result.reason || "Sandbox did not produce validated passing evidence.";
      }
    } catch { record.status = controller.signal.aborted ? "CANCELLED" : "FAILED"; record.reason = "Sandbox execution failed; do not promote this skill."; }
    finally {
      record.completedAt ||= new Date().toISOString();
      if (this.active?.id === record.id) this.active = null;
      try { this.save(); }
      catch { record.status = "INVALIDATED"; record.evidence = undefined; record.reason = "Test checkpoint could not be saved; manual recovery required."; }
    }
  }
  cancel(id: string): SkillTestRecord | undefined {
    const item = this.attempts.find((attempt) => attempt.id === id);
    if (!item) return undefined;
    if (this.active?.id === id) {
      item.status = "CANCEL_REQUESTED"; this.active.abort.abort();
      try { this.save(); } catch { item.status = "INVALIDATED"; }
    }
    return structuredClone(item);
  }
  stopAll() { if (this.active) this.cancel(this.active.id); }
  review(id: string): { record: SkillTestRecord; skillVersion: number } {
    if (this.persistenceLocked) throw new Error("Skill test checkpoint needs review.");
    const attempt = this.attempts.find((item) => item.id === id);
    if (!attempt || attempt.status !== "PASSED_AWAITING_REVIEW" || !attempt.evidence) {
      throw new Error("Only an intact passing sandbox run can be approved.");
    }
    const skill = this.knowledge.get(attempt.skillId), artifact = this.artifacts.read(attempt.codeArtifactId);
    if (!skill || skill.version !== attempt.skillVersion || skill.status !== "supported" ||
        Date.parse(skill.expiresAt) <= Date.now() || !artifact || artifact.item.sha256 !== attempt.codeSha256 ||
        digest(attempt.testSource) !== attempt.testSha256 ||
        candidateDigest(artifact.bytes.toString("utf8"), attempt.testSource) !== attempt.evidence.artifactHash ||
        attempt.evidence.environment !== this.env.SARA_SANDBOX_IMAGE) {
      throw new Error("Source, tests, skill version or sandbox environment changed; retest after review.");
    }
    attempt.status = "REVIEWING";
    this.save(); // durable consume-before-promotion; interrupted reviews require manual inspection.
    const approved = this.knowledge.review(attempt.skillId, { ...attempt.evidence, reviewed: true });
    attempt.status = "REVIEWED"; attempt.promotedVersion = approved.version;
    this.save();
    return { record: structuredClone(attempt), skillVersion: approved.version };
  }
}
