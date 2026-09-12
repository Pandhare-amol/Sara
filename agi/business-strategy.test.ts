import test from "node:test";
import assert from "node:assert/strict";
import { BusinessAssessmentService, KpiTracker } from "./index";

test("business assessment separates evidence gaps from verified strengths", () => {
  const assessment = new BusinessAssessmentService().assess({
    name: "Acme",
    offering: "Workflow software",
    customers: "Small agencies",
    goals: ["Reach 100 paying customers"],
    constraints: ["Limited sales capacity"],
    evidence: [{ statement: "Strong customer retention", source: "cohort report", confidence: 0.9, verified: true }],
  });
  assert.deepEqual(assessment.swot.strengths, ["Strong customer retention"]);
  assert.deepEqual(assessment.swot.weaknesses, ["Limited sales capacity"]);
  assert.equal(assessment.marketPosition.confidence, 0.55);
});

test("KPI tracker reports status and actionable recommendations", () => {
  const tracker = new KpiTracker([{ id: "activation", name: "Activation", unit: "%", target: 80, direction: "higher_is_better" }]);
  tracker.record({ kpiId: "activation", value: 40, observedAt: new Date().toISOString(), source: "analytics" });
  assert.equal(tracker.status("activation"), "off_track");
  assert.match(tracker.recommendations()[0], /Investigate Activation/);
});