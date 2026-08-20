import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dataFile } from "./server_paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  messages: ConversationMessage[];
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
  | "cancelled";

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
  checkpoint?: Record<string, unknown> | null;
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

// Lazy SQL.js bridge. If `data.db` exists we will attempt to load it and
// use it as the authoritative store. If loading fails, we gracefully fall
// back to the existing JSON file-based store.
let sqlInitPromise: Promise<{ SQL: any; db: any; persist: () => void } | null> | null = null;
const CURRENT_SCHEMA_VERSION = 1;

// Named migrations to be applied when upgrading from older schema versions.
const MIGRATIONS: Record<number, string> = {
  // future migrations go here, keyed by the version they apply to
  // e.g. 2: `ALTER TABLE messages ADD COLUMN newColumn TEXT;`
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT, role TEXT, content TEXT, timestamp TEXT, metadata TEXT);
CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, conversationId TEXT, description TEXT, status TEXT, priority INTEGER, assignedAgent TEXT, createdAt TEXT, updatedAt TEXT, startedAt TEXT, completedAt TEXT, checkpoint TEXT, result TEXT, error TEXT, retryCount INTEGER, metadata TEXT);
CREATE TABLE IF NOT EXISTS sessions (sessionId TEXT PRIMARY KEY, conversationId TEXT, device TEXT, connectionStatus TEXT, createdAt TEXT, lastSeen TEXT, lastMessageId TEXT, lastTaskId TEXT, reconnectAttempts INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, sessionId TEXT, conversationId TEXT, toolName TEXT, args TEXT, result TEXT, error TEXT, taskId TEXT, timestamp TEXT);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, category TEXT, text TEXT, createdAt TEXT, updatedAt TEXT);
`;

async function initSqlBridge() {
  if (sqlInitPromise) return sqlInitPromise;
  sqlInitPromise = (async () => {
    try {
      // dynamic import so environments without sql.js still run
      const initSqlJs = (await import('sql.js')).default ?? (await import('sql.js'));
      const locateFile = (file: string) => {
        const candidates = [
          path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
          path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
          path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
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
        // initialize schema version marker
        db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);');
        const stmtInit = db.prepare('INSERT INTO schema_version (version) VALUES (?)');
        stmtInit.run([CURRENT_SCHEMA_VERSION]);
        stmtInit.free && stmtInit.free();
        fsSync.writeFileSync(DB_FILE, Buffer.from(db.export()));
      }

      function persist() {
        try {
          fsSync.writeFileSync(DB_FILE, Buffer.from(db.export()));
        } catch (e) {
          console.warn('Failed to persist data.db:', e?.message || e);
        }
      }

      // Ensure schema exists
      db.run(SCHEMA_SQL);
      // Ensure schema_version table exists and apply migrations if needed
      try {
        db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);');
        const verRes = db.exec('SELECT version FROM schema_version LIMIT 1;');
        let dbVersion = null as number | null;
        if (verRes && verRes[0] && verRes[0].values && verRes[0].values.length) {
          dbVersion = Number(verRes[0].values[0][0]);
        }
        if (!dbVersion) {
          const s = db.prepare('INSERT INTO schema_version (version) VALUES (?)');
          s.run([CURRENT_SCHEMA_VERSION]);
          s.free && s.free();
          dbVersion = CURRENT_SCHEMA_VERSION;
        }

        if (dbVersion < CURRENT_SCHEMA_VERSION) {
          for (let v = dbVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
            const mig = MIGRATIONS[v];
            if (mig) {
              db.run(mig);
            }
          }
          const upd = db.prepare('UPDATE schema_version SET version = ?');
          upd.run([CURRENT_SCHEMA_VERSION]);
          upd.free && upd.free();
        }
      } catch (e) {
        console.warn('Schema version detection/migration failed:', e?.message || e);
      }
      return { SQL, db, persist };
    } catch (e) {
      console.warn('sql.js init failed, falling back to JSON store:', e?.message || e);
      return null;
    }
  })();
  return sqlInitPromise;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return fallback;
    }
    console.error(`[Persistence] Error reading ${filePath}:`, err?.message || err);
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`[Persistence] Error writing ${filePath}:`, err?.message || err);
  }
}

function createId(prefix = ""): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadConversations(): Promise<ConversationRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec("SELECT id,title,createdAt,updatedAt FROM conversations ORDER BY createdAt ASC;");
      if (!res || !res[0]) return [];
      const vals = res[0].values;
      const convs: ConversationRecord[] = [];
      for (const row of vals) {
        const [id, title, createdAt, updatedAt] = row;
        // Load messages for conversation
        const mres = bridge.db.exec(`SELECT id,role,content,timestamp,metadata FROM messages WHERE conversationId='${id}' ORDER BY timestamp ASC;`);
        const msgs: ConversationMessage[] = [];
        if (mres && mres[0]) {
          for (const mrow of mres[0].values) {
            const [mid, role, content, timestamp, metadata] = mrow;
            let meta = null;
            try { meta = metadata ? JSON.parse(metadata) : null; } catch {}
            msgs.push({ id: mid, conversationId: id, role: role as ConversationRole, content, timestamp, metadata: meta });
          }
        }
        convs.push({ id, title, createdAt, updatedAt, messages: msgs });
      }
      return convs;
    } catch (e) {
      console.warn('DB loadConversations failed, falling back to JSON:', e?.message || e);
      return await readJson<ConversationRecord[]>(CONVERSATIONS_FILE, []);
    }
  }
  return await readJson<ConversationRecord[]>(CONVERSATIONS_FILE, []);
}

export async function saveConversations(conversations: ConversationRecord[]): Promise<void> {
  await writeJson(CONVERSATIONS_FILE, conversations);
  const bridge = await initSqlBridge();
  if (!bridge || !bridge.db) return;
  try {
    const db = bridge.db;
    db.run('BEGIN');
    for (const c of conversations) {
      const stmt = db.prepare('INSERT OR REPLACE INTO conversations (id,title,createdAt,updatedAt) VALUES (?,?,?,?)');
      stmt.run([c.id, c.title, c.createdAt, c.updatedAt]);
      for (const m of c.messages || []) {
        const mstmt = db.prepare('INSERT OR REPLACE INTO messages (id,conversationId,role,content,timestamp,metadata) VALUES (?,?,?,?,?,?)');
        mstmt.run([m.id, c.id, m.role, m.content, m.timestamp, JSON.stringify(m.metadata || null)]);
      }
    }
    db.run('COMMIT');
    bridge.persist();
  } catch (e) {
    console.warn('DB saveConversations failed:', e?.message || e);
  }
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const db = bridge.db;
      const cres = db.exec(`SELECT id,title,createdAt,updatedAt FROM conversations WHERE id='${conversationId}' LIMIT 1;`);
      if (!cres || !cres[0] || !cres[0].values.length) return null;
      const [id, title, createdAt, updatedAt] = cres[0].values[0];
      const mres = db.exec(`SELECT id,role,content,timestamp,metadata FROM messages WHERE conversationId='${id}' ORDER BY timestamp ASC;`);
      const msgs: ConversationMessage[] = [];
      if (mres && mres[0]) {
        for (const mrow of mres[0].values) {
          const [mid, role, content, timestamp, metadata] = mrow;
          let meta = null;
          try { meta = metadata ? JSON.parse(metadata) : null; } catch {}
          msgs.push({ id: mid, conversationId: id, role: role as ConversationRole, content, timestamp, metadata: meta });
        }
      }
      return { id, title, createdAt, updatedAt, messages: msgs };
    } catch (e) {
      return (await loadConversations()).find((item) => item.id === conversationId) ?? null;
    }
  }
  const conversations = await loadConversations();
  return conversations.find((item) => item.id === conversationId) ?? null;
}

export async function getOrCreateConversation(conversationId?: string): Promise<ConversationRecord> {
  // First try DB
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    const db = bridge.db;
    if (conversationId) {
      const c = await getConversation(conversationId);
      if (c) return c;
    }
    const id = conversationId || createId("conv-");
    const timestamp = new Date().toISOString();
    try {
      const stmt = db.prepare('INSERT OR REPLACE INTO conversations (id,title,createdAt,updatedAt) VALUES (?,?,?,?)');
      stmt.run([id, 'SARA Voice Conversation', timestamp, timestamp]);
      bridge.persist();
      return { id, title: 'SARA Voice Conversation', createdAt: timestamp, updatedAt: timestamp, messages: [] };
    } catch (e) {
      console.warn('DB getOrCreateConversation failed:', e?.message || e);
    }
  }
  const conversations = await loadConversations();
  if (conversationId) {
    const existing = conversations.find((item) => item.id === conversationId);
    if (existing) return existing;
  }
  const id = conversationId || createId("conv-");
  const timestamp = new Date().toISOString();
  const record: ConversationRecord = {
    id,
    title: "SARA Voice Conversation",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  };
  conversations.push(record);
  await saveConversations(conversations);
  return record;
}

export async function appendConversationMessage(message: ConversationMessage): Promise<void> {
  const conversations = await loadConversations();
  const conversation = conversations.find((item) => item.id === message.conversationId);
  if (!conversation) {
    const record: ConversationRecord = {
      id: message.conversationId,
      title: "SARA Voice Conversation",
      createdAt: message.timestamp,
      updatedAt: message.timestamp,
      messages: [message],
    };
    conversations.push(record);
  } else {
    conversation.messages.push(message);
    conversation.updatedAt = message.timestamp;
  }
  await saveConversations(conversations);

  // Also persist to DB when available
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const db = bridge.db;
      const mstmt = db.prepare('INSERT OR REPLACE INTO messages (id,conversationId,role,content,timestamp,metadata) VALUES (?,?,?,?,?,?)');
      mstmt.run([message.id, message.conversationId, message.role, message.content, message.timestamp, JSON.stringify(message.metadata || null)]);
      const ustmt = db.prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?');
      ustmt.run([message.timestamp, message.conversationId]);
      bridge.persist();
    } catch (e) {
      console.warn('DB appendConversationMessage failed:', e?.message || e);
    }
  }
}

export async function getRecentConversationMessages(conversationId: string, limit = 20): Promise<ConversationMessage[]> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec(`SELECT id,role,content,timestamp,metadata FROM messages WHERE conversationId='${conversationId}' ORDER BY timestamp DESC LIMIT ${limit};`);
      if (!res || !res[0]) return [];
      const rows = res[0].values;
      const msgs: ConversationMessage[] = [];
      for (const r of rows) {
        const [id, role, content, timestamp, metadata] = r;
        let meta = null;
        try { meta = metadata ? JSON.parse(metadata) : null; } catch {}
        msgs.push({ id, conversationId, role: role as ConversationRole, content, timestamp, metadata: meta });
      }
      return msgs.reverse();
    } catch (e) {
      return (await getConversation(conversationId))?.messages.slice(-limit) ?? [];
    }
  }
  const conversation = await getConversation(conversationId);
  if (!conversation) return [];
  return conversation.messages.slice(-limit);
}

export async function loadTasks(): Promise<TaskRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec('SELECT taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata FROM tasks ORDER BY createdAt ASC;');
      if (!res || !res[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [taskId, conversationId, description, status, priority, assignedAgent, createdAt, updatedAt, startedAt, completedAt, checkpoint, result, error, retryCount, metadata] = r;
        let cp: Record<string, unknown> | null = null;
        let md: Record<string, unknown> | undefined = undefined;
        try { cp = checkpoint ? JSON.parse(checkpoint) : null; } catch {}
        try { md = metadata ? JSON.parse(metadata) : undefined; } catch {}
        return {
          taskId,
          conversationId,
          description,
          status: status as TaskStatus,
          priority: Number(priority || 0),
          assignedAgent: assignedAgent || undefined,
          createdAt,
          updatedAt,
          startedAt: startedAt || undefined,
          completedAt: completedAt || undefined,
          checkpoint: cp,
          result: result || undefined,
          error: error || undefined,
          retryCount: Number(retryCount || 0),
          metadata: md,
        } as TaskRecord;
      });
    } catch (e) {
      console.warn('DB loadTasks failed:', e?.message || e);
    }
  }
  return await readJson<TaskRecord[]>(TASKS_FILE, []);
}

export async function saveTasks(tasks: TaskRecord[]): Promise<void> {
  await writeJson(TASKS_FILE, tasks);
  const bridge = await initSqlBridge();
  if (!bridge || !bridge.db) return;
  try {
    const db = bridge.db;
    db.run('BEGIN');
    for (const t of tasks) {
      const stmt = db.prepare('INSERT OR REPLACE INTO tasks (taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      stmt.run([
        t.taskId,
        t.conversationId,
        t.description,
        t.status,
        t.priority,
        t.assignedAgent || null,
        t.createdAt,
        t.updatedAt,
        t.startedAt || null,
        t.completedAt || null,
        t.checkpoint ? JSON.stringify(t.checkpoint) : null,
        t.result || null,
        t.error || null,
        t.retryCount || 0,
        t.metadata ? JSON.stringify(t.metadata) : null,
      ]);
    }
    db.run('COMMIT');
    bridge.persist();
  } catch (e) {
    console.warn('DB saveTasks failed:', e?.message || e);
  }
}

export async function createTask(data: {
  conversationId: string;
  description: string;
  priority?: number;
  assignedAgent?: string;
}): Promise<TaskRecord> {
  const tasks = await loadTasks();
  const timestamp = new Date().toISOString();
  const task: TaskRecord = {
    taskId: createId("task-"),
    conversationId: data.conversationId,
    description: data.description,
    status: "queued",
    priority: data.priority ?? 5,
    assignedAgent: data.assignedAgent,
    createdAt: timestamp,
    updatedAt: timestamp,
    retryCount: 0,
    checkpoint: null,
  };
  tasks.push(task);
  await saveTasks(tasks);
  return task;
}

export async function updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null> {
  const tasks = await loadTasks();
  const task = tasks.find((item) => item.taskId === taskId);
  if (!task) return null;
  Object.assign(task, patch);
  task.updatedAt = new Date().toISOString();
  await saveTasks(tasks);
  return task;
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec('SELECT taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata FROM tasks WHERE taskId=? LIMIT 1;', );
      // sql.js doesn't support parameterized exec; use prepare
      const stmt = bridge.db.prepare('SELECT taskId,conversationId,description,status,priority,assignedAgent,createdAt,updatedAt,startedAt,completedAt,checkpoint,result,error,retryCount,metadata FROM tasks WHERE taskId=? LIMIT 1');
      stmt.bind([taskId]);
      if (!stmt.step()) { stmt.free && stmt.free(); return null; }
      const r = stmt.get();
      stmt.free && stmt.free();
      const [tId, conversationId, description, status, priority, assignedAgent, createdAt, updatedAt, startedAt, completedAt, checkpoint, result, error, retryCount, metadata] = r as any[];
      let cp: Record<string, unknown> | null = null;
      let md: Record<string, unknown> | undefined = undefined;
      try { cp = checkpoint ? JSON.parse(checkpoint) : null; } catch {}
      try { md = metadata ? JSON.parse(metadata) : undefined; } catch {}
      return {
        taskId: tId,
        conversationId,
        description,
        status: status as TaskStatus,
        priority: Number(priority || 0),
        assignedAgent: assignedAgent || undefined,
        createdAt,
        updatedAt,
        startedAt: startedAt || undefined,
        completedAt: completedAt || undefined,
        checkpoint: cp,
        result: result || undefined,
        error: error || undefined,
        retryCount: Number(retryCount || 0),
        metadata: md,
      } as TaskRecord;
    } catch (e) {
      console.warn('DB getTask failed:', e?.message || e);
    }
  }
  const tasks = await loadTasks();
  return tasks.find((item) => item.taskId === taskId) ?? null;
}

export async function loadSessions(): Promise<SessionRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec('SELECT sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts FROM sessions ORDER BY lastSeen ASC;');
      if (!res || !res[0]) return [];
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
    } catch (e) {
      console.warn('DB loadSessions failed:', e?.message || e);
    }
  }
  return await readJson<SessionRecord[]>(SESSIONS_FILE, []);
}

export async function saveSessions(sessions: SessionRecord[]): Promise<void> {
  await writeJson(SESSIONS_FILE, sessions);
  const bridge = await initSqlBridge();
  if (!bridge || !bridge.db) return;
  try {
    const db = bridge.db;
    db.run('BEGIN');
    for (const s of sessions) {
      const stmt = db.prepare('INSERT OR REPLACE INTO sessions (sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts) VALUES (?,?,?,?,?,?,?,?,?)');
      stmt.run([s.sessionId, s.conversationId, s.device || null, s.connectionStatus || null, s.createdAt || new Date().toISOString(), s.lastSeen || new Date().toISOString(), s.lastMessageId || null, s.lastTaskId || null, s.reconnectAttempts || 0]);
    }
    db.run('COMMIT');
    bridge.persist();
  } catch (e) {
    console.warn('DB saveSessions failed:', e?.message || e);
  }
}

export async function upsertSession(session: SessionRecord): Promise<void> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const db = bridge.db;
        // get previous reconnectAttempts and createdAt if present
        const stmtSel = db.prepare('SELECT reconnectAttempts, createdAt FROM sessions WHERE sessionId=? LIMIT 1');
        stmtSel.bind([session.sessionId]);
        let prev = 0;
        let existingCreatedAt: string | null = null;
        if (stmtSel.step()) {
          const row = stmtSel.get();
          prev = Number(row[0] || 0);
          existingCreatedAt = row[1] || null;
        }
        stmtSel.free && stmtSel.free();
        // Determine reconnect attempts without accidentally resetting it to 0.
        const attempts = typeof session.reconnectAttempts === 'number' ? Math.max(prev, session.reconnectAttempts) : prev;
        const createdAtToUse = existingCreatedAt || session.createdAt || new Date().toISOString();
      const stmt = db.prepare('INSERT OR REPLACE INTO sessions (sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts) VALUES (?,?,?,?,?,?,?,?,?)');
      stmt.run([session.sessionId, session.conversationId, session.device || null, session.connectionStatus || null, createdAtToUse, session.lastSeen || new Date().toISOString(), session.lastMessageId || null, session.lastTaskId || null, attempts]);
      bridge.persist();

      // Mirror DB changes back to JSON store so both persistence layers stay in sync.
      const sessions = await loadSessions();
      const existing = sessions.find((item) => item.sessionId === session.sessionId);
      const merged = { ...(existing || {}), ...session, reconnectAttempts: attempts, createdAt: createdAtToUse };
      if (existing) {
        Object.assign(existing, merged);
      } else {
        sessions.push(merged as any);
      }
      await writeJson(SESSIONS_FILE, sessions);
      return;
    } catch (e) {
      console.warn('DB upsertSession failed:', e?.message || e);
    }
  }

  const sessions = await loadSessions();
  const existing = sessions.find((item) => item.sessionId === session.sessionId);
  if (existing) {
    Object.assign(existing, session);
  } else {
    sessions.push(session);
  }
  await saveSessions(sessions);
}

export async function getLastSession(conversationId: string): Promise<SessionRecord | null> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec('SELECT sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts FROM sessions WHERE conversationId=? ORDER BY lastSeen DESC LIMIT 1;');
      // use prepare to bind parameter
      const stmt = bridge.db.prepare('SELECT sessionId,conversationId,device,connectionStatus,createdAt,lastSeen,lastMessageId,lastTaskId,reconnectAttempts FROM sessions WHERE conversationId=? ORDER BY lastSeen DESC LIMIT 1');
      stmt.bind([conversationId]);
      if (!stmt.step()) { stmt.free && stmt.free(); return null; }
      const r = stmt.get();
      stmt.free && stmt.free();
      return {
        sessionId: r[0], conversationId: r[1], device: r[2], connectionStatus: r[3], createdAt: r[4], lastSeen: r[5], lastMessageId: r[6] || undefined, lastTaskId: r[7] || undefined, reconnectAttempts: Number(r[8] || 0),
      } as SessionRecord;
    } catch (e) {
      console.warn('DB getLastSession failed:', e?.message || e);
    }
  }
  const sessions = await loadSessions();
  const matches = sessions.filter((s) => s.conversationId === conversationId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  return matches[0] ?? null;
}

export async function loadToolCalls(): Promise<ToolCallRecord[]> {
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const res = bridge.db.exec('SELECT id,sessionId,conversationId,toolName,args,result,error,taskId,timestamp FROM tool_calls ORDER BY timestamp ASC;');
      if (!res || !res[0]) return [];
      return res[0].values.map((r: any[]) => {
        const [id, sessionId, conversationId, toolName, args, result, error, taskId, timestamp] = r;
        let a: Record<string, unknown> = {};
        try { a = args ? JSON.parse(args) : {}; } catch {}
        let resv: any = result;
        try { resv = result ? JSON.parse(result) : result; } catch {}
        return { id, sessionId, conversationId, toolName, args: a, result: resv, error: error || undefined, taskId: taskId || undefined, timestamp } as ToolCallRecord;
      });
    } catch (e) {
      console.warn('DB loadToolCalls failed:', e?.message || e);
    }
  }
  return await readJson<ToolCallRecord[]>(TOOL_CALLS_FILE, []);
}

export async function appendToolCall(call: ToolCallRecord): Promise<void> {
  const calls = await loadToolCalls();
  calls.push(call);
  await writeJson(TOOL_CALLS_FILE, calls);
  const bridge = await initSqlBridge();
  if (bridge && bridge.db) {
    try {
      const db = bridge.db;
      const stmt = db.prepare('INSERT OR REPLACE INTO tool_calls (id,sessionId,conversationId,toolName,args,result,error,taskId,timestamp) VALUES (?,?,?,?,?,?,?,?,?)');
      stmt.run([call.id, call.sessionId, call.conversationId, call.toolName, JSON.stringify(call.args || {}), JSON.stringify(call.result || null), call.error || null, call.taskId || null, call.timestamp]);
      bridge.persist();
    } catch (e) {
      console.warn('DB appendToolCall failed:', e?.message || e);
    }
  }
}

export function newMessageId(): string {
  return createId("msg-");
}

export function newToolCallId(): string {
  return createId("tool-");
}

export function newSessionId(): string {
  return createId("sess-");
}

export function newTaskCheckpointId(): string {
  return createId("checkpoint-");
}
