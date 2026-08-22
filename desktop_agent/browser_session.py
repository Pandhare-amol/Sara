"""Persistent browser session ownership for the desktop agent.

This module owns session selection and readiness classification. It deliberately
returns an uncertain result when a real user browser cannot be attached safely;
it never claims that an external browser action completed merely because a
process exists.
"""

from __future__ import annotations

import configparser
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


FIREFOX_EXECUTABLE_CANDIDATES = [
    r"C:\Program Files\Mozilla Firefox\firefox.exe",
    r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
]


@dataclass(frozen=True)
class BrowserProfile:
    name: str
    path: str
    absolute_path: str
    is_default: bool = False
    is_relative: bool = True
    available: bool = True


def _firefox_root() -> Path:
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "Mozilla" / "Firefox"


def _profiles_ini_path() -> Path:
    return _firefox_root() / "profiles.ini"


def detect_profiles(profiles_ini: Optional[Path] = None) -> List[BrowserProfile]:
    ini_path = Path(profiles_ini) if profiles_ini else _profiles_ini_path()
    if not ini_path.exists():
        return []

    parser = configparser.ConfigParser()
    parser.read(ini_path, encoding="utf-8")
    root = ini_path.parent
    profiles: List[BrowserProfile] = []
    for section in parser.sections():
        if not section.lower().startswith("profile"):
            continue
        relative = parser.getint(section, "IsRelative", fallback=1) == 1
        profile_path = parser.get(section, "Path", fallback="").strip()
        if not profile_path:
            continue
        absolute = (root / profile_path).resolve() if relative else Path(profile_path).resolve()
        profiles.append(BrowserProfile(
            name=parser.get(section, "Name", fallback=profile_path),
            path=profile_path,
            absolute_path=str(absolute),
            is_default=parser.getint(section, "Default", fallback=0) == 1,
            is_relative=relative,
            available=absolute.exists(),
        ))
    return profiles


def get_default_profile(profiles_ini: Optional[Path] = None) -> Optional[BrowserProfile]:
    profiles = detect_profiles(profiles_ini)
    return next((profile for profile in profiles if profile.is_default), profiles[0] if profiles else None)


def detect_firefox_installation() -> Dict[str, Any]:
    candidates = list(FIREFOX_EXECUTABLE_CANDIDATES)
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    candidates.append(str(local / "Mozilla" / "Firefox" / "firefox.exe"))
    for candidate in candidates:
        if Path(candidate).exists():
            return {"browser": "firefox", "executable": candidate, "installed": True}
    return {"browser": "firefox", "executable": None, "installed": False}


def is_firefox_running() -> bool:
    try:
        output = subprocess.check_output(["tasklist", "/FI", "IMAGENAME eq firefox.exe"], text=True, stderr=subprocess.DEVNULL)
        return "firefox.exe" in output.lower()
    except (OSError, subprocess.SubprocessError):
        return False


def classify_page_state(page_state: Dict[str, Any], purpose: str = "browser") -> str:
    if page_state.get("closed"):
        return "CLOSED"
    if page_state.get("error") or page_state.get("error_state"):
        return "ERROR"
    text = str(page_state.get("body_text_sample") or "").lower()
    url = str(page_state.get("url") or "").lower()
    if purpose.lower() == "whatsapp" or "whatsapp.com" in url:
        if any(marker in text for marker in ("scan the qr", "link this device", "phone number")):
            return "LOGIN_REQUIRED"
        if any(marker in text for marker in ("search or start new chat", "chats", "communities")):
            return "AUTHENTICATED"
        if not page_state.get("body_available", False) or "loading" in text:
            return "LOADING"
    if any(marker in text for marker in ("inbox", "compose", "signed in", "log out", "logout")):
        return "AUTHENTICATED"
    if not page_state.get("body_available", False):
        return "NOT_READY"
    return "READY"


class BrowserSessionManager:
    """Own one persistent Playwright context and its active page."""

    def __init__(self) -> None:
        self.page: Any = None
        self.context: Any = None
        self.connection: Any = None
        self.browser_mode: str = "SARA_PERSISTENT_BROWSER"
        self._playwright: Any = None

    async def _launch_context(self, *, executable: str, user_data_dir: Path) -> Any:
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self.context = await self._playwright.firefox.launch_persistent_context(
            str(user_data_dir), executable_path=executable, headless=False
        )
        self.connection = "launched"
        self.page = self.context.pages[-1] if self.context.pages else await self.context.new_page()
        return self.context

    async def _page_snapshot(self) -> Dict[str, Any]:
        if self.page is None or self.page.is_closed():
            return {"closed": True}
        try:
            body = self.page.locator("body")
            return {
                "closed": False,
                "url": self.page.url,
                "title": await self.page.title(),
                "body_available": await body.count() > 0,
                "body_text_sample": (await body.inner_text(timeout=3000))[:1000],
            }
        except Exception as exc:  # noqa: BLE001
            return {"closed": False, "url": getattr(self.page, "url", ""), "error": str(exc)}

    async def connect_or_launch(
        self,
        *,
        url: str,
        purpose: str = "browser",
        prefer_real: bool = False,
        allow_fallback: bool = True,
    ) -> Dict[str, Any]:
        if prefer_real:
            installation = detect_firefox_installation()
            if installation["installed"] and is_firefox_running():
                return {
                    "ok": False,
                    "status": "uncertain",
                    "browser_mode": "REAL_USER_BROWSER",
                    "state": "UNATTACHED",
                    "error_code": "REAL_BROWSER_NOT_ATTACHABLE",
                    "error": "Firefox is already running and cannot be attached safely.",
                }
            if not installation["installed"] and not allow_fallback:
                return {
                    "ok": False,
                    "status": "failed",
                    "browser_mode": "REAL_USER_BROWSER",
                    "state": "UNAVAILABLE",
                    "error_code": "BROWSER_NOT_INSTALLED",
                    "error": "Firefox is not installed.",
                }

        if self.page is None or self.page.is_closed():
            installation = detect_firefox_installation()
            executable = str(installation.get("executable") or "firefox")
            profile = get_default_profile()
            user_data_dir = Path(profile.absolute_path) if profile else _firefox_root() / "sara-profile"
            await self._launch_context(executable=executable, user_data_dir=user_data_dir)

        if url and hasattr(self.page, "goto"):
            await self.page.goto(url, wait_until="domcontentloaded", timeout=15000)
        snapshot = await self._page_snapshot()
        state = classify_page_state(snapshot, purpose=purpose)
        return {
            "ok": state not in {"CLOSED", "ERROR", "NOT_READY"},
            "status": "completed" if state not in {"CLOSED", "ERROR", "NOT_READY"} else "failed",
            "browser_mode": self.browser_mode,
            "state": state,
            "page": snapshot,
        }

    async def close(self) -> None:
        if self.context is not None:
            await self.context.close()
        if self._playwright is not None:
            await self._playwright.stop()
        self.page = None
        self.context = None
        self.connection = None
        self._playwright = None
