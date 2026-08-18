import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runIntegrityCheck, isManifestStale } from "../src/security/integrityVerifier.ts";
import { evaluateLockPid, getPortOwnerPid } from "../startup/processGuard.ts";

test("integrity verifier flags stale trusted baseline and mismatch details", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-integrity-"));
  const securityDir = path.join(root, "data", "security");
  fs.mkdirSync(securityDir, { recursive: true });
  fs.writeFileSync(path.join(securityDir, ".manifest-key"), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

  const manifest = {
    files: [{ file: "src/alpha.ts", hash: "deadbeef" }],
    generated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(path.join(securityDir, "integrity-manifest.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "alpha.ts"), "const x = 1;\n");

  const result = runIntegrityCheck(root);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.files_failed, 1);
  assert.equal(result.reason, "Integrity check failed");
  assert.equal(isManifestStale(manifest, 1), true);
});

test("lock validation recognizes stale and active SARA-owned PIDs safely", () => {
  const invalid = evaluateLockPid(-1);
  assert.equal(invalid.stale, true);

  const missing = evaluateLockPid(999999);
  assert.equal(missing.stale, true);

  const current = process.pid;
  const live = evaluateLockPid(current);
  assert.equal(live.stale, true); // current process is not a SARA-owned command line in generic env
  assert.equal(typeof live.reason, "string");

  const portOwner = getPortOwnerPid(1);
  assert.equal(typeof portOwner === "number" || portOwner === null, true);
});
