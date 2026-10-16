import { wilson95, type EvaluationReport, type EvaluationRecord } from "./agentEvaluation";

export interface ReviewGate {
  status: "rejected" | "human_review_required";
  reasons: string[];
  regressionIds: string[];
  baselinePassed: number;
  candidatePassed: number;
  comparedAt: string;
  /** Never indicates permission to deploy or change tool policy. */
  deploymentAuthorized: false;
}

const CATEGORIES = ["planning", "approval", "memory", "verification", "recovery"] as const;
const SPLITS = ["development", "local-holdout"] as const;

/** Reports are files, not attestation. Check internal consistency before comparison. */
function validateReport(input: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return [`${label} report is not an object.`];
  const report = input as Partial<EvaluationReport>;
  if (report.schemaVersion !== 1 || report.subject !== "deterministic-policy-fixtures" || report.model !== "none") {
    errors.push(`${label} is not a comparable local fixture report.`);
  }
  if (!Array.isArray(report.observations) || report.observations.length === 0 || report.observations.length > 10_000) {
    return [...errors, `${label} needs a bounded, nonempty observations list.`];
  }
  const ids = new Set<string>();
  let actualPassed = 0;
  for (const item of report.observations) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id) ||
        !SPLITS.includes(item.split) || !CATEGORIES.includes(item.category) || typeof item.passed !== "boolean" ||
        !Number.isFinite(item.durationMs) || item.durationMs < 0) {
      errors.push(`${label} contains an invalid or duplicate observation.`);
      break;
    }
    ids.add(item.id);
    if (item.passed) actualPassed++;
  }
  if (errors.length) return errors;
  const summary = report.summary;
  const interval = wilson95(actualPassed, report.observations.length);
  const latencies = report.observations.map((item) => item.durationMs).sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  if (!summary || summary.total !== report.observations.length || summary.passed !== actualPassed ||
      !Number.isFinite(summary.passRate) || Math.abs(summary.passRate - actualPassed / report.observations.length) > 1e-6 ||
      !Array.isArray(summary.passRateWilson95) || summary.passRateWilson95.length !== 2 ||
      summary.passRateWilson95.some((value) => !Number.isFinite(value)) || interval.some((value, index) => Math.abs(value - summary.passRateWilson95[index]) > 1e-6) ||
      !Number.isFinite(summary.p95LatencyMs) || summary.p95LatencyMs !== p95) {
    errors.push(`${label} counts or rates do not match its observations.`);
  }
  for (const [kind, values] of [["split", SPLITS], ["category", CATEGORIES]] as const) {
    const counts = (kind === "split" ? summary?.bySplit : summary?.byCategory) as Record<string, { total: number; passed: number }> | undefined;
    for (const key of values) {
      const expected = report.observations.filter((item) => item[kind] === key);
      const actual = counts?.[key];
      if (!actual || actual.total !== expected.length || actual.passed !== expected.filter((item) => item.passed).length) {
        errors.push(`${label} ${kind} totals do not match observations.`);
        break;
      }
    }
  }
  return errors;
}

/**
 * Compares local fixture reports only. No pass authorizes a merge, deployment,
 * permission change, or claim of real-model success or generalization.
 */
export function reviewCandidateEvaluation(baseline: EvaluationReport, candidate: EvaluationReport): ReviewGate {
  const reasons = [...validateReport(baseline, "Baseline"), ...validateReport(candidate, "Candidate")];
  if (reasons.length) return { status: "rejected", reasons, regressionIds: [],
    baselinePassed: baseline?.summary?.passed ?? 0, candidatePassed: candidate?.summary?.passed ?? 0,
    comparedAt: new Date().toISOString(), deploymentAuthorized: false };
  const oldCases = new Map<string, EvaluationRecord>();
  const newCases = new Map<string, EvaluationRecord>();
  for (const record of Array.isArray(baseline?.observations) ? baseline.observations : []) oldCases.set(record.id, record);
  for (const record of Array.isArray(candidate?.observations) ? candidate.observations : []) newCases.set(record.id, record);
  const regressionIds: string[] = [];
  for (const [id, old] of oldCases) {
    const next = newCases.get(id);
    if (!next || old.category !== next.category || old.split !== next.split) {
      reasons.push(`Evaluation case missing or reclassified: ${id}`);
    } else if (old.passed && !next.passed) regressionIds.push(id);
  }
  if (newCases.size !== oldCases.size) reasons.push("Evaluation fixture set changed; review it before comparing scores.");
  if (regressionIds.length) reasons.push(`${regressionIds.length} previously passing fixture(s) regressed.`);
  if (candidate.summary.passed < baseline.summary.passed) reasons.push("Overall deterministic fixture pass count decreased.");
  if (candidate?.summary?.passed !== candidate?.summary?.total) reasons.push("Candidate has failing fixtures.");
  return {
    status: reasons.length ? "rejected" : "human_review_required", reasons,
    regressionIds, baselinePassed: baseline?.summary?.passed ?? 0, candidatePassed: candidate?.summary?.passed ?? 0,
    comparedAt: new Date().toISOString(), deploymentAuthorized: false,
  };
}
