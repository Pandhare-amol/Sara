"""Real keyboard and mouse control tools for SARA, backed by pyautogui."""

from __future__ import annotations

from typing import Any, Dict, List

from .desktop_input_controller import DESKTOP_INPUT
from .registry import ToolError, register


@register("hardwareMouseMove")
def hardware_mouse_move(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse moved and position verified.", **DESKTOP_INPUT.move(args.get("x"), args.get("y"), args.get("duration"), args.get("mode"))}


@register("mouseMove")
def mouse_move(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_move(args)


@register("mouseMoveRelative")
def mouse_move_relative(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse moved relative to its current position.", **DESKTOP_INPUT.move_relative(args.get("dx"), args.get("dy"), args.get("duration"), args.get("mode"))}


@register("hardwareMouseClick")
def hardware_mouse_click(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse click sent to the foreground desktop.", **DESKTOP_INPUT.click(args)}


@register("mouseClick")
def mouse_click(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_click(args)


@register("mouseDoubleClick")
def mouse_double_click(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    payload["clicks"] = 2
    return hardware_mouse_click(payload)


@register("mouseRightClick")
def mouse_right_click(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    payload["button"] = "right"
    return hardware_mouse_click(payload)


@register("hardwareMouseDrag")
def hardware_mouse_drag(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse drag sent and released safely.", **DESKTOP_INPUT.drag(args)}


@register("hardwareMouseScroll")
def hardware_mouse_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    amount = args.get("amount") or args.get("clicks") or -5
    return {"result": "Mouse scroll sent.", **DESKTOP_INPUT.scroll(amount, bool(args.get("horizontal", False)))}


@register("mouseScroll")
def mouse_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_scroll(args)


@register("hardwareMousePosition")
def hardware_mouse_position(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = DESKTOP_INPUT._backend()
    x, y = pyautogui.position()
    width, height = pyautogui.size()
    return {"result": f"Mouse is at {x}, {y}.", "x": x, "y": y, "screen_width": width, "screen_height": height}


@register("mousePosition")
def mouse_position(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_position(args)


@register("hardwareKeyboardType")
def hardware_keyboard_type(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Text typed through the foreground keyboard.", **DESKTOP_INPUT.type_text(args.get("text"), args.get("interval"))}


@register("keyboardType")
def keyboard_type(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_keyboard_type(args)


@register("hardwareKeyboardPress")
def hardware_keyboard_press(args: Dict[str, Any]) -> Dict[str, Any]:
    keys = args.get("keys") or args.get("key")
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.replace("+", ",").split(",") if k.strip()]
    if not isinstance(keys, list) or not keys:
        raise ToolError("Provide 'key' or 'keys'.")
    normalized: List[str] = [str(k).lower() for k in keys]
    return {"result": f"Pressed {'+'.join(normalized)}.", **DESKTOP_INPUT.press(normalized)}


@register("keyPress")
def key_press(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_keyboard_press(args)


@register("hardwareKeyboardHold")
def hardware_keyboard_hold(args: Dict[str, Any]) -> Dict[str, Any]:
    key = str(args.get("key") or "").lower()
    return {"result": f"Holding {key}.", **DESKTOP_INPUT.key_down(key)}


@register("keyDown")
def key_down(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_keyboard_hold(args)


@register("hardwareKeyboardRelease")
def hardware_keyboard_release(args: Dict[str, Any]) -> Dict[str, Any]:
    key = str(args.get("key") or "").lower()
    return {"result": f"Released {key}.", **DESKTOP_INPUT.key_up(key)}


@register("keyUp")
def key_up(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_keyboard_release(args)


@register("hardwareMouseButtonDown")
def hardware_mouse_button_down(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse button held.", **DESKTOP_INPUT.button_down(args.get("button"))}


@register("hardwareMouseButtonUp")
def hardware_mouse_button_up(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse button released.", **DESKTOP_INPUT.button_up(args.get("button"))}


@register("hardwareEmergencyRelease")
def hardware_emergency_release(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Held keyboard keys and mouse buttons released.", **DESKTOP_INPUT.emergency_release()}


@register("emergencyStop")
def emergency_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_emergency_release(args)


@register("hardwareMonitors")
def hardware_monitors(args: Dict[str, Any]) -> Dict[str, Any]:
    monitors = DESKTOP_INPUT.monitors()
    return {"result": "Windows monitors enumerated.", "monitors": monitors, "verified": True}


@register("hardwareMacroReplay")
def hardware_macro_replay(args: Dict[str, Any]) -> Dict[str, Any]:
    actions = args.get("actions") or []
    if not isinstance(actions, list):
        raise ToolError("'actions' must be a list.")
    if len(actions) > 100:
        raise ToolError("A hardware macro is limited to 100 actions.")

    handlers = {
        "click": hardware_mouse_click,
        "type": hardware_keyboard_type,
        "press": hardware_keyboard_press,
        "scroll": hardware_mouse_scroll,
        "move": hardware_mouse_move,
    }
    executed = 0
    ignored = 0
    cleanup: Dict[str, Any] = {"verified": False}
    try:
        for action in actions:
            if not isinstance(action, dict):
                ignored += 1
                continue
            handler = handlers.get(str(action.get("type") or ""))
            if handler is None:
                ignored += 1
                continue
            handler(action)
            executed += 1
    finally:
        try:
            cleanup = DESKTOP_INPUT.emergency_release()
        except Exception as exc:  # noqa: BLE001
            cleanup = {"verified": False, "error": str(exc)}

    return {
        "result": f"Replayed {executed} hardware macro action(s); ignored {ignored} unsupported action(s).",
        "executed": executed,
        "ignored": ignored,
        "cleanup": cleanup,
        "action_sent": executed > 0,
        "verified": False,
    }
