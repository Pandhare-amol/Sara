import unittest
import asyncio
import tempfile
from pathlib import Path

from desktop_agent.capability_matrix import find_capability, get_capability_matrix, list_capability_groups
from desktop_agent.app_resolver import resolve_windows_application, resolve_windows_folder
from desktop_agent import tools_hardware as hw
from desktop_agent import tools_pc as pc
from desktop_agent import tools_file_extra as file_extra
from desktop_agent import tools_files as files
from desktop_agent import tools_windows as wins
from desktop_agent import tools_browser as browser
from desktop_agent import tools_screenshot as shot
from desktop_agent import tools_gesture as gesture
from desktop_agent.registry import TOOL_REGISTRY


class CapabilityMatrixTest(unittest.TestCase):
    def test_matrix_contains_expected_groups(self) -> None:
        groups = list_capability_groups()
        for group in ["perception", "mouse", "keyboard", "windows_applications", "browser", "audio_media", "display", "files", "system", "camera", "gesture_control", "advanced_gestures"]:
            self.assertIn(group, groups)

    def test_matrix_exposes_verified_metadata(self) -> None:
        matrix = get_capability_matrix()
        self.assertTrue(any(item["tool"] == "openApplication" for item in matrix["windows_applications"]))
        self.assertTrue(any(item["tool"] == "copyFile" for item in matrix["files"]))
        self.assertTrue(any(item["tool"] == "desktopBrowserOpenTab" for item in matrix["browser"]))
        self.assertTrue(any(item["tool"] == "desktopInspectScreen" for item in matrix["perception"]))
        self.assertTrue(any(item["tool"] == "gestureControlSetMapping" for item in matrix["gesture_control"]))
        self.assertTrue(any(item["name"] == "saraDesktopCapabilityMatrix" for item in TOOL_REGISTRY.list()))
        self.assertTrue(hasattr(gesture, "gesture_control_set_mapping"))

    def test_find_capability_matches_control_panel(self) -> None:
        matches = find_capability("task manager")
        self.assertTrue(any(m["tool"] == "openApplication" for m in matches))

    def test_open_application_routes_control_panel(self) -> None:
        self.assertEqual(resolve_windows_application("control panel")["launch"], "control.exe")
        self.assertEqual(resolve_windows_application("taskmgr")["launch"], "taskmgr.exe")

    def test_settings_folder_is_not_app_target(self) -> None:
        folder, kind = resolve_windows_folder("settings")
        self.assertIsNone(folder)
        self.assertEqual(kind, "windows-app")

    def test_mouse_and_keyboard_tool_presence(self) -> None:
        self.assertTrue(hasattr(hw, "hardware_mouse_move"))
        self.assertTrue(hasattr(hw, "hardware_keyboard_press"))
        self.assertTrue(hasattr(hw, "hardware_mouse_scroll"))

    def test_volume_and_brightness_tools_presence(self) -> None:
        self.assertTrue(hasattr(pc, "set_volume"))
        self.assertTrue(hasattr(pc, "set_brightness"))

    def test_file_and_window_tools_presence(self) -> None:
        self.assertTrue(hasattr(file_extra, "copy_file"))
        self.assertTrue(hasattr(file_extra, "duplicate_file"))
        self.assertTrue(hasattr(wins, "close_window"))
        self.assertTrue(hasattr(wins, "switch_application"))
        import desktop_agent.tools_window_extra as winx
        self.assertTrue(hasattr(winx, "move_window"))
        self.assertTrue(hasattr(winx, "resize_window"))
        import desktop_agent.tools_semantic_ui as sem
        self.assertTrue(hasattr(sem, "desktop_find_element"))
        self.assertTrue(hasattr(sem, "desktop_click_target"))

    def test_browser_and_screenshot_tools_presence(self) -> None:
        self.assertTrue(hasattr(browser, "browser_search"))
        self.assertTrue(hasattr(browser, "browser_tab_action_alias"))
        self.assertTrue(hasattr(browser, "browser_media"))
        self.assertTrue(hasattr(shot, "read_screen"))

    def test_mouse_keyboard_and_system_simulations(self) -> None:
        original_pyautogui = hw._pyautogui
        original_set_volume = pc._set_volume_scalar
        original_set_brightness = pc._set_brightness
        calls = {}

        class FakePyAutoGUI:
            def __init__(self):
                self._pos = (10, 20)

            def moveTo(self, x, y, duration=0.15):
                calls["move"] = (x, y, duration)
                self._pos = (x, y)

            def click(self, *args, **kwargs):
                calls["click"] = (args, kwargs)

            def hotkey(self, *keys):
                calls["hotkey"] = keys

            def scroll(self, amount):
                calls["scroll"] = amount

            def position(self):
                return self._pos

            def size(self):
                return (1920, 1080)

        try:
            fake = FakePyAutoGUI()
            hw._pyautogui = lambda: fake
            pc._set_volume_scalar = lambda value: calls.setdefault("volume", value)
            pc._set_brightness = lambda value: calls.setdefault("brightness", value) or int(value)
            self.assertIn("Moved mouse", hw.hardware_mouse_move({"x": 11, "y": 22})["result"])
            self.assertIn("Clicked", hw.hardware_mouse_click({"button": "left"})["result"])
            self.assertIn("pressed ctrl+c", hw.hardware_keyboard_press({"keys": ["ctrl", "c"]})["result"].lower())
            self.assertIn("Volume", pc.set_volume({"percent": 40})["result"])
            self.assertIn("Brightness", pc.set_brightness({"percent": 70})["result"])
        finally:
            hw._pyautogui = original_pyautogui
            pc._set_volume_scalar = original_set_volume
            pc._set_brightness = original_set_brightness
        self.assertIn("move", calls)
        self.assertIn("click", calls)
        self.assertIn("hotkey", calls)
        self.assertIn("volume", calls)
        self.assertIn("brightness", calls)

    def test_file_operations_simulations(self) -> None:
        original_ensure_safe = file_extra._ensure_safe
        file_extra._ensure_safe = lambda p, allow_anywhere=False: None
        try:
            with tempfile.TemporaryDirectory() as td:
                base = Path(td)
                src = base / "a.txt"
                src.write_text("hello", encoding="utf-8")
                copy_target = base / "copy.txt"
                move_target = base / "moved.txt"
                rename_target = base / "renamed.txt"
                self.assertIn("Copied", file_extra.copy_file({"path": str(src), "destination": str(copy_target)})["result"])
                self.assertTrue(copy_target.exists())
                self.assertIn("Moved", files.move_file({"path": str(copy_target), "destination": str(move_target)})["result"])
                self.assertTrue(move_target.exists())
                self.assertIn("Renamed", files.rename_file({"path": str(move_target), "new_name": "renamed.txt"})["result"])
                self.assertTrue(rename_target.exists())
                self.assertIn("deleted", files.delete_file({"path": str(rename_target), "permanent": True})["result"].lower())
                self.assertFalse(rename_target.exists())
                folder = base / "newfolder"
                self.assertIn("Created folder", file_extra.create_folder({"path": str(folder)})["result"])
                self.assertTrue(folder.exists())
        finally:
            file_extra._ensure_safe = original_ensure_safe

    def test_move_and_resize_window_simulations(self) -> None:
        import desktop_agent.tools_window_extra as winx
        original_find = winx._find_window_by_title
        original_show = winx._show_window
        original_focus = winx._focus
        try:
            class FakeWin32:
                rect = [10, 20, 210, 120]

            class FakeWin32Gui:
                @staticmethod
                def MoveWindow(hwnd, left, top, width, height, repaint):
                    FakeWin32.rect = [left, top, left + width, top + height]

            winx._find_window_by_title = lambda title: 123
            winx._show_window = lambda hwnd, cmd: None
            winx._focus = lambda hwnd: True
            import sys
            sys.modules["win32gui"] = FakeWin32Gui()
            sys.modules["win32gui"].GetWindowRect = lambda hwnd: tuple(FakeWin32.rect)
            sys.modules["win32gui"].IsWindow = lambda hwnd: True
            sys.modules["win32gui"].IsWindowVisible = lambda hwnd: True
            moved = winx.move_window({"title": "Task Manager", "x": 50, "y": 60, "width": 300, "height": 200})
            resized = winx.resize_window({"title": "Task Manager", "width": 400, "height": 250})
            self.assertIn("verification", moved)
            self.assertIn("verification", resized)
        finally:
            winx._find_window_by_title = original_find
            winx._show_window = original_show
            winx._focus = original_focus

    def test_browser_navigation_and_tab_switching(self) -> None:
        original_page = browser.STATE.page
        original_context = browser.STATE.context
        original_page_fn = browser._page

        class FakePage:
            def __init__(self, url):
                self.url = url
                self.title_value = "Title"

            async def goto(self, url, wait_until="domcontentloaded", timeout=30000):
                self.url = url

            async def reload(self, wait_until="domcontentloaded", timeout=20000):
                self.url = self.url + "#reloaded"

            async def go_back(self, wait_until="domcontentloaded", timeout=20000):
                self.url = "https://example.com/back"

            async def go_forward(self, wait_until="domcontentloaded", timeout=20000):
                self.url = "https://example.com/forward"

            async def locator(self, selector):
                class Body:
                    async def inner_text(self, timeout=10000):
                        return "hello world"
                return Body()

            async def title(self):
                return self.title_value

        try:
            fake1 = FakePage("https://one.example")
            fake2 = FakePage("https://two.example")
            browser.STATE.page = fake1
            browser.STATE.context = type("Ctx", (), {"pages": [fake1, fake2]})()
            browser._page = lambda: asyncio.sleep(0, result=fake1)
            res = asyncio.run(browser.browser_tab_action_alias({"action": "switch", "tabId": 1}))
            self.assertEqual(res["verification"], "VERIFIED")
            browser._page = lambda: asyncio.sleep(0, result=fake1)
            self.assertEqual(asyncio.run(browser.browser_go_back({}))["verification"], "VERIFIED")
            self.assertEqual(asyncio.run(browser.browser_go_forward({}))["verification"], "VERIFIED")
            self.assertEqual(asyncio.run(browser.browser_reload({}))["verification"], "VERIFIED")
        finally:
            browser.STATE.page = original_page
            browser.STATE.context = original_context
            browser._page = original_page_fn


    def test_semantic_target_resolution_simulations(self) -> None:
        import desktop_agent.perception as perception
        import desktop_agent.target_resolver as resolver
        original_inspect = perception.inspect_screen
        original_active = perception.get_active_application
        try:
            perception.inspect_screen = lambda: {
                "timestamp": 1.0,
                "active_window": {"title": "Notepad"},
                "windows": [{"title": "Notepad", "application_name": "notepad.exe"}],
                "elements": [{"role": "button", "name": "Save", "text": "Save", "bounds": {"x": 10, "y": 20, "width": 50, "height": 20}, "visible": True, "enabled": True, "clickable": True, "confidence": 0.99, "source": "ACCESSIBILITY"}],
                "ocr": [{"role": "text", "name": "Open", "text": "Open", "bounds": {"x": 100, "y": 120, "width": 40, "height": 15}, "visible": True, "enabled": False, "clickable": False, "confidence": 0.87, "source": "OCR"}],
                "cursor": {"x": 5, "y": 5},
            }
            perception.get_active_application = lambda: {"window": {"title": "Notepad", "application_name": "notepad.exe"}, "application": "notepad.exe"}
            found = resolver.resolve_target("Save")
            self.assertIsNotNone(found.element)
            self.assertEqual(found.source, "ACCESSIBILITY")
            self.assertGreater(found.confidence, 0.5)
            self.assertIsNotNone(resolver.safe_click_point(found.element))
        finally:
            perception.inspect_screen = original_inspect
            perception.get_active_application = original_active

    def test_media_and_screenshot_simulations(self) -> None:
        original_page_fn = browser._page
        original_capture = shot._capture

        class FakeMedia:
            async def evaluate(self, script, action=None):
                return None

            async def locator(self, selector):
                class Body:
                    async def inner_text(self, timeout=10000):
                        return "media"
                return Body()

            @property
            def url(self):
                return "https://youtube.com/watch?v=test"

            async def title(self):
                return "YouTube"

        class FakeImage:
            width = 800
            height = 600

        try:
            browser._page = lambda: asyncio.sleep(0, result=FakeMedia())
            self.assertEqual(asyncio.run(browser.browser_media({"action": "play"}))["verification"], "UNCERTAIN")
            self.assertEqual(asyncio.run(browser.browser_media({"action": "pause"}))["verification"], "UNCERTAIN")
            shot._capture = lambda: FakeImage()
            self.assertIn("Captured screen", shot.take_screenshot({})["result"])
        finally:
            browser._page = original_page_fn
            shot._capture = original_capture


if __name__ == "__main__":
    unittest.main()
