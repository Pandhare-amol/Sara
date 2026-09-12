import unittest
from unittest.mock import patch

from desktop_agent.desktop_input_controller import DesktopInputController


class FakePyAutoGui:
    FAILSAFE = False

    def __init__(self):
        self.calls = []
        self.current_position = (10, 20)

    def keyDown(self, key):
        self.calls.append(("keyDown", key))

    def keyUp(self, key):
        self.calls.append(("keyUp", key))

    def mouseDown(self, button):
        self.calls.append(("mouseDown", button))

    def mouseUp(self, button):
        self.calls.append(("mouseUp", button))

    def dragTo(self, x, y, duration, button):
        self.calls.append(("dragTo", x, y, duration, button))
        self.current_position = (x, y)

    def hotkey(self, *keys):
        self.calls.append(("hotkey", *keys))

    def position(self):
        return self.current_position


class DesktopInputControllerTest(unittest.TestCase):
    def setUp(self):
        self.controller = DesktopInputController()
        self.backend = FakePyAutoGui()

    def test_emergency_release_releases_every_held_input(self):
        with patch.object(self.controller, "_backend", return_value=self.backend):
            self.controller.key_down("ctrl")
            self.controller.button_down("left")
            result = self.controller.emergency_release()

        self.assertEqual(result["released_keys"], ["ctrl"])
        self.assertEqual(result["released_buttons"], ["left"])
        self.assertTrue(result["verified"])
        self.assertIn(("keyUp", "ctrl"), self.backend.calls)
        self.assertIn(("mouseUp", "left"), self.backend.calls)

    def test_drag_starts_at_current_position_and_releases(self):
        with patch.object(self.controller, "_backend", return_value=self.backend):
            result = self.controller.drag({"x": 100, "y": 200, "duration": 0.2})

        self.assertEqual(self.backend.calls[0], ("dragTo", 100, 200, 0.2, "left"))
        self.assertTrue(result["action_sent"])
        self.assertFalse(result["verified"])

    def test_unicode_typing_restores_clipboard(self):
        clipboard = ["user clipboard"]

        def copy(value):
            clipboard[0] = value

        def paste():
            return clipboard[0]

        with patch.object(self.controller, "_backend", return_value=self.backend), \
                patch("pyperclip.paste", side_effect=paste), \
                patch("pyperclip.copy", side_effect=copy):
            result = self.controller.type_text("SARA - café", interval=0)

        self.assertTrue(result["action_sent"])
        self.assertFalse(result["verified"])
        self.assertEqual(clipboard[0], "user clipboard")
        self.assertIn(("hotkey", "ctrl", "v"), self.backend.calls)


if __name__ == "__main__":
    unittest.main()
