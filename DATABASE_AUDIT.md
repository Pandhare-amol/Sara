# SARA Database and Response-Path Audit

**Date:** 2026-08-19  
**Scope:** Existing production architecture, before MemoryRepository implementation  
**Constraint:** Audit only; no database or UI replacement is recommended.

## Executive Findings

1. The active desktop `/live` conversation path is TypeScript `server.ts`/`server_full.ts` using `server_state.ts` for conversations, sessions, tasks, and tool calls, plus `server_memory.ts` for memory context.
2. `data.db` is the active TypeScript state database, but most conversation and task helpers also maintain JSON files under `data/`.
3. `sara_memory.db` is used by the TypeScript `server_memory.ts` sql.js bridge and independently by the Python Desktop Agent's SQLite memory/decision/perception services. It is not the same schema as `data.db`.
4. The cognitive TypeScript layer persists episodic, semantic, procedural, autobiographical, and strategy data in separate JSON files. It is active for `/cognitive/*` and cognitive task flows, but is not the sole memory source for the normal `/live` prompt.
5. The normal `/live` startup path performs session recovery, `loadMemories()`, recent conversation loading, and then `ai.live.connect()`. These operations are sequential and can delay the first response/audio.
6. Assistant persistence is deferred after `turnComplete`, but user-message persistence and session setup occur in the WebSocket connection/turn path. Memory consolidation after a turn can call Gemini and is fire-and-forget, but it still duplicates persistence responsibilities.
7. The project has useful existing local persistence and recovery mechanisms, but no single repository abstraction controls all active stores.

## Production Startup and Runtime Path

### Startup ownership

- `startup/startupManager.ts` is the production supervisor. It acquires the SARA lock, validates configuration, starts/adopts Node backend and Python Desktop Agent, runs health checks, starts its supervisor loop, and launches Electron.
- `server_full.ts` is the npm production build target (`npm run build` bundles it to `dist/server.cjs`).
- `server.ts` is another backend entry point with overlapping routes and runtime logic.
- `desktop_agent/main.py` starts the Python FastAPI agent, live screen monitor, situational awareness, user activity, background events, autonomous decision components, conversation/proactive managers, personality, quiet mode, feedback, and shutdown managers.
- Electron renderer code is under `src/` and uses existing WebSocket/HTTP mechanisms. No UI redesign is required for the persistence/latency fix.

### Normal desktop conversation

Observed path in `server.ts`/`server_full.ts`:

```text
Electron/renderer
  -> WebSocket /live
  -> getOrCreateConversation() / server_state
  -> getLastSession() / server_state
  -> upsertSession() / server_state
  -> loadMemories() / server_memory
  -> getRecentConversationMessages() / server_state
  -> GoogleGenAI live.connect()
  -> streamed audio/message/tool callbacks
  -> ToolRouter / Python Desktop Agent for desktop tools
  -> turnComplete
  -> deferred appendConversationMessage(), upsertSession(), processConversationSlice()
```

The live callback forwards audio immediately, but tool calls remain part of the model turn and can delay final completion. The execution/verification orchestrator now exists and is used by desktop call wrappers, preserving the Python agent as execution authority.

## Database Inventory

| Store | Location | Owner | Active usage | Status |
|---|---|---|---|---|
| TypeScript state DB | `data/data.db` via `server_state.ts`/`dataFile("data.db")` | Node backend | Conversations, messages, tasks, sessions, tool calls, audit/build/webhook tables | **Active for state helpers** |
| Python memory DB | Python data root, normally `%APPDATA%\\Sara\\sara_memory.db` unless `SARA_DATA_DIR` is set | `desktop_agent/sqlite_memory.py`, `platform_core.py`, decision/perception managers | Python memory facts, decisions, activity, awareness, quiet/shutdown-related tables | **Active for Desktop Agent** |
| Node memory DB | `data/sara_memory.db` via `server_memory.ts` sql.js | Node `server_memory.ts` | `memories` and auxiliary memory tables loaded for normal prompt memory | **Active for Node memory path** |
| JSON conversations | `data/conversations.json` and `data/conversations_mobile.json` | `server.ts`/`server_full.ts` routes and state fallbacks | Conversation sync/API and fallback state | **Active parallel/fallback** |
| JSON sessions | `data/sessions.json` | `server_state.ts` | Session persistence/fallback | **Active parallel/fallback** |
| JSON tasks | `data/tasks.json` | `server_state.ts` and task routes | Task persistence/fallback | **Active parallel/fallback** |
| JSON tool calls | `data/tool_calls.json` | `server_state.ts` and task routes | Tool-call history/fallback | **Active parallel/fallback** |
| Node memory JSON | `data/memories.json`, `data/memories_mobile.json` | `server_memory.ts` | Fallback when sql.js DB unavailable; save path also writes JSON | **Active fallback and duplicate copy** |
| Cognitive episodic JSON | `data/episodic_memories.json` | `src/cognitive/episodicMemory.ts` | Cognitive orchestration and consolidation | **Active cognitive path, separate authority** |
| Cognitive semantic JSON | `data/semantic_memories.json` | `src/cognitive/semanticMemory.ts` | Cognitive facts/preferences/RAG context | **Active cognitive path, separate authority** |
| Cognitive procedural JSON | `data/procedural_memories.json` | `src/cognitive/proceduralMemory.ts` | Skills/workflows and consolidation | **Active cognitive path, separate authority** |
| Cognitive autobiographical JSON | `data/autobiographical_memories.json` | `src/cognitive/autobiographicalMemory.ts` | Milestones/project continuity | **Active cognitive path, separate authority** |
| Cognitive strategies JSON | `data/strategies.json` | `src/cognitive/strategyManager.ts` | Strategy selection/learning | **Active cognitive path, separate authority** |
| Advanced service snapshots | `data/memories/` plus backups/exports | `MemoryPersistenceService.ts` | Seven typed service memory collections and learning tests | **Active service/test path, not normal `/live` authority** |
| Hierarchical/transfer/anomaly JSON | `data/` paths configured by cognitive services | `src/cognitive/*` | Specialized learning and planning | **Parallel specialized stores** |

The exact Python data root is environment-dependent. `desktop_agent/sqlite_memory.py:data_root()` uses `SARA_DATA_DIR` when set, otherwise `%APPDATA%\\Sara` on Windows. This differs from Node `server_paths.ts`, which uses the repository `data/` directory.

## Active Read and Write Paths

### Normal `/live` prompt

- `server.ts` and `server_full.ts` call `loadMemories()` from `server_memory.ts` before `GoogleGenAI.live.connect()`.
- `server_memory.ts` first attempts sql.js `sara_memory.db`; if unavailable, it reads `data/memories.json`.
- Recent conversation context comes from `server_state.ts` (`getRecentConversationMessages()`), backed by `data.db` through sql.js and JSON fallback behavior.
- The prompt receives formatted memories plus recent messages. It does not directly query Python `MEMORY`, cognitive episodic memory, semantic memory, or autobiographical memory.
- After a completed turn, `processConversationSlice(apiKey, dialogueHistory)` may call Gemini to extract memory transactions, then writes via `server_memory.ts` to JSON and sql.js DB.

### Cognitive task path

- `/cognitive/*` uses `src/cognitive/orchestrator.ts` and its singleton engines.
- Episodic, semantic, procedural, autobiographical, and strategy engines load their own JSON files and persist synchronously with `fs` operations.
- `MemoryConsolidator` periodically analyzes cognitive episodic JSON and writes semantic/procedural/autobiographical JSON.
- This path is not automatically the same as the normal `/live` memory path.

### Python Desktop Agent path

- `desktop_agent/platform_core.py:MEMORY` wraps `SqliteMemoryManager` and stores memory facts in the Python SQLite database.
- Python autonomous decision, activity, situational-awareness, and quiet-mode managers also use SQLite tables, usually in the Python data root.
- This data is not automatically visible to `server_memory.ts` or `server_state.ts`.

## Which Store Is the Source of Truth Today?

There is no single source of truth today.

For the active desktop conversational prompt, the effective source is:

```text
Node server_memory.ts -> sql.js data/sara_memory.db
                              fallback -> data/memories.json
```

For conversations/tasks/sessions/tool calls, the effective source is:

```text
Node server_state.ts -> sql.js data/data.db
                          fallback/compatibility -> data/*.json
```

For Python desktop-agent memory and autonomous state, the source is:

```text
Python SqliteMemoryManager -> Python data_root()/sara_memory.db
```

For cognitive task execution, the source is the collection of cognitive JSON files. This fragmentation explains why a module may report successful loading while the active conversation path does not use that data.

## Latency and Blocking Risks

### Connection/startup latency

- `/live` performs conversation/session recovery and `upsertSession()` before the Gemini live session is opened.
- `loadMemories()` initializes sql.js and reads/exports `sara_memory.db` on first use. If sql.js initialization or file I/O is slow, first response/audio is delayed.
- `getRecentConversationMessages()` is also awaited before provider connection.
- `new GoogleGenAI()` and `live.connect()` occur in the same connection setup path.

### Response-turn latency

- Audio chunks are forwarded immediately in the live callback, which is good.
- Tool calls are awaited in the model-turn callback and can block turn completion by design; they must remain serialized where safety/verification requires it.
- Assistant conversation writes and memory consolidation are already deferred after `turnComplete`, but `processConversationSlice()` may make a Gemini request and then perform multiple file/DB writes.
- JSON conversation endpoints read and rewrite entire arrays synchronously (`fs.readFileSync`, `fs.writeFileSync`), creating latency and lost-update risk under concurrent writes.
- JSON cognitive engines persist complete in-memory maps synchronously after writes, which can block their caller.
- Python `SqliteMemoryManager.search()` loads all rows for a kind/query and scores them in Python; it is bounded by result count but not by SQL candidate filtering.

### Locking/corruption risks

- `data.db` and `sara_memory.db` are distinct files with overlapping conceptual tables, so writes can diverge without transactional coordination.
- `server_memory.ts` persists sql.js by writing the complete exported database image. Concurrent Node callers can race on the same file because the bridge has a singleton DB but no explicit write queue.
- JSON array read-modify-write endpoints can lose concurrent updates and expose partial files if the process crashes during `writeFileSync`.
- Cognitive JSON engines write complete snapshots synchronously and use separate files, multiplying corruption/recovery surfaces.
- Python SQLite uses WAL and busy/connection handling more carefully, but it is still a separate authority from Node.
- `MemoryPersistenceService` now uses atomic snapshot replacement and valid-file fallback, but it is not the active `/live` memory source.

## Provider and Fallback Findings

- Gemini is directly constructed in `server.ts`/`server_full.ts` for live sessions and non-live generation paths.
- Existing provider modules and fallback logic exist elsewhere in the repository, but the `/live` connection path shown above is Gemini-specific and rejects the session when no Gemini key is configured.
- Provider readiness is not cached as a single fast health decision before each request; initialization/connectivity can therefore be paid on session setup.
- Basic local memory retrieval should not depend on Gemini. Current post-turn semantic extraction does depend on Gemini, so API failure can prevent new complex memories from being consolidated even though existing local memories remain readable.

## Duplicate Systems

The following concepts are duplicated or split:

- Memory facts: Node `server_memory.ts`/sql.js, Node JSON fallback, Python `MEMORY`, and cognitive semantic/autobiographical stores.
- Conversation persistence: `server_state.ts`/`data.db`, JSON conversation files, and mobile AsyncStorage/server sync.
- Episodes: Python task/decision tables, cognitive episodic JSON, and Node task/tool-call records.
- Strategies/skills: Python learning/skill systems, cognitive procedural/strategy JSON, and service-level skill libraries.
- Persistence services: `MemoryPersistenceService`, `MemoryService`, `server_memory.ts`, Python `SqliteMemoryManager`, and cognitive engines.

These should not be deleted immediately. They need an adapter/migration plan around one authoritative repository and compatibility reads during transition.

## Recommended Migration

1. Keep SQLite as the durable technology.
2. Use the currently active Node `data.db` as the authoritative Node application database for conversations, messages, tasks, sessions, and tool calls, because `server_state.ts` already owns that active path.
3. Add a `MemoryRepository` abstraction at the Node boundary, initially backed by the existing `data.db` with additive tables/indexes for memories, episodes, profiles, preferences, and events. Do not delete `sara_memory.db` or JSON stores.
4. Add compatibility adapters that import/read existing `server_memory.ts` records and cognitive JSON records into the repository only when missing, with provenance and migration markers.
5. Keep Python `sara_memory.db` authoritative for Python-local agent state during the first migration step. Expose explicit bridge APIs for Node repository import/recall rather than sharing SQLite connections across processes.
6. Add deterministic local extraction for explicit memory commands before provider invocation. Basic identity/preferences must be saved locally and immediately.
7. Add a write queue for Node repository writes and conversation/message persistence. UI/audio paths should not await consolidation writes.
8. Parallelize independent startup reads: recent conversation, compact memory context, profile, and provider readiness. Do not parallelize writes without a serialized queue.
9. Add request-level performance events at WebSocket receipt, local recall completion, provider start, first token/audio, tool start/end, and final response.
10. Add schema versioning, WAL/busy timeout, atomic backups, corruption validation, and migration reports before redirecting all readers.

## Phase 0 Recommendation

Do not make a destructive database merge in one step. First implement the repository interface and observability, prove the active `/live` path uses it, then migrate cognitive/Python compatibility reads and writes incrementally. Keep existing APIs and UI unchanged.
