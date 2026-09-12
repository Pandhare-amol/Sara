import unittest

from desktop_agent.main import _canonical_result


class ScreenshotContractTest(unittest.TestCase):
    def test_screenshot_observation_is_canonical_verified_evidence(self):
        result = _canonical_result("takeScreenshot", {
            "screenshot_id": "screen-test",
            "width": 1366,
            "height": 768,
            "observation": {"width": 1366, "height": 768},
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "SUCCESS")
        self.assertTrue(result["verified"])


if __name__ == "__main__":
    unittest.main()