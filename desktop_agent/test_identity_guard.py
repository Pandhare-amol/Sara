import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent.identity_guard import agent_route_allowed, protected_mode_active


class MultiUserAgentGuardTest(unittest.TestCase):
    def test_legacy_routes_remain_available_until_opt_in(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"SARA_MULTIUSER_REQUIRED": "false"}):
            self.assertFalse(protected_mode_active(root))
            self.assertTrue(agent_route_allowed("/execute", root))
            self.assertTrue(agent_route_allowed("/companion/command", root))

    def test_marker_blocks_direct_tools_camera_browser_companion_and_diagnostics(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"SARA_MULTIUSER_REQUIRED": "false"}):
            security = Path(root) / "security"
            security.mkdir()
            marker = security / "multiuser.json"
            marker.write_text("{invalid; still deny}", encoding="utf-8")
            self.assertTrue(protected_mode_active(root))
            for route in ("/execute", "/browser/state", "/companion/command", "/orchestrator/emergency-stop", "/health/diagnostics", "/capabilities"):
                with self.subTest(route=route):
                    self.assertFalse(agent_route_allowed(route, root))
            self.assertTrue(agent_route_allowed("/health", root))

    def test_interrupted_activation_intent_locks_agent(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"SARA_MULTIUSER_REQUIRED": "false"}):
            security = Path(root) / "security"
            security.mkdir()
            (security / "multiuser.pending").write_text("pending", encoding="utf-8")
            self.assertFalse(agent_route_allowed("/execute", root))

    def test_required_mode_is_locked_even_before_bootstrap(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"SARA_MULTIUSER_REQUIRED": "true"}):
            self.assertFalse(agent_route_allowed("/execute", root))
            self.assertTrue(agent_route_allowed("/health", root))

    def test_standalone_agent_reads_ignored_dotenv_flag_and_custom_marker(self):
        with tempfile.TemporaryDirectory() as root:
            env = Path(root) / ".env"
            old = {key: os.environ.pop(key, None) for key in
                   ("SARA_MULTIUSER_REQUIRED", "SARA_DATA_DIR", "SARA_APP_ROOT")}
            try:
                os.environ["SARA_APP_ROOT"] = root
                env.write_text('SARA_MULTIUSER_REQUIRED="true"\nSARA_DATA_DIR=private-data\n', encoding="utf-8")
                self.assertFalse(agent_route_allowed("/execute"), ".env-only required mode must lock tools")
                env.write_text("SARA_MULTIUSER_REQUIRED=false\nSARA_DATA_DIR=private-data\n", encoding="utf-8")
                self.assertTrue(agent_route_allowed("/execute"))
                security = Path(root) / "private-data" / "security"
                security.mkdir(parents=True)
                (security / "multiuser.pending").write_text("pending\n", encoding="utf-8")
                self.assertFalse(agent_route_allowed("/execute"), "custom data path must use the same marker")
                self.assertTrue(agent_route_allowed("/health"))
                env.write_bytes(b"\xffbad configuration")
                self.assertFalse(agent_route_allowed("/execute"), "unreadable config must not reopen tools")
            finally:
                for key, value in old.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
