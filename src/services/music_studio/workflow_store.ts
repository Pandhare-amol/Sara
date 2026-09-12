import crypto from "node:crypto";
import { initSqlBridge } from "../../../server_state";
import type { MusicWorkflowStage, MusicWorkflowStatus, MusicWorkflowTask } from "./autonomousTypes";

function mapRow(columns: string[], values: unknown[]): MusicWorkflowTask {
  const row: Record<string, unknown> = {}; columns.forEach((column, index) => { row[column] = values[index]; });
  return {
    taskId: String(row.task_id), projectId: String(row.project_id), conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    stage: String(row.stage) as MusicWorkflowStage, status: String(row.status) as MusicWorkflowStatus, progress: Number(row.progress || 0),
    currentStep: String(row.current_step || ""), retryCount: Number(row.retry_count || 0), checkpoint: row.checkpoint ? JSON.parse(String(row.checkpoint)) : {},
    providerJobId: row.provider_job_id ? String(row.provider_job_id) : undefined, error: row.error ? JSON.parse(String(row.error)) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class MusicWorkflowStore {
  async create(input: { projectId: string; conversationId?: string }): Promise<MusicWorkflowTask> {
    const bridge = await initSqlBridge(); if (!bridge?.db) throw new Error("Database not initialized");
    const task: MusicWorkflowTask = { taskId: `music-task-${crypto.randomUUID()}`, projectId: input.projectId, conversationId: input.conversationId, stage: "IDEA", status: "QUEUED", progress: 0, currentStep: "Queued", retryCount: 0, checkpoint: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const stmt = bridge.db.prepare("INSERT INTO music_workflow_tasks (task_id, project_id, conversation_id, stage, status, progress, current_step, retry_count, checkpoint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    stmt.run([task.taskId, task.projectId, task.conversationId || null, task.stage, task.status, task.progress, task.currentStep, task.retryCount, JSON.stringify(task.checkpoint), task.createdAt, task.updatedAt]); stmt.free?.(); bridge.persist(); return task;
  }
  async get(taskId: string): Promise<MusicWorkflowTask | null> { return this.query("SELECT * FROM music_workflow_tasks WHERE task_id = ?", [taskId]); }
  async getByProject(projectId: string): Promise<MusicWorkflowTask | null> { return this.query("SELECT * FROM music_workflow_tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1", [projectId]); }
  async update(taskId: string, patch: Partial<MusicWorkflowTask>): Promise<MusicWorkflowTask | null> {
    const current = await this.get(taskId); if (!current) return null; const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const bridge = await initSqlBridge(); if (!bridge?.db) throw new Error("Database not initialized");
    const stmt = bridge.db.prepare("UPDATE music_workflow_tasks SET stage = ?, status = ?, progress = ?, current_step = ?, retry_count = ?, checkpoint = ?, provider_job_id = ?, error = ?, updated_at = ? WHERE task_id = ?");
    stmt.run([next.stage, next.status, next.progress, next.currentStep, next.retryCount, JSON.stringify(next.checkpoint || {}), next.providerJobId || null, next.error ? JSON.stringify(next.error) : null, next.updatedAt, taskId]); stmt.free?.(); bridge.persist(); return next;
  }
  private async query(sql: string, params: unknown[]): Promise<MusicWorkflowTask | null> { const bridge = await initSqlBridge(); if (!bridge?.db) return null; const stmt = bridge.db.prepare(sql); stmt.bind(params); const row = stmt.step() ? stmt.getAsObject() : null; const columns = stmt.getColumnNames(); stmt.free?.(); return row ? mapRow(columns, columns.map((column) => (row as Record<string, unknown>)[column])) : null; }
}