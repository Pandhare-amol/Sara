"""Authoritative real Windows mouse and keyboard input controller."""

from __future__ import annotations

import math
import time
from typing import Any, Dict, Iterable, List

from .registry import ToolError


_MOUSE_BUTTONS = {"left", "right", "middle"}
_MAX_SCROLL_CLICKS = 200
_MAX_TEXT_LENGTH = 10_000


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
        import platform
        if platform.system() != "Windows":
            raise ToolError("Real desktop input is supported only on Windows.")

    @staticmethod
    def _coordinate(value: Any, name: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ToolError(f"Parameter '{name}' must be an integer.") from exc

    @staticmethod
    def _duration(value: Any, default: float) -> float:
        try:
            duration = float(default if value is None else value)
        except (TypeError, ValueError) as exc:
            raise ToolError("Mouse duration must be a finite number.") from exc
        if not math.isfinite(duration):
            raise ToolError("Mouse duration must be a finite number.")
        return max(0.0, min(duration, 30.0))

    def move(self, x: Any, y: Any, duration: Any = 0.15, mode: Any = "NATURAL") -> Dict[str, Any]:
        pyautogui = self._backend()
        target_x = self._coordinate(x, "x")
        target_y = self._coordinate(y, "y")
        selected_mode = str(mode or "NATURAL").upper()
        if selected_mode not in {"FAST", "NATURAL", "PRECISE"}:
            raise ToolError("Mouse mode must be FAST, NATURAL, or PRECISE.")
        defaults = {"FAST": 0.0, "NATURAL": 0.15, "PRECISE": 0.45}
        move_duration = self._duration(duration, defaults[selected_mode])
        pyautogui.moveTo(target_x, target_y, duration=move_duration)
        actual_x, actual_y = pyautogui.position()
        return {
            "x": actual_x,
            "y": actual_y,
            "target_x": target_x,
            "target_y": target_y,
            "mode": selected_mode,
            "verified": actual_x == target_x and actual_y == target_y,
        }

    def move_relative(self, dx: Any, dy: Any, duration: Any = 0.15, mode: Any = "NATURAL") -> Dict[str, Any]:
        pyautogui = self._backend()
        current_x, current_y = pyautogui.position()
        return self.move(current_x + self._coordinate(dx, "dx"), current_y + self._coordinate(dy, "dy"), duration, mode)

    def click(self, args: Dict[str, Any]) -> Dict[str, Any]:
        pyautogui = self._backend()
        button = str(args.get("button") or "left").lower()
        if button not in _MOUSE_BUTTONS:
            raise ToolError("Mouse button must be left, right, or middle.")
        try:
            clicks = max(1, min(int(args.get("clicks") or 1), 3))
        except (TypeError, ValueError) as exc:
            raise ToolError("Click count must be an integer between 1 and 3.") from exc
        has_x = args.get("x") is not None
        has_y = args.get("y") is not None
        if has_x != has_y:
            raise ToolError("Provide both x and y coordinates for a targeted click.")
        if has_x:
            pyautogui.click(self._coordinate(args["x"], "x"), self._coordinate(args["y"], "y"), clicks=clicks, button=button)
        else:
            pyautogui.click(clicks=clicks, button=button)
        x, y = pyautogui.position()
        return {"button": button, "clicks": clicks, "x": x, "y": y, "action_sent": True, "verified": False}

    def button_down(self, button: Any = "left") -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(button or "left").lower()
        if value not in _MOUSE_BUTTONS:
            raise ToolError("Mouse button must be left, right, or middle.")
        pyautogui.mouseDown(button=value)
        self._held_buttons.add(value)
        return {"button": value, "held": True, "tracking_verified": value in self._held_buttons, "verified": False}

    def button_up(self, button: Any = "left") -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(button or "left").lower()
        if value not in _MOUSE_BUTTONS:
            raise ToolError("Mouse button must be left, right, or middle.")
        pyautogui.mouseUp(button=value)
        self._held_buttons.discard(value)
        return {"button": value, "held": False, "tracking_verified": value not in self._held_buttons, "verified": False}

    def drag(self, args: Dict[str, Any]) -> Dict[str, Any]:
        pyautogui = self._backend()
        target_x = self._coordinate(args.get("x"), "x")
        target_y = self._coordinate(args.get("y"), "y")
        button = str(args.get("button") or "left").lower()
        if button not in _MOUSE_BUTTONS:
            raise ToolError("Mouse button must be left, right, or middle.")
        duration = self._duration(args.get("duration"), 0.3)
        cleanup: Dict[str, Any] = {"verified": False}
        try:
            pyautogui.dragTo(target_x, target_y, duration=duration, button=button)
        finally:
            cleanup = self.emergency_release()
        actual_x, actual_y = pyautogui.position()
        return {"x": actual_x, "y": actual_y, "target_x": target_x, "target_y": target_y,
            "button": button, "action_sent": True, "cleanup": cleanup, "verified": False}

    def scroll(self, amount: Any, horizontal: bool = False) -> Dict[str, Any]:
        pyautogui = self._backend()
        try:
            clicks = int(amount)
        except (TypeError, ValueError) as exc:
            raise ToolError("Scroll amount must be an integer.") from exc
        clicks = max(-_MAX_SCROLL_CLICKS, min(_MAX_SCROLL_CLICKS, clicks))
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
        if len(value) > _MAX_TEXT_LENGTH:
            raise ToolError(f"Text is too long; limit is {_MAX_TEXT_LENGTH} characters.")
        try:
            delay = float(interval or 0)
        except (TypeError, ValueError) as exc:
            raise ToolError("Typing interval must be a finite number.") from exc
        if not math.isfinite(delay):
            raise ToolError("Typing interval must be a finite number.")
        delay = max(0.0, min(delay, 1.0))
        # Clipboard paste supports Unicode, unlike pyautogui.write, which is
        # limited to its key-name mapping. Preserve the user's clipboard.
        try:
            import pyperclip
            previous = pyperclip.paste()
            try:
                pyperclip.copy(value)
                pyautogui.hotkey("ctrl", "v")
                if delay:
                    time.sleep(delay)
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
        return {"keys": normalized, "action_sent": True, "verified": False}

    def key_down(self, key: Any) -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        pyautogui.keyDown(value)
        self._held_keys.add(value)
        return {"key": value, "held": True, "tracking_verified": value in self._held_keys, "verified": False}

    def key_up(self, key: Any) -> Dict[str, Any]:
        pyautogui = self._backend()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        pyautogui.keyUp(value)
        self._held_keys.discard(value)
        return {"key": value, "held": False, "tracking_verified": value not in self._held_keys, "verified": False}

    def emergency_release(self) -> Dict[str, Any]:
        pyautogui = self._backend()
        held_keys = sorted(self._held_keys)
        held_buttons = sorted(self._held_buttons)
        released_keys: List[str] = []
        released_buttons: List[str] = []
        failed_keys: List[str] = []
        failed_buttons: List[str] = []

        for key in held_keys:
            try:
                pyautogui.keyUp(key)
                released_keys.append(key)
                self._held_keys.discard(key)
            except Exception:  # noqa: BLE001
                failed_keys.append(key)
        for button in held_buttons:
            try:
                pyautogui.mouseUp(button=button)
                released_buttons.append(button)
                self._held_buttons.discard(button)
            except Exception:  # noqa: BLE001
                failed_buttons.append(button)

        return {
            "released_keys": released_keys,
            "released_buttons": released_buttons,
            "failed_keys": failed_keys,
            "failed_buttons": failed_buttons,
            "verified": not failed_keys and not failed_buttons and not self._held_keys and not self._held_buttons,
        }

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
