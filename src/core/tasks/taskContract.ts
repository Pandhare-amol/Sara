export enum TaskExecutionStatus {
  CREATED = "CREATED",
  QUEUED = "QUEUED",
  RUNNING = "RUNNING",
  WAITING_CONFIRMATION = "WAITING_CONFIRMATION",
  EXECUTED = "EXECUTED",
  VERIFYING = "VERIFYING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  RECOVERING = "RECOVERING",
  BLOCKED = "BLOCKED",
  WAITING_FOR_PROVIDER = "WAITING_FOR_PROVIDER",
  WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL",
  PAUSED = "PAUSED",
  RECOVERABLE = "RECOVERABLE",
}

export enum TaskPriority {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  NORMAL = "NORMAL",
  LOW = "LOW",
  BACKGROUND = "BACKGROUND",
}

export enum TaskVerificationStatus {
  VERIFIED = "VERIFIED",
  FAILED = "FAILED",
  UNCERTAIN = "UNCERTAIN",
  NOT_REQUIRED = "NOT_REQUIRED",
  SKIPPED = "SKIPPED",
}

export interface TaskExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface TaskExecution {
  taskId: string;
  correlationId: string;
  conversationId: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: TaskExecutionStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutAt?: string;
  attempt: number;
  maxAttempts: number;
  priority: TaskPriority;
  source: string;
  verificationStatus: TaskVerificationStatus;
  verificationResult?: Record<string, unknown>;
  error?: TaskExecutionError;
  recoveryState?: "NONE" | "PENDING" | "ACTIVE" | "RESOLVED";
  parentTaskId?: string;
  childTaskIds: string[];
  userVisibleStatus: string;
}

export type TaskExecutionUpdate = Partial<Omit<TaskExecution, "taskId" | "correlationId" | "createdAt">>;

export const TASK_TERMINAL_STATUSES = new Set<TaskExecutionStatus>([
  TaskExecutionStatus.COMPLETED,
  TaskExecutionStatus.FAILED,
  TaskExecutionStatus.TIMEOUT,
  TaskExecutionStatus.CANCELLED,
  TaskExecutionStatus.BLOCKED,
]);

export function isTerminalTaskStatus(status: TaskExecutionStatus): boolean {
  return TASK_TERMINAL_STATUSES.has(status);
}

export function buildUserVisibleTaskStatus(status: TaskExecutionStatus): string {
  switch (status) {
    case TaskExecutionStatus.CREATED:
      return "Created";
    case TaskExecutionStatus.QUEUED:
      return "Queued";
    case TaskExecutionStatus.RUNNING:
      return "Running";
    case TaskExecutionStatus.WAITING_CONFIRMATION:
      return "Waiting for confirmation";
    case TaskExecutionStatus.EXECUTED:
      return "Executed";
    case TaskExecutionStatus.VERIFYING:
      return "Verifying";
    case TaskExecutionStatus.COMPLETED:
      return "Completed";
    case TaskExecutionStatus.FAILED:
      return "Failed";
    case TaskExecutionStatus.TIMEOUT:
      return "Timed out";
    case TaskExecutionStatus.CANCELLED:
      return "Cancelled";
    case TaskExecutionStatus.RECOVERING:
      return "Recovering";
    case TaskExecutionStatus.BLOCKED:
      return "Blocked";
    case TaskExecutionStatus.WAITING_FOR_PROVIDER:
      return "Waiting for provider";
    case TaskExecutionStatus.WAITING_FOR_APPROVAL:
      return "Waiting for approval";
    case TaskExecutionStatus.PAUSED:
      return "Paused";
    case TaskExecutionStatus.RECOVERABLE:
      return "Recoverable error";
    default:
      return "Processing";
  }
}
