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

async function until(check: () => Promise<boolean>, timeoutMs = 18_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Chat test server did not become ready.");
}

test("HTTP chat keeps later-turn context bounded without repeating the same history", { timeout: 45_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-chat-http-"));
  const prompts: string[] = [];
  let child: ChildProcess | undefined;
  let output = "";
  let navigationStarted = false;
  let releaseNavigation!: () => void;
  const heldNavigation = new Promise<void>((resolve) => { releaseNavigation = resolve; });
  const agent = await listen(async (req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end('{"status":"ok"}'); return; }
    if (req.url !== "/execute") { res.writeHead(404); res.end(); return; }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body);
    assert.equal(request.tool, "desktopBrowserWorkflow");
    if (request.args.operation === "navigate") { navigationStarted = true; await heldNavigation; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tool: request.tool, result: {
      ok: true, verified: ["inspect", "read"].includes(request.args.operation), url: "https://example.com/start",
      text: "Public article loaded", result: "Observed.",
    } }));
  });
  const provider = await listen(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body);
    prompts.push(String(request.messages?.at(-1)?.content || ""));
    const isPlan = String(request.messages?.at(-1)?.content || "").includes("Produce ONLY a JSON object");
    const answer = isPlan ? JSON.stringify({ steps: [
      { action: "navigate", url: "https://example.com/start" },
      { action: "read", contains: "Public article loaded" },
    ] }) : "Provider reply";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { completion_tokens: 5 } }));
  });
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1", DISABLE_HMR: "true",
        SARA_DATA_DIR: dir, SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fake",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, DESKTOP_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        SARA_AUTO_MEMORY: "false", GEMINI_API_KEY: "",
      },
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
    await until(async () => (await fetch(`${base}/api/models/status`)).ok);
    const send = async (text: string, history: unknown[]) => {
      const started = Date.now();
      const response = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, history, source: "desktop", conversationId: "latency-test" }),
      });
      const body = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(body) + output.slice(-500));
      assert.equal(body.text, "Provider reply");
      return Date.now() - started;
    };
    const firstMs = await send("initial greeting", []);
    const history = Array.from({ length: 22 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", text: `HIST-TURN-${String(index).padStart(3, "0")}-${"x".repeat(320)}`,
    }));
    const laterMs = await send("a later question", history);
    const last = prompts.at(-1) || "";
    const occurrences = last.split("HIST-TURN-020-").length - 1;
    // This measures a fake local provider only. The wall times are diagnostics,
    // not assertions about a real LLM or a particular desktop installation.
    console.log(`fake chat first_ms=${firstMs} later_ms=${laterMs} later_prompt_chars=${last.length} history_occurrences=${occurrences}`);
    assert.equal(prompts.length, 2);
    assert.equal(occurrences, 1, "A recent turn must not be repeated in both the chat transcript and bounded context.");
    assert.ok(last.length < 18_000, "Prompt growth should be bounded on later turns.");

    // A successful /api/chat is authoritative for this pair. The UI should not
    // need to POST its entire growing conversation file a second time merely
    // to retain unsaved interleaved voice turns or update a default title.
    const voiceTurn = { role: "assistant", text: "VOICE-ONLY-TURN", timestamp: new Date().toISOString() };
    const chatBody = { text: "next typed turn", history: [], source: "desktop", conversationId: "latency-test",
      title: "User-chosen topic", voiceTurns: [voiceTurn] };
    const save = async (text: string) => {
      const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...chatBody, text }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).conversationId, "latency-test");
    };
    await save("next typed turn");
    await save("another typed turn"); // repeated voice payload must not duplicate the voice message
    await save("repeat this");
    await save("repeat this"); // a deliberate, identical new text request is still a new turn
    const stored = await (await fetch(`${base}/api/conversations?source=desktop`)).json() as any[];
    const record = stored.find((item) => item.id === "latency-test");
    assert.equal(record?.title, "User-chosen topic");
    assert.equal(record?.messages.filter((item: any) => item.text === voiceTurn.text).length, 1);
    assert.ok(record.messages.some((item: any) => item.text === "another typed turn"));
    assert.equal(record.messages.filter((item: any) => item.role === "user" && item.text === "repeat this").length, 2);
    assert.equal(record.messages.filter((item: any) => item.role === "assistant" && item.text === "Provider reply").length, 6,
      "Each accepted text request must persist its own response even when the provider repeats its answer.");

    // A real HTTP task remains in-flight at the fake desktop gateway; another
    // text chat must finish without waiting for that task or claiming it is done.
    const post = async (url: string, body: unknown) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const planned = await post(`${base}/api/workflows/browser/plan`, {
      goal: "Read a public article", startUrl: "https://example.com/start", conversationId: "latency-test",
    });
    assert.equal(planned.status, 201, JSON.stringify(planned.body));
    const taskId = planned.body.task.taskId as string;
    const started = await post(`${base}/api/workflows/browser/${taskId}/start`, {});
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(async () => navigationStarted, 4_000);
    const conversationContinues = await Promise.race([
      send("What's the task status, and can we discuss another topic while it runs?", []).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    assert.equal(conversationContinues, true, "Chat should not wait for a held desktop task.");
    assert.match(prompts.at(-1) || "", new RegExp(`ACTIVE TASK[^\\n]*${taskId}`),
      "A status question must see the server's actual in-progress workflow, not stale client metadata.");
    const inProgress = await (await fetch(`${base}/api/workflows/browser/${taskId}`)).json() as any;
    assert.notEqual(inProgress.task.status, "completed");
    releaseNavigation();
    await until(async () => (await (await fetch(`${base}/api/workflows/browser/${taskId}`)).json() as any).task.status === "completed", 5_000);

    // A damaged user conversation file must not be silently treated as an
    // empty store and overwritten by the new incremental chat path or its
    // snapshot fallback. This fixture is private and is never committed.
    const file = path.join(dir, "conversations.json");
    const damaged = '{"unfinished":';
    fs.writeFileSync(file, damaged);
    assert.equal((await post(`${base}/api/chat`, { text: "must fail safely", conversationId: "latency-test" })).status, 500);
    const failedSave = await post(`${base}/api/conversations`, {
      source: "desktop", conversation: { id: "latency-test", messages: [] },
    });
    assert.equal(failedSave.status, 500);
    assert.doesNotMatch(JSON.stringify(failedSave.body), /unfinished/);
    const failedDelete = await fetch(`${base}/api/conversations/latency-test`, { method: "DELETE" });
    assert.equal(failedDelete.status, 500);
    assert.equal(fs.readFileSync(file, "utf-8"), damaged);
    fs.writeFileSync(file, "{}");
    assert.equal((await post(`${base}/api/conversations`, {
      source: "desktop", conversation: { id: "latency-test", messages: [] },
    })).status, 500);
    assert.equal(fs.readFileSync(file, "utf-8"), "{}");
  } finally {
    releaseNavigation();
    child?.kill("SIGTERM");
    if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child?.exitCode === null) child.kill("SIGKILL");
    await Promise.all([provider.server, agent.server].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
