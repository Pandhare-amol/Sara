from __future__ import annotations

import os
import tempfile
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
        decision = self.engine.should_respond({"idle_seconds": 1000, "current_task": "SARA"})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "proactive_conversation_disabled")

    def test_settings_accept_ui_camel_case(self) -> None:
        snapshot = self.engine.update_settings({"proactiveConversation": True, "playfulMode": True, "prankMode": True})
        self.assertTrue(snapshot["settings"]["proactive_conversation"])
        self.assertTrue(snapshot["settings"]["playful_mode"])
        self.assertTrue(snapshot["settings"]["prank_mode"])

    def test_sensitive_turn_is_not_saved(self) -> None:
        with patch("desktop_agent.social_intelligence.MEMORY.remember") as remember:
            self.engine.record_turn("My API key is a secret token")
        remember.assert_not_called()

    def test_memory_context_is_returned_for_non_sensitive_turn(self) -> None:
        with patch("desktop_agent.social_intelligence.MEMORY.search", return_value=[{"content": "SARA project uses Python"}]):
            plan = self.engine.plan_response("Continue the project")
        self.assertEqual(plan["relevant_memories"], ["SARA project uses Python"])

    def test_quiet_mode_and_camel_case_settings_suppress_proactive_policy(self) -> None:
        self.engine.update_settings({"proactiveConversation": True, "quietMode": True})
        decision = self.engine.should_respond({"idle_seconds": 1000, "current_task": "SARA"})
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["reason"], "quiet_mode")

    def test_busy_important_event_requires_interrupt_permission(self) -> None:
        self.engine.update_settings({"proactiveConversation": True})
        blocked = self.engine.should_respond({"user_busy": True, "important_event": True, "idle_seconds": 1000})
        self.assertEqual(blocked["reason"], "smart_interruption_disabled")
        self.engine.update_settings({"smartInterruption": True})
        allowed = self.engine.should_respond({"user_busy": True, "important_event": True, "idle_seconds": 1000})
        self.assertNotEqual(allowed["reason"], "smart_interruption_disabled")

    def test_relationship_context_progresses_with_real_turns(self) -> None:
        self.assertEqual(self.engine.snapshot()["relationship_state"], "stranger")
        self.engine.record_turn("Hello Sara")
        self.assertEqual(self.engine.snapshot()["relationship_state"], "new_user")


if __name__ == "__main__":
    unittest.main()