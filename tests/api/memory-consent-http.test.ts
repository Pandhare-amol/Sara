import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("memory HTTP routes keep external research separate and require explicit consent for retrieval", { timeout: 45_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-memory-routes-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, "memories.json"), JSON.stringify([
    { id: "unapproved", category: "preference", text: "User likes coral colors.", createdAt: now, updatedAt: now,
      source: "historical_memory", verificationStatus: "verified", approvedByUser: false, evidence: ["legacy inference"] },
    { id: "external", category: "project", text: "Sourced public topic, not personal memory.", createdAt: now,
      updatedAt: now, source: "external_research", verificationStatus: "verified", evidence: ["source citation"] },
  ]));
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "production", PORT: String(port), SARA_DATA_DIR: dataDir,
      SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1", SARA_AUTO_MEMORY: "false", GEMINI_API_KEY: "",
    },
  });
  child.stdout?.on("data", (data) => { logs += String(data).slice(0, 1200); });
  child.stderr?.on("data", (data) => { logs += String(data).slice(0, 1200); });

  try {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited before the memory routes were ready: ${logs.slice(-1000)}`);
      try { if ((await fetch(`${base}/api/users/status`, { signal: AbortSignal.timeout(1000) })).ok) break; }
      catch { /* Still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method, ...(body ? {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    const visible = await call("/api/memories");
    assert.equal(visible.status, 200, logs.slice(-500));
    assert.deepEqual(visible.body.map((memory: any) => memory.id), ["unapproved"]);
    assert.equal((await call("/api/memories/external/confirm", "POST")).status, 403);
    assert.equal((await call("/api/memories/external", "PUT", { category: "project", text: "A private claim" })).status, 403);
    assert.equal((await call("/api/memories/external", "PATCH", { category: "project", text: "A private claim" })).status, 403);
    assert.equal((await call("/api/memories/external", "DELETE")).status, 403);

    const noOpEdit = await call("/api/memories/unapproved", "PUT", { category: "preference", text: "User likes coral colors." });
    assert.equal(noOpEdit.status, 200);
    assert.equal(noOpEdit.body.approvedByUser, false, "an unchanged label is not consent to reuse legacy memories");
    const confirmed = await call("/api/memories/unapproved/confirm", "POST");
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.approvedByUser, true);
    assert.equal(confirmed.body.source, "user_provided");
    assert.equal(confirmed.body.verificationStatus, "verified");

    const manual = await call("/api/memories", "POST", { category: "goal", text: "User is planning a small garden." });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.approvedByUser, true);
    const retry = await call("/api/memories", "POST", { category: "goal", text: "User is planning a small garden." });
    assert.equal(retry.body.id, manual.body.id, "retrying a manual save must not duplicate records");
    const correction = await call(`/api/memories/${manual.body.id}`, "PUT", { category: "goal", text: "User is planning a community garden." });
    assert.equal(correction.status, 200);
    assert.equal(correction.body.approvedByUser, true);
    assert.equal(correction.body.text, "User is planning a community garden.");
    assert.equal((await call(`/api/memories/${manual.body.id}`, "DELETE")).status, 200);
    assert.equal((await call(`/api/memories/${manual.body.id}`, "DELETE")).status, 404);
  } finally {
    await stop(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
