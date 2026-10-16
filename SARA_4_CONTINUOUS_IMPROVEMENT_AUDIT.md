# SARA 4.0: Continuous Improvement Architecture Audit

**Audit date:** 2026-10-15<br>
**Scope:** Phase 1 only — inspect and document the checked-out application before implementing learning or update behavior.<br>
**Implementation in this phase:** this document only. No application source, database, secret, build output, or runtime-data file was changed.

This audit was checked against the current repository and package entry points. Older root-level audit reports were not treated as authoritative where they conflict with current source. Runtime data contents were not inspected.

## Executive summary

SARA already has useful foundations: a React/Electron interface, a Node/Express backend, a Python desktop-control service, task verification and emergency-stop paths, several local memory stores, and a Gemini integration. It also contains two cognitive/learning implementations with different wiring and persistence behavior.

It does **not** currently have a trusted software-update manager, a staged installer with rollback, a connected learning-record pipeline with user approval and validation, or a single learning/update dashboard. Existing integrity-manifest scripts are local build-integrity tooling, not a remote publisher-authenticated updater. Existing skill generation is not equivalent to safely tested skill promotion. The main chat/voice path calls Gemini generation APIs; repository inspection found no model fine-tuning or training pipeline. That does not establish whether a particular Gemini model/account supports fine-tuning; that question must be checked separately before Phase 8.

The safest approach is additive and incremental: build on the active backend, current memory/task stores, tool-policy and approval gateway, and existing UI panels. Avoid a database consolidation or mobile-platform migration as part of the first learning increment.

## 1. Current application architecture

| Area | Current implementation and evidence | Audit notes |
|---|---|---|
| Renderer | `index.html` loads `main.tsx`; `src/main.tsx` mounts `src/App.tsx` inside `ApiKeyGate`. Vite, React and Tailwind are in `vite.config.ts` and `package.json`. | The root-level `App.tsx` is not the Vite entry imported by `src/main.tsx`; use `src/App.tsx` for UI changes. |
| Desktop shell | `electron/main.cjs` launches the built `dist/server.cjs`, serves the UI from the local backend, and sets `SARA_DATA_DIR` to Electron's writable per-user `userData` directory. `electron-builder.yml` packages NSIS and portable Windows targets. | The active product shell is Electron; updates must leave per-user data and secrets outside the install directory. The Electron source itself explicitly describes auto-update as a later phase. |
| Production backend | `npm run dev` runs `server_full.ts`; `npm run build` bundles that file; `npm start` runs the bundle; `npm run start:prod` uses `startup/startupManager.ts`. | `server.ts` remains as a second/older server implementation, and `mobile_server.ts` is a separate service. New behavior should be placed on the active `server_full.ts` path unless an explicit migration is planned. |
| Desktop agent | `desktop_agent/main.py` exposes the FastAPI service; `desktop_agent/registry.py`, `agents.py`, and `tools_*.py` implement the Python tool and agent runtime. The Node backend calls it through `desktop_agent_bridge.ts`; the default local agent port is 8765. `desktop_agent.spec` and `scripts/build-windows-agent.ps1` produce the packaged agent. | The agent has its own version in `desktop_agent/__init__.py` (`1.0.0`); keep its release and compatibility status distinct from the Node package version. |
| AI provider | Active chat and task planning use `@google/genai` in `server_full.ts` and `server_task_manager.ts`. Chat uses `gemini-3.5-flash`; Live voice uses `gemini-3.1-flash-live-preview`. `server_paths.ts` stores a user-supplied Gemini key in the per-user data directory and does not return the key to the UI. | The principal assistant path is directly coupled to Google GenAI rather than a replaceable provider interface. The repository contains no fine-tune/train job implementation. Do not describe memory, retrieval, or prompt changes as model retraining. |
| Voice | `src/lib/audio.ts` streams microphone audio over the Live WebSocket; the backend configures Gemini Live speech output. `src/lib/wakeWord.ts` uses browser speech-recognition support where available; `src/wake/` includes optional Porcupine and null implementations. | Voice itself is not a separate model-training system. Preserve the Live connection and existing voice controls while adding bounded background services. |
| Native/mobile | The checked-in Android project is `android/`; `capacitor.config.ts` points Capacitor at `dist`, and `package.json` includes Capacitor 8. `mobile_server.ts` is a separate service. `app.json` and `eas.json` contain Expo/EAS metadata, but `package.json` has neither `expo` nor `expo-updates`. There is no checked-in `ios/` directory. | The current native build path is Capacitor/Android, not a verified Expo Updates runtime. `.github/workflows/android-build.yml` refers to `android_app/`, which is absent; the repository contains `android/`. Resolve this mismatch before promising mobile update notifications or OTA installation. |
| Tool authorization and outcomes | `src/core/tools/toolRouter.ts`, `toolRegistry.ts`, and `policyEngine.ts` provide a Node tool-policy boundary; `ConfirmationPanel.tsx` and server approval routes handle explicit approvals. `server_task_manager.ts` uses `AuthoritativeTaskResult` and task-specific verification; `AutomationOrchestrator` and TaskRunner include cooperative stop/checkpoint behavior. | Keep the existing permission gateway authoritative. The cognitive execution route currently invokes `callDesktopAgent` directly; its integration with the same policy and verification path must be explicitly addressed before learned skills can execute tools. |

## 2. Existing learning, memory, and retrieval

### Stores and current UI

- `server_paths.ts` selects `SARA_DATA_DIR` when packaged and `./data` in development; Gemini secrets are stored separately from source code.
- `server_memory.ts` stores chat-derived memories in JSON files and `sara_memory.db` through `sql.js`. It also queues Gemini-based conversation consolidation after replies, with prompt guidance not to retain passwords/secrets/private information. The extractor can add, update, or remove memories without a per-record user approval step; prompt text is not a substitute for a deterministic secret/privacy filter.
- `server_state.ts` stores conversations, tasks, sessions, tool calls, and related state in `data.db` with JSON fallback files. The cognitive subsystem persists episodic, semantic, procedural, and autobiographical memories in separate JSON files under `data/`.
- `src/components/MemoryDashboard.tsx`, mounted by `src/App.tsx`, is the connected user-facing memory panel; `server_full.ts` exposes memory list/create/delete endpoints. The visible panel supports viewing, manual entry, and deletion. Export/report controls also exist in `src/components/MemoryManagementUI.tsx`, but that component is not mounted by the current `src/App.tsx` path.
- `Memory` in `src/lib/memoryTypes.ts` already has optional source, evidence, confidence, verification, and last-verified fields. However, the SQL read/write mapping in `server_memory.ts` omits several of those fields, so records can lose provenance/verification metadata when the SQL.js path is used. No record expiration/review scheduler was found.

### Cognitive learning and skill behavior

- `src/cognitive/episodicMemory.ts`, `semanticMemory.ts`, and `proceduralMemory.ts` provide persistent episode, knowledge, and procedure stores. `src/cognitive/planner.ts`, `orchestrator.ts`, `evaluator.ts`, and `integrationBridge.ts` connect planning, execution, evaluation, and learning for `/cognitive/task/execute`.
- The active cognitive route currently derives `goalAchieved` from the execution result text plus correction/error counts, rather than requiring independently verified outcome evidence. The separate TaskRunner path has a stronger authoritative-result/verification contract; those paths should converge before cognitive outcomes are promoted to confirmed learning.
- `src/cognitive/types.ts` has a correction type and a version string for procedures, but the cognitive route currently passes an empty correction list. The procedure version field does not by itself provide immutable version history, candidate testing, approval, regression monitoring, disablement, or rollback.
- `src/cognitive/memoryConsolidator.ts` schedules hourly consolidation after the cognitive subsystem is initialized. It can create and save a procedure from repeated episodes (minimum three) directly into procedural memory. This is pattern-based memory/skill generation, not a restricted skill test or approval workflow.
- A second generic learning stack exists in `src/services/AdvancedLearningService.ts`, `LearningWorkflowCoordinator.ts`, `ClosedLoopExecutor.ts`, `SkillLibraryAndStrategyManager.ts`, and `src/brain/SARACognitiveBrain.ts`. Repository references show that stack is used by the real-desktop acceptance code and its own components, but it is not initialized in the active `server_full.ts`/`src/App.tsx` request path. Treat it as a candidate to reuse only after tests establish its behavior; do not wire it in wholesale or create a third learning system.
- Search and browser tools exist, and semantic memory can record a source label. No end-to-end knowledge-refresh scheduler, source review/expiration policy, conflict-resolution workflow, or consistent citation/provenance store was found.

## 3. Existing safety, updates, and operational controls

- The current task/automation paths include cancellation, emergency stop, checkpoints, approval states, and verification. These are important foundations, but there are no separate user controls to pause learning, pause update checks, and pause update installation independently.
- `scripts/build-prod.ps1`, `scripts/sign-manifest.cjs`, and `src/security/integrityBaseline.ts` support a **local/manual build integrity baseline**. The signing code uses a local HMAC key under the data directory; an HMAC with a local shared key is not a publisher public-key signature or a trusted remote update channel.
- The active backend explicitly reports integrity monitoring and baseline approval as disabled in `server_full.ts` (`/api/admin/security/status`, `/verify`, and `/approveBaseline`). Do not treat the existence of the integrity scripts or admin dashboard as an active update-security control.
- Repository search found no `electron-updater`/Electron `autoUpdater`, no remote update-manifest consumer, no `expo-updates`, and no staged update/health-monitor/rollback manager. Release packaging is local via `electron-builder` and the Windows agent build script. Current app and desktop-agent versions are both `1.0.0`; the backend health response hardcodes its version as well.
- `package.json` exposes TypeScript lint/build, API, security, voice, closed-loop, persistence, and optional real-desktop test commands. Update-manager and skill-promotion regression suites do not exist yet.

## 4. Data preservation and test-isolation risk

`data/` and `logs/` are ignored in `.gitignore`, but **256 paths under those directories are currently tracked by Git**. This audit counted paths only and did not inspect their contents. Tests in this repository have also previously modified runtime task/tool-event files. Preserve these paths; do not clean, migrate, overwrite, or untrack them as part of this work without separate explicit approval.

Before adding learning/update tests that write state, route them to isolated temporary data directories using `SARA_DATA_DIR` or injected storage adapters, and verify the configured test directory before each write. Update installation must back up and leave the user's `SARA_DATA_DIR`, secrets, checkpoints, browser profiles, and other runtime state untouched.

## 5. Current gaps against the SARA 4.0 request

| Capability | Current status from source inspection |
|---|---|
| Task outcome events | Partial: TaskRunner/tool logs and cognitive episodes exist, but there is no single provenance-rich learning-record schema across paths. |
| User corrections/feedback | Partial: correction types and general approvals exist; cognitive route corrections are currently empty and no consistent feedback-to-future-plan path was found. |
| Verified learning | Partial: TaskRunner uses explicit verification; cognitive episode success is inferred without that evidence. |
| Safe reusable skills | Partial: procedures have a version string and learned patterns can be saved; no restricted candidate runner, automated acceptance suite, approval, regression disable, or rollback lifecycle. |
| Memory view/delete/export | Partial: connected memory panel supports view/add/delete; separate generic UI has exports, but it is not connected to the active App. |
| Privacy and prompt-injection protection | Partial: extraction prompt warns against secrets and memory types support provenance, but no deterministic end-to-end sanitizer or explicit untrusted-content boundary was found. |
| Knowledge freshness | Missing/partial: source fields exist, but persistence mapping is incomplete and no refresh/expiry workflow was found. |
| Trusted update checks/install | Missing: no remote signed manifest, compatibility gate, staged install, post-update health checks, or rollback service. |
| Improvement laboratory | Missing: no isolated code-proposal/test/release workflow. |
| Model fine-tuning | Not present in the repository; provider/account support and economics remain unverified. |
| Dashboard and controls | Partial: memory, settings, monitoring, approvals, and security panels exist; there is no unified learning/update dashboard or independent learning/update pause controls. |
| Mobile update notifications | Not established: Expo/EAS metadata exists, but the package/runtime is Capacitor-based and `expo-updates` is absent. |

## 6. File/component change map for the implementation phases

This is a candidate map based on current code ownership, not authorization to change all files at once. Each phase should be implemented and tested before proceeding; revise the map if an earlier test or schema inspection reveals a safer seam.

| Phase | Existing files expected to integrate with | New modules likely needed |
|---|---|---|
| 1 — Audit (this increment) | None | `SARA_4_CONTINUOUS_IMPROVEMENT_AUDIT.md` only |
| 2 — Outcomes and feedback | `src/cognitive/types.ts`, `integrationBridge.ts`, `evaluator.ts`, `routes.ts`, `server_full.ts`, `src/types/AuthoritativeTaskResult.ts` | A bounded, sanitized learning-record repository/service and tests; choose JSON/SQL ownership only after inspecting migration impact. |
| 3 — Validated skills | `src/cognitive/proceduralMemory.ts`, `memoryConsolidator.ts`, `planner.ts`, `src/core/tools/toolRouter.ts`, `toolRegistry.ts`, `policyEngine.ts` | Skill lifecycle/validation module and restricted fixture-based tests; keep promotion/rollback and permission checks in the Node safety path. |
| 4 — Knowledge refresh | `src/cognitive/semanticMemory.ts`, `server_memory.ts`, `server_full.ts` search routes | Source-aware knowledge service with retrieval dates, review/expiry, conflicts, and trust-boundary tests. |
| 5–6 — Update check, staging, health, rollback | `package.json`, `electron-builder.yml`, `electron/main.cjs`, `startup/`, `server_full.ts`, `desktop_agent/__init__.py`, `desktop_agent.spec`, `scripts/build-prod.ps1` | Update manager and manifest-verification modules, trusted release configuration, staging/backup/health/rollback tests. Do not reuse the local HMAC as a publisher trust root. |
| 7 — Dashboard and controls | `src/App.tsx`, `src/components/SettingsPanel.tsx`, `MemoryDashboard.tsx`, `ConfirmationPanel.tsx`, relevant `server_full.ts` APIs | A dedicated learning/update dashboard component and authenticated control/status endpoints. Reuse existing panels; do not duplicate them. |
| 8 — Optional fine-tuning | Provider configuration under `server_full.ts`/`server_paths.ts` only if later justified | Separate opt-in training/evaluation pipeline only after checking current Gemini model/account support, consent, budgets, and held-out safety evaluations. No training code is justified by this audit alone. |

**Mobile constraint:** before adding release notifications, choose and test the actual Capacitor distribution path or deliberately plan a supported Expo migration. Do not add OTA code based only on `app.json`/`eas.json` metadata, and do not assume OTA can replace native binaries.

**Improvement-lab constraint:** candidate code must run in an isolated temporary sandbox with immutable security/approval/rollback checks. External update manifests and generated code remain untrusted until verified; a model recommendation is never a publisher signature or deployment approval.

## 7. Smallest safe increment and test for Phase 1

The only implementation in Phase 1 is this audit document. The post-write check will verify that required sections and the named current entry-point files exist, then run `git diff --check`. No live services, AI calls, desktop actions, database migrations, or runtime-data writes are required for this documentation-only increment.
