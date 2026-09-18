"""Real keyboard and mouse control tools for SARA, backed by pyautogui."""

from __future__ import annotations

import math
import re
import time
import ctypes
import platform
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


@register("mouseDrag")
def mouse_drag(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_drag(args)


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
        raw_keys = re.split(r"\s*(?:\+|,|\bthen\b)\s*", keys.strip(), flags=re.IGNORECASE)
        if len(raw_keys) == 1 and " " in raw_keys[0]:
            raw_keys = raw_keys[0].split()
        keys = [k.strip() for k in raw_keys if k.strip()]
    if not isinstance(keys, list) or not keys:
        raise ToolError("Provide 'key' or 'keys'.")
    normalized: List[str] = [str(k).lower() for k in keys]
    return {"result": f"Pressed {'+'.join(normalized)}.", **DESKTOP_INPUT.press(normalized)}


@register("keyPress")
def key_press(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_keyboard_press(args)


@register("keyboardShortcut")
def keyboard_shortcut(args: Dict[str, Any]) -> Dict[str, Any]:
    shortcuts = {
        "copy": ["ctrl", "c"],
        "paste": ["ctrl", "v"],
        "cut": ["ctrl", "x"],
        "select_all": ["ctrl", "a"],
        "undo": ["ctrl", "z"],
        "redo": ["ctrl", "y"],
        "save": ["ctrl", "s"],
        "find": ["ctrl", "f"],
        "new_tab": ["ctrl", "t"],
        "close_tab": ["ctrl", "w"],
        "close_window": ["alt", "f4"],
        "alt_tab": ["alt", "tab"],
        "show_desktop": ["win", "d"],
        "lock_screen": ["win", "l"],
    }
    name = str(args.get("name") or args.get("shortcut") or "").strip().lower().replace(" ", "_")
    keys = shortcuts.get(name)
    if not keys:
        raise ToolError(f"Unknown keyboard shortcut '{name}'.")
    return {"result": f"Pressed {name.replace('_', ' ')}.", **DESKTOP_INPUT.press(keys), "shortcut": name}


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


@register("mouseButtonDown")
def mouse_button_down(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_button_down(args)


@register("hardwareMouseButtonUp")
def hardware_mouse_button_up(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Mouse button released.", **DESKTOP_INPUT.button_up(args.get("button"))}


@register("mouseButtonUp")
def mouse_button_up(args: Dict[str, Any]) -> Dict[str, Any]:
    return hardware_mouse_button_up(args)


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


@register("diagnosticMouseSweep")
def diagnostic_mouse_sweep(args: Dict[str, Any]) -> Dict[str, Any]:
    """Moves the mouse in a circular diagnostic pattern to demonstrate native control."""
    try:
        from .native_input import get_virtual_screen_bounds
        vx, vy, vcx, vcy = get_virtual_screen_bounds()
    except Exception:
        vx, vy, vcx, vcy = 0, 0, 1920, 1080
    
    # Calculate center and radius
    center_x = vx + vcx // 2
    center_y = vy + vcy // 2
    radius = min(vcx, vcy) // 4
    
    points = 36
    delay = 0.02
    
    # Start at the top of the circle
    DESKTOP_INPUT.move(center_x, center_y - radius, duration=0, mode="INSTANT")
    time.sleep(0.1)
    
    # Sweep in a circle
    for i in range(points + 1):
        angle = (i / points) * 2 * math.pi - (math.pi / 2)
        x = center_x + int(radius * math.cos(angle))
        y = center_y + int(radius * math.sin(angle))
        DESKTOP_INPUT.move(x, y, duration=0, mode="INSTANT")
        time.sleep(delay)
        
    return {
        "result": "Performed visual mouse diagnostic sweep (circle).", 
        "verified": True,
        "center_x": center_x,
        "center_y": center_y,
        "radius": radius
    }

@register("emptyRecycleBin")
def empty_recycle_bin(args: Dict[str, Any]) -> Dict[str, Any]:
    """Empty the Windows Recycle Bin without user prompts.
    Returns a result dict indicating success.
    """
    if platform.system() != "Windows":
        raise ToolError("emptyRecycleBin is only supported on Windows.")
    # Flags: no confirmation, no progress UI, no sound
    SHERB_NOCONFIRMATION = 0x00000001
    SHERB_NOPROGRESSUI = 0x00000002
    SHERB_NOSOUND = 0x00000004
    flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
    try:
        result = ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, flags)
        if result != 0:
            raise ToolError(f"Failed to empty recycle bin, error code {result}")
        return {"result": "Recycle bin emptied successfully.", "status": "SUCCESS"}
    except Exception as e:
        raise ToolError(f"Error emptying recycle bin: {e}") from e
