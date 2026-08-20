const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.SARA_DATA_DIR || process.cwd();
const DB_PATH = path.join(DATA_DIR, 'data.db');

function readJsonSafe(name) {
  const p = path.join(DATA_DIR, name);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Failed reading', p, e.message || e);
    return null;
  }
}

(async () => {
  console.log('Migrating JSON data from', DATA_DIR, 'to', DB_PATH);
  const convs = readJsonSafe('conversations.json') || [];
  const tasks = readJsonSafe('tasks.json') || [];
  const sessions = readJsonSafe('sessions.json') || [];
  const toolcalls = readJsonSafe('tool_calls.json') || [];
  const memories = readJsonSafe('memories.json') || [];

  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
  const db = new SQL.Database();

  db.run(`
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT, role TEXT, content TEXT, timestamp TEXT, metadata TEXT);
CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, conversationId TEXT, description TEXT, status TEXT, priority INTEGER, assignedAgent TEXT, createdAt TEXT, updatedAt TEXT, startedAt TEXT, completedAt TEXT, checkpoint TEXT, result TEXT, error TEXT, retryCount INTEGER, metadata TEXT);
CREATE TABLE IF NOT EXISTS sessions (sessionId TEXT PRIMARY KEY, conversationId TEXT, device TEXT, connectionStatus TEXT, createdAt TEXT, lastSeen TEXT, lastMessageId TEXT, lastTaskId TEXT, reconnectAttempts INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, sessionId TEXT, conversationId TEXT, toolName TEXT, args TEXT, result TEXT, error TEXT, taskId TEXT, timestamp TEXT);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, category TEXT, text TEXT, createdAt TEXT, updatedAt TEXT);
  `);

  const insertConv = db.prepare('INSERT OR REPLACE INTO conversations VALUES (?, ?, ?, ?)');
  const insertMsg = db.prepare('INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  const insertTask = db.prepare('INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSession = db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTool = db.prepare('INSERT OR REPLACE INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMemory = db.prepare('INSERT OR REPLACE INTO memories VALUES (?, ?, ?, ?, ?)');

  try {
    db.run('BEGIN');
    for (const c of convs) {
      insertConv.run([c.id, c.title || null, c.createdAt || null, c.updatedAt || null]);
      if (Array.isArray(c.messages)) {
        for (const m of c.messages) {
          insertMsg.run([m.id, c.id, m.role, m.content, m.timestamp, JSON.stringify(m.metadata || null)]);
        }
      }
    }

    for (const t of tasks) {
      insertTask.run([t.taskId, t.conversationId, t.description, t.status, t.priority, t.assignedAgent || null, t.createdAt || null, t.updatedAt || null, t.startedAt || null, t.completedAt || null, JSON.stringify(t.checkpoint || null), t.result || null, t.error || null, t.retryCount || 0, JSON.stringify(t.metadata || null)]);
    }

    for (const s of sessions) {
      insertSession.run([s.sessionId, s.conversationId, s.device || null, s.connectionStatus || null, s.createdAt || null, s.lastSeen || null, s.lastMessageId || null, s.lastTaskId || null, s.reconnectAttempts || 0]);
    }

    for (const tc of toolcalls) {
      insertTool.run([tc.id, tc.sessionId || null, tc.conversationId || null, tc.toolName || null, JSON.stringify(tc.args || null), JSON.stringify(tc.result || null), tc.error || null, tc.taskId || null, tc.timestamp || null]);
    }

    for (const m of memories) {
      insertMemory.run([m.id, m.category || null, m.text || null, m.createdAt || null, m.updatedAt || null]);
    }
    db.run('COMMIT');
    const binary = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(binary));
    console.log('Migration completed successfully. Database saved at', DB_PATH);
  } catch (e) {
    console.error('Migration failed:', e.message || e);
  } finally {
    db.close();
  }
})();
