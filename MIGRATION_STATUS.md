# SARA Architecture Migration Status

Status date: 2026-08-19
Current phase: Phase 2 — Tool Router

## WORKING

- Electron UI and existing layouts remain unchanged.
- Existing Node backend build succeeds.
- Python Desktop Agent remains the authoritative Windows executor.
- Python registry and capability discovery remain active.
- Existing `/execute`, `/health`, `/capabilities`, `/live`, task, memory, browser, screen, and desktop APIs remain in place.
- Persistent Python memory and platform memory restart verification pass.
- Real MSS/PIL screen monitoring lifecycle passes.
- Existing tool names and arguments remain compatible.
- Existing TypeScript typecheck passes.

## PARTIAL

- `server.ts` and `server_full.ts` still contain duplicated backend source logic.
- Python, Node task manager, and TypeScript brain still have separate verification helpers.
- Memory remains distributed across Node sql.js/JSON, Python SQLite, and TypeScript cognitive stores.
- Provider failover beyond Gemini is not yet implemented.
- TypeScript `ScreenPerceptionEngine.ts` still contains placeholder behavior and has not yet been switched to the real Python/Electron state adapter.
- Window state is real in Python, but no single cross-layer window DTO/event stream exists yet.
- Structured metrics/tracing and the full event bus are not yet implemented.

## BROKEN

- No new Phase 2 regression was introduced.
- The audit identified no newly broken production feature during this phase.
- Existing build warning: `server_state.ts` uses `import.meta` while the production backend is bundled as CommonJS. Build succeeds, but this remains a production hardening item.

## UNCHANGED

- Electron renderer design and existing controls.
- Python Desktop Agent implementations.
- Existing browser automation and Windows automation implementations.
- Existing startup supervisor and process ownership behavior.
- Existing safety and confirmation controls.
- Existing memory databases and JSON compatibility files.
- Existing Gemini Live conversation path.

## MIGRATED

### Phase 0 — Audit

- Added `ARCHITECTURE_AUDIT.md`.
- Added `FEATURE_COMPATIBILITY.md`.
- Documented processes, ports, databases, APIs, memory stores, risks, and migration boundaries.

### Phase 1 — Contracts

- Added `src/core/contracts/toolContract.ts`.
- Defined shared execution, verification, final-status, error, correlation, and canonical result types.

### Phase 2 — Tool Router

- Added `src/core/tools/toolRegistry.ts`.
- Added `src/core/tools/toolExecutor.ts`.
- Added `src/core/tools/toolRouter.ts`.
- Added `src/core/tools/index.ts`.
- Wrapped existing `callDesktopAgent()` entry points in both `server.ts` and `server_full.ts`.
- Unknown tools are rejected before execution.
- Existing transport and Python execution remain unchanged.
- Existing adapter payloads are preserved while canonical result data is attached.
- Added `tests/tool_router.test.ts`.

## CHANGED FILES

| File | Change | Reason | Risk | Test status |
|---|---|---|---|---|
| `src/core/contracts/toolContract.ts` | Added shared tool result types/status model | Establish one contract for adapters | Low; passive types only | Typecheck passed |
| `src/core/tools/toolRegistry.ts` | Added Node routing metadata registry | Describe ownership without duplicating Python tools | Low | Typecheck passed |
| `src/core/tools/toolExecutor.ts` | Added legacy-result normalizer | Preserve old payloads while exposing canonical fields | Low | Router tests passed |
| `src/core/tools/toolRouter.ts` | Added centralized routing boundary | Route existing calls through one orchestration point | Medium | Router tests passed |
| `src/core/tools/index.ts` | Added exports | Stable import boundary | Low | Typecheck passed |
| `server.ts` | Routed existing Desktop Agent calls through ToolRouter | Integrate Phase 2 without changing callers | Medium | Build/typecheck passed |
| `server_full.ts` | Routed production backend Desktop Agent calls through ToolRouter | Keep development/production paths aligned | Medium | Production build passed |
| `tests/tool_router.test.ts` | Added unknown-tool and result-preservation tests | Verify router behavior | Low | 2/2 passed |
| `ARCHITECTURE_AUDIT.md` | Added repository audit | Required Phase 0 baseline | None | Reviewed |
| `FEATURE_COMPATIBILITY.md` | Added feature matrix | Track non-breaking migration | None | Reviewed |
| `MIGRATION_STATUS.md` | Added this report | Required phase status | None | Reviewed |

## NEXT

### Phase 3 — Execution and Verification

1. Add a shared Node execution/verification adapter around the existing Python canonical result.
2. Remove only duplicated inference in `server_task_manager.ts`; do not remove Python verification.
3. Ensure browser/window/file operations use independent postconditions where available.
4. Add retry classification and timeout policy at the router boundary.
5. Add integration tests for Node → Router → Python → Verification → Result.

### Phase 4 — Desktop Agent Adapter

1. Add `src/adapters/desktopAgent/desktopAgentClient.ts` around the existing transport.
2. Move health/capability/recovery concerns behind that adapter.
3. Keep `callDesktopAgent()` as a backward-compatible facade.

### Phase 5 — Screen/Vision Adapter

1. Replace TypeScript screen placeholders with calls to the real `/screen/live/*` and active-window APIs.
2. Preserve explicit Electron/browser screen-sharing behavior.
3. Do not create a second capture loop.
