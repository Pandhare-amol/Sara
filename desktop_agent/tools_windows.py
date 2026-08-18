"""
Window management: minimize / maximize / close the active window or switch apps.

Uses win32gui for the foreground window and pygetwindow for title-based lookups,
with graceful degradation if a backend isn't present.
"""

from __future__ import annotations

import platform
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register

SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SW_HIDE = 0


def _get_foreground_window():
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        return hwnd
    except Exception:
        return None


def _window_title(hwnd) -> str:
    try:
        import win32gui

        return win32gui.GetWindowText(hwnd)
    except Exception:
        return ""


def _show_window(hwnd, cmd) -> None:
    try:
        import win32gui

        win32gui.ShowWindow(hwnd, cmd)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not change window state: {e}")


def _close_window_hwnd(hwnd) -> None:
    try:
        import win32con
        import win32gui

        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close window: {e}")


def _find_window_by_title(query: str):
    """Return the hwnd of the first window whose title contains query."""
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        matches = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title and query.lower() in title.lower():
                    matches.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return matches[0] if matches else None
    except Exception:
        return None


def _focus(hwnd) -> None:
    try:
        import win32gui
        import win32process
        import win32con

        fg = win32gui.GetForegroundWindow()
        if fg and fg != hwnd:
            try:
                fg_thread, _ = win32process.GetWindowThreadProcessId(fg)
                target_thread, _ = win32process.GetWindowThreadProcessId(hwnd)
                if fg_thread and target_thread and fg_thread != target_thread:
                    win32process.AttachThreadInput(fg_thread, target_thread, True)
                    try:
                        win32gui.BringWindowToTop(hwnd)
                        win32gui.SetActiveWindow(hwnd)
                        win32gui.SetForegroundWindow(hwnd)
                    finally:
                        win32process.AttachThreadInput(fg_thread, target_thread, False)
                else:
                    win32gui.BringWindowToTop(hwnd)
                    win32gui.SetForegroundWindow(hwnd)
            except Exception:
                win32gui.ShowWindow(hwnd, SW_RESTORE)
                win32gui.BringWindowToTop(hwnd)
                win32gui.SetForegroundWindow(hwnd)
        else:
            win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
    except Exception:
        # Restore first, then try again
        _show_window(hwnd, SW_RESTORE)
        time.sleep(0.1)
        try:
            import win32gui
            import win32process

            fg = win32gui.GetForegroundWindow()
            if fg and fg != hwnd:
                try:
                    fg_thread, _ = win32process.GetWindowThreadProcessId(fg)
                    target_thread, _ = win32process.GetWindowThreadProcessId(hwnd)
                    if fg_thread and target_thread and fg_thread != target_thread:
                        win32process.AttachThreadInput(fg_thread, target_thread, True)
                        try:
                            win32gui.BringWindowToTop(hwnd)
                            win32gui.SetForegroundWindow(hwnd)
                        finally:
                            win32process.AttachThreadInput(fg_thread, target_thread, False)
                    else:
                        win32gui.BringWindowToTop(hwnd)
                        win32gui.SetForegroundWindow(hwnd)
                except Exception:
                    win32gui.BringWindowToTop(hwnd)
                    win32gui.SetForegroundWindow(hwnd)
            else:
                win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not focus window: {e}")


def _resolve_target(args: Dict[str, Any]):
    """Pick the hwnd to operate on: explicit title, or the foreground window."""
    title: Optional[str] = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window with title containing '{title}'.")
        return hwnd, str(title)
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    return hwnd, _window_title(hwnd)

def _get_window_metadata(hwnd):
    if platform.system() != "Windows":
        return None
    try:
        import win32gui
        import win32process
        import psutil
        
        if not win32gui.IsWindow(hwnd):
            return None

        title = win32gui.GetWindowText(hwnd)
        rect = win32gui.GetWindowRect(hwnd) # (left, top, right, bottom)
        bounds = {"left": rect[0], "top": rect[1], "right": rect[2], "bottom": rect[3]}
        
        pid = 0
        process_name = ""
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid > 0:
                p = psutil.Process(pid)
                process_name = p.name()
        except Exception:
            pass

        state = "visible" if win32gui.IsWindowVisible(hwnd) else "hidden"
        
        return {
            "hwnd": hwnd,
            "title": title,
            "process_id": pid,
            "application_name": process_name,
            "bounds": bounds,
            "state": state
        }
    except Exception:
        return None


def _window_state(hwnd) -> Dict[str, Any]:
    if platform.system() != "Windows":
        return {"exists": False, "visible": False, "iconic": False, "zoomed": False}
    try:
        import win32gui

        return {
            "exists": bool(win32gui.IsWindow(hwnd)),
            "visible": bool(win32gui.IsWindowVisible(hwnd)),
            "iconic": bool(win32gui.IsIconic(hwnd)),
            "zoomed": bool(win32gui.IsZoomed(hwnd)),
        }
    except Exception:
        return {"exists": False, "visible": False, "iconic": False, "zoomed": False}


def _verify_foreground_matches(query: str, retries: int = 3, delay: float = 0.1) -> Optional[Dict[str, Any]]:
    if platform.system() != "Windows":
        return None
    try:
        import win32gui
    except Exception:
        return None
    q = str(query or "").strip().lower()
    for _ in range(retries):
        active = _get_foreground_window()
        meta = _get_window_metadata(active) if active else None
        if meta and _window_matches_query(meta, q):
            return meta
        time.sleep(delay)
    active = _get_foreground_window()
    return _get_window_metadata(active) if active else None


def _window_matches_query(meta: Dict[str, Any], query: str) -> bool:
    q = str(query or "").strip().lower()
    if not q:
        return False
    title = str(meta.get("title") or "").lower()
    app = str(meta.get("application_name") or "").lower()
    return q in title or q in app or q == app.replace(".exe", "")


def _find_matching_windows(query: str) -> list:
    if platform.system() != "Windows":
        return []
    try:
        import win32gui
    except Exception:
        return []
    matches = []

    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            meta = _get_window_metadata(hwnd)
            if meta and _window_matches_query(meta, query):
                matches.append(meta)
        return True

    try:
        win32gui.EnumWindows(cb, None)
    except Exception:
        return []
    return matches

@register("listWindows")
def list_windows(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("listWindows is only supported on Windows.")
    
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
        
    windows = []
    
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd)
            if title: # Only include windows with titles
                meta = _get_window_metadata(hwnd)
                if meta:
                    windows.append(meta)
        return True
        
    win32gui.EnumWindows(cb, None)
    return {"result": f"Found {len(windows)} visible windows.", "windows": windows}

@register("getActiveWindow")
def get_active_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    meta = _get_window_metadata(hwnd)
    if not meta:
        raise ToolError("Could not retrieve active window metadata.")
    
    return {"result": f"Active window is '{meta['title']}'.", "window": meta}

@register("focusWindow")
def focus_window(args: Dict[str, Any]) -> Dict[str, Any]:
    target = str(args.get("application") or args.get("title") or "")
    if not target:
        raise ToolError("Must provide 'application' or 'title' to focus.")
    
    if platform.system() != "Windows":
        raise ToolError("focusWindow is only supported on Windows.")
    
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
        
    matches = []
    
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            meta = _get_window_metadata(hwnd)
            if meta and meta["title"]:
                title = meta["title"].lower()
                app = meta["application_name"].lower()
                q = target.lower()
                
                # Check if it matches title or process name
                if q in title or q in app or q == app.replace(".exe", ""):
                    matches.append(meta)
        return True
        
    win32gui.EnumWindows(cb, None)
    
    if not matches:
        raise ToolError(f"Target '{target}' is not running or has no visible windows.")
        
    # Heuristic: pick the one where target is exact app name, or exact title, else first
    q = target.lower()
    best_match = None
    for m in matches:
        app = m["application_name"].lower()
        title = m["title"].lower()
        if q == app.replace(".exe", "") or q == title:
            best_match = m
            break
            
    if not best_match:
        best_match = matches[0]
        
    hwnd = best_match["hwnd"]
    _show_window(hwnd, SW_RESTORE)
    _focus(hwnd)
    
    # Wait a tiny bit to let OS apply focus
    time.sleep(0.2)
    fg = win32gui.GetForegroundWindow()
    if fg != hwnd:
        return {"result": f"Attempted to focus '{best_match['title']}', but it may not be in foreground.", "window": best_match}
        
    return {"result": f"Focused window: '{best_match['title']}'.", "window": best_match}

@register("minimizeOtherWindows")
def minimize_other_windows(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("minimizeOtherWindows is only supported on Windows.")
        
    # Focus the target first
    focus_res = focus_window(args)
    target_hwnd = focus_res.get("window", {}).get("hwnd")
    
    if not target_hwnd:
        return focus_res
        
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
        
    minimized_count = 0
    def cb(hwnd, _):
        nonlocal minimized_count
        if hwnd != target_hwnd and win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
            meta = _get_window_metadata(hwnd)
            if meta:
                app = meta.get("application_name", "").lower()
                # Don't minimize essential shell windows
                if app not in ["explorer.exe", "searchapp.exe", "shellexperiencehost.exe", "applicationframehost.exe"]:
                    _show_window(hwnd, SW_MINIMIZE)
                    minimized_count += 1
        return True
        
    win32gui.EnumWindows(cb, None)
    
    # Ensure target is still focused
    _show_window(target_hwnd, SW_RESTORE)
    _focus(target_hwnd)
    
    return {"result": f"Focused '{focus_res['window']['title']}' and minimized {minimized_count} other windows.", "window": focus_res["window"]}

@register("showDesktop")
def show_desktop(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("showDesktop is only supported on Windows.")
    
    try:
        import win32gui
    except ImportError:
        raise ToolError("win32gui is not available.")
        
    minimized = 0
    def cb(hwnd, _):
        nonlocal minimized
        if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
            meta = _get_window_metadata(hwnd)
            if meta:
                app = meta.get("application_name", "").lower()
                if app not in ["explorer.exe", "searchapp.exe", "shellexperiencehost.exe", "applicationframehost.exe"]:
                    _show_window(hwnd, SW_MINIMIZE)
                    minimized += 1
        return True
        
    win32gui.EnumWindows(cb, None)
    
    return {"result": f"Showed desktop. Minimized {minimized} windows."}


@register("minimizeWindow")
def minimize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MINIMIZE)
    time.sleep(0.15)
    state = _window_state(hwnd)
    verified = bool(state.get("iconic")) or not bool(state.get("visible"))
    return {"result": f"Minimized window: {title or 'active window'}." if verified else f"Requested minimize for window: {title or 'active window'}.", "window_state": state, "verified": verified, "verification": "VERIFIED" if verified else "UNCERTAIN"}


@register("maximizeWindow")
def maximize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MAXIMIZE)
    time.sleep(0.15)
    state = _window_state(hwnd)
    verified = bool(state.get("zoomed"))
    return {"result": f"Maximized window: {title or 'active window'}." if verified else f"Requested maximize for window: {title or 'active window'}.", "window_state": state, "verified": verified, "verification": "VERIFIED" if verified else "UNCERTAIN"}


@register("closeWindow")
def close_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    meta = _get_window_metadata(hwnd)
    try:
        _close_window_hwnd(hwnd)
    except ToolError:
        # Fallback for elevated/system windows where WM_CLOSE can be blocked.
        try:
            _focus(hwnd)
            time.sleep(0.1)
            import pyautogui

            pyautogui.hotkey("alt", "f4")
        except Exception as e:  # noqa: BLE001
            if meta and meta.get("process_id"):
                try:
                    import psutil

                    proc = psutil.Process(int(meta["process_id"]))
                    proc.terminate()
                    try:
                        proc.wait(timeout=1.5)
                    except Exception:
                        proc.kill()
                except Exception as kill_exc:  # noqa: BLE001
                    raise ToolError(f"Could not close window: {e}") from kill_exc
            else:
                raise ToolError(f"Could not close window: {e}")
    time.sleep(0.35)
    title_query = str(args.get("title") or args.get("application") or title or "")
    remaining = _find_matching_windows(title_query)
    if remaining:
        return {
            "result": f"Requested close for window: {title or 'active window'}.",
            "window": remaining[0],
            "verification": "FAILED",
            "verified": False,
            "remaining": remaining,
        }
    if platform.system() == "Windows":
        try:
            import win32gui
            if win32gui.IsWindow(hwnd) and win32gui.IsWindowVisible(hwnd):
                return {
                    "result": f"Requested close for window: {title or 'active window'}.",
                    "verification": "UNCERTAIN",
                    "verified": False,
                }
        except Exception:
            pass
    return {"result": f"Closed window: {title or 'active window'}.", "verification": "VERIFIED", "verified": True}


@register("switchApplication")
def switch_application(args: Dict[str, Any]) -> Dict[str, Any]:
    """Focus a window by title, or cycle windows (Alt+Tab) if no title given."""
    title = args.get("title") or args.get("application")
    if title:
        # Instead of old logic, we can route it to focus_window for better matching
        try:
            result = focus_window({"application": title})
            time.sleep(0.25)
            meta = _verify_foreground_matches(str(title)) or _get_window_metadata(_get_foreground_window()) if _get_foreground_window() else None
            if meta and _window_matches_query(meta, str(title)):
                result["verification"] = "VERIFIED"
                result["verified"] = True
                return result
            if meta:
                result["verification"] = "FAILED"
                result["verified"] = False
                result["active_window"] = meta
                result["result"] = f"Focused window does not match '{title}'."
                return result
            result["verification"] = "UNCERTAIN"
            result["verified"] = False
            return result
        except ToolError as e:
            raise e

    # No specific title -> Alt+Tab cycle.
    try:
        import pyautogui

        pyautogui.hotkey("alt", "tab")
        return {"result": "Cycled to the next window."}
    except Exception:
        # Fallback: cycle by enumerating windows and focusing the next one.
        if platform.system() == "Windows":
            try:
                import win32gui

                order = []

                def cb(hwnd, _):
                    if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
                        order.append(hwnd)
                    return True

                win32gui.EnumWindows(cb, None)
                fg = win32gui.GetForegroundWindow()
                if order:
                    idx = order.index(fg) if fg in order else -1
                    nxt = order[(idx + 1) % len(order)]
                    _focus(nxt)
                    time.sleep(0.2)
                    active = win32gui.GetForegroundWindow()
                    if active == nxt:
                        return {"result": f"Switched to: {win32gui.GetWindowText(nxt)}.", "verification": "VERIFIED", "verified": True}
                    return {"result": f"Attempted to switch to: {win32gui.GetWindowText(nxt)}.", "verification": "UNCERTAIN", "verified": False}
            except Exception:
                pass
        raise ToolError("Could not switch applications.")


__all__ = [
    "list_windows",
    "get_active_window",
    "focus_window",
    "minimize_other_windows",
    "show_desktop",
    "minimize_window",
    "maximize_window",
    "close_window",
    "switch_application",
]
