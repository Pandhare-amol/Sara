import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freePort(): Promise<number> {
  const server = createServer((_, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Mobile API did not start.");
}

test("separate mobile chat endpoint bounds later-turn prompt without truncating the user's current question", { timeout: 35_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-mobile-chat-"));
  let child: ChildProcess | undefined;
  const prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    prompts.push(String(JSON.parse(raw).messages?.at(-1)?.content || ""));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Mobile fake reply" } }], usage: { completion_tokens: 5 } }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "mobile_server.ts"], {
      cwd: process.cwd(), stdio: "ignore", env: {
        ...process.env, MOBILE_SERVER_PORT: String(port), SARA_MOBILE_SERVER_HOST: "127.0.0.1",
        SARA_DATA_DIR: dir, SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fake",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`, SARA_AUTO_MEMORY: "false", GEMINI_API_KEY: "",
      },
    });
    await until(async () => (await fetch(`${base}/api/models/status`)).ok);
    const history = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? "assistant" : "user",
      text: `MOBILE-TURN-${index}-${"m".repeat(300)}` }));
    const question = "Current mobile user question after many earlier turns";
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: question, history }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).text, "Mobile fake reply");
    const prompt = prompts.at(-1) || "";
    assert.match(prompt, /MOBILE-TURN-99/);
    assert.doesNotMatch(prompt, /MOBILE-TURN-0-/);
    assert.match(prompt, /Current mobile user question after many earlier turns/);
    assert.ok(prompt.length < 10_000, `Mobile later-turn prompt was ${prompt.length} chars.`);
  } finally {
    child?.kill("SIGTERM");
    if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child?.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
