"""Ephemeral, explicit screen grants for the Windows agent.

No voice tool, OCR text, webpage, document, or request argument may grant itself
screen access. Only the Node admin route knows the per-process bridge secret.
Grants are never persisted and expire or disappear on agent restart.
"""

from __future__ import annotations

import hmac
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .registry import ToolError

_APP_NAME = re.compile(r"^[a-zA-Z0-9_.-]{2,65}\.exe$")
_PROTECTED_PROCESSES = {"logonui.exe", "lockapp.exe", "consent.exe", "credentialui.exe", "winlogon.exe"}
_PROTECTED_TITLE = re.compile(r"\b(user account control|windows security|security warning|enter (your )?(password|pin)|sign[ -]?in|authentication required)\b", re.I)


@dataclass(frozen=True)
class VisualGrant:
    scope: str
    application: str
    display: int
    display_geometry: tuple[int, int, int, int] | None
    expires_at: float
    allow_monitor: bool = False
    allow_save: bool = False
    allow_cloud: bool = False
    generation: int = 0


class VisualAccess:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._grant: Optional[VisualGrant] = None
        self._generation = 0
        self._last_command_sequence = 0

    @staticmethod
    def _bridge(secret: Any) -> None:
        configured = os.environ.get("SARA_VISUAL_BRIDGE_KEY", "")
        if len(configured) < 32 or not isinstance(secret, str) or not hmac.compare_digest(configured, secret):
            raise ToolError("Visual access requires the trusted local admin bridge.")

    @staticmethod
    def _monitors() -> list[Dict[str, Any]]:
        from .desktop_input_controller import DESKTOP_INPUT
        return DESKTOP_INPUT.monitors()

    def configure(self, args: Dict[str, Any]) -> Dict[str, Any]:
        from .identity_guard import protected_mode_active
        self._bridge(args.get("bridge_key"))
        if protected_mode_active():
            raise ToolError("Visual grants are unavailable in protected multi-user mode.")
        scope = str(args.get("scope") or "").lower()
        app = str(args.get("application") or "").lower().strip()
        if scope not in {"application", "display"}:
            raise ToolError("Choose exactly one application or display scope.")
        if scope == "application" and not _APP_NAME.fullmatch(app):
            raise ToolError("Application scope requires an exact executable name such as notepad.exe.")
        if scope == "display" and app:
            raise ToolError("A display grant cannot also claim an application scope.")
        display = -1
        geometry = None
        if scope == "display":
            raw = args.get("display")
            if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
                raise ToolError("Choose a valid display index.")
            monitors = self._monitors()
            if raw >= len(monitors):
                raise ToolError("Selected display is unavailable.")
            display = raw
            monitor = monitors[display]
            geometry = (int(monitor["x"]), int(monitor["y"]), int(monitor["width"]), int(monitor["height"]))
            if geometry[2] <= 0 or geometry[3] <= 0:
                raise ToolError("Selected display has invalid dimensions.")
        ttl = args.get("duration_seconds", 120)
        if isinstance(ttl, bool) or not isinstance(ttl, int) or not 10 <= ttl <= 300:
            raise ToolError("Choose an access duration between 10 and 300 seconds.")
        sequence = args.get("sequence")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
            raise ToolError("A fresh visual control sequence is required.")
        with self._lock:
            if sequence <= self._last_command_sequence:
                raise ToolError("Visual grant arrived after a newer stop or permission change; denied.")
            self._last_command_sequence = sequence
            self._generation += 1
            self._grant = VisualGrant(scope, app, display, geometry, time.monotonic() + ttl,
                                      allow_monitor=args.get("allow_monitor") is True,
                                      allow_save=args.get("allow_save") is True,
                                      allow_cloud=args.get("allow_cloud_vision") is True,
                                      generation=self._generation)
        return self.status()

    def revoke(self, secret: Any, sequence: Any) -> Dict[str, Any]:
        self._bridge(secret)
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
            raise ToolError("A fresh visual stop sequence is required.")
        with self._lock:
            if sequence < self._last_command_sequence:
                raise ToolError("Visual stop was superseded; this older request cannot change a newer grant.")
            self._last_command_sequence = sequence
            self._generation += 1
            self._grant = None
        return self.status()

    def force_revoke(self) -> None:
        """Internal-only: a protected-mode transition can only reduce access."""
        with self._lock:
            self._generation += 1
            self._grant = None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            g = self._grant
            if g is None or g.expires_at <= time.monotonic():
                self._grant = None
                return {"enabled": False}
            return {"enabled": True, "scope": g.scope, "application": g.application or None,
                    "display": g.display if g.scope == "display" else None,
                    "remaining_seconds": max(0, int(g.expires_at - time.monotonic())),
                    "monitoring": g.allow_monitor, "saving": g.allow_save, "cloud_vision": g.allow_cloud}

    def require(self, *, monitor: bool = False, save: bool = False) -> VisualGrant:
        from .identity_guard import protected_mode_active
        if protected_mode_active():
            with self._lock:
                self._grant = None
            raise ToolError("Screen access is locked in protected multi-user mode.")
        with self._lock:
            g = self._grant
            if g is None or g.expires_at <= time.monotonic():
                self._grant = None
                raise ToolError("Screen access is off or expired. Grant it explicitly in SARA's task panel.")
            if monitor and not g.allow_monitor:
                raise ToolError("Continuous screen monitoring was not approved.")
            if save and not g.allow_save:
                raise ToolError("Saving screenshots was not approved.")
            return g

    def select(self, window: Dict[str, Any] | None, *, monitor: bool = False, save: bool = False) -> tuple[VisualGrant, tuple[int, int, int, int]]:
        g = self.require(monitor=monitor, save=save)
        if not isinstance(window, dict) or not window.get("hwnd"):
            raise ToolError("Cannot identify the foreground window; screen access paused.")
        process = str(window.get("process_name") or "").lower().strip()
        title = str(window.get("title") or "")
        if not process or process in _PROTECTED_PROCESSES or _PROTECTED_TITLE.search(title):
            raise ToolError("Protected or unidentified screen; no capture or input was performed.")
        if g.scope == "application":
            if process != g.application or window.get("minimized") is True or window.get("visible") is False:
                raise ToolError("The approved application is not the active visible window.")
            bounds = window.get("bounds") or {}
            try:
                rect = (int(bounds["x"]), int(bounds["y"]), int(bounds["width"]), int(bounds["height"]))
            except (ValueError, TypeError, KeyError) as exc:
                raise ToolError("Approved window bounds unavailable; no capture performed.") from exc
        else:
            monitors = self._monitors()
            if g.display >= len(monitors):
                raise ToolError("Approved display was removed or changed.")
            m = monitors[g.display]
            rect = (int(m["x"]), int(m["y"]), int(m["width"]), int(m["height"]))
            if rect != g.display_geometry:
                raise ToolError("Approved display geometry changed. Grant access again.")
        if rect[2] <= 0 or rect[3] <= 0 or rect[2] > 8192 or rect[3] > 8192 or rect[2] * rect[3] > 10_000_000:
            raise ToolError("Untrusted or oversized screen dimensions; capture paused.")
        return g, rect

    def unchanged(self, g: VisualGrant) -> None:
        from .identity_guard import protected_mode_active
        with self._lock:
            if protected_mode_active() or self._grant is not g or time.monotonic() >= g.expires_at:
                raise ToolError("Screen access changed or expired during the operation; discard the result.")


VISUAL_ACCESS = VisualAccess()
