"""On-demand cached screen perception for observe-act-verify workflows."""

from __future__ import annotations

import hashlib
import platform
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional

from .registry import ToolError
from .visual_access import VISUAL_ACCESS


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
        self._grant_generation = -1

    def _capture(self):
        if platform.system() != "Windows":
            raise ToolError("Screen state capture is supported only on Windows.")
        from .tools_screenshot import _authorized_capture
        return _authorized_capture()[0]

    @staticmethod
    def _active_window() -> Dict[str, Any]:
        from .tools_screenshot import _active_window_info
        return _active_window_info() or {}

    def current(self, force: bool = False, reason: str = "") -> Dict[str, Any]:
        grant = VISUAL_ACCESS.require()
        now = time.time()
        window = self._active_window()
        VISUAL_ACCESS.select(window)
        if self._state and self._grant_generation == grant.generation and not force and now - self._state.timestamp <= self.cache_ttl and self._state.active_window.get("hwnd") == window.get("hwnd"):
            return {"state": asdict(self._state), "cached": True, "reason": reason}
        image = self._capture()
        digest = hashlib.sha256(image.convert("L").resize((64, 64)).tobytes()).hexdigest()
        VISUAL_ACCESS.unchanged(grant)
        self._state = ScreenState(now, digest, image.width, image.height, window)
        self._grant_generation = grant.generation
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
