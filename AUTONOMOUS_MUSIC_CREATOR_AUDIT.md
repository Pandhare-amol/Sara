# SARA Autonomous Music Creator Phase 2 Audit

Date: 2026-09-06

## Existing Owners

- Durable database: `server_state.ts` initializes `data/data.db` with existing `music_projects` and `music_assets` tables.
- Music project management: `src/services/music_studio/project_manager.ts` creates, reads, updates, and lists projects through the SQL bridge.
- Asset persistence: `src/services/music_studio/asset_manager.ts` stores project artifacts under `data/projects/<projectId>/assets` and records them in `music_assets`.
- Song intelligence: `src/services/music_studio/concept_agent.ts` and `lyric_agent.ts` use Gemini and persist concept/lyrics updates with basic lyric versioning.
- Existing task orchestration: `server_state.ts` task records plus `server_task_manager.ts` background `TaskRunner`; `src/core/automation/automationOrchestrator.ts` is another existing runtime orchestrator for automation tasks.
- Tool routing and policy: `src/core/tools/toolRouter.ts`, `toolRegistry.ts`, and `executionOrchestrator.ts` provide routing, permission policy, retries, structured results, and verification hooks.
- Verification: `src/core/tools/verification/verificationRegistry.ts` and `src/core/verification/verificationEngine.ts` verify registered tool effects; filesystem and browser/screen verifiers already exist.
- Desktop/browser: `desktop_agent/` exposes YouTube, browser, file, and media tools; official YouTube upload support exists as a desktop tool surface but must be independently verified before publishing.
- Conversation/memory: `server_state.ts`, conversation repositories, `server_memory.ts`, and cognitive memory modules provide context and selective persistence.
- UI: React/Vite existing shell, Quick Chat, task panels, and compact Singer player. No redesign is required.

## Reusable Integration Points

1. Extend `music_projects` with workflow/checkpoint metadata rather than creating a second JSON project store.
2. Reuse `MusicProjectManager` and `MusicAssetManager` for projects and immutable versioned artifacts.
3. Wrap concept/lyrics/music/video/publishing stages as one persistent music workflow submitted to the existing task system.
4. Use provider interfaces for music/vocals/artwork/video/publishing and reject unavailable providers truthfully.
5. Use the existing ToolRouter/execution and policy boundary for external publishing actions.
6. Use existing verification contracts for file/artifact and platform result verification.
7. Persist only useful creator preferences/analytics observations through existing memory services.

## Missing Components

- Typed Phase 2 project workflow state and durable checkpoints.
- Music provider registry with health, async job, cancellation, retry, and timeout contracts.
- Structured creative brief and creation-agent orchestration over existing concept/lyrics agents.
- Audio/video/artwork quality verification.
- Official publishing provider contract and approval gate.
- Instagram content preparation and comment-draft policy workflow.
- Analytics observation storage and selective creator learning.
- Minimal project/task endpoints and UI status integration.

## Risks

- Existing `music_projects` schema is present but has no workflow checkpoint, approval, or provider job fields.
- The existing desktop browser suite contains fallback-looking response paths; publishing must not claim success from browser return values alone.
- No configured production singing/music/video/artwork provider is present in the audited code. Production must remain unavailable until a real adapter and credentials are configured.
- `server.ts` and `server_full.ts` are parallel entry points; production build targets `server_full.ts`, but shared domain modules should stay entry-point independent.
- SQL bridge query construction in the existing project manager interpolates IDs; new persistence code must use parameterized statements.

## Phase 2 Boundary

Implement durable project/workflow contracts, stage checkpoints, provider abstractions, creative brief orchestration, artifact quality verification, and approval-aware status APIs first. Do not fabricate media or publish through an unverified browser response. Real generation/publishing remains provider-dependent and must report unavailable credentials or adapters honestly.
