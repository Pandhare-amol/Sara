"""
SARA Desktop Control Agent â€” FastAPI entrypoint.

Single dispatch endpoint POST /execute { tool, args } -> { result } | { error }.
SARA's Node bridge (server.ts) calls this over HTTP on 127.0.0.1:8765.

Run:
    uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
or:
    python -m desktop_agent.main
"""

from __future__ import annotations

import logging
import os
import sys
import traceback
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__
from .android_companion import ANDROID_COMPANION_MANAGER
from .agents import MANAGER
from .platform_core import HEALTH
from .registry import DESKTOP_TOOL_NAMES, TOOLS, ToolError, load_all

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sara.desktop")


# Load all tool modules so their handlers register before the app starts.
load_all()
log.info("Loaded %d desktop tools: %s", len(TOOLS), ", ".join(sorted(TOOLS)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("SARA Desktop Control Agent v%s starting up.", __version__)
    yield
    # Clean shutdown of the Playwright browser if it was started.
    try:
        from .tools_browser import shutdown_browser

        shutdown_browser()
    except Exception as e:  # noqa: BLE001
        log.warning("Browser shutdown error: %s", e)
    log.info("SARA Desktop Control Agent stopped.")


app = FastAPI(
    title="SARA Desktop Control Agent",
    version=__version__,
    description="JARVIS-style desktop automation backend for SARA.",
    lifespan=lifespan,
)

# Same-origin Node bridge is the only caller; allow localhost origins flexibly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExecuteRequest(BaseModel):
    tool: str | None = None
    args: Dict[str, Any] = {}


class ExecuteResponse(BaseModel):
    ok: bool
    result: Any = None
    error: str | None = None
    tool: str


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "name": "SARA Desktop Control Agent",
        "version": __version__,
        "tools": sorted(TOOLS.keys()),
        "tool_count": len(TOOLS),
    }


@app.get("/health/diagnostics")
def health_diagnostics() -> Dict[str, Any]:
    return {"status": "ok", "result": HEALTH.latest() or HEALTH.run()}


@app.get("/tools")
def list_tools() -> Dict[str, Any]:
    return {"tools": sorted(TOOLS.keys()), "count": len(TOOLS)}


@app.get("/orchestrator/status")
def orchestrator_status() -> Dict[str, Any]:
    status = MANAGER.status()
    tasks = list(status.get("tasks", {}).values())
    events = status.get("events", [])
    active_tasks = [task for task in tasks if task.get("status") in {"created", "scheduled", "running"}]
    return {
        "status": "ok",
        "agent_count": len(status.get("agents", {})),
        "active_agents": [agent for agent in status.get("agents", {}).values() if agent.get("status") not in {"stopped", "idle"}],
        "tasks": tasks,
        "active_tasks": active_tasks,
        "events": events[-50:],
        "workflow_count": len([event for event in events if event.get("type") == "workflow_planned"]),
        "checkpoint_count": len([event for event in events if "checkpoint" in str(event.get("payload", {})).lower()]),
    }


@app.post("/orchestrator/emergency-stop")
def orchestrator_emergency_stop() -> Dict[str, Any]:
    return {"status": "ok", "result": MANAGER.emergency_stop()}


@app.post("/orchestrator/unload-idle")
def orchestrator_unload_idle() -> Dict[str, Any]:
    return {"status": "ok", "result": MANAGER.unload_idle_agents(force=False)}


@app.get("/command-center")
def command_center() -> Dict[str, Any]:
    status = MANAGER.status()
    health = HEALTH.latest() or HEALTH.run(manager_status=status)
    return {
        "status": "ok",
        "health": health,
        "orchestrator": {
            "agent_count": len(status.get("agents", {})),
            "active_agents": [agent for agent in status.get("agents", {}).values() if agent.get("status") not in {"stopped", "idle"}],
            "tasks": list(status.get("tasks", {}).values())[-100:],
            "events": status.get("events", [])[-100:],
        },
        "summary": {
            "browser": health.get("browser"),
            "voice": health.get("voice"),
            "memory": health.get("memory"),
            "rag": health.get("rag"),
            "issues": health.get("issues", 0),
            "warnings": health.get("warnings", 0),
        },
    }


@app.post("/execute", response_model=ExecuteResponse)
def execute(req: ExecuteRequest) -> ExecuteResponse:
    tool = req.tool
    args = req.args or {}
    if not tool and args.get("action"):
        device_id = str(args.get("device_id") or args.get("device") or "")
        token = str(args.get("token") or "")
        try:
            ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
        except PermissionError:
            return ExecuteResponse(ok=False, error="Invalid device token", tool="saraAndroidExecute")
        except ValueError as exc:
            return ExecuteResponse(ok=False, error=str(exc), tool="saraAndroidExecute")
        command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, args)
        return ExecuteResponse(ok=True, result={"result": command}, tool="saraAndroidExecute")
    log.info("EXEC tool=%s args=%s", tool, _short_args(args))

    if tool not in TOOLS:
        known = ", ".join(sorted(TOOLS.keys()))
        return ExecuteResponse(
            ok=False,
            error=f"Unknown tool '{tool}'. Known tools: {known}",
            tool=tool,
        )

    handler = TOOLS[tool]
    try:
        out = handler(args)
    except ToolError as e:
        log.warning("ToolError in %s: %s", tool, e.message)
        return ExecuteResponse(ok=False, error=e.message, tool=tool)
    except Exception as e:  # noqa: BLE001
        log.error("Unhandled error in %s: %s\n%s", tool, e, traceback.format_exc())
        return ExecuteResponse(
            ok=False,
            error=f"Internal error in {tool}: {e}",
            tool=tool,
        )

    # Handlers return dicts like {"result": "..."}; pass the whole payload.
    result_text = ""
    if isinstance(out, dict):
        result_text = str(out.get("result", out))
    else:
        result_text = str(out)
    log.info("DONE tool=%s -> %s", tool, result_text[:160])

    return ExecuteResponse(ok=True, result=out, tool=tool)


@app.post("/companion/pair")
def companion_pair(payload: Dict[str, Any]) -> Dict[str, Any]:
    name = str(payload.get("name") or "Android Device")
    token = str(payload.get("token") or "sara-token")
    return {"ok": True, "result": ANDROID_COMPANION_MANAGER.register_device(name, token)}


@app.post("/companion/auth")
def companion_auth(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    token = str(payload.get("token") or "")
    try:
        device = ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except PermissionError:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid device token"})
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    return JSONResponse(status_code=200, content={"ok": True, "result": device})


@app.post("/companion/command")
def companion_command(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    token = str(payload.get("token") or "")
    try:
        ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except PermissionError:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid device token"})
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, payload)
    return JSONResponse(status_code=200, content={"ok": True, "result": command})


@app.get("/companion/pending/{device_id}")
def companion_pending(device_id: str) -> Dict[str, Any]:
    return {"ok": True, "result": ANDROID_COMPANION_MANAGER.get_pending_commands(device_id)}


@app.post("/companion/result")
def companion_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    command_id = str(payload.get("command_id") or payload.get("id") or "")
    ANDROID_COMPANION_MANAGER.mark_command_done(device_id, command_id)
    return {"ok": True, "result": {"device_id": device_id, "command_id": command_id}}


def _short_args(args: Dict[str, Any]) -> str:
    """Compact, log-safe representation of args (truncate long values)."""
    parts = []
    for k, v in args.items():
        s = repr(v)
        if len(s) > 60:
            s = s[:60] + "â€¦"
        parts.append(f"{k}={s}")
    return "{" + ", ".join(parts) + "}"


def main() -> None:
    """Allow `python -m desktop_agent.main` to launch uvicorn."""
    import uvicorn

    host = os.environ.get("SARA_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("SARA_AGENT_PORT", "8765"))
    log.info("Launching uvicorn on %s:%d", host, port)
    uvicorn.run(
        "desktop_agent.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
