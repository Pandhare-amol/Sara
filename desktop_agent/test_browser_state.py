import unittest

from .browser_state import BrowserStateManager
from . import tools_browser


class FakePage:
    url = "https://example.com"

    def __init__(self):
        self.handlers = {}

    def on(self, name, handler):
        self.handlers[name] = handler

    async def title(self):
        return "Example"


class BrowserStateManagerTest(unittest.TestCase):
    def test_attached_page_has_authoritative_snapshot(self):
        page = FakePage()
        manager = BrowserStateManager("test-session")

        state = manager.attach_page(page)
        manager.update_media(page, {"paused": False, "currentTime": 1.2, "duration": 10})
        snapshot = manager.snapshot(page)

        self.assertEqual(state.session_id, "test-session")
        self.assertEqual(snapshot["url"], "https://example.com")
        self.assertFalse(snapshot["media_state"]["paused"])
        self.assertEqual(snapshot["last_event"], "media_state_changed")

    def test_browser_media_state_tool_returns_live_media_snapshot(self):
        page = FakePage()
        tools_browser.STATE.browser_state = BrowserStateManager("verify-session")
        tools_browser.STATE.page = page
        tools_browser.STATE.browser_state.attach_page(page)
        tools_browser.STATE.browser_state.update_media(page, {
            "paused": False,
            "currentTime": 12.5,
            "duration": 120,
            "readyState": 4,
            "ended": False,
            "muted": False,
        })

        result = tools_browser.browser_media_state({})

        self.assertTrue(result["ok"])
        self.assertEqual(result["media_state"]["currentTime"], 12.5)
        self.assertFalse(result["media_state"]["paused"])
        self.assertEqual(result["state"]["media_state"]["currentTime"], 12.5)


if __name__ == "__main__":
    unittest.main()