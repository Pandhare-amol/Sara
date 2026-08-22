# SARA Mobile Architecture

Date: 2026-08-22
Status: approved-for-design only; no mobile runtime created in this audit.

## Target Shape

```text
Capacitor Android SARA client
  -> authenticated REST + WebSocket
  -> existing Node SARA backend
  -> Gemini, memory, context, tasks, ToolRouter, policy
  -> device-aware routing
       -> Windows Desktop Agent / Electron
       -> Android capability adapter
```

The phone is a client, not a second SARA backend. Gemini credentials, authoritative memory, task persistence, ToolRouter, and safety policy remain server-owned.

## Existing Owners to Preserve

- `server_full.ts` is the production build source; `server.ts` is a parallel development surface that must not drift further.
- `server_state.ts` owns Node conversations, sessions, tasks, tool calls, and audit state.
- `server_memory.ts` and existing cognitive services remain backend memory surfaces until an explicit consolidation migration.
- `desktop_agent/main.py` and `desktop_agent/registry.py` remain the Windows execution authority.
- `src/core/tools/toolRouter.ts`, `src/core/tools/execution/executionOrchestrator.ts`, and policy/verification modules remain the routing/execution boundary.
- `electron/main.cjs` remains the Windows shell and screen-capture owner.

## New Boundaries, Additive Only

### Core API

- `MobileAuthService`: access token, refresh token, device registration, logout, expiry.
- `ConversationService`: REST history plus authenticated live WebSocket.
- `TaskService`: submit/status/cancel/retry/subscribe; backed by existing task persistence.
- `MemoryService`: shared API access, optional encrypted mobile cache.
- `DeviceRegistry`: user devices, capabilities, status, permissions, last-seen.
- `DeviceAwareTaskRouter`: selects Android or Windows based on capability and explicit target.
- `MobileCapabilityGateway`: validates and dispatches camera, microphone, files, notifications, and screen operations.

### Platform Adapters

- Desktop: existing Electron, Windows, Desktop Browser, Desktop Screen, and Desktop Agent paths.
- Android: camera, microphone/audio, notifications, secure storage, files/SAF, mobile browser, and optional screen capture.

## Transport

REST is used for authentication, history, memory, settings, device registration, task queries, and upload metadata. WebSocket is used for live conversation, Gemini audio events, task progress, automation events, connection state, and notifications. The mobile client must authenticate before opening either channel and refresh credentials without losing task context.

## Security Requirements

- Never ship `GEMINI_API_KEY` or provider secrets in the APK.
- Do not expose `127.0.0.1:8765`; mobile reaches the authenticated Node backend, which reaches the local Desktop Agent.
- Use TLS outside localhost deployment, short-lived access tokens, refresh rotation, device revocation, rate limits, origin/device checks, and redacted logs.
- Keep confirmation and policy decisions in the backend. A mobile UI confirmation is an input event; assistant-generated text is never confirmation.

## Migration Sequence

1. Define versioned shared API/WS schemas without changing existing routes.
2. Add backend authentication/device registry as additive middleware and endpoints.
3. Add device-aware routing over the existing TaskManager/ToolRouter; do not create a parallel task store.
4. Extract shared visual contracts from the current React renderer and create a Capacitor shell.
5. Implement mobile chat and task status first using existing backend behavior.
6. Add secure storage, permissions, camera, microphone/audio, notifications, and file picker one adapter at a time.
7. Add cross-device actions and PC screen sharing after device capability tests pass.
8. Add offline cache/reconnect and background notification behavior.
9. Run desktop regression, API/WS, Android emulator, and real-device tests before release.

## Explicit Non-Goals

No rewrite of Electron, Node, Gemini, memory, ToolRouter, Desktop Agent, or existing desktop UI. No direct Android implementation of Windows shutdown, Win32 automation, or Desktop Agent browser control.
