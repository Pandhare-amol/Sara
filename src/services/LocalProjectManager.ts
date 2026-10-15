import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type GeneralProjectStatus = "active" | "on_hold" | "completed" | "archived";
export type GeneralTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type GeneralTaskPriority = "low" | "normal" | "high";

export interface GeneralProject {
  id: string;
  title: string;
  description: string;
  status: GeneralProjectStatus;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: GeneralTaskStatus;
  priority: GeneralTaskPriority;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralProjectSummary extends GeneralProject {
  taskCount: number;
  completedTaskCount: number;
}

export interface GeneralProjectDetail {
  project: GeneralProject;
  tasks: GeneralTask[];
}

interface ProjectDataFile {
  version: 1;
  projects: GeneralProject[];
  tasks: GeneralTask[];
}

const PROJECT_STATUSES = new Set<GeneralProjectStatus>(["active", "on_hold", "completed", "archived"]);
const TASK_STATUSES = new Set<GeneralTaskStatus>(["todo", "in_progress", "blocked", "done", "cancelled"]);
const TASK_PRIORITIES = new Set<GeneralTaskPriority>(["low", "normal", "high"]);

function cleanText(value: unknown, limit: number): string {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, limit);
}

function normalizeDueDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 64) throw new Error("dueDate must be a valid ISO date/time.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("dueDate must be a valid ISO date/time.");
  return parsed.toISOString();
}

function isValidStoredDueDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

function normalizeStatus<T extends string>(value: unknown, allowed: Set<T>, fallback: T, label: string): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

export class LocalProjectManager {
  constructor(private readonly storagePath: string) {}

  private read(): ProjectDataFile {
    let contents: string;
    try {
      contents = fs.readFileSync(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { version: 1, projects: [], tasks: [] };
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      // Never turn corruption into an empty store: the next successful write
      // would otherwise destroy the only recoverable copy of the user's data.
      throw new Error("Project data file contains invalid JSON; it was left unchanged.");
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Project data file must contain a JSON object; it was left unchanged.");
    }
    const record = raw as Record<string, unknown>;
    if (record.version !== undefined && record.version !== 1) {
      throw new Error("Project data file uses an unsupported version; it was left unchanged.");
    }
    if (!Array.isArray(record.projects) || !Array.isArray(record.tasks)) {
      throw new Error("Project data file is missing its project or task list; it was left unchanged.");
    }
    if (record.projects.length > 1000 || record.tasks.length > 20_000) {
      throw new Error("Project data file exceeds supported limits; it was left unchanged.");
    }

    const projects = record.projects as unknown[];
    const projectIds = new Set<string>();
    for (const item of projects) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Project data file contains an invalid project record; it was left unchanged.");
      }
      const project = item as Record<string, unknown>;
      if (typeof project.id !== "string" || !project.id || project.id.length > 100
        || typeof project.title !== "string" || !project.title
        || typeof project.description !== "string"
        || typeof project.status !== "string" || !PROJECT_STATUSES.has(project.status as GeneralProjectStatus)
        || typeof project.createdAt !== "string" || !Number.isFinite(Date.parse(project.createdAt))
        || typeof project.updatedAt !== "string" || !Number.isFinite(Date.parse(project.updatedAt))
        || !isValidStoredDueDate(project.dueDate)
        || projectIds.has(project.id)) {
        throw new Error("Project data file contains an invalid project record; it was left unchanged.");
      }
      projectIds.add(project.id);
    }

    const taskIds = new Set<string>();
    const tasks = record.tasks as unknown[];
    for (const item of tasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Project data file contains an invalid task record; it was left unchanged.");
      }
      const task = item as Record<string, unknown>;
      if (typeof task.id !== "string" || !task.id || task.id.length > 100
        || typeof task.projectId !== "string" || !projectIds.has(task.projectId)
        || typeof task.title !== "string" || !task.title
        || typeof task.description !== "string"
        || typeof task.status !== "string" || !TASK_STATUSES.has(task.status as GeneralTaskStatus)
        || typeof task.priority !== "string" || !TASK_PRIORITIES.has(task.priority as GeneralTaskPriority)
        || typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt))
        || typeof task.updatedAt !== "string" || !Number.isFinite(Date.parse(task.updatedAt))
        || !isValidStoredDueDate(task.dueDate)
        || taskIds.has(task.id)) {
        throw new Error("Project data file contains an invalid task record; it was left unchanged.");
      }
      taskIds.add(task.id);
    }

    return { version: 1, projects: projects as GeneralProject[], tasks: tasks as GeneralTask[] };
  }

  private write(data: ProjectDataFile): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(temporaryPath, 0o600); } catch { /* best-effort on Windows ACLs */ }
      fs.renameSync(temporaryPath, this.storagePath);
      try { fs.chmodSync(this.storagePath, 0o600); } catch { /* best-effort on Windows ACLs */ }
    } finally {
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    }
  }

  listProjects(options: { includeArchived?: boolean } = {}): GeneralProjectSummary[] {
    const data = this.read();
    return data.projects
      .filter((project) => options.includeArchived === true || project.status !== "archived")
      .map((project) => {
        const projectTasks = data.tasks.filter((task) => task.projectId === project.id);
        return {
          ...project,
          taskCount: projectTasks.length,
          completedTaskCount: projectTasks.filter((task) => task.status === "done").length,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getProject(projectId: unknown): GeneralProjectDetail | null {
    if (typeof projectId !== "string" || projectId.length > 100) return null;
    const data = this.read();
    const project = data.projects.find((item) => item.id === projectId);
    if (!project) return null;
    const tasks = data.tasks.filter((task) => task.projectId === project.id).sort((left, right) => {
      const priorityOrder: Record<GeneralTaskPriority, number> = { high: 0, normal: 1, low: 2 };
      return priorityOrder[left.priority] - priorityOrder[right.priority] || right.updatedAt.localeCompare(left.updatedAt);
    });
    return { project, tasks };
  }

  createProject(input: { title?: unknown; description?: unknown; dueDate?: unknown }): GeneralProject {
    const title = cleanText(input.title, 160);
    if (!title) throw new Error("Project title is required.");
    const data = this.read();
    if (data.projects.length >= 1000) throw new Error("The local project list is full.");
    const now = new Date().toISOString();
    const project: GeneralProject = {
      id: `project-${crypto.randomUUID()}`,
      title,
      description: cleanText(input.description, 2000),
      status: "active",
      dueDate: normalizeDueDate(input.dueDate),
      createdAt: now,
      updatedAt: now,
    };
    data.projects.push(project);
    this.write(data);
    return project;
  }

  updateProject(projectId: unknown, patch: { title?: unknown; description?: unknown; status?: unknown; dueDate?: unknown }): GeneralProject | null {
    if (typeof projectId !== "string" || projectId.length > 100) return null;
    const data = this.read();
    const project = data.projects.find((item) => item.id === projectId);
    if (!project) return null;
    if (patch.title !== undefined) {
      const title = cleanText(patch.title, 160);
      if (!title) throw new Error("Project title is required.");
      project.title = title;
    }
    if (patch.description !== undefined) project.description = cleanText(patch.description, 2000);
    if (patch.status !== undefined) project.status = normalizeStatus(patch.status, PROJECT_STATUSES, project.status, "Project status");
    if (patch.dueDate !== undefined) project.dueDate = normalizeDueDate(patch.dueDate);
    project.updatedAt = new Date().toISOString();
    this.write(data);
    return project;
  }

  createTask(input: { projectId?: unknown; title?: unknown; description?: unknown; status?: unknown; priority?: unknown; dueDate?: unknown }): GeneralTask {
    if (typeof input.projectId !== "string" || input.projectId.length > 100) throw new Error("A valid projectId is required.");
    const data = this.read();
    const project = data.projects.find((item) => item.id === input.projectId);
    if (!project) throw new Error("Project not found.");
    if (project.status === "archived" || project.status === "completed") throw new Error("Tasks cannot be added to a completed or archived project.");
    if (data.tasks.length >= 20_000) throw new Error("The local task list is full.");
    const title = cleanText(input.title, 200);
    if (!title) throw new Error("Task title is required.");
    const now = new Date().toISOString();
    const task: GeneralTask = {
      id: `task-${crypto.randomUUID()}`,
      projectId: project.id,
      title,
      description: cleanText(input.description, 4000),
      status: normalizeStatus(input.status, TASK_STATUSES, "todo", "Task status"),
      priority: normalizeStatus(input.priority, TASK_PRIORITIES, "normal", "Task priority"),
      dueDate: normalizeDueDate(input.dueDate),
      createdAt: now,
      updatedAt: now,
    };
    data.tasks.push(task);
    project.updatedAt = now;
    this.write(data);
    return task;
  }

  updateTask(taskId: unknown, patch: { title?: unknown; description?: unknown; status?: unknown; priority?: unknown; dueDate?: unknown }): GeneralTask | null {
    if (typeof taskId !== "string" || taskId.length > 100) return null;
    const data = this.read();
    const task = data.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    if (patch.title !== undefined) {
      const title = cleanText(patch.title, 200);
      if (!title) throw new Error("Task title is required.");
      task.title = title;
    }
    if (patch.description !== undefined) task.description = cleanText(patch.description, 4000);
    if (patch.status !== undefined) task.status = normalizeStatus(patch.status, TASK_STATUSES, task.status, "Task status");
    if (patch.priority !== undefined) task.priority = normalizeStatus(patch.priority, TASK_PRIORITIES, task.priority, "Task priority");
    if (patch.dueDate !== undefined) task.dueDate = normalizeDueDate(patch.dueDate);
    const now = new Date().toISOString();
    task.updatedAt = now;
    const project = data.projects.find((item) => item.id === task.projectId);
    if (project) project.updatedAt = now;
    this.write(data);
    return task;
  }
}
