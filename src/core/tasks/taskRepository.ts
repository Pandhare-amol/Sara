import fs from "fs";
import path from "path";
import { TaskExecution, TaskExecutionStatus, isTerminalTaskStatus } from "./taskContract";

export class TaskRepository {
  private readonly tasks = new Map<string, TaskExecution>();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.cwd(), "data", "task-state.json");
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return;

      const parsed = JSON.parse(raw) as TaskExecution[];
      for (const task of parsed) {
        if (task?.taskId) this.tasks.set(task.taskId, task);
      }
    } catch {
      // Ignore corrupt or unreadable task state and start from in-memory state.
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...this.tasks.values()], null, 2), "utf8");
    } catch {
      // Keep runtime execution resilient even when persistence fails.
    }
  }

  upsert(task: TaskExecution): TaskExecution {
    const copy = { ...task, childTaskIds: [...(task.childTaskIds || [])] };
    this.tasks.set(task.taskId, copy);
    this.persist();
    return { ...copy };
  }

  get(taskId: string): TaskExecution | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task, childTaskIds: [...(task.childTaskIds || [])] } : undefined;
  }

  list(): TaskExecution[] {
    return [...this.tasks.values()].map((task) => ({ ...task, childTaskIds: [...(task.childTaskIds || [])] }));
  }

  getActiveTasks(): TaskExecution[] {
    return this.list()
      .filter((task) => !isTerminalTaskStatus(task.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getPreviousTasks(): TaskExecution[] {
    return this.list()
      .filter((task) => isTerminalTaskStatus(task.status))
      .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime());
  }

  getActiveForConversation(conversationId: string): TaskExecution | undefined {
    const tasks = this.getActiveTasks().filter((task) => task.conversationId === conversationId);
    return tasks[0] || undefined;
  }

  getAllForConversation(conversationId: string): TaskExecution[] {
    return this.list().filter((task) => task.conversationId === conversationId);
  }

  recoverInterruptedTasks(): TaskExecution[] {
    return this.getActiveTasks().filter(
      (task) =>
        task.status === TaskExecutionStatus.RUNNING ||
        task.status === TaskExecutionStatus.VERIFYING ||
        task.status === TaskExecutionStatus.RECOVERING ||
        task.status === TaskExecutionStatus.QUEUED,
    );
  }
}
