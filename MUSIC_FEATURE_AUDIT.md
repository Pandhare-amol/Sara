# SARA MUSIC CREATOR & DIGITAL ARTIST - PHASE 0 AUDIT

## 1. Existing Task System
SARA utilizes a centralized task management and execution system primarily found in:
- `src/core/tasks/taskManager.ts` & `src/core/tasks/taskContract.ts`: Defines `TaskExecutionStatus` (e.g., QUEUED, RUNNING, COMPLETED, WAITING_CONFIRMATION, FAILED), `TaskPriority`, and `TaskVerificationStatus`. The `TaskManager` class acts as the core event emitter and state manager for tasks.
- `server_task_manager.ts`: Contains the `TaskRunner` which polls tasks and routes execution to the `desktop_agent_bridge` via `callDesktopAgent`. It handles autonomy levels, required confirmations, and tool-specific verifications (like for file and browser operations). 
**Integration Strategy**: Music project states (like generating lyrics, vocals, mixing) should map directly into these task contracts. New tools must be registered and executed through this existing orchestrator, ensuring background execution doesn't block conversation.

## 2. Database Architecture
SARA uses SQLite databases:
- `data.db` and `sara_memory.db` initialized via `sql.js` in `server_state.ts` and `server_memory.ts`.
- The database is verified at startup (`startupManager.ts` and `healthChecks.ts`).
- There's also an IndexedDB context implementation for AGI (`agi/context.ts`).
**Integration Strategy**: Do not create a separate database. New tables/models for `music_projects`, `music_assets`, `music_tasks`, etc., need to be integrated into the existing `data.db` schema (using migrations if available or standard SQL initialization).

## 3. ToolRouter and ToolRegistry
Located in `src/core/tools/`:
- `ToolRouter` (`toolRouter.ts`) routes tool calls and maintains a `ToolRegistry` (`toolRegistry.ts`).
- Execution is orchestrated via `ExecutionOrchestrator` (`executionOrchestrator.ts`).
- `server_full.ts` and `server.ts` initialize a `desktopToolRouter` which binds to Python agents.
**Integration Strategy**: Music generation tools (e.g., `music_create_project`, `music_generate_lyrics`, `music_mix`) MUST be registered formally with schemas in the `ToolRegistry` and executed via the `ToolRouter` pipeline.

## 4. Memory System
- Episodic and working memory is persisted into `sara_memory.db`.
- Governed by `src/cognitive/episodicMemory.ts` and `server_memory.ts`.
**Integration Strategy**: Music project context can be saved securely into SARA's existing episodic memory to allow recalling context in future conversations without overwhelming the LLM prompt context window.

## 5. Provider Abstraction
- Currently, there is no generic `Provider` or `MusicGenerationProvider` interface found in the existing codebase. The existing ecosystem has `ApiGateway` for generic APIs, but nothing specific to music generation or audio synthesis.
**Integration Strategy**: We must create the `MusicGenerationProvider` and `VocalProvider` abstraction layers exactly as requested in Phase 3 & 4. Adapters will implement these interfaces to wrap external APIs, preventing hardcoded credentials.

## 6. Browser Agent & Social Integrations
- Desktop automation and browser integrations exist in the Python desktop agent: `browser_automation_suite.py`, `tools_browser.py`, `tools_youtube.py`, `social_intelligence.py`.
**Integration Strategy**: Publishing capabilities (YouTube, Instagram) should leverage these existing toolsets and API wrappers. The new publishing agents will orchestrate these existing tools rather than reinventing authentication or browser control from scratch.

## 7. Security and Confirmations
- The task runner already enforces an autonomy level guard (`WAITING_FOR_APPROVAL`) for dangerous tools.
**Integration Strategy**: Publishing content publicly and executing sensitive API endpoints will leverage the existing confirmation state in the task runner, keeping alignment with SARA's current security architecture.

---

**Conclusion**: The core SARA architecture is fully equipped to support background task execution, database persistence, and tool routing for the music studio feature. Phase 1 (Music Project foundation) can commence by introducing the necessary models into the existing task and database repositories.
