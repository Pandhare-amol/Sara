from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent.visual_access import VisualAccess


class VisualAccessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SARA_DATA_DIR": self.temp.name,
                                        "SARA_MULTIUSER_REQUIRED": "false",
                                        "SARA_VISUAL_BRIDGE_KEY": "bridge-secret-for-unit-tests-only-32-chars"})
        self.env.start()
        self.access = VisualAccess()
        self.sequence = 0
        self.window = {"hwnd": 12, "title": "Untitled - Notepad", "process_name": "Notepad.exe",
                       "bounds": {"x": 100, "y": 200, "width": 600, "height": 400}, "visible": True}

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def grant(self, **patches):
        self.sequence += 1
        return self.access.configure({"bridge_key": os.environ["SARA_VISUAL_BRIDGE_KEY"],
                                      "scope": "application", "application": "notepad.exe",
                                      "duration_seconds": 120, "sequence": self.sequence, **patches})

    def test_default_deny_admin_bridge_scope_and_revocation(self) -> None:
        with self.assertRaisesRegex(ToolError, "off or expired"):
            self.access.select(self.window)
        with self.assertRaisesRegex(ToolError, "trusted local admin bridge"):
            self.access.configure({"scope": "application", "application": "notepad.exe"})
        self.assertTrue(self.grant()["enabled"])
        self.assertFalse(self.access.status()["cloud_vision"], "screen grant is not cloud-transfer consent")
        grant, bounds = self.access.select(self.window)
        self.assertEqual(bounds, (100, 200, 600, 400))
        with self.assertRaisesRegex(ToolError, "monitoring"):
            self.access.require(monitor=True)
        with self.assertRaisesRegex(ToolError, "Saving"):
            self.access.require(save=True)
        with self.assertRaisesRegex(ToolError, "active visible"):
            self.access.select({**self.window, "process_name": "chrome.exe"})
        with self.assertRaisesRegex(ToolError, "Protected"):
            self.access.select({**self.window, "title": "Windows Security password", "process_name": "consent.exe"})
        self.sequence += 1
        self.assertFalse(self.access.revoke(os.environ["SARA_VISUAL_BRIDGE_KEY"], self.sequence)["enabled"])
        with self.assertRaisesRegex(ToolError, "changed or expired"):
            self.access.unchanged(grant)

    def test_display_scope_rechecks_geometry_and_protected_foreground(self) -> None:
        left = {"x": -1920, "y": 0, "width": 1920, "height": 1080, "primary": False}
        with patch.object(self.access, "_monitors", return_value=[left]):
            self.access.configure({"bridge_key": os.environ["SARA_VISUAL_BRIDGE_KEY"], "sequence": 1,
                                   "scope": "display", "display": 0, "duration_seconds": 20})
            _, rect = self.access.select(self.window)
            self.assertEqual(rect, (-1920, 0, 1920, 1080))
        with patch.object(self.access, "_monitors", return_value=[{**left, "x": -1800}]):
            with self.assertRaisesRegex(ToolError, "geometry changed"):
                self.access.select(self.window)
        with patch.object(self.access, "_monitors", return_value=[left]):
            with self.assertRaisesRegex(ToolError, "Protected"):
                self.access.select({**self.window, "title": "User Account Control"})

    def test_headless_browser_screenshot_is_not_a_desktop_grant_bypass(self) -> None:
        from desktop_agent.registry import TOOLS, load_all
        load_all()
        with self.assertRaisesRegex(ToolError, "browser-origin scope"):
            TOOLS["desktopBrowserScreenshot"]({})

    def test_late_grant_after_emergency_stop_never_reopens_screen(self) -> None:
        self.grant()
        self.access.revoke(os.environ["SARA_VISUAL_BRIDGE_KEY"], 3)
        with self.assertRaisesRegex(ToolError, "newer stop"):
            self.access.configure({"bridge_key": os.environ["SARA_VISUAL_BRIDGE_KEY"],
                                   "sequence": 2, "scope": "application", "application": "notepad.exe",
                                   "duration_seconds": 120})
        self.assertFalse(self.access.status()["enabled"])

    def test_expiry_and_protected_mode_cannot_be_extended_by_untrusted_text(self) -> None:
        self.grant()
        with patch("desktop_agent.identity_guard.protected_mode_active", return_value=True):
            with self.assertRaisesRegex(ToolError, "protected multi-user"):
                self.access.require()
        self.assertFalse(self.access.status()["enabled"])
        self.grant()
        with patch("desktop_agent.visual_access.time.monotonic", return_value=1e20):
            self.assertFalse(self.access.status()["enabled"])
        with self.assertRaisesRegex(ToolError, "valid display"):
            self.access.configure({"bridge_key": os.environ["SARA_VISUAL_BRIDGE_KEY"], "scope": "display",
                                   "display": "0", "duration_seconds": 120})


if __name__ == "__main__":
    unittest.main()
