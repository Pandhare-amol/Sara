# SARA Mobile Migration Plan

Date: 2026-08-22

## Phase 0: Audit Complete

Documented the current stack, versions, UI design baseline, feature compatibility, shared-core boundaries, device model, build/setup constraints, risks, and test plan. No runtime code changed.

## Phase 1: Shared Contracts

Add versioned TypeScript contracts for authenticated mobile sessions, devices, capabilities, tasks, events, permissions, and result/error states. Keep existing routes and WebSocket messages backward compatible.

## Phase 2: Backend Mobile Boundary

Add authentication, refresh/revocation, device registration, capability discovery, redacted task/event endpoints, and WebSocket authorization to the existing Node backend. Do not expose Gemini keys or the Python Desktop Agent port.

## Phase 3: Device-Aware Routing

Add a facade over the existing TaskManager and ToolRouter. Route by capability and explicit device target. Preserve Python Desktop Agent as Windows authority and do not create a second task persistence system.

## Phase 4: Capacitor Shell and Chat

Create the smallest Android client using existing React/Vite UI contracts. Implement login, shared conversation, live connection state, chat, task list, and notifications before native sensors.

## Phase 5: Native Adapters

Add Android secure storage, microphone/audio, camera/vision, notifications, file picker, network state, and optional screen capture behind platform interfaces. Request permissions just in time.

## Phase 6: Cross-Device Tasks

Implement phone-to-PC commands, PC state visibility, task progress, confirmation, recovery, and truthful final results. Verify Windows-only capabilities remain Windows-routed.

## Phase 7: Offline and Reliability

Add encrypted cache, reconnect/backoff, token refresh, event replay/reconciliation, task restoration, and push/local completion notifications.

## Phase 8: Release Validation

Run desktop regression, backend/API/WS tests, Android emulator tests, real-device permission tests, security scans, build/signing checks, and manual cross-device acceptance.

## High-Risk Items

- Existing `server.ts`/`server_full.ts` drift.
- Existing mobile server creates separate Gemini/mobile memory behavior.
- Existing companion token handling is not production mobile authentication.
- Multiple task/memory authorities exist.
- WebSocket `/live` currently assumes browser-local audio and needs an authenticated mobile-compatible protocol.
- Browser wake-word support is not equivalent to Android background wake-word support.
- Desktop screen/file/browser operations require network, authorization, privacy controls, and explicit device routing.

## Files to Preserve

`electron/main.cjs`, `electron/preload.cjs`, `server_full.ts`, `server.ts`, `desktop_agent/`, `src/core/tools/`, existing memory stores, existing Gemini code, and existing desktop UI components. Changes should be additive or adapter-based until replacement behavior is proven.
