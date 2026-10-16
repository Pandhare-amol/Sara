import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { dataFile } from "./server_paths";

let resolvedFilename = "";
try {
  resolvedFilename = __filename;
} catch {
  resolvedFilename = path.join(process.cwd(), "server_state.ts");
}
const resolvedDirname = path.dirname(resolvedFilename);
const __dirname = resolvedDirname;

export type ConversationRole = "user" | "assistant" | "system" | "agent" | "tool";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ConversationRole;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  activeContext?: Record<string, unknown>;
  taskState?: Record<string, unknown>;
  status?: "active" | "archived" | "deleted";
  userId?: string;
  lastMessageAt?: string | null;
  messages: ConversationMessage[];
}

export function normalizeConversationRecord(record?: Partial<ConversationRecord> & { conversationId?: string } | null): ConversationRecord {
  const now = new Date().toISOString();
  const legacyConversationId = (record as { conversationId?: string } | undefined)?.conversationId;
  const id = String(record?.id || legacyConversationId || "").trim() || `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const safeTitle = String(record?.title || "SARA Voice Conversation").trim() || "SARA Voice Conversation";
  return {
    ...record,
    id,
    title: safeTitle,
    createdAt: record?.createdAt || now,
    updatedAt: record?.updatedAt || now,
    summary: record?.summary || "",
    activeContext: record?.activeContext || {},
    taskState: record?.taskState || {},
    status: record?.status || "active",
    userId: record?.userId || "default-user",
    lastMessageAt: record?.lastMessageAt || null,
    // Desktop chat snapshots use `text`; the voice SQLite store uses
    // `content`. Keep both schemas readable without dropping either source.
    messages: Array.isArray(record?.messages) ? record.messages.map((message, index) => ({
      ...message,
      id: String(message?.id || `msg-${index}-${id}`),
      conversationId: id,
      content: typeof message?.content === "string" ? message.content : String((message as any)?.text || ""),
      timestamp: message?.timestamp || now,
    })) : [],
  };
}

export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting"
  | "paused"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "RECOVERING"
  | "awaiting_confirmation"
  | "partial"
  | "timed_out"
  | "blocked"
  | "succeeded";

export const FINAL_TASK_STATES = new Set<TaskStatus>([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "partial",
  "timed_out",
  "blocked",
]);

export function normalizeTaskStatus(status?: string | null): TaskStatus | undefined {
  const value = String(status || "").trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "succeeded") return "completed";
  if (normalized === "timedout") return "timed_out";
  if (normalized === "blocked") return "blocked";
  if (normalized === "partial") return "partial";
  if (normalized === "awaiting_confirmation") return "awaiting_confirmation";
  return (normalized as TaskStatus);
}

export function isFinalTaskState(status?: string | null): boolean {
  return FINAL_TASK_STATES.has(normalizeTaskStatus(status) as TaskStatus);
}

export interface TaskRecord {
  taskId: string;
  conversationId: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assignedAgent?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  checkpoint?: {
    current_goal?: string;
    current_task?: string;
    task_progress?: number;
    completed_steps?: string[];
    failed_steps?: string[];
    pending_steps?: string[];
    active_agents?: string[];
    last_action?: string;
    last_verified_result?: string;
    recent_summary?: string;
    [key: string]: unknown;
  } | null;
  result?: string;
  error?: string;
  retryCount: number;
  metadata?: Record<string, unknown>;
}

export type ConnectionStatus = "online" | "offline" | "reconnecting";

export interface SessionRecord {
  sessionId: string;
  conversationId: string;
  device: string;
  connectionStatus: ConnectionStatus;
  createdAt: string;
  lastSeen: string;
  lastMessageId?: string;
  lastTaskId?: string;
  reconnectAttempts: number;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  conversationId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  taskId?: string;
  timestamp: string;
}

const CONVERSATIONS_FILE = dataFile("conversations.json");
const TASKS_FILE = dataFile("tasks.json");
const SESSIONS_FILE = dataFile("sessions.json");
const TOOL_CALLS_FILE = dataFile("tool_calls.json");
const DB_FILE = dataFile("data.db");

let sqlInitPromise: Promise<{ SQL: any; db: any; persist: () => void } | null> | null = null;
const CURRENT_SCHEMA_VERSION = 1;
const MIGRATIONS: Record<number, string> = {};
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT, role TEXT, content TEXT, timestamp TEXT, metadata TEXT);
CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, conversationId TEXT, description TEXT, status TEXT, priority INTEGER, assignedAgent TEXT, createdAt TEXT, updatedAt TEXT, startedAt TEXT, completedAt TEXT, checkpoint TEXT, result TEXT, error TEXT, retryCount INTEGER, metadata TEXT);
-- Extended task fields for recovery and progress
CREATE TABLE IF NOT EXISTS task_steps (id TEXT PRIMARY KEY, taskId TEXT, step_index INTEGER, description TEXT, status TEXT, result TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tasks_extra (taskId TEXT PRIMARY KEY, current_step TEXT, progress INTEGER, verification TEXT);
CREATE TABLE IF NOT EXISTS sessions (sessionId TEXT PRIMARY KEY, conversationId TEXT, device TEXT, connectionStatus TEXT, createdAt TEXT, lastSeen TEXT, lastMessageId TEXT, lastTaskId TEXT, reconnectAttempts INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, sessionId TEXT, conversationId TEXT, toolName TEXT, args TEXT, result TEXT, error TEXT, taskId TEXT, timestamp TEXT);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, category TEXT, text TEXT, createdAt TEXT, updatedAt TEXT);

-- Audit and integrity provenance tables
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  previous_event_hash TEXT,
  event_hash TEXT,
  timestamp TEXT,
  session_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  event_type TEXT,
  status TEXT,
  duration_ms INTEGER,
  metadata TEXT,
  severity TEXT
);

CREATE TABLE IF NOT EXISTS build_integrity (
  id TEXT PRIMARY KEY,
  build_manifest TEXT,
  generated_at TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT,
  secret TEXT,
  created_at TEXT
);

-- Idempotency store for deduplication of outgoing messages and tool calls
CREATE TABLE IF NOT EXISTS idempotency (
  id TEXT PRIMARY KEY,
  toolName TEXT,
  args TEXT,
  result TEXT,
  status TEXT,
  created_at TEXT
);

-- Music Studio Tables
CREATE TABLE IF NOT EXISTS music_projects (
  project_id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT,
  concept TEXT,
  genre TEXT,
  mood TEXT,
  language TEXT,
  target_audience TEXT,
  lyrics TEXT,
  composition_metadata TEXT,
  bpm INTEGER,
  key TEXT,
  time_signature TEXT,
  vocal_configuration TEXT,
  instrument_configuration TEXT,
  production_status TEXT,
  quality_report TEXT,
  publishing_status TEXT,
  youtube_metadata TEXT,
  instagram_metadata TEXT,
  analytics_summary TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS music_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  asset_type TEXT,
  file_path TEXT,
  metadata TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS music_workflow_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT,
  provider_job_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export async function initSqlBridge() {
  if (sqlInitPromise) return sqlInitPromise;
  sqlInitPromise = (async () => {
    try {
      const initSqlJs = (await import("sql.js")).default ?? (await import("sql.js"));
      const locateFile = (file: string) => {
        const candidates = [
          path.join(__dirname, "node_modules", "sql.js", "dist", file),
          path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
          path.join(__dirname, "..", "node_modules", "sql.js", "dist", file),
        ];
        for (const c of candidates) {
          try { if (fsSync.existsSync(c)) return c; } catch {}
        }
        return file;
      };
      const SQL = await initSqlJs({ locateFile });
      let db: any;
      if (fsSync.existsSync(DB_FILE)) {
        const bin = fsSync.readFileSync(DB_FILE);
        db = new SQL.Database(new Uint8Array(bin));
      } else {
        db = new SQL.Database();
        db.run(SCHEMA_SQL);
        db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);");
        const stmtInit = db.prepare("INSERT INTO schema_version (version) VALUES (?)");
        stmtInit.run([CURRENT_SCHEMA_VERSION]);
        stmtInit.free && stmtInit.free();
        fsSync.writeFileSync(DB_FILE, Buffer.from(db.export()));
      }
      function persist() {
        const temp = `${DB_FILE}.${process.pid}.tmp`;
        try {
          fsSync.writeFileSync(temp, Buffer.from(db.export()), { mode: 0o600 });
          fsSync.renameSync(temp, DB_FILE);
        } finally {
          if (fsSync.existsSync(temp)) fsSync.unlinkSync(temp);
        }
      }
      db.run(SCHEMA_SQL);
      try {
        db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);");
        const verRes = db.exec("SELECT version FROM schema_version LIMIT 1;");
        let dbVersion = null as number | null;
        if (verRes && verRes[0] && verRes[0].values && verRes[0].values.length) dbVersion = Number(verRes[0].values[0][0]);
        if (!dbVersion) {
          const s = db.prepare("INSERT INTO schema_version (version) VALUES (?)");
          s.run([CURRENT_SCHEMA_VERSION]);
          s.free && s.free();
          dbVersion = CURRENT_SCHEMA_VERSION;
        }
        if (dbVersion < CURRENT_SCHEMA_VERSION) {
          for (let v = dbVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) if (MIGRATIONS[v]) db.run(MIGRATIONS[v]);
          const upd = db.prepare("UPDATE schema_version SET version = ?");
          upd.run([CURRENT_SCHEMA_VERSION]);
          upd.free && upd.free();
        }
      } catch {}
      return { SQL, db, persist };
    } catch {
      return null;
    }
  })();
  return sqlInitPromise;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(filePath, "utf-8")) as T; } catch (err: any) { if (err?.code === "ENOENT") return fallback; return fallback; }
}
async function writeJson(filePath: string, data: unknown): Promise<void> { await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8"); }
function createId(prefix = ""): string { return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

// A single process may receive voice writes while /api/chat writes the same
// conversation. Hold the lock over each read-modify-write, never over a model
// call. Independent server processes still need an external transaction lock.
let conversationWriteQueue: Promise<unknown> = Promise.resolve();
export function withConversationWriteLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const next = conversationWriteQueue.then(operation, operation);
  conversationWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

function readConversationSnapshot(): ConversationRecord[] | null {
  if (!fsSync.existsSync(CONVERSATIONS_FILE)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fsSync.readFileSync(CONVERSATIONS_FILE, "utf-8")); }
  catch { throw new Error("Conversation storage is unreadable; existing data was not overwritten."); }
  if (!Array.isArray(parsed)) throw new Error("Conversation storage is not a list; existing data was not overwritten.");
  return parsed.map((item) => normalizeConversationRecord(item));
}

/** The desktop JSON file contains text AND voice turns; SQL is a legacy voice index. */
export async function loadConversations(): Promise<ConversationRecord[]> {
  // JSON is authoritative when present, including an empty array after a
  // deletion. Do not resurrect removed conversations from the SQLite index.
  const snapshot = readConversationSnapshot();
  if (snapshot !== null) return snapshot;
  const bridge = await initSqlBridge();
  if (!bridge?.db) return [];
  try {
    const rows = bridge.db.exec("SELECT id,title,createdAt,updatedAt FROM conversations ORDER BY createdAt ASC;");
    return (rows?.[0]?.values || []).map((row: any[]) => {
      const [id, title, createdAt, updatedAt] = row;
      const stmt = bridge.db.prepare("SELECT id,role,content,timestamp,metadata FROM messages WHERE conversationId=? ORDER BY timestamp ASC");
      const messages: ConversationMessage[] = [];
      try {
        stmt.bind([id]);
        while (stmt.step()) {
          const data = stmt.getAsObject();
          let metadata: Record<string, unknown> | undefined;
          try { metadata = data.metadata ? JSON.parse(String(data.metadata)) : undefined; } catch { /* old metadata */ }
          messages.push({ id: String(data.id), conversationId: String(id), role: data.role as ConversationRole,
            content: String(data.content || ""), timestamp: String(data.timestamp), metadata });
        }
      } finally { stmt.free(); }
      return normalizeConversationRecord({ id: String(id), title: String(title), createdAt: String(createdAt),
        updatedAt: String(updatedAt), messages });
    });
  } catch { return []; }
}

async function saveConversationsUnlocked(conversations: ConversationRecord[]): Promise<void> {
  // Refuse to replace corrupt user data. Atomically replace this file so a
  // process crash cannot leave half of a JSON write behind.
  readConversationSnapshot();
  const normalized = conversations.map((item) => normalizeConversationRecord(item));
  const temp = `${CONVERSATIONS_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fsSync.writeFileSync(temp, JSON.stringify(normalized, null, 2), { encoding: "utf-8", mode: 0o600 });
    fsSync.renameSync(temp, CONVERSATIONS_FILE);
  } finally {
    try { if (fsSync.existsSync(temp)) fsSync.unlinkSync(temp); } catch { /* best-effort cleanup */ }
  }
  const bridge = await initSqlBridge();
  if (!bridge?.db) return;
  const db = bridge.db;
  db.run("BEGIN");
  try {
    const statement = db.prepare("INSERT OR REPLACE INTO conversations (id,title,createdAt,updatedAt) VALUES (?,?,?,?)");
    const messageStatement = db.prepare("INSERT OR REPLACE INTO messages (id,conversationId,role,content,timestamp,metadata) VALUES (?,?,?,?,?,?)");
    try {
      for (const c of normalized) {
        statement.run([c.id, c.title, c.createdAt, c.updatedAt]);
        for (const m of c.messages || []) messageStatement.run([m.id, c.id, m.role, m.content, m.timestamp, JSON.stringify(m.metadata || null)]);
      }
    } finally { statement.free(); messageStatement.free(); }
    db.run("COMMIT");
    bridge.persist();
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* persistence can fail after commit */ }
    throw error;
  }
}

export async function saveConversations(conversations: ConversationRecord[]): Promise<void> {
  return withConversationWriteLock(() => saveConversationsUnlocked(conversations));
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  const targetId = String(conversationId || "").trim();
  if (!targetId) return null;
  const conversations = await loadConversations();
  return conversations.find((item) => item.id === targetId) ?? null;
}

export async function getOrCreateConversation(conversationId?: string): Promise<ConversationRecord> {
  const targetId = String(conversationId || "").trim();
  return withConversationWriteLock(async () => {
    const conversations = await loadConversations();
    const existing = targetId ? conversations.find((item) => item.id === targetId) : undefined;
    if (existing) return existing;
    const id = targetId || createId("conv-");
    const timestamp = new Date().toISOString();
    const record = normalizeConversationRecord({
      id,
      title: "SARA Voice Conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
      summary: "Conversation started.",
      activeContext: { objective: "Continue the active project context" },
      taskState: { status: "new" },
      messages: [],
    });
    conversations.push(record);
    await saveConversationsUnlocked(conversations);
    return record;
  });
}

export async function appendConversationMessage(message: ConversationMessage): Promise<void> {
  const targetId = String(message.conversationId || "").trim();
  if (!targetId) return;
  await withConversationWriteLock(async () => {
    const conversations = await loadConversations();
    const conversation = conversations.find((item) => item.id === targetId) ?? normalizeConversationRecord({ id: targetId, title: "SARA Voice Conversation", createdAt: message.timestamp, updatedAt: message.timestamp, messages: [] });
    const exists = conversation.messages.some((entry) => entry.id === message.id || (entry.content === message.content && entry.timestamp === message.timestamp && entry.role === message.role));
    if (!exists) {
      conversation.messages.push(message);
      conversation.updatedAt = message.timestamp;
      conversation.lastMessageAt = message.timestamp;
    }
    const index = conversations.findIndex((item) => item.id === targetId);
    if (index >= 0) conversations[index] = conversation; else conversations.push(conversation);
    await saveConversationsUnlocked(conversations);
  });
}

export async function getRecentConversationMessages(conversationId: string, limit = 20): Promise<ConversationMessage[]> { const conversation = await getConversation(conversationId); if (!conversation) return []; return conversation.messages.slice(-limit); }
export async function loadTasks(): Promise<TaskRecord[]> { const bridge = await initSqlBridge(); if (bridge?.db) { try { const res = bridge.db.exec("SELECT taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata FROM tasks ORDER BY createdAt ASC;"); if (!res?.[0] || res[0].values.length === 0) return await readJson<TaskRecord[]>(TASKS_FILE, []); return res[0].values.map((r: any[]) => { const [taskId, conversationId, description, status, priority, assignedAgent, createdAt, updatedAt, startedAt, completedAt, checkpoint, result, error, retryCount, metadata] = r; let cp: Record<string, unknown> | null = null; let md: Record<string, unknown> | undefined = undefined; try { cp = checkpoint ? JSON.parse(checkpoint) : null; } catch {} try { md = metadata ? JSON.parse(metadata) : undefined; } catch {} return { taskId, conversationId, description, status: status as TaskStatus, priority: Number(priority || 0), assignedAgent: assignedAgent || undefined, createdAt, updatedAt, startedAt: startedAt || undefined, completedAt: completedAt || undefined, checkpoint: cp, result: result || undefined, error: error || undefined, retryCount: Number(retryCount || 0), metadata: md } as TaskRecord; }); } catch {} } return await readJson<TaskRecord[]>(TASKS_FILE, []); }
export async function saveTasks(tasks: TaskRecord[]): Promise<void> {
  const bridge = await initSqlBridge();
  if (bridge?.db) {
    const db = bridge.db;
    db.run("BEGIN TRANSACTION");
    try {
      // Deleting first prevents removed tasks from reappearing after restart.
      db.run("DELETE FROM tasks");
      const stmt = db.prepare("INSERT INTO tasks (taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      try {
        for (const t of tasks) {
          stmt.run([t.taskId, t.conversationId, t.description, t.status, t.priority, t.assignedAgent || null, t.createdAt, t.updatedAt, t.startedAt || null, t.completedAt || null, t.checkpoint ? JSON.stringify(t.checkpoint) : null, t.result || null, t.error || null, t.retryCount || 0, t.metadata ? JSON.stringify(t.metadata) : null]);
        }
      } finally { stmt.free(); }
      db.run("COMMIT");
      bridge.persist();
    } catch (error) {
      try { db.run("ROLLBACK"); } catch { /* Already committed, but persistence failed. */ }
      throw error;
    }
  }
  // SQLite is authoritative when available; JSON remains a portable snapshot.
  await writeJson(TASKS_FILE, tasks);
}

// Serialize legacy read-modify-write task mutations in this process. Multiple
// independent runners share data.db; without this lock, a workflow checkpoint
// can be overwritten by a concurrent task update.
let taskWriteQueue: Promise<unknown> = Promise.resolve();
function withTaskWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = taskWriteQueue.then(operation, operation);
  taskWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function createTask(data: { taskId?: string; conversationId: string; description: string; priority?: number; assignedAgent?: string; status?: TaskStatus; metadata?: Record<string, unknown>; }): Promise<TaskRecord> {
  return withTaskWriteLock(async () => {
    const tasks = await loadTasks();
    const timestamp = new Date().toISOString();
    const task: TaskRecord = {
      taskId: data.taskId || createId("task-"),
      conversationId: data.conversationId,
      description: data.description,
      status: data.status ?? "queued",
      priority: data.priority ?? 5,
      assignedAgent: data.assignedAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
      retryCount: 0,
      checkpoint: null,
      metadata: data.metadata,
    };
    tasks.push(task);
    await saveTasks(tasks);
    return task;
  });
}

export async function loadUnfinishedTasks(): Promise<TaskRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge?.db) {
    try {
      const res = bridge.db.exec("SELECT taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata FROM tasks WHERE status NOT IN ('completed','cancelled') ORDER BY createdAt ASC;");
      if (!res?.[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [taskId, conversationId, description, status, priority, assignedAgent, createdAt, updatedAt, startedAt, completedAt, checkpoint, result, error, retryCount, metadata] = r;
        let cp: Record<string, unknown> | null = null; let md: Record<string, unknown> | undefined = undefined;
        try { cp = checkpoint ? JSON.parse(checkpoint) : null; } catch {}
        try { md = metadata ? JSON.parse(metadata) : undefined; } catch {}
        return { taskId, conversationId, description, status: status as TaskStatus, priority: Number(priority || 0), assignedAgent: assignedAgent || undefined, createdAt, updatedAt, startedAt: startedAt || undefined, completedAt: completedAt || undefined, checkpoint: cp, result: result || undefined, error: error || undefined, retryCount: Number(retryCount || 0), metadata: md } as TaskRecord;
      });
    } catch {}
  }
  const tasks = await loadTasks();
  return tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
}

export async function updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null> {
  return withTaskWriteLock(async () => {
    const tasks = await loadTasks();
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) return null;

    const currentStatus = normalizeTaskStatus(task.status);
    const nextStatus = normalizeTaskStatus((patch as any).status ?? task.status);

    if (isFinalTaskState(currentStatus) && nextStatus && nextStatus !== currentStatus) {
      const safePatch = { ...patch };
      delete (safePatch as any).status;
      Object.assign(task, safePatch);
      task.updatedAt = new Date().toISOString();
      await saveTasks(tasks);
      return task;
    }

    if (patch.status) {
      (task as any).status = nextStatus ?? task.status;
    }
    Object.assign(task, patch);

    if ((patch as any).status) {
      task.status = nextStatus ?? task.status;
    }

    task.updatedAt = new Date().toISOString();
    await saveTasks(tasks);
    return task;
  });
}

export async function saveTaskCheckpoint(taskId: string, checkpoint: TaskRecord['checkpoint']): Promise<void> {
  return withTaskWriteLock(async () => {
    const tasks = await loadTasks();
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    task.checkpoint = { ...(task.checkpoint || {}), ...(checkpoint || {}) };
    task.updatedAt = new Date().toISOString();
    await saveTasks(tasks);
  });
}

export async function deleteTask(taskId: string): Promise<boolean> { return withTaskWriteLock(async () => { const tasks = await loadTasks(); const next = tasks.filter((item) => item.taskId !== taskId); if (next.length === tasks.length) return false; await saveTasks(next); return true; }); }

export async function loadSessions(): Promise<SessionRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge?.db) {
    try {
      const res = bridge.db.exec("SELECT sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts FROM sessions ORDER BY lastSeen ASC;");
      if (!res?.[0]) return [];
      return res[0].values.map((r: any[]) => ({
        sessionId: r[0],
        conversationId: r[1],
        device: r[2],
        connectionStatus: r[3],
        createdAt: r[4],
        lastSeen: r[5],
        lastMessageId: r[6] || undefined,
        lastTaskId: r[7] || undefined,
        reconnectAttempts: Number(r[8] || 0),
      } as SessionRecord));
    } catch {}
  }
  return await readJson<SessionRecord[]>(SESSIONS_FILE, []);
}

export async function saveSessions(sessions: SessionRecord[]): Promise<void> {
  await writeJson(SESSIONS_FILE, sessions);
  const bridge = await initSqlBridge();
  if (!bridge?.db) return;
  try {
    const db = bridge.db;
    db.run("BEGIN");
    for (const s of sessions) {
      const stmt = db.prepare("INSERT OR REPLACE INTO sessions (sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts) VALUES (?,?,?,?,?,?,?,?,?)");
      stmt.run([s.sessionId, s.conversationId, s.device || null, s.connectionStatus || null, s.createdAt || new Date().toISOString(), s.lastSeen || new Date().toISOString(), s.lastMessageId || null, s.lastTaskId || null, s.reconnectAttempts || 0]);
    }
    db.run("COMMIT");
    bridge.persist();
  } catch {}
}

export async function upsertSession(session: SessionRecord): Promise<void> {
  const sessions = await loadSessions();
  const existing = sessions.find((item) => item.sessionId === session.sessionId);
  if (existing) Object.assign(existing, session);
  else sessions.push(session);
  await saveSessions(sessions);
  try {
    await appendAuditEvent({ event_type: existing ? 'SESSION_UPDATED' : 'SESSION_CREATED', session_id: session.sessionId, metadata: { conversationId: session.conversationId, device: session.device, connectionStatus: session.connectionStatus } });
  } catch {}
}

export async function getLastSession(conversationId: string): Promise<SessionRecord | null> {
  const sessions = await loadSessions();
  const matches = sessions.filter((s) => s.conversationId === conversationId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  return matches[0] ?? null;
}

export async function getSessionRecoveryContext(conversationId: string): Promise<{
  session: SessionRecord | null;
  lastTaskId?: string;
  task?: TaskRecord | null;
} | null> {
  const sessions = await loadSessions();
  const matches = sessions.filter((s) => s.conversationId === conversationId);
  matches.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  const session = matches[0] ?? null;
  const tasks = await loadTasks();
  const unfinished = tasks
    .filter((task) => task.conversationId === conversationId && !FINAL_TASK_STATES.has(normalizeTaskStatus(task.status) as TaskStatus))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const lastTask = unfinished[0] ?? null;
  const sessionTask = session?.lastTaskId && tasks.some((task) => task.taskId === session.lastTaskId)
    ? tasks.find((task) => task.taskId === session.lastTaskId) ?? null
    : null;
  const preferredTask = lastTask
    ? (sessionTask && sessionTask.taskId === lastTask.taskId ? sessionTask : lastTask)
    : sessionTask;
  const lastTaskId = preferredTask?.taskId ?? session?.lastTaskId ?? undefined;

  if (!session && !lastTask && !sessionTask && !lastTaskId) {
    return null;
  }

  return {
    session,
    lastTaskId,
    task: lastTaskId ? tasks.find((task) => task.taskId === lastTaskId) ?? null : null,
  };
}

export async function getConversationTaskContext(conversationId: string): Promise<{
  conversationId: string;
  summary: string;
  activeContext: Record<string, unknown>;
  taskState: Record<string, unknown>;
  taskId?: string;
  status?: string;
  description?: string;
  lastUpdatedAt?: string;
} | null> {
  const conversation = await getConversation(conversationId);
  if (!conversation) return null;
  const recovery = await getSessionRecoveryContext(conversationId);
  const task = recovery?.task ?? null;
  const activeContext = conversation.activeContext && Object.keys(conversation.activeContext).length > 0 ? conversation.activeContext : {};
  const taskState = {
    ...(conversation.taskState || {}),
    ...(task ? {
      taskId: task.taskId,
      status: task.status,
      description: task.description,
      updatedAt: task.updatedAt,
      checkpoint: task.checkpoint || undefined,
    } : {}),
    lastUpdatedAt: task?.updatedAt || conversation.updatedAt,
  };

  return {
    conversationId: conversation.id,
    summary: conversation.summary || conversation.title || "Continue the previous conversation context.",
    activeContext,
    taskState,
    taskId: task?.taskId,
    status: task?.status || conversation.status || "active",
    description: task?.description || conversation.title,
    lastUpdatedAt: task?.updatedAt || conversation.updatedAt,
  };
}

export async function loadToolCalls(): Promise<ToolCallRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge?.db) {
    try {
      const res = bridge.db.exec("SELECT id,sessionId,conversationId,toolName,args,result,error,taskId,timestamp FROM tool_calls ORDER BY timestamp ASC;");
      if (!res?.[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [id, sessionId, conversationId, toolName, args, result, error, taskId, timestamp] = r;
        let a: Record<string, unknown> = {};
        try { a = args ? JSON.parse(args) : {}; } catch {}
        let resv: any = result;
        try { resv = result ? JSON.parse(result) : result; } catch {}
        return { id, sessionId, conversationId, toolName, args: a, result: resv, error: error || undefined, taskId: taskId || undefined, timestamp } as ToolCallRecord;
      });
    } catch {}
  }
  return await readJson<ToolCallRecord[]>(TOOL_CALLS_FILE, []);
}

export async function appendToolCall(call: ToolCallRecord): Promise<void> {
  const calls = await loadToolCalls();
  calls.push(call);
  await writeJson(TOOL_CALLS_FILE, calls);
  const bridge = await initSqlBridge();
  if (bridge?.db) {
    try {
      const db = bridge.db;
      const stmt = db.prepare("INSERT OR REPLACE INTO tool_calls (id,sessionId,conversationId,toolName,args,result,error,taskId,timestamp) VALUES (?,?,?,?,?,?,?,?,?)");
      stmt.run([call.id, call.sessionId, call.conversationId, call.toolName, JSON.stringify(call.args || {}), JSON.stringify(call.result || null), call.error || null, call.taskId || null, call.timestamp]);
      bridge.persist();
    } catch {}
  }
  try {
    // Emit audit event for tool call
    await appendAuditEvent({ event_type: 'TOOL_CALL', session_id: call.sessionId, task_id: call.taskId, agent_id: undefined, metadata: { tool: call.toolName, args: call.args, result: call.result, error: call.error }, timestamp: call.timestamp });
  } catch {}
}

export interface AuditEventRecord {
  event_id: string;
  previous_event_hash?: string | null;
  event_hash: string;
  timestamp: string;
  session_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  event_type: string;
  status?: string | null;
  duration_ms?: number | null;
  metadata?: Record<string, unknown> | null;
  severity?: string | null;
}

export async function appendAuditEvent(event: Omit<Partial<AuditEventRecord>, 'event_id'|'event_hash'|'timestamp'> & { event_type: string, timestamp?: string }): Promise<AuditEventRecord> {
  const now = event.timestamp || new Date().toISOString();
  const id = createId('audit-');
  const prevHash = null; // we'll attempt to load last event hash from DB
  const bridge = await initSqlBridge();
  let lastHash: string | null = null;
  try {
    if (bridge?.db) {
      const res = bridge.db.exec("SELECT event_hash FROM audit_events ORDER BY timestamp DESC LIMIT 1;");
      if (res?.[0] && res[0].values && res[0].values.length) lastHash = res[0].values[0][0];
    }
  } catch {}

  const payload: AuditEventRecord = {
    event_id: id,
    previous_event_hash: lastHash || null,
    event_hash: '',
    timestamp: now,
    session_id: event.session_id || null,
    task_id: event.task_id || null,
    agent_id: event.agent_id || null,
    event_type: event.event_type,
    status: event.status || null,
    duration_ms: event.duration_ms ?? null,
    metadata: event.metadata ?? null,
    severity: event.severity || null,
  };
  const toHash = JSON.stringify({ event_id: payload.event_id, previous_event_hash: payload.previous_event_hash, timestamp: payload.timestamp, event_type: payload.event_type, metadata: payload.metadata || {} });
  payload.event_hash = crypto.createHash('sha256').update(toHash, 'utf8').digest('hex');

  // Persist to DB if available, else fall back to append file in data/logs
  try {
    if (bridge?.db) {
      const db = bridge.db;
      const stmt = db.prepare("INSERT OR REPLACE INTO audit_events (event_id,previous_event_hash,event_hash,timestamp,session_id,task_id,agent_id,event_type,status,duration_ms,metadata,severity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      stmt.run([payload.event_id, payload.previous_event_hash, payload.event_hash, payload.timestamp, payload.session_id, payload.task_id, payload.agent_id, payload.event_type, payload.status, payload.duration_ms, payload.metadata ? JSON.stringify(payload.metadata) : null, payload.severity]);
      stmt.free && stmt.free();
      bridge.persist();
      return payload;
    }
  } catch (e) {
    // fall back
  }

  // Fallback: append to logs/sara_audit_log.json (array)
  try {
    const f = dataFile('logs/sara_audit_log.json');
    let arr: any[] = [];
    try { arr = JSON.parse(fsSync.readFileSync(f, 'utf8')); } catch {}
    arr.push(payload);
    try { fsSync.mkdirSync(path.dirname(f), { recursive: true }); } catch {}
    fsSync.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
  } catch {}
  return payload;
}

export async function loadRecentAuditEvents(limit = 200): Promise<AuditEventRecord[]> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const res = bridge.db.exec(`SELECT event_id,previous_event_hash,event_hash,timestamp,session_id,task_id,agent_id,event_type,status,duration_ms,metadata,severity FROM audit_events ORDER BY timestamp DESC LIMIT ${limit};`);
      if (!res?.[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [event_id, previous_event_hash, event_hash, timestamp, session_id, task_id, agent_id, event_type, status, duration_ms, metadata, severity] = r;
        let md: any = null;
        try { md = metadata ? JSON.parse(metadata) : null; } catch {}
        return { event_id, previous_event_hash, event_hash, timestamp, session_id, task_id, agent_id, event_type, status, duration_ms, metadata: md, severity } as AuditEventRecord;
      });
    }
  } catch {}
  // fallback to logs
  try {
    const f = dataFile('logs/sara_audit_log.json');
    const arr = JSON.parse(fsSync.readFileSync(f, 'utf8')) as AuditEventRecord[];
    return (arr || []).slice(-limit).reverse();
  } catch {}
  return [];
}

// Idempotency helpers
export interface IdempotencyRecord {
  id: string;
  toolName?: string | null;
  args?: Record<string, unknown> | null;
  result?: unknown;
  status?: string | null;
  created_at?: string | null;
}

export async function getIdempotencyEntry(id: string): Promise<IdempotencyRecord | null> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const statement = bridge.db.prepare("SELECT id,toolName,args,result,status,created_at FROM idempotency WHERE id = ? LIMIT 1;");
      try {
        statement.bind([id]);
        if (!statement.step()) return null;
        const row = statement.getAsObject() as Record<string, any>;
        let args: Record<string, unknown> | null = null;
        let result: any = null;
        try { args = row.args ? JSON.parse(String(row.args)) : null; } catch {}
        try { result = row.result ? JSON.parse(String(row.result)) : row.result; } catch { result = row.result; }
        return {
          id: String(row.id),
          toolName: row.toolName || null,
          args,
          result,
          status: row.status || null,
          created_at: row.created_at || null,
        };
      } finally {
        statement.free();
      }
    }
  } catch {}
  // fallback: file based idempotency store
  try {
    const f = dataFile('idempotency.json');
    const arr = JSON.parse(await fs.readFile(f, 'utf8')) as IdempotencyRecord[];
    const found = arr.find((x) => x.id === id);
    return found || null;
  } catch {}
  return null;
}

export async function upsertIdempotencyEntry(entry: IdempotencyRecord): Promise<void> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const db = bridge.db;
      const stmt = db.prepare("INSERT OR REPLACE INTO idempotency (id,toolName,args,result,status,created_at) VALUES (?,?,?,?,?,?)");
      stmt.run([entry.id, entry.toolName || null, entry.args ? JSON.stringify(entry.args) : null, entry.result ? JSON.stringify(entry.result) : null, entry.status || null, entry.created_at || new Date().toISOString()]);
      stmt.free && stmt.free();
      bridge.persist();
      return;
    }
  } catch (e) {}
  // fallback: append to file
  try {
    const f = dataFile('idempotency.json');
    let arr: IdempotencyRecord[] = [];
    try { arr = JSON.parse(await fs.readFile(f, 'utf8')) as IdempotencyRecord[]; } catch {}
    const idx = arr.findIndex(x => x.id === entry.id);
    if (idx >= 0) arr[idx] = entry; else arr.push(entry);
    try { await fs.writeFile(f, JSON.stringify(arr, null, 2), 'utf8'); } catch {}
  } catch {}
}

export async function saveBuildManifest(manifest: Record<string, unknown>): Promise<void> {
  const bridge = await initSqlBridge();
  try {
    if (!bridge?.db) return;
    const db = bridge.db;
    const id = createId('build-');
    const stmt = db.prepare("INSERT OR REPLACE INTO build_integrity (id, build_manifest, generated_at) VALUES (?,?,?)");
    stmt.run([id, JSON.stringify(manifest), new Date().toISOString()]);
    stmt.free && stmt.free();
    bridge.persist();
  } catch (e) {
    // ignore
  }
}

export interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  secret?: string | null;
  created_at: string;
}

export async function listWebhooks(): Promise<WebhookRecord[]> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const res = bridge.db.exec("SELECT id,url,events,secret,created_at FROM webhooks ORDER BY created_at DESC;");
      if (!res?.[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [id, url, events, secret, created_at] = r;
        let ev: string[] = [];
        try { ev = events ? JSON.parse(events) : []; } catch { ev = typeof events === 'string' ? events.split(',').map((s:string)=>s.trim()) : []; }
        return { id, url, events: ev, secret: secret || null, created_at } as WebhookRecord;
      });
    }
  } catch {}
  // fallback: read from settings.json
  try {
    const s = JSON.parse(await fs.readFile(dataFile('settings.json'), 'utf8'));
    return (s.webhooks || []).map((w: any) => ({ id: w.id, url: w.url, events: w.events || ['*'], secret: w.secret || null, created_at: w.created_at || new Date().toISOString() }));
  } catch {}
  return [];
}

export async function createWebhook(opts: { url: string; events?: string[]; secret?: string | null }): Promise<WebhookRecord> {
  const bridge = await initSqlBridge();
  const id = 'wh-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
  const created_at = new Date().toISOString();
  const rec: WebhookRecord = { id, url: opts.url, events: opts.events || ['*'], secret: opts.secret || null, created_at };
  try {
    if (bridge?.db) {
      const stmt = bridge.db.prepare("INSERT INTO webhooks (id,url,events,secret,created_at) VALUES (?,?,?,?,?)");
      stmt.run([rec.id, rec.url, JSON.stringify(rec.events), rec.secret || null, rec.created_at]);
      stmt.free && stmt.free();
      bridge.persist();
      return rec;
    }
  } catch {}
  // fallback: append to settings
  try {
    const settingsPath = dataFile('settings.json');
    let s = {} as any;
    try { s = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch {}
    s.webhooks = s.webhooks || [];
    s.webhooks.push(rec);
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
  return rec;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const stmt = bridge.db.prepare("DELETE FROM webhooks WHERE id = ?");
      stmt.run([id]);
      stmt.free && stmt.free();
      bridge.persist();
      return true;
    }
  } catch {}
  // fallback: remove from settings
  try {
    const settingsPath = dataFile('settings.json');
    let s = {} as any;
    try { s = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch {}
    s.webhooks = (s.webhooks || []).filter((w: any) => w.id !== id);
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');
    return true;
  } catch {}
  return false;
}

export async function getWebhook(id: string): Promise<WebhookRecord | null> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const res = bridge.db.exec("SELECT id,url,events,secret,created_at FROM webhooks WHERE id = ? LIMIT 1;", [id]);
      if (res?.[0] && res[0].values && res[0].values.length) {
        const [rid, url, events, secret, created_at] = res[0].values[0];
        let ev: string[] = [];
        try { ev = events ? JSON.parse(events) : []; } catch { ev = typeof events === 'string' ? events.split(',').map((s:string)=>s.trim()) : []; }
        return { id: rid, url, events: ev, secret: secret || null, created_at } as WebhookRecord;
      }
    }
  } catch {}
  // fallback: settings
  try { const s = JSON.parse(await fs.readFile(dataFile('settings.json'), 'utf8')); const w = (s.webhooks||[]).find((x:any)=>x.id===id); return w? { id: w.id, url: w.url, events: w.events||['*'], secret: w.secret||null, created_at: w.created_at||new Date().toISOString() } : null; } catch {}
  return null;
}

export async function updateWebhook(id: string, patch: { url?: string; events?: string[]; secret?: string | null }): Promise<WebhookRecord | null> {
  const bridge = await initSqlBridge();
  try {
    if (bridge?.db) {
      const existing = await getWebhook(id);
      if (!existing) return null;
      const url = patch.url ?? existing.url;
      const events = patch.events ?? existing.events;
      const secret = patch.secret ?? existing.secret ?? null;
      const stmt = bridge.db.prepare("UPDATE webhooks SET url = ?, events = ?, secret = ? WHERE id = ?");
      stmt.run([url, JSON.stringify(events), secret, id]);
      stmt.free && stmt.free();
      bridge.persist();
      return { id, url, events, secret, created_at: existing.created_at } as WebhookRecord;
    }
  } catch {}
  // fallback: update settings.json
  try {
    const settingsPath = dataFile('settings.json');
    let s: any = {};
    try { s = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch {}
    s.webhooks = s.webhooks || [];
    const idx = s.webhooks.findIndex((w: any) => w.id === id);
    if (idx === -1) return null;
    const existing = s.webhooks[idx];
    existing.url = patch.url ?? existing.url;
    existing.events = patch.events ?? existing.events;
    existing.secret = patch.secret ?? existing.secret ?? null;
    s.webhooks[idx] = existing;
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');
    return { id: existing.id, url: existing.url, events: existing.events || ['*'], secret: existing.secret || null, created_at: existing.created_at || new Date().toISOString() } as WebhookRecord;
  } catch {}
  return null;
}

export async function migrateWebhooksFromSettingsIfNeeded(): Promise<void> {
  const bridge = await initSqlBridge();
  if (!bridge?.db) return;
  try {
    const existing = bridge.db.exec("SELECT COUNT(1) FROM webhooks;");
    let count = 0;
    if (existing && existing[0] && existing[0].values && existing[0].values[0]) count = Number(existing[0].values[0][0]);
    if (count > 0) return; // already populated
  } catch {}
  try {
    const settingsPath = dataFile('settings.json');
    let s: any = {};
    try { s = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch {}
    const whs = s.webhooks || [];
    for (const w of whs) {
      try {
        const id = w.id || ('wh-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
        const stmt = bridge.db.prepare("INSERT OR REPLACE INTO webhooks (id,url,events,secret,created_at) VALUES (?,?,?,?,?)");
        stmt.run([id, w.url, JSON.stringify(w.events || ['*']), w.secret || null, w.created_at || new Date().toISOString()]);
        stmt.free && stmt.free();
      } catch {}
    }
    bridge.persist();
  } catch {}
}

export function newMessageId(): string { return createId("msg-"); }
export function newToolCallId(): string { return createId("tool-"); }
export function newSessionId(): string { return createId("sess-"); }
