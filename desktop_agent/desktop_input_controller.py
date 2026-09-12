"""Authoritative real Windows mouse and keyboard input controller."""

from __future__ import annotations

import platform
import time
from typing import Any, Dict, Iterable, List

from .registry import ToolError


class DesktopInputController:
    """Thin, stateful wrapper around real OS input with emergency cleanup."""

    def __init__(self) -> None:
        self._held_keys: set[str] = set()
        self._held_buttons: set[str] = set()

    @staticmethod
    def _backend():
        try:
            import pyautogui
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Hardware control unavailable: {exc}") from exc
        pyautogui.FAILSAFE = True
        return pyautogui

    @staticmethod
    def _require_windows() -> None:
        if platform.system() != "Windows":
            raise ToolError("Real desktop input is supported only on Windows.")

    @staticmethod
    def _coordinate(value: Any, name: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ToolError(f"Parameter '{name}' must be an integer.") from exc

    def move(self, x: Any, y: Any, duration: Any = 0.15, mode: Any = "NATURAL") -> Dict[str, Any]:
        pyautogui = self._backend()
        target_x = self._coordinate(x, "x")
        target_y = self._coordinate(y, "y")
        selected_mode = str(mode or "NATURAL").upper()
        if selected_mode not in {"FAST", "NATURAL", "PRECISE"}:
            raise ToolError("Mouse mode must be FAST, NATURAL, or PRECISE.")
        defaults = {"FAST": 0.0, "NATURAL": 0.15, "PRECISE": 0.45}
        move_duration = max(0.0, min(float(duration) if duration is not None else defaults[selected_mode], 30.0))
        pyautogui.moveTo(target_x, target_y, duration=move_duration)
        actual_x, actual_y = pyautogui.position()
        return {"x": actual_x, "y": actual_y, "target_x": target_x, "target_y": target_y,
                "mode": selected_mode, "verified": actual_x == target_x and actual_y == target_y}

    def move_relative(self, dx: Any, dy: Any, duration: Any = 0.15, mode: Any = "NATURAL") -> Dict[str, Any]:
        pyautogui = self._backend()
        current_x, current_y = pyautogui.position()
        return self.move(current_x + self._coordinate(dx, "dx"), current_y + self._coordinate(dy, "dy"), duration, mode)

    def click(self, args: Dict[str, Any]) -> Dict[str, Any]:
        pyautogui = self._backend()
        button = str(args.get("button") or "left").lower()
        if button not in {"left", "right", "middle"}:
            raise ToolError("Mouse button must be left, right, or middle.")
        clicks = max(1, min(int(args.get("clicks") or 1), 3))
        if args.get("x") is not None and args.get("y") is not None:
            pyautogui.click(self._coordinate(args["x"], "x"), self._coordinate(args["y"], "y"), clicks=clicks, button=button)
        else:
            pyautogui.click(clicks=clicks, button=button)
        x, y = pyautogui.position()
        return {"button": button, "clicks": clicks, "x": x, "y": y, "action_sent": True, "verified": False}

    def button_down(self, button: Any = "left") -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(button or "left").lower()
        if value not in {"left", "right", "middle"}:
            raise ToolError("Mouse button must be left, right, or middle.")
        pyautogui.mouseDown(button=value)
        self._held_buttons.add(value)
        return {"button": value, "held": True, "verified": value in self._held_buttons}

    def button_up(self, button: Any = "left") -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(button or "left").lower()
        pyautogui.mouseUp(button=value)
        self._held_buttons.discard(value)
        return {"button": value, "held": False, "verified": value not in self._held_buttons}

    def drag(self, args: Dict[str, Any]) -> Dict[str, Any]:
        pyautogui = self._backend()
        target_x = self._coordinate(args.get("x"), "x")
        target_y = self._coordinate(args.get("y"), "y")
        button = str(args.get("button") or "left").lower()
        duration = max(0.0, min(float(args.get("duration") or 0.3), 30.0))
        try:
            pyautogui.dragTo(target_x, target_y, duration=duration, button=button)
        finally:
            self.emergency_release()
        actual_x, actual_y = pyautogui.position()
        return {"x": actual_x, "y": actual_y, "target_x": target_x, "target_y": target_y,
            "button": button, "action_sent": True, "verified": False}

    def scroll(self, amount: Any, horizontal: bool = False) -> Dict[str, Any]:
        pyautogui = self._backend()
        clicks = int(amount)
        if horizontal and hasattr(pyautogui, "hscroll"):
            pyautogui.hscroll(clicks)
        else:
            pyautogui.scroll(clicks)
        return {"amount": clicks, "horizontal": horizontal, "action_sent": True, "verified": False}

    def type_text(self, text: Any, interval: Any = 0.01) -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(text or "")
        if not value:
            raise ToolError("Parameter 'text' is required.")
        # Clipboard paste is a real foreground keyboard action and supports Unicode,
        # unlike pyautogui.write, which is limited to its key-name mapping.
        try:
            import pyperclip
            previous = pyperclip.paste()
            try:
                pyperclip.copy(value)
                pyautogui.hotkey("ctrl", "v")
                if interval:
                    import time
                    time.sleep(min(float(interval), 1.0))
            finally:
                pyperclip.copy(previous)
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Unicode keyboard input unavailable: {exc}") from exc
        return {"characters": len(value), "unicode": any(ord(char) > 127 for char in value),
                "action_sent": True, "verified": False}

    def press(self, keys: Iterable[Any]) -> Dict[str, Any]:
        pyautogui = self._backend()
        normalized = [str(key).strip().lower() for key in keys if str(key).strip()]
        if not normalized:
            raise ToolError("Provide 'key' or 'keys'.")
        if len(normalized) == 1:
            pyautogui.press(normalized[0])
        else:
            pyautogui.hotkey(*normalized)
        return {"keys": normalized, "verified": True}

    def key_down(self, key: Any) -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        pyautogui.keyDown(value)
        self._held_keys.add(value)
        return {"key": value, "held": True, "verified": value in self._held_keys}

    def key_up(self, key: Any) -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        pyautogui.keyUp(value)
        self._held_keys.discard(value)
        return {"key": value, "held": False, "verified": value not in self._held_keys}

    def emergency_release(self) -> Dict[str, Any]:
        pyautogui = self._backend()
        released_keys = sorted(self._held_keys)
        released_buttons = sorted(self._held_buttons)
        for key in released_keys:
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass
        for button in released_buttons:
            try:
                pyautogui.mouseUp(button=button)
            except Exception:
                pass
        self._held_keys.clear()
        self._held_buttons.clear()
        return {"released_keys": released_keys, "released_buttons": released_buttons, "verified": not self._held_keys and not self._held_buttons}

    def monitors(self) -> List[Dict[str, Any]]:
        self._require_windows()
        try:
            import win32api
            monitors = []
            for handle, _hdc, rectangle in win32api.EnumDisplayMonitors():
                info = win32api.GetMonitorInfo(handle)
                left, top, right, bottom = rectangle
                monitors.append({"handle": str(handle), "x": left, "y": top, "width": right - left,
                                 "height": bottom - top, "primary": bool(info.get("Flags", 0) & 1)})
            return monitors
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Could not enumerate Windows monitors: {exc}") from exc


DESKTOP_INPUT = DesktopInputController()
