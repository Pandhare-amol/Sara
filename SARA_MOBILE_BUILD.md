# SARA Mobile Build Plan

Date: 2026-08-22
Status: planning only; no mobile build files exist yet.

## Recommended Pipeline

1. Build the existing React/Vite renderer with the current `npm run build` path.
2. Add a Capacitor Android target that consumes the built web assets.
3. Add native plugins incrementally for secure storage, camera, microphone/audio, notifications, files, network status, and optional screen capture.
4. Sign debug/internal builds separately from release builds.
5. Keep Gemini credentials exclusively in the backend deployment environment.
6. Use a CI Android build only after emulator smoke tests and backend contract tests pass.

## Existing Build Facts

- Desktop build: Vite plus esbuild server bundle.
- Desktop packaging: electron-builder NSIS/portable.
- `app.json` contains an Expo project ID and Android package name, but no Expo source/configuration was found.
- `eas.json` contains EAS profiles, but it does not establish a working Expo application.
- No Gradle, Capacitor, React Native, Flutter, or native Kotlin project exists.

## Release Gates

- Existing desktop build and TypeScript check pass.
- Mobile API/WS authentication tests pass.
- Gemini key scan confirms no key is present in mobile artifacts.
- Android permission denial and revocation paths are tested.
- Device routing tests prove Windows-only actions remain on the Windows device.
- Task state survives mobile WebSocket loss.
- Real-device camera, microphone, notification, file picker, and background behavior are tested.
