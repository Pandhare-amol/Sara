import unittest
from unittest.mock import patch

from desktop_agent.tools_youtube import youtube_play


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
        with patch.dict("desktop_agent.tools_youtube.TOOLS", handlers, clear=True):
            result = await youtube_play({"query": "Python tutorial"})

        self.assertTrue(result["verified"])
        self.assertEqual([call[0] for call in calls], ["search", "links", "open", "media"])
        self.assertEqual(calls[2][1]["url"], "https://www.youtube.com/watch?v=abc123")


if __name__ == "__main__":
    unittest.main()
