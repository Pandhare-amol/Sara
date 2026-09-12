# SARA Human-Agent Architecture Audit

Date: 2026-08-24
Scope: Existing SARA repository before the human-agent migration
Status: Audit complete; runtime code intentionally unchanged during this phase

## Executive Summary

SARA is an existing Windows desktop assistant composed of an Electron shell, React/Vite renderer, Node/TypeScript backend, Python/FastAPI Desktop Agent, Gemini Live integration, local persistence, and mobile companion surfaces. The safest migration is adapter-first. The project already has real OS, browser, screen, camera, memory, task, and security entry points, but ownership is split and success reporting is not uniformly backed by independent observation.

The production path is:

```text
Windows logon
  -> startup/startupManager.ts
  -> server_full.ts bundled as dist/server.cjs on port 3000
  -> desktop_agent/main.py on port 8765
  -> Electron electron/main.cjs
  -> React/Vite UI

Conversation/audio:
  React audio transport -> Node /live WebSocket -> Gemini Live
  Gemini tool call -> Node ToolRouter -> HTTP POST /execute
  Python registry -> existing Windows/browser/device handler
```

Primary risks before declaring the target architecture complete:

- Browser ownership is split between an iframe/proxy renderer, OS default-browser launchers, and a separate Playwright browser.
- There are parallel Node backends (`server.ts` and `server_full.ts`) and multiple task, memory, and orchestration systems.
- Several tools return success-like payloads without an independent postcondition check.
- Browser state exists, but session identity and tab state are not durably unified with Node tasks or the UI.
- Gemini disconnect accounting exists, but full reconnect/context restoration is incomplete.
- User model, relationships, provider abstraction, and centralized permission policy are not yet authoritative subsystems.
- Some application and service integrations are scaffolds that report queued/prepared work instead of performing and verifying the real-world action.

## Status Legend

- WORKING: Concrete implementation exists and has local or integration evidence.
- PARTIAL: Some real behavior exists, but coverage, ownership, or verification is incomplete.
- BROKEN: Current path cannot satisfy the requested behavior reliably.
- DUPLICATED: More than one competing implementation or authority exists.
- PLACEHOLDER: Returns simulated, planned, queued, or canned behavior instead of performing the requested action.
- UNSAFE: Missing, bypassable, or inconsistent authorization/confirmation.
- SLOW: Blocking, polling, or high-latency behavior is visible in the path.
- UNKNOWN: No sufficient code/test evidence was found during this audit.

A feature can have more than one status.

## Component Audit

| Subsystem | Status | Evidence and finding |
|---|---|---|
| Electron shell | WORKING, PARTIAL | `electron/main.cjs` creates the window, enforces a single instance, loads the backend URL, handles native screen IPC, and can own backend startup. Browser tabs are not owned here. |
| React/Vite UI | WORKING, PARTIAL | `src/App.tsx`, `App.tsx`, `src/main.tsx`, and components provide chat, voice, settings, browser, camera, vision, tasks, and companion surfaces. Browser UI is not the authoritative browser engine. |
| Node backend | WORKING, DUPLICATED | `server_full.ts` is the production bundle source; `server.ts` is a parallel runtime source. Both contain Gemini, REST, WebSocket, tool lists, and Desktop Agent bridges with drift risk. |
| Startup manager | WORKING | `startup/startupManager.ts`, `startup/processGuard.ts`, `startup/healthChecks.ts`, and `startup/electronLauncher.ts` supervise service order, health, ownership, Electron launch, and stale process handling. Windows registration now targets `start-sara-silent.bat`. |
| Desktop Agent lifecycle | WORKING, PARTIAL | `startup/desktopAgentController.ts` and the supervisor start/health-check the Python agent. Some paths intentionally skip auto-start when `SARA_SUPERVISOR` is set; recovery and ownership should remain one authority. |
| Python Desktop Agent | WORKING | `desktop_agent/main.py` exposes `/health`, `/capabilities`, `/tools`, `/execute`, browser state, screen, orchestration, and companion APIs. Tool modules are loaded through `desktop_agent/registry.py`. |
| ToolRouter | WORKING, PARTIAL | `src/core/tools/toolRouter.ts` is the TypeScript controlled entry point and normalizes routed results. Production bridge behavior is also directly present in Node and Python, so authority should be made explicit rather than replaced. |
| ToolRegistry/Executor | WORKING, DUPLICATED | `src/core/tools/toolRegistry.ts`, `toolExecutor.ts`, Python `TOOLS`, and several suite-level dispatchers coexist. Preserve all routes while consolidating policy and result contracts around the existing router. |
| Gemini integration | WORKING, PARTIAL, DUPLICATED | `server.ts` and `server_full.ts` use `@google/genai` and Gemini Live. Session persistence/reconnect counters exist, but complete reconnect and context restoration are not proven. |
| AI provider abstraction | BROKEN, PLACEHOLDER | Gemini is directly imported in server code. No provider-neutral `AIProvider` boundary is authoritative for generate/stream/plan/vision/classify/summarize. |
| Audio transport | WORKING | `src/lib/audio.ts` handles WebAudio PCM conversion, WebSocket transport, transcript events, tool calls, and playback scheduling. It is a transport/session layer, not a complete provider abstraction. |
| Wake-word/STT | PARTIAL, UNKNOWN | `src/lib/wakeWord.ts` uses browser Web Speech recognition with restart/debounce behavior. Python has an STT endpoint/test helper, but the authoritative production STT selection and end-to-end device behavior require further verification. |
| TTS | PARTIAL, UNKNOWN | Audio output/playback paths exist and Gemini audio is forwarded, but a single explicit TTS owner, voice policy, fallback, interruption contract, and measured latency path were not established in this audit. |
| Voice identity | PARTIAL | `src/core/identity/voiceIdentity.ts` and settings enrollment/matching provide opt-in local fingerprint storage and matching. This is not authentication and must remain behind confirmation for sensitive operations. |
| Personality | PARTIAL, DUPLICATED | Personality guidance is embedded in `server_full.ts`, `server.ts`, `SARA_SYSTEM_PROMPT.md`, and `src/config/saraProfile`; `desktop_agent/proactive_interaction.py` also holds emotional/proactive state. No dedicated authoritative `PersonalityEngine` exists. |
| User model | BROKEN, PLACEHOLDER | Preferences and memories exist, but no authoritative persistent `UserModel` with explicit identity, language, communication style, habits, devices, and permission preferences was found. |
| Relationships/contacts | PARTIAL | Relationship memory categories and service/browser surfaces exist. Explicit structured relationship resolution such as `Mom -> contact` is not one authoritative, verified subsystem. |
| Memory overall | PARTIAL, DUPLICATED | Node `server_memory.ts`, Node sql.js `server_state.ts`, Python `platform_core.py`, Python SQLite/JSON stores, TypeScript cognitive memory modules, and compatibility JSON files coexist. Retrieval exists but ownership is split. |
| Cognitive context | WORKING, PARTIAL | `src/cognitive/orchestrator.ts` retrieves working, episodic, semantic, procedural, and autobiographical context with bounded limits. It is not the sole context builder used by all live requests. |
| Planning | PARTIAL, DUPLICATED | `src/cognitive/planner.ts`, Python `TaskPlannerAgent`, application/browser/OS suites, and server task inference each plan or infer actions. Some plans contain generic observation/action placeholders rather than executable verified steps. |
| Task engine | PARTIAL, DUPLICATED | `server_task_manager.ts`, `src/core/automation/automationOrchestrator.ts`, Python `agents.py`, `tools_background.py`, and cognitive execution flows all manage tasks. Persistence and status semantics differ. |
| Task continuity | PARTIAL | `taskContext.ts`, Node task persistence, Python recovery, and Gemini session records exist. Full restore from browser/agent/network/Gemini failure from last verified step is not proven across all paths. |
| Background execution | WORKING, PARTIAL | Node and Python background paths exist; `AutomationOrchestrator` runs asynchronously and has browser serialization. Some tools remain blocking or use synchronous wrappers. |
| Observation/verification | PARTIAL, DUPLICATED | TypeScript `VerificationRegistry`, `ScreenVerifier`, Python canonical results, browser state, media state, and task verification helpers exist. Tool-returned `verified` fields are not uniformly independent evidence. |
| Browser engine | WORKING, DUPLICATED | `desktop_agent/tools_browser.py` is a real persistent Playwright Chromium context. Renderer `BrowserAgent` uses iframe/proxy behavior, and default-browser tools use `webbrowser`, creating multiple browser authorities. |
| Browser session manager | PARTIAL, DUPLICATED | `desktop_agent/browser_session.py` provides persistent Firefox profile/session classification, while `tools_browser.py` has a separate Chromium singleton and `browser_automation_suite.py` has an in-memory session label manager. |
| Browser tabs/navigation | WORKING, PARTIAL | Playwright open, navigate, tab, close, search, back, forward, reload, click, type, forms, scroll, keyboard, zoom, media, read, extract, and screenshot handlers exist. Durable tab identity and UI synchronization are incomplete. |
| Browser security/auth | PARTIAL, UNSAFE | Persistent browser profiles and login-state helpers exist. Permission/download/history ownership and safe authentication-aware action policy are not centralized. |
| YouTube | PARTIAL, UNSAFE SUCCESS REPORTING | `desktop_agent/tools_youtube.py` supports search/play/media actions; real Playwright selection and media verification exist in parts. Search fallback and several controls still return uncertain/canned outcomes; end-to-end authenticated playback is not proven. |
| WhatsApp | PARTIAL, PLACEHOLDER, UNSAFE SUCCESS REPORTING | `src/whatsapp_client.ts`, Python/application/browser suites, and server routes exist. Several service integration actions say prepared/queued, and a complete browser send plus independent sent-message verification is not proven. |
| File Explorer/files | WORKING, PARTIAL, UNSAFE | `desktop_agent/tools_files.py` performs real safe-root file operations and uses Recycle Bin where available. Permanent deletion can run when explicitly requested; centralized permission policy and postcondition coverage should be unified. |
| Windows applications/windows | WORKING, PARTIAL | Python tools use real process/window APIs and pyautogui/Win32 paths. Some suite methods return planned/canned results and cross-router status differs. |
| Keyboard/mouse | WORKING, UNSAFE | `desktop_agent/tools_hardware.py` performs real pyautogui input. Coordinate/semantic authorization, focus verification, and sensitive-action policy are not uniformly enforced at the central router. |
| Power actions | WORKING, PARTIAL | `tools_confirmation.py` provides single-use short-lived tokens and `tools_pc.py` executes gated power actions. Separate OS suite semantics exist, so shutdown SARA vs shutdown Windows needs one tested policy facade. |
| Screenshot capture | WORKING, PARTIAL, DUPLICATED | Python PIL/MSS-related capture and Electron `desktopCapturer` paths exist. Result evidence fields and verification mappings differ; no canonical capture ID contract is shared everywhere. |
| Screen monitoring/live screen | PARTIAL, SLOW | `desktop_agent/screen_monitor.py` has a background interval sampler and event buffer; live endpoints exist. It can repeatedly OCR/capture and is not yet a low-bandwidth event-driven stream with one ScreenObserver owner. |
| Camera | PARTIAL | `desktop_agent/tools_camera.py` uses OpenCV when available and can launch Windows Camera, capture, record, and scan QR. Permission indicators, face/identity analysis, lifecycle state, and cautious visual claims are incomplete. |
| Proactive behavior | PARTIAL | `desktop_agent/proactive_interaction.py` implements cooldowns, quiet mode, topic grounding, emotional state, and conservative scoring. It is local and non-speaking, but integration with unified context and event bus is incomplete. |
| Event bus | BROKEN, DUPLICATED | EventEmitter/task events and Python event logs exist, but no central cross-subsystem event contract for speech, AI, task, tool, browser, screen, memory, permissions, and connection events is authoritative. |
| Security/permissions | PARTIAL, UNSAFE | Python power confirmation, safe file roots, credential vault, audit logger, Node policy engine, and integrity checks exist. Sensitive browser/service/file actions do not all pass through one permission manager with user/intent/tool/args/confirmation/result records. |
| Audit logging/observability | WORKING, PARTIAL | Node DB/file audit logging, redaction, hashes, structured tool logs, correlation IDs, and Python events exist. End-to-end latency fields and a unified event schema are incomplete. |
| Database | PARTIAL, DUPLICATED | `server_state.ts` sql.js/data DB is authoritative for Node conversations/tasks/sessions/tool calls/audit; Python memory DB/JSON and TypeScript cognitive JSON stores are additional authorities. No destructive migration should occur. |
| Mobile | PARTIAL, DUPLICATED | `mobile_server.ts`, Android companion manager/tools, mobile APIs, and app files exist. The companion queues commands and stores encrypted local data, but a single authenticated SARA Core connection and end-to-end mobile capability contract are not proven. |
| Tests | WORKING, PARTIAL | Python unit tests, TypeScript tests, Playwright/E2E helpers, PowerShell checks, and real-desktop test scaffolding exist. Coverage is uneven and several E2E tests use stubs or accept queued/failed states instead of requiring real postconditions. |

## Current Runtime Ownership

### Electron and UI

- `electron/main.cjs` owns the Electron process, single-instance lock, native capture IPC, splash/main windows, and optional standalone backend child.
- `src/App.tsx`, `App.tsx`, and `src/components/` own the existing user interface and should be preserved.
- `src/components/BrowserAgent.tsx` is a renderer browser-like surface, not a native browser owner. It uses iframe/proxy/fallback behavior and is incompatible with the requested universal real-browser behavior for authenticated, media, WebSocket, or frame-blocked sites.

### Node and Gemini

- `server_full.ts` is the production build source used by `npm run build` and `dist/server.cjs`.
- `server.ts` is a parallel source/runtime surface. Changes that affect live behavior must account for this divergence.
- Both servers use Gemini and bridge desktop tools to Python. `server_full.ts` also wires cognitive routes and the automation orchestrator.
- `server_state.ts` owns Node conversations, sessions, tasks, tool calls, audit, and idempotency persistence.

### Python Desktop Agent

- `desktop_agent/main.py` is the FastAPI authority for Windows, browser, screen, camera, mobile, memory/platform, and tool execution.
- `desktop_agent/registry.py` loads handlers into `TOOLS` and provides the shared `STATE` object.
- Existing real execution surfaces include `tools_applications.py`, `tools_windows.py`, `tools_files.py`, `tools_hardware.py`, `tools_browser.py`, `tools_youtube.py`, `tools_screenshot.py`, `tools_camera.py`, and `tools_pc.py`.
- Existing suite wrappers include `app_automation_suite.py`, `browser_automation_suite.py`, and `os_control_suite.py`; these should delegate to canonical tools rather than become competing authorities.

## Exact Safe Integration Points

1. Add shared TypeScript contracts under `src/core/contracts/` and normalize existing Node/Python results at the bridge. Preserve legacy `result` payloads.
2. Extend `ToolRouter` and `VerificationRegistry`; do not route around them from new Node features.
3. Extend `desktop_agent/browser_state.py` and `desktop_agent/tools_browser.py` for browser/session observations. Keep Playwright as the real browser engine for automation until a native Electron browser adapter is proven.
4. Extend `server_state.ts` task records/checkpoints with additive fields for session/user/plan/step/observation/verification. Do not create a new database authority.
5. Add a `PersonalityEngine` and `UserModel` as adapters over existing profile, memory, relationship, and settings stores; migrate reads incrementally.
6. Add provider interfaces around current Gemini calls in `server_full.ts` first, retaining Gemini as the only active implementation.
7. Add a central event contract over existing EventEmitter, WebSocket, audit, and Python events. Existing producers should be adapted, not removed.
8. Add a `PermissionManager` facade over Node policy, Python confirmation tokens, safe roots, and credential vault. Existing checks remain in place until parity is verified.
9. Use `startup/startupManager.ts` as the only production process supervisor and preserve the current Windows registration flow.
10. Keep mobile as a client/companion adapter to the existing Node/Python services; never place Gemini secrets in the client.

## Files That Must Not Be Modified During Architecture Work

These are protected unless a change is directly required, reviewed, and tested for compatibility:

- `electron/main.cjs` startup, IPC, and single-instance behavior
- `src/App.tsx`, `App.tsx`, `src/main.tsx`, and existing UI components unless a requested UI state is impossible without an additive change
- `server_state.ts` persistence schema and migration behavior
- `server_full.ts` and `server.ts` live Gemini/tool paths without dual-source validation
- `desktop_agent/main.py` dispatch protocol and `/health`, `/capabilities`, `/execute` contracts
- `desktop_agent/registry.py` existing tool names and registration behavior
- `desktop_agent/tools_*` existing handlers unless extending a verified gap in that handler
- `startup/startupManager.ts`, `startup/processGuard.ts`, `startup/healthChecks.ts`, and `startup/electronLauncher.ts` startup ownership behavior
- `package.json`, `tsconfig.json`, `vite.config.ts`, and `electron-builder.yml` build/packaging behavior unless required by a tested migration
- Existing databases and compatibility files: `data/data.db`, `data.db` where present, `sara_memory.db`, `conversations.json`, `sessions.json`, `tasks.json`, `tool_calls.json`, `memories.json`
- Existing security/integrity files under `src/security/` and Python confirmation/safe-root code
- Existing mobile API contracts and Android companion storage

## Files to Extend First

For the first implementation phases, prefer these files or new additive modules:

- `src/core/contracts/` for shared task, tool, verification, browser, permission, and event types
- `src/core/tools/toolRouter.ts`
- `src/core/tools/toolExecutor.ts`
- `src/core/tools/verification/verificationRegistry.ts`
- `src/core/tools/verification/screenVerifier.ts`
- `src/core/automation/taskContext.ts`
- `src/core/automation/automationOrchestrator.ts`
- `server_state.ts` through additive migrations/helpers
- `desktop_agent/browser_state.py`
- `desktop_agent/tools_browser.py`
- `desktop_agent/browser_session.py` after deciding the single browser authority
- `desktop_agent/tools_youtube.py` and existing WhatsApp surfaces only after verification tests exist
- New `src/core/personality/`, `src/core/user/`, `src/core/providers/`, `src/core/events/`, and `src/core/permissions/` adapters
- `src/components/SettingsPanel.tsx` only for opt-in profile/permission controls
- `tests/` and `desktop_agent/test_*.py` for focused regression and E2E tests

## Recommended Migration Plan

### Phase 0: Audit

Complete this document. Freeze deletion/refactoring. Record owners, contracts, test evidence, and known gaps.

### Phase 1: Shared Contracts

Define additive contracts for `TaskSession`, `ToolExecutionResult`, `Observation`, `VerificationResult`, `BrowserSession`, `PermissionRequest`, `AIProvider`, and event types. Add adapters at existing Node/Python boundaries. Keep legacy fields and APIs.

### Phase 2: Tool Routing

Make the existing `ToolRouter` the explicit Node entry point for all new automation. Validate registered tool names against Python `/capabilities`. Do not remove direct legacy routes until equivalence tests pass.

### Phase 3: Task Continuity

Extend the existing Node task persistence and `taskContext.ts` with plan steps, completed/failed steps, tool calls/results, observations, verification, retry count, and connection/session IDs. Restore only from the last verified step.

### Phase 4: Observation and Verification

Expand `VerificationRegistry` and Python browser state with operation-specific independent checks. A tool return value is execution evidence only, not proof. Add URL/title/DOM/media/chat/file/window postconditions and bounded retry policy.

### Phase 5: Browser Ownership

Choose and document one automation browser owner. The immediate safe owner is the existing persistent Playwright Chromium context in Python. Treat renderer iframe/proxy and OS default-browser paths as compatibility surfaces until a native Electron adapter is tested. Add session/tab IDs and durable task references.

### Phase 6: Real YouTube, WhatsApp, and Files

Implement verified workflows by extending current handlers. YouTube must select a real watch URL and verify media state. WhatsApp must resolve an explicit contact, send through the selected real path, and verify the sent message. File operations must verify destination/source postconditions and retain confirmation gates.

### Phase 7: Screen and Camera

Wrap existing capture/monitor/camera implementations with a shared observer contract. Add event/change detection, privacy state, permissions, and bounded sampling without sending unnecessary frames to Gemini.

### Phase 8: Voice Identity and Context

Keep current opt-in fingerprint enrollment. Add user-context selection and confidence metadata. Voice similarity alone must never authorize sensitive actions.

### Phase 9: User Model and Memory

Create an adapter over existing Node/Python/TypeScript memory stores. Add explicit users, preferences, relationships, privacy, expiration, and relevance retrieval. Migrate reads/writes gradually with backups and rollback.

### Phase 10: Performance and Providers

Add `AIProvider` around Gemini, streaming/caching metrics, non-blocking task workers, and measured latency. Add fallbacks only behind the interface and only after secret handling is verified.

### Phase 11: Security and Production Hardening

Centralize permission decisions, audit all sensitive actions, test shutdown intent separation, validate startup recovery, and produce `SARA_PRODUCTION_READINESS_REPORT.md` only after evidence-based acceptance tests pass.

## Test Plan

### Baseline checks after every phase

- `npm run lint`
- `npm run build`
- `npx tsx --test` for focused TypeScript tests
- `python -m pytest` for focused Python tests
- `npm run sara:doctor -- --status` where supported
- Startup supervisor health on ports 3000 and 8765
- Verify no database files are deleted or reset
- Inspect startup, tool, audit, and error logs

### Required focused tests

- ToolRouter route/unknown-tool/canonical-result tests
- Python `/health`, `/capabilities`, and `/execute` contract tests
- Browser session creation, tab selection, closed-page recovery, URL/title observation
- YouTube search result selection and playing/paused media postconditions
- WhatsApp explicit contact resolution, send, and visible sent-message verification
- File copy/move/delete postconditions and confirmation policy
- Task checkpoint save/restore after Gemini, WebSocket, browser, agent, and network failure
- Retry bounds and no duplicate destructive actions
- User/relationship explicit mapping and privacy filtering
- Voice identity confidence and sensitive-action escalation
- Screen observer change detection and capture throttling
- Camera permission/privacy lifecycle
- Mobile authentication and no-client-secret checks
- Shutdown SARA versus shutdown Windows intent tests

### Required end-to-end acceptance tests

1. Open YouTube, select a video, play it, verify player state, and report only verified success.
2. Send a test WhatsApp message to an explicitly configured contact and verify the sent message.
3. Open Downloads and verify the expected folder/window state.
4. Find and open a known file with a verified path/window result.
5. Capture/read the screen with evidence fields that the verifier understands.
6. Start a long task, disconnect Gemini, reconnect, and continue from the last verified step.
7. Run a browser task while asking an independent conversational question.
8. Confirm computer shutdown and separately test "shut yourself down" without shutting down Windows.

## Initial Audit Conclusion

SARA should not be rebuilt. The current system has enough real capability to evolve into the requested human-like operating-system agent, but only through explicit ownership, additive contracts, independent verification, persistent task checkpoints, and centralized policy adapters. The first implementation after this audit should be Phase 1 shared contracts and compatibility adapters, followed by a focused task/verification path. Native Electron browser replacement, unified memory migration, provider expansion, and broad personality changes should wait until their boundaries are tested.

No runtime code was modified while producing this audit.
