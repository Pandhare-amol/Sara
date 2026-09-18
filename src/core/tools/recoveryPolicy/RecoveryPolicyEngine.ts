// src/core/tools/recoveryPolicy/RecoveryPolicyEngine.ts

/**
 * Minimal recovery policy engine used by ExecutionOrchestrator.
 * It decides whether to retry a tool call, fall back to an alternative tool,
 * or abort based on the error information and provided execution context.
 */

export type RecoveryAction = "RETRY" | "FALLBACK_TOOL" | "ABORT";

export interface RecoveryPlan {
  action: RecoveryAction;
  fallbackTools?: string[]; // Used when action === "FALLBACK_TOOL"
  reason?: string;
}

export interface RecoveryContext {
  tool: string;
  confirmed: boolean;
  sandboxed: boolean;
  source: "user" | "model" | "recovery";
  riskLevel?: string;
}

export class RecoveryPolicyEngine {
  /**
   * Select a recovery plan based on the tool, the error that occurred,
   * and the execution context.
   *
   * For now this is a simple heuristic:
   *   - If the error is marked retryable, return a RETRY plan.
   *   - If the tool is known and has a configured fallback list, return a FALLBACK_TOOL plan.
   *   - Otherwise, abort.
   */
  public selectRecoveryPlan(
    tool: string,
    error: { retryable?: boolean; code?: string; message?: string } | undefined,
    context: RecoveryContext,
  ): RecoveryPlan | null {
    if (!error) {
      return null;
    }

    // Retryable errors – allow a retry.
    if (error.retryable) {
      return { action: "RETRY", reason: error.message ?? "Retryable error" };
    }

    // Example: provide a static fallback list for certain tools.
    const staticFallbacks: Record<string, string[]> = {
      // toolName: [fallbackTool1, fallbackTool2]
      // Add entries as needed.
    };

    const fallbacks = staticFallbacks[tool];
    if (fallbacks && fallbacks.length > 0) {
      return { action: "FALLBACK_TOOL", fallbackTools: fallbacks, reason: "Using configured fallback tools" };
    }

    // Default abort.
    return { action: "ABORT", reason: error.message ?? "Unrecoverable error" };
  }
}
