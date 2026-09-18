import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { Memory, MemoryTransaction } from "./src/lib/memoryTypes";
import { dataFile } from "./server_paths";
import { memoryService } from "./src/services/MemoryService";
import { getMemoryPersistenceService } from "./src/services/MemoryPersistenceService";
import { createSemanticMemory, MemoryRecord, SemanticMemory, EpisodicMemory } from "./src/types/Memory";

export type StoredMemory = Memory & {
  storageSource?: "desktop" | "mobile";
  lastReferencedAt?: string;
  keywords?: string[];
};

const DESKTOP_MEMORY_FILE = dataFile("memories.json");
const MOBILE_MEMORY_FILE = dataFile("memories_mobile.json");
const MEMORY_DB_FILE = dataFile("sara_memory.db");
const DECISIONS_FILE = dataFile("decisions.json");
const QUESTIONS_FILE = dataFile("questions.json");
const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  source TEXT,
  category TEXT,
  text TEXT,
  importance INTEGER,
  importance_level TEXT,
  tier TEXT,
  keywords TEXT,
  confidence REAL,
  verification_status TEXT,
  evidence_text TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  lastReferencedAt TEXT,
  lastVerified TEXT
);
CREATE TABLE IF NOT EXISTS short_term_memory (id TEXT PRIMARY KEY, conversation_id TEXT, text TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS conversation_summary (id TEXT PRIMARY KEY, conversation_id TEXT, summary TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, category TEXT, fact TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS episodic_memory (id TEXT PRIMARY KEY, episode_name TEXT, text TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS task_memory (id TEXT PRIMARY KEY, task_id TEXT, result TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS project_memory (id TEXT PRIMARY KEY, project_name TEXT, fact TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS user_preference_memory (id TEXT PRIMARY KEY, preference TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS relationship_memory (id TEXT PRIMARY KEY, relation_name TEXT, fact TEXT, importance_level TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS relationship_records (person_id TEXT PRIMARY KEY, name TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS camera_activity (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, status TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, title TEXT, decision TEXT, reason TEXT, category TEXT, confidence REAL, expected_outcome TEXT, actual_outcome TEXT, evaluation_notes TEXT, metadata TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question TEXT, category TEXT, importance REAL, reason TEXT, source TEXT, asked INTEGER, answered INTEGER, answer TEXT, metadata TEXT, created_at TEXT);
`;

type MemorySource = "desktop" | "mobile";

function memoryFileForSource(source: MemorySource): string {
  return source === "mobile" ? MOBILE_MEMORY_FILE : DESKTOP_MEMORY_FILE;
}

function parseJsonWithBom<T>(value: string): T {
  const normalized = value.replace(/^\uFEFF/, "").trim();
  return JSON.parse(normalized) as T;
}

function normalizeKeywords(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "your", "you", "are", "was", "were", "will", "what", "when", "where", "which", "sara", "user", "about", "into", "they", "them", "their", "been", "would", "could", "should", "like", "love", "want", "need", "just", "okay", "hello", "hi", "hey"]);
  return Array.from(new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)).slice(0, 32)));
}

let memoryDbInit: Promise<{ db: any; persist: () => void } | null> | null = null;
async function getMemoryDb() {
  if (memoryDbInit) return memoryDbInit;
  memoryDbInit = (async () => {
    try {
      const initSqlJs = (await import("sql.js")).default ?? (await import("sql.js"));
      const locateFile = (file: string) => {
        const candidates = [
          path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
          path.join(process.cwd(), "server", "node_modules", "sql.js", "dist", file),
        ];
        return candidates.find((c) => { try { return fsSync.existsSync(c); } catch { return false; } }) || file;
      };
      const SQL = await initSqlJs({ locateFile });
      const db = fsSync.existsSync(MEMORY_DB_FILE)
        ? new SQL.Database(new Uint8Array(fsSync.readFileSync(MEMORY_DB_FILE)))
        : new SQL.Database();
      db.run(MEMORY_SCHEMA);
      const persist = () => { try { fsSync.writeFileSync(MEMORY_DB_FILE, Buffer.from(db.export())); } catch {} };
      persist();
      return { db, persist };
    } catch {
      return null;
    }
  })();
  return memoryDbInit;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return parseJsonWithBom<T>(await fs.readFile(filePath, "utf-8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function scoreMemory(memory: StoredMemory, query: string): number {
  const terms = normalizeKeywords(query);
  const hay = `${memory.text} ${(memory.keywords || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) if (hay.includes(term)) score += term.length > 4 ? 2 : 1;
  if (memory.category === "identity") score += 1;
  score += Math.min(3, Math.max(0, (memory.importance ?? 5) / 3));
  if (memory.lastReferencedAt) score += 0.2;
  const ageHours = Math.max(0, Date.now() - new Date(memory.updatedAt).getTime()) / 36e5;
  score += Math.max(0, 2 - ageHours / 72);
  return score;
}

let memoryPersistenceInitialized = false;

async function ensureMemoryPersistence() {
  if (!memoryPersistenceInitialized) {
    memoryPersistenceInitialized = true;
    const persistence = getMemoryPersistenceService();
    const result = await persistence.loadMemories();
    if (result.store) {
      (memoryService as any).store = result.store;
    }
    persistence.enableAutoSave((memoryService as any).store);
    console.log("[MemoryService] Unified memory persistence initialized");
  }
}

function memoryRecordToStoredMemory(record: MemoryRecord, source: MemorySource = "desktop"): StoredMemory {
  let text = "";
  if (record.type === "semantic") text = (record as SemanticMemory).fact.statement;
  else if (record.type === "episodic") text = (record as EpisodicMemory).event.description;
  else text = JSON.stringify(record.metadata);

  return {
    id: record.id,
    category: record.metadata?.category || "semantic",
    text,
    importance: 5,
    storageSource: source,
    createdAt: new Date(record.timestamp).toISOString(),
    updatedAt: new Date(record.timestamp).toISOString(),
    lastReferencedAt: new Date(record.timestamp).toISOString(),
    keywords: record.tags || normalizeKeywords(text),
  };
}

export async function loadMemories(source: MemorySource = "desktop"): Promise<StoredMemory[]> {
  await ensureMemoryPersistence();
  const result = memoryService.queryMemories({ limit: 1000 });
  return result.memories.map(m => memoryRecordToStoredMemory(m, source));
}

export async function saveMemories(memories: StoredMemory[], source: MemorySource = "desktop"): Promise<void> {
  await ensureMemoryPersistence();
  for (const m of memories) {
    const existing = memoryService.queryMemories({ keywords: [m.id], limit: 1 }).memories.find(mem => mem.id === m.id);
    if (!existing) {
      const record = createSemanticMemory(m.text, m.category, 0.9, m.keywords || normalizeKeywords(m.text));
      record.id = m.id;
      record.metadata = { category: m.category, source: m.storageSource };
      memoryService.storeSemantic(record);
    }
  }
  const persistence = getMemoryPersistenceService();
  persistence.markDirty();
}

export async function searchMemories(query: string, source: MemorySource = "desktop", limit = 8): Promise<StoredMemory[]> {
  await ensureMemoryPersistence();
  const keywords = normalizeKeywords(query);
  const result = memoryService.queryMemories({ keywords, limit, confidence: 0 });
  
  if (result.memories.length === 0) {
    // Fallback to naive search
    const all = memoryService.queryMemories({ limit: 1000 }).memories;
    const scored = all.map(m => ({ m, score: scoreMemory(memoryRecordToStoredMemory(m, source), query) }));
    return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => memoryRecordToStoredMemory(x.m, source));
  }

  return result.memories.map(m => memoryRecordToStoredMemory(m, source));
}

export async function upsertMemory(memory: StoredMemory, source: MemorySource = "desktop"): Promise<StoredMemory[]> {
  await ensureMemoryPersistence();
  const timestamp = new Date().toISOString();
  
  const keywords = memory.keywords || normalizeKeywords(memory.text);
  const record = createSemanticMemory(memory.text, memory.category, 0.9, keywords);
  record.id = memory.id || Math.random().toString(36).substring(2, 11);
  record.metadata = { category: memory.category, source: source };
  
  memoryService.storeSemantic(record);
  getMemoryPersistenceService().markDirty();

  return loadMemories(source);
}

export async function forgetMemory(id: string, source: MemorySource = "desktop"): Promise<StoredMemory[]> {
  await ensureMemoryPersistence();
  // Use the MemoryService's deleteMemory method to remove the memory across all stores
  const result = memoryService.deleteMemory(id);
  // If deletion failed, you may choose to handle it; for now we just proceed
  getMemoryPersistenceService().markDirty();
  return loadMemories(source);
}

export function formatSystemInstructionsWithMemories(baseInstruction: string, memories: StoredMemory[]): string {
  if (memories.length === 0) {
    return baseInstruction + "\n\n=== SARA MEMORY CORE ===\nNo durable Sara memories are stored yet.\n=========================\n";
  }
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    grouped[m.category] = grouped[m.category] || [];
    grouped[m.category].push(m.text);
  }
  const ordered: { key: string; label: string }[] = [
    { key: "identity", label: "Identity" },
    { key: "preference", label: "Preferences" },
    { key: "goal", label: "Goals" },
    { key: "project", label: "Projects" },
    { key: "relationship", label: "Relationships" },
    { key: "emotional", label: "Emotional" },
    { key: "behavior", label: "Behavior" },
  ];
  let block = "\n\n=== RELEVANT MEMORY ===\n";
  for (const cat of ordered) {
    const items = grouped[cat.key] || [];
    if (items.length) block += `* ${cat.label}:\n${items.map((t) => `  - ${t}`).join("\n")}\n`;
  }
  block += "=========================\n";
  return baseInstruction + block;
}

let isConsolidating = false;
export async function processConversationSlice(apiKey: string, dialogueHistory: { role: string; text: string }[], source: MemorySource = "desktop"): Promise<Memory[] | null> {
  if (isConsolidating || dialogueHistory.length < 2) return null;
  const requestedNoStore = dialogueHistory.some((line) =>
    line.role === "user" && /\b(?:don't|do not|never)\s+(?:remember|store|save|keep)\b/i.test(line.text),
  );
  if (requestedNoStore) return null;
  isConsolidating = true;
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
    const currentMemories = await loadMemories(source);
    const memoryContext = currentMemories.map((m) => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`).join("\n");
    const dialogueContext = dialogueHistory.map((line) => `${line.role === "user" ? "User" : "Sara"}: ${line.text}`).join("\n");
    const prompt = `You are Sara's durable memory engine. Extract only durable facts, preferences, goals, projects, relationships, emotional milestones explicitly shared as lasting context, and long-term behavior. Never store passwords, secrets, highly sensitive personal details, or content marked private. Never store transient emotion labels, sentiment classifications, mental-health diagnoses, or guesses about how the user feels; those remain private per-turn response signals only.\n\nCURRENT MEMORIES:\n${memoryContext || "(none)"}\n\nRECENT DIALOGUE:\n${dialogueContext}\n\nReturn JSON with transactions array. Use action ADD, UPDATE, or REMOVE. Keep summaries short, natural, and written about Sara's user.`;
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transactions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, enum: ["ADD", "UPDATE", "REMOVE"] },
                  id: { type: Type.STRING },
                  category: { type: Type.STRING, enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"] },
                  text: { type: Type.STRING },
                },
                required: ["action", "category", "text"],
              },
            },
          },
          required: ["transactions"],
        },
      },
    });
    const resultText = response.text?.trim() || "{}";
    const resultObj = JSON.parse(resultText);
    const transactions: MemoryTransaction[] = resultObj.transactions || [];
    if (!transactions.length) return null;
    let updated = [...currentMemories];
    const timestamp = new Date().toISOString();
    for (const trx of transactions) {
      if (trx.action === "ADD") {
        updated.push({
          id: Math.random().toString(36).substring(2, 11),
          category: trx.category,
          text: trx.text,
          createdAt: timestamp,
          updatedAt: timestamp,
          storageSource: source,
          importance: 5,
          keywords: normalizeKeywords(trx.text),
        });
      } else if (trx.action === "UPDATE") {
        const idx = updated.findIndex((m) => m.id === trx.id);
        if (idx >= 0) updated[idx] = { ...updated[idx], category: trx.category, text: trx.text, updatedAt: timestamp, keywords: normalizeKeywords(trx.text) };
      } else if (trx.action === "REMOVE") {
        updated = updated.filter((m) => m.id !== trx.id);
      }
    }
    await saveMemories(updated, source);
    return updated;
  } catch {
    return null;
  } finally {
    isConsolidating = false;
  }
}

export async function rebuildMemoryIndexFromDatabase(source: MemorySource = "desktop"): Promise<StoredMemory[]> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) {
    return await loadMemories(source);
  }
  try {
    const stmt = bridge.db.prepare("SELECT id,source,category,text,importance,tier,keywords,createdAt,updatedAt,lastReferencedAt FROM memories WHERE source = ? ORDER BY COALESCE(importance,0) DESC, updatedAt DESC");
    stmt.bind([source]);
    const rebuilt: StoredMemory[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      const text = row.text || "";
      rebuilt.push({
        id: String(row.id),
        category: row.category || "semantic",
        text,
        createdAt: row.createdAt || new Date().toISOString(),
        updatedAt: row.updatedAt || new Date().toISOString(),
        tier: row.tier || undefined,
        importance: row.importance === null || row.importance === undefined ? 5 : Number(row.importance),
        storageSource: source,
        lastReferencedAt: row.lastReferencedAt || undefined,
        keywords: row.keywords ? JSON.parse(row.keywords) : normalizeKeywords(text),
      });
    }
    stmt.free();
    await writeJson(memoryFileForSource(source), rebuilt);
    return rebuilt;
  } catch (e) {
    return await loadMemories(source);
  }
}

// Decision Memory Persistence
export async function loadDecisions(): Promise<any[]> {
  return readJson<any[]>(DECISIONS_FILE, []);
}

export async function saveDecisions(decisions: any[]): Promise<void> {
  await writeJson(DECISIONS_FILE, decisions);
}

export async function upsertDecision(decision: any): Promise<any[]> {
  const current = await loadDecisions();
  const existing = current.findIndex((d) => d.id === decision.id);
  if (existing >= 0) {
    current[existing] = { ...current[existing], ...decision, updatedAt: new Date().toISOString() };
  } else {
    current.push({ ...decision, createdAt: new Date().toISOString() });
  }
  await saveDecisions(current);
  return current;
}

export async function loadQuestions(): Promise<any[]> {
  return readJson<any[]>(QUESTIONS_FILE, []);
}

export async function saveQuestions(questions: any[]): Promise<void> {
  await writeJson(QUESTIONS_FILE, questions);
}

export async function upsertQuestion(question: any): Promise<any[]> {
  const current = await loadQuestions();
  const existing = current.findIndex((q) => q.id === question.id);
  if (existing >= 0) {
    current[existing] = { ...current[existing], ...question };
  } else {
    current.push(question);
  }
  await saveQuestions(current);
  return current;
}

export async function getUnansweredQuestions(): Promise<any[]> {
  const questions = await loadQuestions();
  return questions.filter((q: any) => !q.userResponded);
}

export type PersistedRelationshipRecord = {
  personId: string;
  name: string;
  [key: string]: unknown;
};

export async function loadRelationshipRecords(): Promise<PersistedRelationshipRecord[]> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return [];
  try {
    const stmt = bridge.db.prepare("SELECT record_json FROM relationship_records ORDER BY updated_at DESC");
    const records: PersistedRelationshipRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { record_json?: string };
      try {
        const parsed = JSON.parse(String(row.record_json || "{}")) as PersistedRelationshipRecord;
        if (parsed.personId && parsed.name) records.push(parsed);
      } catch {}
    }
    stmt.free();
    return records;
  } catch {
    return [];
  }
}

export async function upsertRelationshipRecord(record: PersistedRelationshipRecord): Promise<void> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return;
  const updatedAt = String(record.updatedAt || new Date().toISOString());
  bridge.db.run(
    "INSERT OR REPLACE INTO relationship_records (person_id, name, record_json, updated_at) VALUES (?, ?, ?, ?)",
    [record.personId, record.name, JSON.stringify(record), updatedAt],
  );
  bridge.persist();
}

export async function deleteRelationshipRecord(personId: string): Promise<boolean> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return false;
  try {
    bridge.db.run("DELETE FROM relationship_records WHERE person_id = ?", [personId]);
    bridge.persist();
    return true;
  } catch {
    return false;
  }
}

export async function recordCameraActivity(eventType: string, status: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return;
  bridge.db.run(
    "INSERT INTO camera_activity (id, event_type, status, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [`camera-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, eventType, status, JSON.stringify(metadata), new Date().toISOString()],
  );
  const retentionDays = Math.max(1, Math.min(365, Number(metadata.retentionDays || 7)));
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  bridge.db.run("DELETE FROM camera_activity WHERE created_at < ?", [cutoff]);
  bridge.persist();
}

export async function listCameraActivity(limit = 100): Promise<Array<Record<string, unknown>>> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return [];
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const stmt = bridge.db.prepare(`SELECT id, event_type, status, metadata_json, created_at FROM camera_activity ORDER BY created_at DESC LIMIT ${safeLimit}`);
  const rows: Array<Record<string, unknown>> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(String(row.metadata_json || "{}")); } catch {}
    rows.push({ id: row.id, eventType: row.event_type, status: row.status, metadata, createdAt: row.created_at });
  }
  stmt.free();
  return rows;
}

export async function clearCameraActivity(): Promise<void> {
  const bridge = await getMemoryDb();
  if (!bridge?.db) return;
  bridge.db.run("DELETE FROM camera_activity");
  bridge.persist();
}


