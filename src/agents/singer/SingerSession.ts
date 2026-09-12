import crypto from "node:crypto";
import type { SingerSessionContext, SingerTask, SingerTaskStatus } from "./SingerTypes";
import { SARA_VOCAL_PERSONA } from "./SingerTypes";

export class SingerSessionStore {
  private readonly sessions = new Map<string, SingerSessionContext>();
  private readonly tasks = new Map<string, SingerTask>();
  createTask(input: { userId: string; conversationId: string; correlationId?: string }): SingerTask {
    const now = new Date().toISOString();
    const taskId = `singer-${crypto.randomUUID()}`;
    const session: SingerSessionContext = { sessionId: `singer-session-${crypto.randomUUID()}`, taskId, conversationId: input.conversationId, vocalProfile: SARA_VOCAL_PERSONA, createdAt: now };
    const task: SingerTask = { taskId, userId: input.userId, conversationId: input.conversationId, correlationId: input.correlationId || crypto.randomUUID(), status: "QUEUED", progress: 0, createdAt: now, updatedAt: now, session };
    this.sessions.set(session.sessionId, session); this.tasks.set(taskId, task); return this.copy(task);
  }
  update(taskId: string, status: SingerTaskStatus, progress: number, error?: SingerTask["error"]): SingerTask | undefined {
    const task = this.tasks.get(taskId); if (!task) return undefined;
    task.status = status; task.progress = Math.max(0, Math.min(100, progress)); task.updatedAt = new Date().toISOString(); if (error) task.error = error; return this.copy(task);
  }
  updateSession(taskId: string, patch: Partial<SingerSessionContext>): SingerTask | undefined {
    const task = this.tasks.get(taskId); if (!task) return undefined;
    Object.assign(task.session, patch); return this.copy(task);
  }
  get(taskId: string): SingerTask | undefined { const task = this.tasks.get(taskId); return task && this.copy(task); }
  getByConversation(conversationId: string): SingerTask | undefined { return [...this.tasks.values()].filter((task) => task.conversationId === conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] && this.copy([...this.tasks.values()].filter((task) => task.conversationId === conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]); }
  private copy(task: SingerTask): SingerTask { return { ...task, session: { ...task.session }, error: task.error && { ...task.error } }; }
}
