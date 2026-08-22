# SARA Mobile Setup Plan

Date: 2026-08-22
Status: not yet implemented.

## Prerequisites

- Node/npm versions compatible with the current Vite/TypeScript toolchain.
- Android Studio, Android SDK, and a device/emulator.
- Java/Gradle versions required by the selected Capacitor release.
- A reachable, authenticated SARA Node backend. The phone must not call the local Desktop Agent port directly.
- TLS or a controlled development network tunnel for non-localhost use.

## Planned Initial Client

Use Capacitor around the existing React/Vite renderer. Keep the current desktop renderer build intact and introduce a mobile build target/configuration only after shared API boundaries are defined. Do not install packages or create native files as part of the audit.

## Required Environment Concepts

- `SARA_API_BASE_URL`: authenticated Node backend URL.
- `SARA_WS_URL`: authenticated live WebSocket URL.
- No `GEMINI_API_KEY` in mobile environment, source, assets, or build secrets.
- Development-only device registration and test credentials must be separate from production credentials.

## First Run Flow

1. Launch the mobile shell.
2. Show backend connection state.
3. Authenticate/register device.
4. Load profile, conversation, memory summary, tasks, and capabilities.
5. Connect live WebSocket only after authentication.
6. Request microphone/camera/notification permissions only when the user invokes the corresponding feature.
7. Restore active tasks and subscribe to progress events.

## Offline Behavior

Display `OFFLINE`, preserve cached conversations/settings, stop claiming Gemini results, and queue only explicitly safe operations. On reconnect, refresh auth/session, reconcile task IDs and events, and restore context from the backend.
