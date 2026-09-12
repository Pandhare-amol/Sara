import type { ReasoningResult, ReasoningStep } from "./advanced-types";

export class ReasoningService {
  solve(problem: string, steps: ReasoningStep[] = [], assumptions: string[] = []): ReasoningResult {
    const normalized = problem.trim();
    const counterfactuals = assumptions.map((assumption) => `If ${assumption} were false, verify the conclusion again.`);
    return { answer: normalized || "Insufficient problem statement.", steps: steps.length ? steps : [{ title: "Clarify", conclusion: normalized || "No conclusion", confidence: normalized ? 0.4 : 0, evidence: [] }], assumptions, counterfactuals };
  }
  compare(left: string, right: string): { similarity: number; differences: string[] } { const a = new Set(left.toLowerCase().split(/\W+/).filter(Boolean)); const b = new Set(right.toLowerCase().split(/\W+/).filter(Boolean)); const intersection = [...a].filter((word) => b.has(word)).length; return { similarity: Math.max(a.size, b.size) ? intersection / Math.max(a.size, b.size) : 1, differences: [...new Set([...a].filter((word) => !b.has(word)).concat([...b].filter((word) => !a.has(word))))] }; }
}
