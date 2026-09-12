export type TaskCheckpointStatus =
  | "CREATED"
  | "PLANNING"
  | "WAITING"
  | "RUNNING"
  | "VERIFYING"
  | "PAUSED"
  | "RECOVERING"
  | "FAILED"
  | "COMPLETED"
  | "CANCELLED";

export interface TaskContextCheckpoint {
  taskId: string;
  correlationId: string;
  userIntent: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  status: TaskCheckpointStatus;
  currentStep?: string;
  completedSteps: string[];
  pendingSteps: string[];
  failedSteps: string[];
  retryCount: number;
  activeTabId?: string;
  activeWindow?: string;
  currentUrl?: string;
  lastObservation?: Record<string, unknown>;
  lastResult?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resumable: boolean;
  requiresApproval: boolean;
}

export type ConversationConnectionState =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "RESTORING_CONTEXT";

export interface ConversationSessionCheckpoint {
  sessionId: string;
  conversationId: string;
  connectionState: ConversationConnectionState;
  lastUserMessageId?: string;
  lastAssistantMessageId?: string;
  activeTaskId?: string;
  browserSessionId?: string;
  browserTabId?: string;
  currentUrl?: string;
  contextSummary?: string;
  updatedAt: string;
  reconnectAttempts: number;
  nextReconnectAt?: string;
}

export interface AutomationCheckpointEvent {
  eventId: string;
  eventType:
    | "TASK_CREATED"
    | "TASK_STARTED"
    | "TASK_STEP_STARTED"
    | "TASK_STEP_COMPLETED"
    | "TASK_STEP_FAILED"
    | "TASK_PAUSED"
    | "TASK_RESUMED"
    | "TASK_CANCELLED"
    | "TASK_COMPLETED"
    | "GEMINI_CONNECTED"
    | "GEMINI_DISCONNECTED"
    | "GEMINI_RECONNECTED";
  taskId?: string;
  sessionId?: string;
  correlationId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
