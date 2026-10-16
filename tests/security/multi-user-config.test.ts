import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const guard = require("../../electron/nativeGuard.cjs") as {
  backendDataDir: (appRoot: string, appUserData: string, configured?: string) => string;
  protectedDatastoreExists: (options: { required: boolean; appRoot: string; appUserData: string; configuredDataDir?: string }) => boolean;
};

test("Electron native guard checks the exact backend data path, old defaults and interrupted setup markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-electron-guard-"));
  try {
    const appRoot = path.join(dir, "application"), userData = path.join(dir, "electron-data");
    const configured = path.join(appRoot, "chosen-data");
    fs.mkdirSync(path.join(configured, "security"), { recursive: true });
    const args = { appRoot, appUserData: userData, configuredDataDir: "chosen-data", required: false };
    assert.equal(guard.backendDataDir(appRoot, userData, "chosen-data"), configured);
    assert.equal(guard.backendDataDir(appRoot, userData), userData);
    assert.equal(guard.protectedDatastoreExists(args), false);
    fs.writeFileSync(path.join(configured, "security", "multiuser.pending"), "pending\n");
    assert.equal(guard.protectedDatastoreExists(args), true, "native capture is locked before bootstrap finishes");
    fs.rmSync(path.join(configured, "security", "multiuser.pending"));
    fs.mkdirSync(path.join(userData, "security"), { recursive: true });
    fs.writeFileSync(path.join(userData, "security", "multiuser.json"), "protected");
    assert.equal(guard.protectedDatastoreExists(args), true, "a previous standalone install must not be ignored");
    fs.rmSync(path.join(userData, "security", "multiuser.json"));
    assert.equal(guard.protectedDatastoreExists({ ...args, required: true }), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function stop(child: ChildProcess | undefined) {
  if (!child) return;
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([once(child, "exit"), new Promise((resolve) => {
      timer = setTimeout(resolve, 3000); timer.unref();
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("ignored .env protection flag and custom data path load before account store selection", { timeout: 25_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-early-dotenv-"));
  const dataDir = path.join(dir, "private-data");
  const repo = process.cwd();
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const secret = "a-long-private-owner-secret-for-dotenv-fixture";
  // sql.js searches process.cwd()/node_modules for its WASM in an ESM launch;
  // expose only the installed package in this disposable test cwd.
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, ".env"),
    `SARA_MULTIUSER_REQUIRED=true\nSARA_DATA_DIR=${dataDir}\nSARA_ADMIN_TOKEN=${secret}\n`, { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: "production", SARA_SUPERVISOR: "1",
    PORT: String(address.port), SARA_BIND_HOST: "127.0.0.1" };
  for (const name of ["SARA_MULTIUSER_REQUIRED", "SARA_DATA_DIR", "SARA_ADMIN_TOKEN"]) delete env[name];
  let output = "";
  let child: ChildProcess | undefined;
  try {
    // Absolute loader/entry paths permit a disposable cwd without writing
    // .env into the repository or touching an existing user's data.
    const loader = new URL(import.meta.resolve("tsx")).pathname;
    child = spawn(process.execPath, ["--import", loader, path.join(repo, "server_full.ts")], {
      cwd: dir, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (part) => { output += String(part).slice(0, 300); });
    child.stdout?.on("data", (part) => { output += String(part).slice(0, 300); });
    const base = `http://127.0.0.1:${address.port}`;
    const deadline = Date.now() + 12_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { if ((await fetch(`${base}/api/users/status`)).ok) { ready = true; break; } }
      catch { /* process is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `backend must start from disposable cwd: ${output.slice(-400)}`);
    const status = await (await fetch(`${base}/api/users/status`)).json() as {
      enabled: boolean; initialized: boolean; ownerSecretConfigured: boolean;
    };
    assert.deepEqual(status, { enabled: true, initialized: false, ownerSecretConfigured: true });
    const denied = await fetch(`${base}/api/memories`);
    assert.notEqual(denied.status, 200, "an uninitialized protected install cannot serve old data");
    const bootstrap = await fetch(`${base}/api/users/bootstrap`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Fixture owner", adminSecret: secret }) });
    assert.equal(bootstrap.status, 201, `fixture bootstrap must work only in the configured directory: ${output.slice(-300)}`);
    assert.equal(fs.existsSync(path.join(dataDir, "security", "multiuser.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "data", "security", "multiuser.json")), false);
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
