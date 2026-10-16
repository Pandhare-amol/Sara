import unittest
import time
from types import SimpleNamespace
from unittest.mock import patch

from desktop_agent.tools_targeting import click_ui_target, resolve_ui_target


class TargetingTest(unittest.TestCase):
    def test_resolves_exact_high_confidence_target(self):
        detected = {"active_window": {"title": "Document - Word", "process_name": "WINWORD.EXE", "hwnd": 9}, "elements": [{"text": "Save", "confidence": 96, "bbox": {"left": 10, "top": 20, "width": 80, "height": 30}, "center": {"x": 50, "y": 35}}]}
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
        active = {"title": "Form - Notepad", "process_name": "notepad.exe", "hwnd": 9,
                  "bounds": {"x": 0, "y": 0, "width": 400, "height": 400}}
        detected = {"active_window": active, "observed_at": time.time(), "elements": [{"text": "Submit", "confidence": 95, "center": {"x": 100, "y": 200}}]}
        with patch.dict("desktop_agent.tools_targeting.TOOLS", {"detectUiElements": lambda args: detected}), \
                patch("desktop_agent.tools_targeting._active_window_info", return_value=active), \
                patch("desktop_agent.tools_targeting._coordinate_is_calibrated", return_value=True), \
                patch("desktop_agent.tools_targeting.VISUAL_ACCESS.select", return_value=(SimpleNamespace(scope="application", application="notepad.exe"), (0, 0, 400, 400))), \
                patch("desktop_agent.tools_targeting.VISUAL_ACCESS.unchanged"), \
                patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click", return_value={"action_sent": True, "verified": False}) as click:
            result = click_ui_target({"text": "Submit", "application": "notepad"})
        click.assert_called_once()
        self.assertTrue(result["action_sent"])
        self.assertFalse(result["verified"])

    def test_legacy_coordinates_refuse_stale_target_scaling_and_out_of_window(self):
        active = {"title": "Form - Notepad", "process_name": "notepad.exe", "hwnd": 9,
                  "bounds": {"x": 0, "y": 0, "width": 400, "height": 400}}
        observed = {"active_window": active, "observed_at": time.time(), "elements": [
            {"text": "Submit", "confidence": 95, "center": {"x": 100, "y": 200}}]}
        grant = SimpleNamespace(scope="application", application="notepad.exe")
        with patch.dict("desktop_agent.tools_targeting.TOOLS", {"detectUiElements": lambda args: observed}), \
                patch("desktop_agent.tools_targeting._active_window_info", return_value=active), \
                patch("desktop_agent.tools_targeting.VISUAL_ACCESS.select", return_value=(grant, (0, 0, 400, 400))), \
                patch("desktop_agent.tools_targeting.VISUAL_ACCESS.unchanged"), \
                patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click") as click:
            observed["observed_at"] = time.time() - 3
            with self.assertRaisesRegex(Exception, "stale"):
                click_ui_target({"text": "Submit", "application": "notepad"})
            observed["observed_at"] = time.time()
            with patch("desktop_agent.tools_targeting._coordinate_is_calibrated", return_value=False):
                with self.assertRaisesRegex(Exception, "uncalibrated"):
                    click_ui_target({"text": "Submit", "application": "notepad"})
            observed["elements"][0]["center"] = {"x": 401, "y": 200}
            with patch("desktop_agent.tools_targeting._coordinate_is_calibrated", return_value=True):
                with self.assertRaisesRegex(Exception, "outside"):
                    click_ui_target({"text": "Submit", "application": "notepad"})
        click.assert_not_called()


if __name__ == "__main__":
    unittest.main()
