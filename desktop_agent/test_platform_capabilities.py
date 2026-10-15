import unittest

from desktop_agent.platform_capabilities import build_platform_capabilities


class PlatformCapabilityReportingTests(unittest.TestCase):
    def test_linux_reports_registered_tools_and_windows_limitations(self):
        payload = build_platform_capabilities(
            "Linux",
            ["desktopBrowserOpen", "takeScreenshot", "mouseMove", "createFile"],
        )
        self.assertEqual(payload["host_platform"], "Linux")
        self.assertFalse(payload["capabilities"]["desktop"])
        self.assertTrue(payload["capabilities"]["browser"])
        self.assertTrue(payload["capabilities"]["screen"])
        self.assertIn("mouseMove", payload["capabilities"]["platform_limited_tools"])
        self.assertTrue(payload["capabilities"]["runtime_check_required"])

    def test_windows_reports_no_windows_only_tools_as_limited(self):
        payload = build_platform_capabilities("Windows", ["mouseMove", "desktopBrowserOpen"])
        self.assertTrue(payload["capabilities"]["desktop"])
        self.assertEqual(payload["capabilities"]["platform_limited_tools"], [])
        self.assertEqual(payload["capabilities"]["browser_tools"], ["desktopBrowserOpen"])


if __name__ == "__main__":
    unittest.main()
