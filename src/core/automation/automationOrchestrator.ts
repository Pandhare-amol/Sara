import crypto from "crypto";
import { createTaskContext, resumeFromTaskContext, type PersistedTaskContext } from "./taskContext";

export type AutomationPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "BACKGROUND";
export type AutomationStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "CANCELLING"
  | "RETRYING"
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
  /** Overall queue + execution deadline; bounded by the orchestrator. */
  deadlineMs?: number;
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
  deadline_at?: string;
  stop_requested_at?: string;
  retry_count: number;
  error?: string;
  result?: unknown;
  sessionId?: string;
  conversationId?: string;
  task_state?: string;
  goal?: string;
  original_command?: string;
  context?: PersistedTaskContext;
  checkpoint?: Record<string, unknown>;
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
  type: AutomationEventType | "automation:queued" | "automation:started" | "automation:progress" | "automation:completed" | "automation:failed" | "automation:paused" | "automation:cancel_requested";
  task: AutomationTask;
};

type Executor = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
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

// Only known, non-console app launches are eligible for immediate queued voice
// acknowledgement. Unknown names fall through to the existing synchronous
// tool/policy path; do not broaden arbitrary process execution via background work.
const BACKGROUND_APP_NAMES = new Set([
  "notepad", "calculator", "calc", "chrome", "edge", "firefox", "brave", "vscode", "code",
  "file explorer", "explorer", "task manager", "taskmanager", "paint", "word", "excel",
  "powerpoint", "vlc", "spotify",
]);

function usesDesktopResource(tool: string): boolean {
  // Office edits and app opens must not race with other desktop-control work.
  return isBrowserTool(tool) || tool === "openApplication" || tool === "saraVisualClick" ||
    ["saraDocumentCreate", "saraDocumentEdit", "saraDocumentOpen"].includes(tool);
}

function resultRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function resultIsVerifiedSuccess(value: unknown): boolean {
  const record = resultRecord(value);
  const verification = resultRecord(record.verification);
  const checks = Array.isArray(verification.checks) ? verification.checks : record.verificationChecks;
  const hasPassingCheck = Array.isArray(checks) && checks.some((check: unknown) => resultRecord(check).passed === true);
  const explicitlyVerified = hasPassingCheck && (
    (verification.attempted === true && verification.passed === true) ||
    (record.verificationStatus === "verified" && record.verified === true)
  );
  return (record.success === true || record.ok === true) && explicitlyVerified;
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
  return `SARA-AUTO-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

export class AutomationQueueFullError extends Error {
  constructor() { super("Automation queue is full; wait for a task to finish before submitting another."); }
}

/** A deliberately small safe list; retry only a confirmed non-execution of a read-only probe. */
const SAFE_RETRY_TOOLS = new Set(["systemInfo"]);
const TERMINAL = new Set<AutomationStatus>(["COMPLETED", "FAILED", "CANCELLED"]);

/** Client/Live status projection. Never serialize tool arguments, results, user goals or checkpoints. */
export function publicAutomationTask(task: AutomationTask) {
  return {
    task_id: task.task_id, tool: task.tool, status: task.status,
    progress: task.progress, priority: task.priority,
    conversationId: task.conversationId, created_at: task.created_at,
    updated_at: task.updated_at, started_at: task.started_at,
    completed_at: task.completed_at, deadline_at: task.deadline_at,
    stop_requested_at: task.stop_requested_at, retry_count: task.retry_count,
    verified: task.status === "COMPLETED",
    review_required: task.status === "PAUSED" && (task.checkpoint?.recovery as { state?: string } | undefined)?.state !== "paused_before_execution",
    message: task.status === "COMPLETED" ? (task.stop_requested_at ? "Completed despite the stop request; independently verified." : "Independently verified completed.")
      : task.status === "CANCELLING" ? "Stop requested. An in-flight tool may still finish; outcome is not yet known."
      : task.status === "PAUSED" ? (task.checkpoint?.recovery as { state?: string } | undefined)?.state === "paused_before_execution"
        ? "Paused before execution; may resume before its deadline."
        : "Paused; review the external state. An action may have run."
      : task.status === "CANCELLED" ? "Cancelled before execution or confirmed not executed."
      : task.status === "FAILED" ? "Failed; do not claim the action completed."
      : "Not independently verified as complete.",
  };
}

/** Coordinates existing tools without owning or reimplementing any tool. */
export class AutomationOrchestrator {
  private readonly executor: Executor;
  private readonly listeners = new Set<Listener>();
  private readonly tasks = new Map<string, AutomationTask>();
  private queue: AutomationTask[] = [];
  private running = 0;
  private desktopBusy = false;
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxQueued: number;
  private readonly maxRecords: number;

  constructor(executor: Executor, limits: { maxQueued?: number; maxRecords?: number } = {}) {
    this.executor = executor;
    this.maxQueued = Math.max(1, Math.min(128, limits.maxQueued ?? 24));
    this.maxRecords = Math.max(this.maxQueued + 4, Math.min(1024, limits.maxRecords ?? 256));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(input: AutomationTaskInput): AutomationTask {
    // Backpressure is checked before allocating a task ID or changing state.
    this.pruneHistory(true);
    if (this.queue.length >= this.maxQueued || this.tasks.size >= this.maxRecords) throw new AutomationQueueFullError();
    const taskId = input.task_id || newTaskId();
    if (this.tasks.has(taskId)) throw new Error("Automation task ID already exists.");
    const deadlineMs = Number.isFinite(input.deadlineMs)
      ? Math.max(1_000, Math.min(300_000, Math.floor(input.deadlineMs!))) : 120_000;
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
      args: { ...input.args },
      priority: input.priority || "NORMAL",
      status: "QUEUED",
      task_state: context.task_state,
      progress: 0,
      retry_count: 0,
      created_at: context.created_at,
      deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      goal,
      original_command: context.original_command,
      context,
    };
    this.tasks.set(task.task_id, task);
    this.queue.push(task);
    this.emit("TASK_CREATED", task);
    this.emit("automation:queued", task);
    this.scheduleDeadline(task, deadlineMs);
    this.pruneHistory();
    queueMicrotask(() => this.drain());
    return { ...task };
  }

  restore(tasks: RestoredAutomationTask[]): void {
    const interruptedMessage = "This automation was interrupted by a SARA restart. Its saved checkpoint was preserved; review it before explicitly retrying because an external side effect may already have occurred.";
    for (const restored of tasks) {
      const previousStatus = String(restored.status || "").toLowerCase();
      if (this.tasks.has(restored.task_id) || ["completed", "succeeded", "failed", "cancelled"].includes(previousStatus)) continue;

      const restoredGoal = String((restored as any).goal || restored.tool || "Automation task");
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
        args: { ...restored.args },
        priority: restored.priority,
        status: "PAUSED",
        task_state: "WAITING_FOR_USER",
        progress: restored.progress ?? Number(restored.checkpoint?.task_progress || 0),
        retry_count: 0,
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
      // A restored task is reviewable but is deliberately not added to the queue.
      this.emit("RECOVERY_PAUSED", task);
    }
  }

  /** Only work paused *before dispatch* may resume. Uncertain effects never replay. */
  resumeTask(taskId: string): AutomationTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "PAUSED" || (task.checkpoint?.recovery as { state?: string } | undefined)?.state !== "paused_before_execution" ||
        this.queue.length >= this.maxQueued || Date.parse(task.deadline_at || "") <= Date.now()) return undefined;
    task.context = task.context ? resumeFromTaskContext(task.context, "queued_after_pause") : task.context;
    task.task_state = "QUEUED";
    task.status = "QUEUED";
    task.error = undefined;
    task.updated_at = new Date().toISOString();
    task.checkpoint = undefined;
    this.queue.push(task);
    this.emit("RECOVERY_COMPLETED", task);
    this.emit("automation:queued", task);
    queueMicrotask(() => this.drain());
    return { ...task };
  }

  pauseTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "QUEUED") return false;
    this.queue = this.queue.filter((item) => item.task_id !== taskId);
    task.status = "PAUSED";
    task.task_state = "PAUSED";
    task.updated_at = new Date().toISOString();
    task.checkpoint = { recovery: { state: "paused_before_execution", automaticReplay: false } };
    this.emit("automation:paused", task);
    return true;
  }

  /** In-flight tools do not promise cooperative cancellation. Keep their resource held until a result arrives. */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL.has(task.status) || task.status === "CANCELLING" ||
        (task.status === "PAUSED" && (task.checkpoint?.recovery as { state?: string } | undefined)?.state !== "paused_before_execution")) return false;
    if (task.status === "QUEUED" || task.status === "PAUSED") {
      task.status = "CANCELLED";
      task.task_state = "CANCELLED";
      task.completed_at = new Date().toISOString();
      this.queue = this.queue.filter((item) => item.task_id !== taskId);
      this.settle(task);
      this.emit("automation:failed", task);
      return true;
    }
    task.status = "CANCELLING";
    task.stop_requested_at = new Date().toISOString();
    task.updated_at = task.stop_requested_at;
    this.emit("automation:cancel_requested", task);
    return true;
  }

  getTask(taskId: string): AutomationTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(): AutomationTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  private emit(type: AutomationEvent["type"], task: AutomationTask): void {
    const event = { type, task: { ...task } } as AutomationEvent;
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* status listeners must not affect execution */ }
    }
  }

  /** The server's single ordered event listener owns persistence; never write raw args here. */
  private scheduleDeadline(task: AutomationTask, ms: number): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(task.task_id);
      if (TERMINAL.has(task.status)) return;
      if (task.status === "QUEUED" ||
          (task.status === "PAUSED" && (task.checkpoint?.recovery as { state?: string } | undefined)?.state === "paused_before_execution")) {
        this.queue = this.queue.filter((item) => item.task_id !== task.task_id);
        task.status = "FAILED";
        task.task_state = "FAILED";
        task.error = "Deadline expired before dispatch; no tool was executed.";
        task.completed_at = new Date().toISOString();
        this.emit("TASK_FAILED", task);
        this.emit("automation:failed", task);
      } else if (["STARTING", "RUNNING", "VERIFYING", "RETRYING"].includes(task.status)) {
        // The agent may already have acted. Never report an in-flight timeout as cancellation.
        task.status = "CANCELLING";
        task.stop_requested_at = new Date().toISOString();
        task.updated_at = task.stop_requested_at;
        this.emit("automation:cancel_requested", task);
      }
    }, ms);
    timer.unref?.();
    this.deadlines.set(task.task_id, timer);
  }

  private settle(task: AutomationTask): void {
    const timer = this.deadlines.get(task.task_id);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(task.task_id);
    this.pruneHistory();
  }

  private pruneHistory(reserveSlot = false): void {
    // Keep active work and the most recent terminal results for voice deduplication.
    // Older completed records remain in the server-owned task store for audit.
    const limit = this.maxRecords - (reserveSlot ? 1 : 0);
    if (this.tasks.size <= limit) return;
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= limit) break;
      if (TERMINAL.has(task.status)) this.tasks.delete(id);
    }
  }

  private nextTask(): AutomationTask | undefined {
    for (const task of this.queue) {
      if (task.status === "QUEUED" && Date.parse(task.deadline_at || "") <= Date.now()) {
        task.status = "FAILED";
        task.task_state = "FAILED";
        task.error = "Deadline expired before dispatch; no tool was executed.";
        task.completed_at = new Date().toISOString();
        this.settle(task);
        this.emit("TASK_FAILED", task);
        this.emit("automation:failed", task);
      }
    }
    this.queue = this.queue.filter((task) => task.status === "QUEUED");
    const available = this.queue;
    const next = available
      .filter((task) => !usesDesktopResource(task.tool) || !this.desktopBusy)
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
    const desktopTask = usesDesktopResource(task.tool);
    if (desktopTask) this.desktopBusy = true;
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

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        task.result = await this.executor(task.tool, {
          ...task.args,
          automation_task_id: task.task_id,
        });
        // Only a read-only probe with explicit non-execution may retry once.
        // Never replay a GUI write, app launch, message or uncertain result.
        if (attempt === 0 && SAFE_RETRY_TOOLS.has(task.tool) && definiteNoExecution(task.result) &&
            !task.stop_requested_at && Date.now() + 150 < Date.parse(task.deadline_at || "")) {
          task.retry_count += 1;
          task.status = "RETRYING";
          task.updated_at = new Date().toISOString();
          this.emit("automation:progress", task);
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (task.stop_requested_at || Date.now() >= Date.parse(task.deadline_at || "")) break;
          task.status = "RUNNING";
          this.emit("automation:progress", task);
          continue;
        }
        break;
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
        task.status = "COMPLETED";
        task.task_state = "COMPLETED";
        if (task.stop_requested_at) task.error = "The action completed despite the stop request; the result was independently verified.";
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
        task.status = task.stop_requested_at ? "CANCELLED" : "FAILED";
        task.task_state = task.status;
        task.progress = 100;
        task.completed_at = new Date().toISOString();
        task.error = task.stop_requested_at ? "Stop confirmed before tool execution." : resultError(task.result);
        if (task.context) {
          task.context.task_state = task.task_state as PersistedTaskContext["task_state"];
          task.context.last_error = task.error;
          task.context.updated_at = task.completed_at;
        }
        this.emit("VERIFICATION_FAILED", task);
        if (task.status === "FAILED") this.emit("TASK_FAILED", task);
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
    } catch (error) {
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
    } finally {
      this.settle(task);
      if (desktopTask) this.desktopBusy = false;
      this.running -= 1;
      this.drain();
    }
  }
}

export function isAsyncAutomationTool(tool: string, args: Record<string, unknown> = {}): boolean {
  if (isBrowserTool(tool)) return true;
  if (["saraDocumentCreate", "saraDocumentEdit", "saraDocumentOpen"].includes(tool)) {
    return typeof args.path === "string" && Boolean(args.path.trim());
  }
  const name = args.name ?? args.application;
  return tool === "openApplication" && typeof name === "string" && BACKGROUND_APP_NAMES.has(name.trim().toLowerCase());
}