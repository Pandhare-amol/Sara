"""Screen monitoring tools for SARA."""

from __future__ import annotations

from typing import Any, Dict

from .registry import register
from .screen_monitor import SCREEN_MONITOR


@register("saraScreenMonitorStart")
def sara_screen_monitor_start(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": SCREEN_MONITOR.start(
            float(args.get("interval") or 5.0),
            int(args.get("max_events") or 20),
            bool(args.get("capture_images") or args.get("live") or args.get("save_frames")),
        )
    }


@register("saraScreenMonitorStop")
def sara_screen_monitor_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCREEN_MONITOR.stop()}


@register("saraScreenMonitorStatus")
def sara_screen_monitor_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCREEN_MONITOR.status()}


@register("saraScreenMonitorSample")
def sara_screen_monitor_sample(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCREEN_MONITOR.sample()}


@register("saraScreenLiveStart")
def sara_screen_live_start(args: Dict[str, Any]) -> Dict[str, Any]:
    args = dict(args or {})
    args["capture_images"] = True
    args.setdefault("interval", 1.0)
    return sara_screen_monitor_start(args)


@register("saraScreenLiveStop")
def sara_screen_live_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    return sara_screen_monitor_stop(args)


@register("saraScreenLiveStatus")
def sara_screen_live_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return sara_screen_monitor_status(args)
