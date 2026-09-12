import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionOrchestrator } from "../src/core/tools/execution/executionOrchestrator";
import { ToolRouter } from "../src/core/tools/toolRouter";
import { VerificationRegistry } from "../src/core/tools/verification/verificationRegistry";
import { FilesystemVerifier } from "../src/core/tools/verification/filesystemVerifier";
import { VerificationEngine } from "../src/core/verification/verificationEngine";
import { TaskExecutionStatus, TaskPriority, TaskVerificationStatus } from "../src/core/tasks/taskContract";

test("ExecutionOrchestrator executes and verifies filesystem operations", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  // Register filesystem verifier
  const fsVerifier = new FilesystemVerifier();
  registry.registerVerifier("filesystem", fsVerifier);
  registry.mapToolToVerifier("createFolder", ["filesystem"]);

  // Mock adapter returns success
  router.setAdapter(async (tool, args) => ({
    ok: true,
    result: {
      status: "SUCCESS",
      execution_status: "SUCCESS",
      verification_status: "UNCERTAIN",
      executed: true,
      tool,
      operation_id: `op-${Date.now()}`,
    },
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);

  // Execute with verification
  const result = await orchestrator.executeWithVerification("createFolder", {
    folder: "/tmp/sara_test_folder_12345",
  });

  assert.equal(result.executionStatus, "success");
  assert.ok(result.totalDurationMs > 0);
  assert.equal(result.tool, "createFolder");
  assert.ok(result.correlationId);
  assert.ok(result.toolCallId);
});

test("ExecutionOrchestrator fails when execution fails", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  // Mock adapter returns failure
  router.setAdapter(async () => ({
    ok: false,
    error: "Tool not found",
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);

  const result = await orchestrator.executeWithVerification("unknownTool", {});

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.success, false);
  assert.ok(result.executionError);
});

test("ExecutionOrchestrator sets status to failed when verification fails", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  // Register a verifier that always fails
  registry.registerVerifier("filesystem", {
    canVerify: () => true,
    verify: async () => ({
      verified: false,
      method: "filesystem",
      checks: [{ name: "test", passed: false }],
      details: "Verification failed",
      confidence: 0,
    }),
    timeout: 1000,
  });
  registry.mapToolToVerifier("testTool", ["filesystem"]);

  // Mock adapter returns success
  router.setAdapter(async () => ({
    ok: true,
    result: {
      status: "SUCCESS",
      execution_status: "SUCCESS",
      verification_status: "UNCERTAIN",
      executed: true,
    },
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);

  const result = await orchestrator.executeWithVerification("testTool", {});

  // Execution succeeded but verification failed
  assert.equal(result.executionStatus, "success");
  assert.equal(result.verificationStatus, "failed");
  assert.equal(result.status, "failed"); // Final status is failed
  assert.equal(result.success, false);
});

test("ExecutionOrchestrator skips verification when disabled", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  const registry = new VerificationRegistry();

  router.setAdapter(async () => ({
    ok: true,
    result: { status: "SUCCESS", execution_status: "SUCCESS" },
  }));

  const orchestrator = new ExecutionOrchestrator(router, registry);

  const result = await orchestrator.executeWithVerification("testTool", {}, {
    enableVerification: false,
  });

  assert.equal(result.executionStatus, "success");
  assert.equal(result.verificationStatus, "not_required");
  assert.equal(result.success, true); // Success because verification not required
});

test("VerificationEngine marks a task as verifying without treating it as skipped", async () => {
  const engine = new VerificationEngine();
  const task = {
    taskId: "task-1",
    correlationId: "corr-1",
    conversationId: "conv-1",
    toolCallId: "tool-1",
    toolName: "testTool",
    arguments: { foo: "bar" },
    status: TaskExecutionStatus.RUNNING,
    createdAt: new Date().toISOString(),
    attempt: 1,
    maxAttempts: 3,
    priority: TaskPriority.NORMAL,
    source: "chat",
    verificationStatus: TaskVerificationStatus.SKIPPED,
    childTaskIds: [],
    userVisibleStatus: "Running",
  };

  const updated = await engine.markVerifying(task);

  assert.equal(updated.status, TaskExecutionStatus.VERIFYING);
  assert.equal(updated.verificationStatus, TaskVerificationStatus.UNCERTAIN);
  assert.equal(updated.userVisibleStatus, "Verifying");
});
