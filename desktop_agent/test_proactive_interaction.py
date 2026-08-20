import tempfile
import unittest
import os
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

    def test_emotional_state_transition_is_explicit(self):
        result = self.engine.update_emotion("user_frustrated", 0.9)
        emotion = result["emotional_state"]
        self.assertEqual(emotion["state"], "SUPPORTIVE")
        self.assertEqual(emotion["trigger"], "user_frustrated")
        self.assertIn("previous_state", emotion)


if __name__ == "__main__":
    unittest.main()