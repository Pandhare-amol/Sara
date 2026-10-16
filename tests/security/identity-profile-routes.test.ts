import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const repositoryRoot = process.cwd();

async function reservePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("identity profile routes require admin authorization and use the configured data directory", async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-identity-profile-routes-"));
  const adminToken = "test-admin-token-for-identity-routes-0123456789";
  const child = spawn(process.execPath, [tsxCli, path.join(repositoryRoot, "server_full.ts")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      SARA_BIND_HOST: "127.0.0.1",
      SARA_DATA_DIR: dataDir,
      SARA_USER_PROFILES_LEGACY_PATH: path.join(dataDir, "nonexistent-legacy-user-profiles.json"),
      SARA_ADMIN_TOKEN: adminToken,
      SARA_SUPERVISOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let processOutput = "";
  child.stdout.on("data", (chunk) => { processOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { processOutput += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = { "X-Admin-Token": adminToken };

  try {
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/api/identity/profiles`, {
          headers: adminHeaders,
          signal: AbortSignal.timeout(1500),
        });
        if (response.status === 200) {
          assert.deepEqual((await response.json() as any).profiles, []);
          ready = true;
          break;
        }
      } catch {
        // Wait for application imports and route registration to finish.
      }
      await delay(200);
    }
    assert.equal(ready, true, `Backend did not start with identity routes mounted. Output:\n${processOutput}`);

    const unauthorizedList = await fetch(`${baseUrl}/api/identity/profiles`);
    assert.equal(unauthorizedList.status, 401);
    assert.equal(unauthorizedList.headers.get("cache-control"), "no-store");

    const unauthorizedRead = await fetch(`${baseUrl}/api/identity/profiles/alice`);
    assert.equal(unauthorizedRead.status, 401);

    const unauthorizedWrite = await fetch(`${baseUrl}/api/identity/profiles/alice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Alice", permissions: ["admin"] }),
    });
    assert.equal(unauthorizedWrite.status, 401);

    const unchanged = await fetch(`${baseUrl}/api/identity/profiles`, { headers: adminHeaders });
    assert.deepEqual((await unchanged.json() as any).profiles, [], "unauthorized writes must not create a profile");

    const created = await fetch(`${baseUrl}/api/identity/profiles/alice`, {
      method: "PUT",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Alice", relationship: "self", preferences: { theme: "dark" } }),
    });
    assert.equal(created.status, 200);
    const createdPayload = await created.json() as any;
    assert.equal(createdPayload.profile.userId, "alice");
    assert.equal(createdPayload.profile.displayName, "Alice");

    const readBack = await fetch(`${baseUrl}/api/identity/profiles/alice`, { headers: adminHeaders });
    assert.equal(readBack.status, 200);
    assert.equal((await readBack.json() as any).profile.preferences.theme, "dark");

    assert.equal(fs.existsSync(path.join(dataDir, "user_profiles.json")), true,
      "profile writes must use the configured SARA_DATA_DIR");
  } finally {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
