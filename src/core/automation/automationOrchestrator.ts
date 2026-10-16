import crypto from "crypto";
import { createTaskContext, resumeFromTaskContext, type PersistedTaskContext } from "./taskContext";

export type AutomationPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "BACKGROUND";
export type AutomationStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "WAITING"
  | "PAUSED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type AutomationEventType =
  | "TASK_CREATED"
  | "TASK_PLANNED"
  | "STEP_STARTED"
  | "STEP_COMPLETED"
  | "STEP_FAILED"
  | "VERIFICATION_STARTED"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "RECOVERY_STARTED"
  | "RECOVERY_PAUSED"
  | "RECOVERY_COMPLETED"
  | "TASK_COMPLETED"
  | "TASK_FAILED";

export interface AutomationTaskInput {
  tool: string;
  args: Record<string, unknown>;
  priority?: AutomationPriority;
  sessionId?: string;
  conversationId?: string;
  task_id?: string;
  goal?: string;
  original_command?: string;
  userId?: string;
  identityId?: string;
  currentStep?: string;
}

export interface AutomationTask {
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  priority: AutomationPriority;
  status: AutomationStatus;
  progress: number;
  created_at: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  result?: unknown;
  sessionId?: string;
  conversationId?: string;
  task_state?: string;
  goal?: string;
  original_command?: string;
  context?: PersistedTaskContext;
  checkpoint?: Record<string, unknown>;
  stop_requested?: boolean;
  stop_requested_at?: string;
}

export interface RestoredAutomationTask {
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  priority: AutomationPriority;
  status?: AutomationStatus;
  progress?: number;
  created_at?: string;
  started_at?: string;
  sessionId?: string;
  conversationId?: string;
  checkpoint?: Record<string, unknown>;
}

export type AutomationEvent = {
  type: AutomationEventType | "automation:queued" | "automation:started" | "automation:progress" | "automation:completed" | "automation:failed" | "automation:cancelled";
  task: AutomationTask;
};

type Executor = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type AfterVerifiedSuccess = (task: AutomationTask) => Promise<unknown> | unknown;
type Listener = (event: AutomationEvent) => void;

const PRIORITY_WEIGHT: Record<AutomationPriority, number> = {
  CRITICAL: 5,
  HIGH: 4,
  NORMAL: 3,
  LOW: 2,
  BACKGROUND: 1,
};

function isBrowserTool(tool: string): boolean {
  return tool.startsWith("desktopBrowser") || tool.startsWith("browser") || tool.startsWith("youtube_") ||
    tool === "searchYouTube" || tool === "openWebsite" || tool === "searchWeb";
}

function resultRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function hasExplicitPassingVerification(record: Record<string, any>): boolean {
  const verification = resultRecord(record.verification);
  const status = String(record.verificationStatus || record.verification_status || "").toLowerCase();
  const checks = Array.isArray(verification.checks)
    ? verification.checks
    : Array.isArray(record.verificationChecks)
      ? record.verificationChecks
      : [];
  const checksPass = checks.length > 0 && checks.every((check: unknown) => resultRecord(check).passed === true);
  if (!checksPass) return false;

  const authoritativeProof = record.state === "SUCCEEDED" && record.verified === true &&
    verification.attempted === true && verification.passed === true;
  const executionStatus = String(record.executionStatus || record.execution_status || "").toLowerCase();
  const finalStatus = String(record.status || "").toLowerCase();
  const unifiedProof = record.verified === true && status === "verified" &&
    executionStatus === "success" && finalStatus === "success";
  return authoritativeProof || unifiedProof;
}

function resultIsVerifiedSuccess(value: unknown): boolean {
  const record = resultRecord(value);
  const execution = resultRecord(record.executionResult);
  const executionData = resultRecord(execution.data);
  const hasVerification = [record, execution, executionData].some(hasExplicitPassingVerification);
  return (record.success === true || record.ok === true) && hasVerification;
}

function definiteNoExecution(value: unknown): boolean {
  const record = resultRecord(value);
  const execution = resultRecord(record.executionResult);
  const status = String(record.executionStatus || record.execution_status || "").toLowerCase();
  return status === "failed" && (record.executed === false || execution.executed === false);
}

function resultError(value: unknown): string {
  const record = resultRecord(value);
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return typeof record.message === "string" && record.message.trim() ? record.message : "No explicit verification evidence was returned.";
}

function newTaskId(): string {
  return `SARA-AUTO-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function canonicalizeJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "undefined") return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Automation task arguments must not contain circular data.");
    ancestors.add(value);
    const result = `[${value.map((item) => canonicalizeJson(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (ancestors.has(objectValue)) throw new Error("Automation task arguments must not contain circular data.");
    ancestors.add(objectValue);
    const entries = Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key], ancestors)}`);
    ancestors.delete(objectValue);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Automation task arguments must be JSON-compatible.");
}

function cloneTaskArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Automation task arguments must be a JSON object.");
  }
  return JSON.parse(canonicalizeJson(args)) as Record<string, unknown>;
}

function fingerprintTaskRequest(
  tool: string,
  args: Record<string, unknown>,
  sessionId?: string,
  conversationId?: string,
): string {
  const request = {
    tool,
    args: cloneTaskArgs(args),
    sessionId: sessionId || null,
    conversationId: conversationId || null,
  };
  return crypto.createHash("sha256").update(canonicalizeJson(request), "utf8").digest("hex");
}

/** Stable, process-independent task id for duplicate model/tool-call deliveries. */
export function createAutomationOperationTaskId(
  sessionId: string,
  conversationId: string,
  operationId: string,
  tool: string,
): string {
  const operation = canonicalizeJson({ sessionId, conversationId, operationId, tool });
  return `SARA-OP-${crypto.createHash("sha256").update(operation, "utf8").digest("hex").slice(0, 24).toUpperCase()}`;
}

function snapshotTask(task: AutomationTask): AutomationTask {
  return { ...task, args: cloneTaskArgs(task.args) };
}

/** Coordinates existing tools without owning or reimplementing any tool. */
export class AutomationOrchestrator {
  private readonly executor: Executor;
  private readonly afterVerifiedSuccess?: AfterVerifiedSuccess;
  private readonly listeners = new Set<Listener>();
  private readonly tasks = new Map<string, AutomationTask>();
  // In-process deduplication only. Durable cross-session idempotency needs a persistent operation ledger.
  private readonly taskFingerprints = new Map<string, string>();
  private queue: AutomationTask[] = [];
  private running = 0;
  private browserBusy = false;

  constructor(executor: Executor, afterVerifiedSuccess?: AfterVerifiedSuccess) {
    this.executor = executor;
    this.afterVerifiedSuccess = afterVerifiedSuccess;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(input: AutomationTaskInput): AutomationTask {
    const taskId = input.task_id || newTaskId();
    const args = cloneTaskArgs(input.args);
    const fingerprint = fingerprintTaskRequest(input.tool, args, input.sessionId, input.conversationId);
    const existing = this.tasks.get(taskId);
    if (existing) {
      const previousFingerprint = this.taskFingerprints.get(taskId) ||
        fingerprintTaskRequest(existing.tool, existing.args, existing.sessionId, existing.conversationId);
      if (previousFingerprint !== fingerprint) {
        throw new Error(`Automation task ID ${taskId} was reused for a different request; no new action was queued.`);
      }
      this.taskFingerprints.set(taskId, previousFingerprint);
      return snapshotTask(existing);
    }

    const goal = String(input.goal || input.original_command || input.tool || "Automation task");
    const context = createTaskContext({
      task_id: taskId,
      conversation_id: input.conversationId || "automation",
      user_id: input.userId,
      identity_id: input.identityId,
      goal,
      original_command: input.original_command || goal,
      current_step: input.currentStep || "queued",
      task_state: "QUEUED",
    });

    const task: AutomationTask = {
      task_id: taskId,
      tool: input.tool,
      args,
      priority: input.priority || "NORMAL",
      status: "QUEUED",
      task_state: context.task_state,
      progress: 0,
      created_at: context.created_at,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      goal,
      original_command: context.original_command,
      context,
    };
    this.tasks.set(task.task_id, task);
    this.taskFingerprints.set(task.task_id, fingerprint);
    this.queue.push(task);
    this.emit("TASK_CREATED", task);
    this.emit("automation:queued", task);
    void this.persistTaskState(task);
    queueMicrotask(() => {
      void this.drain();
    });
    return snapshotTask(task);
  }

  restore(tasks: RestoredAutomationTask[]): void {
    const interruptedMessage = "This automation was interrupted by a SARA restart. Its saved checkpoint was preserved; review it before explicitly retrying because an external side effect may already have occurred.";
    for (const restored of tasks) {
      const previousStatus = String(restored.status || "").toLowerCase();
      if (this.tasks.has(restored.task_id) || ["completed", "succeeded", "failed", "cancelled"].includes(previousStatus)) continue;

      const restoredGoal = String((restored as any).goal || restored.tool || "Automation task");
      const restoredArgs = cloneTaskArgs(restored.args || {});
      const savedContext = restored.checkpoint?.automationContext as PersistedTaskContext | undefined;
      const context: PersistedTaskContext = savedContext?.task_id === restored.task_id
        ? {
            ...savedContext,
            current_step: "recovery_review",
            task_state: "WAITING_FOR_USER",
            last_error: interruptedMessage,
            updated_at: new Date().toISOString(),
          }
        : createTaskContext({
            task_id: restored.task_id,
            conversation_id: restored.conversationId || "automation",
            goal: restoredGoal,
            original_command: String((restored as any).original_command || restoredGoal),
            current_step: "recovery_review",
            task_state: "WAITING_FOR_USER",
          });
      const recovery = {
        state: "paused_after_restart",
        interruptedStatus: restored.status || "unknown",
        interruptedAt: new Date().toISOString(),
        checkpointPreserved: true,
        automaticReplay: false,
      };
      const task: AutomationTask = {
        task_id: restored.task_id,
        tool: restored.tool,
        args: restoredArgs,
        priority: restored.priority,
        status: "PAUSED",
        task_state: "WAITING_FOR_USER",
        progress: restored.progress ?? Number(restored.checkpoint?.task_progress || 0),
        created_at: restored.created_at || new Date().toISOString(),
        started_at: restored.started_at,
        updated_at: new Date().toISOString(),
        error: interruptedMessage,
        sessionId: restored.sessionId,
        conversationId: restored.conversationId,
        goal: restoredGoal,
        original_command: context.original_command,
        context,
        checkpoint: { ...(restored.checkpoint || {}), recovery },
      };
      this.tasks.set(task.task_id, task);
      this.taskFingerprints.set(task.task_id, fingerprintTaskRequest(task.tool, task.args, task.sessionId, task.conversationId));
      // A restored task is reviewable but is deliberately not added to the queue.
      this.emit("RECOVERY_PAUSED", task);
    }
  }

  resumeTask(taskId: string, nextStep?: string): AutomationTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "PAUSED") return undefined;
    const restoredContext = task.context ? resumeFromTaskContext(task.context, nextStep) : createTaskContext({
      task_id: taskId,
      conversation_id: task.conversationId || "automation",
      goal: task.goal || task.tool,
      original_command: task.original_command || task.goal || task.tool,
      current_step: nextStep || "resume",
      task_state: "RUNNING",
    });
    task.context = restoredContext;
    task.task_state = "RECOVERING";
    task.status = "QUEUED";
    task.stop_requested = false;
    task.stop_requested_at = undefined;
    task.error = undefined;
    task.progress = Math.max(task.progress, 25);
    task.updated_at = restoredContext.updated_at;
    this.queue.push(task);
    this.emit("RECOVERY_COMPLETED", task);
    this.emit("automation:queued", task);
    void this.persistTaskState(task);
    queueMicrotask(() => { void this.drain(); });
    return snapshotTask(task);
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) return false;
    if (task.status === "QUEUED" || task.status === "PAUSED") {
      task.status = "CANCELLED";
      task.task_state = "CANCELLED";
      task.completed_at = new Date().toISOString();
      task.updated_at = task.completed_at;
      this.queue = this.queue.filter((item) => item.task_id !== taskId);
      this.emit("automation:cancelled", task);
      void this.persistTaskState(task);
      return true;
    }
    if (["STARTING", "RUNNING", "WAITING", "VERIFYING"].includes(task.status)) {
      task.stop_requested = true;
      task.stop_requested_at = new Date().toISOString();
      task.updated_at = task.stop_requested_at;
      this.emit("automation:progress", task);
      void this.persistTaskState(task);
      return true;
    }
    return false;
  }

  /** Cancel queued work and request cooperative stops for active tasks. */
  emergencyStop(): { cancelledQueuedTaskIds: string[]; cancellationRequestedTaskIds: string[] } {
    const cancelledQueuedTaskIds: string[] = [];
    const cancellationRequestedTaskIds: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "QUEUED") {
        if (this.cancelTask(task.task_id)) cancelledQueuedTaskIds.push(task.task_id);
      } else if (["STARTING", "RUNNING", "WAITING", "VERIFYING"].includes(task.status)) {
        if (this.cancelTask(task.task_id)) cancellationRequestedTaskIds.push(task.task_id);
      }
    }
    return { cancelledQueuedTaskIds, cancellationRequestedTaskIds };
  }

  getTask(taskId: string): AutomationTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? snapshotTask(task) : undefined;
  }

  listTasks(): AutomationTask[] {
    return [...this.tasks.values()].map(snapshotTask);
  }

  private pauseAfterStopRequest(task: AutomationTask, detail?: unknown): void {
    task.status = "PAUSED";
    task.task_state = "WAITING_FOR_USER";
    task.progress = Math.max(task.progress, 20);
    task.updated_at = new Date().toISOString();
    const extra = detail instanceof Error ? ` ${detail.message}` : detail ? ` ${String(detail)}` : "";
    task.error = `Stop requested while this action may have been running. The current tool call may have completed external effects; review the real-world state before retrying. SARA will not replay it automatically.${extra}`;
    task.checkpoint = {
      ...(task.checkpoint || {}),
      cancellation: { requested: true, requestedAt: task.stop_requested_at, actionMayHaveCompleted: true },
      recovery: { state: "paused_for_review", checkpointPreserved: true, automaticReplay: false },
    };
    if (task.context) {
      task.context.task_state = "WAITING_FOR_USER";
      task.context.current_step = "cancellation_review";
      task.context.last_error = task.error;
      task.context.updated_at = task.updated_at;
    }
    this.emit("RECOVERY_PAUSED", task);
    this.emit("automation:progress", task);
    void this.persistTaskState(task);
  }

  private emit(type: AutomationEvent["type"], task: AutomationTask): void {
    const event = { type, task: snapshotTask(task) } as AutomationEvent;
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* status listeners must not affect execution */ }
    }
  }

  private async persistTaskState(task: AutomationTask): Promise<void> {
    try {
      const { loadTasks, updateTask, createTask } = await import("../../../server_state");
      const existing = (await loadTasks()).find((entry) => entry.taskId === task.task_id);
      const metadata = {
        automation: true,
        tool: task.tool,
        args: task.args,
        taskContext: task.context,
        taskState: task.task_state || task.status,
        sessionId: task.sessionId,
        conversationId: task.conversationId,
      };
      if (existing) {
        await updateTask(task.task_id, {
          status: task.status.toLowerCase(),
          checkpoint: {
            current_task: task.tool,
            task_progress: task.progress,
            current_step: task.context?.current_step,
            last_action: task.tool,
            recent_summary: task.goal || task.tool,
          },
          metadata,
          updatedAt: new Date().toISOString(),
        } as any);
      } else {
        await createTask({
          taskId: task.task_id,
          conversationId: task.conversationId || "automation",
          description: task.goal || task.tool,
          priority: 5,
          assignedAgent: "AutomationOrchestrator",
          metadata,
        });
      }
    } catch {
      // persistence is best-effort and should not break the runtime queue
    }
  }

  private nextTask(): AutomationTask | undefined {
    const available = this.queue.filter((task) => task.status === "QUEUED");
    const next = available
      .filter((task) => !isBrowserTool(task.tool) || !this.browserBusy)
      .sort((left, right) => PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority] || left.created_at.localeCompare(right.created_at))[0];
    if (!next) return undefined;
    this.queue = this.queue.filter((task) => task.task_id !== next.task_id);
    return next;
  }

  private drain(): void {
    while (this.running < 4) {
      const task = this.nextTask();
      if (!task) return;
      void this.run(task);
    }
  }

  private async run(task: AutomationTask): Promise<void> {
    this.running += 1;
    const browserTask = isBrowserTool(task.tool);
    if (browserTask) this.browserBusy = true;
    task.status = "STARTING";
    task.task_state = "RUNNING";
    task.started_at = new Date().toISOString();
    if (task.context) {
      task.context.task_state = "RUNNING";
      task.context.current_step = task.context.current_step || "running";
      task.context.updated_at = task.started_at;
    }
    this.emit("TASK_PLANNED", task);
    this.emit("automation:started", task);
    task.status = "RUNNING";
    task.progress = 20;
    this.emit("automation:progress", task);
    void this.persistTaskState(task);

    try {
      task.result = await this.executor(task.tool, {
        ...task.args,
        automation_task_id: task.task_id,
      });
      if (task.stop_requested) {
        this.pauseAfterStopRequest(task);
        return;
      }
      task.status = "VERIFYING";
      task.task_state = "VERIFYING";
      task.progress = 90;
      task.updated_at = new Date().toISOString();
      if (task.context) {
        task.context.task_state = "VERIFYING";
        task.context.current_step = "verify_postcondition";
        task.context.updated_at = task.updated_at;
      }
      this.emit("VERIFICATION_STARTED", task);

      if (resultIsVerifiedSuccess(task.result)) {
        if (this.afterVerifiedSuccess) {
          const verifiedTaskResult = task.result;
          try {
            const postSuccessResult = await this.afterVerifiedSuccess({ ...task, args: { ...task.args } });
            if (postSuccessResult !== undefined) {
              task.result = { taskResult: verifiedTaskResult, autoClose: postSuccessResult };
            }
          } catch (error) {
            task.result = {
              taskResult: verifiedTaskResult,
              autoClose: {
                ok: false,
                verified: false,
                status: "left_open",
                result: `The task succeeded, but graceful app cleanup could not be verified; the app was left open. ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
        }
        if (task.stop_requested) {
          this.pauseAfterStopRequest(task);
          return;
        }
        task.status = "COMPLETED";
        task.task_state = "COMPLETED";
        task.progress = 100;
        task.completed_at = new Date().toISOString();
        if (task.context) {
          task.context.task_state = "COMPLETED";
          task.context.current_step = "completed_verified";
          task.context.updated_at = task.completed_at;
        }
        this.emit("VERIFICATION_PASSED", task);
        this.emit("TASK_COMPLETED", task);
        this.emit("automation:completed", task);
      } else if (definiteNoExecution(task.result)) {
        task.status = "FAILED";
        task.task_state = "FAILED";
        task.progress = 100;
        task.completed_at = new Date().toISOString();
        task.error = resultError(task.result);
        if (task.context) {
          task.context.task_state = "FAILED";
          task.context.last_error = task.error;
          task.context.updated_at = task.completed_at;
        }
        this.emit("VERIFICATION_FAILED", task);
        this.emit("TASK_FAILED", task);
        this.emit("automation:failed", task);
      } else {
        task.status = "PAUSED";
        task.task_state = "WAITING_FOR_USER";
        task.progress = 90;
        task.updated_at = new Date().toISOString();
        task.error = `The action may have run, but its final state was not verified. ${resultError(task.result)} Review the external state before explicitly retrying; SARA will not replay it automatically.`;
        task.checkpoint = {
          ...(task.checkpoint || {}),
          verification: { attempted: true, passed: false, status: "review_required" },
          recovery: { state: "paused_for_review", checkpointPreserved: true, automaticReplay: false },
        };
        if (task.context) {
          task.context.task_state = "WAITING_FOR_USER";
          task.context.current_step = "verification_review";
          task.context.last_error = task.error;
          task.context.updated_at = task.updated_at;
        }
        this.emit("VERIFICATION_FAILED", task);
        this.emit("RECOVERY_PAUSED", task);
        this.emit("automation:progress", task);
      }
      void this.persistTaskState(task);
    } catch (error) {
      if (task.stop_requested) {
        this.pauseAfterStopRequest(task, error);
      } else {
        task.status = "PAUSED";
        task.task_state = "WAITING_FOR_USER";
        task.progress = 90;
        task.updated_at = new Date().toISOString();
        task.error = `Execution outcome is uncertain and needs review before retrying: ${error instanceof Error ? error.message : String(error)}`;
        task.checkpoint = {
          ...(task.checkpoint || {}),
          recovery: { state: "paused_for_review", checkpointPreserved: true, automaticReplay: false },
        };
        if (task.context) {
          task.context.task_state = "WAITING_FOR_USER";
          task.context.current_step = "execution_review";
          task.context.last_error = task.error;
          task.context.updated_at = task.updated_at;
        }
        this.emit("VERIFICATION_FAILED", task);
        this.emit("RECOVERY_PAUSED", task);
        this.emit("automation:progress", task);
        void this.persistTaskState(task);
      }
    } finally {
      if (browserTask) this.browserBusy = false;
      this.running -= 1;
      this.drain();
    }
  }
}

export function isAsyncAutomationTool(tool: string): boolean {
  return isBrowserTool(tool) || tool === "saraAppExecuteGoal";
}