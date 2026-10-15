const INTERRUPTED_STATUSES = new Set(["running", "planning", "recovering", "retrying"]);

export interface RecoverableTask {
  taskId: string;
  status: string;
  checkpoint?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface InterruptedTaskPatch {
  status: "paused";
  updatedAt: string;
  error: string;
  checkpoint: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Convert an in-flight task left by a previous process into a reviewable pause.
 * Never automatically replays work: the prior process may have completed an
 * external side effect before it stopped persisting progress.
 */
export function buildInterruptedTaskPatch(
  task: RecoverableTask,
  interruptedAt = new Date().toISOString(),
): InterruptedTaskPatch | null {
  const previousStatus = String(task.status || "").toLowerCase();
  if (!INTERRUPTED_STATUSES.has(previousStatus)) return null;

  const recovery = {
    state: "paused_after_restart",
    interruptedStatus: task.status,
    interruptedAt,
    checkpointPreserved: true,
    automaticReplay: false,
  };

  return {
    status: "paused",
    updatedAt: interruptedAt,
    error: "SARA stopped while this task was in progress. Its checkpoint was preserved; the task was not replayed because an external side effect may already have occurred. Review it before explicitly retrying.",
    checkpoint: {
      ...(task.checkpoint && typeof task.checkpoint === "object" ? task.checkpoint : {}),
      recovery,
    },
    metadata: {
      ...(task.metadata || {}),
      lastInterruption: recovery,
    },
  };
}
