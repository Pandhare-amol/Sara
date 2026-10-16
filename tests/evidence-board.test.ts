import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EvidenceBoardStore, EvidenceConflictError } from "../src/core/projects/evidenceBoard";
import { LocalProjectManager } from "../src/services/LocalProjectManager";
import { KnowledgeStore } from "../src/core/research/knowledgeStore";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import type { SourceRecord, ResearchJob } from "../src/core/research/researchEngine";
import type { StudioJob } from "../src/core/studio/studioJobs";
import type { ResearchJobManager } from "../src/core/research/researchEngine";
import type { StudioJobs } from "../src/core/studio/studioJobs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-evidence-board-"));
  const projects = new LocalProjectManager(path.join(root, "general-projects.json"));
  const project = projects.createProject({ title: "Owner's reviewed plan", description: "Keep source and output provenance" });
  const knowledge = new KnowledgeStore(path.join(root, "knowledge.json"));
  const artifacts = new ArtifactStore(path.join(root, "studio"));
  const source: SourceRecord = { id: randomUUID(), url: "https://example.com/docs", title: "Fixture page",
    retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update("fixture body").digest("hex"),
    passages: ["A fixture passage with sufficient words for the human reviewer to inspect and compare."],
    status: "retrieved_unverified", sourceType: "web_document" };
  const researchJob: ResearchJob = { id: randomUUID(), question: "What was retrieved?", urls: [source.url],
    sources: [source], failures: [], status: "COMPLETED", findingsStatus: "unresolved" };
  const research = new Map([[researchJob.id, researchJob]]);
  const jobs = new Map<string, StudioJob>();
  const file = path.join(root, "private", "project-evidence.json");
  const deps = {
    projects,
    research: { get: (id: string) => research.get(id) } as Pick<ResearchJobManager, "get">,
    knowledge, artifacts,
    jobs: { get: (id: string) => jobs.get(id) } as Pick<StudioJobs, "get">,
  };
  const board = new EvidenceBoardStore(file, deps);
  return { root, file, project, source, researchJob, research, jobs, projects, knowledge, artifacts, deps, board };
}
function brief() { return "Human-authored summary of this fixture's retrieved text, pending review of factual claims."; }
function validBrief(f: ReturnType<typeof fixture>) {
  let report = f.board.create(f.project.id);
  report = f.board.linkSources(f.project.id, report.board.revision, f.researchJob.id, [f.source.id]);
  report = f.board.setBrief(f.project.id, report.board.revision, brief());
  report = f.board.reviewBrief(f.project.id, report.board.revision, report.briefDigest, true);
  assert.equal(report.phase, "BRIEF_REVIEWED");
  return report;
}

test("real private manifest links existing project, retrieved source, reviewed brief and verified disk artifact", () => {
  const f = fixture();
  try {
    let report = f.board.create(f.project.id);
    assert.equal(report.phase, "DRAFT");
    assert.throws(() => f.board.reviewBrief(f.project.id, report.board.revision, report.briefDigest, true), EvidenceConflictError);
    report = f.board.linkSources(f.project.id, report.board.revision, f.researchJob.id, [f.source.id]);
    assert.equal(report.board.sources[0].contentHash, f.source.contentHash);
    assert.throws(() => f.board.linkSources(f.project.id, report.board.revision, f.researchJob.id, [f.source.id]), /duplicated/);
    report = f.board.setBrief(f.project.id, report.board.revision, brief());
    const proposed = f.knowledge.propose({ name: "Reviewed topic", kind: "topic", platform: "any", description: "Source-grounded topic summary",
      intendedUse: "Reference, not an execution grant", expiresInDays: 30 }, [f.source]);
    const approved = f.knowledge.review(proposed.id);
    report = f.board.linkKnowledge(f.project.id, report.board.revision, approved.id);
    assert.equal(report.board.knowledge[0].version, approved.version);
    assert.throws(() => f.board.reviewBrief(f.project.id, report.board.revision, "0".repeat(64), true), EvidenceConflictError);
    report = f.board.reviewBrief(f.project.id, report.board.revision, report.briefDigest, true);
    const original = f.artifacts.save({ kind: "text", format: "md", bytes: Buffer.from("# Evidence-backed draft\nStill unverified."),
      prompt: "An approved fixture draft", provider: "fixture", model: "local", estimatedCostUsd: 0 });
    const job: StudioJob = { id: randomUUID(), status: "COMPLETED", request: { modality: "text", format: "md", prompt: "Fixture draft" },
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifactId: original.id };
    f.jobs.set(job.id, job);
    report = f.board.linkJob(f.project.id, report.board.revision, job.id);
    assert.match(report.blockers.join("; "), /missing its linked saved file/);
    report = f.board.linkArtifact(f.project.id, report.board.revision, original.id);
    assert.equal(report.phase, "AWAITING_FINAL_REVIEW");
    assert.equal(report.estimatedCostUsd, 0);
    assert.throws(() => f.board.accept(f.project.id, report.board.revision - 1, report.manifestDigest, true), EvidenceConflictError);
    assert.throws(() => f.board.accept(f.project.id, report.board.revision, "0".repeat(64), true), EvidenceConflictError);
    report = f.board.accept(f.project.id, report.board.revision, report.manifestDigest, true);
    assert.equal(report.phase, "HUMAN_ACCEPTED");
    assert.equal(report.board.acceptance?.meaning, "human_accepted_for_manual_use");
    assert.ok(report.disclaimer.includes("Not independently certified"));
    assert.equal(new EvidenceBoardStore(f.file, f.deps).report(f.project.id)?.phase, "HUMAN_ACCEPTED");
    if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    f.projects.updateProject(f.project.id, { title: "Renamed after approval" });
    const changed = f.board.report(f.project.id)!;
    assert.equal(changed.phase, "STALE", "A legacy project rename cannot inherit the old approval.");
    assert.throws(() => f.board.rebindProject(f.project.id, report.board.revision, undefined), EvidenceConflictError);
    f.projects.updateProject(f.project.id, { description: "Changed again before rebind" });
    assert.throws(() => f.board.rebindProject(f.project.id, report.board.revision,
      changed.currentProjectFingerprint), EvidenceConflictError, "Stale displayed project details cannot be approved.");
    report = f.board.rebindProject(f.project.id, report.board.revision,
      f.board.report(f.project.id)!.currentProjectFingerprint);
    assert.equal(report.board.acceptance, undefined);
    report = f.board.reviewBrief(f.project.id, report.board.revision, report.briefDigest, true);
    report = f.board.accept(f.project.id, report.board.revision, report.manifestDigest, true);
    assert.equal(report.phase, "HUMAN_ACCEPTED");

    const revision = f.artifacts.save({ kind: "text", format: "md", bytes: Buffer.from("# Revision\nDifferent contents."),
      prompt: "Revise without overwriting", parentId: original.id, provider: "fixture", model: "local", estimatedCostUsd: 0 });
    report = f.board.linkArtifact(f.project.id, report.board.revision, revision.id);
    assert.equal(report.phase, "AWAITING_FINAL_REVIEW", "A new file invalidates prior human acceptance.");
    assert.equal(f.artifacts.read(original.id)?.bytes.toString("utf8"), "# Evidence-backed draft\nStill unverified.");
    assert.equal(report.board.acceptance, undefined);
    fs.appendFileSync(path.join(f.root, "studio", "artifacts", revision.fileName), "tampered");
    assert.equal(f.board.report(f.project.id)?.phase, "STALE");
    assert.throws(() => f.board.accept(f.project.id, report.board.revision, report.manifestDigest, true), EvidenceConflictError);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("stale sources, revised knowledge, cancellation and restart remain fail-closed without deleting files", () => {
  const f = fixture();
  try {
    let report = validBrief(f);
    const item = f.knowledge.propose({ name: "Fresh topic", kind: "topic", platform: "any", description: "Human source summary",
      intendedUse: "Read only", expiresInDays: 30 }, [f.source]);
    const reviewed = f.knowledge.review(item.id);
    report = f.board.linkKnowledge(f.project.id, report.board.revision, reviewed.id);
    assert.equal(report.phase, "DRAFT", "New evidence link needs a fresh brief review.");
    report = f.board.reviewBrief(f.project.id, report.board.revision, report.briefDigest, true);
    f.knowledge.review(item.id);
    assert.equal(f.board.report(f.project.id)?.phase, "STALE");
    assert.match(f.board.report(f.project.id)!.blockers.join("; "), /changed, expired/);
    report = f.board.setLifecycle(f.project.id, report.board.revision, "PAUSED");
    assert.equal(report.phase, "PAUSED");
    assert.throws(() => f.board.linkArtifact(f.project.id, report.board.revision, randomUUID()), /missing|resume/i);
    report = f.board.setLifecycle(f.project.id, report.board.revision, "CANCELLED");
    assert.equal(report.phase, "CANCELLED");
    assert.equal(f.research.get(f.researchJob.id)?.status, "COMPLETED", "A board change must not cancel a separate research task.");
    report = f.board.setLifecycle(f.project.id, report.board.revision, "ACTIVE");
    assert.equal(report.phase, "STALE");
    f.researchJob.status = "FAILED";
    assert.match(f.board.report(f.project.id)!.blockers.join("; "), /changed or was removed/);
    assert.equal(new EvidenceBoardStore(f.file, f.deps).report(f.project.id)?.phase, "STALE");
    assert.throws(() => f.board.setBrief(f.project.id, report.board.revision - 1, brief()), EvidenceConflictError);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("evidence ledger refuses symlinks, corruption, unapproved source input and forged artifacts", () => {
  const f = fixture();
  try {
    const report = f.board.create(f.project.id);
    assert.throws(() => f.board.linkSources(f.project.id, report.board.revision, f.researchJob.id, [randomUUID()]), /missing/);
    assert.throws(() => f.board.linkArtifact(f.project.id, report.board.revision, randomUUID()), /missing/);
    assert.throws(() => f.board.setBrief(f.project.id, report.board.revision, "API_KEY=not-for-this-file and a secret"), /credentials/);
    fs.writeFileSync(f.file, "not JSON");
    assert.throws(() => new EvidenceBoardStore(f.file, f.deps), /JSON|recovery/);
    fs.rmSync(f.file);
    fs.symlinkSync(path.join(f.root, "general-projects.json"), f.file);
    assert.throws(() => new EvidenceBoardStore(f.file, f.deps), /recovery/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
