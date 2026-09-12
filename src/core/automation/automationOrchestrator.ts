import crypto from "crypto";
import { createTaskContext, resumeFromTaskContext, type PersistedTaskContext } from "./taskContext";

export type AutomationPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "BACKGROUND";
export type AutomationStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "WAITING"
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
}

export interface RestoredAutomationTask {
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  priority: AutomationPriority;
  status?: AutomationStatus;
  progress?: number;
  created_at?: string;
  sessionId?: string;
  conversationId?: string;
}

export type AutomationEvent = {
  type: AutomationEventType | "automation:queued" | "automation:started" | "automation:progress" | "automation:completed" | "automation:failed";
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

function newTaskId(): string {
  return `SARA-AUTO-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/** Coordinates existing tools without owning or reimplementing any tool. */
export class AutomationOrchestrator {
  private readonly executor: Executor;
  private readonly listeners = new Set<Listener>();
  private readonly tasks = new Map<string, AutomationTask>();
  private queue: AutomationTask[] = [];
  private running = 0;
  private browserBusy = false;

  constructor(executor: Executor) {
    this.executor = executor;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(input: AutomationTaskInput): AutomationTask {
    const taskId = input.task_id || newTaskId();
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
      created_at: context.created_at,
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
    void this.persistTaskState(task);
    queueMicrotask(() => {
      void this.drain();
    });
    return { ...task };
  }

  restore(tasks: RestoredAutomationTask[]): void {
    for (const restored of tasks) {
      if (this.tasks.has(restored.task_id) || ["COMPLETED", "FAILED", "CANCELLED"].includes(restored.status || "")) continue;
      const restoredGoal = String((restored as any).goal || restored.tool || "Automation task");
      const context = createTaskContext({
        task_id: restored.task_id,
        conversation_id: restored.conversationId || "automation",
        goal: restoredGoal,
        original_command: String((restored as any).original_command || restoredGoal),
        current_step: String((restored as any).current_step || "resume"),
        task_state: "RECOVERING",
      });
      const task: AutomationTask = {
        task_id: restored.task_id,
        tool: restored.tool,
        args: { ...restored.args },
        priority: restored.priority,
        status: "QUEUED",
        task_state: context.task_state,
        progress: restored.progress || 0,
        created_at: restored.created_at || new Date().toISOString(),
        sessionId: restored.sessionId,
        conversationId: restored.conversationId,
        goal: restoredGoal,
        original_command: context.original_command,
        context,
      };
      this.tasks.set(task.task_id, task);
      this.queue.push(task);
      this.emit("RECOVERY_STARTED", task);
      this.emit("automation:queued", task);
    }
    if (tasks.length > 0) queueMicrotask(() => this.drain());
  }

  resumeTask(taskId: string, nextStep?: string): AutomationTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const restoredContext = task.context ? resumeFromTaskContext(task.context, nextStep) : createTaskContext({
      task_id: taskId,
      conversation_id: task.conversationId || "automation",
      goal: task.goal || task.tool,
      original_command: task.original_command || task.goal || task.tool,
      current_step: nextStep || "resume",
      task_state: "RUNNING",
    });
    task.context = restoredContext;
    task.task_state = restoredContext.task_state;
    task.status = "RUNNING";
    task.progress = Math.max(task.progress, 25);
    task.updated_at = restoredContext.updated_at;
    this.emit("RECOVERY_COMPLETED", task);
    void this.persistTaskState(task);
    return { ...task };
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) return false;
    if (task.status === "QUEUED") {
      task.status = "CANCELLED";
      task.completed_at = new Date().toISOString();
      this.queue = this.queue.filter((item) => item.task_id !== taskId);
      this.emit("automation:failed", task);
      return true;
    }
    return false;
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
          status: (task.task_state || task.status || "queued").toLowerCase(),
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
      task.status = "COMPLETED";
      task.task_state = "COMPLETED";
      task.progress = 100;
      task.completed_at = new Date().toISOString();
      if (task.context) {
        task.context.task_state = "COMPLETED";
        task.context.current_step = "completed";
        task.context.updated_at = task.completed_at;
      }
      this.emit("TASK_COMPLETED", task);
      this.emit("automation:completed", task);
      void this.persistTaskState(task);
    } catch (error) {
      task.status = "FAILED";
      task.task_state = "FAILED";
      task.progress = 100;
      task.completed_at = new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);
      if (task.context) {
        task.context.task_state = "FAILED";
        task.context.last_error = task.error;
        task.context.updated_at = task.completed_at;
      }
      this.emit("TASK_FAILED", task);
      this.emit("automation:failed", task);
      void this.persistTaskState(task);
    } finally {
      if (browserTask) this.browserBusy = false;
      this.running -= 1;
      this.drain();
    }
  }
}

export function isAsyncAutomationTool(tool: string): boolean {
  return isBrowserTool(tool);
}