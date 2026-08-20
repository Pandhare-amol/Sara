import crypto from "crypto";

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

export interface AutomationTaskInput {
  tool: string;
  args: Record<string, unknown>;
  priority?: AutomationPriority;
  sessionId?: string;
  conversationId?: string;
}

export interface AutomationTask {
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  priority: AutomationPriority;
  status: AutomationStatus;
  progress: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  result?: unknown;
  sessionId?: string;
  conversationId?: string;
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
  type: "automation:queued" | "automation:started" | "automation:progress" | "automation:completed" | "automation:failed";
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
    const task: AutomationTask = {
      task_id: newTaskId(),
      tool: input.tool,
      args: { ...input.args },
      priority: input.priority || "NORMAL",
      status: "QUEUED",
      progress: 0,
      created_at: new Date().toISOString(),
      sessionId: input.sessionId,
      conversationId: input.conversationId,
    };
    this.tasks.set(task.task_id, task);
    this.queue.push(task);
    this.emit("automation:queued", task);
    queueMicrotask(() => this.drain());
    return { ...task };
  }

  restore(tasks: RestoredAutomationTask[]): void {
    for (const restored of tasks) {
      if (this.tasks.has(restored.task_id) || ["COMPLETED", "FAILED", "CANCELLED"].includes(restored.status || "")) continue;
      const task: AutomationTask = {
        task_id: restored.task_id,
        tool: restored.tool,
        args: { ...restored.args },
        priority: restored.priority,
        status: "QUEUED",
        progress: restored.progress || 0,
        created_at: restored.created_at || new Date().toISOString(),
        sessionId: restored.sessionId,
        conversationId: restored.conversationId,
      };
      this.tasks.set(task.task_id, task);
      this.queue.push(task);
      this.emit("automation:queued", task);
    }
    if (tasks.length > 0) queueMicrotask(() => this.drain());
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
    task.started_at = new Date().toISOString();
    this.emit("automation:started", task);
    task.status = "RUNNING";
    task.progress = 20;
    this.emit("automation:progress", task);

    try {
      task.result = await this.executor(task.tool, {
        ...task.args,
        automation_task_id: task.task_id,
      });
      task.status = "COMPLETED";
      task.progress = 100;
      task.completed_at = new Date().toISOString();
      this.emit("automation:completed", task);
    } catch (error) {
      task.status = "FAILED";
      task.progress = 100;
      task.completed_at = new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);
      this.emit("automation:failed", task);
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