"""Shared-datastore marker for the desktop-agent multi-user safety boundary.

No device token or loopback address authenticates a named person. Until a signed,
user-scoped execution context is added to /execute, reject every route except
process health as soon as protected mode is enabled. Testable without FastAPI.
"""
from __future__ import annotations

import os
from pathlib import Path


def _local_account_config(app_root: Path) -> dict[str, str]:
    """Only read the two protection/path keys, not credential values. The agent
    can also run independently of Node; .env-only mode must still lock its API.
    A malformed/unreadable local config fails closed, not back to legacy tools.
    """
    file = app_root / ".env"
    if not file.exists():
        return {}
    try:
        if file.stat().st_size > 64 * 1024:
            raise ValueError("Oversized local configuration")
        result: dict[str, str] = {}
        for line in file.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = (part.strip() for part in line.split("=", 1))
            if key in {"SARA_MULTIUSER_REQUIRED", "SARA_DATA_DIR"}:
                if len(value) > 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                result[key] = value
        return result
    except (OSError, UnicodeError, ValueError):
        return {"_invalid_config": "true"}


def protected_mode_active(data_dir: str | Path | None = None) -> bool:
    app_root = Path(os.environ.get("SARA_APP_ROOT") or Path.cwd()).resolve()
    config = _local_account_config(app_root) if data_dir is None else {}
    required = (config.get("_invalid_config") == "true" or
                os.environ.get("SARA_MULTIUSER_REQUIRED", config.get("SARA_MULTIUSER_REQUIRED", "false")) == "true")
    chosen = data_dir or os.environ.get("SARA_DATA_DIR") or config.get("SARA_DATA_DIR") or app_root / "data"
    root = Path(chosen)
    if not root.is_absolute():
        root = app_root / root
    return (required or (root / "security" / "multiuser.json").exists()
            or (root / "security" / "multiuser.pending").exists())


def agent_route_allowed(route: str, data_dir: str | Path | None = None) -> bool:
    return not protected_mode_active(data_dir) or route == "/health"
