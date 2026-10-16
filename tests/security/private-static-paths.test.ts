import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPrivateStaticPath } from "../../src/security/privateStaticPaths";

const blocked = ["/data/security/multiuser.json", "/logs/system.log", "/users/u-abc/conversations.json",
  "/@fs/tmp/private.json", "/%64ata/memories.json", "/data%252fsecurity%252fmultiuser.json", "/src/../data/private.json",
  "/src/.env", "/.git/config", "/%3fbad%", "/data\\security\\multiuser.json"];
for (const item of blocked) test(`static private path blocked: ${item.slice(0, 45)}`, () => assert.equal(isPrivateStaticPath(item), true));
for (const item of ["/", "/src/App.tsx", "/assets/logo.png", "/api/users/status", "/api/memories"]) {
  test(`static public path not blocked: ${item}`, () => assert.equal(isPrivateStaticPath(item), false));
}

test("standalone Vite dev server cannot serve a runtime JSON file from the repository root", { timeout: 30_000 }, async () => {
  const root = process.cwd();
  const folder = path.join(root, "data", "security");
  fs.mkdirSync(folder, { recursive: true });
  const fixture = `sara-private-path-test-${crypto.randomBytes(8).toString("hex")}.json`;
  const file = path.join(folder, fixture);
  fs.writeFileSync(file, JSON.stringify({ sentinel: "never-return-this-to-browser" }), { mode: 0o600 });
  const server = createServer((_, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  let child: ChildProcess | undefined;
  try {
    child = spawn(path.join(root, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(address.port)], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISABLE_HMR: "true" },
    });
    const base = `http://127.0.0.1:${address.port}`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const response = await fetch(`${base}/`); if (response.ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Vite server must be available before testing file access");
    for (const route of [`/data/security/${fixture}`, `/@fs/${file}`]) {
      const response = await fetch(`${base}${route}`);
      const text = await response.text();
      assert.equal(response.status, 403, `${route} must be denied by the Vite plugin`);
      assert.doesNotMatch(text, /never-return-this-to-browser/);
    }
  } finally {
    child?.kill("SIGTERM");
    if (child?.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child?.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(file, { force: true }); // never remove the existing data directory
  }
});
