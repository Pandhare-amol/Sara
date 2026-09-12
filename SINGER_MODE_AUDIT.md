# SARA Singer Mode Audit

Date: 2026-09-05

## Scope

This audit identifies the existing SARA integration points before adding Singer Mode. Singer Mode must remain a separate capability and must not replace the normal assistant voice pipeline.

## Working Components

### Audio and Normal Voice

- `src/lib/audio.ts` contains `SaraAudioSession`, the browser Web Audio pipeline for microphone capture and Gemini Live PCM playback.
- The normal output path uses a 24 kHz `AudioContext`, an output gain/analyser chain, scheduled `AudioBufferSourceNode` buffers, and immediate interruption by stopping active sources.
- The input path uses a 16 kHz microphone stream and sends PCM frames over the `/live` WebSocket bridge.
- `src/lib/wakeWord.ts` provides continuous browser wake-word detection and is the existing voice-interruption entry point.
- This pipeline is designed for conversational speech. It is not a singing synthesis pipeline and must remain unchanged for normal SARA responses.

### Gemini Integration

- `server.ts` and `server_full.ts` use `@google/genai` for the conversational and Live API bridge.
- Gemini is suitable for intent understanding, lyrics, language, song structure, mood, and style orchestration.
- No existing code treats Gemini as a dedicated singing or music generation engine. Singer Mode therefore needs an explicit provider contract and truthful provider availability checks.

### Tasks and Background Work

- `src/core/tasks/taskManager.ts` and `taskRepository.ts` provide persistent task records, lifecycle events, cancellation, retries, and recovery.
- `src/core/automation/automationOrchestrator.ts` provides non-blocking queued execution with progress/event callbacks and task persistence.
- Existing task contracts use generic statuses, so Singer Mode needs a singer-specific lifecycle mapping without changing existing task semantics.

### Conversation and Context

- `src/core/conversation/ConversationManager.ts` and `src/lib/conversationRepository.ts` manage messages and conversation metadata.
- `src/lib/conversationContextManager.ts` builds recent working context and topic summaries.
- `ConversationRestorer` and `server_state.ts` restore task/session context for conversations.
- The conversation record has `active_context`, `task_state`, and `metadata` fields suitable for a temporary singer session reference; full generated lyrics should not be written into permanent memory by default.

### Memory

- `server_memory.ts` and `src/services/MemoryPersistenceService.ts` provide existing persistent memory stores and preference persistence.
- `src/cognitive/` contains working, episodic, semantic, procedural, autobiographical, and consolidation layers.
- Singer Mode should keep active song state in a bounded session store and only promote repeated music preferences through the existing preference/memory path.

### UI and Electron

- The frontend is React/Vite (`App.tsx`, `main.tsx`, and `src/components/`).
- `src/lib/audio.ts` already exposes analyser data used by the conversation voice UI and can remain the normal voice path.
- Electron is configured through `electron/main.cjs` and `electron-builder.yml`; no existing dedicated singer audio IPC or file playback abstraction was found in the audited surface.
- Singer playback should use a separate browser-safe audio session manager with an HTML/Web Audio-compatible source URL, while preserving the existing `SaraAudioSession`.

### Tool and Server Integration

- `src/core/tools/toolRouter.ts` and its initialization layer are the existing server-side tool boundary.
- `server.ts`/`server_full.ts` expose HTTP and WebSocket APIs and route desktop-agent tools separately.
- Singer commands should enter through a dedicated singer intent/tool route, not by modifying the normal TTS response path.

## Reusable Components

- Existing task persistence and event emission from `TaskManager`.
- Existing automation queue patterns for asynchronous, non-blocking work.
- Existing conversation identifiers, correlation IDs, and active context fields.
- Existing server-side credential handling in `ApiCredentialManager` and environment-based configuration.
- Existing audio interruption concepts in `SaraAudioSession` and wake-word detection.
- Existing React component conventions and Lucide icons for a compact player.

## Missing Components

- Singer intent analysis that distinguishes singing from music questions and ordinary playback requests.
- Original/user-provided/public-domain lyric classification and bounded song structure.
- Language-aware style and vocal persona models for English, Hindi, and Marathi.
- `SingingProvider` abstraction with production-safe provider resolution and development/test-only mock support.
- Vocal and instrumental generation services, mixing, verification, cache cleanup, and truthful partial-failure handling.
- Singer-specific asynchronous task lifecycle and session context.
- Dedicated playback/session controls for play, pause, resume, stop, volume, and interruption.
- Server/UI event contract and compact player integration for main conversation and Quick Chat.
- Focused tests for intent detection, non-blocking execution, provider failures, playback controls, and cleanup.

## Integration Points

1. Add singer domain modules under `src/agents/singer/` and provider adapters under the same bounded subsystem.
2. Adapt `TaskManager` through a singer task adapter rather than changing existing task status contracts.
3. Register singer commands at the server/tool boundary and emit progress events through the existing event transport.
4. Store only the active singer context in conversation `active_context`/task state; use existing memory services for explicit preference promotion.
5. Add a separate `src/services/audio/` playback/session layer that consumes verified audio artifacts and never calls normal TTS.
6. Add a compact React player that subscribes to singer state without redesigning the existing shell.

## Risks

- No production singing provider is currently configured, so production must return a clear unavailable-provider error rather than silently synthesize or use normal TTS.
- Server and Vite/browser code run in different environments; filesystem/provider secrets must remain server-side and audio artifacts need safe, bounded delivery.
- Playback interruption must be coordinated with wake-word and normal voice playback so a stop command takes priority without breaking the `/live` session.
- `server.ts` and `server_full.ts` are parallel server surfaces; integration must avoid updating only one runtime entry point.
- Existing integrity manifests may require an explicit baseline update after source changes, but that is a release operation and must not be performed implicitly.
- Generated audio and lyrics may contain sensitive user data; logs must use IDs and stage metadata, not raw lyrics or internal paths.

## Audit Conclusion

The safest first implementation is a provider-backed, asynchronous Singer subsystem with explicit unavailable-provider behavior and an isolated playback manager. Gemini can orchestrate song intelligence, but it must not be presented as the singing audio engine. Existing normal voice, desktop-agent, task, conversation, and memory systems remain the owners of their current behavior.