from __future__ import annotations

from typing import Any, Dict

from .registry import register, ToolError
from .vision_engine import VISION_ENGINE
from .gesture_engine import GESTURE_ENGINE

@register("enableVision")
def enable_vision(args: Dict[str, Any]) -> Dict[str, Any]:
    """Legacy endpoint to enable the camera and start the vision processing loop."""
    try:
        VISION_ENGINE.enable()
        return {"result": "Vision engine enabled and camera streaming started."}
    except Exception as exc:
        raise ToolError(f"Failed to enable vision engine: {exc}")

@register("disableVision")
def disable_vision(args: Dict[str, Any]) -> Dict[str, Any]:
    """Legacy endpoint to disable the camera and stop the vision processing loop."""
    try:
        VISION_ENGINE.disable()
        return {"result": "Vision engine disabled and camera released."}
    except Exception as exc:
        raise ToolError(f"Failed to disable vision engine: {exc}")

@register("getVisionState")
def get_vision_state(args: Dict[str, Any]) -> Dict[str, Any]:
    """Return current vision engine state, including detected hands and gestures."""
    try:
        return {"result": VISION_ENGINE.get_state()}
    except Exception as exc:
        raise ToolError(f"Failed to retrieve vision state: {exc}")

@register("gestureControlStart")
def gesture_control_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Enable Gesture Engine and Vision Engine (Camera)."""
    try:
        GESTURE_ENGINE.enable()
        VISION_ENGINE.enable()
        return {"result": "Gesture control activated. Camera started.", "status": "SUCCESS", "executed": True, "verified": True, "changed_state": True, "data": GESTURE_ENGINE.get_status()}
    except Exception as exc:
        raise ToolError(f"Failed to start gesture control: {exc}")

@register("gestureControlStop")
def gesture_control_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    """Disable Gesture Engine and Vision Engine (Camera)."""
    try:
        GESTURE_ENGINE.emergency_stop()
        GESTURE_ENGINE.disable()
        VISION_ENGINE.disable()
        return {"result": "Gesture control deactivated. Camera released.", "status": "SUCCESS", "executed": True, "verified": True, "changed_state": True, "data": GESTURE_ENGINE.get_status()}
    except Exception as exc:
        raise ToolError(f"Failed to stop gesture control: {exc}")

@register("gestureControlPause")
def gesture_control_pause(args: Dict[str, Any]) -> Dict[str, Any]:
    """Pause Gesture Engine and Vision Engine without releasing the camera."""
    try:
        GESTURE_ENGINE.pause()
        VISION_ENGINE.pause()
        return {"result": "Gesture control paused.", "status": "SUCCESS", "executed": True, "verified": True, "changed_state": True, "data": GESTURE_ENGINE.get_status()}
    except Exception as exc:
        raise ToolError(f"Failed to pause gesture control: {exc}")

@register("gestureControlResume")
def gesture_control_resume(args: Dict[str, Any]) -> Dict[str, Any]:
    """Resume Gesture Engine and Vision Engine."""
    try:
        GESTURE_ENGINE.resume()
        VISION_ENGINE.resume()
        return {"result": "Gesture control resumed.", "status": "SUCCESS", "executed": True, "verified": True, "changed_state": True, "data": GESTURE_ENGINE.get_status()}
    except Exception as exc:
        raise ToolError(f"Failed to resume gesture control: {exc}")

@register("gestureControlStatus")
def gesture_control_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Return the status of the Gesture Engine and Vision Engine."""
    return {
        "result": {
            "gesture_engine_enabled": GESTURE_ENGINE.enabled,
            "gesture_engine_paused": GESTURE_ENGINE.paused,
            "vision_engine_active": VISION_ENGINE.is_active(),
            "vision_state": VISION_ENGINE.get_state(),
            "gesture_status": GESTURE_ENGINE.get_status(),
        }
    }

@register("gestureControlCalibrate")
def gesture_control_calibrate(args: Dict[str, Any]) -> Dict[str, Any]:
    """Trigger the calibration flow."""
    # In a full implementation, this might broadcast to UI or set a mode.
    # For now we'll just indicate it should be initiated.
    return {"result": "Calibration flow initiated.", "calibration": GESTURE_ENGINE.calibrate(), "gesture_status": GESTURE_ENGINE.get_status()}
