import assert from "node:assert/strict";
import test from "node:test";
import { CognitiveIntegrationBridge } from "./integrationBridge";
import type { Plan } from "./planner";

function makePlan(): Plan {
  return {
    id: "plan-cancel-test",
    goal: "complete two steps",
    steps: [
      { id: "step-1", index: 0, goal: "first", action: "first", critical: false, verifiable: true },
      { id: "step-2", index: 1, goal: "second", action: "second", critical: false, verifiable: true },
    ],
    estimatedDuration: 1000,
    confidence: 1,
    strategy: "test",
    alternatives: [],
    reasoning: { selectedStrategy: "test", whyChosen: "test", risks: [], fallbacks: [] },
    created: Date.now(),
  };
}

test("a cancelled cognitive plan returns a review checkpoint without failure learning", async () => {
  const calls: string[] = [];
  const bridge = Object.create(CognitiveIntegrationBridge.prototype) as any;
  bridge.cognitive = {
    buildContext: async () => ({ workingMemory: {} }),
    setWorking: () => calls.push("setWorking"),
    clearWorking: () => calls.push("clearWorking"),
    recordEpisode: () => calls.push("recordEpisode"),
    recordSkillSuccess: () => calls.push("recordSkillSuccess"),
    recordSkillFailure: () => calls.push("recordSkillFailure"),
  };
  bridge.planner = { createPlan: async () => makePlan() };
  bridge.strategies = {
    selectStrategy: () => undefined,
    recordExecution: () => calls.push("recordExecution"),
  };
  bridge.evaluator = {
    evaluateExecution: async () => {
      calls.push("evaluateExecution");
      throw new Error("cancelled work must not be evaluated");
    },
  };

  const result = await bridge.executeTaskWithCognition(
    {
      taskId: "cognitive-cancel-test",
      goal: "complete two steps",
      userInput: "complete two steps",
      startTime: Date.now(),
    },
    async () => ({
      actions: [{ id: "step-1", success: true, output: "first step finished" }],
      errors: [],
      corrections: [],
      result: "Stop requested after the first step.",
      cancelled: true,
    })
  );

  assert.equal(result.cancelled, true);
  assert.equal(result.success, false);
  assert.equal(result.goalAchieved, false);
  assert.deepEqual(result.execution?.actions.map((action) => action.id), ["step-1"]);
  assert.deepEqual(result.checkpoint, {
    planId: "plan-cancel-test",
    status: "paused_for_review",
    attemptedStepIds: ["step-1"],
    pendingStepIds: ["step-2"],
    automaticReplay: false,
  });
  assert.ok(!calls.includes("recordEpisode"));
  assert.ok(!calls.includes("recordExecution"));
  assert.ok(!calls.includes("recordSkillFailure"));
  assert.ok(!calls.includes("evaluateExecution"));
  assert.equal(calls.filter((call) => call === "clearWorking").length, 1);
});
