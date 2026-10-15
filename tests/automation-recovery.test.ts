import test from "node:test";
import assert from "node:assert/strict";
import { AutomationOrchestrator } from "../src/core/automation/automationOrchestrator";
import { createTaskContext } from "../src/core/automation/taskContext";

test("restored automation tasks preserve checkpoints and stay paused until reviewed", async () => {
  let executions = 0;
  const orchestrator = new AutomationOrchestrator(async () => {
    executions += 1;
    return { ok: true };
  });
  const context = createTaskContext({
    task_id: "automation-recovery-1",
    conversation_id: "conversation-1",
    goal: "Send a message",
    original_command: "Send the approved message",
    current_step: "provider_request",
    task_state: "RUNNING",
  });
  context.completed_actions.push("prepare_message");
  const checkpoint = {
    task_progress: 60,
    completed_steps: ["prepare_message"],
    automationContext: context,
  };
  const events: string[] = [];
  orchestrator.on((event) => events.push(event.type));

  orchestrator.restore([{
    task_id: "automation-recovery-1",
    tool: "whatsapp_send",
    args: { phone: "+919876543210", message: "hello" },
    priority: "NORMAL",
    status: "RUNNING",
    progress: 60,
    checkpoint,
  }]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const task = orchestrator.getTask("automation-recovery-1");
  assert.ok(task);
  assert.equal(task.status, "PAUSED");
  assert.equal(task.task_state, "WAITING_FOR_USER");
  assert.deepEqual(task.checkpoint?.completed_steps, ["prepare_message"]);
  assert.equal((task.checkpoint?.recovery as any).automaticReplay, false);
  assert.deepEqual(task.context?.completed_actions, ["prepare_message"]);
  assert.ok(events.includes("RECOVERY_PAUSED"));
  assert.equal(executions, 0, "restore must not replay an externally visible action");
});
