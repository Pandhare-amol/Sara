from __future__ import annotations

import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from desktop_agent.registry import ToolError
from desktop_agent.visual_actions import VisualActions

TASK_ID = "SARA-AUTO-" + "A" * 24
WINDOW = {"hwnd": 27, "title": "Untitled - Notepad", "process_name": "notepad.exe",
          "bounds": {"x": 10, "y": 20, "width": 200, "height": 100}}
BOUNDS = {"x": 25, "y": 40, "width": 45, "height": 18}


def ui(label, role="menu"):
    return {"type": role, "label": label, "source": "uia", "enabled": True, "confidence": 1.0,
            "bounds": BOUNDS, "timestamp": "now"}


def observation(elements, *, age=0, window=None):
    from datetime import datetime, timezone, timedelta
    return {"observed_at": (datetime.now(timezone.utc) - timedelta(seconds=age)).isoformat(),
            "window": window or WINDOW, "capture_bounds": {"x": 10, "y": 20, "width": 200, "height": 100},
            "changed": True, "elements": elements}


class VisualActionTest(unittest.TestCase):
    def setUp(self):
        self.actions = VisualActions()
        self.grant = SimpleNamespace(scope="application", application="notepad.exe")
        self.args = {"bridge_key": "secret", "automation_task_id": TASK_ID,
                     "label": "Help", "expected_label": "About"}

    def _mocks(self, before, after, invoke=None):
        wrapper = SimpleNamespace(iface_invoke=SimpleNamespace(Invoke=invoke or MagicMock()))
        patches = [patch("desktop_agent.visual_actions.VISUAL_ACCESS._bridge"),
                   patch("desktop_agent.visual_actions.VISUAL_ACCESS.require", return_value=self.grant),
                   patch("desktop_agent.visual_actions.VISUAL_ACCESS.select", return_value=(self.grant, (10, 20, 200, 100))),
                   patch("desktop_agent.visual_actions.VISUAL_ACCESS.unchanged"),
                   patch("desktop_agent.visual_actions.VISUAL_PERCEPTION._active_window", return_value=WINDOW),
                   patch("desktop_agent.visual_actions.VISUAL_PERCEPTION.observe", side_effect=[before, after]),
                   patch("desktop_agent.visual_actions.uia_elements", return_value=([ui("Help")], [wrapper], True))]
        return patches, wrapper

    def test_safe_uia_navigation_needs_a_fresh_new_accessible_postcondition(self):
        patches, wrapper = self._mocks(observation([ui("Help")]), observation([ui("Help"), ui("About", "button")]))
        with _patched(patches):
            result = self.actions.click(self.args)
        self.assertTrue(result["verified"])
        self.assertTrue(result["verification"]["checks"][0]["passed"])
        wrapper.iface_invoke.Invoke.assert_called_once()
        self.assertEqual(self.actions.status(TASK_ID)["step"], "verified")
        self.assertEqual(self.actions.status(TASK_ID)["retry_count"], 0)
        with patch("desktop_agent.visual_actions.VISUAL_ACCESS._bridge"):
            with self.assertRaisesRegex(ToolError, "Duplicate"):
                self.actions.click(self.args)

    def test_stale_observation_or_changed_layout_never_invokes(self):
        patches, wrapper = self._mocks(observation([ui("Help")], age=3), observation([ui("About")]))
        with _patched(patches):
            result = self.actions.click(self.args)
        self.assertEqual(result["status"], "BLOCKED")
        wrapper.iface_invoke.Invoke.assert_not_called()
        other = VisualActions()
        patches, wrapper = self._mocks(observation([ui("Help")]), observation([ui("About")]))
        with _patched(patches), patch("desktop_agent.visual_actions.uia_elements", return_value=(
                [{**ui("Help"), "bounds": {**BOUNDS, "x": 90}}], [wrapper], True)):
            result = other.click(self.args)
        self.assertEqual(result["status"], "BLOCKED")
        wrapper.iface_invoke.Invoke.assert_not_called()

    def test_failed_invoke_might_have_actually_clicked_no_automatic_retry(self):
        invoking = MagicMock(side_effect=RuntimeError("COM error after input"))
        patches, wrapper = self._mocks(observation([ui("Help")]), observation([ui("About")]), invoking)
        with _patched(patches):
            result = self.actions.click(self.args)
        self.assertEqual(result["status"], "UNCERTAIN")
        self.assertTrue(result["action_sent"], "dispatch may have reached Windows before the exception")
        wrapper.iface_invoke.Invoke.assert_called_once()
        self.assertEqual(self.actions.status(TASK_ID)["retry_count"], 0)

    def test_unexpected_dialog_and_permission_prompt_fail_shut(self):
        patches, wrapper = self._mocks(observation([ui("Help"), ui("Unexpected", "dialog")]), observation([ui("About")]))
        with _patched(patches):
            result = self.actions.click(self.args)
        self.assertEqual(result["status"], "BLOCKED")
        wrapper.iface_invoke.Invoke.assert_not_called()
        other = VisualActions()
        patches, wrapper = self._mocks(observation([ui("Help")]), observation([ui("About")]))
        with _patched(patches), patch("desktop_agent.visual_actions.VISUAL_ACCESS.unchanged", side_effect=ToolError("Permission revoked")):
            result = other.click(self.args)
        self.assertEqual(result["status"], "BLOCKED")
        wrapper.iface_invoke.Invoke.assert_not_called()
        with patch("desktop_agent.visual_actions.VISUAL_ACCESS._bridge"):
            with self.assertRaisesRegex(ToolError, "Only approved Notepad"):
                VisualActions().click({**self.args, "label": "Save"})

    def test_in_flight_cancel_before_invocation_is_honest(self):
        entered = threading.Event()
        resume = threading.Event()
        result: list[dict] = []
        before = observation([ui("Help")]); after = observation([ui("About")])
        patches, wrapper = self._mocks(before, after)
        def pause(_task_id, *, force):
            entered.set()
            self.assertTrue(resume.wait(2))
            return before
        with _patched(patches), patch("desktop_agent.visual_actions.VISUAL_PERCEPTION.observe", side_effect=pause):
            thread = threading.Thread(target=lambda: result.append(self.actions.click(self.args)))
            thread.start()
            self.assertTrue(entered.wait(2))
            self.assertTrue(self.actions.cancel(TASK_ID)["ok"])
            resume.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result[0]["status"], "CANCELLED")
        self.assertFalse(result[0]["action_sent"])
        wrapper.iface_invoke.Invoke.assert_not_called()


class _patched:
    def __init__(self, patches): self.patches = patches
    def __enter__(self):
        for p in self.patches: p.start()
    def __exit__(self, exc_type, exc, tb):
        for p in reversed(self.patches): p.stop()


if __name__ == "__main__":
    unittest.main()
