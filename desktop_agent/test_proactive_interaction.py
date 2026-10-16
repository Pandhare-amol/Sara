import tempfile
import unittest
import os
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from desktop_agent.proactive_interaction import ProactiveInteractionEngine


class ProactiveInteractionTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.temp_dir.name
        self.engine = ProactiveInteractionEngine()

    def tearDown(self):
        if self.previous_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.previous_data_dir
        self.temp_dir.cleanup()

    def test_focused_work_waits(self):
        result = self.engine.evaluate({
            "activity_level": "coding",
            "idle_seconds": 0,
            "relevant_memory": True,
        })
        self.assertEqual(result["action"], "WAIT")
        self.assertTrue(result["focused_work"])

    def test_relevant_idle_context_can_ask(self):
        result = self.engine.evaluate({
            "activity_level": "idle",
            "idle_seconds": 700,
            "previous_topic": True,
            "unfinished_topic": True,
            "quiet_hours_enabled": False,
        })
        self.assertIn(result["action"], {"ASK", "SAY"})
        self.assertTrue(result["context_grounded"])

    def test_quiet_mode_suppresses_noncritical_opportunity(self):
        self.engine.set_quiet(True)
        result = self.engine.evaluate({"idle_seconds": 1000, "relevant_memory": True})
        self.assertEqual(result["action"], "WAIT")
        self.assertTrue(result["quiet_mode"])

    def test_ignored_outcomes_are_recorded_without_content(self):
        self.engine.record_outcome(False, "private topic")
        snapshot = self.engine.snapshot()
        self.assertEqual(snapshot["ignored_count"], 1)
        self.assertNotIn("private topic", str(snapshot))

    def test_sent_checkin_persists_cooldown_and_recent_topic(self):
        snapshot = self.engine.record_proactive_sent("SARA demo")
        self.assertEqual(snapshot["last_topic"], "SARA demo")
        self.assertIn("SARA demo", snapshot["recent_proactive_topics"])
        decision = self.engine.evaluate({"idle_seconds": 900, "relevant_memory": True})
        self.assertEqual(decision["action"], "WAIT")

    def test_configured_cooldown_is_respected(self):
        sent_at = 1_700_000_000.0
        with patch("desktop_agent.proactive_interaction.time.time", return_value=sent_at):
            self.engine.record_proactive_sent("SARA demo")

        with patch("desktop_agent.proactive_interaction.time.time", return_value=sent_at + 2_400):
            decision = self.engine.evaluate({
                "idle_seconds": 700,
                "unfinished_topic": "SARA demo",
                "quiet_hours_enabled": False,
                "conversation_cooldown_seconds": 2_700,
            })

        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["policy_reason"], "conversation_cooldown")
        self.assertEqual(decision["cooldown_seconds"], 300.0)

    def test_daily_cap_is_persisted_and_resets_on_a_new_local_day(self):
        sent_at = 1_700_000_000.0
        with patch("desktop_agent.proactive_interaction.time.time", return_value=sent_at):
            for _ in range(3):
                self.engine.record_proactive_sent("SARA demo")
            capped = self.engine.evaluate({
                "idle_seconds": 700,
                "unfinished_topic": "SARA demo",
                "quiet_hours_enabled": False,
                "max_proactive_conversations_per_day": 3,
            })

        self.assertEqual(capped["action"], "WAIT")
        self.assertEqual(capped["policy_reason"], "daily_limit_reached")
        self.assertEqual(capped["daily_count"], 3)

        with patch("desktop_agent.proactive_interaction.time.time", return_value=sent_at + 48 * 60 * 60):
            next_day = self.engine.evaluate({
                "idle_seconds": 700,
                "unfinished_topic": "SARA demo",
                "quiet_hours_enabled": False,
                "max_proactive_conversations_per_day": 3,
            })
        self.assertEqual(next_day["daily_count"], 0)
        self.assertIn(next_day["action"], {"ASK", "SAY"})

    def test_quiet_hours_handle_overnight_and_all_day_windows(self):
        before_bedtime = datetime(2026, 10, 16, 21, 59, tzinfo=timezone.utc)
        late_evening = datetime(2026, 10, 16, 22, 0, tzinfo=timezone.utc)
        morning = datetime(2026, 10, 17, 7, 59, tzinfo=timezone.utc)
        after_quiet_hours = datetime(2026, 10, 17, 8, 0, tzinfo=timezone.utc)

        self.assertFalse(self.engine._is_within_quiet_hours(before_bedtime, "22:00", "08:00"))
        self.assertTrue(self.engine._is_within_quiet_hours(late_evening, "22:00", "08:00"))
        self.assertTrue(self.engine._is_within_quiet_hours(morning, "22:00", "08:00"))
        self.assertFalse(self.engine._is_within_quiet_hours(after_quiet_hours, "22:00", "08:00"))
        self.assertTrue(self.engine._is_within_quiet_hours(after_quiet_hours, "00:00", "00:00"))

    def test_quiet_hours_cannot_be_bypassed_by_professional_question_priority(self):
        self.engine.set_current_mode("PROFESSIONAL")
        self.engine.set_unanswered_questions_count(1)
        decision = self.engine.evaluate({
            "idle_seconds": 700,
            "unfinished_topic": "SARA project",
            "mode": "PROFESSIONAL",
            "quiet_hours_enabled": True,
            "quiet_hours_start": "00:00",
            "quiet_hours_end": "00:00",
        })
        self.assertEqual(decision["action"], "WAIT")
        self.assertEqual(decision["policy_reason"], "quiet_hours")

    def test_emotional_state_transition_is_explicit(self):
        result = self.engine.update_emotion("user_frustrated", 0.9)
        emotion = result["emotional_state"]
        self.assertEqual(emotion["state"], "SUPPORTIVE")
        self.assertEqual(emotion["trigger"], "user_frustrated")
        self.assertIn("previous_state", emotion)

    def test_topic_selection_is_grounded_and_privacy_aware(self):
        result = self.engine.evaluate({
            "idle_seconds": 700,
            "unfinished_topic": "finish the authentication bug tomorrow",
        })
        self.assertEqual(result["topic"]["topic"], "finish the authentication bug tomorrow")
        self.assertTrue(result["topic"]["grounded"])

        private = self.engine.evaluate({
            "idle_seconds": 700,
            "unfinished_topic": "private health detail",
            "privacy_level": "SENSITIVE",
        })
        self.assertEqual(private["topic"]["topic"], "")
        self.assertTrue(private["topic"]["privacy_filtered"])


if __name__ == "__main__":
    unittest.main()