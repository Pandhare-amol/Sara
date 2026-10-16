import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}
async function freePort(): Promise<number> {
  const { server, port } = await listen((_, res) => res.end());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function post(url: string, data: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
async function until(check: () => Promise<boolean>, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("HTTP workflow did not reach expected state before timeout.");
}

test("HTTP integration: fake planning provider, existing task API, unauthenticated approval denial, verified desktop gateway", { timeout: 45_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-workflow-http-"));
  const calls: string[] = [];
  const admin = "test-only-admin-credential-32-characters";
  let child: ChildProcess | undefined;
  let output = "";
  const provider = await listen(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    const plan = { steps: [
      { action: "navigate", url: "https://example.com/start" },
      { action: "click", role: "button", name: "Show article", expect: { type: "text", value: "Article loaded" } },
      { action: "read", contains: "Article loaded" },
    ] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { completion_tokens: 45 } }));
  });
  const agent = await listen(async (req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end('{"status":"ok"}'); return; }
    if (req.url !== "/execute") { res.writeHead(404); res.end(); return; }
    let content = "";
    for await (const part of req) content += part.toString();
    const { tool, args } = JSON.parse(content);
    assert.equal(tool, "desktopBrowserWorkflow");
    assert.equal(args.confirmed, undefined);
    assert.equal(args.authorized, undefined);
    calls.push(args.operation);
    const observed = { ok: true, verified: ["inspect", "read"].includes(args.operation), url: "https://example.com/start", text: "Article loaded", result: "Observed." };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tool, result: observed }));
  });
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1",
        SARA_DATA_DIR: dir, DESKTOP_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fake", SARA_PLANNING_MODEL: "fake",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, SARA_ADMIN_TOKEN: admin, DISABLE_HMR: "true",
      },
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    await until(async () => (await fetch(`${base}/api/models/status`)).ok, 18_000);
    const planned = await post(`${base}/api/workflows/browser/plan`, { goal: "Read a public article", startUrl: "https://example.com/start" });
    assert.equal(planned.status, 201, output.slice(-600));
    const taskId = planned.body.task.taskId as string;
    const digest = planned.body.task.metadata.workflow.digest;
    assert.deepEqual(calls, [], "Planning must not dispatch browser actions.");
    assert.equal(planned.body.task.status, "paused");
    const legacy = await post(`${base}/api/cognitive/task/execute`, { goal: "Run shell", userInput: "Run shell" });
    assert.equal(legacy.status, 410, "Legacy cognitive execution must not bypass the reviewed gateway.");
    assert.equal((await post(`${base}/api/cognitive/remember`, { category: "identity", content: "unapproved", type: "fact" })).status, 410);
    assert.equal((await post(`${base}/api/cognitive/memory/consolidate`, {})).status, 410);
    assert.deepEqual(calls, []);
    const directApproval = await post(`${base}/api/workflows/browser/${taskId}/approve`, { approve: true, index: 1, digest });
    assert.equal(directApproval.status, 401);
    const genericPatch = await fetch(`${base}/api/tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"status":"completed","metadata":{}}' });
    assert.equal(genericPatch.status, 409);
    const started = await post(`${base}/api/workflows/browser/${taskId}/start`, { confirmed: true });
    assert.equal(started.status, 202);
    const get = async () => (await (await fetch(`${base}/api/workflows/browser/${taskId}`)).json() as any).task;
    try { await until(async () => (await get()).status === "awaiting_confirmation"); }
    catch { assert.fail(`Unexpected workflow state: ${JSON.stringify(await get())}; calls: ${JSON.stringify(calls)}; server: ${output.slice(-1200)}`); }
    assert.deepEqual(calls, ["navigate", "inspect"], "A model-supplied confirmation must not click.");
    assert.equal((await get()).checkpoint.currentIndex, 1);
    const wrong = await post(`${base}/api/workflows/browser/${taskId}/approve`, { approve: true, index: 1, digest: "changed-plan" }, { "x-admin-token": admin });
    assert.equal(wrong.status, 409);
    assert.equal(calls.includes("click"), false);
    const approved = await post(`${base}/api/workflows/browser/${taskId}/approve`, { approve: true, index: 1, digest }, { "x-admin-token": admin });
    assert.equal(approved.status, 202);
    await until(async () => (await get()).status === "completed");
    assert.deepEqual(calls, ["navigate", "inspect", "click", "inspect", "read", "close"]);
    const replay = await post(`${base}/api/workflows/browser/${taskId}/approve`, { approve: true, index: 1, digest }, { "x-admin-token": admin });
    assert.equal(replay.status, 409);
    const legacyRetry = await post(`${base}/api/tasks/${taskId}/retry`, {});
    assert.equal(legacyRetry.status, 409);

    const next = await post(`${base}/api/workflows/browser/plan`, { goal: "Read another public article", startUrl: "https://example.com/start" });
    assert.equal(next.status, 201);
    const cancelledId = next.body.task.taskId as string;
    const cancelled = await post(`${base}/api/workflows/browser/${cancelledId}/cancel`, {});
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.task.status, "cancelled");
    const actionsAfterCancel = calls.filter((operation) => operation !== "close").length;
    const forbiddenRestart = await post(`${base}/api/workflows/browser/${cancelledId}/start`, {});
    assert.equal(forbiddenRestart.status, 409);
    assert.equal(calls.filter((operation) => operation !== "close").length, actionsAfterCancel,
      "A cancelled task must never execute another desktop action.");
  } finally {
    child?.kill("SIGTERM");
    if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child?.exitCode === null) child.kill("SIGKILL");
    await Promise.all([provider.server, agent.server].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
