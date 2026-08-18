import time
import os
import logging
from typing import Dict, Any
from .tools_hardware import (
    hardware_mouse_move as hardwareMouseMove,
    hardware_mouse_click as hardwareMouseClick,
    hardware_mouse_scroll as hardwareMouseScroll,
    hardware_keyboard_press as hardwareKeyboardPress,
)
from .registry import TOOL_REGISTRY, register, ToolError

_log = logging.getLogger("sara.gesture_mapper")

class GestureMapper:
    """Maps high-level gestures to SARA desktop tool calls."""

    # Default mappings across different modes
    MODES: Dict[str, Dict[str, Dict[str, Any]]] = {
        "DEFAULT": {
            "PINCH": {
                "tool": "hardwareMouseClick",
                "args": {"button": "left"},
                "requires_confirmation": False,
            },
            "OPEN_PALM": {
                "tool": "hardwareMouseMove",
                "args": {}, # Dynamically populated
                "requires_confirmation": False,
            },
            "CLOSED_FIST": {
                "tool": "hardwareMouseClick",
                "args": {"button": "right"},
                "requires_confirmation": False,
            },
            "INDEX_POINT": {
                "tool": "hardwareMouseMove",
                "args": {}, 
                "requires_confirmation": False,
            },
            "TWO_FINGER_SCROLL_UP": {
                "tool": "hardwareMouseScroll",
                "args": {"amount": 5},
                "requires_confirmation": False,
            },
            "TWO_FINGER_SCROLL_DOWN": {
                "tool": "hardwareMouseScroll",
                "args": {"amount": -5},
                "requires_confirmation": False,
            },
            "SWIPE_LEFT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["alt", "left"]},
                "requires_confirmation": False,
            },
            "SWIPE_RIGHT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["alt", "right"]},
                "requires_confirmation": False,
            },
            "SWIPE_UP": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["pageup"]},
                "requires_confirmation": False,
            },
            "SWIPE_DOWN": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["pagedown"]},
                "requires_confirmation": False,
            },
            "THUMBS_UP": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["volumeup"]},
                "requires_confirmation": False,
            },
            "THUMBS_DOWN": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["volumedown"]},
                "requires_confirmation": False,
            },
        },
        "MEDIA": {
            "SWIPE_LEFT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["prevtrack"]},
                "requires_confirmation": False,
            },
            "SWIPE_RIGHT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["nexttrack"]},
                "requires_confirmation": False,
            },
            "THUMBS_UP": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["volumeup"]},
                "requires_confirmation": False,
            },
            "THUMBS_DOWN": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["volumedown"]},
                "requires_confirmation": False,
            },
            "OPEN_PALM": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["playpause"]},
                "requires_confirmation": False,
            }
        },
        "PRESENTATION": {
            "SWIPE_LEFT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["left"]},
                "requires_confirmation": False,
            },
            "SWIPE_RIGHT": {
                "tool": "hardwareKeyboardPress",
                "args": {"keys": ["right"]},
                "requires_confirmation": False,
            }
        },
        "BROWSER": {
            "TWO_FINGER_SCROLL_UP": {
                "tool": "hardwareMouseScroll",
                "args": {"amount": 5},
                "requires_confirmation": False,
            },
            "TWO_FINGER_SCROLL_DOWN": {
                "tool": "hardwareMouseScroll",
                "args": {"amount": -5},
                "requires_confirmation": False,
            }
        }
    }

    # Used for runtime override
    DEFAULT_MAPPING = MODES["DEFAULT"]

    @classmethod
    def handle_gesture(cls, name: str, confidence: float, profile: str = "DEFAULT", **kwargs) -> None:
        mode_mapping = cls.MODES.get(profile, cls.MODES["DEFAULT"])
        mapping = mode_mapping.get(name) or cls.DEFAULT_MAPPING.get(name)
        
        # Allow runtime override via persisted mappings
        try:
            from .gesture_tools import _mappings_path
            import json
            path = _mappings_path()
            if path and os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    persisted = json.load(f)
                    mapping = persisted.get(name, mapping)
        except Exception:
            pass
            
        if not mapping:
            _log.warning(f"[Gesture][WARN] No mapping for gesture {name}")
            return

        tool_name = mapping["tool"]
        args = mapping.get("args", {}).copy()
        _log.info(f"[Gesture] Detected: {name}")
        _log.info(f"[Gesture] Confidence: {confidence:.2f}")
        _log.info(f"[Gesture] Mapped action: {tool_name}")
        # Dynamic arguments from kwargs (e.g. hand tracking coordinates)
        if kwargs:
            args.update(kwargs)

        # Ensure OPEN_PALM or INDEX_POINT gets coords if not passed (fallback to current mouse)
        if (name == "OPEN_PALM" or name == "INDEX_POINT") and "x" not in args and "x_norm" not in args:
            import pyautogui
            x, y = pyautogui.position()
            args["x"] = x
            args["y"] = y

        # If gesture includes camera coords, map to screen coordinates
        if 'camera_x' in args or 'camera_y' in args or ('x_norm' in args and 'y_norm' in args):
            try:
                # Normalized camera coords expected in 'camera_x'/'camera_y' or 'x_norm'/'y_norm'
                if 'x_norm' in args and 'y_norm' in args:
                    nx = float(args.pop('x_norm'))
                    ny = float(args.pop('y_norm'))
                else:
                    nx = float(args.pop('camera_x'))
                    ny = float(args.pop('camera_y'))
                    
                # Load calibration from gesture engine config
                from .gesture_engine import GESTURE_ENGINE
                cfg = GESTURE_ENGINE.get_config()
                calib = cfg.get('calibration') or {}
                
                # Expect calibration with camera and screen corners
                # fallback: map directly to screen using pyautogui
                import pyautogui
                screen_w, screen_h = pyautogui.size()
                if not calib or 'camera_top_left' not in calib:
                    sx = int(max(0, min(1, nx)) * screen_w)
                    sy = int(max(0, min(1, ny)) * screen_h)
                else:
                    # simple affine mapping using normalized camera coords and screen corners
                    c_tl = calib.get('camera_top_left')
                    c_tr = calib.get('camera_top_right')
                    c_bl = calib.get('camera_bottom_left')
                    s_tl = calib.get('screen_top_left')
                    s_tr = calib.get('screen_top_right')
                    s_bl = calib.get('screen_bottom_left')
                    # compute scale based on top edge
                    cx_span = (c_tr[0] - c_tl[0]) if (c_tr and c_tl) else 1.0
                    cy_span = (c_bl[1] - c_tl[1]) if (c_bl and c_tl) else 1.0
                    sx = int(((nx - c_tl[0]) / (cx_span or 1.0)) * (s_tr[0] - s_tl[0]) + s_tl[0])
                    sy = int(((ny - c_tl[1]) / (cy_span or 1.0)) * (s_bl[1] - s_tl[1]) + s_tl[1])
                    
                args['x'] = int(max(0, min(screen_w, sx)))
                args['y'] = int(max(0, min(screen_h, sy)))
            except Exception as ex:
                _log.error(f"Calibration mapping failed: {ex}")

        # Check permission / confirmation via the registry
        if not TOOL_REGISTRY.is_allowed(tool_name, args):
            requires = mapping.get('requires_confirmation') if isinstance(mapping, dict) else False
            if requires:
                try:
                    import requests
                    payload = { 'action': tool_name, 'args': args }
                    server_port = int(os.environ.get('SARA_SERVER_PORT', '3000'))
                    resp = requests.post(f'http://127.0.0.1:{server_port}/api/confirm/request', json={ 'action': tool_name, 'args': args, 'ttl': 120 })
                    if resp.ok:
                        _log.info(f"Confirmation requested for {name}: {resp.json()}")
                        return
                except Exception as ex:
                    _log.error(f"Confirmation request failed: {ex}")
            raise ToolError(f"Gesture {name} maps to disallowed tool {tool_name}")

        # Dispatch the tool via the registry's TOOLS dict
        tool_fn = TOOL_REGISTRY.tools.get(tool_name)
        if not tool_fn:
            raise ToolError(f"Tool {tool_name} not found in registry")
        
        _log.info(f"[Gesture] Executing: {tool_name}")
        result = tool_fn(args)
        _log.info(f"[Gesture] Action completed: {tool_name}")
        _log.debug(f"Executed {tool_name} for gesture {name}: {result}")


# The following legacy tools are kept for compatibility, 
# but we add new ones in tools_vision.py for full control

@register("gestureControlEnable")
def gesture_control_enable(args: Dict[str, Any]) -> Dict[str, Any]:
    from .gesture_engine import GESTURE_ENGINE
    from .vision_engine import VISION_ENGINE
    GESTURE_ENGINE.enable()
    VISION_ENGINE.enable()
    return {"result": "Gesture control enabled"}

@register("gestureControlDisable")
def gesture_control_disable(args: Dict[str, Any]) -> Dict[str, Any]:
    from .gesture_engine import GESTURE_ENGINE
    from .vision_engine import VISION_ENGINE
    GESTURE_ENGINE.disable()
    VISION_ENGINE.disable()
    return {"result": "Gesture control disabled"}

@register("gestureControlSetProfile")
def gesture_control_set_profile(args: Dict[str, Any]) -> Dict[str, Any]:
    profile = args.get("profile")
    if not profile:
        raise ToolError("Missing 'profile' parameter for gestureControlSetProfile")
    from .gesture_engine import GESTURE_ENGINE
    GESTURE_ENGINE.set_profile(profile.upper())
    return {"result": f"Gesture profile set to {profile.upper()}"}
