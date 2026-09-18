"""Verified Win32 window discovery and focus management."""

from __future__ import annotations

import platform
import time
from typing import Any, Dict, List

from .registry import ToolError


class WindowManager:
    def _win32gui(self):
        if platform.system() != "Windows":
            raise ToolError("Window management is supported only on Windows.")
        try:
            import win32gui
            return win32gui
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Windows window APIs unavailable: {exc}") from exc

    def _window_info(self, hwnd: int) -> Dict[str, Any]:
        win32gui = self._win32gui()
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        title = win32gui.GetWindowText(hwnd)
        process_id = 0
        process_name = None
        try:
            import win32process
            import psutil
            _, process_id = win32process.GetWindowThreadProcessId(hwnd)
            process_name = psutil.Process(process_id).name()
        except Exception:
            pass
        try:
            maximized = bool(win32gui.IsZoomed(hwnd))
        except AttributeError:
            try:
                import win32con
                placement = win32gui.GetWindowPlacement(hwnd)
                maximized = bool(len(placement) > 1 and placement[1] == win32con.SW_SHOWMAXIMIZED)
            except Exception:
                maximized = False

        return {
            "hwnd": int(hwnd),
            "title": title,
            "visible": bool(win32gui.IsWindowVisible(hwnd)),
            "minimized": bool(win32gui.IsIconic(hwnd)),
            "maximized": maximized,
            "bounds": {"x": left, "y": top, "width": right - left, "height": bottom - top},
            "process_id": process_id,
            "process_name": process_name,
        }

    def list_windows(self, include_untitled: bool = False) -> List[Dict[str, Any]]:
        win32gui = self._win32gui()
        windows: List[Dict[str, Any]] = []

        def callback(hwnd: int, _extra: Any) -> bool:
            if win32gui.IsWindowVisible(hwnd):
                info = self._window_info(hwnd)
                if include_untitled or info["title"].strip():
                    windows.append(info)
            return True

        win32gui.EnumWindows(callback, None)
        return windows

    def active_window(self) -> Dict[str, Any]:
        win32gui = self._win32gui()
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            raise ToolError("No active window found.")
        return self._window_info(hwnd)

    def find(self, query: str) -> Dict[str, Any]:
        needle = str(query or "").strip().lower()
        if not needle:
            raise ToolError("Parameter 'title' or 'application' is required.")
        matches = [window for window in self.list_windows() if needle in window["title"].lower() or needle in str(window["process_name"] or "").lower()]
        if not matches:
            raise ToolError(f"No visible window matching '{query}'.")
        if len(matches) > 1:
            exact = [window for window in matches if window["title"].lower() == needle or str(window["process_name"] or "").lower() == needle]
            if exact:
                return exact[0]
        return matches[0]

    def focus(self, query: str) -> Dict[str, Any]:
        win32gui = self._win32gui()
        window = self.find(query)
        hwnd = window["hwnd"]
        if window["minimized"]:
            win32gui.ShowWindow(hwnd, 9)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.05)
        active = win32gui.GetForegroundWindow()
        verified = int(active or 0) == hwnd
        return {"window": self._window_info(hwnd), "verified": verified, "active_hwnd": int(active or 0)}


WINDOW_MANAGER = WindowManager()
