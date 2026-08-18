import unittest

from desktop_agent.app_resolver import resolve_windows_application, resolve_windows_folder
from desktop_agent.tool_result import make_tool_result
from desktop_agent import tools_applications as apps
from desktop_agent import tools_windows as wins


class DesktopReliabilityTest(unittest.TestCase):
    def test_settings_routes_to_windows_settings(self) -> None:
        self.assertEqual(resolve_windows_application("settings")["launch"], "ms-settings:")
        self.assertEqual(resolve_windows_application("windows settings")["launch"], "ms-settings:")
        folder, kind = resolve_windows_folder("settings")
        self.assertIsNone(folder)
        self.assertEqual(kind, "windows-app")

    def test_settings_folder_routes_as_filesystem_folder(self) -> None:
        folder, kind = resolve_windows_folder("settings folder")
        self.assertIsNotNone(folder)
        self.assertIn(kind, {"project-relative", "alias-match"})

    def test_tool_result_three_state_contract(self) -> None:
        success = make_tool_result("closeWindow", "SUCCESS", "VERIFIED")
        uncertain = make_tool_result("closeWindow", "SUCCESS", "UNCERTAIN")
        failed = make_tool_result("closeWindow", "FAILED", "UNCERTAIN")
        self.assertEqual(success["status"], "SUCCESS")
        self.assertEqual(uncertain["status"], "UNCERTAIN")
        self.assertEqual(failed["status"], "FAILED")

    def test_open_application_uses_windows_target_resolution(self) -> None:
        resolved = resolve_windows_application("control panel")
        self.assertEqual(resolved["launch"], "control.exe")

        original_resolve_app = apps._resolve_app
        original_is_running = apps._is_running
        original_focus_running = apps._focus_running_app
        original_verify = apps._verify_app_visible
        try:
            apps._resolve_app = lambda name: (_ for _ in ()).throw(apps.ToolError("force windows resolution"))
            apps._is_running = lambda spec: False
            apps._focus_running_app = lambda spec: False
            apps._verify_app_visible = lambda spec, timeout=2.5: True
            res = apps.open_application({"name": "control panel"})
        finally:
            apps._resolve_app = original_resolve_app
            apps._is_running = original_is_running
            apps._focus_running_app = original_focus_running
            apps._verify_app_visible = original_verify
        self.assertEqual(res["verification"], "VERIFIED")
        self.assertEqual(res["result"], "Control Panel opened.")

    def test_close_window_verifies_absence(self) -> None:
        original_resolve = wins._resolve_target
        original_close = wins._close_window_hwnd
        original_find = wins._find_matching_windows
        original_system = wins.platform.system
        original_fg = wins._get_foreground_window
        import sys

        class FakeWin32Gui:
            @staticmethod
            def IsWindow(hwnd):
                return False

            @staticmethod
            def IsWindowVisible(hwnd):
                return False
        try:
            wins._resolve_target = lambda args: (123, "Task Manager")
            wins._close_window_hwnd = lambda hwnd: None
            wins._find_matching_windows = lambda query: []
            wins.platform.system = lambda: "Windows"
            wins._get_foreground_window = lambda: None
            sys.modules["win32gui"] = FakeWin32Gui()
            res = wins.close_window({"title": "Task Manager"})
        finally:
            wins._resolve_target = original_resolve
            wins._close_window_hwnd = original_close
            wins._find_matching_windows = original_find
            wins.platform.system = original_system
            wins._get_foreground_window = original_fg
            sys.modules.pop("win32gui", None)
        self.assertEqual(res["verification"], "VERIFIED")
        self.assertTrue(res["verified"])

    def test_switch_application_verifies_foreground(self) -> None:
        fg_meta = {"title": "WhatsApp - Mozilla Firefox", "application_name": "firefox.exe"}
        original_focus = wins.focus_window
        original_sleep = wins.time.sleep
        original_system = wins.platform.system
        original_fg = wins._get_foreground_window
        original_meta = wins._get_window_metadata
        try:
            wins.focus_window = lambda args: {"result": "Focused", "window": fg_meta, "verification": "UNCERTAIN"}
            wins.time.sleep = lambda *_: None
            wins.platform.system = lambda: "Windows"
            wins._get_foreground_window = lambda: 1
            wins._get_window_metadata = lambda hwnd: fg_meta
            res = wins.switch_application({"application": "Mozilla Firefox"})
        finally:
            wins.focus_window = original_focus
            wins.time.sleep = original_sleep
            wins.platform.system = original_system
            wins._get_foreground_window = original_fg
            wins._get_window_metadata = original_meta
        self.assertEqual(res["verification"], "VERIFIED")


if __name__ == "__main__":
    unittest.main()
