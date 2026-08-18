from __future__ import annotations

import json
from typing import Any, Dict

from .gesture_mapper import GestureMapper  # noqa: F401 - import registers legacy tools
from .gesture_tools import _mappings_path  # noqa: F401 - import registers config tools
from .gesture_engine import GESTURE_ENGINE
from .registry import ToolError, register, TOOL_REGISTRY
from .vision_engine import VISION_ENGINE


def _result(message: str, *, tool: str, verified: bool = True, data: Dict[str, Any] | None = None, status: str | None = None, error: str = "", changed_state: bool | None = None) -> Dict[str, Any]:
    status = status or ("SUCCESS" if verified else "UNCERTAIN")
    payload: Dict[str, Any] = {
        "tool": tool,
        "status": status,
        "executed": True,
        "verified": verified,
        "changed_state": changed_state,
        "message": message,
        "error": error,
        "data": data or {},
        "verification": {"status": "VERIFIED" if verified else "UNCERTAIN", "method": "gesture_state"},
    }
    return payload


@register(
    "gestureControlSetMapping",
    permission_level="LOW",
    risk_level="LOW",
    supported_os=["Windows", "macOS", "Linux"],
    destructive=False,
    live_ui_verification=False,
    can_return_uncertain=True,
    verification_method="gesture_mapping_store",
    tags=["gesture", "camera", "mapping"],
)
def gesture_control_set_mapping(args: Dict[str, Any]) -> Dict[str, Any]:
    gesture = str(args.get("gesture") or args.get("name") or "").strip()
    mapping = args.get("mapping") or {}
    if not gesture:
        raise ToolError("Parameter 'gesture' is required.")
    if not isinstance(mapping, dict):
        raise ToolError("Parameter 'mapping' must be an object.")
    if not mapping.get("tool"):
        raise ToolError("Mapping requires a 'tool' field.")
    if not TOOL_REGISTRY.get(str(mapping.get("tool"))):
        raise ToolError(f"Unknown tool '{mapping.get('tool')}' in gesture mapping.")
    if not GESTURE_ENGINE.safety.validate_mapping(gesture, mapping):
        raise ToolError("Mapping is not valid.")
    current = GESTURE_ENGINE.get_config().get("per_gesture") or {}
    if not isinstance(current, dict):
        current = {}
    current[gesture] = dict(mapping)
    GESTURE_ENGINE.set_config({"per_gesture": current})
    try:
        path = _mappings_path()
        persisted = {}
        if path and json:
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    persisted = json.load(fh)
            except Exception:
                persisted = {}
            if not isinstance(persisted, dict):
                persisted = {}
            persisted[gesture] = dict(mapping)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(persisted, fh, indent=2)
            GestureMapper.DEFAULT_MAPPING = persisted
    except Exception:
        pass
    return _result(f"Gesture mapping updated for {gesture}.", tool="gestureControlSetMapping", data={"gesture": gesture, "mapping": mapping}, changed_state=True)


@register(
    "gestureControlSetMonitor",
    permission_level="LOW",
    risk_level="LOW",
    supported_os=["Windows", "macOS", "Linux"],
    destructive=False,
    live_ui_verification=False,
    can_return_uncertain=True,
    verification_method="camera_state",
    tags=["gesture", "camera", "monitor"],
)
def gesture_control_set_monitor(args: Dict[str, Any]) -> Dict[str, Any]:
    monitor_index = int(args.get("monitor_index") or args.get("monitor") or 1)
    GESTURE_ENGINE.set_monitor(monitor_index)
    if VISION_ENGINE.is_active():
        VISION_ENGINE.disable()
        VISION_ENGINE.enable()
    return _result(f"Gesture monitor set to {monitor_index}.", tool="gestureControlSetMonitor", data={"monitor_index": monitor_index}, changed_state=True)


@register(
    "gestureControlSetSensitivity",
    permission_level="LOW",
    risk_level="LOW",
    supported_os=["Windows", "macOS", "Linux"],
    destructive=False,
    live_ui_verification=False,
    can_return_uncertain=True,
    verification_method="gesture_config",
    tags=["gesture", "camera", "sensitivity"],
)
def gesture_control_set_sensitivity(args: Dict[str, Any]) -> Dict[str, Any]:
    sensitivity = float(args.get("sensitivity") or args.get("value") or 1.0)
    GESTURE_ENGINE.set_sensitivity(sensitivity)
    return _result(f"Gesture sensitivity set to {sensitivity:.2f}.", tool="gestureControlSetSensitivity", data={"sensitivity": sensitivity}, changed_state=True)


@register(
    "gestureControlSetThresholds",
    permission_level="LOW",
    risk_level="LOW",
    supported_os=["Windows", "macOS", "Linux"],
    destructive=False,
    live_ui_verification=False,
    can_return_uncertain=True,
    verification_method="gesture_config",
    tags=["gesture", "camera", "thresholds"],
)
def gesture_control_set_thresholds(args: Dict[str, Any]) -> Dict[str, Any]:
    thresholds = args.get("thresholds") or {}
    if not isinstance(thresholds, dict):
        raise ToolError("Parameter 'thresholds' must be an object.")
    GESTURE_ENGINE.set_thresholds(thresholds)
    return _result("Gesture thresholds updated.", tool="gestureControlSetThresholds", data={"thresholds": thresholds}, changed_state=True)
