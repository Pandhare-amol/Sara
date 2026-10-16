import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateMemoryText, isMemoryCategory } from "../src/security/memoryContentPolicy";
import { serializeMemoryExport } from "../src/services/memoryExport";
import type { Memory } from "../src/lib/memoryTypes";

let tempDataDir = "";
let originalDataDir: string | undefined;
let memoryStore: typeof import("../server_memory") | undefined;

before(async () => {
  originalDataDir = process.env.SARA_DATA_DIR;
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-memory-management-"));
  process.env.SARA_DATA_DIR = tempDataDir;

  // Seed an older SQL.js schema without memory_metadata to exercise the
  // additive migration while keeping all writes in this temporary directory.
  const sqlModule = await import("sql.js");
  const initSqlJs = sqlModule.default ?? sqlModule;
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });
  const db = new SQL.Database();
  db.run(`CREATE TABLE memories (
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
  )`);
  const legacyInsert = db.prepare(`INSERT INTO memories (
    id,source,category,text,importance,tier,keywords,confidence,verification_status,evidence_text,createdAt,updatedAt,lastReferencedAt,lastVerified
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  legacyInsert.run([
    "legacy-memory",
    "desktop",
    "preference",
    "User prefers concise answers.",
    6,
    "semantic",
    JSON.stringify(["prefers", "concise", "answers"]),
    0.82,
    "verified",
    JSON.stringify(["confirmed directly by user"]),
    "2025-01-01T00:00:00.000Z",
    "2025-01-02T00:00:00.000Z",
    null,
    "2025-01-02T00:00:00.000Z",
  ]);
  legacyInsert.free();
  const databasePath = path.join(tempDataDir, "sara_memory.db");
  fsSync.writeFileSync(databasePath, Buffer.from(db.export()));
  db.close();

  // Import only after SARA_DATA_DIR is configured so server_paths resolves the
  // isolated test location when it is initialized.
  memoryStore = await import("../server_memory");
});

after(async () => {
  if (originalDataDir === undefined) delete process.env.SARA_DATA_DIR;
  else process.env.SARA_DATA_DIR = originalDataDir;
  if (tempDataDir) await fs.rm(tempDataDir, { recursive: true, force: true });
});

test("memory policy accepts ordinary recollections and rejects obvious credentials", () => {
  assert.deepEqual(validateMemoryText("The user likes quiet cafés."), {
    ok: true,
    text: "The user likes quiet cafés.",
  });
  assert.equal(validateMemoryText("  ").ok, false);
  assert.equal(validateMemoryText("password=hunter2").ok, false);
  assert.equal(validateMemoryText("API key: sk-123456789012345678901234").ok, false);
  assert.equal(validateMemoryText("-----BEGIN RSA PRIVATE KEY-----").ok, false);
  assert.equal(validateMemoryText("x".repeat(2001)).ok, false);
  assert.equal(isMemoryCategory("preference"), true);
  assert.equal(isMemoryCategory("system"), false);
});

test("legacy SQL metadata survives migration, correction, and subsequent writes", async () => {
  assert.ok(memoryStore, "memory persistence module should be initialized");
  const store = memoryStore!;
  const legacy = (await store.loadMemories()).find((memory) => memory.id === "legacy-memory");
  assert.ok(legacy, "legacy record should remain available after additive column migration");
  assert.equal(legacy.confidence, 0.82);
  assert.equal(legacy.verificationStatus, "verified");
  assert.deepEqual(legacy.evidence, ["confirmed directly by user"]);
  assert.equal(legacy.lastVerified, "2025-01-02T00:00:00.000Z");

  const reviewed = await store.updateMemory("legacy-memory", {
    category: "preference",
    text: "User prefers concise answers.",
  });
  assert.ok(reviewed);
  assert.equal(reviewed.confidence, 0.82);
  assert.equal(reviewed.verificationStatus, "verified");
  assert.deepEqual(reviewed.evidence, ["confirmed directly by user"]);

  const corrected = await store.updateMemory("legacy-memory", {
    category: "preference",
    text: "User prefers concise answers with a short summary.",
  });
  assert.ok(corrected);
  assert.equal(corrected.text, "User prefers concise answers with a short summary.");
  assert.equal(corrected.source, "user_provided");
  assert.equal(corrected.verificationStatus, "verified");
  assert.equal(corrected.confidence, undefined, "a correction must not reuse confidence for the previous text");
  assert.deepEqual(corrected.evidence, ["User corrected this memory in SARA's Memory Dashboard."]);
  assert.ok(corrected.lastVerified, "the explicit correction should record when the user confirmed it");

  const richMemory: Memory = {
    id: "rich-memory",
    category: "project",
    text: "The user is planning a local garden.",
    createdAt: "2025-02-01T00:00:00.000Z",
    updatedAt: "2025-02-01T00:00:00.000Z",
    confidence: 0.67,
    source: "user_provided",
    evidence: ["User stated this directly."],
    contradictingEvidence: ["A previous plan mentioned a balcony garden."],
    lastVerified: "2025-02-02T00:00:00.000Z",
    verificationStatus: "partially_verified",
    mode: "PERSONAL",
  };
  await store.upsertMemory(richMemory);
  const roundTripped = (await store.loadMemories()).find((memory) => memory.id === "rich-memory");
  assert.ok(roundTripped);
  assert.equal(roundTripped.source, "user_provided");
  assert.equal(roundTripped.confidence, 0.67);
  assert.deepEqual(roundTripped.evidence, ["User stated this directly."]);
  assert.deepEqual(roundTripped.contradictingEvidence, ["A previous plan mentioned a balcony garden."]);
  assert.equal(roundTripped.lastVerified, "2025-02-02T00:00:00.000Z");
  assert.equal(roundTripped.verificationStatus, "partially_verified");
  assert.equal(roundTripped.mode, "PERSONAL");

  const candidate: Memory = {
    id: "candidate-memory",
    category: "preference",
    text: "The user is considering learning the cello.",
    createdAt: "2025-04-01T00:00:00.000Z",
    updatedAt: "2025-04-01T00:00:00.000Z",
    source: "historical_memory",
    verificationStatus: "unverified",
  };
  await store.upsertMemory(candidate);
  assert.equal((await store.searchMemories("cello")).some((memory) => memory.id === candidate.id), false);
  assert.equal(store.formatSystemInstructionsWithMemories("Base instruction", [candidate]).includes(candidate.text), false);
  const confirmed = await store.confirmMemory(candidate.id);
  assert.equal(confirmed?.verificationStatus, "verified");
  assert.equal(confirmed?.source, "user_provided");
  assert.ok(confirmed?.lastVerified);
  assert.ok(confirmed?.evidence?.some((evidence) => evidence.includes("User confirmed")));
  assert.equal((await store.searchMemories("cello")).some((memory) => memory.id === candidate.id), true);

  const externalKnowledge: Memory = {
    id: "external-knowledge",
    category: "project",
    text: "A sourced external fact, not a personal memory.",
    createdAt: "2025-05-01T00:00:00.000Z",
    updatedAt: "2025-05-01T00:00:00.000Z",
    source: "external_research",
    verificationStatus: "verified",
    evidence: ["https://example.invalid/source"],
  };
  await store.upsertMemory(externalKnowledge);
  assert.equal((await store.searchMemories("external fact")).some((memory) => memory.id === externalKnowledge.id), false);
  assert.equal(store.formatSystemInstructionsWithMemories("Base instruction", [externalKnowledge]).includes(externalKnowledge.text), false);
  assert.equal(await store.updateMemory(externalKnowledge.id, { category: "project", text: "Not a personal memory." }), null);
  assert.equal((await store.forgetMemory(externalKnowledge.id)).some((memory) => memory.id === externalKnowledge.id), true);

  await assert.rejects(
    store.updateMemory("rich-memory", { category: "project", text: "password=hunter2" }),
    /password, API key, token, or private key/i,
  );
  const afterRejectedEdit = (await store.loadMemories()).find((memory) => memory.id === "rich-memory");
  assert.equal(afterRejectedEdit?.text, richMemory.text, "a rejected edit must not change the stored text");

  const afterDelete = await store.forgetMemory("rich-memory");
  assert.equal(afterDelete.some((memory) => memory.id === "rich-memory"), false);
});

test("personal-memory export is versioned JSON and retains metadata", () => {
  const memory: Memory = {
    id: "export-memory",
    category: "goal",
    text: "The user wants to learn Marathi.",
    createdAt: "2025-03-01T00:00:00.000Z",
    updatedAt: "2025-03-01T00:00:00.000Z",
    source: "user_provided",
    verificationStatus: "unverified",
  };
  const serialized = serializeMemoryExport([memory], "2025-03-02T00:00:00.000Z");
  const exported = JSON.parse(serialized);
  assert.equal(exported.format, "sara-personal-memory");
  assert.equal(exported.version, 1);
  assert.equal(exported.exportedAt, "2025-03-02T00:00:00.000Z");
  assert.deepEqual(exported.memories, [memory]);
});
