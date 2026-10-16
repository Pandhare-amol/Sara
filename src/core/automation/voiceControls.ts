import { publicAutomationTask, type AutomationOrchestrator } from "./automationOrchestrator";

/** Short, explicit turn-level speech stops. Never interpreted as task cancellation. */
export function isSpeechStopCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^(?:sara[, ]+)?(?:please\s+)?(?:stop (?:speaking|talking|your speech)|be quiet|quiet please|shush)(?:\s+(?:now|sara))?[.!?\s]*$/i.test(value.trim());
}

export function isTaskCancelCommand(text: string): boolean {
  return !isSpeechStopCommand(text) && (/\b(?:cancel|abort|stop)\b.{0,36}\b(?:task|automation|operation|background work)\b/i.test(text) ||
    /\b(?:task|automation|operation)\b.{0,24}\b(?:cancel|abort|stop)\b/i.test(text));
}

/** Only a direct user utterance may stop this conversation's unambiguous task. */
export function liveAutomationTaskCancel(
  orchestrator: AutomationOrchestrator, taskId: string, conversationId: string, latestUserText: string,
) {
  const task = taskId ? orchestrator.getTask(taskId) : undefined;
  if (!task || task.conversationId !== conversationId) return { ok: false, error: "Task not found for this conversation." };
  if (!isTaskCancelCommand(latestUserText)) {
    return { ok: false, error: "Stopping speech is not cancelling a task. Ask explicitly to cancel the selected task." };
  }
  const active = orchestrator.listTasks().filter((entry) => entry.conversationId === conversationId &&
    ["QUEUED", "STARTING", "RUNNING", "RETRYING", "VERIFYING", "CANCELLING"].includes(entry.status));
  if (!latestUserText.toUpperCase().includes(taskId.toUpperCase()) &&
      !(active.length === 1 && active[0].task_id === taskId)) {
    return { ok: false, error: "More than one task may be active; name the exact task ID before cancelling." };
  }
  const accepted = orchestrator.cancelTask(taskId);
  const updated = orchestrator.getTask(taskId)!;
  if (!accepted) return { ok: false, error: "Task already settled or its external effect needs review.", task: publicAutomationTask(updated) };
  return { ok: true, task: publicAutomationTask(updated),
    message: updated.status === "CANCELLING"
      ? "Stop requested. The in-flight action may still finish; check this task for its verified outcome."
      : "Queued task cancelled before execution. This did not stop SARA's speech." };
}
