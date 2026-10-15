import unittest
from unittest.mock import patch

from desktop_agent import tools_hardware


class HardwareMacroReplayTest(unittest.TestCase):
    def test_macro_executes_only_supported_actions_and_reports_cleanup(self):
        calls = []
        with patch.object(tools_hardware, "hardware_mouse_click", side_effect=lambda args: calls.append(("click", args))), \
                patch.object(tools_hardware, "hardware_keyboard_type", side_effect=lambda args: calls.append(("type", args))), \
                patch.object(tools_hardware, "hardware_keyboard_press", side_effect=lambda args: calls.append(("press", args))), \
                patch.object(tools_hardware, "hardware_mouse_scroll", side_effect=lambda args: calls.append(("scroll", args))), \
                patch.object(tools_hardware, "hardware_mouse_move", side_effect=lambda args: calls.append(("move", args))), \
                patch.object(tools_hardware.DESKTOP_INPUT, "emergency_release", return_value={"verified": True}) as release:
            result = tools_hardware.hardware_macro_replay({"actions": [
                {"type": "click", "x": 1, "y": 2},
                {"type": "type", "text": "hello"},
                {"type": "press", "key": "enter"},
                {"type": "scroll", "amount": 2},
                {"type": "move", "x": 5, "y": 6},
                {"type": "launch", "path": "unexpected"},
                "invalid",
            ]})

        self.assertEqual(result["executed"], 5)
        self.assertEqual(result["ignored"], 2)
        self.assertFalse(result["verified"])
        self.assertTrue(result["cleanup"]["verified"])
        self.assertEqual(len(calls), 5)
        release.assert_called_once()

    def test_macro_enforces_action_limit_and_releases_after_failure(self):
        with self.assertRaisesRegex(Exception, "100 actions"):
            tools_hardware.hardware_macro_replay({"actions": [{}] * 101})

        with patch.object(tools_hardware, "hardware_mouse_click", side_effect=RuntimeError("click failed")), \
                patch.object(tools_hardware.DESKTOP_INPUT, "emergency_release", return_value={"verified": True}) as release:
            with self.assertRaisesRegex(RuntimeError, "click failed"):
                tools_hardware.hardware_macro_replay({"actions": [{"type": "click"}]})
        release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
