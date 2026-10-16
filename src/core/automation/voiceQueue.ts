import { isDeepStrictEqual } from "node:util";
import { AutomationOrchestrator, AutomationQueueFullError, type AutomationTaskInput } from "./automationOrchestrator";

const ACTIVE = new Set(["QUEUED", "STARTING", "RUNNING", "VERIFYING", "CANCELLING", "RETRYING"]);
const MAX_ACTIVE_PER_SESSION = 4;

/** One bounded voice queue; retries of a tool-call id observe the same task. */
export function queueVoiceAutomation(orchestrator: AutomationOrchestrator, input: AutomationTaskInput) {
  const tasks = orchestrator.listTasks();
  const operationId = input.args.operation_id;
  if (typeof operationId === "string" && input.sessionId) {
    const existing = tasks.find((task) => task.sessionId === input.sessionId && task.conversationId === input.conversationId &&
      task.tool === input.tool && task.args.operation_id === operationId);
    if (existing) {
      if (!isDeepStrictEqual(existing.args, input.args)) return {
        ok: false, status: "CONFLICT", verified: false,
        error: "The operation ID was previously used with different arguments; nothing new was queued.",
      };
      return {
        ok: true, status: existing.status, task_id: existing.task_id, operation_id: operationId,
        verified: existing.status === "COMPLETED", result: "This tool call was already accepted; no second execution was scheduled.",
      };
    }
  }
  if (tasks.filter((task) => task.sessionId === input.sessionId && ACTIVE.has(task.status)).length >= MAX_ACTIVE_PER_SESSION) {
    return { ok: false, status: "BUSY", verified: false,
      error: "Four tasks are already active in this voice session. Wait or inspect status before submitting another." };
  }
  try {
    const task = orchestrator.submit(input);
    return { ok: true, status: "QUEUED", task_id: task.task_id, operation_id: operationId, verified: false,
      result: "Accepted for background execution. This is not a completion result. You can keep talking; check the task status to learn the observed outcome." };
  } catch (error) {
    if (!(error instanceof AutomationQueueFullError)) throw error;
    return { ok: false, status: "BUSY", verified: false, error: error.message };
  }
}
