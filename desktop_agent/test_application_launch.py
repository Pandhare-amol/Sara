import unittest
from unittest.mock import patch

from desktop_agent.tools_applications import _launch, _wait_for_application


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

    def test_unresolved_windows_executable_uses_shell_app_path_resolution(self):
        spec = {"label": "Google Chrome", "exe": "chrome.exe"}
        with patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications.shutil.which", return_value=None), \
                patch("desktop_agent.tools_applications._launch_windows_target") as shell_launch:
            _launch(spec)

        shell_launch.assert_called_once_with("chrome.exe")

    def test_windows_command_script_uses_shell_even_when_resolved(self):
        spec = {"label": "Visual Studio Code", "exe": "code.cmd"}
        with patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications.shutil.which", return_value=r"C:\Tools\code.cmd"), \
                patch("desktop_agent.tools_applications._launch_windows_target") as shell_launch:
            _launch(spec)

        shell_launch.assert_called_once_with(r"C:\Tools\code.cmd")


if __name__ == "__main__":
    unittest.main()
