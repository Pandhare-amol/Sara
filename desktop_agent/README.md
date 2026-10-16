# SARA Desktop Agent

A local Python FastAPI service for SARA's desktop, browser, file, screen, and system tools. The set of usable actions depends on the host OS, installed optional dependencies, device permissions, and whether an interactive desktop session is available. The agent reports the host platform and registered platform-limited tools through `/health` and `/capabilities`; a registered tool is not a guarantee that its runtime dependencies are working.

## Requirements

- Python 3.11 or newer
- Node.js/npm for the SARA backend
- Playwright Chromium for browser automation (optional)
- Tesseract OCR engine for OCR (optional; install using the package manager or installer for your OS)

## Setup

From a terminal, change to the SARA project directory and create a virtual environment:

```bash
python -m venv .venv
```

Activate it before installing dependencies:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
# macOS / Linux
source .venv/bin/activate
```

Then install the Python packages and, if needed, the browser runtime:

```bash
python -m pip install -r desktop_agent/requirements.txt
python -m playwright install chromium
```

Set `SARA_PYTHON` if SARA should use a specific Python executable. Otherwise it prefers the active virtual environment, the project `.venv`, and then the host's standard Python launcher. No user-specific interpreter path is required.

## Run

For normal use, start SARA with its managed launcher (`npm run dev` for development or `npm run start:prod` for the production supervisor). The launcher creates a process-scoped internal token in memory and passes it to the Node backend and Python agent.

With the virtual environment active, the agent can also be started manually:

```bash
python -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
```

A manually started agent will answer the local health probe, but control routes fail closed unless the backend and agent receive the same `SARA_AGENT_INTERNAL_TOKEN` (at least 32 UTF-8 bytes) through protected environment configuration. Do not put this value in browser code, UI storage, command arguments, or logs. For a remote agent, use HTTPS and `SARA_AGENT_ACCESS_TOKEN`; non-loopback binding also requires the configured TLS certificate and key.

## API

- `GET /health` — minimal local liveness probe plus platform, registered-tool, and authenticated-protocol metadata. Non-loopback requests require HTTPS and the remote token.
- `GET /auth/check` — protected proof that the caller has the configured agent token.
- `GET /capabilities`, `GET /tools`, browser/task/status routes, companion routes, and `POST /execute` — require `X-SARA-Agent-Token` (or a bearer token). CORS preflight is not authorization; all control routes still require the token.
- `POST /execute` — execute one registered tool, for example:

```json
{ "tool": "openApplication", "args": { "name": "notepad" } }
```

The Node backend supplies the header automatically. When manually calling the endpoint, send `X-SARA-Agent-Token` from the protected environment that holds `SARA_AGENT_INTERNAL_TOKEN`; never paste it into a browser page or share it in logs.

## Platform notes

- Native mouse/keyboard input, window management, and Windows auto-start are Windows-specific in the current agent. File operations, some system information, and browser workflows may be usable on other systems, subject to dependencies and permissions.
- Screen capture requires an accessible graphical session. OCR additionally requires the Tesseract engine; the Python `pytesseract` package alone is not sufficient.
- Application names and power actions vary by OS. Check the tool result rather than assuming an action succeeded.
- Camera tools require a connected camera and user permission. Camera-based emotion recognition is not implemented.

## Safety

- WhatsApp suggestions never send by themselves. Sending requires explicit approval of the recipient and exact message.
- Destructive and sensitive actions require explicit approval or their tool-specific confirmation flow.
- File deletion uses the configured safe-delete behavior where available; always review the target path.
- Python script execution has a configurable timeout.

The agent is a local tool service, not an AGI/ASI system or a guarantee of universal OS control. Reconnection and background execution are subject to service availability and the limits of the host platform.
