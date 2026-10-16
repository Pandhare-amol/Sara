export interface CognitiveCancellationToken {
  taskId: string;
  requested: boolean;
  requestedAt?: string;
}

const activeCognitiveTasks = new Map<string, CognitiveCancellationToken>();

/** Register one live cognitive workflow. A task id can only be active once. */
export function beginCognitiveTask(taskId: string): CognitiveCancellationToken | undefined {
  const normalizedId = String(taskId || "").trim();
  if (!normalizedId || activeCognitiveTasks.has(normalizedId)) return undefined;
  const token: CognitiveCancellationToken = { taskId: normalizedId, requested: false };
  activeCognitiveTasks.set(normalizedId, token);
  return token;
}

export function endCognitiveTask(taskId: string): void {
  activeCognitiveTasks.delete(String(taskId || "").trim());
}

export function requestCognitiveTaskCancellation(taskId: string): boolean {
  const token = activeCognitiveTasks.get(String(taskId || "").trim());
  if (!token) return false;
  token.requested = true;
  token.requestedAt ||= new Date().toISOString();
  return true;
}

/** Execute sequential plan steps only while no cooperative stop is requested. */
export async function runCognitiveStepsUntilCancelled<T>(
  steps: readonly T[],
  token: Pick<CognitiveCancellationToken, "requested">,
  executeStep: (step: T) => Promise<void>
): Promise<void> {
  for (const step of steps) {
    if (token.requested) break;
    await executeStep(step);
  }
}

/** Signal active plans to stop before starting another tool call. */
export function requestCognitiveEmergencyStop(): { cancellationRequestedTaskIds: string[] } {
  const cancellationRequestedTaskIds: string[] = [];
  for (const [taskId, token] of activeCognitiveTasks) {
    token.requested = true;
    token.requestedAt ||= new Date().toISOString();
    cancellationRequestedTaskIds.push(taskId);
  }
  return { cancellationRequestedTaskIds };
}

export function listActiveCognitiveTaskIds(): string[] {
  return [...activeCognitiveTasks.keys()];
}
