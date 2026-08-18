from typing import Dict, Any
from .registry import register, ToolError
from .screen_monitor import SCREEN_MONITOR, ScreenMonitorState

@register("saraScreenLiveStart")
def sara_screen_live_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Start continuous screen monitoring."""
    fps = float(args.get("fps", 1.0))
    quality = int(args.get("quality", 50))
    monitor_index = int(args.get("monitor_index", 1))
    
    try:
        status = SCREEN_MONITOR.start_live(fps=fps, quality=quality, monitor_index=monitor_index)
        if status.get("state") == ScreenMonitorState.ERROR:
            raise ToolError(f"Screen monitoring failed to start: {status.get('error')}")
        return {"result": "Screen monitoring started.", "status": status}
    except Exception as exc:
        raise ToolError(f"Error starting screen monitor: {exc}")

@register("saraScreenLiveStop")
def sara_screen_live_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    """Stop continuous screen monitoring."""
    try:
        status = SCREEN_MONITOR.stop()
        return {"result": "Screen monitoring stopped.", "status": status}
    except Exception as exc:
        raise ToolError(f"Error stopping screen monitor: {exc}")

@register("saraScreenLivePause")
def sara_screen_live_pause(args: Dict[str, Any]) -> Dict[str, Any]:
    """Pause continuous screen monitoring."""
    try:
        status = SCREEN_MONITOR.pause()
        return {"result": "Screen monitoring paused.", "status": status}
    except Exception as exc:
        raise ToolError(f"Error pausing screen monitor: {exc}")

@register("saraScreenLiveResume")
def sara_screen_live_resume(args: Dict[str, Any]) -> Dict[str, Any]:
    """Resume continuous screen monitoring."""
    try:
        status = SCREEN_MONITOR.resume()
        return {"result": "Screen monitoring resumed.", "status": status}
    except Exception as exc:
        raise ToolError(f"Error resuming screen monitor: {exc}")

@register("saraScreenMonitorStatus")
def sara_screen_monitor_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get screen monitor status."""
    return {"result": SCREEN_MONITOR.status()}

@register("saraScreenGetMonitors")
def sara_screen_get_monitors(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get list of connected monitors."""
    try:
        import mss
        with mss.mss() as sct:
            return {"result": sct.monitors}
    except Exception as exc:
        raise ToolError(f"Error getting monitors: {exc}")

@register("saraScreenGetActiveWindow")
def sara_screen_get_active_window(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get the currently active window title."""
    try:
        import pygetwindow as gw
        active = gw.getActiveWindow()
        if active:
            return {"result": active.title}
        return {"result": "No active window found."}
    except Exception as exc:
        raise ToolError(f"Error getting active window: {exc}")

# Legacy endpoints for compatibility
@register("saraScreenMonitorStart")
def sara_screen_monitor_start(args: Dict[str, Any]) -> Dict[str, Any]:
    return sara_screen_live_start(args)

@register("saraScreenMonitorStop")
def sara_screen_monitor_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    return sara_screen_live_stop(args)

@register("saraScreenMonitorSample")
def sara_screen_monitor_sample(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCREEN_MONITOR.status()}
