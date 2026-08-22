import unittest

from .browser_state import BrowserStateManager


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


if __name__ == "__main__":
    unittest.main()