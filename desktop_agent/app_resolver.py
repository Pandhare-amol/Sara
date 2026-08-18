from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

HOME = Path(os.path.expanduser("~"))
PROJECT_ROOT = Path.cwd()

ALIASES = {
    "task manager": "taskmgr.exe",
    "taskmgr": "taskmgr.exe",
    "control panel": "control.exe",
    "windows settings": "ms-settings:",
    "calculator": "calc.exe",
    "notepad": "notepad.exe",
    "file explorer": "explorer.exe",
    "explorer": "explorer.exe",
    "command prompt": "cmd.exe",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "settings": "ms-settings:",
}

WINDOWS_TARGETS: Dict[str, Dict[str, str]] = {
    "control panel": {"display": "Control Panel", "launch": "control.exe", "kind": "shell"},
    "task manager": {"display": "Task Manager", "launch": "taskmgr.exe", "kind": "exe"},
    "settings": {"display": "Windows Settings", "launch": "ms-settings:", "kind": "uri"},
    "calculator": {"display": "Calculator", "launch": "calc.exe", "kind": "exe"},
    "notepad": {"display": "Notepad", "launch": "notepad.exe", "kind": "exe"},
    "file explorer": {"display": "File Explorer", "launch": "explorer.exe", "kind": "exe"},
    "command prompt": {"display": "Command Prompt", "launch": "cmd.exe", "kind": "exe"},
    "powershell": {"display": "PowerShell", "launch": "powershell.exe", "kind": "exe"},
    "paint": {"display": "Paint", "launch": "mspaint.exe", "kind": "exe"},
    "device manager": {"display": "Device Manager", "launch": "devmgmt.msc", "kind": "shell"},
    "services": {"display": "Services", "launch": "services.msc", "kind": "shell"},
    "registry editor": {"display": "Registry Editor", "launch": "regedit.exe", "kind": "exe"},
    "windows security": {"display": "Windows Security", "launch": "windowsdefender:", "kind": "uri"},
    "network connections": {"display": "Network Connections", "launch": "ncpa.cpl", "kind": "shell"},
    "task scheduler": {"display": "Task Scheduler", "launch": "taskschd.msc", "kind": "shell"},
}

SPECIAL_FOLDER_ALIASES: Dict[str, Path] = {
    "desktop": HOME / "Desktop",
    "documents": HOME / "Documents",
    "downloads": HOME / "Downloads",
    "pictures": HOME / "Pictures",
    "videos": HOME / "Videos",
    "music": HOME / "Music",
    "home": HOME,
    "appdata": Path(os.environ.get("APPDATA") or (HOME / "AppData" / "Roaming")),
    "localappdata": Path(os.environ.get("LOCALAPPDATA") or (HOME / "AppData" / "Local")),
    "programfiles": Path(os.environ.get("ProgramFiles") or r"C:\Program Files"),
    "programfilesx86": Path(os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"),
    "windows": Path(os.environ.get("WINDIR") or r"C:\Windows"),
    "system32": Path(os.environ.get("WINDIR") or r"C:\Windows") / "System32",
    "temp": Path(os.environ.get("TEMP") or os.environ.get("TMP") or str(Path.cwd())),
    "project": PROJECT_ROOT,
    "sara project": PROJECT_ROOT,
}


def resolve_windows_application(name: str) -> Dict[str, str]:
    low = (name or "").strip().lower()
    if not low:
        return {"display": "", "launch": "", "kind": "unknown"}
    if low in WINDOWS_TARGETS:
        return dict(WINDOWS_TARGETS[low])
    for key, spec in WINDOWS_TARGETS.items():
        if key in low:
            return dict(spec)
    for key, exe in ALIASES.items():
        if key == low or key in low:
            return {"display": key.title(), "launch": exe, "kind": "alias"}
    return {"display": name.strip(), "launch": name.strip(), "kind": "unknown"}


def resolve_windows_folder(name_or_path: str) -> Tuple[Optional[Path], str]:
    raw = str(name_or_path or "").strip()
    if not raw:
        return None, "empty"
    low = raw.lower()
    if low in WINDOWS_TARGETS:
        return None, "windows-app"
    if any(alias in low for alias in ("window settings", "windows settings")) and "folder" not in low:
        return None, "windows-app"
    if raw.startswith("\\\\") or (len(raw) >= 2 and raw[1] == ":"):
        return Path(raw).expanduser().resolve(), "absolute"
    if low in SPECIAL_FOLDER_ALIASES:
        return SPECIAL_FOLDER_ALIASES[low].resolve(), "alias"
    for key, path in SPECIAL_FOLDER_ALIASES.items():
        if key in low:
            return path.resolve(), "alias-match"
    return (PROJECT_ROOT / raw).resolve(), "project-relative"


def resolve_application(name: str) -> Tuple[str, str]:
    """Resolve a user-provided application name to (display_name, executable_or_uri).
    Returns normalized display name and the executable/URI to launch.
    """
    if not name:
        return ("", "")
    resolved = resolve_windows_application(name)
    return (resolved["display"] or name.strip(), resolved["launch"] or name.strip())
