import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

async function port() {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function until(check: () => Promise<boolean>, deadlineMs = 20_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* backend or job still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated evidence-board HTTP fixture timed out.");
}

test("owner board links fixture provenance and real offline artifact; stale files and protected mode revoke acceptance",
  { timeout: 55_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-evidence-http-"));
    const admin = "test-owner-secret-long-enough-for-isolation";
    const researchTaskId = randomUUID(), sourceId = randomUUID();
    const source = { id: sourceId, url: "https://example.com/public-document", title: "Isolated fixture only",
      retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update("a local fixture, not a live citation").digest("hex"),
      passages: ["Fixture passages are not evidence of a live web request."],
      status: "retrieved_unverified", sourceType: "web_document" };
    fs.mkdirSync(path.join(root, "research"), { recursive: true });
    fs.writeFileSync(path.join(root, "research", "jobs.json"), JSON.stringify({ schema: 1, dailyUsage: [], jobs: [
      { id: researchTaskId, question: "Local HTTP contract fixture", urls: [source.url], status: "COMPLETED",
        sources: [source], failures: [], findingsStatus: "unresolved", finishedAt: new Date().toISOString() },
    ] }), { mode: 0o600 });
    const serverPort = await port(), base = `http://127.0.0.1:${serverPort}`;
    let child: ChildProcess | undefined, output = "";
    const call = async (route: string, method = "GET", body?: unknown, token = "") => {
      const response = await fetch(base + route, { method, headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { "x-admin-token": token } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json().catch(() => ({})) as any,
        cache: response.headers.get("cache-control") || "" };
    };
    try {
      child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], { cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"], env: {
          ...process.env, PORT: String(serverPort), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1",
          SARA_DATA_DIR: root, SARA_ADMIN_TOKEN: admin, SARA_AUTO_MEMORY: "false", GEMINI_API_KEY: "",
          SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "non-generating-local-fixture",
          SARA_TEXT_API_BASE_URL: "http://127.0.0.1:9/v1", SARA_TEXT_API_KEY: "fixture-only",
        } });
      child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-1200); });
      child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-1200); });
      await until(async () => (await fetch(base + "/api/models/status")).ok);
      const project = (await call("/api/projects", "POST", { title: "Evidence-focused launch", description: "Fixture only" })).data.project;
      assert.ok(project?.id);
      const prefix = `/api/projects/${encodeURIComponent(project.id)}/evidence`;
      assert.equal((await call(prefix)).status, 403);
      assert.equal((await call(prefix, "POST", { confirm: true })).status, 403);
      assert.equal((await call("/api/owner/release-readiness")).status, 403);
      assert.equal((await call(prefix, "POST", {}, admin)).status, 400);
      let result = await call(prefix, "POST", { confirm: true }, admin);
      assert.equal(result.status, 201, JSON.stringify(result.data) + output);
      assert.match(result.cache, /no-store/);
      assert.equal(result.data.report.phase, "DRAFT");
      const readiness = await call("/api/owner/release-readiness", "GET", undefined, admin);
      assert.equal(readiness.status, 200);
      assert.equal(readiness.data.status, "BLOCKED", "The known tracked-path gate must remain visible, never hidden by the UI.");
      assert.ok(readiness.data.total > 0);
      assert.ok(!JSON.stringify(readiness.data).includes(".pnpm-store/"), "No tracked path or file contents in release status.");

      result = await call(prefix + "/sources", "POST", { confirm: true, expectedRevision: result.data.report.board.revision,
        researchTaskId, sourceIds: [sourceId] }, admin);
      assert.equal(result.status, 200);
      result = await call(prefix + "/brief", "PUT", { confirm: true, expectedRevision: result.data.report.board.revision,
        brief: "I read the fixture text and wrote this summary by hand. It is not independently fact checked." }, admin);
      assert.equal(result.status, 200);
      const staleRevision = result.data.report.board.revision - 1;
      assert.equal((await call(prefix + "/brief/review", "POST", { confirm: true,
        expectedRevision: staleRevision, digest: result.data.report.briefDigest, acknowledgeUnverified: true }, admin)).status, 409);
      assert.equal((await call(prefix + "/brief/review", "POST", { confirm: true,
        expectedRevision: result.data.report.board.revision, digest: "0".repeat(64), acknowledgeUnverified: true }, admin)).status, 409);
      result = await call(prefix + "/brief/review", "POST", { confirm: true,
        expectedRevision: result.data.report.board.revision, digest: result.data.report.briefDigest,
        acknowledgeUnverified: true }, admin);
      assert.equal(result.status, 200);
      assert.equal(result.data.report.phase, "BRIEF_REVIEWED");
      const tone = await call("/api/studio/jobs", "POST", { confirm: true, modality: "tone-sequence", format: "wav",
        prompt: "C4:1 D4:1 E4:1 R:1", bpm: 120 }, admin);
      assert.equal(tone.status, 202);
      const jobId = tone.data.job.id as string;
      await until(async () => (await call(`/api/studio/jobs/${jobId}`, "GET", undefined, admin)).data.job?.status === "COMPLETED");
      const artifactId = (await call(`/api/studio/jobs/${jobId}`, "GET", undefined, admin)).data.job.artifactId as string;
      result = await call(prefix + "/jobs", "POST", { confirm: true, expectedRevision: result.data.report.board.revision, jobId }, admin);
      assert.equal(result.status, 200);
      assert.match(result.data.report.blockers.join("; "), /missing its linked saved file/);
      result = await call(prefix + "/artifacts", "POST", { confirm: true, expectedRevision: result.data.report.board.revision, artifactId }, admin);
      assert.equal(result.status, 200);
      assert.equal(result.data.report.phase, "AWAITING_FINAL_REVIEW");
      assert.equal((await call(prefix + "/accept", "POST", { confirm: true, expectedRevision: result.data.report.board.revision,
        digest: result.data.report.manifestDigest }, admin)).status, 409);
      result = await call(prefix + "/accept", "POST", { confirm: true, expectedRevision: result.data.report.board.revision,
        digest: result.data.report.manifestDigest, acknowledgeLimitations: true }, admin);
      assert.equal(result.status, 200);
      assert.equal(result.data.report.phase, "HUMAN_ACCEPTED");
      const manifest = await fetch(base + prefix + "/manifest", { headers: { "x-admin-token": admin } });
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers.get("content-disposition") || "", /attachment/);
      const exported = await manifest.json() as any;
      assert.equal(exported.phase, "HUMAN_ACCEPTED");
      assert.equal(exported.board.sources[0].contentHash, source.contentHash);
      assert.equal(exported.board.artifacts[0].id, artifactId);
      assert.ok(!JSON.stringify(exported).includes("data:audio"), "Manifest links metadata, not private file bytes.");
      const bytes = await fetch(base + `/api/studio/artifacts/${artifactId}/download`, { headers: { "x-admin-token": admin } });
      assert.equal(Buffer.from(await bytes.arrayBuffer()).toString("ascii", 0, 4), "RIFF");

      assert.equal((await call(`/api/projects/${project.id}`, "PATCH", { title: "Revised launch" })).status, 200);
      let changed = await call(prefix, "GET", undefined, admin);
      assert.equal(changed.data.report.phase, "STALE");
      assert.equal((await call(prefix + "/project-details/review", "POST", {
        confirm: true, expectedRevision: changed.data.report.board.revision }, admin)).status, 409);
      assert.equal((await call(`/api/projects/${project.id}`, "PATCH", { description: "Changed again" })).status, 200);
      assert.equal((await call(prefix + "/project-details/review", "POST", {
        confirm: true, expectedRevision: changed.data.report.board.revision,
        currentProjectFingerprint: changed.data.report.currentProjectFingerprint }, admin)).status, 409,
      "A project changed after the displayed review must not be rebound.");
      changed = await call(prefix, "GET", undefined, admin);
      result = await call(prefix + "/project-details/review", "POST", {
        confirm: true, expectedRevision: changed.data.report.board.revision,
        currentProjectFingerprint: changed.data.report.currentProjectFingerprint }, admin);
      assert.equal(result.status, 200);
      assert.equal(result.data.report.board.acceptance, undefined);
      assert.equal(result.data.report.board.briefReview, undefined);
      result = await call(prefix + "/brief/review", "POST", {
        confirm: true, expectedRevision: result.data.report.board.revision,
        digest: result.data.report.briefDigest, acknowledgeUnverified: true }, admin);
      assert.equal(result.status, 200);
      result = await call(prefix + "/accept", "POST", {
        confirm: true, expectedRevision: result.data.report.board.revision,
        digest: result.data.report.manifestDigest, acknowledgeLimitations: true }, admin);
      assert.equal(result.data.report.phase, "HUMAN_ACCEPTED");
      assert.equal((await call(`/api/studio/artifacts/${artifactId}`, "DELETE", { confirm: true }, admin)).status, 200);
      assert.equal((await call(prefix, "GET", undefined, admin)).data.report.phase, "STALE",
        "Deleting a saved file revokes the board's current acceptance without forging a new output.");
      assert.equal((await call("/api/users/bootstrap", "POST", { adminSecret: admin, displayName: "Owner" })).status, 201);
      for (const [route, method] of [[prefix, "GET"], [prefix, "POST"], [prefix + "/manifest", "GET"],
        [prefix + "/accept", "POST"], ["/api/owner/release-readiness", "GET"]]) {
        assert.equal((await call(route, method, method === "POST" ? { confirm: true } : undefined, admin)).status, 403,
          `${method} ${route} must stay private in protected mode`);
      }
    } finally {
      child?.kill("SIGTERM");
      if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child?.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
