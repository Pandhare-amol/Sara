import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxVerifier, sandboxArguments } from "../src/core/intelligence/sandboxVerifier";

const image = `python@sha256:${"a".repeat(64)}`;
test("sandbox disabled by default, never executes code using the host interpreter", async () => {
  const verifier = new SandboxVerifier({});
  assert.equal(verifier.status().configured, false);
  const result = await verifier.run("open('/etc/passwd').read()", "assert False");
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.evidence, undefined);
});

test("container invocation is no-network, read-only, non-root and pinned; no arbitrary code is an argument", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sara-sandbox-args-"));
  try {
    const args = sandboxArguments(folder, image, `sara-check-${"a".repeat(24)}`);
    for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--user=65534:65534", "--memory=256m", "--pids-limit=64", "--pull=never"]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.match(args.join(" "), /dst=\/work,readonly/);
    assert.throws(() => sandboxArguments(folder, "python:latest", `sara-check-${"a".repeat(24)}`));
    assert.throws(() => sandboxArguments(folder, image, "../../untrusted"));
    assert.equal(args.includes("--privileged"), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
