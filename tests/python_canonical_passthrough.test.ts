/**
 * Regression tests for the Python → Node canonical result passthrough bug.
 *
 * The bug: Python's desktop agent returns { ok: true, result: <raw>, canonical: {...} }
 * but the Node transport was only passing `result` (raw), losing Python's
 * verified/execution_status fields. This caused ok=true tool calls to be
 * treated as executionStatus="unknown" and verification to be skipped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionOrchestrator } from "../src/core/tools/execution/executionOrchestrator";
import { ToolRouter } from "../src/core/tools/toolRouter";
import { VerificationRegistry } from "../src/core/tools/verification/verificationRegistry";

// Simulate what callDesktopAgentTransport now returns after the fix:
// the Python canonical (body.canonical) as the result, not the raw result.
function makePythonCanonical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    status: "SUCCESS",
    execution_status: "SUCCESS",
    verification_status: "VERIFIED",
    verified: true,
    executed: true,
    tool: "takeScreenshot",
    operation_id: "op-screenshot-001",
    message: "Screenshot captured successfully.",
    timestamp: Date.now(),
    retryable: false,
    data: {
      screenshot_id: "scr-001",
      width: 1920,
      height: 1080,
      result: "screenshot saved",
    },
    verification: {
      verified: true,
      method: "screen",
    },
    ...overrides,
  };
}

test("Python canonical result with ok:true is recognized as executionStatus=success", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  // Simulate the fixed transport: returns Python canonical as `result`
  router.setAdapter(async () => ({
    ok: true,
    result: makePythonCanonical(),
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);
  const result = await orchestrator.executeWithVerification("takeScreenshot", {}, {
    enableVerification: false, // no verifier registered, skip phase 2
  });

  assert.equal(result.executionStatus, "success", "Python ok:true should map to executionStatus=success");
  assert.equal(result.success, true);
});

test("Python canonical with verified:true produces verified result when ScreenVerifier passes", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  // Register a mock screen verifier that passes
  registry.registerVerifier("screen_pass", {
    canVerify: (tool) => tool === "takeScreenshot",
    verify: async (_tool, _args, executionResult) => {
      // The executionResult should now be the canonical with data.width/height
      const canonical = executionResult as Record<string, any>;
      const data = canonical?.data ?? canonical;
      const dimensionsOk = Number(data?.width) > 0 && Number(data?.height) > 0;
      return {
        verified: dimensionsOk,
        method: "screen",
        checks: [{ name: "dimensions", passed: dimensionsOk, evidence: { width: data?.width, height: data?.height } }],
        details: dimensionsOk ? "Dimensions valid." : "No dimensions.",
        confidence: dimensionsOk ? 0.95 : 0,
      };
    },
    timeout: 2000,
  });
  registry.mapToolToVerifier("takeScreenshot", ["screen_pass"]);

  router.setAdapter(async () => ({
    ok: true,
    result: makePythonCanonical(),
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);
  const result = await orchestrator.executeWithVerification("takeScreenshot", {});

  assert.equal(result.executionStatus, "success", "Execution should be success");
  assert.equal(result.verificationStatus, "verified", "Verification should pass (has width+height in canonical.data)");
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
});

test("Python canonical with ok:false is recognized as executionStatus=failed", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  router.setAdapter(async () => ({
    ok: false,
    result: makePythonCanonical({ ok: false, status: "FAILED", execution_status: "FAILED", verified: false }),
    error: "Tool failed on Python side",
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);
  const result = await orchestrator.executeWithVerification("takeScreenshot", {}, {
    enableVerification: false,
  });

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.success, false);
});

test("Legacy raw result (no execution_status) with ok:true is still treated as success", async () => {
  // Legacy tools that return just { result: "done" } without canonical fields
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  router.setAdapter(async () => ({
    ok: true,
    result: { result: "Volume set to 50%" }, // raw legacy output
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);
  const result = await orchestrator.executeWithVerification("setVolume", {}, {
    enableVerification: false,
  });

  // With the fix, ok:true on routedResult means executionStatus=success
  assert.equal(result.executionStatus, "success", "Legacy ok:true should still map to success");
  assert.equal(result.success, true);
});
