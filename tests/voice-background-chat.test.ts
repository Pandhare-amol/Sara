import test from "node:test";
import assert from "node:assert/strict";
import { AutomationOrchestrator } from "../src/core/automation/automationOrchestrator";
import { canInjectSocialPlan, liveAutomationTaskStatus, respondToLiveTool } from "../src/core/automation/liveToolResponses";
import { queueVoiceAutomation } from "../src/core/automation/voiceQueue";

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function nextTurn(): Promise<void> { return new Promise((done) => setImmediate(done)); }

test("a slow direct tool call does not block another Live message callback", async () => {
  const held = deferred<string>();
  const responses: string[] = [];
  respondToLiveTool(() => held.promise, (value) => responses.push(value), () => assert.fail("unexpected error"));
  respondToLiveTool(async () => "I can keep listening", (value) => responses.push(value), () => assert.fail("unexpected error"));
  await nextTurn();
  assert.deepEqual(responses, ["I can keep listening"]);
  held.resolve("first tool finished");
  await nextTurn();
  assert.deepEqual(responses, ["I can keep listening", "first tool finished"]);
});

test("voice queue acknowledges pending work, deduplicates a repeated call id and limits active work", async () => {
  const held = deferred<unknown>();
  let executions = 0;
  const orchestrator = new AutomationOrchestrator(async () => { executions++; return held.promise; });
  const input = { tool: "openApplication", args: { name: "notepad", operation_id: "fc-1-openApplication" },
    sessionId: "voice-1", conversationId: "conv-1" };
  const queued = queueVoiceAutomation(orchestrator, input);
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.verified, false);
  assert.ok(queued.task_id);
  assert.equal(queueVoiceAutomation(orchestrator, input).task_id, queued.task_id);
  const changedArgs = queueVoiceAutomation(orchestrator, { ...input, args: { name: "chrome", operation_id: input.args.operation_id } });
  assert.equal(changedArgs.ok, false, "An existing operation ID cannot be rebound to a different app.");
  assert.equal(changedArgs.status, "CONFLICT");
  for (let index = 2; index <= 4; index++) {
    assert.equal(queueVoiceAutomation(orchestrator, { ...input, args: { ...input.args, operation_id: `fc-${index}-openApplication` } }).status, "QUEUED");
  }
  const fifth = queueVoiceAutomation(orchestrator, { ...input, args: { ...input.args, operation_id: "fc-5-openApplication" } });
  assert.equal(fifth.status, "BUSY");
  assert.equal(fifth.ok, false);
  await nextTurn();
  assert.equal(executions, 1, "Conflicting foreground actions must be serialized.");
  held.resolve({ success: true, verified: false });
});

test("optional social plan from a previous or completed voice turn cannot interrupt the next answer", () => {
  assert.equal(canInjectSocialPlan(1, 1, 0, false, true), true);
  assert.equal(canInjectSocialPlan(1, 2, 0, false, true), false);
  assert.equal(canInjectSocialPlan(2, 2, 2, false, true), false);
  assert.equal(canInjectSocialPlan(2, 2, 1, true, true), false);
  assert.equal(canInjectSocialPlan(2, 2, 1, false, false), false);
});

test("task status is scoped to the voice conversation and never equates queued or unverified with success", async () => {
  const held = deferred<unknown>();
  const orchestrator = new AutomationOrchestrator(async () => held.promise);
  const task = orchestrator.submit({ tool: "openApplication", args: { name: "notepad", secret: "do not expose" }, conversationId: "one" });
  const queued = liveAutomationTaskStatus(orchestrator, task.task_id, "one");
  assert.equal(queued.ok, true);
  assert.equal(queued.verified, false);
  assert.equal(queued.status, "QUEUED");
  assert.doesNotMatch(JSON.stringify(queued), /do not expose/);
  assert.deepEqual(liveAutomationTaskStatus(orchestrator, task.task_id, "another"), {
    ok: false, error: "Task not found for this conversation.",
  });
  await nextTurn();
  assert.equal(liveAutomationTaskStatus(orchestrator, task.task_id, "one").status, "RUNNING");
  held.resolve({ success: true, verified: false });
  await nextTurn();
  await nextTurn();
  const uncertain = liveAutomationTaskStatus(orchestrator, task.task_id, "one");
  assert.equal(uncertain.status, "PAUSED");
  assert.equal(uncertain.review_required, true);
  assert.equal(uncertain.verified, false);
});
