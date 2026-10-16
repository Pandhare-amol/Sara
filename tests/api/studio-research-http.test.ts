import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); return address.port;
}
async function freePort() { const server = createServer((_, res) => res.end()); const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function until(check: () => Promise<boolean>, timeout = 18_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Isolated studio HTTP fixture timed out.");
}

test("owner-only research and creation APIs save real verified files but never trust forged evidence or protected sessions", { timeout: 50_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara13-14-http-"));
  const admin = "isolated-local-admin-secret-long-enough-for-tests";
  let heldStarted = 0; let releaseHeld!: () => void; let protectedStarted = 0; let protectedReplied = 0; let releaseProtected!: () => void;
  const heldCreation = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const heldProtected = new Promise<void>((resolve) => { releaseProtected = resolve; });
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    if (body.includes("HOLD_STUDIO_PROTECTED")) { protectedStarted++; await heldProtected; }
    else if (body.includes("HOLD_STUDIO")) { heldStarted++; await heldCreation; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "# Provider-generated report\nThis is a real Markdown file from a test fixture." } }],
      usage: { prompt_tokens: 12, completion_tokens: 16 } }));
    if (body.includes("HOLD_STUDIO_PROTECTED")) protectedReplied++;
  });
  const providerPort = await listen(provider);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined; let logs = "";
  const call = async (route: string, method = "GET", body?: unknown, auth = "") => {
    const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}),
      ...(auth ? { "x-admin-token": auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  try {
    child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], { cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), SARA_BIND_HOST: "127.0.0.1",
        SARA_SUPERVISOR: "1", SARA_DATA_DIR: root, SARA_ADMIN_TOKEN: admin, SARA_AUTO_MEMORY: "false",
        GEMINI_API_KEY: "", SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fixture-text",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
        SARA_IMAGE_PROVIDER: "", SARA_AUDIO_PROVIDER: "" },
    });
    child.stdout?.on("data", (chunk) => { logs += String(chunk).slice(0, 600); });
    child.stderr?.on("data", (chunk) => { logs += String(chunk).slice(0, 600); });
    await until(async () => (await fetch(base + "/api/models/status")).ok);
    assert.equal((await call("/api/studio/capabilities")).status, 403);
    assert.equal((await call("/api/research/tasks")).status, 403);
    assert.equal((await call("/api/knowledge")).status, 403);
    assert.equal((await call("/api/refresh/plans")).status, 403);
    assert.equal((await call("/api/skills/verifications")).status, 403);
    assert.equal((await call("/api/models/test", "POST", { role: "creation", confirm: true })).status, 403);
    const status = await call("/api/studio/capabilities", "GET", undefined, admin);
    assert.equal(status.status, 200, logs.slice(-250));
    assert.equal(status.body.capabilities.find((c: any) => c.modality === "image").configured, false);
    assert.equal(status.body.capabilities.find((c: any) => c.modality === "text").connection, "untested");
    assert.equal((await call("/api/studio/jobs", "POST", { modality: "text", format: "md", prompt: "Write a report" }, admin)).status, 400);
    assert.equal((await call("/api/research/tasks", "POST", { question: "Find a source", urls: ["http://127.0.0.1/private"], confirm: true }, admin)).status, 400);
    const forged = await call("/api/knowledge", "POST", { name: "Invented", kind: "skill", sourceIds: ["invented"],
      testEvidence: { passed: true }, confirm: true }, admin);
    assert.notEqual(forged.status, 201);
    assert.equal((await call("/api/knowledge/forged/review", "POST", { confirm: true, testEvidence: { passed: true } }, admin)).status, 400);
    const unconfiguredTest = await call("/api/skills/verifications", "POST", { skillId: "forged", codeArtifactId: "forged",
      testSource: "import unittest\nclass T(unittest.TestCase): pass", confirm: true }, admin);
    assert.equal(unconfiguredTest.status, 400);
    assert.match(unconfiguredTest.body.error, /not configured/);
    assert.deepEqual((await call("/api/skills/verifications", "GET", undefined, admin)).body.attempts, []);
    const submitted = await call("/api/studio/jobs", "POST", { modality: "text", format: "md",
      prompt: "Write a report", confirm: true }, admin);
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body) + logs.slice(-400));
    const id = submitted.body.job.id as string;
    await until(async () => ["COMPLETED", "FAILED"].includes((await call(`/api/studio/jobs/${id}`, "GET", undefined, admin)).body.job?.status));
    const job = await call(`/api/studio/jobs/${id}`, "GET", undefined, admin);
    assert.equal(job.body.job.status, "COMPLETED", JSON.stringify(job.body) + logs.slice(-500));
    const artifactId = job.body.job.artifactId as string;
    const download = await fetch(`${base}/api/studio/artifacts/${artifactId}/download`, { headers: { "x-admin-token": admin } });
    assert.equal(download.status, 200);
    assert.match(await download.text(), /Provider-generated report/);
    assert.match(download.headers.get("content-disposition") || "", /attachment/);
    assert.equal((await call(`/api/studio/artifacts/${artifactId}/export-pdf`, "POST", { confirm: true }, admin)).status, 201);
    const word = await call(`/api/studio/artifacts/${artifactId}/export-office`, "POST", { format: "docx", confirm: true }, admin);
    const slides = await call(`/api/studio/artifacts/${artifactId}/export-office`, "POST", { format: "pptx", confirm: true }, admin);
    assert.equal(word.status, 201); assert.equal(slides.status, 201);
    const officeDownload = await fetch(`${base}/api/studio/artifacts/${word.body.artifact.id}/download`, { headers: { "x-admin-token": admin } });
    assert.equal(officeDownload.status, 200);
    assert.equal(Buffer.from(await officeDownload.arrayBuffer()).subarray(0, 4).toString("hex"), "504b0304");
    assert.equal((await call("/api/studio/artifacts", "GET", undefined, admin)).body.artifacts.length, 4);
    assert.equal(fs.readdirSync(path.join(root, "studio", "artifacts")).length, 4);
    const mesh = await call("/api/studio/jobs", "POST", { modality: "3d-primitive", format: "obj",
      prompt: "Make a simple sphere for manual editing", shape: "sphere", dimensions: { width: 1, height: 1, depth: 1 }, confirm: true }, admin);
    assert.equal(mesh.status, 202);
    await until(async () => (await call(`/api/studio/jobs/${mesh.body.job.id}`, "GET", undefined, admin)).body.job?.status === "COMPLETED");
    const meshJob = (await call(`/api/studio/jobs/${mesh.body.job.id}`, "GET", undefined, admin)).body.job;
    const meshResponse = await fetch(`${base}/api/studio/artifacts/${meshJob.artifactId}/download`, { headers: { "x-admin-token": admin } });
    assert.equal(meshResponse.status, 200); assert.match(await meshResponse.text(), /\no SARA_sphere\n/);
    assert.equal((await call("/api/studio/artifacts", "GET", undefined, admin)).body.artifacts.find((entry: any) => entry.id === meshJob.artifactId).geometry.triangles, 720);
    const slow = await call("/api/studio/jobs", "POST", { modality: "text", format: "md", prompt: "HOLD_STUDIO creative draft",
      confirm: true }, admin);
    assert.equal(slow.status, 202);
    await until(async () => heldStarted === 1);
    const chatAt = Date.now();
    const chat = await call("/api/chat", "POST", { text: "Can we continue talking while a draft is pending?", source: "desktop" });
    assert.equal(chat.status, 200);
    assert.ok(Date.now() - chatAt < 2000, "chat must not wait for a held creative provider request");
    assert.equal((await call(`/api/studio/jobs/${slow.body.job.id}/cancel`, "POST", undefined, admin)).status, 200);
    releaseHeld();
    await until(async () => (await call(`/api/studio/jobs/${slow.body.job.id}`, "GET", undefined, admin)).body.job?.status === "CANCELLED");
    assert.equal((await call(`/api/studio/artifacts/${artifactId}/download`)).status, 403);
    const concurrent = await call("/api/studio/jobs", "POST", { modality: "text", format: "md",
      prompt: "HOLD_STUDIO_PROTECTED pending draft", confirm: true }, admin);
    assert.equal(concurrent.status, 202);
    await until(async () => protectedStarted === 1);
    assert.equal((await call("/api/users/bootstrap", "POST", { displayName: "Owner", adminSecret: admin })).status, 201);
    releaseProtected();
    await until(async () => protectedReplied === 1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(fs.readdirSync(path.join(root, "studio", "artifacts")).length, 5,
      "protected-mode transition must discard a pending creation before any new artifact is saved");
    for (const [route, method] of [["/api/studio/capabilities", "GET"], ["/api/studio/jobs", "POST"],
      ["/api/studio/artifacts", "GET"], [`/api/studio/artifacts/${artifactId}/download`, "GET"],
      ["/api/research/tasks", "GET"], ["/api/knowledge", "GET"], ["/api/refresh/plans", "GET"],
      ["/api/skills/verifications", "GET"], ["/api/skills/verifications", "POST"]]) {
      assert.equal((await call(route, method, method === "POST" ? { modality: "text", prompt: "New", format: "md", confirm: true } : undefined, admin)).status, 403,
        `${route} must stay closed in protected mode`);
    }
    assert.equal(fs.readdirSync(path.join(root, "studio", "artifacts")).length, 5);
  } finally {
    releaseHeld(); releaseProtected();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(); child.once("exit", () => resolve()); });
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
