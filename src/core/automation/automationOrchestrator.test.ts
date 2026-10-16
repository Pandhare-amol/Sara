import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutomationOrchestrator, createAutomationOperationTaskId, isAsyncAutomationTool } from "./automationOrchestrator";
import { createTaskContext, resumeFromTaskContext } from "./taskContext";

const previousDataDir = process.env.SARA_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-automation-orchestrator-"));
process.env.SARA_DATA_DIR = testDataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.SARA_DATA_DIR;
  else process.env.SARA_DATA_DIR = previousDataDir;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function verifiedResult(result: unknown = "done") {
  return { state: "SUCCEEDED", success: true, verified: true, verification: { attempted: true, passed: true, checks: [{ name: "postcondition", passed: true }] }, result };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("app-goal tasks are queued while direct app opens remain synchronous", () => {
  assert.equal(isAsyncAutomationTool("saraAppExecuteGoal"), true);
  assert.equal(isAsyncAutomationTool("openApplication"), false);
});

test("post-success cleanup runs only after explicit task verification and does not undo task success", async () => {
  let cleanupCalls = 0;
  const orchestrator = new AutomationOrchestrator(
    async () => verifiedResult("helper task"),
    async () => {
      cleanupCalls += 1;
      return { ok: false, verified: false, status: "left_open", result: "Unsaved work prompt." };
    },
  );
  const task = orchestrator.submit({ tool: "saraAppExecuteGoal", args: { goal: "complete a helper task" } });
  await nextTurn();
  await nextTurn();

  const result = orchestrator.getTask(task.task_id);
  assert.equal(cleanupCalls, 1);
  assert.equal(result?.status, "COMPLETED");
  assert.equal((result?.result as any)?.autoClose?.verified, false);
  assert.match((result?.result as any)?.autoClose?.result || "", /unsaved work prompt/i);
});

test("the unified execution result is accepted only with passing verification checks", async () => {
  const orchestrator = new AutomationOrchestrator(async () => ({
    success: true,
    status: "success",
    executionStatus: "success",
    verificationStatus: "verified",
    verificationChecks: [{ name: "postcondition", passed: true }],
    verified: true,
  }));
  const task = orchestrator.submit({ tool: "desktopBrowserOpen", args: { url: "https://example.com" } });
  await nextTurn();
  await nextTurn();

  assert.equal(orchestrator.getTask(task.task_id)?.status, "COMPLETED");
});

test("unsubstantiated or contradictory verified flags pause and never trigger cleanup", async () => {
  const unsubstantiatedResults = [
    { success: true, verified: true },
    { success: true, verified: true, executionResult: { verified: true } },
    { success: true, verified: true, verification: { passed: true, checks: [{ name: "postcondition", passed: true }] } },
    { success: true, verified: false, verification: { attempted: true, passed: true, checks: [{ name: "postcondition", passed: true }] } },
    { success: true, verified: true, verification: { attempted: true, passed: true, checks: [{ name: "postcondition", passed: false }] } },
    { success: true, verified: true, executionStatus: "success", verificationStatus: "verified", verificationChecks: [] },
    { success: true, verified: true, state: "FAILED", verification: { attempted: true, passed: true, checks: [{ name: "postcondition", passed: true }] } },
    { success: true, verified: true, status: "failed", executionStatus: "success", verificationStatus: "verified", verificationChecks: [{ name: "postcondition", passed: true }] },
    { success: true, verified: true, status: "success", executionStatus: "failed", verificationStatus: "verified", verificationChecks: [{ name: "postcondition", passed: true }] },
  ];

  for (const outcome of unsubstantiatedResults) {
    let cleanupCalls = 0;
    const orchestrator = new AutomationOrchestrator(
      async () => outcome,
      async () => { cleanupCalls += 1; return { ok: true, verified: true }; },
    );
    const task = orchestrator.submit({ tool: "saraAppExecuteGoal", args: { goal: "complete a helper task" } });
    await nextTurn();
    await nextTurn();

    assert.equal(orchestrator.getTask(task.task_id)?.status, "PAUSED");
    assert.equal(cleanupCalls, 0);
  }
});

test("AutomationOrchestrator submits without waiting for the executor", () => {
  const gate = deferred<unknown>();
  const orchestrator = new AutomationOrchestrator(async () => gate.promise);
  const task = orchestrator.submit({ tool: "youtube_play", args: { query: "Python lectures" } });

  assert.equal(task.status, "QUEUED");
  assert.equal(orchestrator.getTask(task.task_id)?.status, "QUEUED");
  gate.resolve(verifiedResult());
});

test("AutomationOrchestrator serializes browser tasks while allowing independent work to start", async () => {
  const first = deferred<unknown>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    calls.push(tool);
    if (tool === "youtube_play") return first.promise;
    return verifiedResult("weather");
  });

  const video = orchestrator.submit({ tool: "youtube_play", args: {} });
  orchestrator.submit({ tool: "systemInfo", args: {}, priority: "HIGH" });
  await nextTurn();

  assert.deepEqual(calls, ["systemInfo", "youtube_play"]);
  first.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(video.task_id)?.status, "COMPLETED");
});

test("AutomationOrchestrator cancels queued tasks before execution", async () => {
  const gate = deferred<unknown>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async () => {
    calls.push("running");
    return gate.promise;
  });
  const running = orchestrator.submit({ tool: "youtube_play", args: {} });
  const queued = orchestrator.submit({ tool: "youtube_pause", args: {} });
  await nextTurn();

  assert.equal(orchestrator.cancelTask(queued.task_id), true);
  assert.equal(orchestrator.getTask(queued.task_id)?.status, "CANCELLED");
  assert.equal(calls.length, 1);
  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(running.task_id)?.status, "COMPLETED");
});

test("emergency stop cancels queued work and preserves active work for review without cleanup", async () => {
  const gate = deferred<unknown>();
  let executorCalls = 0;
  let cleanupCalls = 0;
  const orchestrator = new AutomationOrchestrator(
    async () => { executorCalls += 1; return gate.promise; },
    async () => { cleanupCalls += 1; return { ok: true, verified: true }; },
  );
  const active = Array.from({ length: 4 }, () => orchestrator.submit({ tool: "saraAppExecuteGoal", args: { goal: "finish helper work" } }));
  const queued = orchestrator.submit({ tool: "saraAppExecuteGoal", args: { goal: "do more helper work" } });
  await nextTurn();
  assert.equal(executorCalls, 4);

  const stop = orchestrator.emergencyStop();
  assert.deepEqual(stop.cancelledQueuedTaskIds, [queued.task_id]);
  assert.deepEqual(stop.cancellationRequestedTaskIds.sort(), active.map((task) => task.task_id).sort());
  assert.equal(orchestrator.getTask(queued.task_id)?.status, "CANCELLED");

  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  await nextTurn();
  for (const task of active) {
    const stopped = orchestrator.getTask(task.task_id);
    assert.equal(stopped?.status, "PAUSED");
    assert.equal(stopped?.stop_requested, true);
    assert.match(stopped?.error || "", /may have completed external effects/i);
    assert.equal((stopped?.checkpoint?.recovery as any)?.automaticReplay, false);
  }
  assert.equal(cleanupCalls, 0);
});

test("unverified outcomes pause for review and are never reported completed", async () => {
  const events: string[] = [];
  const orchestrator = new AutomationOrchestrator(async () => ({ success: true, verified: false, executionStatus: "success" }));
  orchestrator.on((event) => events.push(event.type));
  const task = orchestrator.submit({ tool: "desktopBrowserOpen", args: { url: "https://example.com" } });
  await nextTurn();
  await nextTurn();

  const result = orchestrator.getTask(task.task_id);
  assert.equal(result?.status, "PAUSED");
  assert.equal(result?.task_state, "WAITING_FOR_USER");
  assert.match(result?.error || "", /review the external state before explicitly retrying/i);
  assert.equal((result?.checkpoint?.recovery as any)?.automaticReplay, false);
  assert.ok(events.includes("VERIFICATION_STARTED"));
  assert.ok(events.includes("VERIFICATION_FAILED"));
  assert.ok(events.includes("RECOVERY_PAUSED"));
  assert.ok(!events.includes("TASK_COMPLETED"));
});

test("Persisted task context survives GEMINI disconnect and resumes from the last confirmed step", () => {
  const context = createTaskContext({
    task_id: "task-ctx-1",
    conversation_id: "conv-1",
    goal: "Open YouTube and play Python tutorial",
    original_command: "Open YouTube and play Python tutorial",
    current_step: "find_video",
    task_state: "RECOVERING",
  });

  const resumed = resumeFromTaskContext(context, "open_video");
  assert.equal(resumed.task_state, "RUNNING");
  assert.equal(resumed.current_step, "open_video");
  assert.equal(resumed.goal, "Open YouTube and play Python tutorial");
});

test("operation task ids are stable within a session and isolated across sessions/tools", () => {
  const first = createAutomationOperationTaskId("session-1", "conversation-1", "call-1", "desktopBrowserOpen");
  assert.equal(first, createAutomationOperationTaskId("session-1", "conversation-1", "call-1", "desktopBrowserOpen"));
  assert.notEqual(first, createAutomationOperationTaskId("session-2", "conversation-1", "call-1", "desktopBrowserOpen"));
  assert.notEqual(first, createAutomationOperationTaskId("session-1", "conversation-1", "call-1", "desktopBrowserSearch"));
  assert.match(first, /^SARA-OP-[A-F0-9]{24}$/);
});

test("duplicate task submissions with the same id and JSON request do not execute twice", async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const orchestrator = new AutomationOrchestrator(async () => {
    calls += 1;
    return gate.promise;
  });
  const first = orchestrator.submit({
    task_id: "duplicate-operation-1",
    tool: "desktopBrowserOpen",
    args: { url: "https://example.com", options: { waitUntil: "load", timeout: 5000 } },
    sessionId: "session-1",
    conversationId: "conversation-1",
  });
  const duplicate = orchestrator.submit({
    task_id: "duplicate-operation-1",
    tool: "desktopBrowserOpen",
    args: { options: { timeout: 5000, waitUntil: "load" }, url: "https://example.com" },
    sessionId: "session-1",
    conversationId: "conversation-1",
  });

  assert.equal(duplicate.task_id, first.task_id);
  assert.equal(duplicate.status, "QUEUED");
  assert.equal(orchestrator.listTasks().length, 1);
  await nextTurn();
  assert.equal(calls, 1);
  gate.resolve(verifiedResult("opened"));
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(first.task_id)?.status, "COMPLETED");

  const replay = orchestrator.submit({
    task_id: "duplicate-operation-1",
    tool: "desktopBrowserOpen",
    args: { url: "https://example.com", options: { waitUntil: "load", timeout: 5000 } },
    sessionId: "session-1",
    conversationId: "conversation-1",
  });
  assert.equal(replay.status, "COMPLETED");
  assert.equal(calls, 1);
});

test("reusing a task id with changed arguments or session fails closed", async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const orchestrator = new AutomationOrchestrator(async () => {
    calls += 1;
    return gate.promise;
  });
  orchestrator.submit({
    task_id: "conflicting-operation-1",
    tool: "desktopBrowserOpen",
    args: { url: "https://example.com" },
    sessionId: "session-1",
    conversationId: "conversation-1",
  });

  assert.throws(() => orchestrator.submit({
    task_id: "conflicting-operation-1",
    tool: "desktopBrowserOpen",
    args: { url: "https://other.example" },
    sessionId: "session-1",
    conversationId: "conversation-1",
  }), /reused for a different request/i);
  assert.throws(() => orchestrator.submit({
    task_id: "conflicting-operation-1",
    tool: "desktopBrowserOpen",
    args: { url: "https://example.com" },
    sessionId: "session-2",
    conversationId: "conversation-1",
  }), /reused for a different request/i);
  await nextTurn();
  assert.equal(calls, 1);
  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.listTasks().length, 1);
});
