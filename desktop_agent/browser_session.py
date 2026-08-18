"""Shared browser session manager for SARA browser-driven web apps.

This module prefers a safe Firefox-based persistent session for authenticated
workflows such as WhatsApp Web and email. It never silently claims access to a
user's existing Firefox session if the profile is locked or cannot be safely
reused.
"""

from __future__ import annotations

import configparser
import os
import re
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # pragma: no cover - Windows-only optional dependency
    import psutil  # type: ignore
except Exception:  # pragma: no cover - keep agent alive without psutil
    psutil = None  # type: ignore


FIREFOX_EXECUTABLE_CANDIDATES = [
    r"C:\Program Files\Mozilla Firefox\firefox.exe",
    r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
]


@dataclass
class BrowserProfile:
    name: str
    path: str
    absolute_path: str
    is_default: bool = False
    is_relative: bool = True
    is_locked: bool = False


def _appdata_dir() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")


def _localappdata_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def _firefox_root() -> Path:
    return _appdata_dir() / "Mozilla" / "Firefox"


def _profiles_ini() -> Path:
    return _firefox_root() / "profiles.ini"


def _candidate_executables() -> List[Path]:
    candidates = [Path(p) for p in FIREFOX_EXECUTABLE_CANDIDATES]
    path_entries = [entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry]
    for entry in path_entries:
        candidates.append(Path(entry) / "firefox.exe")
    # Registry-backed installs are common on Windows, but we avoid hard
    # importing winreg on non-Windows hosts during unit tests.
    try:  # pragma: no cover - Windows-specific
        import winreg  # type: ignore

        for hive, subkey in [
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"),
        ]:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    value, _ = winreg.QueryValueEx(key, "")
                    if value:
                        candidates.append(Path(value))
            except Exception:
                pass
    except Exception:
        pass
    return candidates


def detect_firefox_installation() -> Dict[str, Any]:
    for candidate in _candidate_executables():
        if candidate.exists():
            return {"browser": "firefox", "executable": str(candidate), "installed": True}
    return {"browser": "firefox", "executable": "", "installed": False}


def _profile_lock_files(profile_dir: Path) -> List[Path]:
    return [profile_dir / "parent.lock", profile_dir / ".parentlock", profile_dir / "lock"]


def is_profile_locked(profile_dir: Path) -> bool:
    return any(path.exists() for path in _profile_lock_files(profile_dir))


def _resolve_profile_path(profile_path: str, is_relative: bool) -> Path:
    if is_relative:
        return _firefox_root() / profile_path
    return Path(profile_path)


def detect_profiles(profiles_ini: Optional[Path] = None) -> List[BrowserProfile]:
    ini = profiles_ini or _profiles_ini()
    if not ini.exists():
        return []
    parser = configparser.ConfigParser()
    parser.read(ini, encoding="utf-8")
    profiles: List[BrowserProfile] = []
    for section in parser.sections():
        if not section.lower().startswith("profile"):
            continue
        raw_path = parser.get(section, "Path", fallback="").strip()
        is_relative = parser.getboolean(section, "IsRelative", fallback=True)
        is_default = parser.getboolean(section, "Default", fallback=False)
        name = parser.get(section, "Name", fallback=section).strip() or section
        abs_path = _resolve_profile_path(raw_path, is_relative)
        profiles.append(
            BrowserProfile(
                name=name,
                path=raw_path,
                absolute_path=str(abs_path),
                is_default=is_default,
                is_relative=is_relative,
                is_locked=is_profile_locked(abs_path) if abs_path.exists() else False,
            )
        )
    profiles.sort(key=lambda p: (not p.is_default, p.name.lower()))
    return profiles


def get_default_profile(profiles_ini: Optional[Path] = None) -> Optional[BrowserProfile]:
    profiles = detect_profiles(profiles_ini=profiles_ini)
    if not profiles:
        return None
    for profile in profiles:
        if profile.is_default:
            return profile
    return profiles[0]


def is_firefox_running() -> bool:
    if psutil is None:
        return False
    try:
        for proc in psutil.process_iter(["name"]):
            name = str(proc.info.get("name") or "").lower()
            if "firefox" in name:
                return True
    except Exception:
        return False
    return False


def _user_data_dir_for_fallback() -> Path:
    fallback = _localappdata_dir() / "SARA" / "browser-profile" / "firefox"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def classify_page_state(snapshot: Dict[str, Any], *, purpose: str = "whatsapp") -> str:
    if snapshot.get("closed"):
        return "DISCONNECTED"
    url = str(snapshot.get("url") or "").lower()
    title = str(snapshot.get("title") or "").lower()
    text = str(snapshot.get("body_text_sample") or "").lower()
    body_ok = bool(snapshot.get("body_available"))
    if not body_ok and str(snapshot.get("ready_state") or "").lower() in {"loading", "interactive"}:
        return "LOADING"
    if "whatsapp" in url or "whatsapp" in title or "whatsapp" in text:
        if any(marker in text for marker in ("scan the qr code", "link a device", "use whatsapp on your phone")):
            return "LOGIN_REQUIRED"
        if any(marker in text for marker in ("blocked", "not supported", "unsupported", "something went wrong")):
            return "BLOCKED"
        if body_ok and (("chat list" in text) or ("new chat" in text) or ("search" in text)):
            return "AUTHENTICATED"
        return "UNKNOWN" if body_ok else "LOADING"
    if purpose == "email":
        if any(marker in text for marker in ("sign in", "log in", "login", "enter your password")):
            return "LOGIN_REQUIRED"
        if any(marker in text for marker in ("blocked", "suspicious", "not supported", "unable to sign in")):
            return "BLOCKED"
        if body_ok and any(marker in text for marker in ("inbox", "compose", "mail", "new message", "search mail")):
            return "AUTHENTICATED"
        return "UNKNOWN" if body_ok else "LOADING"
    return "UNKNOWN" if body_ok else "LOADING"


class BrowserSessionManager:
    def __init__(self) -> None:
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.browser_mode = "TEST_BROWSER"
        self.profile: Optional[BrowserProfile] = None
        self.profile_source = ""
        self.connection = ""
        self.state = "UNKNOWN"
        self.last_error = ""

    async def _ensure_playwright(self) -> Any:
        if self.playwright is None:
            from playwright.async_api import async_playwright

            self.playwright = await async_playwright().start()
        return self.playwright

    async def _launch_context(self, *, executable: str, user_data_dir: Path) -> Any:
        pw = await self._ensure_playwright()
        self.browser = None
        self.context = await pw.firefox.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            executable_path=executable or None,
            headless=False,
            viewport=None,
            args=["--no-remote"],
        )
        self.page = self.context.pages[-1] if self.context.pages else await self.context.new_page()
        self.connection = "launched"
        return self.context

    def diagnostics(self) -> Dict[str, Any]:
        return {
            "browser": "firefox" if self.profile or self.browser_mode != "TEST_BROWSER" else "chromium",
            "installed": detect_firefox_installation()["installed"],
            "profile": asdict(self.profile) if self.profile else None,
            "profile_source": self.profile_source,
            "running": is_firefox_running(),
            "connection": self.connection,
            "browser_mode": self.browser_mode,
            "state": self.state,
            "last_error": self.last_error,
        }

    async def connect_or_launch(
        self,
        *,
        url: Optional[str] = None,
        purpose: str = "whatsapp",
        prefer_real: bool = True,
        allow_fallback: bool = True,
    ) -> Dict[str, Any]:
        install = detect_firefox_installation()
        profiles = detect_profiles()
        default_profile = get_default_profile()
        running = is_firefox_running()
        self.last_error = ""
        self.profile = default_profile
        self.profile_source = "user_default" if default_profile else ""

        if prefer_real and running and default_profile and default_profile.is_locked:
            self.browser_mode = "REAL_USER_BROWSER"
            self.state = "UNKNOWN"
            self.connection = "blocked"
            self.last_error = "Firefox is running and the default profile is locked; safe attachment is unavailable."
            if not allow_fallback:
                return {
                    "ok": False,
                    "reason": self.last_error,
                    "browser_mode": self.browser_mode,
                    "state": self.state,
                    "connection": self.connection,
                    "installed": install,
                    "profiles": [asdict(p) for p in profiles],
                    "profile": asdict(default_profile),
                    "page": None,
                    "context": None,
                    "diagnostics": self.diagnostics(),
                }

        if prefer_real and not running and install.get("installed") and default_profile:
            user_data_dir = default_profile.absolute_path if default_profile.absolute_path else str(_user_data_dir_for_fallback())
            try:
                await self._launch_context(executable=install.get("executable") or "", user_data_dir=Path(user_data_dir))
                self.browser_mode = "REAL_USER_BROWSER"
                self.connection = "launched"
                self.state = "READY"
                if url:
                    await self.open_url(url, purpose=purpose)
                return await self.snapshot(purpose=purpose)
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)

        if not allow_fallback:
            self.browser_mode = "UNKNOWN"
            self.state = "UNKNOWN"
            self.connection = "blocked"
            return {
                "ok": False,
                "reason": self.last_error or "Fallback disabled.",
                "browser_mode": self.browser_mode,
                "state": self.state,
                "connection": self.connection,
                "installed": install,
                "profiles": [asdict(p) for p in profiles],
                "profile": asdict(default_profile) if default_profile else None,
                "page": None,
                "context": None,
                "diagnostics": self.diagnostics(),
            }

        fallback = _user_data_dir_for_fallback()
        try:
            await self._launch_context(executable=install.get("executable") or "", user_data_dir=fallback)
            self.browser_mode = "SARA_PERSISTENT_BROWSER"
            self.profile_source = "sara_persistent"
            self.connection = "launched"
            self.state = "READY"
            if url:
                await self.open_url(url, purpose=purpose)
            return await self.snapshot(purpose=purpose)
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self.browser_mode = "UNKNOWN"
            self.state = "UNKNOWN"
            self.connection = "failed"
            return {
                "ok": False,
                "reason": self.last_error,
                "browser_mode": self.browser_mode,
                "state": self.state,
                "connection": self.connection,
                "installed": install,
                "profiles": [asdict(p) for p in profiles],
                "profile": asdict(default_profile) if default_profile else None,
                "page": None,
                "context": None,
                "diagnostics": self.diagnostics(),
            }

    async def open_url(self, url: str, *, purpose: str = "whatsapp", timeout_ms: int = 20000) -> Dict[str, Any]:
        if self.page is None:
            raise RuntimeError("Browser session not initialized.")
        try:
            await self.page.goto(url, wait_until="commit", timeout=timeout_ms)
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
        snapshot = await self.snapshot(purpose=purpose)
        snapshot["navigation_error"] = self.last_error or ""
        return snapshot

    async def snapshot(self, *, purpose: str = "whatsapp", max_chars: int = 8000) -> Dict[str, Any]:
        if self.page is None:
            self.state = "DISCONNECTED"
            return {"ok": False, "reason": "No page available.", "browser_mode": self.browser_mode, "state": self.state, "connection": self.connection, "page": None, "context": None, "diagnostics": self.diagnostics()}
        try:
            closed = bool(self.page.is_closed())
        except Exception:
            closed = True
        data: Dict[str, Any] = {
            "ok": not closed,
            "browser_mode": self.browser_mode,
            "page_closed": closed,
            "page": self.page,
            "context": self.context,
            "diagnostics": self.diagnostics(),
        }
        if closed:
            self.state = "DISCONNECTED"
            return data
        try:
            data["url"] = self.page.url
        except Exception as exc:  # noqa: BLE001
            data["url_error"] = str(exc)
        try:
            data["title"] = await self.page.title()
        except Exception as exc:  # noqa: BLE001
            data["title_error"] = str(exc)
        try:
            data["ready_state"] = await self.page.evaluate("() => document.readyState")
        except Exception as exc:  # noqa: BLE001
            data["ready_state_error"] = str(exc)
        try:
            body = self.page.locator("body")
            body_count = await body.count()
            data["body_available"] = body_count > 0
            if body_count:
                text = await body.inner_text(timeout=4000)
                data["body_text_length"] = len(text or "")
                data["body_text_sample"] = (text or "")[:max_chars]
        except Exception as exc:  # noqa: BLE001
            data["body_error"] = str(exc)
            data["body_available"] = False
        data["state"] = classify_page_state(data, purpose=purpose)
        self.state = data["state"]
        return data

    async def close_owned_session(self) -> None:
        try:
            if self.context is not None:
                await self.context.close()
        except Exception:
            pass
        try:
            if self.playwright is not None:
                await self.playwright.stop()
        except Exception:
            pass
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.connection = "closed"
        self.state = "DISCONNECTED"


SESSION_MANAGER = BrowserSessionManager()


def browser_environment_summary() -> Dict[str, Any]:
    install = detect_firefox_installation()
    default_profile = get_default_profile()
    return {
        "installed": install,
        "default_profile": asdict(default_profile) if default_profile else None,
        "running": is_firefox_running(),
        "fallback_profile_dir": str(_user_data_dir_for_fallback()),
    }
