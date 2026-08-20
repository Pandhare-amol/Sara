# SARA Architecture Audit

Audit date: 2026-08-19
Scope: Existing SARA / MYRAA desktop assistant before incremental architecture migration.

## Executive Summary

SARA is a Windows-focused modular monolith composed of an Electron renderer, a Node/TypeScript backend, a Python/FastAPI Desktop Agent, a startup supervisor, and several parallel memory/cognitive implementations. The system already has real desktop automation, real MSS/PIL capture, Win32/UI Automation access, Gemini Live integration, persistent SQLite/JSON state, task recovery, safety controls, and broad test coverage.

The principal architectural risk is not missing functionality. It is split ownership:

- `server.ts` and `server_full.ts` are parallel Node backend surfaces.
- `data.db`, `sara_memory.db`, JSON files, and several cognitive JSON stores coexist.
- Python `desktop_agent` is the authoritative real Windows execution path, while some TypeScript services still contain placeholder implementations.
- Tool registry, bridge routing, task execution, and verification are implemented in more than one layer.
- Configuration reads are distributed across `process.env`, `.env`, startup config, and service-specific modules.

The safest migration is adapter-first: preserve current entry points and UI, establish contracts and ownership boundaries, then route existing implementations through them incrementally.

## Current Runtime Architecture

```text
start-sara-prod.bat / npm run start:prod
        |
        v
startup/startupManager.ts
  - supervisor lock
  - config validation
  - integrity checks
  - process ownership/adoption
  - backend health
  - Desktop Agent health
  - Electron launch
        |
        +--> Node backend: server_full.ts -> dist/server.cjs, port 3000
        |      - Express REST APIs
        |      - WebSocket `/live`
        |      - Gemini Live / tool calling
        |      - task and conversation routes
        |      - bridge to Python `/execute`
        |
        +--> Python Desktop Agent: desktop_agent/main.py, port 8765
        |      - FastAPI lifecycle
        |      - registry and tool dispatch
        |      - Windows/UI Automation
        |      - browser automation
        |      - memory/platform services
        |      - verification/reward systems
        |      - live MSS/PIL screen monitor
        |
        +--> Electron: electron/main.cjs
               - single-instance lock
               - renderer window/tray
               - backend loading
               - native screen capture IPC
               - external URL IPC
```

Development commonly uses `server.ts` through `tsx`; production build uses `server_full.ts` through the `npm run build` esbuild target. This divergence is a migration risk and must be resolved through shared modules or an explicit build/source policy, not an immediate rewrite.

## Existing Components

### Electron and Renderer

- Entry: `electron/main.cjs`
- Renderer entry: `src/main.tsx`, `main.tsx`, `App.tsx`, `src/App.tsx`
- Existing UI: React, motion animations, SARA visualizer, chat, conversations, memory dashboard, settings, browser, camera/gesture panels, task controls.
- Preload/IPC: Electron native capture, screen sources, external URL opening, notifications/tray support.
- UI preservation rule: `src/App.tsx` already has a toast path; new backend events should use existing toast/event mechanisms rather than redesigning the UI.

### Node/TypeScript Backend

- Primary source surfaces: `server.ts`, `server_full.ts`
- Transport: Express HTTP plus `ws` WebSocket server at `/live`.
- REST families include health, memories, settings, chat, agent health, orchestration, tasks, companion, camera, conversations, logs, YouTube, vision, desktop execution, cognitive routes, and diagnostics.
- State helpers: `server_state.ts`, `server_memory.ts`, `server_paths.ts`, `server_logger.ts`.
- Task bridge: `server_task_manager.ts`, `desktop_agent_bridge.ts`.
- Cognitive APIs: `src/cognitive/routes.ts` and TypeScript cognitive memory modules.

### Python Desktop Agent

- Entry: `desktop_agent/main.py`
- Registry: `desktop_agent/registry.py`; `load_all()` discovers/registers modules into `TOOLS` and `TOOL_REGISTRY`.
- Protocol: `POST /execute`, `GET /health`, `GET /capabilities`, capability diagnostics, perception, awareness, conversation, proactive, personality, quiet mode, interruption, feedback, shutdown, orchestration, vision, companion, STT, and live screen endpoints.
- Tools: application, browser, file, window, hardware, camera, screen/OCR, semantic UI, YouTube, WhatsApp, email, RAG, memory, learning, goals, workflows, security, services, gestures, and multi-agent orchestration.
- Real desktop adapters: `tools_windows.py`, `tools_window_extra.py`, `tools_applications.py`, `tools_hardware.py`, `perception.py`, `tools_screenshot.py`, `screen_monitor.py`.

### AI / Model Integration

- Google Gemini Live is imported in `server.ts` and `server_full.ts` through `@google/genai`.
- SARA system prompt and voice profile are loaded through `SARA_SYSTEM_PROMPT.md`, `src/config/saraProfile`, and backend prompt composition.
- Current repository evidence is strongest for Gemini; no complete provider-neutral router is currently wired for Groq/OpenAI/local models.
- `src/brain/SARACognitiveBrain.ts` provides intent/decision abstractions but uses simplified pattern matching and is not the sole runtime authority.

### Memory Systems

1. Node file memory: `server_memory.ts`, `memories.json`.
2. Node SQL state: `server_state.ts`, `data.db` via sql.js; conversations, messages, tasks, sessions, tool calls, audit, idempotency.
3. Python durable memory: `desktop_agent/sqlite_memory.py`, `sara_memory.db`.
4. Python platform wrapper: `desktop_agent/platform_core.py::MemoryManager` with typed memory metadata, deduplication, projects, skills, workflows, recovery, RAG, and learning.
5. TypeScript cognitive stores: `src/cognitive/episodicMemory.ts`, `semanticMemory.ts`, `proceduralMemory.ts`, `autobiographicalMemory.ts`, `memoryConsolidator.ts`, `strategyManager.ts` and related JSON files.
6. TypeScript in-memory service: `src/services/MemoryService.ts` and `MemoryPersistenceService.ts`; useful abstractions, but not currently the authoritative desktop persistence path.

Migration implication: create a `MemoryService` adapter around the authoritative stores first. Do not delete or silently merge data stores until import, conflict, backup, and rollback are tested.

### Task System

- Node persistent task records: `server_state.ts`, `tasks` table/JSON compatibility, `server_task_manager.ts`.
- Python orchestration: `desktop_agent/agents.py`, `tools_multi_agent.py`, platform recovery/checkpoints.
- TypeScript closed-loop model: `src/services/ClosedLoopExecutor.ts`, `ClosedLoopTask` types, learning coordinator.
- Background Python tasks: `desktop_agent/tools_background.py`.
- Existing task states include queued/planning/running/waiting/paused/retrying/completed/failed/cancelled/recovering/partial/timed_out/blocked/awaiting_confirmation.

Risk: status normalization and execution ownership differ between Node task runner, Python multi-agent manager, and TypeScript closed-loop services.

### Desktop Agent Communication

```text
SARA/Electron UI
  -> Node `/live` WebSocket or REST
  -> Node callDesktopAgent()
  -> HTTP POST 127.0.0.1:8765/execute
  -> Python registry handler
  -> real Windows/browser/filesystem operation
  -> Python verification/reward
  -> canonical result
  -> Node/Gemini/UI
```

Correlation fields now include request/operation IDs in the Python canonical result path. Capability discovery is exposed from Python and consumed by the Node bridge, but the legacy TypeScript tool list remains as a compatibility seed and should eventually be generated/validated from the contract.

### Live Screen and Perception

Authoritative real path:

- `desktop_agent/screen_monitor.py`: persistent MSS/PIL capture session, first-frame readiness, frame hash/change detection, adaptive OCR interval, bounded event buffer, recovery counters, multiple-monitor discovery, live health.
- `desktop_agent/situational_awareness.py`: active window/process state, activity metrics, accessibility elements, dialogs, live monitor state, autonomous awareness synchronization, proactive opportunity gating.
- `desktop_agent/perception.py`: Windows UI Automation first, OCR fallback, semantic target resolution.
- Electron native capture remains available through `electron/main.cjs` IPC for existing UI sharing.

Non-authoritative/partial path:

- `src/services/ScreenPerceptionEngine.ts` still contains placeholder screenshot/OCR/window/cursor behavior and must become a transport adapter to the Python/Electron real state, not a second implementation.

### Startup and Health

- `startup/startupManager.ts`: supervisor lifecycle and lock.
- `startup/processGuard.ts`: ownership/adoption/restart.
- `startup/healthChecks.ts`: service checks.
- `startup/desktopAgentController.ts`: Desktop Agent control and critical capability checks.
- `startup/electronLauncher.ts`: Electron launch.
- `startup/configValidator.ts`: environment, Python, uvicorn, ports, entry files.
- `startup/doctor.ts`: operational status/doctor/stop/restart.

## Ports and Processes

- Node backend / renderer origin: `127.0.0.1:3000`
- Python Desktop Agent: `127.0.0.1:8765`
- Electron notify server: `127.0.0.1:43123`
- Additional browser/local-agent support may use port `3001` according to browser comments and repository files.
- Processes: supervisor `tsx`, Node backend, Python/uvicorn or frozen agent executable, Electron, optional Playwright browser, optional camera/vision workers.

## Existing Databases and Files

- `data/data.db`: sql.js Node state, schema version, conversations/messages/tasks/sessions/tool calls/audit/idempotency.
- `data/sara_memory.db` or configured `SARA_DATA_DIR/sara_memory.db`: Python memory, verification, personality, activity, awareness, events, tasks, rewards and related tables.
- JSON compatibility/persistence: `conversations.json`, `sessions.json`, `tasks.json`, `tool_calls.json`, `memories.json`, cognitive memory JSON files, RAG files, strategies.
- Backups: Python memory backup support and TypeScript memory snapshot backups exist, but coverage and authority are not uniform.

## Current Strengths

- Real Windows process/window/input operations.
- Real Python registry with broad tool coverage.
- Structured capability discovery and canonical Python result contract.
- Real MSS/PIL continuous capture with recovery and health metrics.
- UI Automation plus OCR fallback for target resolution.
- Gemini Live tool calling and streaming audio path.
- Startup ownership/adoption and bounded process recovery.
- Existing safety confirmation paths for power, destructive, message, credential, and security operations.
- Persistent task/conversation/tool-call state and cognitive modules.
- Existing real-desktop test suites and Python unit tests.
- UI is already feature-rich and should be preserved.

## Partial or Broken Areas

- `src/services/ScreenPerceptionEngine.ts` is placeholder-based and can mislead consumers if treated as authoritative.
- Node backend source/build split (`server.ts` vs `server_full.ts`) creates drift risk.
- Multiple memory stores lack one ownership contract and unified startup restoration.
- Task statuses and verification are duplicated across TypeScript, Node, and Python.
- `server_task_manager.ts` contains separate verification helpers; Python has `verification.py`; TypeScript brain has another verification interpretation.
- Model provider routing is not provider-neutral; Gemini is the clear active provider.
- Some desktop tool handlers still return legacy plain dictionaries and rely on outer normalization.
- Browser verification is weaker than filesystem/window verification in parts of the TypeScript task runner.
- Configuration is spread across direct `process.env` reads and startup config.
- Structured logging/metrics/tracing are incomplete and partly best-effort text logs.
- Some Python managers use relative `sara_memory.db` paths instead of `data_root()`, risking split databases depending on working directory.
- Existing startup health checks can report degraded timing while services become healthy shortly afterward.

## Duplicated Functionality and Tight Coupling

- Node server source duplication: `server.ts` and `server_full.ts`.
- Memory: Node JSON/sql.js, Python SQLite/platform memory, TypeScript cognitive files/service.
- Perception: Electron capture, Python live monitor, Python semantic perception, TypeScript placeholder screen engine.
- Verification: Python canonical engine, Node task verification helpers, TypeScript `SARACognitiveBrain.verifyResult`, tool-local verified flags.
- Tool routing: hard-coded Node compatibility set, Python registry, TypeScript task bridge, Python agent manager routes.
- Background workers: state watcher, situational awareness, activity monitor, event monitor, autonomous decision engine, proactive engines, browser loop, screen monitor.

## Migration Risks

1. Changing `server.ts` or `server_full.ts` without checking both development and production paths.
2. Migrating memory without preserving `data.db`, `sara_memory.db`, JSON, and cognitive files.
3. Replacing Python desktop behavior with TypeScript abstractions and losing Windows verification.
4. Adding another background polling loop and increasing CPU/race conditions.
5. Normalizing result statuses in a way that changes existing UI/Gemini tool responses.
6. Changing Electron preload/IPC without testing packaged and development paths.
7. Treating browser “command sent” as verification.
8. Altering safety/confirmation behavior while introducing adapters.
9. Schema changes without backup, migration version, and rollback.
10. Logging sensitive arguments or API keys during observability work.

## Files to Protect Initially

- `App.tsx`, `src/App.tsx`, `src/index.css`, existing UI components: preserve visual behavior.
- `electron/main.cjs` and preload/IPC: change only with focused compatibility tests.
- `server.ts`, `server_full.ts`: avoid broad edits until shared ownership is established.
- `desktop_agent/tools_*.py`: preserve public names/arguments; wrap before refactoring.
- Existing data files/databases: never delete or reset automatically.
- `startup/*`: preserve ownership, lock, adoption, and shutdown semantics.

## Safe Initial Migration Points

- Add architecture contracts under `src/core/contracts` without moving existing files.
- Add a Node `DesktopAgentAdapter` that delegates to the current `callDesktopAgent`.
- Add a `ToolResult` compatibility normalizer around Python/legacy results.
- Add a single event bus adapter around existing task/desktop/monitor events.
- Make `ScreenPerceptionEngine` delegate to `/screen/live/state` and `/screen/live/*` APIs.
- Add a `MemoryService` facade that reads/writes the current authoritative stores with explicit source metadata.
- Add model-provider interfaces around current Gemini calls before adding fallback providers.
- Add observability at bridge/task boundaries using existing IDs and audit logger.

## Recommended Migration Plan

### Phase 0: Audit and compatibility baseline

- Keep this audit and add the feature matrix.
- Record current startup/build/test commands.
- Add contract tests for existing `/health`, `/capabilities`, `/execute`, `/live`, memory, and task routes.

### Phase 1: Shared contracts

- Define TypeScript interfaces for tool results, execution states, verification, task events, model requests, memory records, and desktop state.
- Keep adapters backward compatible.

### Phase 2: Tool and Desktop Agent adapter

- Treat Python registry/capabilities as authoritative.
- Wrap legacy Node calls with request IDs, timeouts, structured errors, retry policy, and capability validation.
- Preserve existing names and arguments.

### Phase 3: Verification and recovery

- Route important operations through one Node/Python verification contract.
- Add safe retry classification and post-failure observation.
- Keep dangerous operations non-retryable without confirmation.

### Phase 4: State/event integration

- Publish task/tool/screen/window/memory events through one internal adapter.
- Connect the existing UI toast/event path without redesign.

### Phase 5: Memory facade and migration

- Use Python/SQLite and existing Node state deliberately by domain.
- Add backup, schema versioning, integrity checks, provenance, and conflict rules.
- Do not remove legacy stores until migration reports prove equivalence.

### Phase 6: Model router

- Wrap current Gemini provider first.
- Add provider health/capability interfaces and offline command fallback.
- Do not add providers until request/result/error contracts are tested.

### Phase 7: Task orchestration

- Make `server_task_manager.ts` the Node task boundary or explicitly delegate to the existing closed-loop executor.
- Normalize statuses and persist progress/checkpoints.

### Phase 8: Native/live screen adapter

- Make TypeScript `ScreenPerceptionEngine` consume the real Python/Electron state.
- Preserve browser screen sharing for explicit user sharing.
- Do not add a second capture loop.

### Phase 9: Observability and production hardening

- Structured logs, metrics, correlation IDs, redaction, health details, crash recovery, concurrency/resource limits, and deployment documentation.

## Files That Can Safely Be Added

- `src/core/contracts/*`
- `src/core/adapters/*`
- `src/core/events/*`
- `src/core/observability/*`
- `docs/architecture/*`
- compatibility and integration tests

## Audit Conclusion

SARA is already a viable real-world desktop assistant foundation. The correct production architecture is a modular compatibility layer around existing authoritative implementations, not a rewrite. The first implementation priorities are contract unification, source-of-truth selection, TypeScript placeholder delegation to the real Python/Electron state, and migration-safe observability.
