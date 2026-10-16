# SARA capability status: conversation starters, AGI/ASI, and gaps

**Review date:** 2026-10-16<br>
**Basis:** Source/configuration review of the active React app, `server_full.ts`, `agi/`, desktop-agent social policy, and the existing `SARA_10_FEATURE_AUDIT.md`. This is not a live Windows/Android or full end-to-end verification.

## Conversation start: what changed and what already existed

A fresh SARA launch already opens the desktop chat when there is no saved conversation. The empty chat now greets the user with an opening question and provides editable starter prompts for planning, asking what SARA can currently do, discussing AGI versus ASI accurately, or thinking through a problem. Selecting a prompt only drafts it in the composer; it is **not sent** until the user presses Send.

SARA also has an existing *optional* spoken check-in path while a user-started Live voice session is connected. It waits for an idle period and applies cooldown, daily-limit, quiet-hours, quiet-mode, relevance, and topic-grounding rules. Both `proactiveConversation` and `voiceInitiationEnabled` default to **off**. This increment does not enable background speech, wake-word listening, microphone access, or camera access. Users can opt in using Settings; a connected Live session is still required for spoken check-ins.

## AGI and ASI: current truth

- SARA is an AI assistant, not AGI or ASI. AGI means broad, general problem-solving at a human level; ASI is a hypothetical system exceeding human capabilities. These are not features that can be truthfully enabled with a UI toggle or a few code modules.
- The `agi/` directory is an **optional, independent enhancement scaffold**. Its README says the active UI/server do not import it automatically. `agi/config.ts` sets `enabled: false` by default. Its analysis currently uses simple text heuristics; OpenAI/Anthropic wrappers make provider calls only if explicitly instantiated with credentials.
- The active server uses its configured model and existing cognitive/task components; source search found no active `AgiService` integration in the server or renderer. There is no ASI implementation.
- The active system instructions already tell SARA not to claim AGI, ASI, consciousness, unlimited autonomy, or capabilities it does not have. That honesty boundary should remain.

## Main gaps, in priority order

| Priority | Missing or not established | Why it matters / next work |
|---|---|---|
| P0 | General authenticated user/session/role identity and consistent per-user scoping across conversations, tasks, profile, and memory | Identity-profile list/read/write endpoints now require admin authentication and use the configured per-user data directory, but this is not a general user identity boundary. The chat path still trusts caller-provided `userId`, and other routes still depend on caller-provided IDs/source values. Complete the identity and access-control audit before private multi-user deployment. |
| P0 | Repository-wide high-impact action approval bound to the requesting principal/session | The existing approval work is partial; some direct high-impact routes and durable approver/session binding still need review. See `SARA_10_FEATURE_AUDIT.md`. |
| P0 | Full review of tracked runtime data and secret handling | The prior audit found many tracked runtime/data paths; their contents were intentionally not inspected. Review and classify them before release. |
| P1 | Production-grade model evaluation, factuality/grounding, uncertainty calibration, and task-specific success metrics | Provider wrappers, tests, and cognitive classes do not prove broad intelligence or dependable real-world results. Add repeatable evaluations and measure failure rates. |
| P1 | Deliberate integration of the optional `agi/` package, if desired | It is not active in the main chat path. Integration would require choosing a provider, explicit credential/privacy policy, latency/cost limits, safe context handling, and fallback tests. It would still be an experimental reasoning enhancement—not AGI. |
| P1 | Reliable task checkpoints, durable idempotency, recovery, and independent verification on every entry path | Some planning, cancellation, verification, and retry components exist, but behavior varies by route and platform. A first increment now deduplicates async app/browser tool-call deliveries by a stable ID within the same Live session, rejects reuse with changed arguments/scope, and keeps restored matching work paused. A second increment makes AutomationOrchestrator require a structured verification record with attempted/passing status (or the unified verified status) and a non-empty set of all-passing checks before completion or post-success cleanup. Naked/nested `verified` flags, missing checks, failed checks, or contradictory top-level status now pause for review. This remains process/session-scoped, not a durable cross-session idempotency ledger, and does not establish verification on every task entry path. |
| P1 | Per-user memory lifecycle: expiry, contradiction handling, provenance, and complete export/delete | Current memory features are useful but do not establish a private, complete user-data lifecycle. |
| P2 | Verified offline/local-model mode and clear capability reporting | Local provider interfaces exist, but no active offline inference or durable disconnected execution queue was established. |
| P2 | Native platform verification and release safety | Windows UI automation, Android device/emulator behavior, corrected Android CI path, signed/staged updates, backups, rollback, and platform-specific privacy checks still need validation. |
| P2 | Production avatar and expressive speech animation | The current avatar is procedural; it is not a professional skinned model. A licensed external rig/animation asset and timestamped viseme/phoneme data would be needed for production quality and phoneme-level lip-sync. |
| P2 | Full runtime testing of spoken proactive check-ins and interruption/privacy behavior | The feature is opt-in and policy-gated in code, but it still needs controlled live-session tests across reconnect, interruption, quiet hours, and device sleep/lock boundaries. |

## What SARA can do today (source evidence, not a guarantee)

SARA has text chat and a Gemini-backed Live voice path, optional wake-word and screen-sharing controls, a Windows desktop-agent integration, task/project/calendar and memory components, policy/approval mechanisms, cognitive planning code, and an optional procedural 3D companion. Availability depends on configuration, platform, credentials, permissions, and the relevant backend/agent being online. The repository does **not** establish universal computer control, human identity verification from voice, continuous availability, autonomous self-direction, AGI, or ASI.

## Latest identity-security increment (2026-10-16)

The identity-profile management API now requires the existing admin authentication (static admin token or short-lived passkey session), disables response caching, and stores profiles under `SARA_DATA_DIR`. A valid, bounded legacy store is copied once when needed while the old file is retained; profile writes use restrictive file permissions where supported. The profile-store, profile-route, and confirmation-route tests passed 3/3 together, and lint passed. This protects profile administration only: there is still no general user/session/role model, the chat endpoint accepts caller-supplied `userId`, and conversations, memory, and tasks are not consistently owner-scoped.

## Latest task-reliability increment (2026-10-16)

Automation completion and post-success cleanup now require a consistent success/verified state plus a non-empty set of passing verification checks. Both the authoritative task-result and unified execution-result shapes are covered; bare or contradictory verification flags pause for review. The targeted automation/recovery suite passed 14/14, the isolated closed-loop suite passed 28/28, lint passed, and the production build passed with Vite's large-chunk warning. This is a narrow automation-path improvement, not proof of verification across all task paths or durable idempotency.

For the detailed security, feature-state, and prioritized engineering audit, see `SARA_10_FEATURE_AUDIT.md`.
