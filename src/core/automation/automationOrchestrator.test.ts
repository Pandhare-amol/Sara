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

test("only reviewed long voice actions are queued; generic agents, approvals and status tools stay direct", () => {
  assert.equal(isAsyncAutomationTool("desktopBrowserReadPage"), true);
  assert.equal(isAsyncAutomationTool("openApplication", { name: "notepad" }), true);
  assert.equal(isAsyncAutomationTool("openApplication", { application: "calculator" }), true);
  assert.equal(isAsyncAutomationTool("openApplication", { name: "arbitrary-program.exe" }), false);
  assert.equal(isAsyncAutomationTool("saraDocumentCreate", { path: "Documents/report.docx" }), true);
  assert.equal(isAsyncAutomationTool("saraDocumentEdit", { path: "Documents/report.docx" }), true);
  assert.equal(isAsyncAutomationTool("saraDocumentOpen", { path: "Documents/report.docx" }), true);
  assert.equal(isAsyncAutomationTool("saraDocumentEdit", {}), false);
  assert.equal(isAsyncAutomationTool("saraDocumentInspect", { path: "Documents/report.docx" }), false);
  for (const name of ["saraAgentExecute", "saraTaskSubmit", "saraTaskStatus", "saraTaskCancel", "saraAgentEmergencyStop", "requestPowerAction", "whatsappSend", "hardwareKeyboardPress"]) {
    assert.equal(isAsyncAutomationTool(name), false, `${name} must retain its existing policy/result handling`);
  }
});

test("app-goal tasks join reviewed background work; only named safe app opens are queued", () => {
  assert.equal(isAsyncAutomationTool("saraAppExecuteGoal"), true);
  assert.equal(isAsyncAutomationTool("openApplication", { name: "notepad" }), true);
  assert.equal(isAsyncAutomationTool("openApplication", { name: "arbitrary-program.exe" }), false);
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

test("queued app launch does not block status checks or overlap another desktop action", async () => {
  const pending = deferred<unknown>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    calls.push(tool);
    return tool === "openApplication" ? pending.promise : verifiedResult();
  });
  const launch = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" }, conversationId: "voice-1" });
  await nextTurn();
  assert.equal(orchestrator.getTask(launch.task_id)?.status, "RUNNING");
  const browser = orchestrator.submit({ tool: "desktopBrowserReadPage", args: {} });
  orchestrator.submit({ tool: "systemInfo", args: {} });
  await nextTurn();
  assert.deepEqual(calls, ["openApplication", "systemInfo"]);
  assert.equal(orchestrator.getTask(browser.task_id)?.status, "QUEUED");
  pending.resolve({ success: true, verified: false });
  await nextTurn();
  await nextTurn();
  assert.deepEqual(calls, ["openApplication", "systemInfo", "desktopBrowserReadPage"]);
  assert.equal(orchestrator.getTask(launch.task_id)?.status, "PAUSED", "A launch attempt is not proof that the app opened.");
});

test("two Office edits serialize but an unrelated status request can run during the first", async () => {
  const pending = deferred<unknown>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    calls.push(tool);
    return tool === "saraDocumentCreate" ? pending.promise : verifiedResult();
  });
  const first = orchestrator.submit({ tool: "saraDocumentCreate", args: { path: "draft.docx" } });
  await nextTurn();
  const second = orchestrator.submit({ tool: "saraDocumentEdit", args: { path: "draft.docx" } });
  orchestrator.submit({ tool: "systemInfo", args: {} });
  await nextTurn();
  assert.deepEqual(calls, ["saraDocumentCreate", "systemInfo"]);
  assert.equal(orchestrator.getTask(second.task_id)?.status, "QUEUED");
  pending.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(first.task_id)?.status, "COMPLETED");
  assert.deepEqual(calls, ["saraDocumentCreate", "systemInfo", "saraDocumentEdit"]);
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
  assert.equal(executorCalls, 1, "GUI-affecting app goals must be serialized");

  const stop = orchestrator.emergencyStop();
  assert.deepEqual(stop.cancelledQueuedTaskIds, [...active.slice(1), queued].map((task) => task.task_id));
  assert.deepEqual(stop.cancellationRequestedTaskIds, [active[0].task_id]);
  for (const task of [...active.slice(1), queued]) {
    assert.equal(orchestrator.getTask(task.task_id)?.status, "CANCELLED");
  }

  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  await nextTurn();
  const stopped = orchestrator.getTask(active[0].task_id);
  assert.equal(stopped?.status, "PAUSED");
  assert.equal(stopped?.stop_requested, true);
  assert.match(stopped?.error || "", /may have completed external effects/i);
  assert.equal((stopped?.checkpoint?.recovery as any)?.automaticReplay, false);
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

test("a bare success/verified flag without verification checks cannot complete a queued task", async () => {
  const orchestrator = new AutomationOrchestrator(async () => ({ success: true, verified: true }));
  const task = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(task.task_id)?.status, "PAUSED");
});

test("independent canonical verification evidence allows a queued task to complete", async () => {
  const orchestrator = new AutomationOrchestrator(async () => ({
    success: true, verified: true, verificationStatus: "verified",
    verificationChecks: [{ name: "window_found", passed: true }],
  }));
  const task = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(task.task_id)?.status, "COMPLETED");
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

test("SARA 8 queue applies global backpressure without allocating rejected tasks", async () => {
  const gate = deferred<unknown>();
  const orchestrator = new AutomationOrchestrator(async () => gate.promise, { maxQueued: 2, maxRecords: 6 });
  const running = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  orchestrator.submit({ tool: "desktopBrowserOpen", args: {} });
  orchestrator.submit({ tool: "saraDocumentEdit", args: { path: "draft.docx" } });
  assert.throws(() => orchestrator.submit({ tool: "youtube_play", args: {} }), /queue is full/i);
  assert.equal(orchestrator.listTasks().length, 3);
  assert.equal(orchestrator.cancelTask(running.task_id), true);
  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
});

test("running stop is a request, never an unverified cancellation; uncertain effects stay paused", async () => {
  const held = deferred<unknown>();
  const orchestrator = new AutomationOrchestrator(async () => held.promise);
  const task = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  assert.equal(orchestrator.cancelTask(task.task_id), true);
  assert.equal(orchestrator.getTask(task.task_id)?.status, "CANCELLING");
  assert.equal(orchestrator.cancelTask(task.task_id), false);
  held.resolve({ success: true, verified: false });
  await nextTurn();
  await nextTurn();
  assert.equal(orchestrator.getTask(task.task_id)?.status, "PAUSED");
  assert.equal(orchestrator.resumeTask(task.task_id), undefined);
  assert.equal(orchestrator.cancelTask(task.task_id), false, "an uncertain effect cannot be labelled cancelled");
});

test("a running stop preserves independently verified completion or confirmed non-execution", async () => {
  for (const [result, expected] of [
    [verifiedResult(), "COMPLETED"],
    [{ executionStatus: "failed", executionResult: { executed: false }, error: "not started" }, "CANCELLED"],
  ] as const) {
    const held = deferred<unknown>();
    const orchestrator = new AutomationOrchestrator(async () => held.promise);
    const task = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
    await nextTurn();
    assert.equal(orchestrator.cancelTask(task.task_id), true);
    held.resolve(result);
    await nextTurn();
    await nextTurn();
    assert.equal(orchestrator.getTask(task.task_id)?.status, expected);
  }
});

test("pause/resume acts only before dispatch and cannot bypass the deadline", async () => {
  const gate = deferred<unknown>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    calls.push(tool);
    return tool === "openApplication" ? gate.promise : verifiedResult();
  });
  const first = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  assert.equal(orchestrator.pauseTask(first.task_id), false);
  const later = orchestrator.submit({ tool: "saraDocumentEdit", args: { path: "draft.docx" } });
  assert.equal(orchestrator.pauseTask(later.task_id), true);
  await nextTurn();
  assert.deepEqual(calls, ["openApplication"]);
  assert.equal(orchestrator.getTask(later.task_id)?.status, "PAUSED");
  assert.equal(orchestrator.resumeTask(later.task_id)?.status, "QUEUED");
  gate.resolve(verifiedResult());
  await nextTurn();
  await nextTurn();
  assert.deepEqual(calls, ["openApplication", "saraDocumentEdit"]);
});

test("queue deadlines fail before dispatch; read-only non-execution retries at most once", async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    if (tool === "openApplication") return gate.promise;
    calls += 1;
    return calls === 1 ? { executionStatus: "failed", executed: false } : verifiedResult();
  });
  const blocker = orchestrator.submit({ tool: "openApplication", args: { name: "notepad" } });
  await nextTurn();
  const expired = orchestrator.submit({ tool: "saraDocumentEdit", args: {}, deadlineMs: 1_000 });
  const status = orchestrator.submit({ tool: "systemInfo", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(orchestrator.getTask(status.task_id)?.status, "COMPLETED");
  assert.equal(orchestrator.getTask(status.task_id)?.retry_count, 1);
  assert.equal(calls, 2);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(orchestrator.getTask(expired.task_id)?.status, "FAILED");
  assert.equal(orchestrator.getTask(expired.task_id)?.started_at, undefined);
  gate.resolve(verifiedResult());
  await nextTurn();
  assert.equal(orchestrator.getTask(blocker.task_id)?.status, "COMPLETED");
});

test("public task status does not expose private tool args, result, goals, or checkpoints", async () => {
  const orchestrator = new AutomationOrchestrator(async () => verifiedResult({ private: "secret-result" }));
  const task = orchestrator.submit({ tool: "systemInfo", args: { token: "secret-args" }, goal: "secret-goal", conversationId: "one" });
  await nextTurn();
  const { publicAutomationTask } = await import("./automationOrchestrator");
  const projected = publicAutomationTask(orchestrator.getTask(task.task_id)!);
  assert.equal(projected.status, "COMPLETED");
  assert.equal(projected.verified, true);
  assert.doesNotMatch(JSON.stringify(projected), /secret-args|secret-result|secret-goal/);
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
