from __future__ import annotations

import unittest
import time
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_screenshot, tools_targeting


class ScreenshotTargetingTest(unittest.TestCase):
    def test_ocr_dictionary_rows_are_scoped_to_active_window_with_absolute_screen_bounds(self) -> None:
        active = {"title": "Report - Word", "process_name": "WINWORD.EXE", "hwnd": 91, "bounds": {"x": 100, "y": 200, "width": 700, "height": 500}}
        data = {"text": ["", "Font", "Size"], "conf": ["-1", "96", "94"],
                "left": [0, 10, 86], "top": [0, 20, 20], "width": [0, 65, 44], "height": [0, 20, 20]}
        with patch("desktop_agent.tools_screenshot.VISUAL_ACCESS.require", return_value=object()), \
             patch("desktop_agent.tools_screenshot.VISUAL_ACCESS.unchanged"), \
             patch("desktop_agent.tools_screenshot._authorized_capture", return_value=(object(), active, (100, 200))) as capture, \
             patch("desktop_agent.tools_screenshot._ocr_data", return_value=data):
            found = tools_screenshot.detect_ui_elements({})
        capture.assert_called_once_with()
        self.assertEqual([e["text"] for e in found["elements"]], ["Font", "Size"])
        self.assertEqual(found["elements"][0]["center"], {"x": 142, "y": 230})
        self.assertEqual(found["active_window"]["process_name"], "WINWORD.EXE")

    def test_click_fails_if_window_changes_or_app_is_ambiguous(self) -> None:
        detected = {"active_window": {"title": "Report - Word", "process_name": "WINWORD.EXE", "hwnd": 91},
                    "observed_at": time.time(), "elements": [{"text": "Font Size", "confidence": 95, "bbox": {"left": 10, "top": 20, "width": 60, "height": 20},
                                  "center": {"x": 40, "y": 30}}]}
        with patch.dict(tools_targeting.TOOLS, {"detectUiElements": lambda args: detected}), \
             patch("desktop_agent.tools_targeting._active_window_info", return_value={"title": "ChatGPT", "process_name": "chrome.exe", "hwnd": 123}), \
             patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click") as click:
            with self.assertRaisesRegex(ToolError, "window changed"):
                tools_targeting.click_ui_target({"text": "Font Size", "application": "Word"})
            click.assert_not_called()
        with patch.dict(tools_targeting.TOOLS, {"detectUiElements": lambda args: detected}):
            with self.assertRaisesRegex(ToolError, "application"):
                tools_targeting.click_ui_target({"text": "Font Size"})
            with self.assertRaisesRegex(ToolError, "application"):
                tools_targeting.resolve_ui_target({"text": "Font Size", "application": "ChatGPT"})

    def test_stale_ocr_target_refuses_a_late_click(self) -> None:
        active = {"title": "Report - Word", "process_name": "WINWORD.EXE", "hwnd": 91}
        detected = {"active_window": active, "observed_at": time.time() - 30,
                    "elements": [{"text": "Save", "confidence": 99, "center": {"x": 10, "y": 20}}]}
        with patch.dict(tools_targeting.TOOLS, {"detectUiElements": lambda args: detected}), \
             patch("desktop_agent.tools_targeting._active_window_info", return_value=active), \
             patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click") as click:
            with self.assertRaisesRegex(ToolError, "stale"):
                tools_targeting.click_ui_target({"text": "Save", "application": "Word"})
            click.assert_not_called()

    def test_click_hits_exact_word_label_and_keeps_outcome_unverified(self) -> None:
        active = {"title": "Report - Word", "process_name": "WINWORD.EXE", "hwnd": 91,
                  "bounds": {"x": 0, "y": 0, "width": 200, "height": 100}}
        detected = {"active_window": active, "observed_at": time.time(),
                    "elements": [{"text": "Font Size", "confidence": 95, "bbox": {"left": 10, "top": 20, "width": 60, "height": 20},
                                  "center": {"x": 40, "y": 30}}]}
        from types import SimpleNamespace
        grant = SimpleNamespace(scope="application", application="winword.exe")
        with patch.dict(tools_targeting.TOOLS, {"detectUiElements": lambda args: detected}), \
             patch("desktop_agent.tools_targeting._active_window_info", return_value=active), \
             patch("desktop_agent.tools_targeting.VISUAL_ACCESS.select", return_value=(grant, (0, 0, 200, 100))), \
             patch("desktop_agent.tools_targeting.VISUAL_ACCESS.unchanged"), \
             patch("desktop_agent.tools_targeting._coordinate_is_calibrated", return_value=True), \
             patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click", return_value={"action_sent": True, "verified": False}) as click:
            result = tools_targeting.click_ui_target({"text": "Font Size", "application": "Word"})
            click.assert_called_once()
            self.assertFalse(result["verified"])
            self.assertEqual(result["target"]["window"]["hwnd"], 91)
    def test_scaled_or_uncalibrated_ocr_coordinates_are_rejected(self) -> None:
        from types import SimpleNamespace
        active = {"title": "Report - Word", "process_name": "WINWORD.EXE", "hwnd": 91,
                  "bounds": {"x": -1920, "y": 0, "width": 1280, "height": 720}}
        detected = {"active_window": active, "observed_at": time.time(),
                    "elements": [{"text": "Help", "confidence": 98, "bbox": {"left": -1900, "top": 50, "width": 30, "height": 20},
                                  "center": {"x": -1885, "y": 60}}]}
        grant = SimpleNamespace(scope="application", application="winword.exe")
        with patch.dict(tools_targeting.TOOLS, {"detectUiElements": lambda args: detected}), \
             patch("desktop_agent.tools_targeting._active_window_info", return_value=active), \
             patch("desktop_agent.tools_targeting.VISUAL_ACCESS.select", return_value=(grant, (-1920, 0, 1280, 720))), \
             patch("desktop_agent.tools_targeting._coordinate_is_calibrated", return_value=False), \
             patch("desktop_agent.tools_targeting.DESKTOP_INPUT.click") as click:
            with self.assertRaisesRegex(ToolError, "scaling is uncalibrated"):
                tools_targeting.click_ui_target({"application": "Word", "text": "Help"})
            click.assert_not_called()


if __name__ == "__main__":
    unittest.main()
