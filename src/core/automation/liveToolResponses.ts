import { publicAutomationTask, type AutomationOrchestrator } from "./automationOrchestrator";

/** Do not inject a late optional policy as a synthetic user turn. */
export function canInjectSocialPlan(
  requestedTurn: number,
  currentTurn: number,
  lastCompletedTurn: number,
  responseStarted: boolean,
  connectionOpen: boolean,
): boolean {
  return connectionOpen && requestedTurn === currentTurn && requestedTurn > lastCompletedTurn && !responseStarted;
}

/** Do not hold the Live SDK's message callback open on a desktop/API request. */
export function respondToLiveTool<T>(
  run: () => Promise<T>,
  deliver: (value: T) => void,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve().then(run).then(deliver).catch((error) => {
    try { onError(error); } catch { /* the Live session may already be closed */ }
  });
}

/** Status only: no raw args, private tool output or cross-conversation results. */
export function liveAutomationTaskStatus(orchestrator: AutomationOrchestrator, id: string, conversationId: string) {
  const task = id ? orchestrator.getTask(id) : undefined;
  if (!task || task.conversationId !== conversationId) {
    return { ok: false, error: "Task not found for this conversation." };
  }
  const publicTask = publicAutomationTask(task);
  return {
    ok: true,
    task_id: task.task_id,
    status: task.status,
    verified: publicTask.verified,
    review_required: publicTask.review_required,
    stop_requested: Boolean(publicTask.stop_requested_at),
    message: publicTask.message,
  };
}
