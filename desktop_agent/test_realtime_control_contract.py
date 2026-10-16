import unittest
from unittest.mock import patch

from desktop_agent.desktop_input_controller import DesktopInputController
from desktop_agent.registry import TOOLS, load_all
from desktop_agent.screen_state_manager import ScreenStateManager


class FakeBackend:
    def __init__(self):
        self.current_position = (5, 7)

    def moveTo(self, x, y, duration=0):
        self.current_position = (x, y)

    def position(self):
        return self.current_position


class RealtimeControlContractTest(unittest.TestCase):
    def test_mouse_modes_and_relative_position(self):
        controller = DesktopInputController()
        backend = FakeBackend()
        with patch.object(controller, "_backend", return_value=backend):
            result = controller.move_relative(10, -2, mode="FAST")
        self.assertEqual((result["x"], result["y"]), (15, 5))
        self.assertEqual(result["mode"], "FAST")

    def test_invalid_mouse_mode_is_rejected(self):
        controller = DesktopInputController()
        with patch.object(controller, "_backend", return_value=FakeBackend()):
            with self.assertRaises(Exception):
                controller.move(1, 2, mode="RANDOM")

    def test_first_class_tools_are_registered(self):
        load_all()
        for name in ("mouseMove", "mouseDoubleClick", "keyboardType", "keyDown", "observeScreen", "waitForScreenChange"):
            self.assertIn(name, TOOLS)

    def test_screen_state_uses_cache_until_forced(self):
        manager = ScreenStateManager(cache_ttl=60)
        from types import SimpleNamespace
        class Image:
            width = 10
            height = 20
            def convert(self, _mode): return self
            def resize(self, _size): return self
            def tobytes(self): return b"same"
        active = {"hwnd": 1, "process_name": "notepad.exe", "bounds": {"x": 0, "y": 0, "width": 10, "height": 20}}
        with patch.object(manager, "_capture", return_value=Image()), \
             patch.object(manager, "_active_window", return_value=active), \
             patch("desktop_agent.screen_state_manager.VISUAL_ACCESS.require", return_value=SimpleNamespace(generation=1)), \
             patch("desktop_agent.screen_state_manager.VISUAL_ACCESS.select", return_value=(object(), (0, 0, 10, 20))), \
             patch("desktop_agent.screen_state_manager.VISUAL_ACCESS.unchanged"):
            first = manager.current(reason="before_click")
            second = manager.current(reason="after_click")
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["state"]["image_hash"], second["state"]["image_hash"])


if __name__ == "__main__":
    unittest.main()