"""
Application control: launch common Windows applications and request safe closes.

Launch strategy is layered for robustness. Closing only sends WM_CLOSE to
visible windows of a specifically recognized app; SARA never terminates or
force-kills a process when Windows declines a graceful close.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

try:
    import psutil
except Exception:  # noqa: BLE001
    psutil = None

from .registry import ToolError, register
from .tools_windows import SW_RESTORE, _find_window_by_title, _focus, _show_window

# Canonical app key -> (launch_command, kind)
#   kind == "exe"   : launch_command is the executable name (resolved via PATH/App Paths)
#   kind == "shell" : launch_command is a shell builtin verb run with cmd /c
#   kind == "uwp"   : launch_command is an apps-family activation string
APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "notepad": {"exe": "notepad.exe", "image": "notepad.exe", "label": "Notepad"},
    "chrome": {"exe": "chrome.exe", "image": "chrome.exe", "label": "Google Chrome"},
    "edge": {"exe": "msedge.exe", "image": "msedge.exe", "label": "Microsoft Edge"},
    "firefox": {"exe": "firefox.exe", "image": "firefox.exe", "label": "Firefox"},
    "brave": {"exe": "brave.exe", "image": "brave.exe", "label": "Brave Browser"},
    "vscode": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "calculator": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "calc": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "file explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "task manager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "taskmanager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "command prompt": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "cmd": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "powershell": {"exe": "powershell.exe", "image": "powershell.exe", "label": "PowerShell"},
    "wordpad": {"shell": "write", "image": "wordpad.exe", "label": "WordPad"},
    "paint": {"shell": "mspaint", "image": "mspaint.exe", "label": "Paint"},
    "snipping tool": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
    "whatsapp": {"uwp": "whatsapp:", "image": "WhatsApp.exe", "label": "WhatsApp"},
    "zoom": {"exe": "zoom.exe", "image": "zoom.exe", "label": "Zoom"},
    "discord": {"exe": "Discord.exe", "image": "Discord.exe", "label": "Discord"},
    "slack": {"exe": "slack.exe", "image": "slack.exe", "label": "Slack"},
    "teams": {"exe": "teams.exe", "image": "Teams.exe", "label": "Microsoft Teams"},
    "spotify": {"exe": "spotify.exe", "image": "Spotify.exe", "label": "Spotify"},
    "word": {"exe": "WINWORD.EXE", "image": "WINWORD.EXE", "label": "Word"},
    "excel": {"exe": "EXCEL.EXE", "image": "EXCEL.EXE", "label": "Excel"},
    "powerpoint": {"exe": "POWERPNT.EXE", "image": "POWERPNT.EXE", "label": "PowerPoint"},
    "onenote": {"exe": "ONENOTE.EXE", "image": "ONENOTE.EXE", "label": "OneNote"},
    "camera": {"uwp": "microsoft.windows.camera:", "image": "WindowsCamera.exe", "label": "Camera"},
    "thunderbird": {"exe": "thunderbird.exe", "image": "thunderbird.exe", "label": "Thunderbird"},
    "visual studio": {"exe": "devenv.exe", "image": "devenv.exe", "label": "Visual Studio"},
    "pycharm": {"exe": "pycharm64.exe", "image": "pycharm64.exe", "label": "PyCharm"},
    "github desktop": {"exe": "GitHubDesktop.exe", "image": "GitHubDesktop.exe", "label": "GitHub Desktop"},
    "docker desktop": {"exe": "Docker Desktop.exe", "image": "Docker Desktop.exe", "label": "Docker Desktop"},
    "libreoffice": {"exe": "soffice.exe", "image": "soffice.bin", "label": "LibreOffice"},
    "vlc": {"exe": "vlc.exe", "image": "vlc.exe", "label": "VLC"},
    "obsidian": {"exe": "Obsidian.exe", "image": "Obsidian.exe", "label": "Obsidian"},
}

# In-memory ownership records only. No process is eligible for task cleanup
# unless SARA started it during an explicitly auto-close-enabled task.
_AUTO_CLOSE_LAUNCHES: Dict[str, List[Dict[str, Any]]] = {}
_AUTO_CLOSE_LOCK = threading.Lock()


def _is_safe_universal_app_name(value: str) -> bool:
    if not value or len(value) > 160:
        return False
    return not bool(re.search(r'[&|<>^]', value))


def _universal_launch(name: str) -> None:
    if not _is_safe_universal_app_name(name):
        raise ToolError("Application name contains unsupported shell characters.")
    if os.name == "nt":
        subprocess.Popen(["cmd", "/c", "start", "", name], close_fds=True)
        return
    subprocess.Popen([name], close_fds=True)
def _resolve_app(key: str) -> Dict[str, str]:
    norm = (key or "").strip().lower()
    if norm in APP_COMMANDS:
        return APP_COMMANDS[norm]
    # Allow loose aliases (e.g. "code", "visual studio code").
    aliases = {
        "code": "vscode",
        "visual studio code": "vscode",
        "vs code": "vscode",
        "google chrome": "chrome",
        "microsoft edge": "edge",
        "firefox browser": "firefox",
        "brave browser": "brave",
        "calc": "calculator",
        "settings app": "settings",
        "file explorer": "file explorer",
        "windows explorer": "file explorer",
        "whatsapp desktop": "whatsapp",
        "whatsapp web": "whatsapp",
        "microsoft teams": "teams",
        "ms teams": "teams",
        "word 365": "word",
        "excel 365": "excel",
        "power point": "powerpoint",
        "mozilla thunderbird": "thunderbird",
        "vs": "visual studio",
        "githubdesktop": "github desktop",
        "docker": "docker desktop",
        "libre office": "libreoffice",
        "vlc player": "vlc",
    }
    if norm in aliases and aliases[norm] in APP_COMMANDS:
        return APP_COMMANDS[aliases[norm]]
    raise ToolError(
        f"Unrecognized application '{key}'. Supported: "
        f"{', '.join(sorted({v['label'] for v in APP_COMMANDS.values()}))}."
    )


def _is_windows_platform() -> bool:
    return os.name == "nt"


def _launch_windows_target(target: str) -> None:
    """Ask the Windows shell to resolve PATH/App Paths/UWP targets."""
    startfile = getattr(os, "startfile", None)
    if callable(startfile):
        try:
            startfile(target)
            return
        except OSError:
            # App Paths and protocol handlers are not available for every
            # command; try the Windows `start` resolver as a fallback.
            pass
    subprocess.Popen(["cmd", "/c", "start", "", target], close_fds=True)


def _launch(spec: Dict[str, str]) -> None:
    try:
        if "exe" in spec:
            exe = spec["exe"]
            resolved = shutil.which(exe)
            extension = os.path.splitext(exe)[1].lower()

            if _is_windows_platform() and extension in {".cmd", ".bat"}:
                _launch_windows_target(resolved or exe)
            elif resolved:
                # Launch the resolved executable path rather than relying on
                # CreateProcess to find an app that is not actually on PATH.
                subprocess.Popen(
                    [resolved],
                    shell=False,
                    close_fds=True,
                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                )
            elif _is_windows_platform():
                # Apps such as Chrome are commonly registered in Windows App
                # Paths/Start Menu but intentionally absent from the process PATH.
                _launch_windows_target(exe)
            else:
                raise FileNotFoundError(f"'{exe}' was not found on PATH.")
        elif "shell" in spec:
            if _is_windows_platform():
                _launch_windows_target(spec["shell"])
            else:
                subprocess.Popen([spec["shell"]], close_fds=True)
        elif "uwp" in spec:
            if _is_windows_platform():
                _launch_windows_target(spec["uwp"])
            else:
                raise ToolError("UWP applications are supported only on Windows.")
        else:
            raise ToolError(f"App spec for {spec.get('label')} is incomplete.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not launch {spec.get('label')}: {e}") from e


def _is_running(spec: Dict[str, str]) -> bool:
    image = (spec.get("image") or "").lower()
    if not image or psutil is None:
        return False
    try:
        for proc in psutil.process_iter(["name"]):
            proc_name = (proc.info.get("name") or "").lower()
            if proc_name == image.lower() or proc_name in {image.lower(), image.lower().replace(".exe", "")}:
                return True
    except Exception:
        return False
    return False


def _matching_process_instances(spec: Dict[str, str]) -> List[Dict[str, Any]]:
    """Return exact process identities for one supported app image."""
    if psutil is None:
        return []
    expected = str(spec.get("image") or "").casefold()
    if not expected:
        return []
    matches: List[Dict[str, Any]] = []
    try:
        for proc in psutil.process_iter(["pid", "name", "create_time"]):
            try:
                info = proc.info
                name = str(info.get("name") or "")
                created_at = info.get("create_time")
                if name.casefold() not in {expected, expected.removesuffix(".exe")} or created_at is None:
                    continue
                matches.append({
                    "pid": int(info.get("pid") or proc.pid),
                    "name": name,
                    "create_time": float(created_at),
                })
            except Exception:  # noqa: BLE001 - inaccessible processes are not eligible
                continue
    except Exception:  # noqa: BLE001
        return []
    return matches


def _windows_for_process(pid: int) -> Optional[List[Dict[str, Any]]]:
    """Enumerate visible top-level windows for exactly one PID; None means unavailable."""
    if not _is_windows_platform():
        return None
    try:
        import win32gui
    except Exception:  # noqa: BLE001
        return None

    windows: List[Dict[str, Any]] = []

    def collect(hwnd: int, _extra: Any) -> None:
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            owner_pid = int(win32gui.GetWindowThreadProcessId(hwnd)[1])
            if owner_pid == int(pid):
                windows.append({"hwnd": int(hwnd), "title": str(win32gui.GetWindowText(hwnd) or "")})
        except Exception:  # noqa: BLE001
            return

    try:
        win32gui.EnumWindows(collect, None)
    except Exception:  # noqa: BLE001
        return None
    return windows


def _track_new_app_windows(
    task_id: str,
    spec: Dict[str, str],
    before: List[Dict[str, Any]],
    launched_at: float,
) -> List[Dict[str, Any]]:
    """Track only new, visible windows launched inside an opted-in task."""
    if not task_id or psutil is None:
        return []
    existing_pids = {int(item["pid"]) for item in before if item.get("pid") is not None}
    tracked: List[Dict[str, Any]] = []
    for process in _matching_process_instances(spec):
        pid = int(process["pid"])
        if pid in existing_pids or process["create_time"] < launched_at - 1.0:
            continue
        windows = _windows_for_process(pid)
        if not windows:
            # A process without a visible, attributable window is not safe to close.
            continue
        tracked.append({
            "pid": pid,
            "name": process["name"],
            "create_time": process["create_time"],
            "windows": windows,
        })

    if tracked:
        with _AUTO_CLOSE_LOCK:
            records = _AUTO_CLOSE_LAUNCHES.setdefault(task_id, [])
            known = {int(item.get("pid", -1)) for item in records}
            records.extend(item for item in tracked if int(item["pid"]) not in known)
    return tracked


def _record_task_tracking_gap(task_id: str, application: str, reason: str) -> None:
    if not task_id:
        return
    with _AUTO_CLOSE_LOCK:
        _AUTO_CLOSE_LAUNCHES.setdefault(task_id, []).append({
            "application": application,
            "tracking_error": reason,
        })


def _discard_task_app_tracking(task_id: str) -> None:
    if not task_id:
        return
    with _AUTO_CLOSE_LOCK:
        _AUTO_CLOSE_LAUNCHES.pop(task_id, None)


def _request_window_close(hwnd: int) -> bool:
    """Send one graceful WM_CLOSE; this helper never terminates a process."""
    try:
        import win32con
        import win32gui

        win32gui.PostMessage(int(hwnd), win32con.WM_CLOSE, 0, 0)
        return True
    except Exception:  # noqa: BLE001
        return False


def _close_recorded_windows(pid: int, recorded_windows: List[Dict[str, Any]], timeout: float = 3.0) -> Dict[str, Any]:
    """Close only the window handles captured at launch, never newer windows."""
    initial = _windows_for_process(pid)
    if initial is None:
        return {"closed": False, "reason": "Windows window inspection is unavailable; the app was left open."}
    original_handles = {int(item["hwnd"]) for item in recorded_windows if item.get("hwnd") is not None}
    current_handles = {int(item["hwnd"]) for item in initial if item.get("hwnd") is not None}
    new_handles = current_handles - original_handles
    if new_handles:
        return {"closed": False, "reason": "A new app window appeared after launch; it was left open to avoid closing user work or an unsaved-work prompt."}
    active_originals = current_handles & original_handles
    if not active_originals:
        return {"closed": True, "reason": "The tracked app window was already closed."}

    for hwnd in sorted(active_originals):
        _request_window_close(hwnd)

    deadline = time.monotonic() + max(0.1, min(timeout, 5.0))
    while time.monotonic() < deadline:
        time.sleep(0.1)
        current = _windows_for_process(pid)
        if current is None:
            return {"closed": False, "reason": "Windows stopped reporting window state; the app was left open."}
        current_handles = {int(item["hwnd"]) for item in current if item.get("hwnd") is not None}
        new_handles = current_handles - original_handles
        if new_handles:
            return {"closed": False, "reason": "A dialog or new app window appeared during graceful close; it was left open for review."}
        if not (current_handles & original_handles):
            return {"closed": True, "reason": "The tracked app window closed gracefully."}

    return {"closed": False, "reason": "Windows did not close the tracked window after a graceful request; it was left open."}


def _focus_running_app(spec: Dict[str, str]) -> bool:
    label = spec.get("label", "")
    target_candidates = [label, label.lower(), spec.get("image", "")]
    for candidate in target_candidates:
        if not candidate:
            continue
        hwnd = _find_window_by_title(str(candidate))
        if hwnd:
            try:
                _show_window(hwnd, SW_RESTORE)
                _focus(hwnd)
                return True
            except ToolError:
                # Foreground activation can be denied by Windows focus rules.
                # Do not launch a duplicate process when the app is already running.
                continue
    return False


def _wait_for_application(spec: Dict[str, str], timeout: float = 8.0) -> Dict[str, Any]:
    deadline = time.monotonic() + max(0.5, min(timeout, 30.0))
    while time.monotonic() < deadline:
        running = _is_running(spec)
        focused = _focus_running_app(spec) if running else False
        if running and focused:
            return {"status": "SUCCESS", "verified": True, "running": True, "focused": True}
        time.sleep(0.2)
    running = _is_running(spec)
    return {
        "status": "UNCERTAIN" if running else "FAILED",
        "verified": False,
        "running": running,
        "focused": False,
        "error_code": "WINDOW_FOCUS_DENIED" if running else "APPLICATION_NOT_STARTED",
    }


@register("openApplication")
def open_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application")
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    try:
        spec = _resolve_app(str(name))
    except ToolError:
        _universal_launch(str(name))
        return {
            "result": f"Windows was asked to open {name}, but SARA could not verify its application identity.",
            "universal": True,
            "status": "UNCERTAIN",
            "verified": False,
            "error_code": "APPLICATION_IDENTITY_UNKNOWN",
        }
    if _is_running(spec):
        if _focus_running_app(spec):
            return {
                "ok": True,
                "result": f"{spec['label']} is already running and was focused.",
                "status": "SUCCESS",
                "verified": True,
                "running": True,
                "focused": True,
                "launched_by_sara": False,
                "opened_target_only": True,
                "auto_close_tracked": False,
            }
        return {
            "ok": False,
            "result": f"{spec['label']} is running, but Windows did not allow SARA to focus its window.",
            "status": "UNCERTAIN",
            "verified": False,
            "launched_by_sara": False,
            "opened_target_only": True,
            "auto_close_tracked": False,
            "error_code": "WINDOW_FOCUS_DENIED",
            "retryable": True,
        }

    before = _matching_process_instances(spec)
    launched_at = time.time()
    _launch(spec)
    verification = _wait_for_application(spec, float(args.get("timeout", 8.0)))
    if verification["status"] == "SUCCESS":
        task_id = str(args.get("automation_task_id") or args.get("taskId") or "").strip()
        auto_close_requested = args.get("auto_close_after_task") is True
        tracking_requested = auto_close_requested and bool(task_id)
        tracked = _track_new_app_windows(task_id, spec, before, launched_at) if tracking_requested else []
        tracking_error = None
        if tracking_requested and not tracked:
            tracking_error = "SARA started the app but could not safely attribute a new visible window to this task; it was left open."
            _record_task_tracking_gap(task_id, spec["label"], tracking_error)
        return {
            "ok": True,
            "result": f"{spec['label']} opened and its window was focused.",
            **verification,
            "launched_by_sara": True,
            "opened_target_only": True,
            "auto_close_tracked": bool(tracked),
            "auto_close_tracking_error": tracking_error,
            "automation_task_id": task_id if auto_close_requested else None,
        }
    return {
        "ok": False,
        "result": f"{spec['label']} launch was attempted, but the application state could not be verified.",
        **verification,
        "launched_by_sara": True,
        "auto_close_tracked": False,
    }


def _close_visible_app_windows(spec: Dict[str, str], timeout: float = 3.0) -> Dict[str, Any]:
    """Gracefully close visible windows for one recognized app; never kill a process."""
    if psutil is None or not _is_windows_platform():
        return {
            "ok": False,
            "status": "left_open",
            "verified": False,
            "error_code": "SAFE_WINDOW_CLOSE_UNAVAILABLE",
            "closed": [],
            "left_open": [{"application": spec.get("label", "Application"), "reason": "Safe Windows window inspection is unavailable; the app was left open."}],
            "result": "SARA could not safely inspect the app window and left it open; no process was terminated.",
        }

    instances = _matching_process_instances(spec)
    if not instances:
        return {
            "ok": True,
            "status": "not_running",
            "verified": True,
            "closed": [],
            "left_open": [],
            "result": f"{spec['label']} has no matching running process.",
        }

    visible_instances: List[Dict[str, Any]] = []
    for instance in instances:
        windows = _windows_for_process(int(instance["pid"]))
        if windows is None:
            return {
                "ok": False,
                "status": "left_open",
                "verified": False,
                "error_code": "WINDOW_INSPECTION_UNAVAILABLE",
                "closed": [],
                "left_open": [{"application": spec["label"], "pid": instance["pid"], "reason": "Windows window inspection failed; the app was left open."}],
                "result": f"SARA could not safely inspect {spec['label']} and left it open; no process was terminated.",
            }
        if windows:
            visible_instances.append({**instance, "windows": windows})

    if not visible_instances:
        return {
            "ok": False,
            "status": "left_open",
            "verified": False,
            "error_code": "NO_VISIBLE_APP_WINDOW",
            "closed": [],
            "left_open": [{"application": spec["label"], "reason": "The process is running without a visible app window; SARA left it untouched."}],
            "result": f"{spec['label']} is running without a visible window. SARA left it untouched; no process was terminated.",
        }

    closed: List[Dict[str, Any]] = []
    left_open: List[Dict[str, Any]] = []
    for instance in visible_instances:
        pid = int(instance["pid"])
        close_result = _close_recorded_windows(pid, instance["windows"], timeout=timeout)
        if close_result.get("closed") is True:
            closed.append({"application": spec["label"], "pid": pid, "window_closed": True, "reason": close_result.get("reason")})
        else:
            left_open.append({"application": spec["label"], "pid": pid, "reason": close_result.get("reason") or "Windows did not verify a graceful close; the app was left open."})
            # A save prompt or other new window requires the user to handle it.
            break

    verified = not left_open and bool(closed)
    return {
        "ok": verified,
        "status": "completed" if verified else "left_open",
        "verified": verified,
        "closed": closed,
        "left_open": left_open,
        "error_code": None if verified else "GRACEFUL_CLOSE_NOT_VERIFIED",
        "result": (
            f"Closed {len(closed)} visible {spec['label']} window(s) gracefully and verified the window state. No process was terminated."
            if verified
            else f"SARA could not verify a graceful close for {spec['label']}. The app was left open for review; no process was terminated."
        ),
    }


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application")
    force = bool(args.get("force", False) or args.get("kill", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    if force:
        return {
            "ok": False,
            "status": "blocked",
            "verified": False,
            "requires_confirmation": True,
            "error_code": "FORCE_CLOSE_DISABLED",
            "result": f"SARA will not force-terminate {name}. If Windows blocks a graceful close or shows an unsaved-work prompt, the app must be left open for review.",
        }
    try:
        spec = _resolve_app(str(name))
    except ToolError:
        return {
            "ok": False,
            "status": "blocked",
            "verified": False,
            "requires_confirmation": False,
            "error_code": "UNKNOWN_APPLICATION_UNTOUCHED",
            "result": f"SARA could not safely identify '{name}' in the supported app list and left all processes untouched. Close it manually or choose a recognized app name.",
        }
    return _close_visible_app_windows(spec)


@register("closeLaunchedApplications")
def close_launched_applications(args: Dict[str, Any]) -> Dict[str, Any]:
    """Gracefully close only the windows SARA started for one task."""
    task_id = str(args.get("automation_task_id") or args.get("taskId") or "").strip()
    if not task_id:
        raise ToolError("Parameter 'automation_task_id' is required for task-scoped cleanup.")

    with _AUTO_CLOSE_LOCK:
        instances = _AUTO_CLOSE_LAUNCHES.pop(task_id, [])
    if not instances:
        return {
            "ok": True,
            "status": "completed",
            "verified": True,
            "closed": [],
            "left_open": [],
            "result": "No newly launched SARA-owned app windows were eligible for cleanup.",
        }

    if not _is_windows_platform() or psutil is None:
        left_open = [
            {
                "application": item.get("application") or item.get("name"),
                "pid": item.get("pid"),
                "reason": item.get("tracking_error") or "Safe Windows process/window inspection is unavailable.",
            }
            for item in instances
        ]
        return {
            "ok": False,
            "status": "left_open",
            "verified": False,
            "closed": [],
            "left_open": left_open,
            "error_code": "SAFE_WINDOW_CLOSE_UNAVAILABLE",
            "result": "SARA could not verify the owned app windows and left them open; no process was terminated.",
        }

    closed: List[Dict[str, Any]] = []
    left_open: List[Dict[str, Any]] = []
    for instance in instances:
        if instance.get("tracking_error"):
            left_open.append({
                "application": instance.get("application") or "Application",
                "pid": instance.get("pid"),
                "reason": str(instance["tracking_error"]),
            })
            continue
        pid = int(instance.get("pid") or 0)
        expected_name = str(instance.get("name") or "")
        try:
            process = psutil.Process(pid)
            actual_name = str(process.name() or "")
            actual_created = float(process.create_time())
            running = bool(process.is_running())
        except Exception as exc:  # noqa: BLE001
            # A process that exited between task completion and cleanup needs no close.
            if type(exc).__name__ in {"NoSuchProcess", "ZombieProcess"}:
                closed.append({"application": expected_name, "pid": pid, "window_closed": True, "process_exited": True})
            else:
                left_open.append({"application": expected_name, "pid": pid, "reason": "Could not verify the process identity; it was left untouched."})
            continue

        same_instance = (
            actual_name.casefold() == expected_name.casefold()
            and abs(actual_created - float(instance.get("create_time") or 0.0)) <= 1.0
        )
        if not same_instance:
            left_open.append({"application": expected_name, "pid": pid, "reason": "The process identity changed; it was left untouched."})
            continue
        if not running:
            closed.append({"application": expected_name, "pid": pid, "window_closed": True, "process_exited": True})
            continue

        result = _close_recorded_windows(pid, instance.get("windows") or [])
        if result.get("closed") is True:
            exit_deadline = time.monotonic() + 1.5
            still_running = True
            while time.monotonic() < exit_deadline:
                try:
                    still_running = bool(process.is_running())
                except Exception:  # noqa: BLE001
                    still_running = True
                if not still_running:
                    break
                time.sleep(0.1)
            if still_running:
                left_open.append({
                    "application": expected_name,
                    "pid": pid,
                    "reason": "The tracked window closed, but its process remains alive; this could be background work or an unsaved-work dialog. SARA left it untouched.",
                })
            else:
                closed.append({
                    "application": expected_name,
                    "pid": pid,
                    "window_closed": True,
                    "process_left_running": False,
                    "reason": result.get("reason"),
                })
        else:
            left_open.append({
                "application": expected_name,
                "pid": pid,
                "reason": result.get("reason") or "Windows did not confirm a graceful close.",
            })

    verified = not left_open
    return {
        "ok": verified,
        "status": "completed" if verified else "left_open",
        "verified": verified,
        "closed": closed,
        "left_open": left_open,
        "error_code": None if verified else "GRACEFUL_CLOSE_NOT_VERIFIED",
        "result": (
            f"Gracefully closed {len(closed)} task-owned app window(s); no process was force-terminated."
            if verified
            else f"SARA could not safely close {len(left_open)} task-owned app window(s). They were left open for review; no process was force-terminated."
        ),
    }


def _close_universal_application(name: str, force: bool = False) -> Dict[str, Any]:
    """Retained for compatibility, but unknown process matches are never terminated."""
    return {
        "ok": False,
        "status": "blocked",
        "verified": False,
        "error_code": "UNKNOWN_APPLICATION_UNTOUCHED",
        "result": f"SARA could not safely identify '{name}' as a supported application and left all processes untouched.",
    }


@register("openAnyApplication")
def open_any_application(args: Dict[str, Any]) -> Dict[str, Any]:
    return open_application(args)


@register("closeAnyApplication")
def close_any_application(args: Dict[str, Any]) -> Dict[str, Any]:
    return close_application(args)

__all__ = ["open_application", "close_application", "close_launched_applications", "open_any_application", "close_any_application", "APP_COMMANDS"]



