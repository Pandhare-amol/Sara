import unittest
from unittest.mock import patch

from desktop_agent.desktop_input_controller import DesktopInputController
from desktop_agent.registry import TOOLS, load_all
from desktop_agent.screen_state_manager import ScreenStateManager
from desktop_agent.tools_hardware import hardware_keyboard_press, keyboard_shortcut


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
        for name in ("mouseMove", "mouseDoubleClick", "keyboardType", "keyboardShortcut", "keyDown", "observeScreen", "waitForScreenChange"):
            self.assertIn(name, TOOLS)

    def test_keyboard_shortcut_normalizes_named_action(self):
        controller = DesktopInputController()
        backend = FakeBackend()
        backend.press_calls = []
        backend.hotkey = lambda *keys: backend.press_calls.append(keys)
        with patch.object(controller, "press", side_effect=lambda keys: {"keys": list(keys), "verified": True}):
            with patch("desktop_agent.tools_hardware.DESKTOP_INPUT", controller):
                result = keyboard_shortcut({"name": "select all"})
        self.assertEqual(result["shortcut"], "select_all")
        self.assertEqual(result["keys"], ["ctrl", "a"])

    def test_spoken_key_combination_is_normalized(self):
        controller = DesktopInputController()
        with patch.object(controller, "press", return_value={"keys": ["ctrl", "c"], "verified": True}):
            with patch("desktop_agent.tools_hardware.DESKTOP_INPUT", controller):
                result = hardware_keyboard_press({"keys": "control c"})
        self.assertEqual(result["keys"], ["ctrl", "c"])

    def test_screen_state_uses_cache_until_forced(self):
        manager = ScreenStateManager(cache_ttl=60)
        class Image:
            width = 10
            height = 20
            def tobytes(self):
                return b"same"
        with patch.object(manager, "_capture", return_value=Image()), patch.object(manager, "_active_window", return_value={}):
            first = manager.current(reason="before_click")
            second = manager.current(reason="after_click")
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["state"]["image_hash"], second["state"]["image_hash"])


if __name__ == "__main__":
    unittest.main()