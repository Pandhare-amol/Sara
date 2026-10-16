import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EvidenceBoardStore } from "../src/core/projects/evidenceBoard";
import { LocalProjectManager } from "../src/services/LocalProjectManager";
import { KnowledgeStore } from "../src/core/research/knowledgeStore";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { synthesizeToneSequence } from "../src/core/studio/toneSequence";
import type { ResearchJobManager, ResearchJob, SourceRecord } from "../src/core/research/researchEngine";
import type { StudioJobs, StudioJob } from "../src/core/studio/studioJobs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-evidence-measure-"));
const rssStartMiB = process.memoryUsage().rss / 1048576, cpuStart = process.cpuUsage();
const result: Record<string, unknown> = { classification: "offline local fixture only; no live citation, provider, Docker or native Office",
  measuredAt: new Date().toISOString(), sourceProvenance: "pre-seeded fixture record", providerCalls: 0 };
const measured = (label: string, action: () => void) => {
  const start = performance.now(); action(); result[label] = Number((performance.now() - start).toFixed(2));
};
try {
  const projects = new LocalProjectManager(path.join(root, "general-projects.json"));
  const project = projects.createProject({ title: "Isolated measurement" });
  const knowledge = new KnowledgeStore(path.join(root, "knowledge.json"));
  const artifacts = new ArtifactStore(path.join(root, "studio"));
  const source: SourceRecord = { id: randomUUID(), url: "https://example.com/fixture", title: "Fixture, not live",
    retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update("not retrieved").digest("hex"),
    passages: ["This is an isolated test passage and not an external citation."],
    status: "retrieved_unverified", sourceType: "web_document" };
  const task: ResearchJob = { id: randomUUID(), question: "Local provenance fixture", urls: [source.url],
    status: "COMPLETED", sources: [source], failures: [], findingsStatus: "unresolved" };
  const jobs = new Map<string, StudioJob>();
  const board = new EvidenceBoardStore(path.join(root, "research", "project-evidence.json"), {
    projects, knowledge, artifacts,
    research: { get: (id: string) => id === task.id ? task : undefined } as Pick<ResearchJobManager, "get">,
    jobs: { get: (id: string) => jobs.get(id) } as Pick<StudioJobs, "get">,
  });
  let report = board.create(project.id);
  measured("linkSourceMs", () => { report = board.linkSources(project.id, report.board.revision, task.id, [source.id]); });
  measured("saveBriefMs", () => { report = board.setBrief(project.id, report.board.revision,
    "I reviewed a local fixture; no factual claims or live retrieval were independently checked."); });
  measured("reviewBriefMs", () => { report = board.reviewBrief(project.id, report.board.revision, report.briefDigest, true); });
  let savedId = "";
  measured("saveAndValidateWavMs", () => {
    const item = artifacts.save({ kind: "tone", format: "wav", bytes: synthesizeToneSequence("C4:1 E4:1", 120),
      prompt: "C4:1 E4:1", provider: "local-synthesizer", model: "fixture-v1", estimatedCostUsd: 0 });
    savedId = item.id;
  });
  const jobId = randomUUID();
  jobs.set(jobId, { id: jobId, status: "COMPLETED", request: { modality: "tone-sequence", format: "wav", prompt: "C4:1 E4:1" },
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifactId: savedId });
  measured("linkValidatedJobAndFileMs", () => {
    report = board.linkJob(project.id, report.board.revision, jobId);
    report = board.linkArtifact(project.id, report.board.revision, savedId);
  });
  measured("humanAcceptanceMs", () => { report = board.accept(project.id, report.board.revision, report.manifestDigest, true); });
  if (report.phase !== "HUMAN_ACCEPTED" || !artifacts.verify(savedId)) throw new Error("Fixture never produced a durable checked manifest.");
  measured("recheckManifestMs", () => {
    if (board.report(project.id)?.phase !== "HUMAN_ACCEPTED") throw new Error("Manifest integrity check failed.");
  });
  const cpu = process.cpuUsage(cpuStart);
  result.cpuUserMs = Number((cpu.user / 1000).toFixed(2));
  result.cpuSystemMs = Number((cpu.system / 1000).toFixed(2));
  result.rssStartMiB = Number(rssStartMiB.toFixed(1));
  result.rssEndMiB = Number((process.memoryUsage().rss / 1048576).toFixed(1));
  result.savedArtifactBytes = artifacts.read(savedId)!.bytes.length;
  result.note = "One local process, one run, no warmup, parallel clients, live provider or billable request. Not a production latency target.";
  console.log(JSON.stringify(result, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
