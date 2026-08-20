from __future__ import annotations

import importlib
import os
import tempfile
import unittest


class ServiceIntegrationsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name
        import desktop_agent.platform_core as platform_core
        import desktop_agent.service_integrations as service_integrations

        self.platform_core = importlib.reload(platform_core)
        self.service_integrations = importlib.reload(service_integrations)

    def tearDown(self) -> None:
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_registry_lists_builtin_integrations(self) -> None:
        listed = self.service_integrations.SERVICE_INTEGRATIONS.list()
        names = [item["name"] for item in listed]
        self.assertIn("Gmail", names)
        self.assertIn("Slack", names)
        self.assertIn("Instagram", names)

    def test_connect_session_and_execute(self) -> None:
        connect = self.service_integrations.SERVICE_INTEGRATIONS.connect("Gmail", "secret-token", {"tenant": "demo"})
        self.assertTrue(connect["connected"])
        session = self.service_integrations.SERVICE_INTEGRATIONS.session("Gmail")
        self.assertTrue(session["connected"])
        email = self.service_integrations.SERVICE_INTEGRATIONS.execute("Gmail", "send_email", {"to": "team@example.com", "subject": "Hello"})
        self.assertTrue(email["connected"])
        self.assertEqual(email["integration"], "Gmail")
        calendar = self.service_integrations.SERVICE_INTEGRATIONS.execute("Google Calendar", "create_event", {"title": "Standup"})
        self.assertEqual(calendar["integration"], "Google Calendar")
        drive = self.service_integrations.SERVICE_INTEGRATIONS.execute("Google Drive", "upload", {"path": "report.pdf"})
        self.assertEqual(drive["integration"], "Google Drive")
        slack = self.service_integrations.SERVICE_INTEGRATIONS.execute("Slack", "send_message", {"text": "hello"})
        self.assertEqual(slack["integration"], "Slack")
        youtube = self.service_integrations.SERVICE_INTEGRATIONS.execute("YouTube", "search", {"query": "AI tutorials"})
        self.assertEqual(youtube["integration"], "YouTube")
        instagram = self.service_integrations.SERVICE_INTEGRATIONS.execute("Instagram", "post", {"content": "new post"})
        self.assertEqual(instagram["integration"], "Instagram")

    def test_vault_roundtrip_persists_service_secret(self) -> None:
        self.platform_core.VAULT.store("gmail", "top-secret")
        self.assertEqual(self.platform_core.VAULT.load("gmail"), "top-secret")


if __name__ == "__main__":
    unittest.main()
