/**
 * AuthoritativeTaskResult — The single canonical result format used throughout SARA.
 *
 * This is the ONE source of truth for task execution outcomes.
 * Every layer (backend, UI, voice, desktop agent, planner) must consume this result.
 * No layer may independently infer success without this result.
 */

export type ExecutionState = 
  | "PLANNING"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export interface ExecutionAction {
  tool: string;
  arguments?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  success: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
  };
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  evidence?: unknown;
  reason?: string;
}

export interface VerificationResult {
  attempted: boolean;
  passed: boolean;
  method?: string;
  checks: VerificationCheck[];
  details?: string;
}

export interface ExecutionError {
  code?: string;
  message: string;
  recoverable?: boolean;
  details?: string;
}

/**
 * The canonical task result object.
 * 
 * Success is determined by:
 * 1. outcome.ok = true (tool/agent reported success)
 * 2. verification.passed = true (verification confirmed the outcome)
 * 3. state = "SUCCEEDED" (final state reflects both conditions)
 * 
 * Tool invocation alone does NOT produce success.
 * Verification alone does NOT produce success.
 * Both must be true.
 */
export interface AuthoritativeTaskResult {
  // Identity
  taskId: string;
  executionId?: string;
  conversationId?: string;

  // State
  state: ExecutionState;
  success: boolean;
  verified: boolean;

  // Goals
  goal: string;
  summary: string;
  userMessage?: string;

  // Execution trace
  actions: ExecutionAction[];
  verification: VerificationResult;

  // Error information
  error?: ExecutionError;

  // Timestamps
  startedAt: string;
  completedAt?: string;
  durationMs?: number;

  // Optional post-success cleanup outcome; this never changes the verified
  // success state of the primary task.
  autoClose?: {
    ok: boolean;
    verified: boolean;
    status?: string;
    closed?: Array<Record<string, unknown>>;
    left_open?: Array<Record<string, unknown>>;
    result?: string;
  };

  // Optional metadata
  metadata?: Record<string, unknown>;
}

/**
 * Convert a task result to a user-facing response message.
 * The UI and voice layer must use this function to generate their response.
 * They must NOT generate success/failure language independently.
 */
export function isVerifiedTaskSuccess(result: Pick<AuthoritativeTaskResult, "state" | "success" | "verified" | "verification">): boolean {
  return result.state === "SUCCEEDED" && result.success === true && result.verified === true &&
    result.verification?.attempted === true && result.verification?.passed === true;
}

export function createUserResponseFromResult(result: AuthoritativeTaskResult): string {
  switch (result.state) {
    case "SUCCEEDED":
      return isVerifiedTaskSuccess(result)
        ? result.summary || `Task completed successfully.`
        : `The action returned a success state, but I couldn't independently verify the outcome. Please check it before retrying.`;

    case "PARTIAL":
      return `The task was only partially completed. Some effects may have occurred; review them before retrying. ${result.summary || "Some objectives were not fully achieved."}`;

    case "FAILED":
      if (result.verification?.attempted && !result.verification.passed) {
        return `I couldn't verify completion. Some effects may already have occurred; review them before retrying. ${result.error?.message ?? result.summary ?? "The requested operation needs review."}`;
      }
      return `I couldn't complete the task. ${result.error?.message ?? result.summary ?? "The requested operation failed."}`;

    case "CANCELLED":
      return `The task was cancelled. Check for partial effects before retrying. ${result.summary || ""}`.trim();

    case "RUNNING":
    case "VERIFYING":
    case "PLANNING":
      return "The task is still in progress.";

    default:
      return "The task is processing.";
  }
}

export function buildAuthoritativeResultMessage(result: AuthoritativeTaskResult): string {
  return createUserResponseFromResult(result);
}

/**
 * Determine if a result represents a terminal state.
 * Terminal states cannot be overwritten by stale updates.
 */
export function isTerminalState(state: ExecutionState): boolean {
  return ["SUCCEEDED", "FAILED", "PARTIAL", "CANCELLED"].includes(state);
}
