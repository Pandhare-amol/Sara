/** Small, deterministic safety evaluation runner. It never calls live models or tools. */
export type EvaluationCategory = "planning" | "approval" | "memory" | "verification" | "recovery";
export type EvaluationSplit = "development" | "local-holdout";

export interface EvaluationCase {
  id: string;
  split: EvaluationSplit;
  category: EvaluationCategory;
  run: () => boolean | Promise<boolean>;
}
export interface EvaluationRecord {
  id: string;
  split: EvaluationSplit;
  category: EvaluationCategory;
  passed: boolean;
  durationMs: number;
  error?: string;
}
export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  subject: "deterministic-policy-fixtures";
  model: "none";
  observations: EvaluationRecord[];
  summary: {
    total: number;
    passed: number;
    passRate: number;
    passRateWilson95: [number, number];
    p95LatencyMs: number;
    byCategory: Record<EvaluationCategory, { passed: number; total: number }>;
    bySplit: Record<EvaluationSplit, { passed: number; total: number }>;
  };
  unmeasured: string[];
}

/** Wilson binomial interval; reports uncertainty instead of a misleading 100% claim. */
export function wilson95(passed: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = passed / total;
  const norm = 1 + z ** 2 / total;
  const mid = (p + z ** 2 / (2 * total)) / norm;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / norm;
  return [Math.max(0, mid - margin), Math.min(1, mid + margin)];
}

export async function runAgentEvaluation(cases: EvaluationCase[]): Promise<EvaluationReport> {
  const ids = new Set<string>();
  const observations: EvaluationRecord[] = [];
  for (const test of cases) {
    if (!test.id || ids.has(test.id)) throw new Error("Evaluation case IDs must be unique and nonempty.");
    ids.add(test.id);
    const started = performance.now();
    try {
      observations.push({ id: test.id, split: test.split, category: test.category, passed: await test.run() === true,
        durationMs: Math.round((performance.now() - started) * 100) / 100 });
    } catch (error) {
      observations.push({ id: test.id, split: test.split, category: test.category, passed: false,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        error: error instanceof Error ? error.name : "Exception" });
    }
  }
  const byCategory = Object.fromEntries(["planning", "approval", "memory", "verification", "recovery"].map((category) => [category, {
    passed: observations.filter((item) => item.category === category && item.passed).length,
    total: observations.filter((item) => item.category === category).length,
  }])) as EvaluationReport["summary"]["byCategory"];
  const bySplit = Object.fromEntries(["development", "local-holdout"].map((split) => [split, {
    passed: observations.filter((item) => item.split === split && item.passed).length,
    total: observations.filter((item) => item.split === split).length,
  }])) as EvaluationReport["summary"]["bySplit"];
  const latencies = observations.map((item) => item.durationMs).sort((a, b) => a - b);
  const passed = observations.filter((item) => item.passed).length;
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), subject: "deterministic-policy-fixtures", model: "none", observations,
    summary: { total: observations.length, passed, passRate: observations.length ? passed / observations.length : 0,
      passRateWilson95: wilson95(passed, observations.length), p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] || 0,
      byCategory, bySplit },
    unmeasured: ["Live model task success", "Real browser/desktop effects", "Factual accuracy", "True unseen-task generalization", "Model cost or token quality", "Windows UI Automation"],
  };
}
