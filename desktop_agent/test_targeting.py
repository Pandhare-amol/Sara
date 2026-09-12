import unittest
from unittest.mock import patch

from desktop_agent.tools_targeting import click_ui_target, resolve_ui_target


class TargetingTest(unittest.TestCase):
    def test_resolves_exact_high_confidence_target(self):
        detected = {"elements": [{"text": "Save", "confidence": 96, "bbox": {"left": 10, "top": 20, "width": 80, "height": 30}, "center": {"x": 50, "y": 35}}]}
        with patch.dict("desktop_agent.tools_targeting.TOOLS", {"detectUiElements": lambda args: detected}):
            result = resolve_ui_target({"text": "Save"})
        self.assertTrue(result["verified"])
        self.assertEqual(result["target"]["center"], {"x": 50, "y": 35})

    def test_rejects_low_confidence_target(self):
        detected = {"elements": [{"text": "Save", "confidence": 60, "center": {"x": 50, "y": 35}}]}
        with patch.dict("desktop_agent.tools_targeting.TOOLS", {"detectUiElements": lambda args: detected}):
            with self.assertRaisesRegex(Exception, "confidence"):
                resolve_ui_target({"text": "Save"})

    def test_click_uses_real_input_only_after_resolution(self):
        detected = {"elements": [{"text": "Submit", "confidence": 95, "center": {"x": 100, "y": 200}}]}
        with patch.dict("desktop_agent.tools_targeting.TOOLS", {"detectUiElements": lambda args: detected}), \
                patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click", return_value={"action_sent": True, "verified": False}) as click:
            result = click_ui_target({"text": "Submit"})
        click.assert_called_once()
        self.assertTrue(result["action_sent"])
        self.assertFalse(result["verified"])


if __name__ == "__main__":
    unittest.main()
