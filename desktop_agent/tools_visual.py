"""Registered SARA 11 visual operations. Grants/actions require the admin bridge secret."""

from __future__ import annotations

from typing import Any, Dict

from .desktop_input_controller import DESKTOP_INPUT
from .registry import ToolError, register
from .screen_monitor import SCREEN_MONITOR
from .visual_access import VISUAL_ACCESS
from .visual_actions import VISUAL_ACTIONS
from .visual_perception import VISUAL_PERCEPTION


@register("saraVisualGrant")
def visual_grant(args: Dict[str, Any]) -> Dict[str, Any]:
    # Stop an old monitoring loop before replacing the source/permissions.
    SCREEN_MONITOR.stop()
    return VISUAL_ACCESS.configure(args)


@register("saraVisualStop")
def visual_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    status = VISUAL_ACCESS.revoke(args.get("bridge_key"), args.get("sequence"))
    SCREEN_MONITOR.stop()
    VISUAL_ACTIONS.cancel_all()
    try:
        release = DESKTOP_INPUT.emergency_release()
        status["input_released"] = release.get("verified") is True
    except ToolError:
        status["input_released"] = False
    return status


@register("saraVisualStatus")
def visual_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return {**VISUAL_ACCESS.status(), "monitor_running": SCREEN_MONITOR.status().get("running", False)}


@register("saraVisualObserve")
def visual_observe(args: Dict[str, Any]) -> Dict[str, Any]:
    return VISUAL_PERCEPTION.observe(str(args.get("task_id") or "")[:90], force=args.get("refresh") is True)


@register("saraVisualClick")
def visual_click(args: Dict[str, Any]) -> Dict[str, Any]:
    return VISUAL_ACTIONS.click(args)


@register("saraVisualTaskStatus")
def visual_task_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return VISUAL_ACTIONS.status(str(args.get("task_id") or ""))


@register("saraVisualTaskCancel")
def visual_task_cancel(args: Dict[str, Any]) -> Dict[str, Any]:
    VISUAL_ACCESS._bridge(args.get("bridge_key"))
    return VISUAL_ACTIONS.cancel(str(args.get("task_id") or ""))


@register("saraVisualDisplays")
def visual_displays(args: Dict[str, Any]) -> Dict[str, Any]:
    # Monitor geometry alone is not a screenshot. On other platforms this
    # returns a real unavailable error, not an invented display list.
    return {"displays": [{"index": idx, "x": mon["x"], "y": mon["y"],
                          "width": mon["width"], "height": mon["height"], "primary": mon.get("primary", False)}
                         for idx, mon in enumerate(DESKTOP_INPUT.monitors())]}
