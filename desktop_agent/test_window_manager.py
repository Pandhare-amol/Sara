import unittest
from unittest.mock import patch

from desktop_agent.window_manager import WindowManager


class FakeWin32Gui:
    def __init__(self):
        self.active = 2
        self.windows = {
            1: {"title": "Untitled - Notepad", "visible": True, "iconic": False, "zoomed": False, "rect": (10, 20, 410, 320)},
            2: {"title": "SARA", "visible": True, "iconic": True, "zoomed": False, "rect": (0, 0, 800, 600)},
            3: {"title": "Hidden", "visible": False, "iconic": False, "zoomed": False, "rect": (0, 0, 1, 1)},
        }

    def IsWindowVisible(self, hwnd):
        return self.windows[hwnd]["visible"]

    def GetWindowText(self, hwnd):
        return self.windows[hwnd]["title"]

    def GetWindowRect(self, hwnd):
        return self.windows[hwnd]["rect"]

    def IsIconic(self, hwnd):
        return self.windows[hwnd]["iconic"]

    def IsZoomed(self, hwnd):
        return self.windows[hwnd]["zoomed"]

    def EnumWindows(self, callback, extra):
        for hwnd in self.windows:
            callback(hwnd, extra)

    def GetForegroundWindow(self):
        return self.active

    def ShowWindow(self, hwnd, command):
        self.windows[hwnd]["iconic"] = False

    def SetForegroundWindow(self, hwnd):
        self.active = hwnd


class WindowManagerTest(unittest.TestCase):
    def test_lists_visible_windows_with_bounds_and_state(self):
        manager = WindowManager()
        fake = FakeWin32Gui()
        with patch.object(manager, "_win32gui", return_value=fake), patch("psutil.Process") as process:
            process.return_value.name.return_value = "notepad.exe"
            windows = manager.list_windows()

        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[0]["bounds"], {"x": 10, "y": 20, "width": 400, "height": 300})
        self.assertTrue(windows[1]["minimized"])

    def test_focus_reports_foreground_verification(self):
        manager = WindowManager()
        fake = FakeWin32Gui()
        with patch.object(manager, "_win32gui", return_value=fake), patch("psutil.Process") as process, patch("time.sleep"):
            process.return_value.name.return_value = "notepad.exe"
            result = manager.focus("SARA")

        self.assertTrue(result["verified"])
        self.assertEqual(result["active_hwnd"], 2)
        self.assertFalse(result["window"]["minimized"])


if __name__ == "__main__":
    unittest.main()
