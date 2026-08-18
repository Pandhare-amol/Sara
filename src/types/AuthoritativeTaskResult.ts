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

  // Optional metadata
  metadata?: Record<string, unknown>;
}

/**
 * Convert a task result to a user-facing response message.
 * The UI and voice layer must use this function to generate their response.
 * They must NOT generate success/failure language independently.
 */
export function createUserResponseFromResult(result: AuthoritativeTaskResult): string {
  switch (result.state) {
    case "SUCCEEDED":
      return result.summary || `Task completed successfully.`;

    case "PARTIAL":
      return `The task was partially completed. ${result.summary || "Some objectives were not fully achieved."}`;

    case "FAILED":
      return `I couldn't complete the task. ${
        result.error?.message ?? result.summary ?? "The requested operation failed."
      }`;

    case "CANCELLED":
      return "The task was cancelled.";

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
