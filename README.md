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
- 🔐 Build watermark, signed integrity manifest, and tamper detection
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
| **Signed Integrity Manifest** | HMAC-SHA256 signature on SHA-256 file hashes; tamper detection at startup |
| **Production Launcher** | `start-sara-prod.bat` — one click starts everything in order |
| **Crash Recovery** | Automatic service restart with bounded retries (max 3) |
| **Duplicate Process Guard** | Health-check before start; reuses existing healthy processes |
| **Windows Auto-Start** | Task Scheduler registration via `npm run register-startup` |

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

```bash
# 1. Clone the repository
git clone https://github.com/your-org/sara.git
cd sara/myraa-ai-assistant

# 2. Install Node dependencies
npm install

# 3. Set up Python virtual environment
python -m venv .venv-1
.venv-1\Scripts\activate
pip install -r requirements.txt

# 4. Configure environment
copy .env.example .env
# Edit .env and set your GEMINI_API_KEY
```

---

## Development Mode

Use the standard development workflow for local development:

```bash
# Start the full dev server (hot-reload)
npm run dev

# In a separate terminal, start the Python desktop agent
.venv-1\Scripts\activate
python -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765 --reload
```

> **Important**: Set `DEVELOPMENT_MODE=true` in `.env` during development.  
> This **disables** production tamper warnings so normal code edits do not trigger integrity alerts.

---

## Production Mode

### Single Launcher (Recommended)

```bat
start-sara-prod.bat
```

This launches the **SARA Startup Manager** which:
1. Validates the environment (Node, Python, API keys)
2. Runs integrity check (verifies production files are unmodified)
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
[SARA] Running integrity check...
[SARA] Integrity check passed (347 files verified).
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
npm run generate-integrity-manifest
```

This creates `data/security/integrity-manifest.json` signed with the HMAC key at `data/security/.manifest-key`.

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

### Tamper Detection
At build time:
1. SHA-256 hashes of protected source files are computed
2. A manifest is generated at `data/security/integrity-manifest.json`
3. The manifest is HMAC-SHA256 signed with a private key (`data/security/.manifest-key`)

At startup:
1. The HMAC signature is verified
2. Each protected file's hash is compared to the manifest
3. Any mismatch is **logged with the file name, expected hash, and actual hash**
4. The failure is recorded to `data/security/integrity-failures/`

> Note: A user with full source access can remove these protections. This system provides **detection and auditability**, not cryptographic prevention.

### Development Mode
Set `DEVELOPMENT_MODE=true` in `.env` to bypass tamper warnings during development.

---

## Testing

```bash
# Python unit tests (reward engine, window tools, etc.)
.venv-1\Scripts\activate
pytest tests/

# Specific tests
python test_windows.py
python test_reward_engine.py

# End-to-end UI tests (Playwright)
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
| `npm run generate-integrity-manifest` | Generate + sign integrity manifest |
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

**SARA Team** — https://github.com/your-org/sara

---

*SARA v1.0.0 · Created by Mr Amol Pandhre & the SARA Team · 2026*
