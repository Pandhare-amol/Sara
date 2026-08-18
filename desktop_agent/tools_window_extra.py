"""Additional window/application management tools for voice control."""

from __future__ import annotations

import ctypes
import platform
import subprocess
from typing import Any, Dict, List

try:
    import psutil
except Exception:  # noqa: BLE001
    psutil = None

from .registry import ToolError, register
from .tools_windows import SW_RESTORE, _find_window_by_title, _focus, _show_window


@register("listRunningApplications")
def list_running_applications(args: Dict[str, Any]) -> Dict[str, Any]:
    if psutil is None:
        return {"result": "Process listing is unavailable in this environment.", "applications": []}
    names = sorted({proc.info.get("name") for proc in psutil.process_iter(["name"]) if proc.info.get("name")})
    return {"result": f"Detected {len(names)} running application process names.", "applications": names[:500]}


@register("closeAllApplications")
def close_all_applications(args: Dict[str, Any]) -> Dict[str, Any]:
    if psutil is None:
        raise ToolError("Process management is unavailable in this environment.")
    protected = {"explorer.exe", "sara.exe", "python.exe", "pythonw.exe", "code.exe", "electron.exe", "uvicorn.exe", "node.exe"}
    force = bool(args.get("force", False))
    closed: List[str] = []
    for proc in psutil.process_iter(["name"]):
        name = (proc.info.get("name") or "").lower()
        if not name or name in protected:
            continue
        try:
            if force:
                proc.kill()
            else:
                proc.terminate()
            closed.append(name)
        except Exception:
            continue
    return {"result": f"Requested close for {len(closed)} application process(es).", "applications": closed[:200]}


@register("restoreWindow")
def restore_window(args: Dict[str, Any]) -> Dict[str, Any]:
    title = args.get("title") or args.get("application")
    if not title:
        raise ToolError("Parameter 'title' or 'application' is required.")
    hwnd = _find_window_by_title(str(title))
    if not hwnd:
        raise ToolError(f"No visible window matching '{title}'.")
    _show_window(hwnd, SW_RESTORE)
    _focus(hwnd)
    return {"result": f"Restored and focused {title}.", "verified": True, "verification": "VERIFIED"}


def _window_rect(hwnd):
    try:
        import win32gui

        return win32gui.GetWindowRect(hwnd)
    except Exception:
        return None


@register("moveWindow")
def move_window(args: Dict[str, Any]) -> Dict[str, Any]:
    title = args.get("title") or args.get("application")
    if not title:
        raise ToolError("Parameter 'title' or 'application' is required.")
    if platform.system() != "Windows":
        raise ToolError("moveWindow is only supported on Windows.")
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
    hwnd = _find_window_by_title(str(title))
    if not hwnd:
        raise ToolError(f"No visible window matching '{title}'.")
    left = int(args.get("x") or args.get("left") or 100)
    top = int(args.get("y") or args.get("top") or 100)
    rect = _window_rect(hwnd)
    width = int(args.get("width") or (rect[2] - rect[0] if rect else 800))
    height = int(args.get("height") or (rect[3] - rect[1] if rect else 600))
    _show_window(hwnd, SW_RESTORE)
    win32gui.MoveWindow(hwnd, left, top, width, height, True)
    new_rect = _window_rect(hwnd)
    verified = bool(new_rect) and int(new_rect[0]) == left and int(new_rect[1]) == top
    return {
        "result": f"Moved {title}." if verified else f"Requested move for {title}.",
        "window": {"hwnd": hwnd, "title": str(title)},
        "bounds": {"left": left, "top": top, "width": width, "height": height},
        "verified": verified,
        "verification": "VERIFIED" if verified else "UNCERTAIN",
        "observed": {"rect": new_rect},
    }


@register("resizeWindow")
def resize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    title = args.get("title") or args.get("application")
    if not title:
        raise ToolError("Parameter 'title' or 'application' is required.")
    if platform.system() != "Windows":
        raise ToolError("resizeWindow is only supported on Windows.")
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
    hwnd = _find_window_by_title(str(title))
    if not hwnd:
        raise ToolError(f"No visible window matching '{title}'.")
    rect = _window_rect(hwnd)
    left = int(args.get("x") or args.get("left") or (rect[0] if rect else 100))
    top = int(args.get("y") or args.get("top") or (rect[1] if rect else 100))
    width = int(args.get("width") or args.get("w") or 800)
    height = int(args.get("height") or args.get("h") or 600)
    _show_window(hwnd, SW_RESTORE)
    win32gui.MoveWindow(hwnd, left, top, width, height, True)
    new_rect = _window_rect(hwnd)
    verified = bool(new_rect) and (int(new_rect[2]) - int(new_rect[0]) == width) and (int(new_rect[3]) - int(new_rect[1]) == height)
    return {
        "result": f"Resized {title}." if verified else f"Requested resize for {title}.",
        "window": {"hwnd": hwnd, "title": str(title)},
        "bounds": {"left": left, "top": top, "width": width, "height": height},
        "verified": verified,
        "verification": "VERIFIED" if verified else "UNCERTAIN",
        "observed": {"rect": new_rect},
    }


@register("showDesktop")
def show_desktop(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        import pyautogui

        pyautogui.hotkey("win", "d")
        return {"result": "Showed the desktop."}
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Could not show desktop: {exc}")


@register("restartExplorer")
def restart_explorer(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("Restarting File Explorer is only supported on Windows.")
    subprocess.run(["taskkill", "/F", "/IM", "explorer.exe"], capture_output=True, check=False)
    subprocess.Popen(["explorer.exe"], close_fds=True)
    return {"result": "Restarted File Explorer."}


@register("turnOffDisplay")
def turn_off_display(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("Turning off the display is only supported on Windows.")
    ctypes.windll.user32.SendMessageW(0xFFFF, 0x0112, 0xF170, 2)
    return {"result": "Turned off the display."}
