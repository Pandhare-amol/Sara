/**
 * Unified tool execution result.
 *
 * This is the single source of truth for every tool call.
 * Contains execution status, verification status, and final success determination.
 */

export type ExecutionStatus = "success" | "failed" | "timeout" | "unknown";
export type VerificationStatus = "verified" | "failed" | "uncertain" | "not_required" | "skipped";
export type FinalStatus = "success" | "failed" | "partial" | "uncertain" | "timeout";

export interface ExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface UnifiedToolExecutionResult {
  // Identity and correlation
  tool: string;
  toolCallId: string;
  correlationId: string;

  // Execution phase
  executionStatus: ExecutionStatus;
  executionDurationMs: number;
  executionStartedAt: string;
  executionCompletedAt: string;
  executionError?: ExecutionError;
  executionResult?: unknown;

  // Verification phase
  verificationStatus: VerificationStatus;
  verificationDurationMs: number;
  verificationStartedAt?: string;
  verificationCompletedAt?: string;
  verificationMethod?: string;
  verificationChecks?: Array<{
    name: string;
    passed: boolean;
    evidence?: unknown;
    reason?: string;
  }>;
  verificationObservedState?: Record<string, unknown>;
  verificationError?: ExecutionError;

  // Final result
  status: FinalStatus;
  success: boolean;
  verified: boolean;
  totalDurationMs: number;

  // Human-readable message
  message: string;

  // Metadata
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Determine final status from execution and verification statuses.
 * Success requires BOTH execution AND verification to pass.
 */
export function determineFinalStatus(
  executionStatus: ExecutionStatus,
  verificationStatus: VerificationStatus,
): FinalStatus {
  if (executionStatus === "timeout") return "timeout";
  if (executionStatus === "failed") return "failed";
  if (verificationStatus === "failed") return "failed";
  if (executionStatus === "success" && verificationStatus === "verified") return "success";
  if (executionStatus === "success" && verificationStatus === "not_required") return "success";
  if (executionStatus === "success" && verificationStatus === "skipped") return "partial";
  if (executionStatus === "success" && verificationStatus === "uncertain") return "uncertain";
  return "uncertain";
}

/**
 * Build a human-readable message for the result.
 * Never claim success if verification failed.
 */
export function buildResultMessage(result: UnifiedToolExecutionResult): string {
  if (result.success) {
    return result.message || `Successfully completed: ${result.tool}`;
  }

  if (result.executionStatus === "failed") {
    return result.executionError?.message || `Failed to execute ${result.tool}`;
  }

  if (result.verificationStatus === "failed") {
    return (
      result.verificationError?.message ||
      `I performed the action, but I couldn't verify that it completed.`
    );
  }

  if (result.executionStatus === "timeout") {
    return `The action timed out. Please try again.`;
  }

  return result.message || `The action status is uncertain. Please verify manually.`;
}
