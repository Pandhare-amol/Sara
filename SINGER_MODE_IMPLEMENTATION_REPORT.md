# SARA Singer Mode Implementation Report

Date: 2026-09-05

## Implemented

- Added the required architecture audit in `SINGER_MODE_AUDIT.md`.
- Added an isolated singer domain under `src/agents/singer/`:
  - `SingerTypes.ts` with intent, plan, persona, session, audio, and lifecycle contracts.
  - `SongIntentAnalyzer.ts` for singing versus music discussion/playback/control detection.
  - `MusicStyleEngine.ts` for mood/style/language/duration plans and bounded song sections.
  - `LyricsManager.ts` for user-provided lyric validation and original lyric planning.
  - `SingerProviders.ts` with a provider abstraction, truthful unavailable production provider, and opt-in development/test mock.
  - `SingerSession.ts` for task and temporary singer context.
  - `SingerAgent.ts` for asynchronous orchestration, retries, progress stages, cancellation, and truthful failures.
  - `AudioMixer.ts` requiring readable, verified mono PCM16 WAV artifacts before mixing.
  - `AudioCacheManager.ts` for bounded temporary cache cleanup.
- Added a separate browser playback path:
  - `src/services/audio/AudioPlaybackManager.ts`
  - `src/services/audio/AudioSessionManager.ts`
- Added server integration to `server_full.ts`:
  - `POST /api/singer/intent`
  - `POST /api/singer/tasks`
  - `GET /api/singer/tasks/:taskId`
  - `GET /api/singer/tasks/:taskId/audio`
  - `GET /api/singer/current`
  - `POST /api/singer/tasks/:taskId/cancel`
  - `POST /api/singer/control`
  - Existing WebSocket clients receive `singer:task` and `singer:control` events.
- Natural requests sent through `/api/chat` now route singing requests and singer stop/pause/resume controls into the same asynchronous Singer Agent, so the main chat and Quick Chat entry points share one implementation.
- Quick Chat now preserves its conversation ID on `/api/chat`, and the Singer player observes both the main conversation and Quick Chat, selecting the newest active singer task.
- Gemini is used only for original lyric orchestration. It is not treated as an audio singing engine.
- Added `SingerPlayer.tsx` as a compact, additive player with play, pause, resume, stop, and volume controls.
- Existing normal `SaraAudioSession`, Gemini Live speech path, wake-word detector, desktop agent, and task contracts were preserved.

## Partially Implemented

- The provider interface, vocal/instrumental split, retry policy, artifact verification, mixing contract, cache policy, task lifecycle, and playback controls are implemented.
- User-provided lyrics are supported through the asynchronous pipeline.
- English, Hindi, and Marathi intent/language inference is supported.
- Full production playback depends on a configured real singing provider that returns verified mono PCM16 WAV artifacts.

## Not Implemented

- No real cloud or local singing provider adapter was added because no provider, credentials, API contract, or audio engine was configured in the repository.
- Automatic Gemini-based lyrics generation requires the existing Gemini API key and only creates lyrics; it does not create singing audio.
- Active singer context is held in the bounded process session store and returned by the singer API. It is not yet persisted into conversation `active_context` across process restarts.
- Provider-backed pause/resume/next semantics are represented at the playback boundary but are not implemented for a remote generation provider.
- The parallel legacy `server.ts` entry point was not modified; the repository build and production script target `server_full.ts`.

## Known Limitations

- Production intentionally returns `SINGER_PROVIDER_UNAVAILABLE` instead of using normal TTS, pitch shifting, dummy audio, or a silent fallback.
- The built-in mixer accepts only verified mono PCM16 WAV files with matching sample rates.
- The current player serves verified cache artifacts through the server endpoint; a production deployment should add authenticated/expiring artifact URLs if remote clients are exposed.
- Permanent music preference promotion into existing memory services is not automatic yet, preventing generated songs from polluting long-term memory.

## Verification

- `npx tsc --noEmit`: passed.
- `npx tsx --test tests/singer-mode.test.ts`: passed, 3 tests.
- `npm run build`: passed for Vite and the bundled `server_full.ts` production server.
- Runtime smoke test on port `3010`: passed intent analysis and async task submission.
- Runtime smoke test confirmed task creation is real and provider failure remains truthful when no singing provider is configured.
- An initial test failure caught Latin-script Marathi detection; the classifier was corrected and the focused suite was rerun successfully.

## Provider Setup Requirement

To enable real end-to-end singing, implement a `SingingProvider` adapter that returns verified vocal and instrumental WAV artifacts, register it in `createSingingProvider()`, keep provider secrets in environment variables, and add provider-specific integration tests. Production must not set `SARA_SINGER_MOCK=true` and must never silently fall back to the mock provider.
