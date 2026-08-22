# SARA Automation Audit - Phase 0

Date: 2026-08-22
Scope: existing automation only; no UI, Gemini, Electron, or Node replacement.

## A. YouTube Automation Map

- `desktop_agent/tools_youtube.py`: `youtube_search` uses YouTube Data API when configured, otherwise `searchYouTube`; `youtube_play` uses Playwright search/link extraction when available and calls `desktopBrowserMedia`.
- `desktop_agent/tools_search.py`: `searchYouTube` only opens a results URL in the OS default browser. It does not inspect or select a result.
- `desktop_agent/tools_browser.py`: `desktopBrowserSearch`, `desktopBrowserExtractLinks`, `desktopBrowserOpen`, and `desktopBrowserMedia` run in a persistent Playwright context. `desktopBrowserMedia(play)` verifies `!paused` and `currentTime > 0`.
- `desktop_agent/app_automation_suite.py`: YouTube `search` opens a search page; `play` is not a complete result-selection state machine.

Classification: `youtube_play` is real but incomplete and selection is first-link based; `youtube_search` is open-only in its normal fallback; pause/resume/seek/volume/captions/fullscreen return uncertain or keyboard-based results; API search is metadata-only. No dedicated playback monitor or recovery state machine exists.

## B. WhatsApp Automation Map

- `src/whatsapp_client.ts`: sends through the WhatsApp Cloud API when credentials exist, with retries and local idempotency persistence. This is API messaging, not WhatsApp Web browser automation, and it does not verify a visible outgoing message.
- `server_full.ts`: `callDesktopAgentTransport` short-circuits WhatsApp send tools to `whatsapp_client.ts`; `/api/whatsapp/send` also uses the Cloud API.
- `desktop_agent/tools_websites.py`: `openWebsite` opens `https://web.whatsapp.com` in the default browser only.
- `desktop_agent/app_automation_suite.py`: WhatsApp send opens a chat URL, fills `div[contenteditable='true']`, presses Enter, and returns `Sent WhatsApp message` without checking login, contact identity, chat identity, upload, or outgoing-message state.
- No registered authoritative Desktop Agent handlers were found for contact resolution, verified WhatsApp Web send, attachments, or browser call verification. Existing names in server declarations are contracts, not evidence of handlers.

Classification: Cloud API send is real transport but not Web automation and is credential-dependent; desktop WhatsApp flows are partial/open-only and unverified; attachment and call flows are unavailable or placeholders.

## C. Browser Architecture

- `desktop_agent/tools_browser.py` is the real Playwright execution layer with a dedicated event-loop thread, a persistent profile, one active page, tab operations, navigation, DOM interaction, media state, extraction, page reading, screenshots, and browser state.
- `desktop_agent/browser_state.py` tracks Playwright page state and media state without using pixels as proof.
- `desktop_agent/browser_automation_suite.py` is a higher-level wrapper, but it has its own lightweight `BrowserSessionManager`, placeholder form/upload/download/extract operations, and generic planned responses.
- `startup/browserManager.ts` launches the OS browser and defines `REAL_BROWSER` versus `AUTOMATION_BROWSER`, but cannot attach to or inspect the OS browser.
- `desktop_agent/tools_websites.py` and `tools_search.py` use `webbrowser.open`, creating a second open-only path.

## D. Desktop Agent Routes

- `desktop_agent/main.py` loads the flat registry and exposes `POST /execute`, `/health`, `/capabilities`, `/tools`, and browser state endpoints.
- `desktop_agent/registry.py` owns tool names and registrations. `tools_browser.py` replaces async registrations with synchronous wrappers around its dedicated loop.
- Node transport is `server.ts`/`server_full.ts` -> `callDesktopAgentTransport` -> HTTP `POST /execute`, with a server-side WhatsApp Cloud API shortcut.

## E. Electron Browser Implementation

- `src/agents/BrowserAgent.ts`, `src/components/BrowserAgent.tsx`, and `src/components/BrowserVisionFallback.tsx` provide renderer-side/in-app browser agent UI and fallback behavior.
- `startup/browserManager.ts` launches configured real browsers using `spawn`, `start`, or `webbrowser`-equivalent OS behavior. It is not an inspectable automation session.
- `local-agent.js` is another Playwright server boundary and must not become a third browser owner.

## F. Verification System

- Python browser media verification is direct DOM/player state and is the strongest current verification path.
- `desktop_agent/main.py::_canonical_result` normalizes legacy results, but treats many legacy `result` strings as `UNCERTAIN`.
- Node `src/core/tools/execution/executionOrchestrator.ts` performs execution then verifier lookup; `src/core/tools/verification/verificationRegistry.ts` and `screenVerifier.ts` provide generic verification.
- `src/core/tools/toolExecutor.ts` normalizes results into execution and verification fields.
- Screenshot actions capture images but are not a reliable substitute for DOM/player/message verification.

Classification: structured contracts exist; coverage is uneven. Open-only tools can still be surfaced as successful legacy results unless their canonical result is checked by the caller.

## G. Task and Session System

- `src/core/tasks/taskManager.ts`, `taskRepository.ts`, and `taskContract.ts` persist task identity, attempts, status, verification, errors, and user-visible status.
- `src/core/automation/automationOrchestrator.ts` queues work asynchronously, serializes browser tasks, persists task context, and has restore/resume support.
- `server_task_manager.ts` is another task runner path and injects `callDesktopAgent` through `desktop_agent_bridge.ts`.
- `desktop_agent/browser_session.py` was referenced by existing tests but missing; Phase 1 adds the missing session owner.

## H. Gemini Connection Lifecycle

- Gemini and conversation handling live primarily in `server.ts` and `server_full.ts`; the task/orchestration code is separate and has persisted task context.
- `AutomationOrchestrator` tests explicitly cover resume after a Gemini disconnect, but the live connection-to-task integration needs verification in a running server.
- The safe rule for migration is to keep persisted task state outside the Gemini Live socket and reconnect/report independently.

## I. Working, Partial, Broken, Mock, Open-only, Unverified

- Working: Playwright navigation/DOM interaction primitives when the Python agent and Playwright are installed; direct media play verification when a video element is present and advances; Cloud API send when credentials and recipient are valid; task persistence primitives.
- Partial: `youtube_play`; YouTube search; browser session reuse; tab management; Node verification routing; WhatsApp Web fill/send path; real-browser configuration.
- Broken or missing: `desktop_agent.browser_session` before this phase; authoritative contact resolution and verified WhatsApp Web messaging; verified WhatsApp attachments/calls; a single session manager used by all browser tools.
- Mock/placeholder: browser suite `_submit_form`, `_upload_file`, `_download_file`, `_extract_content`; generic unknown browser actions; several application-suite fallback result strings; login/captcha helpers based only on supplied argument text.
- Open-only: `openWebsite`, `searchWeb`, `searchYouTube`, `startup/browserManager.openInBrowser`, and default-browser fallback in `youtube_play`.
- Unverified: YouTube pause/resume/seek/volume/captions/fullscreen; most browser click/type/navigation responses; WhatsApp Web actions; screenshot-only screen claims.

## J. Exact Files Requiring Modification Later

1. `desktop_agent/tools_browser.py` and `desktop_agent/browser_session.py`: converge on one persistent session owner and expose inspect/wait/tab/authentication operations.
2. `desktop_agent/tools_youtube.py`: implement result inspection, explicit selection, player readiness, playback monitor, controlled recovery, and truthful failures.
3. `desktop_agent/tools_search.py` and `desktop_agent/tools_websites.py`: route interactive site work through the authoritative browser instead of default-browser open-only behavior.
4. `desktop_agent/app_automation_suite.py`: remove unverified WhatsApp success paths and delegate to a dedicated adapter.
5. `desktop_agent/registry.py`: register only implemented adapter operations and preserve compatibility aliases.
6. `server.ts`, `server_full.ts`, `desktop_agent_bridge.ts`, and `server_task_manager.ts`: preserve one ToolRouter transport and ensure async task results remain independent of Gemini.
7. `src/core/tools/verification/*` and `src/core/contracts/*`: map site-specific verification evidence without treating execution as proof.
8. `src/core/automation/*` and `src/core/tasks/*`: reconcile the two task systems around one persisted task contract.
9. `src/whatsapp_client.ts`: retain Cloud API support, but keep it explicitly separate from WhatsApp Web and return provider delivery state honestly.
10. Focused integration tests under `tests/` and `desktop_agent/` for real browser/session behavior.

## K. Safe Migration Plan

1. Phase 0: audit complete and documented here.
2. Phase 1: add the missing `desktop_agent.browser_session.BrowserSessionManager` as the lifecycle/readiness owner; prove profile detection, real-browser refusal, persistent fallback, and page-state classification with existing tests.
3. Phase 2: migrate `tools_browser.py` to use that manager without changing public tool names; add explicit wait/inspect/tab/session contracts.
4. Phase 3: implement YouTube adapter/state machine and playback monitor; no success before player evidence.
5. Phase 4: implement WhatsApp Web adapter for login/contact/chat/message verification; retain Cloud API as a distinct provider.
6. Phase 5: reconcile task persistence and Gemini disconnect recovery; keep UI responsive through existing task events.
7. Phase 6: add file explorer verification and generic site adapter behavior.
8. Phase 7: add safety confirmation hardening and real integration/regression tests.

Phase 1 implementation in this change is limited to the missing session owner. No existing UI, Gemini integration, Electron app, Node backend, or Python tool behavior was removed or redesigned.
