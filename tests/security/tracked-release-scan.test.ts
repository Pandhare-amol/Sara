import test from "node:test";
import assert from "node:assert/strict";
import { trackedArtifactCategory, trackedArtifactCounts } from "../../src/security/trackedReleaseScan";

test("release gate summarizes only counts and never opens tracked runtime files", () => {
  assert.equal(trackedArtifactCategory("data/security/owner.json"), "runtime_data");
  assert.equal(trackedArtifactCategory("logs/private.txt"), "runtime_data");
  assert.equal(trackedArtifactCategory("agent_dist/desktop.exe"), "generated_bundle");
  assert.equal(trackedArtifactCategory("desktop_agent/__pycache__/module.pyc"), "bytecode");
  assert.equal(trackedArtifactCategory("profiles/Cookies"), "credentials_or_database");
  assert.equal(trackedArtifactCategory(".env"), "credentials_or_database");
  assert.equal(trackedArtifactCategory(".env.example"), null);
  assert.equal(trackedArtifactCategory("src/App.tsx"), null);
  assert.deepEqual(trackedArtifactCounts(["data/security/owner.json", "src/App.tsx", "agent_dist/x.exe"]), {
    total: 2, categories: { runtime_data: 1, generated_bundle: 1, bytecode: 0, credentials_or_database: 0 },
  });
});
