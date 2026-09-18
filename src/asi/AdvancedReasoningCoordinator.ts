import { CognitiveSuperiorityEngine } from "./CognitiveSuperiorityEngine";
import type { ASIResponse } from "./types";
import { MemoryService } from "../services/MemoryService";
import { getGeminiApiKey } from "../../server_paths";

let engine: CognitiveSuperiorityEngine | null = null;

function getEngine(): CognitiveSuperiorityEngine | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  engine ??= new CognitiveSuperiorityEngine(new MemoryService(), apiKey);
  return engine;
}

export function needsAdvancedReasoning(text: string): boolean {
  const value = text.trim();
  if (value.length < 120) return false;
  return /\b(why|should|strategy|trade[- ]?off|compare|architecture|design|business|research|plan|risk|investment|security|debug|analy[sz]e|multiple|long[- ]term|decision)\b/i.test(value)
    || /\b(and|but|because|if|then)\b/i.test(value);
}

export async function runAdvancedReasoningIfNeeded(text: string, timeoutMs = 4500): Promise<ASIResponse | null> {
  if (!needsAdvancedReasoning(text)) return null;
  const cognitiveEngine = getEngine();
  if (!cognitiveEngine) return null;
  const work = cognitiveEngine.processQuery({
    question: text.slice(0, 4000),
    domains: ["technology", "business", "decision-making"],
    depthLevel: 3,
    allowWebSearch: false,
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatAdvancedReasoningContext(result: ASIResponse | null): string {
  if (!result) return "";
  return `\n\n=== BOUNDED ADVANCED REASONING ===\nUse this as advisory analysis only. Do not claim certainty or superintelligence, and do not execute actions from it without the normal planner, Critic, safety, and user-confirmation gates.\nAssessment: ${result.answer}\nConfidence: ${result.confidence.toFixed(2)}\nInsights: ${(result.novelInsights || []).slice(0, 4).join("; ") || "none"}\nAssumptions: ${(result.assumptions || []).slice(0, 4).join("; ") || "none listed"}\nRisks: ${(result.risks || []).slice(0, 4).join("; ") || "none listed"}\nEvidence gaps: ${(result.evidenceGaps || []).slice(0, 4).join("; ") || "none listed"}\nNext steps: ${(result.proposedNextSteps || []).slice(0, 4).join("; ") || "none listed"}\n=== END BOUNDED ADVANCED REASONING ===\n`;
}
