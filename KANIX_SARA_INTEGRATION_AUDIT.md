# KANIX to SARA Integration Audit

## Conclusion

SARA already contains the major KANIX-style boundaries. The project should be evolved through adapters and stronger contracts, not by adding a second assistant architecture.

Production ownership is split deliberately:

- Gemini and conversation/voice Live sessions: `server_full.ts`, `src/lib/audio.ts`
- Node routing and execution verification: `src/core/tools/`
- Executable Windows/browser/file/media tools: `desktop_agent/`
- Durable task records and SQL.js/JSON persistence: `server_state.ts`, `server_task_manager.ts`
- Planning, working memory, episodic/semantic/procedural memory, strategy, and evaluation: `src/cognitive/`
- Security, integrity, audit, and redaction: `src/security/`
- Startup/process supervision: `startup/`
- Existing UI: `src/App.tsx` and `src/components/`

The first safe migration slice is a metadata/policy facade on the existing TypeScript `ToolRegistry`. It does not duplicate Python handlers. It gives routing, execution, verification, retry, logging, and future planners one stable description of each capability while preserving legacy tool payloads through `normalizeToolExecutionResult()`.

## Capability map

| KANIX capability | Existing SARA owner | Decision |
|---|---|---|
| Gemini intelligence and streaming | `server_full.ts`, `server.ts`, `src/lib/audio.ts` | Keep; central provider/session wrapper is a later incremental slice |
| Tool registration | `desktop_agent/registry.py` plus Node `src/core/tools/toolRegistry.ts` | Keep Python handlers; strengthen Node compatibility metadata |
| Structured results | `src/core/contracts/toolContract.ts`, `toolExecutor.ts`, `server_task_manager.ts` | Keep and make normalization richer at the routing boundary |
| Execution and verification | `ExecutionOrchestrator`, `VerificationRegistry`, Python `/execute` | Keep; add metadata-driven defaults and verification references |
| Safety and policy | `src/security/securityManager.ts`, Python confirmation tools, retry policy | Keep; expose risk metadata without bypassing existing checks |
| Durable tasks | `server_state.ts`, `server_task_manager.ts`, Python background tasks | Keep; do not add another database or task runner |
| Async automation | `src/core/automation/automationOrchestrator.ts` | Keep and connect metadata/cancellation policy |
| Windows/app/window/mouse/keyboard | `desktop_agent/tools_windows.py`, `tools_window_extra.py`, `tools_applications.py`, `tools_hardware.py` | Keep; improve individual verification adapters only where needed |
| Browser and YouTube | `desktop_agent/tools_browser.py`, `tools_youtube.py`, browser suite | Keep one Playwright owner; current browser lock/timeouts/playback verification are the right extension point |
| Files and clipboard | `desktop_agent/tools_files.py`, `tools_file_extra.py`, `tools_clipboard.py` | Keep; use existing task verification and policy metadata |
| WhatsApp/messaging | `desktop_agent/tools_whatsapp.py`/related modules and `server_full.ts` routes | Keep; external side effects remain confirmation/idempotency-sensitive |
| Perception/OCR/screen | `desktop_agent/tools_screenshot.py`, screen monitor/live tools, renderer capture | Keep; prefer cached/event-driven state before Gemini vision |
| Memory/RAG/learning | `server_memory.ts`, `src/cognitive/`, Python platform core | Keep; use ranked retrieval and existing consolidation |
| Shutdown | `server_full.ts /api/system/shutdown`, startup supervisor, Python `SelfShutdownManager`, power confirmation tools | Keep separate SARA shutdown from Windows shutdown |
| Plugins/skills | Python plugin/skill libraries and `src/services` | Keep; register metadata through the common facade |
| Logging/audit | `AuditLogger`, structured tool events, server logs | Keep; add correlation/task metadata and redaction at adapters |

## Important existing gaps

1. The Node registry has no complete metadata contract and is not populated uniformly.
2. Python tool results are legacy-shaped; Node normalization is the compatibility boundary and should remain authoritative for callers.
3. `server.ts` and `server_full.ts` contain overlapping backend paths. Production build uses `server_full.ts`; changes to shared execution behavior should be made in the production path and mirrored only when required for compatibility.
4. Durable task state exists, but the recent in-memory `AutomationOrchestrator` is not yet persisted as a second task record. It should emit into `server_state`/existing task runner rather than introduce new storage.
5. Verification coverage is uneven: browser/YouTube and file paths are stronger than messaging/application/window postconditions.
6. `SecurityManager` is currently integrity/audit-focused; operational risk decisions remain distributed between Python confirmation tools, server routes, and retry policy. Metadata can unify descriptions without silently replacing those checks.
7. The existing Playwright voice E2E runner has an ESM/CommonJS configuration mismatch and must be repaired separately before claiming full regression coverage.

## Incremental implementation order

1. Add versioned tool metadata to the existing Node registry and seed it from the existing runtime tool set.
2. Make legacy result normalization include stable `ok`, `error_code`, `retryable`, and verification fields while preserving existing fields.
3. Route policy-aware retry/cancellation decisions through metadata and the existing retry policy.
4. Persist async automation lifecycle into existing tasks/tool calls; do not create another database.
5. Add missing postcondition verifiers for high-value Windows/application/messaging actions.
6. Wrap existing Gemini construction/session handling in a provider only after measuring and testing the current Live path.
7. Improve perception with cached state and event-triggered capture, leaving the UI protocol intact.
8. Repair and broaden regression tests, then run real Windows/browser/Gemini smoke tests with the required dependencies.

## Safety boundaries

- Gemini selects intent/tools; it never receives direct OS privileges.
- External content remains untrusted input and cannot alter system/policy instructions.
- Dangerous operations retain existing confirmation and non-retry protections.
- Existing public tool names, API routes, Python Desktop Agent, UI, memory files, and databases remain compatible.