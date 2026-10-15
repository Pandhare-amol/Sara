import test from "node:test";
import assert from "node:assert/strict";
import { ClosedLoopExecutor } from "../src/services/ClosedLoopExecutor";
import { createClosedLoopTask } from "../src/types/ClosedLoopTask";
import { createEmptyWorldState } from "../src/types/WorldState";

function makeTask() {
  return createClosedLoopTask({
    id: "recovery-verification-test",
    description: "Verify closed-loop recovery state",
    priority: "normal",
    context: {},
    authorityLevel: "NORMAL",
  });
}

function makeSubgoal() {
  return {
    id: "subgoal-1",
    parentGoalId: "recovery-verification-test",
    description: "Perform a verified recovery",
    preconditions: [],
    expectedEffect: "the target state is restored",
    expectedEffectObservable: true,
    skills: [],
    status: "EXECUTING",
    order: 0,
    recovery: [{
      id: "recovery-1",
      failureMode: "test failure",
      description: "restore target state",
      preconditions: [],
      actions: [{ id: "action-1", type: "wait", parameters: {}, timeoutMs: 100, retryable: false, maxRetries: 0, authorityLevel: "LOW_RISK" }],
      expectedEffect: "the target state is restored",
      verification: [],
      priority: 1,
      successRate: 1,
      estimatedDuration: 1,
    }],
  } as any;
}

test("recovery is not reported complete until its expected effect is verified", async () => {
  const executor = new ClosedLoopExecutor();
  const task = makeTask();
  task.currentState = "EXECUTING";
  const world = createEmptyWorldState();
  (executor as any).executeAction = async () => ({ success: true });
  (executor as any).observeWorld = async () => world;
  (executor as any).verifyExpectedEffect = async () => false;

  const recovered = await (executor as any).attemptRecovery(task, makeSubgoal(), {});
  assert.equal(recovered, false);
  assert.equal(executor.getExecutionLog(task.id).some((entry) => entry.eventType === "RECOVERY_COMPLETED"), false);
  assert.equal(executor.getExecutionLog(task.id).some((entry) => entry.eventType === "RECOVERY_FAILED"), true);
});

test("recovery completion is logged only after a positive verification result", async () => {
  const executor = new ClosedLoopExecutor();
  const task = makeTask();
  task.currentState = "EXECUTING";
  const world = createEmptyWorldState();
  (executor as any).executeAction = async () => ({ success: true });
  (executor as any).observeWorld = async () => world;
  (executor as any).verifyExpectedEffect = async () => true;

  const recovered = await (executor as any).attemptRecovery(task, makeSubgoal(), {});
  assert.equal(recovered, true);
  const completion = executor.getExecutionLog(task.id).find((entry) => entry.eventType === "RECOVERY_COMPLETED");
  assert.equal(completion?.details?.verified, true);
});

test("state-transition logs preserve the actual previous state and do not inflate action counts", async () => {
  const executor = new ClosedLoopExecutor();
  const task = makeTask();

  assert.equal(await (executor as any).transitionState(task, "PLANNING"), true);
  assert.equal(await (executor as any).transitionState(task, "EXECUTING"), true);

  const transitions = executor.getExecutionLog(task.id).filter((entry) => entry.eventType === "TASK_STATE_CHANGED");
  assert.deepEqual(transitions.map((entry) => entry.details), [
    { from: "CREATED", to: "PLANNING" },
    { from: "PLANNING", to: "EXECUTING" },
  ]);
  assert.equal(executor.getExecutionLog(task.id).filter((entry) => entry.eventType === "ACTION_STARTED").length, 0);
});
