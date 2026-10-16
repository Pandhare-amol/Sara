import unittest
from unittest.mock import AsyncMock, Mock, patch

from desktop_agent.tools_youtube import youtube_pause, youtube_play


class YouTubePlaybackTest(unittest.IsolatedAsyncioTestCase):
    async def test_playback_awaits_browser_search_navigation_and_media(self):
        calls = []

        async def search(args):
            calls.append(("search", args))
            return {"ok": True, "url": "https://www.youtube.com/results"}

        async def links(args):
            calls.append(("links", args))
            return {"links": [{"url": "https://www.youtube.com/watch?v=abc123", "text": "Video"}]}

        async def open_page(args):
            calls.append(("open", args))
            return {"ok": True, "url": args["url"]}

        async def media(args):
            calls.append(("media", args))
            return {"ok": True, "verified": True, "verification": "VERIFIED", "media_state": {"paused": False, "currentTime": 1}}

        handlers = {
            "desktopBrowserSearch": search,
            "desktopBrowserExtractLinks": links,
            "desktopBrowserOpen": open_page,
            "desktopBrowserMedia": media,
        }
        with patch.dict("desktop_agent.tools_youtube.TOOLS", handlers, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "automation"), \
                patch("desktop_agent.tools_youtube.MEMORY.remember"):
            result = await youtube_play({"query": "Python tutorial"})

        self.assertTrue(result["verified"])
        self.assertEqual([call[0] for call in calls], ["search", "links", "open", "media"])
        self.assertEqual(calls[2][1]["url"], "https://www.youtube.com/watch?v=abc123")

    async def test_direct_url_is_not_reported_as_playing_when_media_is_paused(self):
        async def open_page(args):
            return {"ok": True, "url": args["url"]}

        async def media(_args):
            return {
                "ok": False,
                "verified": False,
                "media_state": {"paused": True, "currentTime": 0},
            }

        handlers = {"desktopBrowserOpen": open_page, "desktopBrowserMedia": media}
        with patch.dict("desktop_agent.tools_youtube.TOOLS", handlers, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "automation"), \
                patch("desktop_agent.tools_youtube.MEMORY.remember") as remember:
            result = await youtube_play({"url": "https://www.youtube.com/watch?v=abc123"})

        self.assertFalse(result["verified"])
        self.assertEqual(result["error_code"], "PLAYBACK_NOT_VERIFIED")
        remember.assert_not_called()

    async def test_default_browser_open_is_explicitly_unverified(self):
        browser_open = AsyncMock(return_value={"ok": True})
        media = AsyncMock(return_value={"verified": True})
        handlers = {"desktopBrowserOpen": browser_open, "desktopBrowserMedia": media}
        with patch.dict("desktop_agent.tools_youtube.TOOLS", handlers, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "default"), \
                patch("desktop_agent.tools_youtube.open_url", return_value="https://www.youtube.com/watch?v=abc123"):
            result = await youtube_play({"url": "https://www.youtube.com/watch?v=abc123"})

        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["verified"])
        self.assertEqual(result["verification"], "UNVERIFIED")
        self.assertEqual(result["playback_target"], "default_browser")
        browser_open.assert_not_awaited()
        media.assert_not_awaited()

    async def test_default_browser_query_opens_results_without_using_hidden_browser(self):
        browser_search = AsyncMock(return_value={"ok": True})
        with patch.dict("desktop_agent.tools_youtube.TOOLS", {"desktopBrowserSearch": browser_search}, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "default"), \
                patch("desktop_agent.tools_youtube.open_url", return_value="https://www.youtube.com/results?search_query=blue+bird") as open_url:
            result = await youtube_play({"query": "blue bird"})

        self.assertTrue(result["ok"])
        self.assertFalse(result["verified"])
        self.assertEqual(result["playback_target"], "default_browser")
        self.assertIn("results?search_query=blue+bird", result["url"])
        self.assertIn("Select a video", result["result"])
        browser_search.assert_not_awaited()
        open_url.assert_called_once_with("https://www.youtube.com/results?search_query=blue+bird")

    async def test_default_browser_pause_does_not_touch_hidden_automation_page(self):
        media = Mock(return_value={"verified": True})
        with patch.dict("desktop_agent.tools_youtube.TOOLS", {"desktopBrowserMedia": media}, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "default"):
            result = youtube_pause({})

        self.assertFalse(result["verified"])
        self.assertEqual(result["error_code"], "DEFAULT_BROWSER_CONTROL_UNAVAILABLE")
        media.assert_not_called()

    async def test_missing_video_results_returns_failure_without_claiming_playback(self):
        async def search(_args):
            return {"ok": True}

        async def links(_args):
            return {"links": [{"url": "https://www.youtube.com/channel/example", "title": "Channel"}]}

        handlers = {"desktopBrowserSearch": search, "desktopBrowserExtractLinks": links}
        with patch.dict("desktop_agent.tools_youtube.TOOLS", handlers, clear=True), \
                patch("desktop_agent.tools_youtube.YOUTUBE_PLAYBACK_TARGET", "automation"):
            result = await youtube_play({"query": "Python tutorial"})

        self.assertFalse(result["verified"])
        self.assertEqual(result["error_code"], "YOUTUBE_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
