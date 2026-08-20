from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path

try:
    from fastapi.testclient import TestClient
except ModuleNotFoundError:  # pragma: no cover - environment dependent
    TestClient = None  # type: ignore[assignment]


@unittest.skipIf(TestClient is None, "fastapi is not installed in this test environment")
class AndroidCompanionManagerTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.android_companion as android_companion

        self.module = importlib.reload(android_companion)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.manager = self.module.AndroidCompanionManager(storage_dir=Path(self.temp_dir.name))

    def test_register_and_list_device(self) -> None:
        device = self.manager.register_device("Pixel 8", "token-123")
        self.assertEqual(device["name"], "Pixel 8")
        self.assertEqual(device["status"], "paired")
        devices = self.manager.list_devices()
        self.assertEqual(len(devices), 1)

    def test_enqueue_and_fetch_command(self) -> None:
        self.manager.register_device("Pixel 8", "token-123")
        self.manager.enqueue_command("Pixel 8", {"action": "flashlight", "value": True})
        pending = self.manager.get_pending_commands("Pixel 8")
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["action"], "flashlight")

    def test_plan_action_supports_mobile_features(self) -> None:
        self.assertEqual(self.manager.plan_action("Turn on the flashlight")["action"], "flashlight")
        self.assertEqual(self.manager.plan_action("Read my notifications")["action"], "notifications")
        self.assertEqual(self.manager.plan_action("Send an SMS")["action"], "sms")
        self.assertEqual(self.manager.plan_action("Open camera")["action"], "camera")
        self.assertEqual(self.manager.plan_action("Get my location")["action"], "location")

    def test_pending_commands_are_trackable_and_completeable(self) -> None:
        device_id = self.manager.register_device("Pixel 8", "token-123")["id"]
        self.manager.enqueue_command(device_id, {"action": "flashlight", "value": True})
        pending = self.manager.get_pending_commands(device_id)
        self.assertEqual(len(pending), 1)
        self.manager.mark_command_done(device_id, pending[0]["id"])
        self.assertEqual(self.manager.get_pending_commands(device_id), [])

    def test_register_device_includes_expanded_capabilities(self) -> None:
        device = self.manager.register_device("Pixel 8", "token-123")
        for feature in ["notifications", "sms", "calls", "contacts", "files", "camera", "screen", "clipboard", "location", "battery"]:
            self.assertIn(feature, device["capabilities"])

    def test_device_status_and_local_storage_are_tracked(self) -> None:
        device_id = self.manager.register_device("Pixel 8", "token-123")["id"]
        self.manager.update_device_status(
            device_id,
            {
                "battery_level": 72,
                "is_charging": True,
                "storage_total_mb": 512000,
                "storage_available_mb": 128000,
                "device_model": "Pixel 8",
                "android_version": "14",
                "network_type": "Wi-Fi",
            },
        )
        status = self.manager.get_device_status(device_id)
        self.assertEqual(status["battery_level"], 72)
        self.assertTrue(status["is_charging"])
        self.assertEqual(status["device_model"], "Pixel 8")

    def test_sensitive_data_is_stored_encrypted_and_loaded(self) -> None:
        self.manager.store_sensitive_data("secret-token", "abc123")
        self.assertEqual(self.manager.load_sensitive_data("secret-token"), "abc123")

    def test_dangerous_actions_require_confirmation(self) -> None:
        plan = self.manager.plan_action("Delete the file and send an SMS")
        self.assertTrue(plan["requires_confirmation"])
        self.assertEqual(plan["action"], "sms")

    def test_social_and_media_actions_are_planned(self) -> None:
        self.assertEqual(self.manager.plan_action("Call Rahul")["action"], "calls")
        self.assertEqual(self.manager.plan_action("Open WhatsApp")["action"], "whatsapp")
        self.assertEqual(self.manager.plan_action("Open Telegram")["action"], "telegram")
        self.assertEqual(self.manager.plan_action("Open Instagram")["action"], "instagram")
        self.assertEqual(self.manager.plan_action("Show my gallery")["action"], "gallery")
        self.assertEqual(self.manager.plan_action("Browse files")["action"], "files")


@unittest.skipIf(TestClient is None, "fastapi is not installed in this test environment")
class AndroidCompanionEndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.main as main_module

        self.module = importlib.reload(main_module)
        self.client = TestClient(self.module.app)
        self.manager = self.module.ANDROID_COMPANION_MANAGER

    def test_companion_auth_requires_valid_token(self) -> None:
        device = self.manager.register_device("Pixel 8", "secret-token")

        ok_resp = self.client.post(
            "/companion/auth",
            json={"device_id": device["id"], "token": "secret-token"},
        )
        self.assertEqual(ok_resp.status_code, 200)
        self.assertTrue(ok_resp.json()["ok"])

        bad_resp = self.client.post(
            "/companion/auth",
            json={"device_id": device["id"], "token": "wrong-token"},
        )
        self.assertEqual(bad_resp.status_code, 401)
        self.assertFalse(bad_resp.json()["ok"])
