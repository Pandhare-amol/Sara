import test from "node:test";
import assert from "node:assert/strict";
import { formatAdvancedReasoningContext, needsAdvancedReasoning } from "../src/asi/AdvancedReasoningCoordinator";

test("advanced reasoning is reserved for complex requests", () => {
  assert.equal(needsAdvancedReasoning("What time is it?"), false);
  assert.equal(needsAdvancedReasoning("Compare the security and business trade-offs of these two deployment architectures, including risks, assumptions, and a long-term recommendation."), true);
});

test("advanced reasoning context remains bounded and advisory", () => {
  const context = formatAdvancedReasoningContext({
    answer: "Use staged rollout.",
    confidence: 0.73,
    novelInsights: ["Rollback speed matters."],
    crossDomainLinks: [],
    proposedNextSteps: ["Run a canary test."],
    reasoningTrace: [],
    processingTimeMs: 20,
    assumptions: ["Traffic is measurable."],
    risks: ["Migration delay."],
    evidenceGaps: ["No production sample."],
  });

  assert.match(context, /advisory assessment|advisory analysis/i);
  assert.match(context, /Confidence: 0.73/);
  assert.match(context, /No production sample/);
  assert.ok(context.length < 3000);
});
