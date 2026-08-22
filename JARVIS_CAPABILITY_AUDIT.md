# SARA Jarvis-Level Capability Audit

Audit date: 2026-08-21
Scope: existing repository, production source paths, Desktop Agent tools, routing, persistence, and tests.

## Executive Summary

SARA is a real Windows-oriented assistant architecture, not only a chatbot. The strongest runtime path is:

`Electron/renderer -> server_full.ts -> Gemini Live -> Desktop Agent HTTP /execute -> desktop_agent registry -> real Windows/Playwright APIs`.

The project has broad capability coverage, but it is not yet a coherent Jarvis-level system end to end. The main risk is split ownership: `server.ts` and `server_full.ts` are parallel backends; Python `desktop_agent` is the real execution owner; TypeScript agents, cognitive services, task runners, and legacy Python suites often model the same capabilities separately. A class, endpoint, or test stub is therefore not counted as working unless the production route reaches a real implementation and returns truthful status.

## Capability Matrix

| Capability | Status | Evidence and limitation |
|---|---|---|
| Gemini reasoning | Working on primary path | Gemini Live and REST chat are wired in `server_full.ts`; tool calls route to Desktop Agent. Provider is not abstracted. |
| Windows application control | Partial/real | `desktop_agent/tools_applications.py` launches real apps and now has verification in newer paths; universal fallback can only report a request. |
| Window control | Partial/real | `tools_windows.py` and `tools_window_extra.py` use Win32/pygetwindow; some operations depend on title matching and focus privileges. |
| Mouse/keyboard | Real but risky | `tools_hardware.py` uses pyautogui. Coordinate input remains a fallback and many handlers return acknowledgement rather than post-action verification. |
| Clipboard | Real | Python clipboard tools use local clipboard APIs; privacy boundary and content redaction need stronger enforcement. |
| File management | Real with safety boundary | `tools_files.py` confines paths and prefers Recycle Bin; permanent delete and archive extraction need stronger confirmation and traversal tests. |
| Browser automation | Real, upgraded | `tools_browser.py` owns persistent Playwright Chromium, defaults headless, serializes operations, and exposes native state. A separate default-browser path remains in `tools_websites.py`/`tools_search.py`. |
| Browser state | Partial/real | `browser_state.py` tracks page lifecycle, errors, downloads, media, and popups. Node exposes `/api/browser/state`; handoff/presentation policy is not yet a single contract. |
| YouTube search/play | Partial/real | `tools_youtube.py` uses DOM result extraction and native media verification for Playwright playback. API/fallback and pause/seek/queue paths still contain uncertain or prepared responses. |
| YouTube full control | Partial | Search, play, pause, resume, seek, volume, captions, transcript, and metadata handlers exist; next/previous/queue/playlist and durable playback state are incomplete or not independently verified. |
| WhatsApp/messaging | Partial | Confirmation/task routes exist and service registry stores credentials encrypted; `service_integrations.py` mostly prepares/queues messages rather than sending through a tested provider. |
| Screen capture/OCR | Real but optional | `tools_screenshot.py` uses PIL/ImageGrab and optional Tesseract. Missing OCR dependencies degrade clearly; screen capture is not a unified context source. |
| Live screen monitoring | Partial/expensive | `screen_monitor.py` runs a background thread but samples OCR/screenshots at intervals. It is not event-driven Windows accessibility state and can capture private screen data. |
| Perception/context | Partial | `situational_awareness.py`, activity/event modules, and monitor tools exist in the repository, but their outputs are not consistently fused into Gemini context. |
| Memory/persistence | Partial | `server_memory.ts` persists JSON plus SQL.js tables; Python `MemoryManager` uses another `sara_memory.json`; TypeScript cognitive memories use additional stores. No single authoritative memory owner exists. |
| RAG | Real local retrieval | `platform_core.py::RagEngine` indexes chunks and deterministic embeddings; retrieval works locally but is not consistently injected into Gemini decisions. |
| Episodic/skill learning | Partial | TypeScript cognitive memories and Python experience/reward/skill systems exist; cross-system outcome flow is incomplete. |
| Conversation continuity | Partial | `server_state.ts` persists conversations and sessions; Gemini receives recent history, but durable context selection is mostly keyword/memory based. |
| Proactive conversation | Partial/real local engine | `proactive_interaction.py` has scoring, quiet mode, cooldowns, privacy filtering, and emotion decay. Live idle evaluation is wired in `server_full.ts`, but current context is narrow and Gemini-generated proactive speech is not fully outcome-tracked. |
| Personality/emotion | Partial/duplicated | Existing TypeScript/Python personality concepts and the current proactive computational state coexist. The current live bridge uses simple lexical emotion cues, not a unified personality owner. |
| Autonomous planning | Partial | `server_task_manager.ts`, Python `agents.py`, `src/cognitive/planner.ts`, and browser/app suites all plan tasks. Gemini deep planning exists, but execution/verification contracts differ. |
| Task persistence/restart | Partial/real | `server_state.ts` persists tasks and `AutomationOrchestrator` restores unfinished tasks. In-flight cancellation and exact resume checkpoints are incomplete. |
| Verification | Partial/real | TypeScript `ExecutionOrchestrator` and verification registry exist; legacy Python tools often return plain result strings or `prepared/queued` states. |
| Error recovery | Partial | Retry policy, agent restart, browser recreation, and task recovery exist. Recovery strategy is not centralized and dangerous operations need stricter no-retry policy enforcement. |
| Safety/confirmation | Partial/real | Confirmation manager, power two-step flow, file roots, service vault, and tool risk metadata exist. Coverage is inconsistent across wrappers and external side effects. |
| Prompt-injection defense | Missing as a centralized policy | Some prompts describe safety, but untrusted web/email/document content is not separated by a deterministic policy layer before Gemini/tool execution. |
| Voice | Real primary path | Gemini Live audio streaming and transcription are wired; explicit barge-in/cancellation and speech output lifecycle are incomplete. |
| UI | Working but duplicated surfaces | Existing React/Electron UI is feature-rich and preserved. Browser/agent controls and older component paths create competing concepts. |
| Self-shutdown | Partial | `SARA`-owned shutdown concepts and emergency-stop tools exist, but a single verified shutdown transaction that saves state, stops workers, and closes only SARA resources is not established. |
| Windows shutdown/restart | Real, gated | Power actions have a confirmation-token flow; this is distinct from SARA self-shutdown. |
| Logging/observability | Partial | Node structured tool logs, audit events, Python logs, and task persistence exist; correlation and redaction are inconsistent across legacy handlers. |

## Confirmed Working Evidence

- `npm run build` completes and produces the renderer and `dist/server.cjs`.
- TypeScript `npm run lint` has passed after recent integrations.
- `python -m pytest -q desktop_agent --collect-only` collects 65 current Desktop Agent tests.
- Current focused browser/proactive tests pass, including native browser state and proactive privacy/cooldown behavior.
- `desktop_agent/tools_browser.py` is the authoritative Playwright owner. It uses a dedicated event-loop thread, persistent profile, headless mode by default, operation serialization, and browser-native state.
- `server_full.ts` injects `callDesktopAgent` into `server_task_manager.ts` at startup, so the task bridge is not merely a disconnected placeholder.
- `server_state.ts` persists conversations, sessions, tasks, tool calls, and audit data through SQL.js/JSON compatibility paths.
- `desktop_agent/platform_core.py` provides real local memory, RAG, goals, recovery, experience, reward, strategy, skill, security, and scheduling primitives.

## Broken or Misleading Paths

1. `desktop_agent/tools_search.py` used `ToolError` without importing it. Invalid search requests crashed with `NameError`; this was fixed and now returns `ToolError`.
2. `desktop_agent/os_control_suite.py` contains success-shaped simulated branches such as `Shutdown requested`, `Opened folder`, `Listed files`, and `Screenshot captured` instead of delegating to verified tools for all actions.
3. `desktop_agent/service_integrations.py` describes several actions as API-queued/prepared without implementing provider calls or returning a distinct `NOT_IMPLEMENTED`/`PENDING_AUTHORIZATION` status.
4. `desktop_agent/tools_hardware.py`, `tools_websites.py`, and `tools_search.py` often return acknowledgement strings without proving the resulting application/browser state.
5. `desktop_agent/tools_youtube.py` still has uncertain legacy handlers for seek, volume, captions, and watch-later; they can report a request without verification.
6. The broad legacy suites under `tests/test_autonomous_*.py` import missing modules including `desktop_agent.personality_manager`, `autonomous_decision_engine`, and `autonomous_awareness_engine`. They cannot be used as a passing regression baseline until either restored or retired explicitly.
7. `server.ts` and `server_full.ts` contain overlapping but drifting runtime surfaces. Production build uses `server_full.ts`; development/tooling references both.
8. `desktop_agent` has a current `proactive_interaction.py`, while the repository also contains older autonomous/proactive concepts in tests and TypeScript services. This is duplicated policy ownership.

## Duplicate Systems

- Node backend: `server.ts` and `server_full.ts`.
- Browser: Python Playwright `tools_browser.py`, TypeScript `src/agents/BrowserAgent.ts`, UI `src/components/BrowserAgent.tsx`, `startup/browserManager.ts`, and `local-agent.js`.
- Tasks: `server_state.ts`, `server_task_manager.ts`, Node `AutomationOrchestrator`, Python `agents.py`, and TypeScript closed-loop/cognitive services.
- Memory: `server_memory.ts`/SQL.js, Python `platform_core.py::MemoryManager`, TypeScript `MemoryService`, cognitive JSON stores, and `MemoryPersistenceService`.
- Planning/brain: Gemini Live, `SARACognitiveBrain`, cognitive planner, voice regex router, app/browser suites, and Python agent planner.
- Verification: TypeScript execution verifier, Python tool-result helpers, tool-local verification, and suite-level result wrappers.
- Screen/perception: Electron capture, Python screenshot/OCR, screen monitor, situational awareness, and TypeScript perception services.

## Security Findings

- External side effects need one policy gate: messaging, uploads, API actions, browser form submissions, and service integrations are not uniformly governed by the same confirmation metadata.
- Web content is not yet represented as untrusted data at the tool boundary; prompt-injection resistance is mainly prompt text, not deterministic policy enforcement.
- `android_companion.py` stores the device token in the device record while also encrypting other secrets. Tokens should be hashed or encrypted and never returned in normal device listings.
- `tools_file_extra.py::extract_zip` calls `extractall` without checking for path traversal entries.
- `tools_files.py` accepts `allow_anywhere` in the safety helper, so callers must be prevented from passing that flag without an authorization decision.
- Screen/OCR and clipboard systems can collect private content; retention, redaction, and explicit user consent need a shared policy.

## Performance and Reliability Findings

- The Gemini Live tool path has a background queue for browser tools, but ordinary Desktop Agent calls still wait synchronously for the full execution/verification result.
- Browser operations are serialized around one active page, which is safe but limits parallelism and can make unrelated tabs contend.
- Screen monitoring uses repeated OCR/screenshot sampling rather than event-first Windows state and can consume CPU or expose sensitive content.
- SQL.js persistence uses synchronous filesystem export in async request paths.
- Service integrations, OS suite wrappers, and some application tools can mark work as completed when only a request was prepared.
- Cancellation is strong for queued Node automation tasks but does not interrupt already-running Python operations through a shared cancellation token.
- Browser crash recreation exists, but durable task checkpoint restore is not yet coupled to the browser session/page state.

## Priority Upgrade Plan

### P0: Truth and safety

1. Make every tool return the canonical contract with `SUCCESS`, `FAILED`, `UNCERTAIN`, `PENDING`, or `NOT_IMPLEMENTED`; remove simulated success branches.
2. Add one policy gate before Desktop Agent execution with risk, domain, authorization, confirmation, task, and request IDs.
3. Add deterministic untrusted-content boundaries for browser, email, document, transcript, and search-result text.
4. Fix zip-slip validation, Android token storage, and `allow_anywhere` authorization.
5. Restore or quarantine missing legacy test modules so the complete test command has a truthful baseline.

### P1: One execution and context authority

1. Make `server_full.ts` the explicit production source and make `server.ts` a compatibility wrapper or shared-runtime import.
2. Treat Python registry plus Node ToolRegistry metadata as one contract generated/validated at startup.
3. Introduce one compact `CurrentContext` adapter that combines active window/activity, browser state, current task, recent conversation, ranked memory, quiet mode, and emotional state for Gemini.
4. Connect task checkpoints, cancellation tokens, retries, verification, and restart recovery across Node and Python.

### P2: Real capability completion

1. Replace OS/service/browser acknowledgement wrappers with real adapters or explicit pending/unsupported responses.
2. Complete YouTube stateful controls and verification.
3. Add real file copy progress, compare, restore, duplicate detection, and archive traversal protection.
4. Add provider-specific WhatsApp/email APIs only behind authorization and confirmation.
5. Make screen perception event-first and publish a redacted context stream rather than raw polling data.

### P3: Intelligence and natural interaction

1. Feed the compact context object to Gemini instead of separate ad hoc prompt fragments.
2. Use Gemini for proactive opportunity decisions while local policy enforces cooldown, focus, quiet, privacy, and safety.
3. Consolidate computational emotion/personality into one owner and use confidence/decay metadata in voice expression.
4. Record proactive outcomes, user corrections, and task lessons into the existing durable memory/learning pipeline.

### P4: Verification

- Unit: canonical contracts, policy, redaction, memory privacy, archive safety, retry/cancel state machines.
- Integration: Gemini -> context -> policy -> router -> real tool -> verifier -> task persistence.
- Real Windows acceptance: app/window/file/browser/clipboard/voice/shutdown flows.
- Failure: agent crash, browser crash, Gemini outage, locked file, denied permission, timeout, restart during task.
- Do not count documentation-only or placeholder tests as feature verification.

## Current Change Made During This Audit

- Fixed the missing `ToolError` import in `desktop_agent/tools_search.py`.
- Strengthened `desktop_agent/main.py` canonical results with `SUCCESS`/`FAILED`/`UNCERTAIN`, operation/request/task/correlation IDs, timestamps, execution duration, verification, and structured errors while preserving legacy response payloads.
- Repaired missing browser state event callbacks and covered browser state, result contracts, and archive security with focused tests.
- Blocked ZIP path traversal in `desktop_agent/tools_file_extra.py` before extraction.
- Changed Windows application focus denial to an honest `UNCERTAIN` result instead of throwing or launching a duplicate process.
- Added `src/core/tools/policyEngine.ts` and enforced it in `ExecutionOrchestrator`: unknown tools are denied, external/destructive tools require confirmation, browser domains can be allowlisted, and the existing power-token flow remains compatible.
- Existing proactive/browser work remains in place and was not replaced.

## Audit Conclusion

SARA is a substantial foundation with real Windows, Playwright, Gemini, memory, RAG, task, safety, and voice components. It should not be rewritten. The highest-value work is contract consolidation and removal of false-success paths: once execution, context, policy, verification, persistence, and learning share one authoritative flow, the existing breadth can become a reliable Jarvis-style assistant rather than a collection of partially overlapping subsystems.
