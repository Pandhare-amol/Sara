"""
Application control: launch and close common Windows applications.

Launch strategy is layered for robustness:
  1. Try a known executable / shell verb (fastest, most reliable).
  2. Fall back to the Windows "where"/App Paths lookup via `start`.

Closing uses taskkill on the matching process image name, with a graceful
grace period so apps can save work.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from typing import Any, Dict

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


def _launch(spec: Dict[str, str]) -> None:
    try:
        if "exe" in spec:
            exe = spec["exe"]
            if shutil.which(exe) or exe.lower().endswith(".exe"):
                # Detached so we don't block the agent.
                subprocess.Popen(
                    [exe],
                    shell=False,
                    close_fds=True,
                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                )
            else:
                # e.g. `code.cmd` lives in PATH; rely on shell resolution.
                subprocess.Popen(f'start "" "{exe}"', shell=True, close_fds=True)
        elif "shell" in spec:
            subprocess.Popen(
                f'start "" {spec["shell"]}', shell=True, close_fds=True
            )
        elif "uwp" in spec:
            subprocess.Popen(
                f'start "" {spec["uwp"]}', shell=True, close_fds=True
            )
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
            return {"result": f"{spec['label']} is already running and was focused.", "status": "SUCCESS", "verified": True, "running": True, "focused": True}
        return {
            "result": f"{spec['label']} is running, but Windows did not allow SARA to focus its window.",
            "status": "UNCERTAIN",
            "verified": False,
            "error_code": "WINDOW_FOCUS_DENIED",
            "retryable": True,
        }
    _launch(spec)
    verification = _wait_for_application(spec, float(args.get("timeout", 8.0)))
    if verification["status"] == "SUCCESS":
        return {"result": f"{spec['label']} opened and its window was focused.", **verification}
    return {"result": f"{spec['label']} launch was attempted, but the application state could not be verified.", **verification}


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application")
    force = bool(args.get("force", False))
    kill = bool(args.get("kill", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    try:
        spec = _resolve_app(str(name))
    except ToolError:
        return _close_universal_application(str(name), force=force or kill)
    image = spec["image"]
    try:
        if kill or force:
            subprocess.run(
                f'taskkill /F /IM "{image}"',
                shell=True,
                capture_output=True,
                timeout=10,
            )
            time.sleep(0.2)
            return {"result": f"Force-closed {spec['label']}"}

        subprocess.run(
            f'taskkill /IM "{image}"',
            shell=True,
            capture_output=True,
            timeout=10,
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close {spec['label']}: {e}") from e
    # Give the OS a moment to actually tear it down.
    time.sleep(0.2)
    return {"result": f"Closed {spec['label']}"}



def _close_universal_application(name: str, force: bool = False) -> Dict[str, Any]:
    if psutil is None:
        raise ToolError("Universal application close requires the optional 'psutil' package.")
    low = name.strip().lower()
    matches = []
    for proc in psutil.process_iter(["pid", "name", "exe"]):
        proc_name = str(proc.info.get("name") or "")
        exe = str(proc.info.get("exe") or "")
        haystack = f"{proc_name} {exe}".lower()
        if low and low in haystack:
            matches.append(proc)
    if not matches:
        raise ToolError(f"No running application matched '{name}'.")
    closed = []
    for proc in matches[:10]:
        try:
            if force:
                proc.kill()
            else:
                proc.terminate()
            closed.append(proc.info.get("name") or str(proc.pid))
        except Exception:
            continue
    if not closed:
        raise ToolError(f"Could not close any process matching '{name}'.")
    return {"result": f"Closed {len(closed)} process(es) matching {name}.", "closed": closed, "universal": True}


@register("openAnyApplication")
def open_any_application(args: Dict[str, Any]) -> Dict[str, Any]:
    return open_application(args)


@register("closeAnyApplication")
def close_any_application(args: Dict[str, Any]) -> Dict[str, Any]:
    return close_application(args)

__all__ = ["open_application", "close_application", "open_any_application", "close_any_application", "APP_COMMANDS"]



