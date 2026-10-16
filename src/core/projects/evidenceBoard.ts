import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LocalProjectManager, GeneralProject } from "../../services/LocalProjectManager";
import type { ResearchJobManager } from "../research/researchEngine";
import type { KnowledgeStore, KnowledgeVersion } from "../research/knowledgeStore";
import type { ArtifactStore } from "../studio/artifactStore";
import type { StudioJobs } from "../studio/studioJobs";

const ID = /^(?:project-)?[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SENSITIVE = /\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|private key|secret)\s*[:=]\s*\S+/i;
const MAX_BOARDS = 50;
const MAX_LINKS = 12;
const MAX_EVENTS = 120;
const MAX_LEDGER_BYTES = 3_000_000;
const SOURCE_AGE_MS = 30 * 24 * 60 * 60_000;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);
const projectDigest = (project: GeneralProject) => sha256({ id: project.id, title: project.title,
  description: project.description, dueDate: project.dueDate, status: project.status });

export class EvidenceConflictError extends Error {}
export type BoardLifecycle = "ACTIVE" | "PAUSED" | "CANCELLED";
export type EvidencePhase = "DRAFT" | "BRIEF_REVIEWED" | "AWAITING_FINAL_REVIEW" |
  "HUMAN_ACCEPTED" | "STALE" | "PAUSED" | "CANCELLED";
export interface SourceLink {
  jobId: string; sourceId: string; url: string; contentHash: string; retrievedAt: string;
}
export interface KnowledgeLink { id: string; version: number; evidenceDigest: string }
export interface JobLink { id: string; modality: string }
export interface ArtifactLink {
  id: string; sha256: string; format: string; parentId?: string; provider: string;
  model: string; estimatedCostUsd?: number;
}
export interface EvidenceBoard {
  projectId: string; projectFingerprint: string; revision: number; lifecycle: BoardLifecycle; brief: string;
  sources: SourceLink[]; knowledge: KnowledgeLink[]; jobs: JobLink[]; artifacts: ArtifactLink[];
  briefReview?: { digest: string; reviewedAt: string; meaning: "human_reviewed_not_fact_checked" };
  acceptance?: { digest: string; acceptedAt: string; meaning: "human_accepted_for_manual_use" };
  events: Array<{ action: string; at: string; revision: number }>;
  createdAt: string; updatedAt: string;
}
export interface EvidenceReport {
  project: GeneralProject | null; board: EvidenceBoard; currentProjectFingerprint: string | null;
  phase: EvidencePhase; briefDigest: string; manifestDigest: string;
  blockers: string[]; briefBlockers: string[]; warnings: string[]; estimatedCostUsd: number | null;
  linkedJobs: Array<{ id: string; status: string; artifactId?: string }>;
  disclaimer: string;
}
interface Snapshot { schema: 1; boards: EvidenceBoard[] }
interface Dependencies {
  projects: Pick<LocalProjectManager, "getProject">;
  research: Pick<ResearchJobManager, "get">;
  knowledge: Pick<KnowledgeStore, "get">;
  artifacts: Pick<ArtifactStore, "verify">;
  jobs: Pick<StudioJobs, "get">;
}
function validId(id: unknown): id is string { return typeof id === "string" && ID.test(id) && id.length <= 100; }
function evidenceDigest(item: KnowledgeVersion) {
  return sha256({ id: item.id, version: item.version, description: item.description,
    evidence: item.evidence.map(({ url, sourceHash, text, retrievedAt }) => ({ url, sourceHash, text, retrievedAt })) });
}
function isStoredBoard(value: unknown): value is EvidenceBoard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const board = value as Partial<EvidenceBoard>;
  return validId(board.projectId) && HASH.test(board.projectFingerprint || "") &&
    Number.isInteger(board.revision) && (board.revision || 0) >= 1 &&
    ["ACTIVE", "PAUSED", "CANCELLED"].includes(board.lifecycle || "") &&
    typeof board.brief === "string" && board.brief.length <= 4000 &&
    Array.isArray(board.sources) && board.sources.length <= MAX_LINKS && board.sources.every((s) =>
      validId(s?.jobId) && validId(s?.sourceId) && typeof s?.url === "string" && s.url.length <= 1500 &&
      HASH.test(s?.contentHash || "") && Number.isFinite(Date.parse(s?.retrievedAt || ""))) &&
    Array.isArray(board.knowledge) && board.knowledge.length <= MAX_LINKS && board.knowledge.every((k) =>
      validId(k?.id) && Number.isInteger(k?.version) && HASH.test(k?.evidenceDigest || "")) &&
    Array.isArray(board.jobs) && board.jobs.length <= MAX_LINKS && board.jobs.every((j) =>
      validId(j?.id) && typeof j?.modality === "string" && j.modality.length <= 40) &&
    Array.isArray(board.artifacts) && board.artifacts.length <= MAX_LINKS && board.artifacts.every((a) =>
      validId(a?.id) && HASH.test(a?.sha256 || "") && typeof a?.format === "string" && a.format.length <= 12 &&
      typeof a?.provider === "string" && a.provider.length <= 80 && typeof a?.model === "string" && a.model.length <= 120 &&
      (a.parentId === undefined || validId(a.parentId)) &&
      (a.estimatedCostUsd === undefined || Number.isFinite(a.estimatedCostUsd) && a.estimatedCostUsd >= 0)) &&
    Array.isArray(board.events) && board.events.length <= MAX_EVENTS && board.events.every((event) =>
      typeof event?.action === "string" && event.action.length <= 80 &&
      Number.isFinite(Date.parse(event?.at || "")) && Number.isInteger(event?.revision)) &&
    (board.briefReview === undefined || board.briefReview.meaning === "human_reviewed_not_fact_checked" &&
      HASH.test(board.briefReview.digest) && Number.isFinite(Date.parse(board.briefReview.reviewedAt))) &&
    (board.acceptance === undefined || board.acceptance.meaning === "human_accepted_for_manual_use" &&
      HASH.test(board.acceptance.digest) && Number.isFinite(Date.parse(board.acceptance.acceptedAt))) &&
    Number.isFinite(Date.parse(board.createdAt || "")) && Number.isFinite(Date.parse(board.updatedAt || ""));
}

/** Links the existing local project, approved research and private Studio artifacts.
 * Never contacts a provider, executes code, promotes a skill or labels source text verified.
 * This ledger is single-backend only; other stores also require distributed coordination.
 */
export class EvidenceBoardStore {
  private boards: EvidenceBoard[];
  constructor(private readonly file: string, private readonly deps: Dependencies,
    private readonly now: () => Date = () => new Date()) {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error("Evidence ledger needs private recovery.");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
      if (parsed.schema !== 1 || !Array.isArray(parsed.boards) || parsed.boards.length > MAX_BOARDS ||
          parsed.boards.some((board) => !isStoredBoard(board)) ||
          new Set(parsed.boards.map((board) => board.projectId)).size !== parsed.boards.length) {
        throw new Error("Evidence ledger needs private recovery.");
      }
      this.boards = parsed.boards;
    } else this.boards = [];
  }
  private persist(next: EvidenceBoard[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.lstatSync(path.dirname(this.file)).isSymbolicLink() ||
        fs.existsSync(this.file) && !fs.lstatSync(this.file).isFile()) throw new Error("Evidence ledger path needs review.");
    const payload = JSON.stringify({ schema: 1, boards: next } satisfies Snapshot);
    if (Buffer.byteLength(payload, "utf8") > MAX_LEDGER_BYTES) throw new Error("Evidence ledger is full; inspect before editing.");
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, payload, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACLs need platform review. */ }
      this.boards = next;
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private project(id: string): GeneralProject | null { return this.deps.projects.getProject(id)?.project || null; }
  private editable(board: EvidenceBoard, expectedRevision: unknown) {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== board.revision) {
      throw new EvidenceConflictError("Evidence board changed. Refresh and review the new revision before retrying.");
    }
    if (board.lifecycle !== "ACTIVE" || this.project(board.projectId)?.status !== "active") {
      throw new EvidenceConflictError("Resume the board and its general project before changing evidence.");
    }
  }
  private update(id: string, expectedRevision: unknown, action: string,
    change: (draft: EvidenceBoard) => void, allowPaused = false): EvidenceReport {
    const old = this.boards.find((board) => board.projectId === id);
    if (!old) throw new Error("Unknown evidence board; start it for an existing project.");
    if (!allowPaused) this.editable(old, expectedRevision);
    else if (!Number.isInteger(expectedRevision) || expectedRevision !== old.revision) {
      throw new EvidenceConflictError("Evidence board revision changed; refresh first.");
    }
    const draft = copy(old);
    change(draft);
    draft.revision++;
    draft.updatedAt = this.now().toISOString();
    draft.events.push({ action, at: draft.updatedAt, revision: draft.revision });
    draft.events = draft.events.slice(-MAX_EVENTS);
    const next = this.boards.map((item) => item.projectId === id ? draft : item);
    this.persist(next);
    return this.report(id)!;
  }
  create(projectId: unknown): EvidenceReport {
    if (!validId(projectId) || !projectId.startsWith("project-")) throw new Error("Choose an existing general project.");
    if (this.boards.some((board) => board.projectId === projectId)) throw new EvidenceConflictError("Evidence board already exists; reopen it.");
    const project = this.project(projectId);
    if (!project || project.status !== "active" || this.boards.length >= MAX_BOARDS) {
      throw new Error("An active general project and available private ledger are required.");
    }
    const at = this.now().toISOString();
    this.persist([...this.boards, { projectId, projectFingerprint: projectDigest(project),
      revision: 1, lifecycle: "ACTIVE", brief: "", sources: [], knowledge: [],
      jobs: [], artifacts: [], events: [{ action: "BOARD_CREATED", at, revision: 1 }], createdAt: at, updatedAt: at }]);
    return this.report(projectId)!;
  }
  report(projectId: string): EvidenceReport | null {
    const stored = this.boards.find((item) => item.projectId === projectId);
    if (!stored) return null;
    const board = copy(stored), project = this.project(projectId);
    const briefDigest = sha256({ projectId, projectFingerprint: board.projectFingerprint,
      brief: board.brief, sources: board.sources, knowledge: board.knowledge });
    const manifestDigest = sha256({ projectId, projectFingerprint: board.projectFingerprint,
      briefDigest, briefReview: board.briefReview?.digest,
      jobs: board.jobs, artifacts: board.artifacts });
    const issues: string[] = [];
    if (!project) issues.push("The original general project is missing.");
    else {
      if (project.status !== "active") issues.push("General project is not active; resume it separately.");
      if (projectDigest(project) !== board.projectFingerprint) issues.push("General project details changed; rebind only after reviewing the current title and description.");
    }
    if (!board.sources.length) issues.push("Link a completed research task and at least one retrieved source.");
    if (board.brief.length < 20) issues.push("Write a human-authored brief (20–4,000 characters).");
    for (const link of board.sources) {
      const job = this.deps.research.get(link.jobId);
      const source = job?.sources.find((entry) => entry.id === link.sourceId);
      if (job?.status !== "COMPLETED" || !source || source.status !== "retrieved_unverified" ||
          source.url !== link.url || source.contentHash !== link.contentHash || source.retrievedAt !== link.retrievedAt) {
        issues.push(`Research source ${link.sourceId} changed or was removed; relink fresh evidence.`);
      } else if (this.now().getTime() - Date.parse(source.retrievedAt) > SOURCE_AGE_MS ||
                 Date.parse(source.retrievedAt) > this.now().getTime() + 60_000) {
        issues.push(`Research source ${link.sourceId} is stale or future-dated; re-retrieve it.`);
      }
    }
    for (const link of board.knowledge) {
      const item = this.deps.knowledge.get(link.id);
      if (!item || item.version !== link.version || !["supported", "verified"].includes(item.status) ||
          Date.parse(item.expiresAt) <= this.now().getTime() || evidenceDigest(item) !== link.evidenceDigest ||
          !item.evidence.some((entry) => board.sources.some((source) => source.url === entry.url && source.contentHash === entry.sourceHash))) {
        issues.push(`Reviewed knowledge ${link.id} was changed, expired or lost its linked source.`);
      }
    }
    // Separate source/brief prerequisites from later file/job prerequisites.
    // Reviewing a brief must not require an artifact, but can never ignore a
    // stale project, source or reviewed-knowledge version.
    const briefBlockers = [...issues];
    const linkedJobs: EvidenceReport["linkedJobs"] = [];
    for (const link of board.jobs) {
      const job = this.deps.jobs.get(link.id);
      linkedJobs.push({ id: link.id, status: job?.status || "INTERRUPTED_OR_NOT_FOUND", artifactId: job?.artifactId });
      if (!job || job.status !== "COMPLETED" || !job.artifactId ||
          !board.artifacts.some((artifact) => artifact.id === job.artifactId)) {
        issues.push(`Studio job ${link.id} is unfinished, interrupted or missing its linked saved file.`);
      }
    }
    for (const link of board.artifacts) {
      const file = this.deps.artifacts.verify(link.id);
      if (!file || file.sha256 !== link.sha256 || file.format !== link.format ||
          file.parentId !== link.parentId || file.provider !== link.provider || file.model !== link.model) {
        issues.push(`Saved file ${link.id} is missing, changed or failed its integrity check.`);
      } else if (link.parentId && !this.deps.artifacts.verify(link.parentId)) {
        issues.push(`Original revision parent of ${link.id} is missing or damaged.`);
      }
    }
    if (board.briefReview?.digest !== briefDigest) issues.push("Human review of the exact brief and source links is required.");
    if (!board.artifacts.length) issues.push("Link at least one format-checked, saved Studio file.");
    let estimatedCostUsd: number | null = 0;
    for (const link of board.artifacts) {
      if (link.estimatedCostUsd === undefined) { estimatedCostUsd = null; break; }
      estimatedCostUsd += link.estimatedCostUsd;
    }
    const stale = issues.some((issue) => !issue.startsWith("Link at least one") && !issue.startsWith("Human review") &&
      !issue.startsWith("Write a human-authored") && !issue.startsWith("Link a completed")) ||
      Boolean(board.briefReview && board.briefReview.digest !== briefDigest || board.acceptance && board.acceptance.digest !== manifestDigest);
    const phase: EvidencePhase = board.lifecycle === "CANCELLED" ? "CANCELLED" :
      board.lifecycle === "PAUSED" || project?.status === "on_hold" ? "PAUSED" :
      stale ? "STALE" : board.acceptance?.digest === manifestDigest && issues.length === 0 ? "HUMAN_ACCEPTED" :
      board.artifacts.length && board.briefReview?.digest === briefDigest ? "AWAITING_FINAL_REVIEW" :
      board.briefReview?.digest === briefDigest ? "BRIEF_REVIEWED" : "DRAFT";
    return { project, board, currentProjectFingerprint: project ? projectDigest(project) : null,
      phase, briefDigest, manifestDigest, blockers: issues, briefBlockers, linkedJobs,
      estimatedCostUsd, warnings: [
        "Retrieved passages are unverified data; a reviewed brief is not a fact check.",
        "File validation checks bytes and format, not semantic quality, native Office compatibility or executable safety.",
        "Human acceptance permits manual use only; it never deploys code, publishes media or promotes a skill.",
        "Costs are estimates from saved artifacts, not provider invoices; failed attempts may still bill.",
      ], disclaimer: "Private owner-only project manifest. Not independently certified, signed, published or deployed." };
  }
  list(): EvidenceReport[] { return this.boards.map((board) => this.report(board.projectId)!); }
  rebindProject(id: string, expectedRevision: unknown, expectedProjectFingerprint: unknown) {
    return this.update(id, expectedRevision, "PROJECT_DETAILS_REVIEWED", (draft) => {
      const current = this.project(id);
      if (!current || current.status !== "active") throw new Error("Resume the existing general project first.");
      if (typeof expectedProjectFingerprint !== "string" ||
          expectedProjectFingerprint !== projectDigest(current)) {
        throw new EvidenceConflictError("General project changed again. Refresh and review its latest details before rebind.");
      }
      draft.projectFingerprint = expectedProjectFingerprint;
      draft.briefReview = undefined; draft.acceptance = undefined;
    });
  }
  setBrief(id: string, expectedRevision: unknown, value: unknown) {
    if (typeof value !== "string" || value.trim().length < 20 || value.length > 4000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || SENSITIVE.test(value)) {
      throw new Error("Write a 20–4,000 character human brief without credentials or control characters.");
    }
    return this.update(id, expectedRevision, "BRIEF_REVISED", (draft) => {
      draft.brief = value.trim(); draft.briefReview = undefined; draft.acceptance = undefined;
    });
  }
  linkSources(id: string, expectedRevision: unknown, jobId: unknown, sourceIds: unknown) {
    if (!validId(jobId) || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 5 ||
        sourceIds.some((sourceId) => !validId(sourceId)) || new Set(sourceIds).size !== sourceIds.length) {
      throw new Error("Select up to five distinct source IDs from a completed research task.");
    }
    const job = this.deps.research.get(jobId);
    if (!job || job.status !== "COMPLETED") throw new Error("Only a completed approved research task may supply sources.");
    const links = sourceIds.map((sourceId: string) => {
      const source = job.sources.find((entry) => entry.id === sourceId);
      if (!source || source.status !== "retrieved_unverified" || !HASH.test(source.contentHash) ||
          !Number.isFinite(Date.parse(source.retrievedAt)) || this.now().getTime() - Date.parse(source.retrievedAt) > SOURCE_AGE_MS ||
          Date.parse(source.retrievedAt) > this.now().getTime() + 60_000) throw new Error("Source is missing, too old or not retrieved.");
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || source.url.length > 1500) {
        throw new Error("Source URL did not pass explicit HTTPS document policy.");
      }
      return { jobId, sourceId, url: source.url, contentHash: source.contentHash, retrievedAt: source.retrievedAt };
    });
    return this.update(id, expectedRevision, "SOURCES_LINKED", (draft) => {
      if (draft.sources.length + links.length > MAX_LINKS || links.some((link) =>
        draft.sources.some((prior) => prior.sourceId === link.sourceId))) {
        throw new Error("Source links are duplicated or at the project limit.");
      }
      draft.sources.push(...links); draft.briefReview = undefined; draft.acceptance = undefined;
    });
  }
  linkKnowledge(id: string, expectedRevision: unknown, knowledgeId: unknown) {
    if (!validId(knowledgeId)) throw new Error("Choose a reviewed knowledge version.");
    const item = this.deps.knowledge.get(knowledgeId);
    if (!item || !["supported", "verified"].includes(item.status) || Date.parse(item.expiresAt) <= this.now().getTime()) {
      throw new Error("Only current human-reviewed knowledge can be linked; this is not an execution grant.");
    }
    return this.update(id, expectedRevision, "REVIEWED_KNOWLEDGE_LINKED", (draft) => {
      if (draft.knowledge.length >= MAX_LINKS || draft.knowledge.some((link) => link.id === knowledgeId) ||
          !item.evidence.some((entry) => draft.sources.some((source) => source.url === entry.url && source.contentHash === entry.sourceHash))) {
        throw new Error("The selected reviewed knowledge must share an existing project source and not be duplicated.");
      }
      draft.knowledge.push({ id: item.id, version: item.version, evidenceDigest: evidenceDigest(item) });
      draft.briefReview = undefined; draft.acceptance = undefined;
    });
  }
  linkJob(id: string, expectedRevision: unknown, jobId: unknown) {
    if (!validId(jobId)) throw new Error("Choose a Studio job ID.");
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new Error("The Studio job is unavailable; interrupted jobs need manual artifact review.");
    return this.update(id, expectedRevision, "STUDIO_JOB_LINKED", (draft) => {
      if (draft.jobs.length >= MAX_LINKS || draft.jobs.some((link) => link.id === jobId)) {
        throw new Error("Studio job already linked or board is full.");
      }
      draft.jobs.push({ id: job.id, modality: job.request.modality }); draft.acceptance = undefined;
    });
  }
  linkArtifact(id: string, expectedRevision: unknown, artifactId: unknown) {
    if (!validId(artifactId)) throw new Error("Choose a saved private Studio file.");
    const item = this.deps.artifacts.verify(artifactId);
    if (!item) throw new Error("Saved Studio artifact is missing or failed its on-disk integrity check.");
    if (item.estimatedCostUsd !== undefined &&
        (!Number.isFinite(item.estimatedCostUsd) || item.estimatedCostUsd < 0 || item.estimatedCostUsd > 100)) {
      throw new Error("Saved artifact has invalid estimated-cost metadata; review the private ledger.");
    }
    return this.update(id, expectedRevision, "SAVED_ARTIFACT_LINKED", (draft) => {
      if (draft.artifacts.length >= MAX_LINKS || draft.artifacts.some((link) => link.id === artifactId)) {
        throw new Error("Artifact already linked or project file limit reached.");
      }
      draft.artifacts.push({ id: item.id, sha256: item.sha256, format: item.format, parentId: item.parentId,
        provider: item.provider, model: item.model, estimatedCostUsd: item.estimatedCostUsd });
      draft.acceptance = undefined;
    });
  }
  unlink(id: string, expectedRevision: unknown, category: "sources" | "knowledge" | "jobs" | "artifacts", linkId: string) {
    if (!["sources", "knowledge", "jobs", "artifacts"].includes(category) || !validId(linkId)) throw new Error("Choose a known link to remove.");
    return this.update(id, expectedRevision, "LINK_REMOVED", (draft) => {
      const before = draft[category].length;
      if (category === "sources") draft.sources = draft.sources.filter((link) => link.sourceId !== linkId);
      else if (category === "knowledge") draft.knowledge = draft.knowledge.filter((link) => link.id !== linkId);
      else if (category === "jobs") draft.jobs = draft.jobs.filter((link) => link.id !== linkId);
      else draft.artifacts = draft.artifacts.filter((link) => link.id !== linkId);
      if (draft[category].length === before) throw new Error("Link not found; no project files were deleted.");
      if (category === "sources" || category === "knowledge") draft.briefReview = undefined;
      draft.acceptance = undefined;
    });
  }
  reviewBrief(id: string, expectedRevision: unknown, digest: unknown, acknowledgeUnverified: unknown) {
    const report = this.report(id);
    if (!report) throw new Error("Unknown evidence board.");
    if (acknowledgeUnverified !== true || digest !== report.briefDigest || report.briefBlockers.length) {
      throw new EvidenceConflictError("Review the exact fresh sources and human brief; source text is not independently verified.");
    }
    return this.update(id, expectedRevision, "BRIEF_HUMAN_REVIEWED", (draft) => {
      draft.briefReview = { digest: report.briefDigest, reviewedAt: this.now().toISOString(),
        meaning: "human_reviewed_not_fact_checked" }; draft.acceptance = undefined;
    });
  }
  accept(id: string, expectedRevision: unknown, digest: unknown, acknowledgeLimitations: unknown) {
    const report = this.report(id);
    if (!report || acknowledgeLimitations !== true || digest !== report.manifestDigest || report.blockers.length ||
        report.board.lifecycle !== "ACTIVE") {
      throw new EvidenceConflictError("Review fresh evidence, the exact saved files and all limitations before accepting manual use.");
    }
    return this.update(id, expectedRevision, "HUMAN_ACCEPTED_MANUAL_USE", (draft) => {
      draft.acceptance = { digest: report.manifestDigest, acceptedAt: this.now().toISOString(),
        meaning: "human_accepted_for_manual_use" };
    });
  }
  setLifecycle(id: string, expectedRevision: unknown, lifecycle: unknown) {
    if (!["ACTIVE", "PAUSED", "CANCELLED"].includes(String(lifecycle))) throw new Error("Choose pause, cancel or explicit resume.");
    return this.update(id, expectedRevision, `BOARD_${lifecycle}`, (draft) => {
      if (draft.lifecycle === lifecycle) throw new EvidenceConflictError("Board already has this state.");
      draft.lifecycle = lifecycle as BoardLifecycle;
      // Cancelling a project board never deletes its files or cancels a distinct Studio job.
      draft.acceptance = undefined;
    }, true);
  }
}
