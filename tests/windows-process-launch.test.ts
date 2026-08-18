import test from "node:test";
import assert from "node:assert/strict";
import { spawnManagedProcess } from "../startup/processGuard.ts";

test("Windows process spawn treats executable and args as separate values", async () => {
  const result = spawnManagedProcess({
    name: "windows-path-probe",
    command: process.execPath,
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)));", "dist/server.cjs", "value with spaces", 'quoted"arg'],
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve) => result.child.on("exit", resolve));

  const parsed = JSON.parse(result.stdout.trim());
  assert.deepEqual(parsed, ["dist/server.cjs", "value with spaces", 'quoted"arg']);
  assert.ok(result.executable === process.execPath || result.executable.toLowerCase().includes("node"));
  assert.equal(result.exitCode, 0);
});
