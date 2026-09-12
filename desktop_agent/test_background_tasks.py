import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent.tools_background import BackgroundTaskManager


class BackgroundTaskManagerTest(unittest.TestCase):
    def make_manager(self):
        directory = tempfile.TemporaryDirectory()
        with patch("desktop_agent.tools_background.data_root", return_value=Path(directory.name)):
            manager = BackgroundTaskManager()
        self.addCleanup(directory.cleanup)
        return manager, Path(directory.name)

    def test_cancelled_task_does_not_start_unknown_tool(self):
        manager, _ = self.make_manager()
        manager._run = lambda task_id: None
        with patch.dict("desktop_agent.tools_background.TOOLS", {"slow": lambda args: time.sleep(0.05)}):
            task = manager.submit("slow", {}, "test")
            cancelled = manager.cancel(task["id"])

        self.assertTrue(cancelled["cancel_requested"])
        self.assertEqual(cancelled["status"], "cancelled")

    def test_restart_marks_unfinished_tasks_paused(self):
        manager, directory = self.make_manager()
        manager._store.write_text('[{"id":"old","tool":"slow","args":{},"status":"running","result":null,"error":"","created_at":1,"started_at":1,"finished_at":null,"label":"old"}]', encoding="utf-8")
        with patch("desktop_agent.tools_background.data_root", return_value=directory):
            restored = BackgroundTaskManager()
        self.assertEqual(restored._tasks["old"].status, "paused")
        self.assertIn("restarted", restored._tasks["old"].error.lower())


if __name__ == "__main__":
    unittest.main()