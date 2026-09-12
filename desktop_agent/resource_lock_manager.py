"""Cooperative locks for shared desktop resources."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Dict, Iterable, Iterator

from .registry import ToolError

RESOURCE_BY_TOOL: Dict[str, set[str]] = {
    "hardwareMouseMove": {"DESKTOP_MOUSE"},
    "hardwareMouseClick": {"DESKTOP_MOUSE"},
    "hardwareMouseDrag": {"DESKTOP_MOUSE"},
    "hardwareMouseScroll": {"DESKTOP_MOUSE"},
    "hardwareMouseButtonDown": {"DESKTOP_MOUSE"},
    "hardwareMouseButtonUp": {"DESKTOP_MOUSE"},
    "hardwareKeyboardType": {"KEYBOARD"},
    "hardwareKeyboardPress": {"KEYBOARD"},
    "hardwareKeyboardHold": {"KEYBOARD"},
    "hardwareKeyboardRelease": {"KEYBOARD"},
    "hardwareEmergencyRelease": {"DESKTOP_MOUSE", "KEYBOARD"},
    "desktopBrowserOpen": {"BROWSER"},
    "desktopBrowserNavigate": {"BROWSER"},
    "desktopBrowserSearch": {"BROWSER"},
    "desktopBrowserClick": {"BROWSER"},
    "desktopBrowserType": {"BROWSER", "KEYBOARD"},
    "desktopBrowserFillForm": {"BROWSER", "KEYBOARD"},
    "takePhoto": {"CAMERA"},
    "recordVideo": {"CAMERA"},
}


class ResourceLockManager:
    def __init__(self, resources: Iterable[str] = ()) -> None:
        names = set(resources) or {"DESKTOP_MOUSE", "KEYBOARD", "BROWSER", "CAMERA", "MICROPHONE", "FILE_SYSTEM", "NETWORK"}
        self._locks = {name: threading.Lock() for name in names}

    def resources_for_tool(self, tool: str) -> set[str]:
        return set(RESOURCE_BY_TOOL.get(tool, set()))

    @contextmanager
    def acquire(self, resources: Iterable[str], timeout: float = 30.0) -> Iterator[None]:
        names = sorted(set(resources))
        acquired: list[str] = []
        deadline = threading.current_thread()
        try:
            for name in names:
                lock = self._locks.setdefault(name, threading.Lock())
                if not lock.acquire(timeout=max(0.0, timeout)):
                    raise ToolError(f"Resource '{name}' is busy; action was not started.")
                acquired.append(name)
            yield
        finally:
            for name in reversed(acquired):
                self._locks[name].release()

    @contextmanager
    def acquire_for_tool(self, tool: str, timeout: float = 30.0) -> Iterator[None]:
        with self.acquire(self.resources_for_tool(tool), timeout):
            yield


RESOURCE_LOCKS = ResourceLockManager()
