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

import hmac
import inspect
import ipaddress
import logging
import os
import platform
import sys
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__
from .android_companion import ANDROID_COMPANION_MANAGER
from .agents import MANAGER
from .platform_core import HEALTH
from .platform_capabilities import build_platform_capabilities
from .registry import DESKTOP_TOOL_NAMES, STATE, TOOLS, ToolError, load_all

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

cors_origins = [
    origin.strip()
    for origin in os.environ.get(
        "SARA_AGENT_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,capacitor://localhost",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "X-SARA-Agent-Token", "X-Companion-Token"],
)


@app.middleware("http")
async def require_remote_agent_token(request: Request, call_next):
    peer = request.client.host if request.client else ""
    try:
        is_local = ipaddress.ip_address(peer.split("%", 1)[0]).is_loopback
    except ValueError:
        # Starlette's in-process TestClient uses this non-network sentinel.
        is_local = peer.lower() in {"localhost", "testclient"}

    if not is_local:
        expected = os.environ.get("SARA_AGENT_ACCESS_TOKEN") or os.environ.get("SARA_REMOTE_ACCESS_TOKEN") or ""
        authorization = request.headers.get("authorization", "")
        bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        provided = bearer or request.headers.get("x-sara-agent-token", "")
        if request.url.scheme != "https":
            return JSONResponse(status_code=403, content={"ok": False, "error": "Remote desktop-agent access requires HTTPS."})
        if len(expected) < 32 or not provided or not hmac.compare_digest(expected.encode(), provided.encode()):
            return JSONResponse(status_code=401, content={"ok": False, "error": "Remote desktop-agent access requires a valid token."})

    return await call_next(request)


class ExecuteRequest(BaseModel):
    tool: str | None = None
    args: Dict[str, Any] = {}


class ExecuteResponse(BaseModel):
    ok: bool
    result: Any = None
    canonical: Dict[str, Any] | None = None
    error: str | None = None
    tool: str


def _canonical_result(
    tool: str,
    outcome: Any = None,
    error: str | None = None,
    *,
    args: Dict[str, Any] | None = None,
    execution_time_ms: int | None = None,
) -> Dict[str, Any]:
    """Normalize legacy handlers without changing the legacy ``result`` field."""
    payload = outcome if isinstance(outcome, dict) else {"result": outcome}
    args = args or {}
    explicit_ok = payload.get("ok") if isinstance(payload.get("ok"), bool) else None
    failed = bool(error) or explicit_ok is False or str(payload.get("status", "")).upper() in {"FAILED", "ERROR"}
    observation = payload.get("observation") if isinstance(payload.get("observation"), dict) else {}
    has_screenshot_evidence = bool(
        payload.get("screenshot_id")
        and int(payload.get("width") or observation.get("width") or 0) > 0
        and int(payload.get("height") or observation.get("height") or 0) > 0
    )
    verified = payload.get("verified") is True or str(payload.get("verification", "")).upper() in {"VERIFIED", "SUCCESS"} or has_screenshot_evidence
    status = "FAILED" if failed else "SUCCESS" if verified else "UNCERTAIN"
    operation_id = str(payload.get("operation_id") or payload.get("operationId") or args.get("operation_id") or f"{tool}-{uuid.uuid4().hex[:12]}")
    request_id = payload.get("request_id") or payload.get("requestId") or args.get("request_id") or args.get("requestId")
    task_id = payload.get("task_id") or payload.get("taskId") or args.get("task_id") or args.get("taskId")
    correlation_id = payload.get("correlation_id") or payload.get("correlationId") or args.get("correlation_id") or args.get("correlationId")
    error_details = None
    if failed:
        error_details = {
            "code": payload.get("error_code") or ("TOOL_EXECUTION_FAILED" if error else "TOOL_FAILED"),
            "message": str(payload.get("message") or payload.get("result") or error or "Tool execution failed."),
            "retryable": bool(payload.get("retryable", False)),
        }
    return {
        "ok": not failed and status == "SUCCESS",
        "status": status,
        "verified": verified,
        "operation_id": operation_id,
        "request_id": request_id,
        "task_id": task_id,
        "correlation_id": correlation_id,
        "timestamp": int(time.time() * 1000),
        "duration_ms": execution_time_ms,
        "data": payload.get("data", payload),
        "error": error_details,
        "verification": {
            "verified": verified,
            "method": payload.get("verification_method") or payload.get("verification") if isinstance(payload.get("verification"), str) else payload.get("verification", {}).get("method") if isinstance(payload.get("verification"), dict) else None,
        },
        "tool": tool,
        # Legacy compatibility fields below (to be removed in future phases)
        "execution_time_ms": execution_time_ms,
        "error_code": payload.get("error_code") or ("TOOL_EXECUTION_FAILED" if error else None),
        "message": str(payload.get("message") or payload.get("result") or error or "Tool execution completed."),
        "retryable": bool(payload.get("retryable", False)),
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "service": "sara-desktop-agent",
        "service_version": __version__,
        "name": "SARA Desktop Control Agent",
        "version": __version__,
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "tools": sorted(TOOLS.keys()),
        "tool_count": len(TOOLS),
    }


@app.get("/health/diagnostics")
def health_diagnostics() -> Dict[str, Any]:
    return {"status": "ok", "result": HEALTH.latest() or HEALTH.run()}


@app.get("/capabilities")
def capabilities() -> Dict[str, Any]:
    tool_names = sorted(TOOLS.keys())
    return {
        "status": "PROCESS_HEALTHY",
        "service": "sara-desktop-agent",
        "service_version": __version__,
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "tool_names": tool_names,
        "tool_count": len(tool_names),
        **build_platform_capabilities(platform.system(), tool_names),
    }


@app.get("/capabilities/diagnostics")
def capabilities_diagnostics() -> Dict[str, Any]:
    return {"status": "PROCESS_HEALTHY", "service": "sara-desktop-agent", "result": HEALTH.latest() or HEALTH.run()}


@app.get("/tools")
def list_tools() -> Dict[str, Any]:
    return {"tools": sorted(TOOLS.keys()), "count": len(TOOLS)}


@app.get("/browser/state")
def browser_state() -> Dict[str, Any]:
    manager = STATE.browser_state
    return {
        "ok": True,
        "status": "ready" if manager is not None else "stopped",
        "session_id": manager.session_id if manager is not None else "sara-browser-session",
        "states": manager.snapshot() if manager is not None else {},
    }


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
async def execute(req: ExecuteRequest) -> ExecuteResponse:
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
    if not tool:
        return ExecuteResponse(ok=False, error="A tool name is required.", tool="")

    if tool == "desktopAgentDiagnostic":
        diagnostic = {
            "result": "Desktop Agent is running and accepting tool calls.",
            "verification": "healthy",
            "verified": True,
            "tool_count": len(TOOLS),
        }
        return ExecuteResponse(
            ok=True,
            result=diagnostic,
            canonical=_canonical_result(tool, diagnostic, args=args),
            tool=tool,
        )

    log.info("EXEC tool=%s args=%s", tool, _short_args(args))

    if tool not in TOOLS:
        known = ", ".join(sorted(TOOLS.keys()))
        message = f"Unknown tool '{tool}'. Known tools: {known}"
        return ExecuteResponse(
            ok=False,
            canonical=_canonical_result(tool, error=message, args=args),
            error=message,
            tool=tool,
        )

    handler = TOOLS[tool]
    started_at = time.perf_counter()
    try:
        out = handler(args)
        if inspect.isawaitable(out):
            out = await out
    except ToolError as e:
        log.warning("ToolError in %s: %s", tool, e.message)
        return ExecuteResponse(ok=False, canonical=_canonical_result(tool, error=e.message, args=args, execution_time_ms=int((time.perf_counter() - started_at) * 1000)), error=e.message, tool=tool)
    except Exception as e:  # noqa: BLE001
        log.error("Unhandled error in %s: %s\n%s", tool, e, traceback.format_exc())
        message = f"Internal error in {tool}: {e}"
        return ExecuteResponse(ok=False, canonical=_canonical_result(tool, error=message, args=args, execution_time_ms=int((time.perf_counter() - started_at) * 1000)), error=message, tool=tool)

    # Handlers return dicts like {"result": "..."}; pass the whole payload.
    result_text = ""
    if isinstance(out, dict):
        result_text = str(out.get("result", out))
    else:
        result_text = str(out)
    log.info("DONE tool=%s -> %s", tool, result_text[:160])

    return ExecuteResponse(ok=True, result=out, canonical=_canonical_result(tool, out, args=args, execution_time_ms=int((time.perf_counter() - started_at) * 1000)), tool=tool)


@app.post("/companion/pair")
def companion_pair(payload: Dict[str, Any]) -> JSONResponse:
    name = str(payload.get("name") or "Android Device")
    device_id = str(payload.get("device_id") or "")
    token = str(payload.get("token") or "")
    if not device_id or not token:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Device ID and a strong token are required."})
    try:
        device = ANDROID_COMPANION_MANAGER.register_device(name, token, device_id=device_id)
    except ValueError:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Invalid companion pairing request."})
    return JSONResponse(status_code=200, content={"ok": True, "result": device})


@app.post("/companion/auth")
def companion_auth(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or "")
    token = str(payload.get("token") or "")
    try:
        device = ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except (PermissionError, ValueError):
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid companion credentials."})
    return JSONResponse(status_code=200, content={"ok": True, "result": device})


@app.post("/companion/command")
def companion_command(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or "")
    token = str(payload.get("token") or "")
    try:
        ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except (PermissionError, ValueError):
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid companion credentials."})
    command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, payload)
    return JSONResponse(status_code=200, content={"ok": True, "result": command})


@app.get("/companion/pending/{device_id}")
def companion_pending(device_id: str, token: str = Header(default="", alias="X-Companion-Token")) -> JSONResponse:
    try:
        ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except (PermissionError, ValueError):
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid companion credentials."})
    return JSONResponse(status_code=200, content={"ok": True, "result": ANDROID_COMPANION_MANAGER.get_pending_commands(device_id)})


@app.post("/companion/result")
def companion_result(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or "")
    token = str(payload.get("token") or "")
    command_id = str(payload.get("command_id") or payload.get("id") or "")
    try:
        ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except (PermissionError, ValueError):
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid companion credentials."})
    ANDROID_COMPANION_MANAGER.mark_command_done(device_id, command_id)
    return JSONResponse(status_code=200, content={"ok": True, "result": {"device_id": device_id, "command_id": command_id}})


def _short_args(args: Dict[str, Any]) -> str:
    """Compact, log-safe representation of args (truncate long values)."""
    parts = []
    for k, v in args.items():
        if any(secret in str(k).lower() for secret in ("password", "token", "secret", "clipboard", "text")):
            v = "[SENSITIVE CONTENT REDACTED]"
        s = repr(v)
        if len(s) > 60:
            s = s[:60] + "â€¦"
        parts.append(f"{k}={s}")
    return "{" + ", ".join(parts) + "}"


def main() -> None:
    """Allow `python -m desktop_agent.main` to launch uvicorn."""
    import uvicorn

    host = os.environ.get("SARA_AGENT_HOST", "127.0.0.1").strip()
    port = int(os.environ.get("SARA_AGENT_PORT", "8765"))
    try:
        remote_bind = not ipaddress.ip_address(host).is_loopback
    except ValueError:
        remote_bind = host.lower() != "localhost"

    tls_options: Dict[str, str] = {}
    if remote_bind:
        token = os.environ.get("SARA_AGENT_ACCESS_TOKEN") or os.environ.get("SARA_REMOTE_ACCESS_TOKEN") or ""
        cert_file = os.environ.get("SARA_AGENT_TLS_CERT_FILE") or os.environ.get("SARA_TLS_CERT_FILE") or ""
        key_file = os.environ.get("SARA_AGENT_TLS_KEY_FILE") or os.environ.get("SARA_TLS_KEY_FILE") or ""
        if len(token) < 32:
            raise RuntimeError("Non-loopback desktop-agent binding requires a 32-character access token.")
        if not cert_file or not key_file:
            raise RuntimeError("Non-loopback desktop-agent binding requires TLS certificate and key files.")
        tls_options = {"ssl_certfile": cert_file, "ssl_keyfile": key_file}

    log.info("Launching uvicorn on %s:%d", host, port)
    uvicorn.run(
        "desktop_agent.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
        **tls_options,
    )


if __name__ == "__main__":
    main()
