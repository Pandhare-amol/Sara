# SARA Agent Architecture Audit

**Audit date:** 2026-09-12  
**Scope:** Existing repository only. No runtime code was changed for this audit.  
**Migration intent:** Introduce one durable agent runtime around the current SARA system without replacing the UI, Gemini integration, Desktop Agent, ToolRouter, or existing feature implementations.

## Executive Summary

SARA is a production-oriented TypeScript/React/Electron application with a Python FastAPI Desktop Agent. The most complete active server path is `server_full.ts`; `server.ts` is a second, older/parallel server implementation with overlapping model, tool, and desktop routing. The frontend is served by Vite and loaded by Electron through `electron/main.cjs`; the production supervisor is `startup/startupManager.ts`.

The repository already contains most building blocks needed for a stateful runtime:

- Gemini request and Gemini Live integrations.
- Persistent conversations, sessions, tasks, tool calls, and audit events.
- A Node `ToolRouter` -> `ToolRegistry` -> adapter boundary.
- Canonical execution results, policy checks, retry policy, verification registries, and screen/filesystem verifiers.
- A Python Desktop Agent with the authoritative Windows tool registry and `/execute` boundary.
- Cognitive working, episodic, semantic, procedural, and autobiographical memory modules.
- Task contracts and a JSON-backed task repository with interrupted-task discovery.
- Startup supervision, health checks, process ownership checks, and Electron lifecycle management.

The main architectural gap is coordination, not missing feature breadth. Task lifecycle, planning, memory context, Gemini function calling, Python-agent execution, and verification are distributed across multiple partial systems. The migration should therefore add a durable graph runtime behind adapters, then move ownership incrementally. It must not create a second browser engine, memory database, desktop executor, or tool router.

## Active Runtime Map

### Production entry points

| Surface | Current owner | Evidence | Status |
|---|---|---|---|
| Production supervisor | `startup/startupManager.ts` | Starts/adopts backend, Desktop Agent, health checks, and Electron | Active production entry |
| Backend bundle | `server_full.ts` -> `dist/server.cjs` | `package.json` `build` and `start` scripts | Primary rich server path |
| Alternate backend | `server.ts` | Separate model/tool routes and server lifecycle | Parallel/legacy risk |
| Desktop UI | `main.tsx`, `src/App.tsx` | React/Vite entry and existing UI | Active; preserve |
| Electron shell | `electron/main.cjs`, `electron/preload.cjs` | BrowserWindow, backend loading, desktop capture bridge | Active; preserve |
| Windows automation | `desktop_agent/main.py` | FastAPI `/execute`, `/health`, `/capabilities`, registry loading | Authoritative implementation |

### Model and conversation systems

#### Gemini standard requests

- `server_full.ts` imports `GoogleGenAI` and calls `ai.models.generateContent` for normal model interactions and vision/API flows.
- `server.ts` contains a parallel implementation with its own `GoogleGenAI` calls.
- API keys are resolved server-side through `server_paths.ts`, `.env`/environment configuration, and configuration endpoints. The frontend does not own the Gemini key.

#### Gemini Live

- `server_full.ts` and `server.ts` both call `ai.live.connect` with `Modality.AUDIO`, function declarations, and `LiveServerMessage` handlers.
- Live session handling is coupled to each server's WebSocket/voice path and tool-call response flow.
- `src/lib/audio.ts`, `src/services/audio/*`, wake-word code, and voice identity modules support the client-side voice experience.
- Migration boundary: keep Gemini Live transport and audio behavior intact; expose task/runtime events through an adapter rather than replacing the Live session.

#### Conversation management

- `server_state.ts` provides durable conversation records, messages, sessions, task records, tool calls, and append/upsert helpers.
- `src/core/conversation/ConversationManager.ts` and `ConversationRepository.ts` provide a second typed conversation abstraction with title generation.
- `src/components/DesktopChatPanel.tsx` and `src/lib/desktopConversationStore.ts` provide desktop chat persistence and restoration.
- `server_full.ts` directly handles chat and conversation persistence, so the runtime must integrate at this boundary instead of bypassing it.

## Tool and Automation Ownership

### Node routing and execution

- `src/core/tools/toolRouter.ts` is the Node routing boundary. It resolves registry entries, applies `ToolPolicyEngine`, invokes a configured adapter, and normalizes results.
- `src/core/tools/toolRegistry.ts` stores owner and metadata contracts, including risk, confirmation, timeout, retry, permissions, and verification metadata.
- `src/core/tools/toolExecutor.ts` normalizes legacy results into `CanonicalToolResult`.
- `src/core/tools/initialization.ts` wires the current adapter and execution orchestrator.
- `src/core/tools/execution/executionOrchestrator.ts` runs a tool through the router and verification registry.
- `src/core/tools/verification/*` contains filesystem, screen, window, and registry-based verification implementations.
- `src/core/tools/retryPolicy.ts`, `structuredLogging.ts`, and `src/core/tools/policyEngine.ts` provide existing retry, observability, and safety middleware.

**Required future boundary:** `Agent Runtime -> existing ToolRouter.execute()`. No graph node may call Python tools, browser helpers, filesystem helpers, or renderer APIs directly.

### Tool registry and executor

- TypeScript `ToolRegistry` describes the Node routing contract and can seed known runtime tools.
- Python `desktop_agent/registry.py` is the executable Desktop Agent registry. `load_all()` imports tool modules into `TOOLS`.
- `desktop_agent/main.py` validates `/execute` requests, invokes the registered handler, and returns canonical compatibility fields.
- `server_full.ts` maintains a large `DESKTOP_TOOLS` allowlist and `callDesktopAgent()` HTTP transport to `127.0.0.1:8765`.

This is an intentional two-process boundary, not two competing executors. The Node registry must remain the policy/routing boundary; Python remains the Windows implementation owner.

### Browser automation

There are currently multiple browser-facing surfaces:

1. Python `desktop_agent/tools_browser.py` using Playwright and a persistent agent-owned browser state. This is the authoritative automation path for real browser work.
2. `src/components/BrowserAgent.tsx`, a renderer holographic/iframe-style UI with restricted-site handling and API-assisted YouTube search.
3. `src/agents/BrowserAgent.ts`, a TypeScript agent abstraction with Puppeteer/Playwright/simulated fallback logic.
4. `local-agent.js` and `scripts/playwright_screen_test.js`, supporting/local test or helper paths.

Migration risk: `src/agents/BrowserAgent.ts` can simulate when automation dependencies are unavailable and must not become the task executor. The future BrowserAgent subagent should adapt to Python Playwright tools and return verified results. The existing renderer BrowserAgent remains a UI feature.

### Desktop, screen, vision, camera, and voice

- Python tools under `desktop_agent/` own mouse, keyboard, windows, applications, files, screenshots, OCR, browser, and system operations.
- `desktop_agent/tools_screenshot.py` is the existing screenshot/screen-reading implementation; `desktop_agent/screen_monitor.py` provides monitoring.
- `src/services/ScreenPerceptionEngine*`, `src/vision/*`, and `src/components/CameraPanel.tsx` support camera/vision flows.
- `src/App.tsx` contains screen sharing and the `/api/vision/screen-capture` browser-compatible fallback; Electron uses `desktopCapturer` through `electron/main.cjs` and `preload.cjs`.
- Voice input/output spans `src/lib/audio.ts`, `src/services/audio/*`, wake word detection, speaker identity, Gemini Live, and TTS-related service code.

Migration risk: screen capture has both renderer media capture and Desktop Agent capture. These serve different UI/runtime contexts; the graph must consume an observation adapter, not introduce another screenshot loop.

## Memory and Context Systems

### Existing memory owners

- `server_memory.ts` is a server-facing JSON memory service with load/save, search, decisions, questions, and conversation-slice processing.
- `src/services/MemoryService.ts` is an in-memory typed store for episodic, semantic, procedural, preference, failure, achievement, and autobiographical records.
- `src/cognitive/workingMemory.ts`, `episodicMemory.ts`, `semanticMemory.ts`, `proceduralMemory.ts`, `autobiographicalMemory.ts`, and `memoryConsolidator.ts` implement the newer cognitive memory model.
- `src/cognitive/orchestrator.ts` retrieves selective episodic, semantic, procedural, and autobiographical context and builds a `CognitiveContext`.
- `src/services/MemoryRepository.ts` and `MemoryPersistence*` add persistence-oriented service abstractions.
- RAG/indexing and knowledge services are registered through the Python platform tools and Node API adapters.

The cognitive modules are the best migration target for selective working/episodic/semantic retrieval, but they are not yet the sole persistence owner. The runtime must define a memory adapter and preserve existing stores during migration. It must never inject entire JSON/database contents into Gemini prompts.

### Persistence stores observed

- JSON data under `data/` and root compatibility JSON files for conversations, sessions, memories, tasks, tool calls, and profiles.
- `data/sara_memory.db` and other SQLite/SQL.js-oriented memory artifacts.
- `src/core/tasks/TaskRepository` defaults to `data/task-state.json`.
- Logs and audit JSON/JSONL under `data/logs` and `logs`.

Migration risk: multiple stores may describe the same concept. The first runtime phase should use explicit adapters and correlation IDs, not silently merge or delete stores.

## Task Lifecycle and Orchestration

### Existing typed task model

`src/core/tasks/taskContract.ts` already defines a richer lifecycle than a boolean:

`CREATED`, `QUEUED`, `RUNNING`, `WAITING_CONFIRMATION`, `EXECUTED`, `VERIFYING`, `COMPLETED`, `FAILED`, `TIMEOUT`, `CANCELLED`, `RECOVERING`, `BLOCKED`, `WAITING_FOR_PROVIDER`, `WAITING_FOR_APPROVAL`, `PAUSED`, and `RECOVERABLE`.

`TaskExecution` already carries task ID, correlation ID, conversation/session IDs, tool call ID, arguments, attempts, priority, verification status/result, errors, recovery state, parent/child tasks, and user-visible status.

`TaskRepository` persists task state to JSON, exposes active/previous tasks, and identifies interrupted `RUNNING`, `VERIFYING`, `RECOVERING`, and `QUEUED` tasks. `TaskManager` creates, queues, runs, updates, cancels, retries, completes, fails, and recovers task records.

### Existing parallel/partial orchestrators

- `src/core/automation/AutomationOrchestrator.ts` coordinates async automation tools and task contexts.
- `src/core/execution/ExecutionEngine` and `ExecutionOrchestrator` perform execution/verification.
- `src/cognitive/orchestrator.ts` coordinates cognitive memory/planning, but does not own the full executable task graph.
- `src/services/AgentRegistry.ts` and `AgentSupervisor.ts` provide agent lifecycle concepts.
- Python `desktop_agent/agents.py` and platform core include multi-agent/task orchestration endpoints.
- `server_task_manager.ts` and `desktop_agent_bridge.ts` provide a separate task-runner injection path.

These are integration surfaces, not candidates for wholesale replacement. LangGraph should become authoritative only after adapters are added around them and regression tests prove parity.

## Security, Confirmation, Verification, and Recovery

- `src/core/tools/policyEngine.ts` centrally classifies registered tools as `ALLOW`, `ASK_USER`, or `DENY` based on risk, confirmation, authorization, and domain policy.
- `ToolRegistry` infers destructive/external-side-effect risk from names and supports explicit metadata.
- `server_state.ts`, `src/services/ConfirmationWorkflow*`, and `/api/confirm/*` provide confirmation records/tokens.
- Power actions use a request-token then execute-token flow in the Node/Python boundary.
- `src/core/tools/verification/*` and `src/core/verification/verificationEngine.ts` provide result verification.
- `server_full.ts` includes retry routes and task retry policy; Desktop Agent canonical results carry verification and retryability.
- Startup `processGuard`, health checks, service manager, and Desktop Agent controller handle process/service recovery.

Important risk: the policy engine currently derives confirmation from request arguments/context. The future runtime must persist a `WAITING_FOR_APPROVAL` state and bind approval to task/correlation/tool identity; it must never treat SARA's own generated text as user approval.

## Startup, Services, Electron, and Data Boundaries

- `startup/startupManager.ts` supervises one SARA instance, validates configuration, starts/adopts services, checks health, and launches Electron.
- `startup/processGuard.ts`, `serviceManager.ts`, `desktopAgentController.ts`, `healthChecks.ts`, and `startupState.ts` provide ownership and service-state tracking.
- `electron/main.cjs` launches/owns the backend when standalone, exposes desktop capture IPC, and loads `http://127.0.0.1:3000`.
- `electron/preload.cjs` exposes a minimal `window.sara` bridge with screen-source/capture functions.
- `server_paths.ts` centralizes data and secret paths; production Electron sets a writable per-user data directory.

Migration risk: development (`tsx server_full.ts`), production bundle (`dist/server.cjs`), supervisor, and Electron standalone modes can initialize different service combinations. Runtime startup/resume behavior must be tested in each supported mode.

## Duplicate, Deprecated, and Compatibility Surfaces

### Duplicate or overlapping active systems

- `server.ts` and `server_full.ts`: overlapping backend/model/live/tool implementations. `server_full.ts` is the richer package-script path; `server.ts` remains a migration risk until callers are proven absent.
- `server_memory.ts`, `MemoryService`, cognitive memory classes, and persistence repositories: overlapping memory abstractions.
- `TaskRecord`/JSON task helpers in `server_state.ts`, `TaskExecution`/`TaskRepository`, `server_task_manager.ts`, and Python task services: overlapping task representations.
- `src/agents/BrowserAgent.ts`, renderer `BrowserAgent.tsx`, Python Playwright tools, and local Playwright helpers: different browser surfaces with overlapping names.
- TypeScript `DesktopAgent.ts` and Python Desktop Agent: TypeScript is a capability/lifecycle abstraction; Python is the actual Windows executor.
- `AutomationOrchestrator`, `ExecutionOrchestrator`, cognitive orchestrator, Python orchestrator, and task manager: partial orchestration layers.

### Deprecated or compatibility paths

- Legacy fields in Python `_canonical_result` are explicitly marked for future removal.
- Renderer/iframe browser projection is a UI feature and must not be promoted to the authoritative browser executor.
- Simulated browser fallback in `src/agents/BrowserAgent.ts` must remain non-authoritative and must never report real success.
- Root compatibility JSON files and generated logs should not become new runtime state owners.

## LangGraph/LangChain Strategy

The current `package.json` does not contain LangGraph or LangChain dependencies. No AutoGen dependency was found in the active package contract. The migration should add LangGraph only in a dedicated runtime layer after the contracts are designed.

Recommended ownership:

```text
Conversation / Gemini Live
          |
          v
SARA Agent Runtime (LangGraph state + durable checkpoints)
  plan -> policy -> execute -> observe -> verify -> recover/resume
          |
          v
Existing ToolRouter.execute()
          |
          +--> Node-owned adapters
          +--> Python Desktop Agent HTTP adapter
          +--> existing verification and persistence adapters
```

LangChain should be limited to model/tool/retrieval integrations where useful. It must not introduce a second router or executor. AutoGen must not be introduced into the core runtime.

## Migration Risks

1. **Dual server ownership:** changes made only in `server.ts` or only in `server_full.ts` can produce mode-specific regressions.
2. **State split:** task state may be written to `server_state` JSON, `TaskRepository`, Python state, or logs without a shared checkpoint identity.
3. **Unverified success:** several capability metadata entries use placeholder verification callbacks; graph completion must require actual verification for important actions.
4. **Confirmation ambiguity:** approval must be durable and cryptographically/task-bound, not inferred from assistant output.
5. **Browser duplication:** renderer and Python browser paths have different purposes; selecting the wrong one can lead to simulated or iframe-only behavior.
6. **Desktop restart recovery:** Node transport retries and startup supervision exist, but task-level resume semantics are not yet one protocol.
7. **Persistence failure handling:** some repositories swallow persistence errors and continue in memory, which is unsafe for critical task state.
8. **Model/live coupling:** Gemini Live handlers and tool declarations are embedded in server paths; extracting runtime calls must preserve audio/session behavior.
9. **Generated data contamination:** runtime logs, browser profiles, caches, databases, and installer outputs can be mistaken for source-of-truth state.
10. **Dependency/runtime compatibility:** adding LangGraph/LangChain must fit the existing TypeScript/Node/Vite/esbuild and Electron packaging model without creating a second language runtime.

## Proposed Incremental Migration Order

1. **Audit and freeze contracts:** preserve this document and add architecture contracts without runtime replacement.
2. **State adapter:** define a strongly typed `SARAState` and map it to `TaskExecution`, conversation records, memory retrieval results, tool-call records, and environment snapshots.
3. **Checkpoint adapter:** persist state transitions durably with atomic writes and explicit recovery/error reporting.
4. **Tool adapter:** connect graph execution only to `ToolRouter.execute()` and its existing policy/verification pipeline.
5. **Planner adapter:** use existing cognitive planner first; introduce LangGraph planning nodes around it rather than replacing it.
6. **Recovery/resume:** restore nonterminal tasks on startup and continue from the last persisted verified boundary.
7. **Conversation bridge:** run background graph tasks asynchronously while preserving chat/voice responsiveness.
8. **Specialized subagents:** add only adapters for genuinely separate responsibilities, with Python Desktop Agent and Python browser automation remaining authoritative.
9. **Observability and tests:** correlation IDs, state transition logs, checkpoint tests, failure/recovery tests, and real boundary integration tests.
10. **Only after parity:** consider retiring redundant paths based on evidence and migration reports.

## Required Runtime Contracts for Next Phase

- `SARAState` must contain session/conversation/user/task identity, goal, plan, step state, observations, tool calls/results, verification, permissions, working/retrieved memory, environment/browser/desktop state, summary, recovery attempts, status, and timestamps.
- Every state transition must be persisted before the next external side effect.
- Every tool call must carry task ID, correlation ID, tool call ID, timeout, policy decision, result, verification result, and failure/retry metadata.
- A graph node may not call implementation modules directly; it must use adapters, especially the existing `ToolRouter`.
- A task may complete only after required verification is `VERIFIED` or an explicit `NOT_REQUIRED` policy is recorded.
- Recovery must classify failures and either retry safely, re-observe, use an approved alternative, restart an affected service, ask the user, or terminate honestly.
- Conversation handling and task execution must be separate asynchronous workflows sharing persisted state and events.

## Audit Conclusion

The repository is suitable for an incremental LangGraph migration, but not for a wholesale rewrite. The correct first implementation slice is a TypeScript agent-runtime contract and durable state/checkpoint adapter that wraps the existing `ToolRouter`, `TaskRepository`, conversation persistence, cognitive retrieval, and verification registry. Gemini, Gemini Live, Electron, Python Desktop Agent, browser automation, and the existing UI should remain behind adapters until end-to-end parity tests pass.

No runtime implementation was changed during this audit.