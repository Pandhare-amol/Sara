import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSseData } from "../../src/core/models/sseStream";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return address.port;
}
async function freePort() { const server = createServer((_, res) => res.end());
  const port = await listen(server); await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 40)); }
  assert.fail("Timed out waiting for local chat fixture.");
}
const streamHeaders = { "Content-Type": "application/json", Accept: "text/event-stream" };

test("HTTP SSE acknowledges early, streams genuine chunks while another chat succeeds, and never saves an aborted or partial turn", { timeout: 55_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara8-stream-http-"));
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let active = 0; let maxActive = 0;
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body);
    const prompt = String(input.messages?.at(-1)?.content || "");
    if (!input.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "JSON reply" } }] }));
      return;
    }
    active++; maxActive = Math.max(maxActive, active);
    res.once("close", () => { active--; });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (prompt.includes("hold-provider")) await slow;
    res.write('data: {"choices":[{"delta":{"content":"First"}}]}\n\n');
    if (prompt.includes("partial-provider")) { res.end(); return; }
    if (prompt.includes("abort-provider")) { await new Promise<void>((resolve) => res.once("close", resolve)); return; }
    res.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const providerPort = await listen(provider);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = "";
  const post = (text: string, conversationId: string, signal?: AbortSignal) => fetch(`${base}/api/chat`, {
    method: "POST", headers: streamHeaders, signal,
    body: JSON.stringify({ text, conversationId, source: "desktop" }),
  });
  const collect = async (response: Response, start = Date.now(), onEvent?: (event: string) => void) => {
    const events: Array<{ event: string; body: any; atMs: number }> = [];
    assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
    await readSseData(response.body!, (data, event) => {
      events.push({ event: event || "", body: JSON.parse(data), atMs: Date.now() - start });
      if (event) onEvent?.(event);
    });
    return events;
  };
  try {
    child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1", DISABLE_HMR: "true",
        SARA_DATA_DIR: dir, SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "mock",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, GEMINI_API_KEY: "", SARA_AUTO_MEMORY: "false",
      },
    });
    child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    await until(async () => (await fetch(`${base}/api/models/status`)).ok);
    const inputStatus = await (await fetch(`${base}/api/automation/input-status`)).json() as any;
    assert.deepEqual({ active: inputStatus.active, waiting: inputStatus.waiting, uncertain: inputStatus.uncertain },
      { active: false, waiting: 0, uncertain: false });
    const manual = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "manual-only", description: "Do not fake automation ownership" }) });
    assert.equal(manual.status, 200);
    const manualTaskId = (await manual.json() as any).task.taskId;
    const forged = await fetch(`${base}/api/tasks/${encodeURIComponent(manualTaskId)}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metadata: { automation: true }, status: "completed" }) });
    assert.equal(forged.status, 409, "generic records cannot be promoted into verified automation");
    const started = Date.now();
    const heldResponse = await post("hold-provider", "slow-conversation");
    assert.equal(heldResponse.status, 200, output.slice(-500));
    const received: Array<{ event: string; body: any; atMs: number }> = [];
    const heldRead = readSseData(heldResponse.body!, (raw, event) => {
      received.push({ event: event || "", body: JSON.parse(raw), atMs: Date.now() - started });
    });
    await until(() => received.some((item) => item.event === "ack"));
    assert.equal(received.some((item) => item.event === "text"), false, "ack must precede slow provider text");
    const fastStarted = Date.now();
    const fast = await collect(await post("new-conversation", "fast-conversation"), fastStarted);
    assert.equal(fast.find((item) => item.event === "done")?.body.text, "First second");
    assert.equal(fast.find((item) => item.event === "done")?.body.metrics.streamed, true);
    assert.equal(typeof fast.find((item) => item.event === "done")?.body.metrics.cpuUserMs, "number");
    assert.equal(typeof fast.find((item) => item.event === "done")?.body.metrics.rssMb, "number");
    assert.ok(maxActive >= 2, "both provider calls must overlap");
    releaseSlow();
    await heldRead;
    assert.deepEqual(received.map((item) => item.event), ["ack", "text", "text", "done"]);
    const done = received.at(-1)!.body;
    assert.equal(done.text, "First second");
    assert.ok(done.metrics.ackMs <= done.metrics.firstTextMs);
    assert.ok(done.metrics.firstTextMs <= done.metrics.completionMs);
    assert.ok(received[1].atMs <= received[3].atMs);
    const saved = await (await fetch(`${base}/api/conversations?source=desktop`)).json() as any[];
    assert.equal(saved.find((item) => item.id === "slow-conversation")?.messages.at(-1).text, "First second");

    const partial = await collect(await post("partial-provider", "partial-conversation"));
    assert.equal(partial.at(-1)?.event, "error");
    assert.equal(partial.at(-1)?.body.partial, true);
    assert.equal(partial.some((item) => item.event === "done"), false);
    const controller = new AbortController();
    const stoppedResponse = await post("abort-provider", "aborted-conversation", controller.signal);
    await assert.rejects(collect(stoppedResponse, Date.now(), (event) => {
      if (event === "text") controller.abort();
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await (await fetch(`${base}/api/conversations?source=desktop`)).json() as any[];
    assert.equal(after.some((item) => item.id === "partial-conversation" || item.id === "aborted-conversation"), false);
    console.log(`fake provider SSE ack_ms=${done.metrics.ackMs} first_text_ms=${done.metrics.firstTextMs} completion_ms=${done.metrics.completionMs} fast_complete_ms=${fast.at(-1)?.atMs} provider_max_active=${maxActive} rss_mb=${done.metrics.rssMb}`);
  } finally {
    releaseSlow();
    child?.kill("SIGTERM");
    if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child?.exitCode === null) child.kill("SIGKILL");
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
