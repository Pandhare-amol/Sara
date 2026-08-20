# SARA Automation Architecture Audit

## Scope and conclusion

This audit follows the current runtime owners rather than introducing a second automation stack. The existing browser automation owner is the Python Desktop Agent's Playwright implementation in `desktop_agent/tools_browser.py`; the existing YouTube owner is `desktop_agent/tools_youtube.py`; and TypeScript tool execution already has verification through `src/core/tools/execution/executionOrchestrator.ts`.

The primary responsiveness bottleneck is in the Gemini Live function-call handler in `server.ts`: desktop tool calls are started, then `await Promise.all(toolResponsePromises)` keeps that Live callback waiting for browser/Desktop Agent completion before Gemini can continue its turn. The safe first integration point is an adapter at that boundary that acknowledges eligible long-running automation immediately and completes it in a background task queue, while preserving the existing tool router and Python handlers.

## 1. Current automation flow

```text
Electron main (electron/main.cjs)
  -> starts dist/server.cjs and owns process cleanup
  -> renderer loads the Node HTTP server

React renderer (src/App.tsx, src/lib/audio.ts)
  -> microphone PCM/video frames over WebSocket /live
  -> receives Gemini audio, transcription, status, tool and desktop events

Node server (server.ts / server_full.ts)
  -> accepts /live WebSocket connections
  -> opens one Gemini Live session per client connection
  -> Gemini emits functionCalls
  -> desktop tool names are routed through callDesktopAgent()
  -> ToolRouter -> ExecutionOrchestrator -> verification -> HTTP POST

Python Desktop Agent (desktop_agent/main.py)
  -> POST /execute dispatches to registry.TOOLS
  -> browser tools execute on a dedicated Playwright event-loop thread
  -> YouTube tools compose existing browser/search/media handlers
```

The production entry point is `startup/startupManager.ts`, which supervises the backend, Desktop Agent, and Electron process. In development, `server_full.ts` is bundled to `dist/server.cjs`; `server.ts` is the narrower source variant used by the current workspace tooling.

## 2. Blocking operations

- Gemini Live tool handling awaits `callDesktopAgent()` for every Desktop Agent function call and then awaits all calls in the batch.
- `callDesktopAgent()` awaits `ExecutionOrchestrator.executeWithVerification()`.
- Tool execution waits for the Python HTTP response, then verification may perform additional HTTP/browser checks.
- `desktop_agent/tools_browser.py::_run()` blocks its FastAPI worker thread on `future.result(timeout=60)` while Playwright runs on its dedicated loop.
- Browser navigation uses fixed 20-second timeouts; back/forward uses 15 seconds; element actions generally use 5 seconds.
- `server_state.ts` uses SQL.js in-process and synchronous filesystem persistence (`writeFileSync` for database export) inside async APIs. Calls are awaited from request handlers, although most conversation writes are already fire-and-forget.

These waits do not stop Node's event loop by themselves, but they do hold the Gemini Live function-call callback and delay the next model turn/tool response. Browser contention also serializes implicitly around one shared active page, without an explicit resource lock.

## 3. Synchronous operations

- `server.ts` uses synchronous filesystem setup and some startup/process inspection operations.
- `desktop_agent/tools_browser.py` exposes synchronous wrappers around async Playwright handlers and blocks the calling worker until completion.
- `desktop_agent/tools_youtube.py` includes synchronous YouTube Data API fallback calls and calls existing synchronous browser wrappers for search/media operations.
- `startup/browserManager.ts` uses synchronous configuration, executable discovery, and `execSync` for real-browser launching.

## 4. Existing background workers

- The Python browser module owns a dedicated asyncio event loop and daemon thread.
- Gemini Live and each WebSocket connection run asynchronously in Node.
- Memory consolidation is already launched with `void` from the Live message path.
- The Python agent has an existing multi-agent manager and task runtime exposed by `/orchestrator/*`, but that is not the Node Gemini tool queue and does not own the browser task lifecycle.
- No centralized Node automation worker currently owns priority, cancellation, progress events, or task acknowledgements.

## 5. Existing task systems and persistence

- `server_state.ts` defines `TaskRecord`, task statuses, priorities, checkpoints, JSON persistence, and a SQL.js `tasks` table.
- `src/services/ClosedLoopExecutor.ts`, cognitive planning/evaluation modules, and the Python `MANAGER` are separate task/agent systems for their existing workflows.
- `src/core/tools/execution/executionOrchestrator.ts` is the existing execution-plus-verification abstraction and should remain the executor used by the new adapter.
- `tool_calls`, `audit_events`, conversations, sessions, and tasks are persisted through `server_state.ts`; there is no separate automation database to add.

## 6. Browser lifecycle and owners

There are two intentionally different browser paths:

1. `startup/browserManager.ts` opens a user's real/default browser for ordinary website/search commands. It is process-launch configuration, not a Playwright session manager.
2. `desktop_agent/tools_browser.py` owns the automation browser. `registry.STATE` caches Playwright, browser, context, and active page. `_ensure_browser_async()` reuses those objects when alive and recreates them after a failed health probe. `main.py` calls `shutdown_browser()` during FastAPI lifespan shutdown.

The automation browser is currently lazy-started on its first tool call, not started during SARA startup. There is no explicit state machine, startup readiness endpoint, crash restart loop, or browser operation lock. The existing state singleton must remain the single source of truth.

## 7. Desktop Agent lifecycle

- `server.ts` checks `/health`, `/capabilities`, and `desktopAgentDiagnostic` in `ensureDesktopAgent()`.
- Without the production supervisor, Node can spawn the Python agent detached using the configured frozen executable or local Python.
- `startup/startupManager.ts`, `processGuard.ts`, `desktopAgentController.ts`, and health checks supervise production processes and avoid duplicate ownership.
- Electron cleanup kills the backend process tree; Python lifespan cleanup closes the cached Playwright browser.
- The Node HTTP bridge uses a 25-second request timeout and marks the agent unverified after transport failures.

## 8. Gemini request lifecycle

- `src/lib/audio.ts` connects the renderer to `/live`, streams microphone audio and optional screen frames, and plays Gemini audio responses.
- `server.ts` creates a `GoogleGenAI` client and `ai.live.connect()` session for the WebSocket.
- Gemini function declarations include browser, YouTube, desktop, memory, and other tools.
- User transcription and most memory/conversation persistence are asynchronous.
- Desktop function calls currently await Python execution and verification before sending `session.sendToolResponse()`.

## 9. Current bottlenecks

1. The Gemini Live callback waits for browser/Desktop Agent completion.
2. YouTube play chains navigation, result selection, page navigation, and media control through one active Playwright page.
3. Browser operations share `STATE.page` without a lock, so concurrent commands could interfere with the same tab.
4. Browser startup is lazy and its state is not surfaced to Node/UI.
5. Fixed browser timeouts are longer than the desired quick-action/navigation budgets.
6. Existing structured tool logs cover execution and verification, but not a distinct queued/started/progress/completed automation lifecycle.
7. Cancellation is available in parts of the task/agent systems, but not as a common `cancelTask(task_id)` contract for Desktop Agent tool calls.

## 10. Safe integration points

- Add a Node `AutomationOrchestrator` beside the existing tool execution system. It should call `getExecutionOrchestrator()`/`callDesktopAgent()` and never register duplicate browser or YouTube tools.
- Classify only eligible long-running automation calls, initially `youtube_*`, `desktopBrowser*`, and explicit browser/search tools. Keep short, conversational or safety-sensitive calls synchronous until tested.
- In the Gemini Live handler, submit an eligible task and send an immediate structured acknowledgement/tool response. Background completion should emit status/progress events to the same WebSocket and persist through existing `server_state.ts`/tool-call logging.
- Add a browser resource lock in the Python browser owner or a narrowly scoped orchestrator lock. Since `STATE.page` is shared, browser-bound tasks should be serialized while weather/API/file tasks remain concurrent.
- Add a persistent-browser readiness/start/shutdown adapter around the existing Python lifecycle; do not create a second Playwright implementation in Node.
- Extend existing verification mappings with YouTube-specific verification using the existing browser page/media state tools, then report success only after verification.
- Preserve `/live`, `/api/desktop/execute`, existing tool names, the Python `/execute` contract, Electron startup, Gemini declarations, and current UI components. UI integration can consume additive automation status events without redesigning the UI.

## Discriminating check for Phase 2

With the current code, issue a browser-bound command and then a normal conversational command over the same Live connection. The second command should show whether the Live handler is waiting on the first tool response. After the adapter is added, the acknowledgement and second response should arrive before browser completion, while the background task eventually emits a verified terminal event and the browser process remains reused.

## Audit status

This document records the pre-change architecture. No existing automation implementation, browser owner, Desktop Agent, Gemini integration, UI, or database has been removed or replaced.