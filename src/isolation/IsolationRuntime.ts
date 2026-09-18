// src/isolation/IsolationRuntime.ts

/**
 * Simple isolation runtime that reviews tool execution requests against a basic policy.
 * It is used by ExecutionOrchestrator to decide whether a tool call should be allowed,
 * require user confirmation, or be denied.
 *
 * The implementation here is intentionally lightweight – it inspects the tool name
 * and the supplied context (e.g., risk level, sandbox flag) and returns a decision.
 * In a production system this could be replaced by a sophisticated policy engine.
 */

export interface IsolationReviewContext {
  confirmed: boolean;
  sandboxed: boolean;
  source: "user" | "model" | "recovery";
  maxSteps?: number;
}

export interface IsolationReviewResult {
  decision: "ALLOW" | "DENY" | "ASK_USER";
  reasons: string[];
}

export interface ToolReviewRequest {
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
  requiresVerification: boolean;
}

export class IsolationRuntime {
  constructor(private toolRouter: any) {}

  /**
   * Review one or more tool requests and return a collective decision.
   * For simplicity we evaluate each request independently and if any request is
   * denied we deny the whole batch. If any request requires user confirmation we
   * ask the user. Otherwise we allow.
   */
  review(requests: ToolReviewRequest[], context: IsolationReviewContext): IsolationReviewResult {
    const reasons: string[] = [];
    let finalDecision: IsolationReviewResult["decision"] = "ALLOW";

    for (const req of requests) {
      // Example policy: high‑risk tools require sandbox or confirmation.
      const metadata = this.toolRouter?.registry?.getMetadata?.(req.tool) ?? {};
      const risk = (metadata?.riskLevel as string) ?? "READ_ONLY";

      if (risk === "HIGH" && !context.sandboxed) {
        finalDecision = "ASK_USER";
        reasons.push(`Tool ${req.tool} is HIGH risk and not sandboxed`);
      }

      // Disallow tools explicitly marked as disabled.
      if (metadata?.disabled) {
        finalDecision = "DENY";
        reasons.push(`Tool ${req.tool} is disabled`);
      }
    }

    return { decision: finalDecision, reasons };
  }
}
