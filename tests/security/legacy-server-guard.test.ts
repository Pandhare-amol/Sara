import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

// This is a separate process so an obsolete entry point cannot silently
// serve owner records simply because it was started with a different command.
test("legacy server.ts refuses to start against an activated or pending protected datastore", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-legacy-guard-"));
  const pending = path.join(dir, "security", "multiuser.pending");
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, "pending\n");
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(), env: { ...process.env, SARA_DATA_DIR: dir, PORT: "0", SARA_MULTIUSER_REQUIRED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
  child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 1000); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<[number | null]>((_, reject) => { timer = setTimeout(() => reject(new Error("Legacy process did not exit within eight seconds.")), 8000); }),
    ]);
    assert.equal(code, 1, output.slice(-500));
    assert.match(output, /this legacy server cannot safely access protected data/);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-running legacy server exits when protected mode is activated", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-legacy-live-"));
  const socket = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", SARA_SUPERVISOR: "1",
      SARA_DATA_DIR: dir, PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_MULTIUSER_REQUIRED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 500); });
  child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 500); });
  try {
    const deadline = Date.now() + 8_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const result = await fetch(`http://127.0.0.1:${port}/health`);
        if (result.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, output.slice(-500));
    const marker = path.join(dir, "security", "multiuser.pending");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "pending\n");
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<[number | null]>((_, reject) => { const timer = setTimeout(() => reject(new Error("Legacy server stayed alive after activation.")), 4000); timer.unref(); }),
    ]);
    assert.equal(code, 1, output.slice(-500));
    assert.match(output, /Legacy standalone server stopping/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
