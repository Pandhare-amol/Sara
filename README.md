# SARA – Smart Assistant for Real‑time Automation

> **Created by Mr Amol Pandhre & the SARA Team**

[![Build](https://img.shields.io/badge/build-passing-brightgreen)](.) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org) [![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://python.org)

---

## Table of Contents
- [Project Overview](#project-overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Development Mode](#development-mode)
- [Production Mode](#production-mode)
- [Windows Auto-Start](#windows-auto-start)
- [Build System](#build-system)
- [Security & Integrity](#security--integrity)
- [Testing](#testing)
- [Scripts Reference](#scripts-reference)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

---

## Project Overview
SARA (Smart Assistant for Real‑time Automation) is an extensible, agent‑driven desktop companion powered by Google Gemini. It combines a React/Electron frontend, a Node.js backend, and a Python FastAPI desktop agent into a single cohesive product.

**Core capabilities:**
- 🧠 Goal-oriented natural language command execution
- 🪟 OS-level window management (focus, minimize, restore, desktop control)
- 🔄 Reinforcement-learning reward engine (task verification + +1/−1 rewards)
- 🔐 Build identity metadata and local audit events
- 🚀 Single-click production launcher with dependency-aware startup
- 🗃 Persistent personal memory (SQLite + RAG)
- 🎙 Voice and natural language interface

---

## Key Features
| Feature | Description |
|---------|-------------|
| **Live Screen & App Control** | `listWindows`, `focusWindow`, `minimizeOtherWindows`, `showDesktop` via native Win32 APIs |
| **Reward Engine** | Verified task outcomes → +1/−1 reward stored in `sara_memory.db` |
| **Build Watermark** | `SARA_NAME`, `SARA_VERSION`, `BUILD_ID`, `BUILD_TIMESTAMP`, `BUILD_HASH` in every build |
| **Integrity tooling status** | A manifest generator is available for evaluation; the active backend does not verify or trust a baseline |
| **Production Launcher** | `start-sara-prod.bat` — one click starts everything in order |
| **Crash Recovery** | Automatic service restart with bounded retries (max 3) |
| **Duplicate Process Guard** | Health-check before start; reuses existing healthy processes |
| **Windows Auto-Start** | Task Scheduler registration via `npm run register-startup` |
| **Local System Monitor** | CPU, RAM, system-disk, battery (when supported) and top-process snapshots; repeated high-use and low-battery alerts. Closing a high-use app requires admin verification and explicit confirmation; SARA requests a graceful close and never force-kills it. |
| **General Projects & Tasks** | Local persistent projects, statuses, priorities, due dates and task progress in `general-projects.json`; separate from music production projects. |

---

## Architecture

```
┌─────────────────────────────────────────┐
│              SARA Launcher               │
│         start-sara-prod.bat              │
└──────────────────┬──────────────────────┘
                   │
         startup/startupManager.ts
                   │
    ┌──────────────┼──────────────────┐
    ▼              ▼                  ▼
Database      Backend (Node)     Desktop Agent (Python)
data.db       port 3000          port 8765
sara_memory.db  server_full.ts   desktop_agent/main.py
    └──────────────┼──────────────────┘
                   ▼
          Health Checks + SARA READY
                   │
              Electron UI
```

---

## Prerequisites
| Tool | Version |
|------|---------|
| **Node.js** | >= 18.x |
| **npm** | >= 10.x |
| **Python** | >= 3.11 (Windows) |
| **pip** | latest |
| **PowerShell** | 5.1+ |
| **Git** | any |

> **Note**: SARA targets Windows OS (uses `win32gui`, `psutil` for window management).

---

## Installation

```powershell
# 1. Clone the repository
git clone https://github.com/Pandhare-amol/Sara.git
cd Sara

# 2. Install Node dependencies
npm ci

# 3. Set up the local Python desktop agent
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r desktop_agent/requirements.txt

# 4. Create a private local environment file
Copy-Item .env.example .env
# Edit .env and set GEMINI_API_KEY and SARA_ADMIN_TOKEN
python -c "import secrets; print(secrets.token_urlsafe(32))"  # paste output into .env; never share it
```

---

## Development Mode

Start the backend and Vite UI with one command:

```powershell
.\.venv\Scripts\Activate.ps1
npm run dev
```

Open **http://localhost:3000**. The backend probes for the local Python desktop agent and attempts to start it when the virtual environment is installed. If the startup log says the agent is unavailable, use a second PowerShell window:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765 --reload
```

Keep the Node backend and desktop agent bound to loopback (`127.0.0.1`) for normal local use. Do not expose them to a LAN or the public internet by changing the bind address unless you also configure TLS, the remote access token, firewall restrictions, and allowed hosts/origins. The desktop agent's local port is not intended to be public. `DEVELOPMENT_MODE` does not enable integrity protection; the active backend reports integrity monitoring as disabled.

For Linux/macOS, activate `.venv` with `source .venv/bin/activate`; install the same `desktop_agent/requirements.txt` and run `npm run dev`.

To run a separate Vite UI on port 3178 while keeping the backend local, first allow that exact local origin in the backend terminal, then open a second terminal for Vite:

```powershell
# Backend terminal (before npm run dev)
$env:SARA_ALLOWED_ORIGINS = "http://localhost:3178"
npm run dev

# UI terminal
$env:SARA_UI_API_PROXY_TARGET = "http://127.0.0.1:3000"
$env:SARA_PREVIEW_HOST = "localhost"
npm run dev:ui -- --host 127.0.0.1 --port 3178 --strictPort
```

For a hosted preview, set `SARA_PREVIEW_HOST` to that preview's exact hostname and set `SARA_ALLOWED_ORIGINS` in the backend environment to its exact `https://` origin. Keep the backend bound to loopback and expose only Vite; do not use wildcard hosts or origins.

---

## Integrations and privacy

- **Weather:** Open-Meteo is available without an API key. A city name is geocoded by Open-Meteo; a city or coordinates are sent to that provider only when weather is requested. OpenWeatherMap remains an optional keyed provider.
- **News and finance:** optional NewsAPI and Alpha Vantage adapters use `NEWSAPI_DEFAULT_API_KEY` and `ALPHAVANTAGE_DEFAULT_API_KEY` from the server environment. Never paste these values into chat or commit them. The server reports only whether a credential is configured, never its value. Provider catalog entries are metadata; importing the public-apis catalog does not create working integrations or supply credentials.
- **Search:** the DuckDuckGo Instant Answer API needs no key but returns instant answers and related topics, not full search-result pages.
- **Calendar:** SARA now has a local-only event calendar with ICS export. It does not connect to Google Calendar or Outlook; exporting an `.ics` file lets you import events there. Calendar records stay in SARA's private data directory.
- **Camera:** the preview starts only after an explicit camera action. Vision analysis sends one frame to Gemini only when Analyze is requested; SARA does not continuously classify facial emotion. Use the camera controls to stop the stream. For conversational check-ins, ask SARA directly rather than relying on inferred facial emotion.

Run `npm run test:api` for mocked integrations and local-calendar contract tests; `npm run test:security` covers request boundaries and admin auth. Focused system-monitor and local-project-manager tests are `npx tsx --test src/services/SystemResourceMonitor.test.ts src/services/LocalProjectManager.test.ts src/services/securityAlertPolling.test.ts src/security/securityAlertStore.test.ts`, plus `python -m unittest desktop_agent.test_system_monitor`. The real mouse/keyboard suite (`npm run test:real-desktop:mouse` / `:keyboard`) requires an opted-in interactive Windows desktop; unit tests only validate mocked input delivery and cleanup. The general-purpose `ClosedLoopExecutor` planner and authenticated action adapter are not implemented yet: it deliberately refuses execution, and `npm run test:closed-loop` checks that it fails closed rather than reporting a planning-only result as success.

---

## Production Mode

### Single Launcher (Recommended)

```bat
start-sara-prod.bat
```

This launches the **SARA Startup Manager** which:
1. Validates the environment (Node, Python, API keys)
3. Starts the database
4. Starts the Node.js backend (port 3000)
5. Starts the Python Desktop Agent (port 8765)
6. Runs health checks on all services
7. Prints `SARA READY ✅`

### Via npm

```bash
npm run start:prod
```

### Startup Output

```
[SARA] Starting...
[SARA] Build identity: SARA v1.0.0 (a1b2c3d4) — 2026-08-14
[SARA] Validating environment...
[SARA] Environment check passed.
[SARA] Checking database...
[SARA] Database ready.
[SARA] Starting backend...
[SARA] ✓ Backend is READY on port 3000.
[SARA] Starting Desktop Agent...
[SARA] ✓ Desktop Agent is READY on port 8765.

[SARA] ─────── Health Report ──────────────────────────
[SARA]   ✓ Database          
[SARA]   ✓ Memory System      
[SARA]   ✓ Gemini API Key     
[SARA]   ✓ Backend/Frontend   (12ms)
[SARA]   ✓ Desktop Agent      (8ms)
[SARA] ──────────────────────────────────────────────────
[SARA] ✅  All systems operational. SARA is READY.
```

---

## Windows Auto-Start

Enable SARA to start automatically at Windows login:

```bash
# Enable (reads AUTO_START from .env)
npm run register-startup

# Disable
npm run unregister-startup

# Or set in .env:
AUTO_START=true
```

This registers a Task Scheduler task that launches `start-sara-prod.bat` at logon.

---

## Build System

### Production Build

```powershell
# Full production build: lint → compile → hash manifest → sign → package
npm run build:prod
```

Output: `release/SARA-Setup-*.exe` and `release/SARA-Portable-*.exe`

### Integrity Manifest

```bash
# (Re-)generate and sign the integrity manifest after source changes
npm run integrity:generate
```

This creates `data/security/integrity-manifest.json` signed with the HMAC key at `data/security/.manifest-key`. This command generates an artifact only: **the active backend does not enforce the manifest** and its integrity-verification/baseline endpoints return `501`. Do not rely on it as tamper protection.

> ⚠️ **Never commit `data/security/.manifest-key`** — it is gitignored and must be kept separately.

---

## Security & Integrity

### Build Watermark
Every build carries:
- `SARA_NAME` — product name
- `SARA_VERSION` — semantic version
- `BUILD_ID` — unique UUID per build run
- `BUILD_TIMESTAMP` — ISO timestamp
- `BUILD_HASH` — SHA-256 fingerprint of core identity fields

Stored in `data/build-manifest.json` and printed in startup logs.

### Integrity Manifest (artifact only)
`npm run integrity:generate` computes SHA-256 hashes and signs a manifest with the local HMAC key. This artifact-generation workflow is available, but **runtime verification and baseline approval are disabled in the active backend**. The related API endpoints return `501`; startup does not verify or enforce the manifest. Do not treat this feature as tamper detection or rely on it for security.

---

## Testing

```powershell
# Activate the environment created during installation
.venv\Scripts\Activate.ps1

# Safe desktop-input, macro, realtime, proactive/social, and system-monitor tests
python -m unittest desktop_agent.test_desktop_input_controller desktop_agent.test_hardware_macro_replay desktop_agent.test_realtime_control_contract desktop_agent.test_proactive_interaction desktop_agent.test_social_intelligence desktop_agent.test_system_monitor

# Existing standalone tests
python test_windows.py
python test_reward_engine.py

# Browser/UI tests (Playwright; install the required browser first)
npm run test:e2e
```

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server (hot-reload) |
| `npm run start:prod` | Start production via Startup Manager |
| `npm run build` | Compile frontend + backend |
| `npm run build:prod` | Full production build pipeline |
| `npm run build:agent` | Build PyInstaller Python agent |
| `npm run build:all` | Build everything + package |
| `npm run dist` | Package with electron-builder |
| `npm run integrity:generate` | Generate + sign integrity manifest |
| `npm run register-startup` | Register Windows auto-start |
| `npm run unregister-startup` | Remove Windows auto-start |
| `npm run lint` | TypeScript type check |
| `npm run test:e2e` | Run Playwright tests |

---

## Contributing
1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Follow the coding style — TypeScript (`npm run lint`), Python (`ruff`)
4. Write tests for new functionality.
5. Submit a Pull Request with a clear description.

Please adhere to our **Code of Conduct** (`CODE_OF_CONDUCT.md`).

---

## License
This project is licensed under the **MIT License** — see `LICENSE` for details.

---

## Contact

**Mr Amol Pandhre** — Lead Architect & Creator  
📧 amol.pandhre@example.com  
🐙 https://github.com/amol-pandhre

**SARA Team** — https://github.com/Pandhare-amol/Sara

---

*SARA v1.0.0 · Created by Mr Amol Pandhre & the SARA Team · 2026*
