from __future__ import annotations

import importlib
import unittest
from unittest.mock import patch


class AppAutomationSuiteTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.app_automation_suite as app_suite

        self.app_suite = importlib.reload(app_suite)
        self.suite = self.app_suite.APP_SUITE

    def test_plan_detects_whatsapp_and_requires_confirmation(self) -> None:
        plan = self.suite.plan("Send a message to John about the meeting")
        self.assertEqual(plan["plugin"]["name"], "WhatsApp")
        self.assertTrue(plan["steps"][0]["requires_confirmation"])

    def test_plan_detects_instagram_social_actions(self) -> None:
        plan = self.suite.plan("Post a story on Instagram")
        self.assertEqual(plan["plugin"]["name"], "Instagram")
        self.assertTrue(plan["requires_confirmation"])

    def test_execute_requires_confirmation_for_sensitive_actions(self) -> None:
        result = self.suite.execute("WhatsApp", "send_message", {"text": "hello"}, confirmed=False)
        self.assertTrue(result["requires_confirmation"])

    def test_youtube_play_uses_playback_handler(self) -> None:
        with patch.dict(self.app_suite.TOOLS, {
            "youtube_play": lambda args: {"verified": True, "result": "Playing"},
        }, clear=False):
            result = self.suite.execute("YouTube", "play", {"query": "Python lecture"}, confirmed=False)

        self.assertTrue(result["result"]["verified"])
        self.assertEqual(result["result"]["result"], "Playing")

    def test_whatsapp_named_recipient_is_sent_and_verified(self) -> None:
        calls = []

        def record(tool_name, response=None):
            def handler(args):
                calls.append((tool_name, args))
                return response or {"result": "ok"}
            return handler

        with patch.dict(self.app_suite.TOOLS, {
            "desktopBrowserOpen": record("open"),
            "desktopBrowserType": record("type"),
            "desktopBrowserClick": record("click"),
            "desktopBrowserKey": record("key"),
            "desktopBrowserReadPage": record("read", {"result": "I'll be home at 7."}),
        }, clear=False):
            result = self.suite.execute(
                "WhatsApp",
                "send_message",
                {"text": "Send Mom: I'll be home at 7."},
                confirmed=True,
            )

        self.assertTrue(result["result"]["verified"])
        self.assertTrue(any(name == "click" and call["text"] == "Mom" for name, call in calls))
        self.assertTrue(any(name == "type" and call["text"] == "I'll be home at 7." for name, call in calls))

    def test_instagram_open_is_safe(self) -> None:
        result = self.suite.execute("Instagram", "open", {}, confirmed=False)
        self.assertIn("result", result)

    def test_plugin_manager_can_register_and_list_plugins(self) -> None:
        manager = self.app_suite.PluginManager()
        plugin = self.app_suite.ApplicationPlugin(
            name="Test App",
            category="Productivity",
            aliases=["test"],
            capabilities=["open", "search"],
        )
        manager.register_plugin(plugin)
        listed = manager.list_plugins()
        self.assertEqual(listed["count"], 1)
        self.assertIn("Test App", [item["name"] for item in listed["plugins"]])

    def test_builtin_plugin_listing_has_no_alias_duplicates(self) -> None:
        listed = self.suite.list_plugins()
        names = [item["name"] for item in listed["plugins"]]
        self.assertEqual(listed["count"], len(names))
        self.assertEqual(len(names), len(set(names)))

    def test_workflow_engine_can_build_and_execute_steps(self) -> None:
        engine = self.app_suite.WorkflowEngine()
        workflow = engine.create_workflow(
            name="demo",
            description="Open a browser and search",
            steps=[
                {"app": "Chrome", "action": "open", "args": {}},
                {"app": "Chrome", "action": "search", "args": {"query": "SARA automation"}},
            ],
        )
        self.assertEqual(workflow["name"], "demo")
        self.assertEqual(len(workflow["steps"]), 2)
        result = engine.execute_workflow(workflow, confirmed=False)
        self.assertEqual(result["status"], "completed")


if __name__ == "__main__":
    unittest.main()
