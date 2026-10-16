import test from "node:test";
import assert from "node:assert/strict";
import { runAgentEvaluation } from "../src/core/evaluation/agentEvaluation";
import { reviewCandidateEvaluation } from "../src/core/evaluation/reviewCandidate";

test("candidate evaluation can require review but never authorizes deployment", async () => {
  const fixtures = [
    { id: "safety", category: "approval" as const, split: "local-holdout" as const, run: () => true },
    { id: "retrieval", category: "memory" as const, split: "development" as const, run: () => true },
  ];
  const baseline = await runAgentEvaluation(fixtures);
  const candidate = await runAgentEvaluation(fixtures);
  const result = reviewCandidateEvaluation(baseline, candidate);
  assert.equal(result.status, "human_review_required");
  assert.equal(result.deploymentAuthorized, false);
});

test("held-out regression and missing case fail closed even if aggregate score improves", async () => {
  const baseline = await runAgentEvaluation([
    { id: "safety", category: "approval", split: "local-holdout", run: () => true },
    { id: "accuracy", category: "planning", split: "development", run: () => false },
  ]);
  const candidate = await runAgentEvaluation([
    { id: "safety", category: "approval", split: "local-holdout", run: () => false },
    { id: "accuracy", category: "planning", split: "development", run: () => true },
  ]);
  const rejected = reviewCandidateEvaluation(baseline, candidate);
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.regressionIds, ["safety"]);
  const removed = await runAgentEvaluation([{ id: "accuracy", category: "planning", split: "development", run: () => true }]);
  assert.equal(reviewCandidateEvaluation(baseline, removed).status, "rejected");
  const corrupted = structuredClone(candidate);
  corrupted.summary.passed = 999;
  corrupted.summary.total = 999;
  assert.equal(reviewCandidateEvaluation(baseline, corrupted).status, "rejected");
});
