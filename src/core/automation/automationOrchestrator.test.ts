import test from "node:test";
import assert from "node:assert/strict";
import { AutomationOrchestrator } from "./automationOrchestrator";
import { createTaskContext, resumeFromTaskContext } from "./taskContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("AutomationOrchestrator submits without waiting for the executor", () => {
  const gate = deferred<string>();
  const orchestrator = new AutomationOrchestrator(async () => gate.promise);
  const task = orchestrator.submit({ tool: "youtube_play", args: { query: "Python lectures" } });

  assert.equal(task.status, "QUEUED");
  assert.equal(orchestrator.getTask(task.task_id)?.status, "QUEUED");
  gate.resolve("playing");
});

test("AutomationOrchestrator serializes browser tasks while allowing independent work to start", async () => {
  const first = deferred<string>();
  const calls: string[] = [];
  const orchestrator = new AutomationOrchestrator(async (tool) => {
    calls.push(tool);
    if (tool === "youtube_play") return first.promise;
    return "weather";
  });

  const video = orchestrator.submit({ tool: "youtube_play", args: {} });
  orchestrator.submit({ tool: "systemInfo", args: {}, priority: "HIGH" });
  await nextTurn();

  assert.deepEqual(calls, ["systemInfo", "youtube_play"]);
  first.resolve("done");
  await nextTurn();
  assert.equal(orchestrator.getTask(video.task_id)?.status, "COMPLETED");
});

test("AutomationOrchestrator cancels queued tasks before execution", async () => {
  const gate = deferred<string>();
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
  gate.resolve("done");
  await nextTurn();
  assert.equal(orchestrator.getTask(running.task_id)?.status, "COMPLETED");
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