// Migration runner for data.db using sql.js (WASM).
// Usage: node scripts/migrate_schema.cjs

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SARA_DATA_DIR || process.cwd();
const DB_FILE = path.join(DATA_DIR, 'data.db');

async function run() {
  try {
    const initSqlJsModule = await import('sql.js');
    const initSqlJs = initSqlJsModule.default ?? initSqlJsModule;

    const locateFile = (file) => {
      const candidates = [
        path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
      ];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch {}
      }
      return file;
    };

    const SQL = await initSqlJs({ locateFile });

    let db;
    if (fs.existsSync(DB_FILE)) {
      console.log('Opening existing DB:', DB_FILE);
      const bin = fs.readFileSync(DB_FILE);
      db = new SQL.Database(new Uint8Array(bin));
    } else {
      console.log('No existing DB found. Creating new DB at', DB_FILE);
      db = new SQL.Database();
      db.run(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT, role TEXT, content TEXT, timestamp TEXT, metadata TEXT);
CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, conversationId TEXT, description TEXT, status TEXT, priority INTEGER, assignedAgent TEXT, createdAt TEXT, updatedAt TEXT, startedAt TEXT, completedAt TEXT, checkpoint TEXT, result TEXT, error TEXT, retryCount INTEGER, metadata TEXT);
CREATE TABLE IF NOT EXISTS sessions (sessionId TEXT PRIMARY KEY, conversationId TEXT, device TEXT, connectionStatus TEXT, createdAt TEXT, lastSeen TEXT, lastMessageId TEXT, lastTaskId TEXT, reconnectAttempts INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, sessionId TEXT, conversationId TEXT, toolName TEXT, args TEXT, result TEXT, error TEXT, taskId TEXT, timestamp TEXT);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, category TEXT, text TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);
`);
      const stmt = db.prepare('INSERT INTO schema_version (version) VALUES (?)');
      stmt.run([1]);
      stmt.free && stmt.free();
      fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
      console.log('Initialized DB with schema version 1');
      return;
    }

    // Ensure schema_version exists
    try {
      db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);');
    } catch (e) {}

    // Read current version
    let current = null;
    try {
      const res = db.exec('SELECT version FROM schema_version LIMIT 1;');
      if (res && res[0] && res[0].values && res[0].values.length) {
        current = Number(res[0].values[0][0]);
      }
    } catch (e) {}

    console.log('Current schema version:', current ?? 'none');

    const CURRENT_SCHEMA_VERSION = 1;
    const MIGRATIONS = {
      // 2: `ALTER TABLE messages ADD COLUMN source TEXT;`,
    };

    if ((current || 0) < CURRENT_SCHEMA_VERSION) {
      console.log('Upgrading schema to', CURRENT_SCHEMA_VERSION);
      for (let v = (current || 0) + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
        const mig = MIGRATIONS[v];
        if (mig) {
          console.log('Applying migration for version', v);
          db.run(mig);
        }
      }
      const upd = db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)');
      upd.run([CURRENT_SCHEMA_VERSION]);
      upd.free && upd.free();
      fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
      console.log('Migration complete. New version:', CURRENT_SCHEMA_VERSION);
    } else {
      console.log('No migrations to apply. Schema up-to-date.');
    }

  } catch (err) {
    console.error('Migration runner failed:', err?.message || err);
    process.exitCode = 2;
  }
}

run();
