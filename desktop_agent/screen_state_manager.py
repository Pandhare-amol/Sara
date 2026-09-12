"""On-demand cached screen perception for observe-act-verify workflows."""

from __future__ import annotations

import hashlib
import platform
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional

from .registry import ToolError


@dataclass
class ScreenState:
    timestamp: float
    image_hash: str
    width: int
    height: int
    active_window: Dict[str, Any] = field(default_factory=dict)
    ui_elements: list[Dict[str, Any]] = field(default_factory=list)


class ScreenStateManager:
    def __init__(self, cache_ttl: float = 0.75) -> None:
        self.cache_ttl = max(0.0, float(cache_ttl))
        self._state: Optional[ScreenState] = None

    def _capture(self):
        if platform.system() != "Windows":
            raise ToolError("Screen state capture is supported only on Windows.")
        try:
            from PIL import ImageGrab
            return ImageGrab.grab(all_screens=True)
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Screen capture failed: {exc}") from exc

    @staticmethod
    def _active_window() -> Dict[str, Any]:
        try:
            import win32gui
            hwnd = int(win32gui.GetForegroundWindow() or 0)
            return {"hwnd": hwnd, "title": win32gui.GetWindowText(hwnd) if hwnd else ""}
        except Exception:
            return {}

    def current(self, force: bool = False, reason: str = "") -> Dict[str, Any]:
        now = time.time()
        if self._state and not force and now - self._state.timestamp <= self.cache_ttl:
            return {"state": asdict(self._state), "cached": True, "reason": reason}
        image = self._capture()
        digest = hashlib.sha256(image.tobytes()).hexdigest()
        self._state = ScreenState(now, digest, image.width, image.height, self._active_window())
        return {"state": asdict(self._state), "cached": False, "reason": reason}

    def wait_for_change(self, timeout: Any = 5, poll_interval: Any = 0.25) -> Dict[str, Any]:
        limit = max(0.0, min(float(timeout), 60.0))
        interval = max(0.1, min(float(poll_interval), 2.0))
        baseline = self.current(force=False, reason="wait_baseline")["state"]["image_hash"]
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            time.sleep(min(interval, remaining))
            current = self.current(force=True, reason="wait_for_change")["state"]
            if current["image_hash"] != baseline:
                return {"changed": True, "state": current, "verified": True}
        current = self.current(force=False, reason="wait_timeout")["state"]
        return {"changed": False, "state": current, "verified": False}


SCREEN_STATE = ScreenStateManager()
