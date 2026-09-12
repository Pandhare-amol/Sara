import { EventEmitter } from "events";
import crypto from "crypto";
import { ExecutionEngine } from "../execution/executionEngine";
import { TaskExecution, TaskExecutionStatus, TaskExecutionUpdate, TaskPriority, TaskVerificationStatus, buildUserVisibleTaskStatus } from "./taskContract";
import { TaskRepository } from "./taskRepository";

export interface CreateTaskInput {
  conversationId: string;
  sessionId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  source?: string;
  priority?: TaskPriority;
  maxAttempts?: number;
  parentTaskId?: string;
  toolCallId?: string;
  correlationId?: string;
}

export class TaskManager extends EventEmitter {
  constructor(
    private readonly repository: TaskRepository = new TaskRepository(),
    private readonly executionEngine?: ExecutionEngine,
  ) {
    super();
  }

  createTask(input: CreateTaskInput): TaskExecution {
    const now = new Date().toISOString();
    const task: TaskExecution = {
      taskId: `task-${crypto.randomUUID()}`,
      correlationId: input.correlationId || crypto.randomUUID(),
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId || `tool-${crypto.randomUUID()}`,
      toolName: input.toolName,
      arguments: input.arguments || {},
      status: TaskExecutionStatus.CREATED,
      createdAt: now,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      priority: input.priority ?? TaskPriority.NORMAL,
      source: input.source || "chat",
      verificationStatus: TaskVerificationStatus.SKIPPED,
      childTaskIds: [],
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.CREATED),
      parentTaskId: input.parentTaskId,
    };

    this.repository.upsert(task);
    this.emit("task.created", task);
    return { ...task };
  }

  enqueueTask(taskId: string): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;
    const updated = {
      ...task,
      status: TaskExecutionStatus.QUEUED,
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.QUEUED),
    };
    this.repository.upsert(updated);
    this.emit("task.queued", updated);
    return { ...updated };
  }

  startTask(taskId: string): Promise<TaskExecution | undefined> {
    return this.runTask(taskId);
  }

  async runTask(taskId: string): Promise<TaskExecution | undefined> {
    const current = this.repository.get(taskId);
    if (!current) return undefined;

    const runningTask = {
      ...current,
      status: TaskExecutionStatus.RUNNING,
      startedAt: current.startedAt || new Date().toISOString(),
      attempt: current.attempt + 1,
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.RUNNING),
    };
    this.repository.upsert(runningTask);
    this.emit("task.started", runningTask);

    if (!this.executionEngine) {
      const fallback = {
        ...runningTask,
        status: TaskExecutionStatus.BLOCKED,
        error: { code: "EXECUTION_ENGINE_MISSING", message: "No execution engine is configured for this task." },
        userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.BLOCKED),
      };
      this.repository.upsert(fallback);
      this.emit("task.failed", fallback);
      return { ...fallback };
    }

    const result = await this.executionEngine.executeTask(runningTask);
    this.repository.upsert(result);
    return { ...result };
  }

  updateTask(taskId: string, updates: TaskExecutionUpdate): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;

    const next = {
      ...task,
      ...updates,
      childTaskIds: [...(updates.childTaskIds || task.childTaskIds || [])],
    };
    if (next.status) {
      next.userVisibleStatus = buildUserVisibleTaskStatus(next.status);
    }
    this.repository.upsert(next);
    this.emit("task.updated", next);
    return { ...next };
  }

  cancelTask(taskId: string): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;

    const cancelled = {
      ...task,
      status: TaskExecutionStatus.CANCELLED,
      completedAt: new Date().toISOString(),
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.CANCELLED),
    };
    this.repository.upsert(cancelled);
    this.emit("task.cancelled", cancelled);
    return { ...cancelled };
  }

  retryTask(taskId: string): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;
    if (task.attempt >= task.maxAttempts) {
      return this.markFailed(taskId, { code: "MAX_ATTEMPTS_EXCEEDED", message: "Task exceeded the retry limit." });
    }

    const retried = {
      ...task,
      status: TaskExecutionStatus.QUEUED,
      error: undefined,
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.QUEUED),
    };
    this.repository.upsert(retried);
    this.emit("task.retried", retried);
    return { ...retried };
  }

  markCompleted(taskId: string, verificationResult?: Record<string, unknown>): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;

    const completed: TaskExecution = {
      ...task,
      status: TaskExecutionStatus.COMPLETED,
      completedAt: new Date().toISOString(),
      verificationStatus: verificationResult ? TaskVerificationStatus.VERIFIED : TaskVerificationStatus.NOT_REQUIRED,
      verificationResult: verificationResult || task.verificationResult,
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.COMPLETED),
    };
    this.repository.upsert(completed);
    this.emit("task.completed", completed);
    return { ...completed };
  }

  markFailed(taskId: string, error: { code: string; message: string; retryable?: boolean; details?: unknown }): TaskExecution | undefined {
    const task = this.repository.get(taskId);
    if (!task) return undefined;

    const failed: TaskExecution = {
      ...task,
      status: TaskExecutionStatus.FAILED,
      completedAt: new Date().toISOString(),
      error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details },
      verificationStatus: TaskVerificationStatus.FAILED,
      userVisibleStatus: buildUserVisibleTaskStatus(TaskExecutionStatus.FAILED),
    };
    this.repository.upsert(failed);
    this.emit("task.failed", failed);
    return { ...failed };
  }

  getTask(taskId: string): TaskExecution | undefined {
    return this.repository.get(taskId);
  }

  getActiveTasks(): TaskExecution[] {
    return this.repository.getActiveTasks();
  }

  getPreviousTasks(): TaskExecution[] {
    return this.repository.getPreviousTasks();
  }

  recoverInterruptedTasks(): TaskExecution[] {
    return this.repository.recoverInterruptedTasks();
  }
}
