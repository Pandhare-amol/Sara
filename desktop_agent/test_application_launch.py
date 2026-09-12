import unittest
from unittest.mock import patch

from desktop_agent.tools_applications import _wait_for_application


class ApplicationLaunchTest(unittest.TestCase):
    def test_wait_reports_success_only_when_running_and_focused(self):
        spec = {"label": "Test App", "image": "test.exe"}
        with patch("desktop_agent.tools_applications._is_running", return_value=True), \
                patch("desktop_agent.tools_applications._focus_running_app", return_value=True):
            result = _wait_for_application(spec, timeout=0.5)

        self.assertEqual(result["status"], "SUCCESS")
        self.assertTrue(result["verified"])

    def test_wait_reports_failure_when_process_never_starts(self):
        spec = {"label": "Missing App", "image": "missing.exe"}
        with patch("desktop_agent.tools_applications._is_running", return_value=False), \
                patch("time.sleep"):
            result = _wait_for_application(spec, timeout=0.5)

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["error_code"], "APPLICATION_NOT_STARTED")


if __name__ == "__main__":
    unittest.main()