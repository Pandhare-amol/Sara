"""Authoritative, event-driven state for the automation browser."""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional


@dataclass
class BrowserState:
    session_id: str
    browser_id: str
    page_id: str
    url: str = "about:blank"
    title: str = ""
    loading: bool = False
    ready: bool = False
    navigation_state: str = "idle"
    active_element: Optional[str] = None
    media_state: Dict[str, Any] = field(default_factory=dict)
    download_state: Dict[str, Any] = field(default_factory=dict)
    authentication_state: str = "unknown"
    error_state: Optional[Dict[str, Any]] = None
    last_event: str = "created"
    timestamp: float = field(default_factory=time.time)

    def snapshot(self) -> Dict[str, Any]:
        return asdict(self)


class BrowserStateManager:
    """Tracks actual Playwright state; it never uses screen pixels as evidence."""

    def __init__(self, session_id: str = "sara-browser-session") -> None:
        self.session_id = session_id
        self._states: Dict[str, BrowserState] = {}
        self._page_ids: Dict[int, str] = {}
        self._counter = 0

    def _page_id(self, page: Any) -> str:
        key = id(page)
        if key not in self._page_ids:
            self._counter += 1
            self._page_ids[key] = f"page-{self._counter}"
        return self._page_ids[key]

    def attach_page(self, page: Any) -> BrowserState:
        page_id = self._page_id(page)
        state = self._states.get(page_id)
        if state is None:
            state = BrowserState(
                session_id=self.session_id,
                browser_id="automation-browser",
                page_id=page_id,
                url=getattr(page, "url", "about:blank") or "about:blank",
            )
            self._states[page_id] = state
            page.on("domcontentloaded", lambda: self._schedule(self._loaded(page, "domcontentloaded")))
            page.on("load", lambda: self._schedule(self._loaded(page, "load")))
            page.on("framenavigated", lambda frame: self._schedule(self._navigated(page, frame)))
            page.on("request", lambda request: self.record_request(page, request))
            page.on("console", lambda message: self.record_console(page, message))
            page.on("pageerror", lambda error: self._record_error(page, "PAGE_ERROR", str(error)))
            page.on("crash", lambda: self._record_error(page, "PAGE_CRASH", "Page crashed"))
            page.on("download", lambda download: self._schedule(self._downloaded(page, download)))
        return state

    def _schedule(self, coroutine: Any) -> None:
        try:
            asyncio.create_task(coroutine)
        except RuntimeError:
            coroutine.close()

    def _get(self, page: Any) -> Optional[BrowserState]:
        return self._states.get(self._page_id(page))

    async def _loaded(self, page: Any, event: str) -> None:
        state = self._get(page)
        if state is None:
            return
        state.url = page.url
        try:
            state.title = await page.title()
        except Exception:
            state.title = ""
        state.loading = False
        state.ready = True
        state.navigation_state = "complete"
        state.last_event = event
        state.timestamp = time.time()

    async def _navigated(self, page: Any, frame: Any) -> None:
        if getattr(frame, "parent_frame", None) is not None:
            return
        state = self._get(page)
        if state is not None:
            state.url = page.url
            state.loading = True
            state.ready = False
            state.navigation_state = "started"
            state.last_event = "navigation_started"
            state.timestamp = time.time()

    async def _downloaded(self, page: Any, download: Any) -> None:
        state = self._get(page)
        if state is not None:
            state.download_state = {"suggested_filename": download.suggested_filename}
            state.last_event = "download_started"
            state.timestamp = time.time()

    def _record_error(self, page: Any, code: str, message: str) -> None:
        state = self._get(page)
        if state is not None:
            state.error_state = {"code": code, "message": message}
            state.last_event = code.lower()
            state.timestamp = time.time()

    def record_request(self, page: Any, request: Any) -> None:
        if not getattr(request, "is_navigation_request", False):
            return
        state = self._get(page)
        if state is not None:
            state.loading = True
            state.ready = False
            state.navigation_state = "started"
            state.last_event = "navigation_started"
            state.timestamp = time.time()

    def record_console(self, page: Any, message: Any) -> None:
        if getattr(message, "type", "") == "error":
            self._record_error(page, "CONSOLE_ERROR", getattr(message, "text", "Console error"))

    def update_media(self, page: Any, media_state: Dict[str, Any]) -> None:
        state = self.attach_page(page)
        state.media_state = dict(media_state)
        state.last_event = "media_state_changed"
        state.timestamp = time.time()

    def snapshot(self, page: Any = None) -> Dict[str, Any]:
        if page is not None:
            self.attach_page(page)
            return self._states[self._page_id(page)].snapshot()
        return {page_id: state.snapshot() for page_id, state in self._states.items()}