from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from desktop_agent import tools_browser


class FakePage:
    def __init__(self, url: str = "about:blank", closed: bool = False) -> None:
        self.url = url
        self.closed = closed
        self.handlers = {}

    def is_closed(self) -> bool:
        return self.closed

    def on(self, event: str, handler) -> None:
        self.handlers.setdefault(event, []).append(handler)


class FakeBrowser:
    def __init__(self, connected: bool = True) -> None:
        self.connected = connected
        self.close_calls = 0

    def is_connected(self) -> bool:
        return self.connected

    async def close(self) -> None:
        self.close_calls += 1
        self.connected = False


class FakeContext:
    def __init__(self, pages=None, browser=None) -> None:
        self.pages = list(pages or [])
        self.browser = browser
        self.handlers = {}
        self.close_calls = 0
        self.launch_calls = []

    def on(self, event: str, handler) -> None:
        self.handlers.setdefault(event, []).append(handler)

    async def new_page(self) -> FakePage:
        page = FakePage("about:blank")
        self.pages.append(page)
        return page

    async def close(self) -> None:
        self.close_calls += 1


class FakeBrowserState:
    def __init__(self) -> None:
        self.attached = []
        self.media = {}

    def attach_page(self, page) -> None:
        self.attached.append(page)

    def update_media(self, page, state) -> None:
        self.media = dict(state)

    def snapshot(self, page=None):
        return {"media_state": dict(self.media)}


class FakeState:
    def __init__(self, *, playwright=None, browser=None, context=None, page=None, browser_state=None) -> None:
        self.playwright = playwright
        self.browser = browser
        self.context = context
        self.page = page
        self.browser_state = browser_state

    def reset_playwright(self) -> None:
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.browser_state = None


class FakeChromium:
    def __init__(self, context) -> None:
        self.context = context
        self.launch_calls = []

    async def launch_persistent_context(self, *args, **kwargs):
        self.launch_calls.append((args, kwargs))
        return self.context


class FakePlaywright:
    def __init__(self, context=None) -> None:
        self.chromium = FakeChromium(context)
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


class FakeLocator:
    @property
    def first(self):
        return self

    async def count(self) -> int:
        return 0

    async def is_visible(self) -> bool:
        return False

    async def get_attribute(self, _name: str):
        return None

    async def click(self, **_kwargs) -> None:
        raise RuntimeError("No clickable controls in test page")


class FakeMediaPage:
    def __init__(self, *, will_play: bool) -> None:
        self.url = "https://www.youtube.com/watch?v=test"
        self.will_play = will_play
        self.media = {
            "found": True,
            "paused": True,
            "currentTime": 0.0,
            "muted": False,
            "volume": 1.0,
            "duration": 12.0,
            "readyState": 2,
            "ended": False,
            "fullscreen": False,
        }

    async def wait_for_selector(self, *_args, **_kwargs) -> None:
        return None

    def locator(self, _selector: str) -> FakeLocator:
        return FakeLocator()

    async def evaluate(self, script: str, *_args):
        if "v.play()" in script:
            return True
        return dict(self.media)

    async def wait_for_function(self, *_args, **_kwargs) -> None:
        if not self.will_play:
            raise TimeoutError("playback remained paused")
        self.media["paused"] = False
        self.media["currentTime"] = 0.25


class BrowserReliabilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_closed_active_page_uses_another_live_tab_without_closing_profile(self):
        closed = FakePage("https://example.com/closed", closed=True)
        live = FakePage("https://example.com/live")
        context = FakeContext([closed, live])
        browser = FakeBrowser()
        browser_state = FakeBrowserState()
        state = FakeState(
            playwright=object(),
            browser=browser,
            context=context,
            page=closed,
            browser_state=browser_state,
        )

        with patch.object(tools_browser, "STATE", state):
            page = await tools_browser._ensure_browser_async()

        self.assertIs(page, live)
        self.assertEqual(context.close_calls, 0)
        self.assertTrue(browser.is_connected())

    async def test_persistent_context_is_reused_when_browser_handle_is_none(self):
        live = FakePage("https://example.com")
        context = FakeContext([live], browser=None)
        state = FakeState(playwright=object(), context=context, page=live, browser_state=FakeBrowserState())

        with patch.object(tools_browser, "STATE", state):
            page = await tools_browser._ensure_browser_async()

        self.assertIs(page, live)
        self.assertIs(state.context, context)

    async def test_disconnected_browser_is_closed_before_persistent_profile_relaunch(self):
        old_context = FakeContext([FakePage("https://example.com")])
        old_browser = FakeBrowser(connected=False)
        old_playwright = FakePlaywright()
        state = FakeState(
            playwright=old_playwright,
            browser=old_browser,
            context=old_context,
            page=old_context.pages[0],
            browser_state=FakeBrowserState(),
        )
        new_browser = FakeBrowser(connected=True)
        new_context = FakeContext([], browser=new_browser)
        new_playwright = FakePlaywright(new_context)

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(tools_browser, "STATE", state), \
                    patch.object(tools_browser, "USER_DATA_DIR", str(Path(temp_dir) / "profile")), \
                    patch.object(tools_browser, "_start_playwright_async", new=AsyncMock(return_value=new_playwright)):
                page = await tools_browser._ensure_browser_async()

        self.assertTrue(old_context.close_calls)
        self.assertTrue(old_playwright.stopped)
        self.assertIs(state.context, new_context)
        self.assertIs(state.browser, new_browser)
        self.assertIs(page, new_context.pages[0])
        self.assertTrue(new_playwright.chromium.launch_calls)

    def test_shutdown_closes_context_even_without_browser_handle(self):
        context = FakeContext([FakePage("https://example.com")])
        playwright = FakePlaywright()
        state = FakeState(playwright=playwright, context=context, browser=None)

        def run_coroutine(coroutine):
            return asyncio.run(coroutine)

        with patch.object(tools_browser, "STATE", state), \
                patch.object(tools_browser, "_run", side_effect=run_coroutine):
            tools_browser.shutdown_browser()

        self.assertEqual(context.close_calls, 1)
        self.assertTrue(playwright.stopped)
        self.assertIsNone(state.context)
        self.assertIsNone(state.playwright)

    async def test_play_action_does_not_claim_success_while_media_is_paused(self):
        page = FakeMediaPage(will_play=False)
        state = FakeState(browser_state=FakeBrowserState())

        with patch.object(tools_browser, "STATE", state), \
                patch.object(tools_browser, "_page", new=AsyncMock(return_value=page)):
            result = await tools_browser.browser_media({"action": "play"})

        self.assertFalse(result["verified"])
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["media_state"]["paused"])

    async def test_play_action_verifies_advancing_media(self):
        page = FakeMediaPage(will_play=True)
        state = FakeState(browser_state=FakeBrowserState())

        with patch.object(tools_browser, "STATE", state), \
                patch.object(tools_browser, "_page", new=AsyncMock(return_value=page)):
            result = await tools_browser.browser_media({"action": "play"})

        self.assertTrue(result["verified"])
        self.assertFalse(result["media_state"]["paused"])
        self.assertGreater(result["media_state"]["currentTime"], 0)


if __name__ == "__main__":
    unittest.main()
