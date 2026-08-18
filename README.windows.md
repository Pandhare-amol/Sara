Windows Build & Packaging for SARA

This document describes how to build a native Windows installer for SARA.
It assumes a Windows developer machine with Node.js, npm, and Python installed.

Prerequisites
- Node.js 18+ and npm
- Git
- Windows: PowerShell
- Python 3.11+ (for building the Python desktop agent) and PyInstaller
- Optional: SoX (for Porcupine microphone capture), if using PorcupineWake

High-level steps
1. Install JS dependencies

   npm install

2. Build web + server bundle

   npm run build

3. Build Python desktop agent (PyInstaller) — this script will try to package `desktop_agent/main.py`:

   npm run build:agent

   If you already have a prebuilt agent, place it under `agent_dist/sara-agent/`.

4. Create Windows installer (NSIS)

   npm run dist

Notes
- The installer includes `agent_dist/sara-agent` into the application resources. Ensure the Python agent was built or copied there before packaging.
- Porcupine keyword files (if used) should be placed under `data/porcupine/keyword.ppn` and will be bundled into the installer by `electron-builder` per `electron-builder.yml`.
- The installer uses NSIS and will create a Start Menu shortcut and desktop shortcut by default.

Post-install
- After install, the app can optionally install a per-user Task Scheduler entry to start SARA on login. This is handled by the app's Settings panel; the installer does not auto-enable auto-start.

Troubleshooting
- If the PyInstaller build fails due to missing deps, create a virtualenv, `pip install -r desktop_agent/requirements.txt`, and re-run the build script.
- If mic capture via Porcupine fails on Windows, install SoX and ensure `sox`/`rec` is on PATH, or use the browser-based wake detector instead.

If you want, I can now:
- Add an Electron `main` build entry and ensure `dist/server.cjs` is packaged and launched by Electron on startup.
- Implement the Task Scheduler registration helper (PowerShell) and UI toggle wiring.

Which of those would you like next? (I can implement the Task Scheduler opt-in now.)