/**
 * Shared tool contract for incremental SARA adapters.
 *
 * Existing tools may continue returning their legacy payloads. Adapters should
 * normalize them into this shape before task-level result construction.
 */
export type ToolExecutionStatus = "SUCCESS" | "FAILED" | "TIMEOUT" | "SKIPPED";
export type ToolVerificationStatus =
  | "VERIFIED"
  | "FAILED"
  | "UNCERTAIN"
  | "NOT_REQUIRED"
  | "SKIPPED";
export type ToolFinalStatus = "SUCCESS" | "FAILED" | "UNCERTAIN";

export interface ToolErrorDetails {
  code?: string;
  message: string;
  retryable?: boolean;
  exceptionType?: string;
}

export interface ToolVerification {
  status: ToolVerificationStatus;
  method?: string;
  checks?: Array<{
    name: string;
    passed: boolean;
    evidence?: unknown;
    reason?: string;
  }>;
  details?: unknown;
}

export interface CanonicalToolResult<T = unknown> {
  ok: boolean;
  status: ToolFinalStatus;
  execution_status: ToolExecutionStatus;
  verification_status: ToolVerificationStatus;
  tool: string;
  request_id?: string;
  operation_id: string;
  message: string;
  details: Record<string, unknown>;
  executed: boolean;
  verified: boolean;
  changed_state?: boolean | null;
  duration_ms?: number | null;
  timestamp: number;
  error?: ToolErrorDetails | null;
  error_code?: string | null;
  retryable: boolean;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  source?: string;
  task_id?: string;
  correlation_id?: string;
  policy_decision?: "ALLOW" | "ASK_USER" | "DENY" | "UNKNOWN";
  data?: T;
  verification: ToolVerification;
}

export function finalStatusForToolResult(
  executionStatus: ToolExecutionStatus,
  verificationStatus: ToolVerificationStatus,
): ToolFinalStatus {
  if (executionStatus === "FAILED" || verificationStatus === "FAILED") {
    return "FAILED";
  }
  if (executionStatus === "TIMEOUT") {
    return "UNCERTAIN";
  }
  if (
    executionStatus === "SUCCESS" &&
    (verificationStatus === "VERIFIED" || verificationStatus === "NOT_REQUIRED")
  ) {
    return "SUCCESS";
  }
  return "UNCERTAIN";
}

export function isSuccessfulToolResult(result: Pick<CanonicalToolResult, "status">): boolean {
  return result.status === "SUCCESS";
}
