"""Real keyboard and mouse control tools for SARA, backed by pyautogui."""

from __future__ import annotations

from typing import Any, Dict, List

from .registry import ToolError, register


def _pyautogui():
    try:
        import pyautogui
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Hardware control unavailable: {exc}")
    pyautogui.FAILSAFE = True
    return pyautogui


@register("hardwareMouseMove")
def hardware_mouse_move(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    x = int(args.get("x"))
    y = int(args.get("y"))
    duration = float(args.get("duration") or 0.15)
    pyautogui.moveTo(x, y, duration=duration)
    return {"result": f"Moved mouse to {x}, {y}.", "x": x, "y": y}


@register("hardwareMouseClick")
def hardware_mouse_click(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    x = args.get("x")
    y = args.get("y")
    button = str(args.get("button") or "left")
    clicks = int(args.get("clicks") or 1)
    if x is not None and y is not None:
        pyautogui.click(int(x), int(y), clicks=clicks, button=button)
    else:
        pyautogui.click(clicks=clicks, button=button)
    return {"result": f"Clicked {button} mouse button {clicks} time(s)."}


@register("hardwareMouseDrag")
def hardware_mouse_drag(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    x = int(args.get("x"))
    y = int(args.get("y"))
    duration = float(args.get("duration") or 0.3)
    button = str(args.get("button") or "left")
    pyautogui.dragTo(x, y, duration=duration, button=button)
    return {"result": f"Dragged mouse to {x}, {y}."}


@register("hardwareMouseScroll")
def hardware_mouse_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    amount = int(args.get("amount") or args.get("clicks") or -5)
    horizontal = bool(args.get("horizontal", False))
    if horizontal and hasattr(pyautogui, "hscroll"):
        pyautogui.hscroll(amount)
        return {"result": f"Scrolled horizontally by {amount}."}
    pyautogui.scroll(amount)
    return {"result": f"Scrolled vertically by {amount}."}


@register("hardwareMousePosition")
def hardware_mouse_position(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    x, y = pyautogui.position()
    width, height = pyautogui.size()
    return {"result": f"Mouse is at {x}, {y}.", "x": x, "y": y, "screen_width": width, "screen_height": height}


@register("hardwareKeyboardType")
def hardware_keyboard_type(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    text = str(args.get("text") or "")
    interval = float(args.get("interval") or 0.01)
    if not text:
        raise ToolError("Parameter 'text' is required.")
    pyautogui.write(text, interval=interval)
    return {"result": f"Typed {len(text)} character(s)."}


@register("hardwareKeyboardPress")
def hardware_keyboard_press(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    keys = args.get("keys") or args.get("key")
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.replace("+", ",").split(",") if k.strip()]
    if not isinstance(keys, list) or not keys:
        raise ToolError("Provide 'key' or 'keys'.")
    normalized: List[str] = [str(k).lower() for k in keys]
    if len(normalized) == 1:
        pyautogui.press(normalized[0])
    else:
        pyautogui.hotkey(*normalized)
    return {"result": f"Pressed {'+'.join(normalized)}.", "keys": normalized}


@register("hardwareKeyboardHold")
def hardware_keyboard_hold(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    key = str(args.get("key") or "").lower()
    if not key:
        raise ToolError("Parameter 'key' is required.")
    pyautogui.keyDown(key)
    return {"result": f"Holding {key}.", "key": key}


@register("hardwareKeyboardRelease")
def hardware_keyboard_release(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    key = str(args.get("key") or "").lower()
    if not key:
        raise ToolError("Parameter 'key' is required.")
    pyautogui.keyUp(key)
    return {"result": f"Released {key}.", "key": key}


@register("hardwareMacroReplay")
def hardware_macro_replay(args: Dict[str, Any]) -> Dict[str, Any]:
    pyautogui = _pyautogui()
    actions = args.get("actions") or []
    if not isinstance(actions, list):
        raise ToolError("'actions' must be a list.")
    executed = 0
    for action in actions:
        if not isinstance(action, dict):
            continue
        kind = action.get("type")
        if kind == "click":
            hardware_mouse_click(action)
        elif kind == "type":
            hardware_keyboard_type(action)
        elif kind == "press":
            hardware_keyboard_press(action)
        elif kind == "scroll":
            hardware_mouse_scroll(action)
        elif kind == "move":
            hardware_mouse_move(action)
        executed += 1
    return {"result": f"Replayed {executed} macro action(s).", "executed": executed}
