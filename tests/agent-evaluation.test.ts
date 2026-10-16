import test from "node:test";
import assert from "node:assert/strict";
import { runAgentEvaluation, wilson95 } from "../src/core/evaluation/agentEvaluation";

test("evaluation reports real passes/failures, local split, latency, uncertainty and unmeasured capabilities", async () => {
  const report = await runAgentEvaluation([
    { id: "ok", split: "development", category: "planning", run: () => true },
    { id: "mismatch", split: "local-holdout", category: "approval", run: () => false },
    { id: "throws", split: "local-holdout", category: "verification", run: () => { throw new Error("secret details not to log"); } },
  ]);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.bySplit["local-holdout"].passed, 0);
  assert.equal(report.summary.byCategory.approval.total, 1);
  assert.ok(report.summary.passRateWilson95[0] < report.summary.passRate);
  assert.ok(report.summary.passRateWilson95[1] > report.summary.passRate);
  assert.ok(report.summary.p95LatencyMs >= 0);
  assert.equal(report.model, "none");
  assert.equal(report.observations[2].error, "Error");
  assert.equal(JSON.stringify(report).includes("secret details"), false);
  assert.ok(report.unmeasured.some((item) => item.includes("Real browser")));
});

test("Wilson interval is wide even when a tiny fixture set passes", () => {
  const [low, high] = wilson95(12, 12);
  assert.ok(low < 0.8);
  assert.equal(high, 1);
  assert.deepEqual(wilson95(0, 0), [0, 1]);
});
