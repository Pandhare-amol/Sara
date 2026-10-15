import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createUserResponseFromResult, isVerifiedTaskSuccess, type AuthoritativeTaskResult } from "../src/types/AuthoritativeTaskResult";
import { TaskManager } from "../src/core/tasks/taskManager";
import { TaskRepository } from "../src/core/tasks/taskRepository";
import { TaskExecutionStatus } from "../src/core/tasks/taskContract";
import { finalStatusForToolResult } from "../src/core/contracts/toolContract";

function result(overrides: Partial<AuthoritativeTaskResult> = {}): AuthoritativeTaskResult {
  return {
    taskId: "task-1",
    state: "SUCCEEDED",
    success: true,
    verified: true,
    goal: "Open the requested page",
    summary: "The requested page was opened.",
    actions: [],
    verification: { attempted: true, passed: true, method: "browser_state", checks: [{ name: "url_matches", passed: true }] },
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("only a complete result with attempted, passing verification counts as verified success", () => {
  assert.equal(isVerifiedTaskSuccess(result()), true);
  assert.equal(isVerifiedTaskSuccess(result({ verified: false })), false);
  assert.equal(isVerifiedTaskSuccess(result({ verification: { attempted: false, passed: true, checks: [] } })), false);
  assert.equal(isVerifiedTaskSuccess(result({ verification: { attempted: true, passed: false, checks: [] } })), false);
  assert.equal(isVerifiedTaskSuccess(result({ state: "PARTIAL" })), false);
});

test("user-facing result text does not turn an unverified success state into a success claim", () => {
  const unverified = result({ verified: false, verification: { attempted: true, passed: false, checks: [] } });
  const message = createUserResponseFromResult(unverified);
  assert.match(message, /couldn't independently verify/i);
  assert.doesNotMatch(message, /^The requested page was opened\./);
});

test("partial results warn users to review possible side effects before retrying", () => {
  const partial = result({
    state: "PARTIAL",
    success: false,
    verified: false,
    verification: { attempted: true, passed: false, checks: [] },
  });
  assert.match(createUserResponseFromResult(partial), /review them before retrying/i);
});

test("tool contracts do not treat missing verification as a successful task", () => {
  assert.equal(finalStatusForToolResult("SUCCESS", "VERIFIED"), "SUCCESS");
  assert.equal(finalStatusForToolResult("SUCCESS", "NOT_REQUIRED"), "UNCERTAIN");
  assert.equal(finalStatusForToolResult("SUCCESS", "SKIPPED"), "UNCERTAIN");
});

test("TaskManager pauses rather than completing when no verification evidence exists", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sara-task-manager-"));
  try {
    const manager = new TaskManager(new TaskRepository(path.join(directory, "tasks.json")));
    const task = manager.createTask({ conversationId: "test", toolName: "deleteFile" });
    const result = manager.markCompleted(task.taskId);
    assert.equal(result?.status, TaskExecutionStatus.PAUSED);
    assert.equal(result?.verificationStatus, "UNCERTAIN");
    assert.match(result?.error?.message || "", /review possible side effects/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("TaskManager completes only with explicit passing verification evidence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sara-task-manager-"));
  try {
    const manager = new TaskManager(new TaskRepository(path.join(directory, "tasks.json")));
    const task = manager.createTask({ conversationId: "test", toolName: "openWebsite" });
    const result = manager.markCompleted(task.taskId, {
      attempted: true,
      passed: true,
      checks: [{ name: "browser_url_matches", passed: true }],
    });
    assert.equal(result?.status, TaskExecutionStatus.COMPLETED);
    assert.equal(result?.verificationStatus, "VERIFIED");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
