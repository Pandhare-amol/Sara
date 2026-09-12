export type AutomationTaskState =
  | "PLANNING"
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "WAITING_FOR_USER"
  | "RECOVERING"
  | "RETRYING"
  | "VERIFYING"
  | "COMPLETED"
  | "PARTIALLY_COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface TaskExecutionStep {
  id: string;
  name: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt?: string;
  completedAt?: string;
  tool?: string;
  result?: Record<string, unknown>;
}

export interface PersistedTaskContext {
  task_id: string;
  conversation_id: string;
  user_id?: string;
  identity_id?: string;
  goal: string;
  original_command: string;
  current_step?: string;
  steps: TaskExecutionStep[];
  current_application?: string;
  current_url?: string;
  active_tab?: string;
  active_window?: string;
  tool_calls: string[];
  completed_actions: string[];
  failed_actions: string[];
  verification_results: Record<string, unknown>[];
  task_state: AutomationTaskState;
  retry_count: number;
  last_error?: string;
  last_successful_state?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function createTaskContext(input: {
  task_id: string;
  conversation_id: string;
  user_id?: string;
  identity_id?: string;
  goal: string;
  original_command: string;
  current_step?: string;
  steps?: TaskExecutionStep[];
  current_application?: string;
  current_url?: string;
  active_tab?: string;
  active_window?: string;
  task_state?: AutomationTaskState;
}): PersistedTaskContext {
  const now = new Date().toISOString();
  return {
    task_id: input.task_id,
    conversation_id: input.conversation_id,
    user_id: input.user_id,
    identity_id: input.identity_id,
    goal: input.goal,
    original_command: input.original_command,
    current_step: input.current_step || "queued",
    steps: input.steps || [],
    current_application: input.current_application,
    current_url: input.current_url,
    active_tab: input.active_tab,
    active_window: input.active_window,
    tool_calls: [],
    completed_actions: [],
    failed_actions: [],
    verification_results: [],
    task_state: input.task_state || "PLANNING",
    retry_count: 0,
    created_at: now,
    updated_at: now,
  };
}

export function resumeFromTaskContext(
  task: PersistedTaskContext,
  nextStep?: string,
): PersistedTaskContext {
  const resumed: PersistedTaskContext = {
    ...task,
    current_step: nextStep || task.current_step || "resume",
    task_state: "RUNNING",
    updated_at: new Date().toISOString(),
  };
  return resumed;
}
