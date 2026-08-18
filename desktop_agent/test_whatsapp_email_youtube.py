from __future__ import annotations

import importlib
import os
import tempfile
import unittest


class WhatsAppEmailYouTubeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name
        
        import desktop_agent.platform_core as platform_core
        import desktop_agent.registry as registry
        import desktop_agent.tools_email as tools_email
        import desktop_agent.tools_whatsapp as tools_whatsapp
        import desktop_agent.tools_youtube as tools_youtube
        import desktop_agent.agents as agents
        import desktop_agent.voice_command_router as router

        self.platform_core = importlib.reload(platform_core)
        self.registry = importlib.reload(registry)
        self.tools_email = importlib.reload(tools_email)
        self.tools_whatsapp = importlib.reload(tools_whatsapp)
        self.tools_youtube = importlib.reload(tools_youtube)
        self.agents = importlib.reload(agents)
        self.router = importlib.reload(router)

    def tearDown(self) -> None:
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_email_tools_registration_and_execution(self) -> None:
        self.assertIn("email_send", self.registry.TOOLS)
        self.assertIn("email_read", self.registry.TOOLS)
        self.assertIn("email_search", self.registry.TOOLS)

        draft = self.tools_email.email_draft({"to": "test@example.com", "subject": "Test", "body": "Hello World"})
        self.assertIn("draft_id", draft)

        scheduled = self.tools_email.email_schedule_send({"to": "test@example.com", "subject": "Later", "body": "Later body", "delay_seconds": 60})
        self.assertIn("job_id", scheduled)

        mem = self.platform_core.MEMORY.search("Test", kind="email_draft")
        self.assertTrue(len(mem) >= 1)

    def test_whatsapp_tools_registration_and_execution(self) -> None:
        self.assertIn("whatsapp_send", self.registry.TOOLS)
        self.assertIn("whatsapp_read_messages", self.registry.TOOLS)
        self.assertIn("whatsapp_schedule_send", self.registry.TOOLS)

        contact = self.tools_whatsapp.whatsapp_resolve_contact({"name": "Alice"})
        self.assertEqual(contact["contact"]["name"], "Alice")

        scheduled = self.tools_whatsapp.whatsapp_schedule_send({"contact": "Bob", "message": "Hi Bob", "delay_seconds": 120})
        self.assertIn("job_id", scheduled)

        task = self.tools_whatsapp.whatsapp_create_task_from_message({"instruction": "Buy groceries", "sender": "Mom"})
        self.assertIn("result", task)

    def test_youtube_tools_registration_and_execution(self) -> None:
        self.assertIn("youtube_search", self.registry.TOOLS)
        self.assertIn("youtube_pause", self.registry.TOOLS)
        self.assertIn("youtube_fullscreen", self.registry.TOOLS)

        pause = self.tools_youtube.youtube_pause({})
        self.assertIn("result", pause)

        info = self.tools_youtube.youtube_get_info({})
        self.assertIn("result", info)

        watch_later = self.tools_youtube.youtube_add_to_watch_later({})
        self.assertIn("result", watch_later)

    def test_voice_command_router_parses_intents(self) -> None:
        cmd_wa = self.router.parse_voice_command("send whatsapp message to Alice saying meeting at 5")
        self.assertEqual(cmd_wa.intent, "whatsapp.send")
        self.assertEqual(cmd_wa.args["contact"], "Alice")
        self.assertTrue(cmd_wa.requires_confirmation)

        cmd_email = self.router.parse_voice_command("send email to boss@company.com saying I finished the report")
        self.assertEqual(cmd_email.intent, "email.send")
        self.assertEqual(cmd_email.args["to"], "boss@company.com")
        self.assertTrue(cmd_email.requires_confirmation)

        cmd_yt = self.router.parse_voice_command("pause video on youtube")
        self.assertEqual(cmd_yt.intent, "youtube.pause")


if __name__ == "__main__":
    unittest.main()
