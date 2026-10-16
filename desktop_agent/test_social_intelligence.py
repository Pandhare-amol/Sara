from __future__ import annotations

import os
import tempfile
import time
import unittest
from unittest.mock import patch

from desktop_agent.social_intelligence import SocialIntelligence


class SocialIntelligenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.temp_dir.name
        self.engine = SocialIntelligence()

    def tearDown(self) -> None:
        if self.previous_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.previous_data_dir
        self.temp_dir.cleanup()

    def test_emotion_is_uncertain_and_evidence_based(self) -> None:
        signal = self.engine.detect_emotion("This stupid code is not working again")
        self.assertEqual(signal["emotion"], "frustrated")
        self.assertLessEqual(signal["confidence"], 1)
        self.assertTrue(signal["evidence"])

    def test_vague_help_produces_question_plan(self) -> None:
        plan = self.engine.plan_response("Help me with my project")
        self.assertTrue(plan["should_ask_question"])
        self.assertEqual(plan["response_style"], "clear")

    def test_serious_context_disables_humor(self) -> None:
        plan = self.engine.plan_response("I failed my exam")
        self.assertEqual(plan["emotion"], "sad")
        self.assertFalse(plan["humor_allowed"])
        self.assertEqual(plan["conversation_state"], "EMOTIONAL_SUPPORT")

    def test_proactive_conversation_is_off_by_default(self) -> None:
        settings = self.engine.settings
        self.assertFalse(settings.proactive_conversation)
        self.assertFalse(settings.voice_initiation_enabled)
        self.assertEqual(settings.conversation_cooldown, 2_700)
        self.assertEqual(settings.max_proactive_conversations_per_day, 3)
        self.assertTrue(settings.quiet_hours_enabled)
        self.assertEqual(settings.quiet_hours_start, "22:00")
        self.assertEqual(settings.quiet_hours_end, "08:00")

        decision = self.engine.should_respond({"idle_seconds": 1000, "current_task": "SARA"})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "proactive_conversation_disabled")

    def test_voice_initiation_requires_its_separate_setting(self) -> None:
        self.engine.update_settings({"proactiveConversation": True})
        decision = self.engine.should_respond({"idle_seconds": 1000, "unfinished_topic": "SARA demo"})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "voice_initiation_disabled")

    def test_recent_proactive_checkin_respects_conversation_cooldown(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "voiceInitiationEnabled": True})
        decision = self.engine.should_respond({"idle_seconds": 1000, "current_task": "SARA", "last_sara_spoke_at": time.time() - 10})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "conversation_cooldown")

    def test_settings_accept_ui_camel_case(self) -> None:
        snapshot = self.engine.update_settings({
            "proactiveConversation": True,
            "voiceInitiationEnabled": True,
            "playfulMode": True,
            "prankMode": True,
            "conversationCooldown": 3_600,
            "maxProactiveConversationsPerDay": 2,
            "quietHoursEnabled": False,
            "quietHoursStart": "21:30",
            "quietHoursEnd": "07:15",
        })
        self.assertTrue(snapshot["settings"]["proactive_conversation"])
        self.assertTrue(snapshot["settings"]["voice_initiation_enabled"])
        self.assertTrue(snapshot["settings"]["playful_mode"])
        self.assertTrue(snapshot["settings"]["prank_mode"])
        self.assertEqual(snapshot["settings"]["conversation_cooldown"], 3_600)
        self.assertEqual(snapshot["settings"]["max_proactive_conversations_per_day"], 2)
        self.assertFalse(snapshot["settings"]["quiet_hours_enabled"])
        self.assertEqual(snapshot["settings"]["quiet_hours_start"], "21:30")
        self.assertEqual(snapshot["settings"]["quiet_hours_end"], "07:15")

    def test_policy_settings_remain_user_adjustable_above_default(self) -> None:
        snapshot = self.engine.update_settings({
            "conversationCooldown": 100_000,
            "maxProactiveConversationsPerDay": 80,
        })
        self.assertEqual(snapshot["settings"]["conversation_cooldown"], 100_000)
        self.assertEqual(snapshot["settings"]["max_proactive_conversations_per_day"], 80)

    def test_policy_settings_are_forwarded_and_policy_reason_is_reported(self) -> None:
        self.engine.update_settings({
            "proactiveConversation": True,
            "voiceInitiationEnabled": True,
            "conversationCooldown": 3_600,
            "maxProactiveConversationsPerDay": 2,
            "quietHoursEnabled": False,
            "quietHoursStart": "21:30",
            "quietHoursEnd": "07:15",
        })
        policy = {
            "action": "WAIT",
            "policy_reason": "daily_limit_reached",
            "conversation_score": 0.7,
            "context_grounded": True,
            "daily_count": 2,
            "daily_limit": 2,
        }
        with patch("desktop_agent.social_intelligence.MEMORY.search", return_value=[]), \
                patch("desktop_agent.social_intelligence.PROACTIVE_ENGINE.evaluate", return_value=policy) as evaluate:
            decision = self.engine.should_respond({"idle_seconds": 700, "unfinished_topic": "SARA demo"})

        forwarded = evaluate.call_args.args[0]
        self.assertEqual(forwarded["conversation_cooldown_seconds"], 3_600)
        self.assertEqual(forwarded["max_proactive_conversations_per_day"], 2)
        self.assertFalse(forwarded["quiet_hours_enabled"])
        self.assertEqual(forwarded["quiet_hours_start"], "21:30")
        self.assertEqual(forwarded["quiet_hours_end"], "07:15")
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "daily_limit_reached")

    def test_sensitive_turn_is_not_saved(self) -> None:
        with patch("desktop_agent.social_intelligence.MEMORY.remember") as remember:
            self.engine.record_turn("My API key is a secret token")
        remember.assert_not_called()

    def test_memory_context_is_returned_for_non_sensitive_turn(self) -> None:
        with patch("desktop_agent.social_intelligence.MEMORY.search", return_value=[{"content": "SARA project uses Python"}]):
            plan = self.engine.plan_response("Continue the project")
        self.assertEqual(plan["relevant_memories"], ["SARA project uses Python"])

    def test_proactive_checkin_uses_safe_retrieved_memory(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "voiceInitiationEnabled": True, "quietHoursEnabled": False})
        with patch("desktop_agent.social_intelligence.MEMORY.search", return_value=[{"content": "The user is preparing a SARA demo", "score": 0.8, "kind": "project", "metadata": {}}]), \
                patch("desktop_agent.social_intelligence.PROACTIVE_ENGINE.snapshot", return_value={"recent_proactive_topics": []}), \
                patch("desktop_agent.social_intelligence.PROACTIVE_ENGINE.evaluate", return_value={"action": "ASK", "conversation_score": 0.8, "context_grounded": True, "topic": {"topic": "The user is preparing a SARA demo", "grounded": True}}) as evaluate:
            decision = self.engine.should_respond({"idle_seconds": 700, "recent_user_message": "SARA demo"})
        self.assertEqual(decision["action"], "ASK")
        self.assertIn("demo", decision["suggested_prompt"])
        self.assertEqual(evaluate.call_args.args[0]["relevant_memory"], "The user is preparing a SARA demo")

    def test_proactive_question_wording_varies(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "voiceInitiationEnabled": True, "quietHoursEnabled": False})
        policy = {"action": "ASK", "conversation_score": 0.8, "context_grounded": True, "topic": {"topic": "the SARA demo"}}
        with patch("desktop_agent.social_intelligence.MEMORY.search", return_value=[]), \
                patch("desktop_agent.social_intelligence.PROACTIVE_ENGINE.snapshot", return_value={"recent_proactive_topics": []}), \
                patch("desktop_agent.social_intelligence.PROACTIVE_ENGINE.evaluate", return_value=policy):
            first = self.engine.should_respond({"idle_seconds": 700, "unfinished_topic": "the SARA demo"})
            second = self.engine.should_respond({"idle_seconds": 700, "unfinished_topic": "the SARA demo"})
        self.assertNotEqual(first["suggested_prompt"], second["suggested_prompt"])

    def test_quiet_mode_and_camel_case_settings_suppress_proactive_policy(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "voiceInitiationEnabled": True, "quietMode": True})
        decision = self.engine.should_respond({"idle_seconds": 1000, "current_task": "SARA"})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "quiet_mode")

    def test_busy_important_event_requires_interrupt_permission(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "voiceInitiationEnabled": True, "quietHoursEnabled": False})
        blocked = self.engine.should_respond({"user_busy": True, "important_event": True, "idle_seconds": 1000})
        self.assertEqual(blocked["reason"], "smart_interruption_disabled")
        self.engine.update_settings({"smartInterruption": True})
        allowed = self.engine.should_respond({"user_busy": True, "important_event": True, "idle_seconds": 1000})
        self.assertNotEqual(allowed["reason"], "smart_interruption_disabled")

    def test_relationship_context_progresses_with_real_turns(self) -> None:
        self.assertEqual(self.engine.snapshot()["relationship_state"], "stranger")
        with patch("desktop_agent.social_intelligence.MEMORY.remember"):
            self.engine.record_turn("Hello Sara")
        self.assertEqual(self.engine.snapshot()["relationship_state"], "new_user")


if __name__ == "__main__":
    unittest.main()