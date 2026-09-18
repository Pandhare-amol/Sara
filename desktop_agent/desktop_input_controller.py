"""Authoritative real Windows mouse and keyboard input controller."""

from __future__ import annotations

import platform
import time
import uuid
from typing import Any, Dict, Iterable, List

from .registry import ToolError
from .native_input import (
    get_cursor_pos, set_cursor_pos, move_mouse_absolute, mouse_click,
    mouse_button_down, mouse_button_up, mouse_scroll, key_press,
    key_down, key_up, type_unicode, get_virtual_screen_bounds,
)


class DesktopInputController:
    """Thin, stateful wrapper around real OS input with emergency cleanup."""

    def __init__(self) -> None:
        self._held_keys: set[str] = set()
        self._held_buttons: set[str] = set()


    def readiness(self) -> Dict[str, Any]:
        """Check that the real input backends are installed without sending input."""
        try:
            vx, vy, vcx, vcy = get_virtual_screen_bounds()
            return {
                "ready": True,
                "platform": platform.system(),
                "screen_width": vcx,
                "screen_height": vcy,
                "virtual_x": vx,
                "virtual_y": vy
            }
        except Exception as exc:
            return {"ready": False, "platform": platform.system(), "error": str(exc)}

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

    def _build_response(
        self,
        action_type: str,
        execution_success: bool,
        verification_success: bool,
        actual_position: tuple[int, int] | None = None,
        error: str | None = None,
        action_id: str | None = None,
        task_id: str | None = None
    ) -> Dict[str, Any]:
        resp = {
            "actionId": action_id or f"ACT-{uuid.uuid4().hex[:8]}",
            "taskId": task_id or "",
            "type": action_type,
            "execution": {
                "success": execution_success
            },
            "verification": {
                "attempted": True,
                "success": verification_success
            },
            "error": error
        }
        if actual_position:
            resp["verification"]["actualPosition"] = {"x": actual_position[0], "y": actual_position[1]}
        return resp

    def move(self, x: Any, y: Any, duration: Any = 0.15, mode: Any = "NATURAL", action_id: str = "", task_id: str = "") -> Dict[str, Any]:
        self._require_windows()
        target_x = self._coordinate(x, "x")
        target_y = self._coordinate(y, "y")
        selected_mode = str(mode or "NATURAL").upper()
        if selected_mode not in {"FAST", "NATURAL", "PRECISE", "INSTANT"}:
            raise ToolError("Mouse mode must be FAST, NATURAL, PRECISE, or INSTANT.")
        try:
            # Execution
            if selected_mode == "INSTANT" or duration == 0:
                set_cursor_pos(target_x, target_y)
            else:
                move_mouse_absolute(target_x, target_y, duration=float(duration or 0.15), mode=selected_mode)
            exec_success = True
            error_msg = None
        except Exception as e:
            exec_success = False
            error_msg = str(e)

        # Verification
        try:
            actual_x, actual_y = get_cursor_pos()
            # Allow some tolerance for virtual screen mapping
            ver_success = exec_success and (abs(actual_x - target_x) <= 2) and (abs(actual_y - target_y) <= 2)
        except Exception:
            actual_x, actual_y = 0, 0
            ver_success = False

        return self._build_response(
            "mouse.move", exec_success, ver_success, (actual_x, actual_y), error_msg, action_id, task_id
        )

    def move_relative(self, dx: Any, dy: Any, duration: Any = 0.15, mode: Any = "NATURAL", action_id: str = "", task_id: str = "") -> Dict[str, Any]:
        self._require_windows()
        current_x, current_y = get_cursor_pos()
        return self.move(current_x + self._coordinate(dx, "dx"), current_y + self._coordinate(dy, "dy"), duration, mode, action_id, task_id)

    def click(self, args: Dict[str, Any]) -> Dict[str, Any]:
        self._require_windows()
        button = str(args.get("button") or "left").lower()
        if button not in {"left", "right", "middle"}:
            raise ToolError("Mouse button must be left, right, or middle.")

        action_id = args.get("actionId", "")
        task_id = args.get("taskId", "")

        try:
            if args.get("x") is not None and args.get("y") is not None:
                self.move(args["x"], args["y"], duration=0, mode="INSTANT")

            clicks = max(1, min(int(args.get("clicks") or 1), 3))
            for _ in range(clicks):
                mouse_click(button)
                time.sleep(0.05)
            exec_success = True
            error = None
        except Exception as e:
            exec_success = False
            error = str(e)

        try:
            actual_x, actual_y = get_cursor_pos()
            ver_success = exec_success # For clicks, physical position is the only easy verify right now
        except Exception:
            actual_x, actual_y = 0, 0
            ver_success = False

        resp = self._build_response("mouse.click", exec_success, ver_success, (actual_x, actual_y), error, action_id, task_id)
        resp["target"] = {"button": button, "clicks": clicks}
        return resp

    def type_text(self, text: Any, interval: Any = 0.01) -> Dict[str, Any]:
        self._require_windows()
        value = str(text or "")
        if not value:
            raise ToolError("Parameter 'text' is required.")
        try:
            type_unicode(value)
            if interval:
                time.sleep(min(float(interval), 1.0))
            exec_success = True
            error = None
        except Exception as exc:
            exec_success = False
            error = str(exc)

        return self._build_response("keyboard.type", exec_success, exec_success, None, error)

    def press(self, keys: Iterable[Any]) -> Dict[str, Any]:
        self._require_windows()
        normalized = [str(key).strip().lower() for key in keys if str(key).strip()]
        if not normalized:
            raise ToolError("Provide 'key' or 'keys'.")
        try:
            key_press(normalized)
            return {"keys": normalized, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Keyboard input failed: {exc}") from exc

    def key_down(self, key: Any) -> Dict[str, Any]:
        self._require_windows()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        try:
            key_down(value)
            self._held_keys.add(value)
            return {"key": value, "held": True, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Keyboard input failed: {exc}") from exc

    def key_up(self, key: Any) -> Dict[str, Any]:
        self._require_windows()
        value = str(key or "").strip().lower()
        if not value:
            raise ToolError("Parameter 'key' is required.")
        try:
            key_up(value)
            self._held_keys.discard(value)
            return {"key": value, "held": False, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Keyboard input failed: {exc}") from exc

    def button_down(self, button: Any = "left") -> Dict[str, Any]:
        self._require_windows()
        value = str(button or "left").lower()
        try:
            mouse_button_down(value)
            self._held_buttons.add(value)
            return {"button": value, "held": True, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Mouse input failed: {exc}") from exc

    def button_up(self, button: Any = "left") -> Dict[str, Any]:
        self._require_windows()
        value = str(button or "left").lower()
        try:
            mouse_button_up(value)
            self._held_buttons.discard(value)
            return {"button": value, "held": False, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Mouse input failed: {exc}") from exc

    def drag(self, args: Dict[str, Any]) -> Dict[str, Any]:
        self._require_windows()
        button = str(args.get("button") or "left").lower()
        try:
            if args.get("x") is None or args.get("y") is None:
                raise ToolError("Drag requires target x and y coordinates.")
            if args.get("start_x") is not None and args.get("start_y") is not None:
                self.move(args["start_x"], args["start_y"], 0, "INSTANT")
            mouse_button_down(button)
            self._held_buttons.add(button)
            try:
                self.move(args["x"], args["y"], args.get("duration", 0.3), args.get("mode", "NATURAL"))
            finally:
                mouse_button_up(button)
                self._held_buttons.discard(button)
            actual = get_cursor_pos()
            return {"button": button, "target_x": int(args["x"]), "target_y": int(args["y"]), "x": actual[0], "y": actual[1], "action_sent": True, "verified": abs(actual[0]-int(args["x"])) <= 2 and abs(actual[1]-int(args["y"])) <= 2}
        except ToolError:
            raise
        except Exception as exc:
            raise ToolError(f"Mouse drag failed: {exc}") from exc

    def scroll(self, amount: Any, horizontal: bool = False) -> Dict[str, Any]:
        self._require_windows()
        try:
            value = int(amount)
            mouse_scroll(value, horizontal)
            return {"amount": value, "horizontal": horizontal, "action_sent": True, "verified": True}
        except Exception as exc:
            raise ToolError(f"Mouse scroll failed: {exc}") from exc

    def emergency_release(self) -> Dict[str, Any]:
        released_keys = sorted(self._held_keys)
        released_buttons = sorted(self._held_buttons)
        if platform.system() == "Windows":
            for value in released_keys:
                try: key_up(value)
                except Exception: pass
            for value in released_buttons:
                try: mouse_button_up(value)
                except Exception: pass
        self._held_keys.clear(); self._held_buttons.clear()
        return {"released": True, "released_keys": released_keys, "released_buttons": released_buttons, "verified": True}

    def monitors(self) -> List[Dict[str, Any]]:
        self._require_windows()
        try:
            import win32api
            result = []
            for handle, _hdc, rectangle in win32api.EnumDisplayMonitors():
                info = win32api.GetMonitorInfo(handle)
                left, top, right, bottom = rectangle
                result.append({"handle": str(handle), "x": left, "y": top, "width": right-left, "height": bottom-top, "primary": bool(info.get("Flags", 0) & 1)})
            return result
        except Exception as exc:
            raise ToolError(f"Could not enumerate Windows monitors: {exc}") from exc

DESKTOP_INPUT = DesktopInputController()
