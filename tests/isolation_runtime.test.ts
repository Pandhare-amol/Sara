import test from "node:test";
import assert from "node:assert/strict";
import { IsolationRuntime } from "../src/core/isolation/isolationRuntime";
import { ToolRouter } from "../src/core/tools/toolRouter";

function createRouter() {
  const router = new ToolRouter({ isKnownTool: (name) => name === "readFile" || name === "runPythonScript" || name === "shutdown" });
  router.setAdapter(async (tool) => ({ ok: true, result: { tool, verification_status: "VERIFIED", executed: true } }));
  router.registry.register({ name: "readFile", owner: "node" });
  router.registry.register({ name: "runPythonScript", owner: "desktop-agent" });
  router.registry.register({ name: "shutdown", owner: "node", metadata: { riskLevel: "DESTRUCTIVE_SYSTEM", requiresConfirmation: true } });
  return router;
}

test("isolation council allows registered read-only work", async () => {
  const runtime = new IsolationRuntime(createRouter());
  const result = await runtime.execute([{ tool: "readFile", args: { path: "README.md" }, requiresVerification: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.review.decision, "ALLOW");
});

test("isolation council blocks direct interpreter tools without sandbox confirmation", () => {
  const runtime = new IsolationRuntime(createRouter());
  const review = runtime.review([{ tool: "runPythonScript", args: { code: "print(1)" } }], { source: "model" });
  assert.equal(review.decision, "ASK_USER");
  assert.match(review.reasons.join(" "), /isolated sandbox/i);
});

test("isolation council requires confirmation for destructive tools", () => {
  const runtime = new IsolationRuntime(createRouter());
  const review = runtime.review([{ tool: "shutdown", args: {} }]);
  assert.equal(review.decision, "ASK_USER");
});

test("isolation council denies unknown tools before execution", async () => {
  const runtime = new IsolationRuntime(createRouter());
  const result = await runtime.execute([{ tool: "unknownTool", args: {} }]);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 0);
  assert.equal(result.review.decision, "DENY");
});