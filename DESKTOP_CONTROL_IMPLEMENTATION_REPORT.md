# SARA Desktop Control Implementation Report

## Actually verified and working

- Existing desktop-agent dispatch and safety behavior remain green: 91 Python tests pass.
- Existing Node routing, orchestration, canonical result, and public API tests remain green: 11 tests pass.
- Production frontend and `server_full.ts` bundle build successfully.
- Real input handlers now delegate through one `DesktopInputController`.
- Mouse movement uses PyAutoGUI system cursor movement and verifies the resulting cursor coordinates.
- Mouse click, drag, and scroll handlers send real foreground desktop input.
- Mouse button down/up state is tracked and can be released centrally.
- Keyboard key press, key down, and key up handlers send real foreground keyboard input.
- Unicode typing uses a real Ctrl+V foreground keyboard action through the existing `pyperclip` dependency and restores the prior clipboard in a `finally` block.
- Emergency release releases all keys and mouse buttons tracked by SARA.
- Windows monitor enumeration uses `pywin32` display monitor APIs and reports virtual-desktop coordinates.
- Hardware tools are registered in the Python agent, Node router allowlist, and Gemini live function declarations.
- Action responses distinguish `action_sent` from `verified`; click, drag, scroll, and typing do not falsely claim a postcondition they cannot observe.

## Implemented but not yet real-world verified

- Physical mouse movement, clicking, dragging, and scrolling on the current user desktop.
- Physical Unicode typing and shortcut behavior in a real focused application.
- Monitor enumeration on the current multi-monitor/DPI configuration.
- Emergency release against a real held key or mouse button.

These require an intentional live Windows smoke test because they change the user’s active desktop. No unsolicited cursor movement, typing, or application interaction was performed during implementation.

## Partial

- Input delivery is real, but generic click/type/scroll postconditions remain unverified unless a higher-level target or application verifier is added. This is reported honestly as `action_sent: true` and `verified: false`.
- Drag reports that the real drag action was sent and safely released, but does not claim that the destination accepted the drop.
- Existing window management remains functional but still has a first-match title lookup and limited foreground-activation verification.
- Existing accessibility/OCR/vision tools are present, but a single unified target resolver across all perception levels is not yet implemented.
- Existing application discovery and browser automation are present, but verified application launch and browser handoff are not yet unified under the new input controller.

## Blocked

- Live real-desktop acceptance testing was not run automatically because it would move the user’s cursor, type into the focused application, and potentially alter files or windows without explicit smoke-test authorization.
- Hardware dependencies must be installed in the runtime Python environment for live operation: `pyautogui`, `pyperclip`, and on Windows `pywin32`.

## Remaining future work

1. Add a unified window manager with enumeration, process identity, bounds, monitor placement, and foreground verification.
2. Add target resolution that composes UI Automation, browser DOM, OCR, vision, and coordinate fallback with confidence thresholds.
3. Add postcondition verifiers for focused controls, typed values, clicked UI state, accepted drops, and application launch identity.
4. Propagate cancellation tokens and deadlines from the authoritative Node execution pipeline into Python action handlers.
5. Add live Windows smoke tests gated behind an explicit environment flag and a disposable test target.
6. Add application-specific controllers for File Explorer, browsers, VS Code, and media applications.

## Public API expansion status

- **VERIFIED:** The existing API catalog now parses the official `public-apis` Markdown index into bounded local metadata.
- **VERIFIED:** HTTPS-only filtering, authentication classification, approval requirements, source attribution, and import limits are covered by tests.
- **VERIFIED:** `POST /api/public-apis/refresh` is admin-protected and performs an explicit network refresh only when requested.
- **VERIFIED:** `POST /api/public-apis/import` accepts validated curated entries with a maximum batch size of 100.
- **VERIFIED:** Catalog rows remain discovery metadata and are not automatically converted into Gemini tools.
- **PARTIAL:** Provider-specific connectors, credential storage, health checks, rate limiting, and request/response schemas still need to be added progressively for selected capabilities.

## Cognitive context status

- **VERIFIED:** `ContextManager` builds a bounded context window with the current request first, followed by active tasks, conversation summary, recent messages, and relevant memories.
- **VERIFIED:** Oversized lower-priority content is omitted instead of exceeding the configured budget.
- **VERIFIED:** The live Gemini session uses the bounded context builder while retaining existing conversation and memory persistence.
- **VERIFIED:** Context construction is centralized for both the live Gemini session and the HTTP chat path.
- **PARTIAL:** Background task workers still need migration to the same builder; durable memory ownership remains split across existing compatibility stores and has not been destructively consolidated.

## Background task continuity status

- **VERIFIED:** Background task records persist under the existing SARA data root in `background_tasks.json`.
- **VERIFIED:** Tasks left queued or running when the Desktop Agent restarts are restored as `paused` rather than silently replayed.
- **VERIFIED:** `saraTaskCancel` marks queued/running work cancelled and prevents execution when cancellation wins the race.
- **VERIFIED:** Background task controls are registered in the Python agent and Node routing allowlist.
- **PARTIAL:** Cancellation is cooperative and cannot forcibly interrupt an arbitrary synchronous third-party handler; destructive actions remain protected from automatic replay.

## Application launch verification status

- **VERIFIED:** Known application launches now wait for a bounded process/window result and attempt to focus the matching window.
- **VERIFIED:** Already-running applications are reused and focused when possible, avoiding duplicate launches.
- **VERIFIED:** Missing processes return `FAILED`; running applications that Windows refuses to focus return `UNCERTAIN`.
- **VERIFIED:** Unknown application names no longer claim verified identity and return `UNCERTAIN` after the shell launch request.
- **PARTIAL:** Live launch/focus behavior on this user desktop still requires an intentional Windows smoke test.

## YouTube playback status

- **VERIFIED:** `youtube_play` now awaits the existing asynchronous Playwright search, link extraction, navigation, and media handlers instead of treating coroutine objects as results.
- **VERIFIED:** Playback selects an actual `/watch?v=` result URL and requires the browser media verifier before returning success.
- **VERIFIED:** A regression test covers the search -> extract -> open -> play sequence.
- **PARTIAL:** Live YouTube playback, autoplay restrictions, cookies, buffering, and authentication still require a real browser smoke test.

## WhatsApp send status

- **VERIFIED:** The sender now uses Node's built-in `fetch`, removing the undeclared `node-fetch` runtime dependency that prevented the module from loading.
- **VERIFIED:** Failed sends update the tracked task to `failed` and return HTTP 502 with `ok: false` instead of a false HTTP success.
- **PARTIAL:** Real delivery still requires configured WhatsApp Business credentials, an authorized recipient, and provider-side delivery confirmation.

## Multi-user profile status

- **VERIFIED:** Added persistent explicit user profiles with display name, relationship, preferences, communication style, permissions, memory scope, and important context.
- **VERIFIED:** Added backend profile list, lookup, and update routes under `/api/identity/profiles`.
- **VERIFIED:** Profile IDs are normalized and permissions are deduplicated.
- **PARTIAL:** Profile routes are local profile management, not authentication; sensitive actions still require the existing policy and confirmation mechanisms.
- **NOT IMPLEMENTED:** Voice or camera recognition is not used to silently select or authorize a user.

## Profile-aware conversation status

- **VERIFIED:** Explicit user profiles are now included in the bounded context sent to both HTTP chat and Gemini Live sessions.
- **VERIFIED:** Profile context includes display name, relationship, preferences, communication style, and important context.
- **VERIFIED:** Profile permissions are intentionally excluded from authorization decisions; existing policy and confirmation gates remain authoritative.
- **PARTIAL:** Profile selection currently uses the request or conversation `userId`; authenticated account/device identity is still future work.

## Conversation identity continuity

- **VERIFIED:** Chat persistence now stores the selected `userId` on the existing conversation record.
- **VERIFIED:** Legacy conversations without an identity retain the `default-user` fallback.
- **VERIFIED:** HTTP chat responses return the associated `userId` so clients can retain profile context.
- **PARTIAL:** This is profile continuity, not account authentication; sensitive actions remain governed by policy and confirmation.

## Screenshot verification status

- **VERIFIED:** Screenshot captures now return a unique `screenshot_id`, dimensions, and observation metadata.
- **VERIFIED:** `ScreenVerifier` returns a structured `VerificationOutcome` for valid capture evidence instead of returning `null`.
- **VERIFIED:** Capture verification records the screenshot ID and dimensions as observed state.
- **PARTIAL:** Live screen capture still depends on Windows capture permissions and runtime availability of the Python imaging backend.

## Real-world screenshot verification

- **VERIFIED:** A live Windows smoke test captured the current desktop at 1366x768.
- **VERIFIED:** The capture returned a unique screenshot ID and canonical `ok: true`, `status: SUCCESS`, `verified: true`.
- **VERIFIED:** No cursor, keyboard, application, file, or window mutation was performed by the smoke test.

## Confidence-gated UI targeting status

- **VERIFIED:** Added `resolveUiTarget` over the existing OCR detector; it returns target name, method, confidence, bounds, and center coordinates.
- **VERIFIED:** Added `clickUiTarget`; it uses the real input controller only after a matching target meets the confidence threshold.
- **VERIFIED:** Exact matches are preferred and equal-confidence ambiguity is rejected instead of guessed.
- **VERIFIED:** Target clicks report `action_sent` separately and do not claim the UI changed without postcondition evidence.
- **PARTIAL:** OCR is the current resolver backend; Windows UI Automation/accessibility and application-specific semantic resolvers remain future higher-priority layers.

## Natural conversation signals

- **VERIFIED:** Added a local `ConversationIntentAnalyzer` for command, question, casual, emotional-statement, frustration, and uncertain inputs.
- **VERIFIED:** Detects urgency cues and exposes confidence plus matched cues.
- **VERIFIED:** Signals are included in bounded Gemini context as tentative cues, not diagnoses or asserted emotions.
- **PARTIAL:** Sarcasm, nuanced emotion, and conversational interruption still require model-level or audio-level interpretation; the local analyzer intentionally remains conservative.

## Changed implementation surfaces

- `desktop_agent/desktop_input_controller.py`
- `desktop_agent/tools_hardware.py`
- `desktop_agent/registry.py`
- `server_full.ts`
- `desktop_agent/test_desktop_input_controller.py`
