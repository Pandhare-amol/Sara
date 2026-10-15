import test from "node:test";
import assert from "node:assert/strict";
import { AutomationOrchestrator } from "./automationOrchestrator";
import { createTaskContext, resumeFromTaskContext } from "./taskContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function verifiedResult(result: unknown = "done") {
  return { success: true, verified: true, verification: { attempted: true, passed: true, checks: [{ name: "postcondition", passed: true }] }, result };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
