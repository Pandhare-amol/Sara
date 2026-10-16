import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCognitiveTask,
  endCognitiveTask,
  listActiveCognitiveTaskIds,
  requestCognitiveEmergencyStop,
  requestCognitiveTaskCancellation,
  runCognitiveStepsUntilCancelled,
} from "./taskCancellation";

test("cognitive emergency stop signals all active plans and is safe to repeat", () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const firstId = `cognitive-stop-a-${suffix}`;
  const secondId = `cognitive-stop-b-${suffix}`;
  const first = beginCognitiveTask(firstId);
  const second = beginCognitiveTask(secondId);
  assert.ok(first);
  assert.ok(second);
  assert.equal(beginCognitiveTask(firstId), undefined);

  const stop = requestCognitiveEmergencyStop();
  assert.deepEqual(stop.cancellationRequestedTaskIds.sort(), [firstId, secondId].sort());
  assert.equal(first.requested, true);
  assert.equal(second.requested, true);
  assert.ok(first.requestedAt);
  assert.equal(requestCognitiveTaskCancellation(firstId), true);
  assert.equal(requestCognitiveTaskCancellation("missing-task"), false);

  endCognitiveTask(firstId);
  endCognitiveTask(secondId);
  assert.ok(!listActiveCognitiveTaskIds().includes(firstId));
  assert.ok(!listActiveCognitiveTaskIds().includes(secondId));
});

test("a cooperative stop prevents the next cognitive plan step from starting", async () => {
  const taskId = `cognitive-step-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = beginCognitiveTask(taskId);
  assert.ok(token);
  const executed: string[] = [];

  try {
    await runCognitiveStepsUntilCancelled(["first", "second", "third"], token, async (step) => {
      executed.push(step);
      if (step === "first") assert.equal(requestCognitiveTaskCancellation(taskId), true);
    });
    assert.deepEqual(executed, ["first"]);
  } finally {
    endCognitiveTask(taskId);
  }
});
