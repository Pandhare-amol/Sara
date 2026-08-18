import asyncio
import unittest

from desktop_agent import tools_browser as tb


class _FakeBody:
    def __init__(self, text: str | None):
        self._text = text or ""

    async def count(self) -> int:
        return 1

    async def inner_text(self, timeout: int = 0) -> str:
        return self._text


class _FakeBodyMissing:
    async def count(self) -> int:
        return 0

    async def inner_text(self, timeout: int = 0) -> str:
        raise AssertionError("should not be called")


class _FakePage:
    def __init__(self, url: str, title: str, ready_state: str, text: str | None, closed: bool = False):
        self.url = url
        self._title = title
        self._ready_state = ready_state
        self._text = text
        self._closed = closed

    def is_closed(self) -> bool:
        return self._closed

    async def title(self, timeout: int = 0) -> str:
        return self._title

    async def evaluate(self, expr: str):
        return self._ready_state

    def locator(self, selector: str):
        if self._text is None:
            return _FakeBodyMissing()
        return _FakeBody(self._text)

    async def wait_for_load_state(self, state: str, timeout: int = 0):
        return None


class BrowserReadinessTest(unittest.TestCase):
    def test_whatsapp_state_classification(self) -> None:
        login = {
            "closed": False,
            "url": "https://web.whatsapp.com/",
            "title": "WhatsApp",
            "body_available": True,
            "body_text_sample": "Scan the QR code to link this device",
        }
        loading = {
            "closed": False,
            "url": "https://web.whatsapp.com/",
            "title": "WhatsApp",
            "body_available": True,
            "body_text_sample": "Loading WhatsApp...",
        }
        auth = {
            "closed": False,
            "url": "https://web.whatsapp.com/",
            "title": "WhatsApp",
            "body_available": True,
            "body_text_sample": "Search or start new chat",
        }
        self.assertEqual(tb._whatsapp_state(login), "login_required")
        self.assertEqual(tb._whatsapp_state(loading), "loading_shell")
        self.assertEqual(tb._whatsapp_state(auth), "authenticated_or_readable")

    def test_page_snapshot_handles_body(self) -> None:
        page = _FakePage("https://web.whatsapp.com/", "WhatsApp", "interactive", "Search or start new chat")
        snap = asyncio.run(tb._page_snapshot(page))
        self.assertTrue(snap["body_available"])
        self.assertEqual(snap["url"], "https://web.whatsapp.com/")
        self.assertEqual(snap["title"], "WhatsApp")
        self.assertGreater(snap["body_text_length"], 0)

    def test_read_page_returns_uncertain_without_body(self) -> None:
        async def _fake_page():
            return _FakePage("https://web.whatsapp.com/", "WhatsApp", "loading", None)

        original = tb._page
        try:
            tb._page = _fake_page  # type: ignore[assignment]
            res = asyncio.run(tb.browser_read_page({"max_chars": 200}))
        finally:
            tb._page = original  # type: ignore[assignment]
        self.assertEqual(res["verification"], "UNCERTAIN")
        self.assertFalse(res["verified"])


if __name__ == "__main__":
    unittest.main()
